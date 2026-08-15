import { describe, expect, it, vi } from "vitest";

import {
  HybridRenderClock,
  nextAlignedFrame,
  type RenderClockFrame,
  type RenderClockScheduler,
} from "./render-clock";

describe("HybridRenderClock", () => {
  it("continues self-driven frames through a 200ms main-thread anchor stall", () => {
    const scheduler = new ManualScheduler(1_000);
    const frames: RenderClockFrame[] = [];
    const clock = new HybridRenderClock({ scheduler, targetFrameMs: 10 });
    clock.anchor(1, 1_000);
    clock.start((frame) => frames.push(frame));
    scheduler.advanceTo(1_050);
    clock.anchor(2, 1_050);
    scheduler.advanceTo(1_250);
    clock.stop();

    const stalledFrames = frames.filter(({ timestamp }) => timestamp >= 1_050 && timestamp < 1_250);
    expect(stalledFrames.length).toBeGreaterThanOrEqual(18);
    expect(clock.metrics()).toMatchObject({ acceptedAnchors: 2, running: false });
    expect(clock.metrics().selfDrivenFrames).toBeGreaterThan(0);
    expect(clock.metrics().maximumFrameGapMs).toBeLessThanOrEqual(12);
  });

  it("caps phase correction and ignores duplicate or stale anchors", () => {
    const scheduler = new ManualScheduler(0);
    const frames: RenderClockFrame[] = [];
    const clock = new HybridRenderClock({
      maximumCorrectionMs: 2,
      scheduler,
      targetFrameMs: 16,
    });
    expect(clock.anchor(9, 5)).toBe(true);
    expect(clock.anchor(9, 6)).toBe(false);
    expect(clock.anchor(8, 7)).toBe(false);
    clock.start((frame) => frames.push(frame));
    scheduler.advanceTo(80);
    clock.stop();
    expect(frames.every(({ correctionMs }) => Math.abs(correctionMs) <= 2)).toBe(true);
    expect(clock.metrics()).toMatchObject({ acceptedAnchors: 1, ignoredAnchors: 2 });
  });

  it("stops and reports callback failures without scheduling more work", () => {
    const scheduler = new ManualScheduler(0);
    const onError = vi.fn();
    const clock = new HybridRenderClock({ onError, scheduler });
    clock.start(() => {
      throw new Error("paint failed");
    });
    scheduler.advanceTo(100);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "paint failed" }));
    expect(clock.metrics()).toMatchObject({ frames: 1, running: false });
    expect(scheduler.pending).toBe(0);
  });

  it("validates timing configuration and computes strict next phases", () => {
    expect(nextAlignedFrame(10, 0, 5)).toBe(15);
    expect(nextAlignedFrame(-10, 0, 5)).toBe(5);
    expect(() => new HybridRenderClock({ targetFrameMs: 0 })).toThrow(/positive/u);
    expect(() => new HybridRenderClock({ maximumCorrectionMs: 9, targetFrameMs: 16 })).toThrow(
      /half/u,
    );
  });
});

class ManualScheduler implements RenderClockScheduler {
  readonly #timers = new Map<number, { callback: () => void; deadline: number }>();
  #nextHandle = 1;
  #now: number;

  public constructor(now: number) {
    this.#now = now;
  }

  public get pending(): number {
    return this.#timers.size;
  }

  public clearTimer(handle: number): void {
    this.#timers.delete(handle);
  }

  public now(): number {
    return this.#now;
  }

  public setTimer(callback: () => void, delayMs: number): number {
    const handle = this.#nextHandle++;
    this.#timers.set(handle, { callback, deadline: this.#now + delayMs });
    return handle;
  }

  public advanceTo(target: number): void {
    while (true) {
      const next = [...this.#timers.entries()].sort(
        ([firstHandle, first], [secondHandle, second]) =>
          first.deadline - second.deadline || firstHandle - secondHandle,
      )[0];
      if (next === undefined || next[1].deadline > target) break;
      this.#timers.delete(next[0]);
      this.#now = next[1].deadline;
      next[1].callback();
    }
    this.#now = target;
  }
}
