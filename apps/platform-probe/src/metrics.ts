export interface SampleSummary {
  readonly count: number;
  readonly max: number;
  readonly mean: number;
  readonly min: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
}

export function absoluteHighResolutionTime(timeOrigin: number, timestamp: number): number {
  return timeOrigin + timestamp;
}

export function summarize(samples: readonly number[]): SampleSummary {
  const finite = samples.filter(Number.isFinite).toSorted((left, right) => left - right);
  if (finite.length === 0) {
    throw new Error("Cannot summarize an empty sample set");
  }

  const total = finite.reduce((sum, sample) => sum + sample, 0);
  return {
    count: finite.length,
    max: finite.at(-1) ?? 0,
    mean: total / finite.length,
    min: finite[0] ?? 0,
    p50: percentile(finite, 0.5),
    p95: percentile(finite, 0.95),
    p99: percentile(finite, 0.99),
  };
}

export function percentile(sortedSamples: readonly number[], quantile: number): number {
  if (sortedSamples.length === 0) {
    throw new Error("Cannot compute a percentile for an empty sample set");
  }
  if (quantile < 0 || quantile > 1) {
    throw new RangeError("Quantile must be between zero and one");
  }

  const index = (sortedSamples.length - 1) * quantile;
  const lowerIndex = Math.floor(index);
  const upperIndex = Math.ceil(index);
  const lower = sortedSamples[lowerIndex] ?? 0;
  const upper = sortedSamples[upperIndex] ?? lower;
  return lower + (upper - lower) * (index - lowerIndex);
}

export function round(value: number, digits = 3): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}
