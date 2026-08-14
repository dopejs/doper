import { round, summarize } from "./metrics";
import type { MessageCopyCostCaseResult, MessageCopyCostWorkerResult } from "./protocol";

const bytesPerMiB = 1024 * 1024;

export function analyzeMessageCopyCost(
  payloadBytes: number,
  iterations: number,
  roundTripMs: readonly number[],
  worker: MessageCopyCostWorkerResult,
): MessageCopyCostCaseResult {
  if (!Number.isInteger(payloadBytes) || payloadBytes < 1) {
    throw new RangeError("payloadBytes must be a positive integer");
  }
  if (!Number.isInteger(iterations) || iterations < 1 || roundTripMs.length !== iterations) {
    throw new RangeError("iterations must match the round-trip sample count");
  }
  if (roundTripMs.some((sample) => !Number.isFinite(sample) || sample < 0)) {
    throw new RangeError("round-trip samples must be finite non-negative numbers");
  }
  const totalBytes = payloadBytes * iterations;
  if (!Number.isSafeInteger(totalBytes)) {
    throw new RangeError("message copy byte count exceeds the safe integer range");
  }
  const totalDurationMs = roundTripMs.reduce((total, sample) => total + sample, 0);
  const effectiveMiBPerSecond =
    totalDurationMs === 0 ? 0 : round(totalBytes / bytesPerMiB / (totalDurationMs / 1000));

  return {
    ...worker,
    effectiveMiBPerSecond,
    iterations,
    payloadBytes,
    roundTripMs: [...roundTripMs],
    summary: summarize(roundTripMs),
    totalBytes,
  };
}

export function payloadChecksum(bytes: Uint8Array): number {
  let checksum = 2166136261;
  for (const byte of bytes) {
    checksum = Math.imul(checksum ^ byte, 16777619) >>> 0;
  }
  return checksum;
}
