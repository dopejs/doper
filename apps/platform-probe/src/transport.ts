import { round, summarize } from "./metrics";
import type { FrameContinuityResult, TransportMode, WorkerCapabilities } from "./protocol";

export interface HostCapabilities {
  readonly crossOriginIsolated: boolean;
  readonly worker: WorkerCapabilities;
}

export interface ContinuitySamples {
  readonly anchorLatencies?: readonly number[];
  readonly finalPixelRgba: readonly number[];
  readonly frameTimestamps: readonly number[];
  readonly mode: TransportMode;
  readonly paintOperations: number;
  readonly phaseErrors?: readonly number[];
  readonly stallEndEpochMs: number;
  readonly stallStartEpochMs: number;
  readonly targetFrameMs: number;
}

export function selectTransport(capabilities: HostCapabilities): TransportMode {
  if (!capabilities.worker.offscreenCanvas) {
    return "main-thread";
  }
  if (
    capabilities.crossOriginIsolated &&
    capabilities.worker.sharedArrayBuffer &&
    typeof SharedArrayBuffer === "function"
  ) {
    return "sab";
  }
  return "post-message";
}

export function analyzeContinuity(samples: ContinuitySamples): FrameContinuityResult {
  const frameIntervals = intervals(samples.frameTimestamps);
  if (frameIntervals.length === 0) {
    throw new Error("Continuity probe requires at least two rendered frames");
  }
  const anchorLatencies = finiteRounded(samples.anchorLatencies ?? []);
  const phaseErrors = finiteRounded(samples.phaseErrors ?? []);
  const maxFrameGapMs = Math.max(...frameIntervals);
  const stallDurationMs = samples.stallEndEpochMs - samples.stallStartEpochMs;
  const framesDuringStall = samples.frameTimestamps.filter(
    (timestamp) => timestamp >= samples.stallStartEpochMs && timestamp < samples.stallEndEpochMs,
  ).length;
  const expectedStallFrames = Math.floor(stallDurationMs / samples.targetFrameMs);
  const missedFrameBudget = frameIntervals.reduce(
    (missed, interval) => missed + Math.max(0, Math.round(interval / samples.targetFrameMs) - 1),
    0,
  );

  return {
    anchorLatencySamples: anchorLatencies,
    ...(anchorLatencies.length === 0 ? {} : { anchorLatencySummary: summarize(anchorLatencies) }),
    continuousDuringStall:
      framesDuringStall >= Math.max(1, expectedStallFrames - 2) &&
      maxFrameGapMs <= samples.targetFrameMs * 2.5,
    durationMs: round((samples.frameTimestamps.at(-1) ?? 0) - (samples.frameTimestamps[0] ?? 0)),
    finalPixelRgba: [...samples.finalPixelRgba],
    frameIntervals,
    frameSummary: summarize(frameIntervals),
    framesDuringStall,
    maxFrameGapMs: round(maxFrameGapMs),
    missedFrameBudget,
    mode: samples.mode,
    paintOperations: samples.paintOperations,
    phaseErrorSamples: phaseErrors,
    ...(phaseErrors.length === 0 ? {} : { phaseErrorSummary: summarize(phaseErrors) }),
    renderedFrames: samples.frameTimestamps.length,
  };
}

export function clampPhaseCorrection(value: number, maximumCorrectionMs = 2): number {
  return Math.max(-maximumCorrectionMs, Math.min(maximumCorrectionMs, value));
}

export function nextAlignedFrame(now: number, anchor: number, targetFrameMs: number): number {
  if (targetFrameMs <= 0) {
    throw new RangeError("Target frame duration must be positive");
  }
  const elapsed = Math.max(0, now - anchor);
  return anchor + (Math.floor(elapsed / targetFrameMs) + 1) * targetFrameMs;
}

function intervals(timestamps: readonly number[]): number[] {
  const result: number[] = [];
  for (let index = 1; index < timestamps.length; index += 1) {
    const current = timestamps[index];
    const previous = timestamps[index - 1];
    if (current !== undefined && previous !== undefined) {
      result.push(round(current - previous));
    }
  }
  return result;
}

function finiteRounded(samples: readonly number[]): number[] {
  return samples.filter(Number.isFinite).map((sample) => round(sample));
}
