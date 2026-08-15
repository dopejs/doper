import { decodeMutationBatch, encodeMutationBatch } from "@dopejs/doper-reconciler";

import { MutationTransportBackpressureError } from "./transport-errors";

const TRANSPORT_VERSION = 1;
const MAX_BUFFERED_BYTES = 256 * 1024 * 1024;

interface MessageEndpoint {
  addEventListener(type: "message", listener: (event: MessageEvent<unknown>) => void): void;
  postMessage(message: unknown, transfer?: readonly Transferable[]): void;
  removeEventListener(type: "message", listener: (event: MessageEvent<unknown>) => void): void;
}

interface MutationMessage {
  readonly bytes: ArrayBuffer;
  readonly frameSeq: number;
  readonly kind: "doper:mutation";
  readonly sessionId: number;
  readonly version: number;
}

interface AcknowledgementMessage {
  readonly frameSeq: number;
  readonly kind: "doper:mutation-ack";
  readonly sessionId: number;
  readonly version: number;
}

interface ErrorMessage {
  readonly error: string;
  readonly kind: "doper:mutation-error";
  readonly sessionId: number;
  readonly version: number;
}

export interface PostMessageTransportOptions {
  readonly acknowledgementTimeoutMs?: number;
  readonly maxBufferedBytes?: number;
  readonly maxBufferedFrames?: number;
  readonly maxInFlight?: number;
  readonly onError?: (error: Error) => void;
  readonly sessionId: number;
}

export interface PostMessageTransportMetrics {
  readonly acknowledged: number;
  readonly bufferedBytes: number;
  readonly highWatermark: number;
  readonly inFlight: number;
  readonly latestAcknowledgedSequence: number;
  readonly latestAcceptedSequence: number;
  readonly merged: number;
  readonly mode: "post-message";
  readonly queued: number;
  readonly rejected: number;
  readonly sent: number;
  readonly timeouts: number;
}

interface BufferedFrame {
  readonly bytes: ArrayBuffer;
  readonly byteLength: number;
  readonly frameSeq: number;
}

/** Bounded, ordered postMessage sender with explicit per-frame acknowledgements. */
export class PostMessageMutationTransport {
  readonly #endpoint: MessageEndpoint;
  readonly #acknowledgementTimeoutMs: number;
  readonly #maxBufferedBytes: number;
  readonly #maxBufferedFrames: number;
  readonly #maxInFlight: number;
  readonly #onError: ((error: Error) => void) | undefined;
  readonly #sessionId: number;
  readonly #pending: BufferedFrame[] = [];
  readonly #inFlight: BufferedFrame[] = [];
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
  #sent = 0;
  #timeouts = 0;

  public constructor(endpoint: MessageEndpoint, options: PostMessageTransportOptions) {
    this.#endpoint = endpoint;
    this.#acknowledgementTimeoutMs = boundedInteger(
      options.acknowledgementTimeoutMs ?? 5_000,
      1,
      60_000,
      "acknowledgementTimeoutMs",
    );
    this.#sessionId = positiveU32(options.sessionId, "sessionId");
    this.#maxInFlight = boundedInteger(options.maxInFlight ?? 8, 1, 64, "maxInFlight");
    this.#maxBufferedFrames = boundedInteger(
      options.maxBufferedFrames ?? 128,
      this.#maxInFlight,
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

  /** Copies and accepts one complete transaction or throws before changing transport state. */
  public enqueue(frameSeq: number, bytes: Uint8Array): void {
    this.assertOpen();
    const sequence = positiveU32(frameSeq, "frameSeq");
    if (!(bytes instanceof Uint8Array)) throw new TypeError("mutation payload must be Uint8Array");
    if (bytes.byteLength === 0 || bytes.byteLength % 4 !== 0) {
      throw new RangeError("mutation payload must be non-empty and four-byte aligned");
    }
    if (
      this.#latestAcceptedSequence !== 0 &&
      sequence !== nextFrameSequence(this.#latestAcceptedSequence)
    ) {
      throw new Error("mutation frame sequence is not contiguous");
    }
    const bufferedFrames = this.#pending.length + this.#inFlight.length;
    if (
      bufferedFrames >= this.#maxBufferedFrames ||
      this.#bufferedBytes + bytes.byteLength > this.#maxBufferedBytes
    ) {
      if (this.mergeNewestPending(sequence, bytes)) return;
      this.#rejected += 1;
      throw new MutationTransportBackpressureError("postMessage mutation buffer is full");
    }

    const copy = bytes.slice().buffer;
    this.#pending.push({ bytes: copy, byteLength: bytes.byteLength, frameSeq: sequence });
    this.#bufferedBytes += bytes.byteLength;
    this.#latestAcceptedSequence = sequence;
    this.#highWatermark = Math.max(this.#highWatermark, bufferedFrames + 1);
    this.flush();
  }

  /** Resolves only after every accepted transaction is acknowledged. */
  public drain(): Promise<void> {
    if (this.#failure !== undefined) return Promise.reject(this.#failure);
    if (this.#pending.length === 0 && this.#inFlight.length === 0) return Promise.resolve();
    return new Promise<void>((resolve, reject) => this.#drainWaiters.push({ reject, resolve }));
  }

  /** Stops accepting frames and detaches once already accepted work drains. */
  public close(): Promise<void> {
    this.#closed = true;
    return this.drain().finally(() => this.detach());
  }

  /** Immediately fails outstanding work, used when a Worker crashes or is replaced. */
  public abort(reason: Error = new Error("postMessage mutation transport aborted")): void {
    if (this.#failure !== undefined) return;
    this.fail(reason);
  }

  public metrics(): PostMessageTransportMetrics {
    return {
      acknowledged: this.#acknowledged,
      bufferedBytes: this.#bufferedBytes,
      highWatermark: this.#highWatermark,
      inFlight: this.#inFlight.length,
      latestAcknowledgedSequence: this.#latestAcknowledgedSequence,
      latestAcceptedSequence: this.#latestAcceptedSequence,
      merged: this.#merged,
      mode: "post-message",
      queued: this.#pending.length,
      rejected: this.#rejected,
      sent: this.#sent,
      timeouts: this.#timeouts,
    };
  }

  readonly #handleMessage = (event: MessageEvent<unknown>): void => {
    const message = event.data;
    if (!isTransportEnvelope(message)) return;
    if (!isPositiveU32(message.sessionId)) {
      this.fail(new Error("postMessage response has an invalid session"));
      return;
    }
    if (message.sessionId !== this.#sessionId) return;
    if (!isTransportMessage(message)) {
      this.fail(new Error("postMessage response is malformed"));
      return;
    }
    if (message.version !== TRANSPORT_VERSION) {
      this.fail(new Error("postMessage transport version mismatch"));
      return;
    }
    if (message.kind === "doper:mutation-error") {
      this.fail(new Error(`render Worker rejected mutation: ${message.error}`));
      return;
    }
    if (message.kind !== "doper:mutation-ack") return;
    const expected = this.#inFlight[0];
    if (expected === undefined || message.frameSeq !== expected.frameSeq) {
      this.fail(new Error("postMessage acknowledgement is missing, duplicate, or out of order"));
      return;
    }
    this.#inFlight.shift();
    this.clearAcknowledgementTimer();
    this.#bufferedBytes -= expected.byteLength;
    this.#acknowledged += 1;
    this.#latestAcknowledgedSequence = message.frameSeq;
    this.flush();
    this.armAcknowledgementTimer();
    this.resolveDrainIfEmpty();
  };

  private flush(): void {
    while (
      this.#failure === undefined &&
      this.#inFlight.length < this.#maxInFlight &&
      this.#pending.length > 0
    ) {
      const frame = this.#pending.shift();
      if (frame === undefined) return;
      const message: MutationMessage = {
        bytes: frame.bytes,
        frameSeq: frame.frameSeq,
        kind: "doper:mutation",
        sessionId: this.#sessionId,
        version: TRANSPORT_VERSION,
      };
      try {
        this.#endpoint.postMessage(message, [frame.bytes]);
      } catch (cause) {
        this.fail(toError(cause, "postMessage mutation send failed"));
        return;
      }
      this.#inFlight.push(frame);
      this.#sent += 1;
    }
    this.armAcknowledgementTimer();
  }

  private assertOpen(): void {
    if (this.#failure !== undefined) throw this.#failure;
    if (this.#closed) throw new Error("postMessage mutation transport is closed");
  }

  private mergeNewestPending(frameSeq: number, bytes: Uint8Array): boolean {
    const previous = this.#pending.at(-1);
    if (previous === undefined) return false;
    let merged: Uint8Array;
    try {
      const first = decodeMutationBatch(new Uint8Array(previous.bytes));
      const second = decodeMutationBatch(bytes);
      if (first.frameSeq !== previous.frameSeq || second.frameSeq !== frameSeq) return false;
      merged = encodeMutationBatch({
        frameSeq,
        mutations: [...first.mutations, ...second.mutations],
      });
    } catch {
      return false;
    }
    const nextBufferedBytes = this.#bufferedBytes - previous.byteLength + merged.byteLength;
    if (nextBufferedBytes > this.#maxBufferedBytes) return false;
    this.#pending[this.#pending.length - 1] = {
      byteLength: merged.byteLength,
      bytes: merged.slice().buffer,
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
    if (this.#pending.length !== 0 || this.#inFlight.length !== 0) return;
    for (const waiter of this.#drainWaiters.splice(0)) waiter.resolve();
  }

  private detach(): void {
    this.clearAcknowledgementTimer();
    this.#endpoint.removeEventListener("message", this.#handleMessage);
  }

  private armAcknowledgementTimer(): void {
    if (this.#ackTimer !== undefined || this.#failure !== undefined || this.#inFlight.length === 0)
      return;
    this.#ackTimer = globalThis.setTimeout(() => {
      this.#ackTimer = undefined;
      this.#timeouts += 1;
      this.fail(new Error("postMessage mutation acknowledgement timed out"));
    }, this.#acknowledgementTimeoutMs);
  }

  private clearAcknowledgementTimer(): void {
    if (this.#ackTimer === undefined) return;
    clearTimeout(this.#ackTimer);
    this.#ackTimer = undefined;
  }
}

export interface PostMessageMutationReceiverOptions {
  readonly onError?: (error: Error) => void;
  readonly sessionId: number;
}

/** Worker-side ordered receiver; acknowledgements mean Core and Backend both accepted a frame. */
export class PostMessageMutationReceiver {
  readonly #consume: (frameSeq: number, bytes: Uint8Array) => Promise<void> | void;
  readonly #endpoint: MessageEndpoint;
  readonly #onError: ((error: Error) => void) | undefined;
  readonly #sessionId: number;
  #disposed = false;
  #lastSequence = 0;
  #processing = Promise.resolve();

  public constructor(
    endpoint: MessageEndpoint,
    consume: (frameSeq: number, bytes: Uint8Array) => Promise<void> | void,
    options: PostMessageMutationReceiverOptions,
  ) {
    this.#endpoint = endpoint;
    this.#consume = consume;
    this.#sessionId = positiveU32(options.sessionId, "sessionId");
    this.#onError = options.onError;
    endpoint.addEventListener("message", this.#handleMessage);
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#endpoint.removeEventListener("message", this.#handleMessage);
  }

  readonly #handleMessage = (event: MessageEvent<unknown>): void => {
    const message = event.data;
    if (!isMutationEnvelope(message) || this.#disposed) return;
    if (!isPositiveU32(message.sessionId)) {
      this.handleFailure(new Error("postMessage mutation has an invalid session"));
      return;
    }
    if (message.sessionId !== this.#sessionId) return;
    if (!isMutationMessage(message)) {
      this.handleFailure(new Error("postMessage mutation is malformed"));
      return;
    }
    this.#processing = this.#processing
      .then(() => (this.#disposed ? undefined : this.consume(message)))
      .catch((cause: unknown) => this.handleFailure(cause));
  };

  private async consume(message: MutationMessage): Promise<void> {
    if (message.version !== TRANSPORT_VERSION)
      throw new Error("postMessage transport version mismatch");
    const sequence = positiveU32(message.frameSeq, "frameSeq");
    if (this.#lastSequence !== 0 && !isNewerSequence(sequence, this.#lastSequence)) {
      throw new Error("postMessage mutation sequence is not newer");
    }
    if (!(message.bytes instanceof ArrayBuffer))
      throw new TypeError("mutation bytes must be ArrayBuffer");
    if (message.bytes.byteLength === 0 || message.bytes.byteLength % 4 !== 0) {
      throw new RangeError("mutation bytes must be non-empty and four-byte aligned");
    }
    await this.#consume(sequence, new Uint8Array(message.bytes));
    this.#lastSequence = sequence;
    const acknowledgement: AcknowledgementMessage = {
      frameSeq: sequence,
      kind: "doper:mutation-ack",
      sessionId: this.#sessionId,
      version: TRANSPORT_VERSION,
    };
    this.#endpoint.postMessage(acknowledgement);
  }

  private postError(error: Error): void {
    const message: ErrorMessage = {
      error: error.message,
      kind: "doper:mutation-error",
      sessionId: this.#sessionId,
      version: TRANSPORT_VERSION,
    };
    try {
      this.#endpoint.postMessage(message);
    } catch {
      // The Worker is already unusable; the main-side error/exit path owns recovery.
    }
  }

  private handleFailure(cause: unknown): void {
    if (this.#disposed) return;
    const error = toError(cause, "render Worker mutation failed");
    this.postError(error);
    this.#onError?.(error);
    this.dispose();
  }
}

function isTransportMessage(value: unknown): value is AcknowledgementMessage | ErrorMessage {
  if (!isTransportEnvelope(value)) return false;
  if (!isPositiveU32(value.sessionId) || !Number.isInteger(value.version)) return false;
  return value.kind === "doper:mutation-ack"
    ? isPositiveU32(value.frameSeq)
    : typeof value.error === "string";
}

function isTransportEnvelope(value: unknown): value is Record<string, unknown> & {
  readonly kind: "doper:mutation-ack" | "doper:mutation-error";
} {
  if (typeof value !== "object" || value === null) return false;
  const kind = (value as { kind?: unknown }).kind;
  return kind === "doper:mutation-ack" || kind === "doper:mutation-error";
}

function isMutationMessage(value: unknown): value is MutationMessage {
  if (!isMutationEnvelope(value)) return false;
  const message = value as Partial<MutationMessage>;
  return (
    message.kind === "doper:mutation" &&
    isPositiveU32(message.sessionId) &&
    Number.isInteger(message.version) &&
    isPositiveU32(message.frameSeq) &&
    message.bytes instanceof ArrayBuffer
  );
}

function isMutationEnvelope(
  value: unknown,
): value is Record<string, unknown> & { readonly kind: "doper:mutation" } {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { kind?: unknown }).kind === "doper:mutation"
  );
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
