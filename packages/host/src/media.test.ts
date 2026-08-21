import { describe, expect, it, vi } from "vitest";

import { MediaPipeline } from "./media";

class FakeVideo extends EventTarget {
  public autoPlay = false;
  public crossOrigin: string | null = null;
  public currentTime = 0;
  public duration = 12;
  public ended = false;
  public error: MediaError | null = null;
  public loop = false;
  public muted = false;
  public paused = true;
  public playsInline = false;
  public preload = "";
  public readyState = 2;
  public src = "";
  public videoHeight = 180;
  public videoWidth = 320;
  public playError: Error | undefined;
  #frame: (() => void) | undefined;

  public load(): void {}
  public removeAttribute(name: string): void {
    if (name === "src") this.src = "";
  }
  public play(): Promise<void> {
    if (this.playError !== undefined) return Promise.reject(this.playError);
    this.paused = false;
    this.dispatchEvent(new Event("play"));
    return Promise.resolve();
  }
  public pause(): void {
    if (this.paused) return;
    this.paused = true;
    this.dispatchEvent(new Event("pause"));
  }
  public requestVideoFrameCallback(callback: () => void): number {
    this.#frame = callback;
    return 1;
  }
  public cancelVideoFrameCallback(): void {
    this.#frame = undefined;
  }
  public emitFrame(): void {
    const callback = this.#frame;
    this.#frame = undefined;
    callback?.();
  }
}

const binding = {
  nodeId: 7,
  resourceId: 11,
  src: "https://media.invalid/video.mp4",
  autoPlay: false,
  loop: true,
  muted: true,
  preload: "metadata" as const,
};

describe("MediaPipeline", () => {
  it("loads metadata, controls playback, and submits HTML media without copies", async () => {
    const video = new FakeVideo();
    const submit = vi.fn();
    const metadata = vi.fn();
    const eventTypes: string[] = [];
    const pipeline = new MediaPipeline({
      createVideo: () => video as unknown as HTMLVideoElement,
      transferableFrames: false,
      target: { submit },
      onMetadata: metadata,
      onEvent: (_nodeId, event) => {
        if ("type" in event) eventTypes.push(event.type);
      },
    });

    pipeline.bind(binding, binding.nodeId);
    expect(video.src).toBe(binding.src);
    expect(video.loop).toBe(true);
    expect(video.muted).toBe(true);
    video.dispatchEvent(new Event("loadedmetadata"));
    expect(metadata).toHaveBeenCalledWith(7, 320, 180);
    expect(submit).toHaveBeenCalledWith(11, video, "html-media");

    pipeline.play(7);
    await Promise.resolve();
    pipeline.seek(7, 99);
    expect(video.currentTime).toBe(12);
    pipeline.pause(7);
    expect(eventTypes).toContain("play");
    expect(eventTypes).toContain("pause");
    expect(pipeline.metrics()).toMatchObject({ copiedFrames: 0, submittedFrames: 1 });
    pipeline.close();
  });

  it("keeps one transferable frame in flight and closes stale completion", async () => {
    const video = new FakeVideo();
    let resolveBitmap: ((value: ImageBitmap) => void) | undefined;
    const closeBitmap = vi.fn();
    const bitmap = { close: closeBitmap } as unknown as ImageBitmap;
    const submit = vi.fn();
    const pipeline = new MediaPipeline({
      createVideo: () => video as unknown as HTMLVideoElement,
      createImageBitmap: () =>
        new Promise<ImageBitmap>((resolve) => {
          resolveBitmap = resolve;
        }),
      transferableFrames: true,
      target: { submit },
    });

    pipeline.bind(binding, 7);
    pipeline.play(7);
    video.emitFrame();
    video.emitFrame();
    expect(pipeline.metrics()).toMatchObject({ inFlight: 1, maximumInFlight: 1, droppedFrames: 1 });
    pipeline.bind(undefined, 7);
    resolveBitmap?.(bitmap);
    await Promise.resolve();
    expect(submit).not.toHaveBeenCalled();
    expect(closeBitmap).toHaveBeenCalledOnce();
    expect(pipeline.metrics()).toMatchObject({ inFlight: 0, releasedFrames: 1 });
    pipeline.close();
  });

  it("coalesces a frame burst and submits the newest transferable", async () => {
    const video = new FakeVideo();
    const resolvers: Array<(value: ImageBitmap) => void> = [];
    const closeStale = vi.fn();
    const closeNewest = vi.fn();
    const stale = { close: closeStale } as unknown as ImageBitmap;
    const newest = { close: closeNewest } as unknown as ImageBitmap;
    const submit = vi.fn();
    const pipeline = new MediaPipeline({
      createVideo: () => video as unknown as HTMLVideoElement,
      createImageBitmap: () =>
        new Promise<ImageBitmap>((resolve) => {
          resolvers.push(resolve);
        }),
      transferableFrames: true,
      target: { submit },
    });

    pipeline.bind(binding, 7);
    pipeline.play(7);
    video.emitFrame();
    video.emitFrame();
    resolvers[0]?.(stale);
    await Promise.resolve();
    expect(closeStale).toHaveBeenCalledOnce();
    expect(resolvers).toHaveLength(2);
    expect(pipeline.metrics()).toMatchObject({ inFlight: 1, maximumInFlight: 1 });
    resolvers[1]?.(newest);
    await Promise.resolve();
    expect(submit).toHaveBeenCalledWith(11, newest, "image-bitmap");
    expect(closeNewest).not.toHaveBeenCalled();
    expect(pipeline.metrics()).toMatchObject({
      droppedFrames: 1,
      inFlight: 0,
      releasedFrames: 1,
      submittedFrames: 1,
    });
    pipeline.close();
  });

  it("updates resource ownership without recreating the media element", () => {
    const video = new FakeVideo();
    const createVideo = vi.fn(() => video as unknown as HTMLVideoElement);
    const pipeline = new MediaPipeline({
      createVideo,
      transferableFrames: false,
      target: { submit: vi.fn() },
    });
    pipeline.bind(binding, 7);
    pipeline.bind({ ...binding, resourceId: 12, muted: false }, 7);
    expect(createVideo).toHaveBeenCalledOnce();
    expect(video.muted).toBe(false);
    pipeline.close();
  });

  it("uses a transferable VideoFrame without reporting a copy", () => {
    const video = new FakeVideo();
    const frame = { close: vi.fn() } as unknown as CanvasImageSource;
    const submit = vi.fn();
    const pipeline = new MediaPipeline({
      createVideo: () => video as unknown as HTMLVideoElement,
      createVideoFrame: () => frame,
      transferableFrames: true,
      target: { submit },
    });

    pipeline.bind(binding, 7);
    video.dispatchEvent(new Event("loadedmetadata"));
    expect(submit).toHaveBeenCalledWith(11, frame, "video-frame");
    expect(pipeline.metrics()).toMatchObject({
      copiedFrames: 0,
      inFlight: 0,
      maximumInFlight: 1,
      submittedFrames: 1,
    });
    pipeline.close();
  });

  it("maps media failures and rejects invalid seek values", async () => {
    const video = new FakeVideo();
    const events = vi.fn();
    const pipeline = new MediaPipeline({
      createVideo: () => video as unknown as HTMLVideoElement,
      transferableFrames: false,
      target: { submit: vi.fn() },
      onEvent: events,
    });
    pipeline.bind(binding, 7);
    video.error = { code: 3, message: "decoder failed" } as MediaError;
    video.dispatchEvent(new Event("error"));
    video.playError = new DOMException("blocked", "NotAllowedError");
    pipeline.play(7);
    await Promise.resolve();

    expect(events).toHaveBeenCalledWith(7, { code: "decode", message: "decoder failed" });
    expect(events).toHaveBeenCalledWith(7, { code: "unknown", message: "blocked" });
    expect(() => pipeline.seek(7, Number.NaN)).toThrow(/finite and non-negative/);
    expect(pipeline.metrics().errors).toBe(2);
    pipeline.close();
  });

  it("does not reinterpret a target submission failure as a copy failure", () => {
    const video = new FakeVideo();
    const closeFrame = vi.fn();
    const frame = { close: closeFrame } as unknown as CanvasImageSource;
    const createImageBitmap = vi.fn();
    const pipeline = new MediaPipeline({
      createVideo: () => video as unknown as HTMLVideoElement,
      createVideoFrame: () => frame,
      createImageBitmap,
      transferableFrames: true,
      target: {
        submit: (_resourceId, source) => {
          (source as { close?: () => void }).close?.();
          throw new Error("worker replaced");
        },
      },
    });

    pipeline.bind(binding, 7);
    video.dispatchEvent(new Event("loadedmetadata"));
    expect(closeFrame).toHaveBeenCalledOnce();
    expect(createImageBitmap).not.toHaveBeenCalled();
    expect(pipeline.metrics()).toMatchObject({ errors: 1, inFlight: 0, submittedFrames: 0 });
    pipeline.close();
  });
});
