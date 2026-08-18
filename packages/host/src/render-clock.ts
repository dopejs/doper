export interface RenderClockScheduler {
  clearTimer(handle: number): void;
  now(): number;
  setTimer(callback: () => void, delayMs: number): number;
}

export interface HybridRenderClockOptions {
  readonly anchorFreshnessMs?: number;
  readonly maximumCorrectionMs?: number;
  readonly onError?: (error: Error) => void;
  readonly scheduler?: RenderClockScheduler;
  readonly targetFrameMs?: number;
}

export interface RenderClockFrame {
  readonly anchorFresh: boolean;
  readonly correctionMs: number;
  readonly deltaMs: number;
  readonly frameSeq: number;
  readonly timestamp: number;
}

export interface RenderClockMetrics {
  readonly acceptedAnchors: number;
  readonly anchoredFrames: number;
  readonly frames: number;
  readonly ignoredAnchors: number;
  readonly maximumFrameGapMs: number;
  /** Delay most recently asked of the timer, before it fired. */
  readonly lastRequestedDelayMs: number;
  /** How late the timer actually fired against that request. */
  readonly maximumTimerLatenessMs: number;
  /** Longest the frame callback itself took. */
  readonly maximumCallbackMs: number;
  readonly overruns: number;
  readonly running: boolean;
  readonly selfDrivenFrames: number;
}

/** Worker-owned clock that self-drives through main-thread stalls and softly re-locks to rAF anchors. */
export class HybridRenderClock {
  readonly #anchorFreshnessMs: number;
  readonly #maximumCorrectionMs: number;
  readonly #onError: ((error: Error) => void) | undefined;
  readonly #scheduler: RenderClockScheduler;
  readonly #targetFrameMs: number;
  #acceptedAnchors = 0;
  #anchorSequence = 0;
  #anchorTimestamp: number | undefined;
  #anchoredFrames = 0;
  #callback: ((frame: RenderClockFrame) => void) | undefined;
  #frameSequence = 0;
  #frames = 0;
  #ignoredAnchors = 0;
  #lastFrameTimestamp: number | undefined;
  #maximumFrameGapMs = 0;
  #lastRequestedDelayMs = 0;
  #requestedAt = 0;
  #maximumTimerLatenessMs = 0;
  #maximumCallbackMs = 0;
  #nextDeadline = 0;
  #overruns = 0;
  #running = false;
  #selfDrivenFrames = 0;
  #timer: number | undefined;

  public constructor(options: HybridRenderClockOptions = {}) {
    this.#targetFrameMs = positiveFinite(options.targetFrameMs ?? 1000 / 60, "targetFrameMs");
    this.#anchorFreshnessMs = positiveFinite(options.anchorFreshnessMs ?? 100, "anchorFreshnessMs");
    this.#maximumCorrectionMs = nonNegativeFinite(
      options.maximumCorrectionMs ?? 2,
      "maximumCorrectionMs",
    );
    if (this.#maximumCorrectionMs > this.#targetFrameMs / 2) {
      throw new RangeError("maximumCorrectionMs must not exceed half a frame");
    }
    this.#scheduler = options.scheduler ?? browserScheduler;
    this.#onError = options.onError;
  }

  public start(callback: (frame: RenderClockFrame) => void): void {
    if (this.#running) throw new Error("render clock is already running");
    this.#callback = callback;
    this.#running = true;
    this.#nextDeadline = this.#scheduler.now();
    this.schedule(0);
  }

  public stop(): void {
    if (!this.#running) return;
    this.#running = false;
    this.#callback = undefined;
    if (this.#timer !== undefined) this.#scheduler.clearTimer(this.#timer);
    this.#timer = undefined;
  }

  /** Supplies a main-thread rAF anchor. Duplicate and stale messages are ignored. */
  public anchor(sequence: number, timestamp: number): boolean {
    const anchorSequence = positiveU32(sequence, "anchor sequence");
    const anchorTimestamp = finite(timestamp, "anchor timestamp");
    if (this.#anchorSequence !== 0 && !isNewerSequence(anchorSequence, this.#anchorSequence)) {
      this.#ignoredAnchors += 1;
      return false;
    }
    this.#anchorSequence = anchorSequence;
    this.#anchorTimestamp = anchorTimestamp;
    this.#acceptedAnchors += 1;
    return true;
  }

  public metrics(): RenderClockMetrics {
    return {
      acceptedAnchors: this.#acceptedAnchors,
      anchoredFrames: this.#anchoredFrames,
      frames: this.#frames,
      ignoredAnchors: this.#ignoredAnchors,
      maximumFrameGapMs: this.#maximumFrameGapMs,
      lastRequestedDelayMs: this.#lastRequestedDelayMs,
      maximumTimerLatenessMs: this.#maximumTimerLatenessMs,
      maximumCallbackMs: this.#maximumCallbackMs,
      overruns: this.#overruns,
      running: this.#running,
      selfDrivenFrames: this.#selfDrivenFrames,
    };
  }

  private readonly tick = (): void => {
    this.#timer = undefined;
    if (!this.#running) return;
    const now = this.#scheduler.now();
    if (this.#requestedAt !== 0) {
      const lateness = now - this.#requestedAt - this.#lastRequestedDelayMs;
      this.#maximumTimerLatenessMs = Math.max(this.#maximumTimerLatenessMs, lateness);
    }
    const previousTimestamp = this.#lastFrameTimestamp;
    const deltaMs = previousTimestamp === undefined ? 0 : Math.max(0, now - previousTimestamp);
    if (previousTimestamp !== undefined) {
      this.#maximumFrameGapMs = Math.max(this.#maximumFrameGapMs, deltaMs);
    }
    const anchorFresh =
      this.#anchorTimestamp !== undefined &&
      now >= this.#anchorTimestamp &&
      now - this.#anchorTimestamp <= this.#anchorFreshnessMs;
    let correctionMs = 0;
    let nextDeadline = this.#nextDeadline + this.#targetFrameMs;
    if (anchorFresh && this.#anchorTimestamp !== undefined) {
      const aligned = nextAlignedFrame(now, this.#anchorTimestamp, this.#targetFrameMs);
      correctionMs = clamp(
        aligned - nextDeadline,
        -this.#maximumCorrectionMs,
        this.#maximumCorrectionMs,
      );
      nextDeadline += correctionMs;
      this.#anchoredFrames += 1;
    } else {
      this.#selfDrivenFrames += 1;
    }
    if (nextDeadline < now - this.#targetFrameMs) {
      nextDeadline = now;
      correctionMs = 0;
      this.#overruns += 1;
    }

    this.#frameSequence = nextFrameSequence(this.#frameSequence);
    this.#frames += 1;
    this.#lastFrameTimestamp = now;
    this.#nextDeadline = nextDeadline;
    const callbackStart = this.#scheduler.now();
    try {
      this.#callback?.({
        anchorFresh,
        correctionMs,
        deltaMs,
        frameSeq: this.#frameSequence,
        timestamp: now,
      });
    } catch (cause) {
      // A thrown value is not always an Error: wasm-bindgen rejects with a
      // JsValue, and reporting only the wrapper's message loses the one thing
      // that says what actually failed.
      const error =
        cause instanceof Error
          ? cause
          : new Error(`render clock callback failed: ${describe(cause)}`, { cause });
      this.stop();
      this.#onError?.(error);
      return;
    }
    this.#maximumCallbackMs = Math.max(
      this.#maximumCallbackMs,
      this.#scheduler.now() - callbackStart,
    );
    if (this.#running) this.schedule(Math.max(0, nextDeadline - this.#scheduler.now()));
  };

  private schedule(delayMs: number): void {
    this.#lastRequestedDelayMs = delayMs;
    this.#requestedAt = this.#scheduler.now();
    this.#timer = this.#scheduler.setTimer(this.tick, delayMs);
  }
}

export function nextAlignedFrame(now: number, anchor: number, targetFrameMs: number): number {
  finite(now, "now");
  finite(anchor, "anchor");
  positiveFinite(targetFrameMs, "targetFrameMs");
  const elapsed = Math.max(0, now - anchor);
  return anchor + (Math.floor(elapsed / targetFrameMs) + 1) * targetFrameMs;
}

const browserScheduler: RenderClockScheduler = {
  clearTimer: (handle) => clearTimeout(handle),
  now: () => performance.timeOrigin + performance.now(),
  setTimer: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
};

function isNewerSequence(candidate: number, previous: number): boolean {
  const distance = (candidate - previous) >>> 0;
  return distance !== 0 && distance < 0x8000_0000;
}

function nextFrameSequence(value: number): number {
  const next = (value + 1) >>> 0;
  return next === 0 ? 1 : next;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function positiveU32(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1 || value > 0xffff_ffff) {
    throw new RangeError(`${label} must be a positive u32`);
  }
  return value;
}

function finite(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new RangeError(`${label} must be finite`);
  return value;
}

function positiveFinite(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${label} must be positive`);
  return value;
}

function nonNegativeFinite(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${label} must be non-negative`);
  return value;
}

/** Renders a thrown non-Error value well enough to diagnose it. */
function describe(cause: unknown): string {
  if (typeof cause === "string") return cause;
  if (typeof cause === "object" && cause !== null && "message" in cause) {
    return String(cause.message);
  }
  return String(cause);
}
