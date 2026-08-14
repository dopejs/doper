import { round } from "./metrics";
import type { SabBackpressureResult, SabBackpressureWorkerResult } from "./protocol";

const writeCursorIndex = 0;
const readCursorIndex = 1;
const doneIndex = 2;
const magicIndex = 3;
const headerWords = 4;
const ringMagic = 0x44505231;
const minimumCapacity = 2;
const maximumCapacity = 4096;

export interface SabSequenceRing {
  readonly capacity: number;
  readonly header: Int32Array;
  readonly slots: Int32Array;
}

export interface SabBackpressureProducerStats {
  readonly acceptedCount: number;
  readonly droppedCount: number;
  readonly highWatermark: number;
  readonly latestAcceptedSequence: number;
  readonly producedCount: number;
}

export function createSabSequenceRing(capacity: number): {
  readonly buffer: SharedArrayBuffer;
  readonly ring: SabSequenceRing;
} {
  validateCapacity(capacity);
  const buffer = new SharedArrayBuffer((headerWords + capacity) * Int32Array.BYTES_PER_ELEMENT);
  const ring = attachSabSequenceRing(buffer, capacity, false);
  Atomics.store(ring.header, magicIndex, ringMagic);
  return { buffer, ring };
}

export function attachSabSequenceRing(
  buffer: SharedArrayBuffer,
  capacity: number,
  requireMagic = true,
): SabSequenceRing {
  validateCapacity(capacity);
  const expectedBytes = (headerWords + capacity) * Int32Array.BYTES_PER_ELEMENT;
  if (buffer.byteLength !== expectedBytes) {
    throw new RangeError(
      `SAB ring byteLength ${String(buffer.byteLength)} does not match ${String(expectedBytes)}`,
    );
  }
  const header = new Int32Array(buffer, 0, headerWords);
  if (requireMagic && Atomics.load(header, magicIndex) !== ringMagic) {
    throw new Error("SAB ring magic/version is invalid");
  }
  return {
    capacity,
    header,
    slots: new Int32Array(buffer, headerWords * Int32Array.BYTES_PER_ELEMENT, capacity),
  };
}

export function tryPublishSequence(ring: SabSequenceRing, sequence: number): boolean {
  if (!Number.isInteger(sequence) || sequence < 1 || sequence > 0x7fffffff) {
    throw new RangeError("SAB ring sequence must be a positive signed 32-bit integer");
  }
  const writeCursor = Atomics.load(ring.header, writeCursorIndex);
  const readCursor = Atomics.load(ring.header, readCursorIndex);
  const occupancy = writeCursor - readCursor;
  if (occupancy < 0 || occupancy > ring.capacity) {
    throw new Error("SAB ring cursors violate the bounded occupancy invariant");
  }
  if (occupancy === ring.capacity) return false;
  Atomics.store(ring.slots, writeCursor % ring.capacity, sequence);
  Atomics.store(ring.header, writeCursorIndex, writeCursor + 1);
  Atomics.notify(ring.header, writeCursorIndex, 1);
  return true;
}

export function takeSequence(ring: SabSequenceRing): number | null {
  const readCursor = Atomics.load(ring.header, readCursorIndex);
  const writeCursor = Atomics.load(ring.header, writeCursorIndex);
  const occupancy = writeCursor - readCursor;
  if (occupancy < 0 || occupancy > ring.capacity) {
    throw new Error("SAB ring cursors violate the bounded occupancy invariant");
  }
  if (occupancy === 0) return null;
  const sequence = Atomics.load(ring.slots, readCursor % ring.capacity);
  Atomics.store(ring.header, readCursorIndex, readCursor + 1);
  return sequence;
}

export function ringOccupancy(ring: SabSequenceRing): number {
  return Atomics.load(ring.header, writeCursorIndex) - Atomics.load(ring.header, readCursorIndex);
}

export function ringCursors(ring: SabSequenceRing): {
  readonly read: number;
  readonly write: number;
} {
  return {
    read: Atomics.load(ring.header, readCursorIndex),
    write: Atomics.load(ring.header, writeCursorIndex),
  };
}

export function finishSequenceRing(ring: SabSequenceRing): void {
  Atomics.store(ring.header, doneIndex, 1);
  Atomics.notify(ring.header, writeCursorIndex, 1);
}

export function sequenceRingFinished(ring: SabSequenceRing): boolean {
  return Atomics.load(ring.header, doneIndex) === 1 && ringOccupancy(ring) === 0;
}

export function waitForSequence(ring: SabSequenceRing, timeoutMs: number): void {
  const writeCursor = Atomics.load(ring.header, writeCursorIndex);
  if (ringOccupancy(ring) === 0 && !sequenceRingFinished(ring)) {
    Atomics.wait(ring.header, writeCursorIndex, writeCursor, timeoutMs);
  }
}

export function analyzeSabBackpressure(
  capacity: number,
  producer: SabBackpressureProducerStats,
  worker: SabBackpressureWorkerResult,
): SabBackpressureResult {
  const consumedCount = worker.consumedSequences.length;
  const latestConsumedSequence = worker.consumedSequences.at(-1) ?? 0;
  const sequenceMonotonic = worker.consumedSequences.every(
    (sequence, index, values) => index === 0 || sequence > (values[index - 1] ?? sequence),
  );
  const sequencesWithinProducedRange = worker.consumedSequences.every(
    (sequence) => sequence >= 1 && sequence <= producer.producedCount,
  );
  const cursorsMatchCounts =
    worker.finalReadCursor === consumedCount && worker.finalWriteCursor === producer.acceptedCount;
  const drained =
    worker.finalReadCursor === worker.finalWriteCursor &&
    consumedCount === producer.acceptedCount &&
    cursorsMatchCounts;
  const accountingValid = producer.acceptedCount + producer.droppedCount === producer.producedCount;
  const backpressureHandled =
    producer.droppedCount > 0 &&
    producer.acceptedCount > 0 &&
    producer.highWatermark === capacity &&
    accountingValid &&
    drained &&
    sequenceMonotonic &&
    sequencesWithinProducedRange &&
    latestConsumedSequence === producer.latestAcceptedSequence;

  return {
    ...worker,
    acceptedCount: producer.acceptedCount,
    acceptedPerSecond:
      worker.durationMs === 0 ? 0 : round(producer.acceptedCount / (worker.durationMs / 1000)),
    backpressureHandled,
    capacity,
    consumedCount,
    drained,
    droppedCount: producer.droppedCount,
    highWatermark: producer.highWatermark,
    latestAcceptedSequence: producer.latestAcceptedSequence,
    latestConsumedSequence,
    producedCount: producer.producedCount,
    sequenceMonotonic,
  };
}

function validateCapacity(capacity: number): void {
  if (!Number.isInteger(capacity) || capacity < minimumCapacity || capacity > maximumCapacity) {
    throw new RangeError(
      `SAB ring capacity must be an integer from ${String(minimumCapacity)} to ${String(maximumCapacity)}`,
    );
  }
}
