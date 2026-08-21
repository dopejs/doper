import type { MediaBinding, PingoMediaError, PingoMediaEvent } from "@dopejs/pingo-reconciler";

/** Decode/copy path chosen for one submitted frame. */
export type MediaFramePath = "html-media" | "image-bitmap" | "video-frame";

/** Independently detectable media paths; none are assumed from Worker support. */
export interface MediaCapabilities {
  readonly htmlMediaElement: boolean;
  readonly imageBitmap: boolean;
  readonly videoFrame: boolean;
}

export function detectMediaCapabilities(scope: typeof globalThis = globalThis): MediaCapabilities {
  const values = scope as typeof globalThis & { readonly VideoFrame?: unknown };
  return Object.freeze({
    htmlMediaElement: typeof values.HTMLVideoElement === "function",
    imageBitmap: typeof values.createImageBitmap === "function",
    videoFrame: typeof values.VideoFrame === "function",
  });
}

/** Aggregate counters; `maximumInFlight` is a hard bounded-queue assertion. */
export interface MediaPipelineMetrics {
  readonly bindings: number;
  readonly submittedFrames: number;
  readonly droppedFrames: number;
  readonly copiedFrames: number;
  readonly releasedFrames: number;
  readonly errors: number;
  readonly inFlight: number;
  readonly maximumInFlight: number;
}

export interface MediaFrameTarget {
  /** Takes ownership of `source` even when submission reports an error. */
  submit(resourceId: number, source: CanvasImageSource, path: MediaFramePath): void;
}

export interface MediaPipelineOptions {
  readonly target: MediaFrameTarget;
  readonly transferableFrames: boolean;
  readonly createVideo?: () => HTMLVideoElement;
  readonly createImageBitmap?: (source: CanvasImageSource) => Promise<ImageBitmap>;
  readonly createVideoFrame?: (source: CanvasImageSource) => CanvasImageSource | undefined;
  readonly onMetadata?: (nodeId: number, width: number, height: number) => void;
  readonly onEvent?: (nodeId: number, event: PingoMediaEvent | PingoMediaError) => void;
  readonly onMetrics?: (metrics: MediaPipelineMetrics) => void;
}

interface MediaEntry {
  binding: MediaBinding;
  readonly video: HTMLVideoElement;
  generation: number;
  inFlight: boolean;
  pendingCapture: boolean;
  frameCallback: number | undefined;
  animationFrame: number | undefined;
  wasPlayingBeforeHidden: boolean;
  readonly listeners: Array<readonly [string, EventListener]>;
}

export const MAX_MEDIA_BINDINGS = 256;

/** Host-owned loading/playback pipeline with one in-flight frame per Video. */
export class MediaPipeline {
  readonly #options: MediaPipelineOptions;
  readonly #entries = new Map<number, MediaEntry>();
  #submittedFrames = 0;
  #droppedFrames = 0;
  #copiedFrames = 0;
  #releasedFrames = 0;
  #errors = 0;
  #inFlight = 0;
  #maximumInFlight = 0;
  #closed = false;

  public constructor(options: MediaPipelineOptions) {
    this.#options = options;
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", this.#handleVisibility);
    }
  }

  public bind(binding: MediaBinding | undefined, nodeId: number): void {
    this.assertOpen();
    const current = this.#entries.get(nodeId);
    if (binding === undefined) {
      if (current !== undefined) this.disposeEntry(current);
      this.#entries.delete(nodeId);
      this.reportMetrics();
      return;
    }
    if (current !== undefined && samePlaybackSource(current.binding, binding)) {
      current.binding = binding;
      this.applyMutableOptions(current.video, binding);
      this.capture(current);
      this.reportMetrics();
      return;
    }
    if (current === undefined && this.#entries.size >= MAX_MEDIA_BINDINGS) {
      throw new RangeError(`media binding count exceeds ${String(MAX_MEDIA_BINDINGS)}`);
    }
    if (current !== undefined) this.disposeEntry(current);
    const video = this.createVideo();
    const entry: MediaEntry = {
      binding,
      video,
      generation: 1,
      inFlight: false,
      pendingCapture: false,
      frameCallback: undefined,
      animationFrame: undefined,
      wasPlayingBeforeHidden: false,
      listeners: [],
    };
    this.#entries.set(nodeId, entry);
    this.configure(entry);
    this.reportMetrics();
  }

  public play(nodeId: number): void {
    const entry = this.requireEntry(nodeId);
    void entry.video.play().catch((cause: unknown) => this.emitError(entry, cause));
  }

  public pause(nodeId: number): void {
    this.requireEntry(nodeId).video.pause();
  }

  public seek(nodeId: number, timeSeconds: number): void {
    if (!Number.isFinite(timeSeconds) || timeSeconds < 0) {
      throw new RangeError("media seek time must be finite and non-negative");
    }
    const video = this.requireEntry(nodeId).video;
    video.currentTime = Number.isFinite(video.duration)
      ? Math.min(timeSeconds, video.duration)
      : timeSeconds;
  }

  public metrics(): MediaPipelineMetrics {
    return Object.freeze({
      bindings: this.#entries.size,
      submittedFrames: this.#submittedFrames,
      droppedFrames: this.#droppedFrames,
      copiedFrames: this.#copiedFrames,
      releasedFrames: this.#releasedFrames,
      errors: this.#errors,
      inFlight: this.#inFlight,
      maximumInFlight: this.#maximumInFlight,
    });
  }

  public close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.#handleVisibility);
    }
    for (const entry of this.#entries.values()) this.disposeEntry(entry);
    this.#entries.clear();
    this.reportMetrics();
  }

  private createVideo(): HTMLVideoElement {
    const video = this.#options.createVideo?.() ?? document.createElement("video");
    if (typeof video.play !== "function" || typeof video.pause !== "function") {
      throw new TypeError("media environment did not create an HTMLVideoElement-compatible object");
    }
    return video;
  }

  private configure(entry: MediaEntry): void {
    const { binding, video } = entry;
    if (binding.crossOrigin !== undefined) video.crossOrigin = binding.crossOrigin;
    video.preload = binding.preload;
    video.playsInline = true;
    this.applyMutableOptions(video, binding);
    this.listen(entry, "loadedmetadata", () => {
      const width = video.videoWidth;
      const height = video.videoHeight;
      if (width > 0 && height > 0) this.#options.onMetadata?.(binding.nodeId, width, height);
      this.emitEvent(entry, "loadedmetadata");
      this.capture(entry);
    });
    this.listen(entry, "play", () => {
      this.emitEvent(entry, "play");
      this.scheduleFrames(entry);
    });
    this.listen(entry, "pause", () => this.emitEvent(entry, "pause"));
    this.listen(entry, "ended", () => this.emitEvent(entry, "ended"));
    this.listen(entry, "timeupdate", () => this.emitEvent(entry, "timeupdate"));
    this.listen(entry, "seeked", () => this.capture(entry));
    this.listen(entry, "error", () => this.emitMediaElementError(entry));
    video.src = binding.src;
    video.load();
    if (binding.autoPlay) void video.play().catch((cause: unknown) => this.emitError(entry, cause));
  }

  private applyMutableOptions(video: HTMLVideoElement, binding: MediaBinding): void {
    video.loop = binding.loop;
    video.muted = binding.muted;
  }

  private scheduleFrames(entry: MediaEntry): void {
    const video = entry.video as HTMLVideoElement & {
      requestVideoFrameCallback?: (callback: () => void) => number;
      cancelVideoFrameCallback?: (handle: number) => void;
    };
    if (video.requestVideoFrameCallback !== undefined) {
      const tick = (): void => {
        if (!this.isCurrent(entry) || entry.video.paused || entry.video.ended) return;
        this.capture(entry);
        entry.frameCallback = video.requestVideoFrameCallback?.(tick);
      };
      entry.frameCallback = video.requestVideoFrameCallback(tick);
      return;
    }
    const tick = (): void => {
      if (!this.isCurrent(entry) || entry.video.paused || entry.video.ended) return;
      this.capture(entry);
      entry.animationFrame = requestAnimationFrame(tick);
    };
    entry.animationFrame = requestAnimationFrame(tick);
  }

  private capture(entry: MediaEntry): void {
    if (!this.isCurrent(entry) || entry.video.readyState < 2) return;
    if (!this.#options.transferableFrames) {
      this.#options.target.submit(entry.binding.resourceId, entry.video, "html-media");
      this.#submittedFrames += 1;
      this.reportMetrics();
      return;
    }
    if (entry.inFlight) {
      // Coalesce a producer burst into one pending capture. The current copy
      // is discarded when it completes, so the newest frame wins while the
      // transferable queue remains strictly bounded.
      entry.pendingCapture = true;
      this.#droppedFrames += 1;
      this.reportMetrics();
      return;
    }
    const generation = entry.generation;
    entry.inFlight = true;
    this.#inFlight += 1;
    this.#maximumInFlight = Math.max(this.#maximumInFlight, this.#inFlight);
    let frame: CanvasImageSource | undefined;
    try {
      frame = this.#options.createVideoFrame?.(entry.video);
    } catch (cause) {
      this.emitError(entry, cause);
    }
    if (frame !== undefined) {
      this.finishCapture(entry, generation, frame, "video-frame");
      return;
    }
    const create = this.#options.createImageBitmap ?? globalThis.createImageBitmap;
    if (typeof create !== "function") {
      this.finishCapture(entry, generation, undefined, "image-bitmap");
      this.emitError(entry, new Error("transferable media frames are unavailable"));
      return;
    }
    void create(entry.video).then(
      (bitmap) => this.finishCapture(entry, generation, bitmap, "image-bitmap"),
      (cause: unknown) => {
        this.finishCapture(entry, generation, undefined, "image-bitmap");
        this.emitError(entry, cause);
      },
    );
  }

  private finishCapture(
    entry: MediaEntry,
    generation: number,
    source: CanvasImageSource | undefined,
    path: MediaFramePath,
  ): void {
    if (entry.inFlight) {
      entry.inFlight = false;
      this.#inFlight -= 1;
    }
    if (!this.isCurrent(entry) || entry.generation !== generation) {
      if (source !== undefined) {
        closeSource(source);
        this.#releasedFrames += 1;
      }
      this.reportMetrics();
      return;
    }
    if (entry.pendingCapture) {
      entry.pendingCapture = false;
      if (source !== undefined) {
        closeSource(source);
        this.#releasedFrames += 1;
      }
      this.capture(entry);
      this.reportMetrics();
      return;
    }
    if (source === undefined) {
      this.reportMetrics();
      return;
    }
    try {
      this.#options.target.submit(entry.binding.resourceId, source, path);
    } catch (cause) {
      this.emitError(entry, cause);
      return;
    }
    this.#submittedFrames += 1;
    if (path === "image-bitmap") this.#copiedFrames += 1;
    this.reportMetrics();
  }

  private emitEvent(entry: MediaEntry, type: PingoMediaEvent["type"]): void {
    this.#options.onEvent?.(
      entry.binding.nodeId,
      Object.freeze({
        type,
        currentTime: finiteOrZero(entry.video.currentTime),
        duration: finiteOrZero(entry.video.duration),
      }),
    );
  }

  private emitMediaElementError(entry: MediaEntry): void {
    const code = entry.video.error?.code;
    const mapped: PingoMediaError["code"] =
      code === 1
        ? "aborted"
        : code === 2
          ? "network"
          : code === 3
            ? "decode"
            : code === 4
              ? "not-supported"
              : "unknown";
    this.emitError(
      entry,
      new Error(entry.video.error?.message || `media error ${String(code ?? 0)}`),
      mapped,
    );
  }

  private emitError(
    entry: MediaEntry,
    cause: unknown,
    code: PingoMediaError["code"] = typeof DOMException === "function" &&
    cause instanceof DOMException &&
    cause.name === "SecurityError"
      ? "security"
      : "unknown",
  ): void {
    this.#errors += 1;
    this.#options.onEvent?.(
      entry.binding.nodeId,
      Object.freeze({ code, message: cause instanceof Error ? cause.message : String(cause) }),
    );
    this.reportMetrics();
  }

  private listen(entry: MediaEntry, type: string, listener: EventListener): void {
    entry.video.addEventListener(type, listener);
    entry.listeners.push([type, listener]);
  }

  private disposeEntry(entry: MediaEntry): void {
    entry.generation += 1;
    entry.pendingCapture = false;
    for (const [type, listener] of entry.listeners) entry.video.removeEventListener(type, listener);
    const video = entry.video as HTMLVideoElement & {
      cancelVideoFrameCallback?: (handle: number) => void;
    };
    if (entry.frameCallback !== undefined) video.cancelVideoFrameCallback?.(entry.frameCallback);
    if (entry.animationFrame !== undefined) cancelAnimationFrame(entry.animationFrame);
    entry.video.pause();
    entry.video.removeAttribute("src");
    entry.video.load();
  }

  private isCurrent(entry: MediaEntry): boolean {
    return this.#entries.get(entry.binding.nodeId) === entry && !this.#closed;
  }

  private requireEntry(nodeId: number): MediaEntry {
    this.assertOpen();
    const entry = this.#entries.get(nodeId);
    if (entry === undefined) throw new Error(`video node ${String(nodeId)} is not mounted`);
    return entry;
  }

  private assertOpen(): void {
    if (this.#closed) throw new Error("media pipeline is closed");
  }

  private reportMetrics(): void {
    this.#options.onMetrics?.(this.metrics());
  }

  readonly #handleVisibility = (): void => {
    if (typeof document === "undefined") return;
    for (const entry of this.#entries.values()) {
      if (document.hidden) {
        entry.wasPlayingBeforeHidden = !entry.video.paused;
        if (entry.wasPlayingBeforeHidden) entry.video.pause();
      } else if (entry.wasPlayingBeforeHidden) {
        entry.wasPlayingBeforeHidden = false;
        void entry.video.play().catch((cause: unknown) => this.emitError(entry, cause));
      }
    }
  };
}

function samePlaybackSource(left: MediaBinding, right: MediaBinding): boolean {
  return (
    left.src === right.src &&
    left.crossOrigin === right.crossOrigin &&
    left.preload === right.preload
  );
}

function closeSource(source: CanvasImageSource): void {
  const close = (source as { close?: () => void }).close;
  if (typeof close === "function") close.call(source);
}

function finiteOrZero(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}
