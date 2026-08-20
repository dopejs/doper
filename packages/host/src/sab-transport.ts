import { decodeMutationBatch, encodeMutationBatch } from "@dopejs/pingo-reconciler";

import type { SabMutationRing, SabMutationRingMetrics } from "./sab-ring";
import { MutationTransportBackpressureError } from "./transport-errors";

const TRANSPORT_VERSION = 1;
const MAX_BUFFERED_BYTES = 256 * 1024 * 1024;

interface MessageEndpoint {
  addEventListener(type: "message", listener: (event: MessageEvent<unknown>) => void): void;
  postMessage(message: unknown): void;
  removeEventListener(type: "message", listener: (event: MessageEvent<unknown>) => void): void;
}

interface WakeMessage {
  readonly kind: "pingo:sab-wake";
  readonly sessionId: number;
  readonly version: number;
}

interface AckMessage {
  readonly frameSeq: number;
  readonly kind: "pingo:sab-ack";
  readonly sessionId: number;
  readonly version: number;
}

interface ErrorMessage {
  readonly error: string;
  readonly kind: "pingo:sab-error";
  readonly sessionId: number;
  readonly version: number;
}

interface QueuedFrame {
  readonly byteLength: number;
  readonly bytes: Uint8Array;
  readonly frameSeq: number;
}

interface PublishedFrame {
  readonly byteLength: number;
  readonly frameSeq: number;
}

export interface SabMutationTransportOptions {
  readonly acknowledgementTimeoutMs?: number;
  readonly maxBufferedBytes?: number;
  readonly maxBufferedFrames?: number;
  readonly onError?: (error: Error) => void;
  readonly sessionId: number;
}

export interface SabMutationTransportMetrics {
  readonly acknowledged: number;
  readonly bufferedBytes: number;
  readonly highWatermark: number;
  readonly latestAcknowledgedSequence: number;
  readonly latestAcceptedSequence: number;
  readonly merged: number;
  readonly mode: "sab";
  readonly publishedAwaitingAck: number;
  readonly queued: number;
  readonly rejected: number;
  readonly ring: SabMutationRingMetrics;
  readonly timeouts: number;
}

/** Main-side bounded queue around the shared ring; normal pressure never fatally fails a root. */
export class SabMutationTransport {
  readonly #endpoint: MessageEndpoint;
  readonly #acknowledgementTimeoutMs: number;
  readonly #maxBufferedBytes: number;
  readonly #maxBufferedFrames: number;
  readonly #onError: ((error: Error) => void) | undefined;
  readonly #ring: SabMutationRing;
  readonly #sessionId: number;
  readonly #pending: QueuedFrame[] = [];
  readonly #published: PublishedFrame[] = [];
  readonly #drainWaiters: Array<{ reject: (error: Error) => void; resolve: () => void }> = [];
  #acknowledged = 0;
  #ackTimer: number | undefined;
  #bufferedBytes = 0;
  #closed = false;
  #failure: Error | undefined;
  #highWatermark = 0;
  #latestAcknowledgedSequence = 0;
  #latestAcceptedSequence = 0;
  #merged = 0;
  #rejected = 0;
  #timeouts = 0;

  public constructor(
    endpoint: MessageEndpoint,
    ring: SabMutationRing,
    options: SabMutationTransportOptions,
  ) {
    this.#endpoint = endpoint;
    this.#acknowledgementTimeoutMs = boundedInteger(
      options.acknowledgementTimeoutMs ?? 5_000,
      1,
      60_000,
      "acknowledgementTimeoutMs",
    );
    this.#ring = ring;
    this.#sessionId = positiveU32(options.sessionId, "sessionId");
    this.#maxBufferedFrames = boundedInteger(
      options.maxBufferedFrames ?? 128,
      2,
      4096,
      "maxBufferedFrames",
    );
    this.#maxBufferedBytes = boundedInteger(
      options.maxBufferedBytes ?? 64 * 1024 * 1024,
      4,
      MAX_BUFFERED_BYTES,
      "maxBufferedBytes",
    );
    this.#onError = options.onError;
    endpoint.addEventListener("message", this.#handleMessage);
  }

  public enqueue(frameSeq: number, bytes: Uint8Array): void {
    this.assertOpen();
    const sequence = positiveU32(frameSeq, "frameSeq");
    if (!(bytes instanceof Uint8Array)) throw new TypeError("mutation payload must be Uint8Array");
    if (bytes.byteLength === 0 || bytes.byteLength % 4 !== 0) {
      throw new RangeError("mutation payload must be non-empty and four-byte aligned");
    }
    if (bytes.byteLength > this.#ring.payloadBytes) {
      throw new RangeError("mutation payload exceeds the SAB slot budget");
    }
    if (
      this.#latestAcceptedSequence !== 0 &&
      sequence !== nextFrameSequence(this.#latestAcceptedSequence)
    ) {
      throw new Error("mutation frame sequence is not contiguous");
    }
    const bufferedFrames = this.#pending.length + this.#published.length;
    if (
      bufferedFrames >= this.#maxBufferedFrames ||
      this.#bufferedBytes + bytes.byteLength > this.#maxBufferedBytes
    ) {
      if (this.mergeNewestPending(sequence, bytes)) return;
      this.#rejected += 1;
      throw new MutationTransportBackpressureError("SAB mutation buffer is full");
    }
    this.#pending.push({ byteLength: bytes.byteLength, bytes: bytes.slice(), frameSeq: sequence });
    this.#bufferedBytes += bytes.byteLength;
    this.#latestAcceptedSequence = sequence;
    this.#highWatermark = Math.max(this.#highWatermark, bufferedFrames + 1);
    this.flush();
  }

  public drain(): Promise<void> {
    if (this.#failure !== undefined) return Promise.reject(this.#failure);
    if (this.#pending.length === 0 && this.#published.length === 0) return Promise.resolve();
    return new Promise<void>((resolve, reject) => this.#drainWaiters.push({ reject, resolve }));
  }

  public close(): Promise<void> {
    this.#closed = true;
    return this.drain().finally(() => {
      this.#ring.close();
      this.detach();
      this.wake();
    });
  }

  public abort(reason: Error = new Error("SAB mutation transport aborted")): void {
    if (this.#failure !== undefined) return;
    this.#ring.close();
    this.fail(reason);
  }

  public metrics(): SabMutationTransportMetrics {
    return {
      acknowledged: this.#acknowledged,
      bufferedBytes: this.#bufferedBytes,
      highWatermark: this.#highWatermark,
      latestAcknowledgedSequence: this.#latestAcknowledgedSequence,
      latestAcceptedSequence: this.#latestAcceptedSequence,
      merged: this.#merged,
      mode: "sab",
      publishedAwaitingAck: this.#published.length,
      queued: this.#pending.length,
      rejected: this.#rejected,
      ring: this.#ring.metrics(),
      timeouts: this.#timeouts,
    };
  }

  readonly #handleMessage = (event: MessageEvent<unknown>): void => {
    const message = event.data;
    if (!isResponseEnvelope(message)) return;
    if (!isPositiveU32(message.sessionId)) {
      this.fail(new Error("SAB response has an invalid session"));
      return;
    }
    if (message.sessionId !== this.#sessionId) return;
    if (!isResponse(message)) {
      this.fail(new Error("SAB response is malformed"));
      return;
    }
    if (message.version !== TRANSPORT_VERSION) {
      this.fail(new Error("SAB transport version mismatch"));
      return;
    }
    if (message.kind === "pingo:sab-error") {
      this.fail(new Error(`render Worker rejected SAB mutation: ${message.error}`));
      return;
    }
    const expected = this.#published[0];
    if (expected === undefined || message.frameSeq !== expected.frameSeq) {
      this.fail(new Error("SAB acknowledgement is missing, duplicate, or out of order"));
      return;
    }
    this.#published.shift();
    this.clearAcknowledgementTimer();
    this.#bufferedBytes -= expected.byteLength;
    this.#acknowledged += 1;
    this.#latestAcknowledgedSequence = message.frameSeq;
    this.flush();
    this.armAcknowledgementTimer();
    this.resolveDrainIfEmpty();
  };

  private flush(): void {
    let publishedAny = false;
    while (this.#failure === undefined && this.#pending.length > 0) {
      const frame = this.#pending[0];
      if (frame === undefined || !this.#ring.tryPublish(frame.frameSeq, frame.bytes)) break;
      this.#pending.shift();
      this.#published.push({ byteLength: frame.byteLength, frameSeq: frame.frameSeq });
      publishedAny = true;
    }
    if (publishedAny) this.wake();
    this.armAcknowledgementTimer();
  }

  private wake(): void {
    const message: WakeMessage = {
      kind: "pingo:sab-wake",
      sessionId: this.#sessionId,
      version: TRANSPORT_VERSION,
    };
    try {
      this.#endpoint.postMessage(message);
    } catch (cause) {
      this.fail(toError(cause, "SAB Worker wake failed"));
    }
  }

  private assertOpen(): void {
    if (this.#failure !== undefined) throw this.#failure;
    if (this.#closed) throw new Error("SAB mutation transport is closed");
  }

  private mergeNewestPending(frameSeq: number, bytes: Uint8Array): boolean {
    const previous = this.#pending.at(-1);
    if (previous === undefined) return false;
    let merged: Uint8Array;
    try {
      const first = decodeMutationBatch(previous.bytes);
      const second = decodeMutationBatch(bytes);
      if (first.frameSeq !== previous.frameSeq || second.frameSeq !== frameSeq) return false;
      merged = encodeMutationBatch({
        frameSeq,
        mutations: [...first.mutations, ...second.mutations],
      });
    } catch {
      return false;
    }
    if (merged.byteLength > this.#ring.payloadBytes) return false;
    const nextBufferedBytes = this.#bufferedBytes - previous.byteLength + merged.byteLength;
    if (nextBufferedBytes > this.#maxBufferedBytes) return false;
    this.#pending[this.#pending.length - 1] = {
      byteLength: merged.byteLength,
      bytes: merged,
      frameSeq,
    };
    this.#bufferedBytes = nextBufferedBytes;
    this.#latestAcceptedSequence = frameSeq;
    this.#merged += 1;
    return true;
  }

  private fail(error: Error): void {
    if (this.#failure !== undefined) return;
    this.#failure = error;
    this.#closed = true;
    this.clearAcknowledgementTimer();
    this.detach();
    for (const waiter of this.#drainWaiters.splice(0)) waiter.reject(error);
    this.#onError?.(error);
  }

  private resolveDrainIfEmpty(): void {
    if (this.#pending.length !== 0 || this.#published.length !== 0) return;
    for (const waiter of this.#drainWaiters.splice(0)) waiter.resolve();
  }

  private detach(): void {
    this.clearAcknowledgementTimer();
    this.#endpoint.removeEventListener("message", this.#handleMessage);
  }

  private armAcknowledgementTimer(): void {
    if (this.#ackTimer !== undefined || this.#failure !== undefined || this.#published.length === 0)
      return;
    this.#ackTimer = globalThis.setTimeout(() => {
      this.#ackTimer = undefined;
      this.#timeouts += 1;
      this.fail(new Error("SAB mutation acknowledgement timed out"));
    }, this.#acknowledgementTimeoutMs);
  }

  private clearAcknowledgementTimer(): void {
    if (this.#ackTimer === undefined) return;
    clearTimeout(this.#ackTimer);
    this.#ackTimer = undefined;
  }
}

export interface SabMutationReceiverOptions {
  readonly onError?: (error: Error) => void;
  readonly sessionId: number;
}

/** Worker-side shared-ring consumer; drain may be called by wake messages and every render tick. */
export class SabMutationReceiver {
  readonly #consume: (frameSeq: number, bytes: Uint8Array) => Promise<void> | void;
  readonly #endpoint: MessageEndpoint;
  readonly #onError: ((error: Error) => void) | undefined;
  readonly #ring: SabMutationRing;
  readonly #sessionId: number;
  #disposed = false;
  #lastSequence = 0;
  #processing = Promise.resolve();

  public constructor(
    endpoint: MessageEndpoint,
    ring: SabMutationRing,
    consume: (frameSeq: number, bytes: Uint8Array) => Promise<void> | void,
    options: SabMutationReceiverOptions,
  ) {
    this.#endpoint = endpoint;
    this.#ring = ring;
    this.#consume = consume;
    this.#sessionId = positiveU32(options.sessionId, "sessionId");
    this.#onError = options.onError;
    endpoint.addEventListener("message", this.#handleMessage);
  }

  /** Moves every currently committed slot into the ordered async processing chain. */
  public drain(): number {
    if (this.#disposed) return 0;
    let queued = 0;
    while (true) {
      const frame = this.#ring.take();
      if (frame === null) break;
      queued += 1;
      this.#processing = this.#processing
        .then(async () => {
          if (this.#disposed) return;
          if (this.#lastSequence !== 0 && !isNewerSequence(frame.frameSeq, this.#lastSequence)) {
            throw new Error("SAB mutation sequence is not newer");
          }
          await this.#consume(frame.frameSeq, frame.bytes);
          this.#lastSequence = frame.frameSeq;
          const acknowledgement: AckMessage = {
            frameSeq: frame.frameSeq,
            kind: "pingo:sab-ack",
            sessionId: this.#sessionId,
            version: TRANSPORT_VERSION,
          };
          this.#endpoint.postMessage(acknowledgement);
        })
        .catch((cause: unknown) => this.handleFailure(cause));
    }
    return queued;
  }

  public whenIdle(): Promise<void> {
    return this.#processing;
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#endpoint.removeEventListener("message", this.#handleMessage);
  }

  readonly #handleMessage = (event: MessageEvent<unknown>): void => {
    const message = event.data;
    if (!isWakeEnvelope(message) || this.#disposed) return;
    if (!isPositiveU32(message.sessionId)) {
      this.handleFailure(new Error("SAB wake has an invalid session"));
      return;
    }
    if (message.sessionId !== this.#sessionId) return;
    if (!isWake(message)) {
      this.handleFailure(new Error("SAB wake is malformed"));
      return;
    }
    if (message.version !== TRANSPORT_VERSION) {
      this.handleFailure(new Error("SAB transport version mismatch"));
      return;
    }
    this.drain();
  };

  private handleFailure(cause: unknown): void {
    if (this.#disposed) return;
    const error = toError(cause, "render Worker SAB mutation failed");
    const message: ErrorMessage = {
      error: error.message,
      kind: "pingo:sab-error",
      sessionId: this.#sessionId,
      version: TRANSPORT_VERSION,
    };
    try {
      this.#endpoint.postMessage(message);
    } catch {
      // The main-side Worker error/exit path owns recovery when messaging is gone.
    }
    this.#onError?.(error);
    this.dispose();
  }
}

function isWake(value: unknown): value is WakeMessage {
  if (!isWakeEnvelope(value)) return false;
  const message = value as { kind?: unknown; sessionId?: unknown; version?: unknown };
  return (
    message.kind === "pingo:sab-wake" &&
    isPositiveU32(message.sessionId) &&
    Number.isInteger(message.version)
  );
}

function isWakeEnvelope(
  value: unknown,
): value is Record<string, unknown> & { readonly kind: "pingo:sab-wake" } {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { kind?: unknown }).kind === "pingo:sab-wake"
  );
}

function isResponse(value: unknown): value is AckMessage | ErrorMessage {
  if (!isResponseEnvelope(value)) return false;
  if (!isPositiveU32(value.sessionId) || !Number.isInteger(value.version)) return false;
  return value.kind === "pingo:sab-ack"
    ? isPositiveU32(value.frameSeq)
    : typeof value.error === "string";
}

function isResponseEnvelope(
  value: unknown,
): value is Record<string, unknown> & { readonly kind: "pingo:sab-ack" | "pingo:sab-error" } {
  if (typeof value !== "object" || value === null) return false;
  const kind = (value as { kind?: unknown }).kind;
  return kind === "pingo:sab-ack" || kind === "pingo:sab-error";
}

function isPositiveU32(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 0xffff_ffff;
}

function nextFrameSequence(value: number): number {
  const next = (value + 1) >>> 0;
  return next === 0 ? 1 : next;
}

function isNewerSequence(candidate: number, previous: number): boolean {
  const distance = (candidate - previous) >>> 0;
  return distance !== 0 && distance < 0x8000_0000;
}

function positiveU32(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1 || value > 0xffff_ffff) {
    throw new RangeError(`${label} must be a positive u32`);
  }
  return value;
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(
      `${label} must be an integer from ${String(minimum)} to ${String(maximum)}`,
    );
  }
  return value;
}

function toError(cause: unknown, message: string): Error {
  return cause instanceof Error ? cause : new Error(message, { cause });
}
