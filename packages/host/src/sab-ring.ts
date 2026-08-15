const RING_MAGIC = 0x3252_5044;
const RING_VERSION = 1;
const HEADER_WORDS = 16;
const SLOT_HEADER_WORDS = 2;
const WORD_BYTES = Int32Array.BYTES_PER_ELEMENT;
const HEADER_BYTES = HEADER_WORDS * WORD_BYTES;
const MIN_CAPACITY = 2;
const MAX_CAPACITY = 64;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;

const MAGIC_INDEX = 0;
const VERSION_INDEX = 1;
const CAPACITY_INDEX = 2;
const PAYLOAD_BYTES_INDEX = 3;
const WRITE_CURSOR_INDEX = 4;
const READ_CURSOR_INDEX = 5;
const CLOSED_INDEX = 6;
const PUBLISHED_INDEX = 7;
const CONSUMED_INDEX = 8;
const REJECTED_INDEX = 9;
const HIGH_WATERMARK_INDEX = 10;
const CORRUPTION_INDEX = 11;
const LATEST_PUBLISHED_SEQUENCE_INDEX = 12;
const LATEST_CONSUMED_SEQUENCE_INDEX = 13;
const RESERVED_START_INDEX = 14;

/** Snapshot of bounded transport pressure and transaction progress. */
export interface SabMutationRingMetrics {
  readonly capacity: number;
  readonly consumed: number;
  readonly corruptionFailures: number;
  readonly highWatermark: number;
  readonly latestConsumedSequence: number;
  readonly latestPublishedSequence: number;
  readonly occupancy: number;
  readonly payloadBytes: number;
  readonly published: number;
  readonly rejected: number;
}

/** One detached committed Mutation Stream read from shared memory. */
export interface SabMutationFrame {
  readonly bytes: Uint8Array;
  readonly frameSeq: number;
}

/** Single-producer/single-consumer, fixed-slot shared Mutation Stream ring. */
export class SabMutationRing {
  readonly #buffer: SharedArrayBuffer;
  readonly #capacity: number;
  readonly #header: Int32Array;
  readonly #payloadBytes: number;
  readonly #slotStrideBytes: number;

  private constructor(buffer: SharedArrayBuffer, capacity: number, payloadBytes: number) {
    this.#buffer = buffer;
    this.#capacity = capacity;
    this.#payloadBytes = payloadBytes;
    this.#slotStrideBytes = (SLOT_HEADER_WORDS * WORD_BYTES + payloadBytes) >>> 0;
    this.#header = new Int32Array(buffer, 0, HEADER_WORDS);
  }

  /** Allocates and initializes a ring, publishing its magic only after all fields are valid. */
  public static create(
    capacity: number,
    payloadBytes: number,
  ): { readonly buffer: SharedArrayBuffer; readonly ring: SabMutationRing } {
    const totalBytes = validateShape(capacity, payloadBytes);
    const buffer = new SharedArrayBuffer(totalBytes);
    const ring = new SabMutationRing(buffer, capacity, payloadBytes);
    Atomics.store(ring.#header, VERSION_INDEX, RING_VERSION);
    Atomics.store(ring.#header, CAPACITY_INDEX, capacity);
    Atomics.store(ring.#header, PAYLOAD_BYTES_INDEX, payloadBytes);
    Atomics.store(ring.#header, MAGIC_INDEX, RING_MAGIC);
    return { buffer, ring };
  }

  /** Attaches to an initialized ring after validating its complete immutable shape. */
  public static attach(buffer: SharedArrayBuffer): SabMutationRing {
    if (!(buffer instanceof SharedArrayBuffer))
      throw new TypeError("ring requires SharedArrayBuffer");
    if (buffer.byteLength < HEADER_BYTES) throw new RangeError("ring header is truncated");
    const header = new Int32Array(buffer, 0, HEADER_WORDS);
    if (Atomics.load(header, MAGIC_INDEX) !== RING_MAGIC) {
      throw new Error("ring magic is invalid or initialization is incomplete");
    }
    if (Atomics.load(header, VERSION_INDEX) !== RING_VERSION) {
      throw new Error("ring version is incompatible");
    }
    const capacity = Atomics.load(header, CAPACITY_INDEX);
    const payloadBytes = Atomics.load(header, PAYLOAD_BYTES_INDEX);
    const expectedBytes = validateShape(capacity, payloadBytes);
    if (buffer.byteLength !== expectedBytes) {
      throw new RangeError("ring byteLength does not match its declared shape");
    }
    for (let index = RESERVED_START_INDEX; index < HEADER_WORDS; index += 1) {
      if (Atomics.load(header, index) !== 0)
        throw new Error("ring reserved header words must be zero");
    }
    const ring = new SabMutationRing(buffer, capacity, payloadBytes);
    ring.assertCursors();
    return ring;
  }

  /** Shared allocation transferred by reference to the Worker. */
  public get buffer(): SharedArrayBuffer {
    return this.#buffer;
  }

  /** Maximum payload bytes in one committed slot. */
  public get payloadBytes(): number {
    return this.#payloadBytes;
  }

  /** Attempts to publish one complete frame; false is explicit backpressure, never data loss. */
  public tryPublish(frameSeq: number, bytes: Uint8Array): boolean {
    assertU32(frameSeq, "frameSeq");
    if (!(bytes instanceof Uint8Array)) throw new TypeError("ring payload must be Uint8Array");
    if (bytes.byteLength === 0 || bytes.byteLength % WORD_BYTES !== 0) {
      throw new RangeError("ring payload must be non-empty and four-byte aligned");
    }
    if (bytes.byteLength > this.#payloadBytes)
      throw new RangeError("ring payload exceeds slot budget");
    if (Atomics.load(this.#header, CLOSED_INDEX) !== 0) throw new Error("ring is closed");

    const { occupancy, write } = this.assertCursors();
    if (occupancy === this.#capacity) {
      Atomics.add(this.#header, REJECTED_INDEX, 1);
      return false;
    }
    const slot = write % this.#capacity;
    const lengthWord = this.slotWord(slot);
    if (Atomics.load(lengthWord, 0) !== 0) return this.corrupt("producer reached a non-empty slot");
    const sequenceWord = new Int32Array(this.#buffer, this.slotOffset(slot) + WORD_BYTES, 1);
    const payload = new Uint8Array(
      this.#buffer,
      this.slotOffset(slot) + SLOT_HEADER_WORDS * WORD_BYTES,
      this.#payloadBytes,
    );
    payload.set(bytes, 0);
    Atomics.store(sequenceWord, 0, frameSeq | 0);
    Atomics.store(lengthWord, 0, bytes.byteLength);
    Atomics.store(this.#header, WRITE_CURSOR_INDEX, (write + 1) | 0);
    Atomics.add(this.#header, PUBLISHED_INDEX, 1);
    Atomics.store(this.#header, LATEST_PUBLISHED_SEQUENCE_INDEX, frameSeq | 0);
    updateMaximum(this.#header, HIGH_WATERMARK_INDEX, occupancy + 1);
    Atomics.notify(this.#header, WRITE_CURSOR_INDEX, 1);
    return true;
  }

  /** Takes the oldest committed frame, returning a detached copy safe after slot reuse. */
  public take(): SabMutationFrame | null {
    const { occupancy, read } = this.assertCursors();
    if (occupancy === 0) return null;
    const slot = read % this.#capacity;
    const lengthWord = this.slotWord(slot);
    const length = Atomics.load(lengthWord, 0);
    if (length <= 0 || length > this.#payloadBytes || length % WORD_BYTES !== 0) {
      return this.corrupt("consumer observed an invalid committed slot length");
    }
    const sequenceWord = new Int32Array(this.#buffer, this.slotOffset(slot) + WORD_BYTES, 1);
    const frameSeq = Atomics.load(sequenceWord, 0) >>> 0;
    const source = new Uint8Array(
      this.#buffer,
      this.slotOffset(slot) + SLOT_HEADER_WORDS * WORD_BYTES,
      length,
    );
    const bytes = source.slice();
    Atomics.store(lengthWord, 0, 0);
    Atomics.store(this.#header, READ_CURSOR_INDEX, (read + 1) | 0);
    Atomics.add(this.#header, CONSUMED_INDEX, 1);
    Atomics.store(this.#header, LATEST_CONSUMED_SEQUENCE_INDEX, frameSeq | 0);
    return { bytes, frameSeq };
  }

  /** Prevents later publication while allowing the consumer to drain committed slots. */
  public close(): void {
    Atomics.store(this.#header, CLOSED_INDEX, 1);
    Atomics.notify(this.#header, WRITE_CURSOR_INDEX, 1);
  }

  /** Whether close was requested and every committed slot was consumed. */
  public isDrained(): boolean {
    return Atomics.load(this.#header, CLOSED_INDEX) !== 0 && this.assertCursors().occupancy === 0;
  }

  /** Waits from a Worker when empty; main-thread callers must use polling/message acknowledgements. */
  public waitForFrame(timeoutMs: number): "not-equal" | "ok" | "timed-out" {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0)
      throw new RangeError("timeout must be finite");
    const write = Atomics.load(this.#header, WRITE_CURSOR_INDEX);
    if (this.assertCursors().occupancy !== 0) return "not-equal";
    return Atomics.wait(this.#header, WRITE_CURSOR_INDEX, write, timeoutMs);
  }

  /** Returns atomic counters without exposing mutable shared views. */
  public metrics(): SabMutationRingMetrics {
    const occupancy = this.assertCursors().occupancy;
    return {
      capacity: this.#capacity,
      consumed: Atomics.load(this.#header, CONSUMED_INDEX) >>> 0,
      corruptionFailures: Atomics.load(this.#header, CORRUPTION_INDEX) >>> 0,
      highWatermark: Atomics.load(this.#header, HIGH_WATERMARK_INDEX) >>> 0,
      latestConsumedSequence: Atomics.load(this.#header, LATEST_CONSUMED_SEQUENCE_INDEX) >>> 0,
      latestPublishedSequence: Atomics.load(this.#header, LATEST_PUBLISHED_SEQUENCE_INDEX) >>> 0,
      occupancy,
      payloadBytes: this.#payloadBytes,
      published: Atomics.load(this.#header, PUBLISHED_INDEX) >>> 0,
      rejected: Atomics.load(this.#header, REJECTED_INDEX) >>> 0,
    };
  }

  private assertCursors(): {
    readonly occupancy: number;
    readonly read: number;
    readonly write: number;
  } {
    const write = Atomics.load(this.#header, WRITE_CURSOR_INDEX) >>> 0;
    const read = Atomics.load(this.#header, READ_CURSOR_INDEX) >>> 0;
    const occupancy = (write - read) >>> 0;
    if (occupancy > this.#capacity) return this.corrupt("ring cursors violate bounded occupancy");
    return { occupancy, read, write };
  }

  private slotOffset(slot: number): number {
    return HEADER_BYTES + slot * this.#slotStrideBytes;
  }

  private slotWord(slot: number): Int32Array {
    return new Int32Array(this.#buffer, this.slotOffset(slot), 1);
  }

  private corrupt(message: string): never {
    Atomics.add(this.#header, CORRUPTION_INDEX, 1);
    throw new Error(message);
  }
}

function validateShape(capacity: number, payloadBytes: number): number {
  if (!Number.isInteger(capacity) || capacity < MIN_CAPACITY || capacity > MAX_CAPACITY) {
    throw new RangeError(
      `ring capacity must be from ${String(MIN_CAPACITY)} to ${String(MAX_CAPACITY)}`,
    );
  }
  if (
    !Number.isInteger(payloadBytes) ||
    payloadBytes < WORD_BYTES ||
    payloadBytes % WORD_BYTES !== 0
  ) {
    throw new RangeError("ring payloadBytes must be a positive four-byte-aligned integer");
  }
  const slotStride = SLOT_HEADER_WORDS * WORD_BYTES + payloadBytes;
  const total = HEADER_BYTES + capacity * slotStride;
  if (!Number.isSafeInteger(total) || total > MAX_TOTAL_BYTES) {
    throw new RangeError("ring allocation exceeds the shared-memory budget");
  }
  return total;
}

function assertU32(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new RangeError(`${label} must be a u32`);
  }
}

function updateMaximum(view: Int32Array, index: number, candidate: number): void {
  let current = Atomics.load(view, index);
  while (candidate > current) {
    const observed = Atomics.compareExchange(view, index, current, candidate);
    if (observed === current) return;
    current = observed;
  }
}
