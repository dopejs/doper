import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const metricDefinitions = {
  mainCanvasOperationsPerSecond: {
    better: "higher",
    read: (report) => report.canvas?.mainThread?.operationsPerSecond,
    unit: "operations/s",
  },
  messageBackpressureAcceptedPerSecond: {
    better: "higher",
    read: (report) => report.messageBackpressure?.acceptedPerSecond,
    unit: "items/s",
  },
  messageCopy1MiBEffectiveMiBPerSecond: {
    better: "higher",
    read: (report) =>
      report.messageCopyCost?.cases.find((result) => result.payloadBytes === 1_048_576)
        ?.effectiveMiBPerSecond,
    unit: "MiB/s",
  },
  messageCopy1MiBP95Ms: {
    better: "lower",
    read: (report) =>
      report.messageCopyCost?.cases.find((result) => result.payloadBytes === 1_048_576)?.summary
        .p95,
    unit: "ms",
  },
  recommendedTransportMaxFrameGapMs: {
    better: "lower",
    read: (report) => {
      const transport = report.transport;
      if (transport === undefined) return undefined;
      const outcome = transport.modes[transport.recommendedMode];
      return outcome.status === "ok" ? outcome.result.maxFrameGapMs : undefined;
    },
    unit: "ms",
  },
  sabBackpressureAcceptedPerSecond: {
    better: "higher",
    read: (report) => report.sabBackpressure?.acceptedPerSecond,
    unit: "items/s",
  },
  sabLatencyP95Ms: {
    better: "lower",
    read: (report) => report.sabLatency?.summary.p95,
    unit: "ms",
  },
  selfDriveP95Ms: {
    better: "lower",
    read: (report) => report.selfDrive?.summary.p95,
    unit: "ms",
  },
  wasmColdStartMs: {
    better: "lower",
    read: (report) => {
      const wasm = report.wasm;
      return wasm === undefined
        ? undefined
        : wasm.fetchMs + wasm.compileAndInstantiateMs + wasm.firstCallMs;
    },
    unit: "ms",
  },
  wasmGzipBytes: {
    better: "lower",
    read: (report) => report.wasm?.gzipBytes,
    unit: "bytes",
  },
  wasmBudgetColdStartMs: {
    better: "lower",
    read: (report) => {
      const wasm = report.wasmBudget;
      return wasm === undefined
        ? undefined
        : wasm.fetchMs + wasm.compileAndInstantiateMs + wasm.firstCallMs;
    },
    unit: "ms",
  },
  wasmBudgetGzipBytes: {
    better: "lower",
    read: (report) => report.wasmBudget?.gzipBytes,
    unit: "bytes",
  },
  workerCanvasOperationsPerSecond: {
    better: "higher",
    read: (report) => report.canvas?.worker?.operationsPerSecond,
    unit: "operations/s",
  },
  workerRafP95Ms: {
    better: "lower",
    read: (report) => report.workerRaf?.summary.p95,
    unit: "ms",
  },
};

let validatorPromise;

export function summarizeReports(reports, generatedAt = new Date().toISOString()) {
  const orderedReports = [...reports].sort((left, right) =>
    reportTime(left).localeCompare(reportTime(right)),
  );
  const runs = orderedReports.map((report) => ({
    buildId: report.build.id,
    collection: report.collection ?? { kind: "single" },
    complete: report.finishedAt !== undefined && Object.keys(report.errors ?? {}).length === 0,
    deviceId: report.deviceId,
    errors: report.errors ?? {},
    finishedAt: report.finishedAt ?? null,
    metrics: readMetrics(report),
    recommendedTransport: report.transport?.recommendedMode ?? null,
    roleId: report.roleId ?? null,
    runId: report.runId,
  }));
  const batches = summarizeBatches(orderedReports);
  const trendRuns = runs.filter((run) => run.collection.kind !== "warmup");

  return {
    batches,
    generatedAt,
    reportCount: runs.length,
    reproducibility: compareBatches(batches),
    runs,
    trends: compareAdjacent(trendRuns, (run) => `${run.roleId ?? "unassigned"}\0${run.deviceId}`),
    version: 2,
  };
}

export async function loadProbeReports(filenames, { allowLocal = false } = {}) {
  return Promise.all(
    filenames.map(async (filename) => {
      const report = JSON.parse(await readFile(filename, "utf8"));
      return validateProbeReport(report, { allowLocal, label: filename });
    }),
  );
}

export async function validateProbeReport(
  report,
  { allowLocal = false, label = "probe report" } = {},
) {
  const { ajv, validate } = await getValidator();
  if (!validate(report)) {
    throw new Error(`${label} failed validation: ${ajv.errorsText(validate.errors)}`);
  }
  if (!allowLocal && (report.build.id === "local-uncommitted" || report.deviceId === "local-dev")) {
    throw new Error(
      `${label} is local-only; provide VITE_DOPER_BUILD_ID and VITE_DOPER_DEVICE_ID or allow local reports explicitly`,
    );
  }
  if (report.sabBackpressure !== undefined) {
    validateBackpressureEvidence(report.sabBackpressure, label);
  }
  if (report.messageBackpressure !== undefined) {
    validateMessageBackpressureEvidence(report.messageBackpressure, label);
  }
  if (report.messageCopyCost !== undefined) {
    validateMessageCopyCostEvidence(report.messageCopyCost, label);
  }
  return report;
}

function validateMessageCopyCostEvidence(result, label) {
  let previousPayloadBytes = 0;
  for (const entry of result.cases) {
    const totalBytes = entry.payloadBytes * entry.iterations;
    const totalDurationMs = entry.roundTripMs.reduce((total, sample) => total + sample, 0);
    const effectiveMiBPerSecond =
      totalDurationMs === 0
        ? 0
        : roundMetric(totalBytes / (1024 * 1024) / (totalDurationMs / 1000));
    const summary = summarizeMetricSamples(entry.roundTripMs);
    const summaryMatches = Object.entries(summary).every(
      ([name, value]) => entry.summary[name] === value,
    );
    if (
      entry.payloadBytes <= previousPayloadBytes ||
      entry.receivedCount !== entry.iterations ||
      entry.roundTripMs.length !== entry.iterations ||
      entry.totalBytes !== totalBytes ||
      entry.effectiveMiBPerSecond !== effectiveMiBPerSecond ||
      !entry.verified ||
      !summaryMatches
    ) {
      throw new Error(`${label} has inconsistent postMessage payload cost evidence`);
    }
    previousPayloadBytes = entry.payloadBytes;
  }
}

function validateMessageBackpressureEvidence(result, label) {
  const acceptedPerSecond =
    result.durationMs === 0 ? 0 : roundMetric(result.acceptedCount / (result.durationMs / 1000));
  const sequenceMonotonic = result.consumedSequences.every(
    (sequence, index, values) => index === 0 || sequence > values[index - 1],
  );
  const sequencesWithinProducedRange = result.consumedSequences.every(
    (sequence) => sequence >= 1 && sequence <= result.producedCount,
  );
  const consumedCount = result.consumedSequences.length;
  const acknowledgedCount = result.acknowledgedSequences.length;
  const latestConsumedSequence = result.consumedSequences.at(-1) ?? 0;
  const latestAcknowledgedSequence = result.acknowledgedSequences.at(-1) ?? 0;
  const acknowledgementsMatch =
    acknowledgedCount === consumedCount &&
    result.acknowledgedSequences.every(
      (sequence, index) => sequence === result.consumedSequences[index],
    );
  const drained =
    result.finalInFlight === 0 &&
    consumedCount === result.acceptedCount &&
    acknowledgedCount === result.acceptedCount;
  const backpressureHandled =
    result.droppedCount > 0 &&
    result.acceptedCount > 0 &&
    result.highWatermark === result.capacity &&
    result.acceptedCount + result.droppedCount === result.producedCount &&
    drained &&
    sequenceMonotonic &&
    sequencesWithinProducedRange &&
    acknowledgementsMatch &&
    latestConsumedSequence === result.latestAcceptedSequence &&
    latestAcknowledgedSequence === result.latestAcceptedSequence;
  if (
    result.acceptedPerSecond !== acceptedPerSecond ||
    result.consumedCount !== consumedCount ||
    result.acknowledgedCount !== acknowledgedCount ||
    result.latestConsumedSequence !== latestConsumedSequence ||
    result.latestAcknowledgedSequence !== latestAcknowledgedSequence ||
    result.sequenceMonotonic !== sequenceMonotonic ||
    result.acknowledgementsMatch !== acknowledgementsMatch ||
    result.drained !== drained ||
    result.backpressureHandled !== backpressureHandled
  ) {
    throw new Error(`${label} has inconsistent postMessage backpressure evidence`);
  }
}

function roundMetric(value, digits = 3) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function summarizeMetricSamples(samples) {
  const sorted = samples.toSorted((left, right) => left - right);
  const total = sorted.reduce((sum, sample) => sum + sample, 0);
  return {
    count: sorted.length,
    max: sorted.at(-1),
    mean: total / sorted.length,
    min: sorted[0],
    p50: metricPercentile(sorted, 0.5),
    p95: metricPercentile(sorted, 0.95),
    p99: metricPercentile(sorted, 0.99),
  };
}

function metricPercentile(sorted, quantile) {
  const index = (sorted.length - 1) * quantile;
  const lowerIndex = Math.floor(index);
  const upperIndex = Math.ceil(index);
  const lower = sorted[lowerIndex];
  const upper = sorted[upperIndex] ?? lower;
  return lower + (upper - lower) * (index - lowerIndex);
}

function validateBackpressureEvidence(result, label) {
  const sequenceMonotonic = result.consumedSequences.every(
    (sequence, index, values) => index === 0 || sequence > values[index - 1],
  );
  const sequencesWithinProducedRange = result.consumedSequences.every(
    (sequence) => sequence >= 1 && sequence <= result.producedCount,
  );
  const consumedCount = result.consumedSequences.length;
  const latestConsumedSequence = result.consumedSequences.at(-1) ?? 0;
  const cursorsMatchCounts =
    result.finalReadCursor === consumedCount && result.finalWriteCursor === result.acceptedCount;
  const drained =
    result.finalReadCursor === result.finalWriteCursor &&
    consumedCount === result.acceptedCount &&
    cursorsMatchCounts;
  const backpressureHandled =
    result.droppedCount > 0 &&
    result.acceptedCount > 0 &&
    result.highWatermark === result.capacity &&
    result.acceptedCount + result.droppedCount === result.producedCount &&
    drained &&
    sequenceMonotonic &&
    sequencesWithinProducedRange &&
    latestConsumedSequence === result.latestAcceptedSequence;
  if (
    result.consumedCount !== consumedCount ||
    result.latestConsumedSequence !== latestConsumedSequence ||
    result.sequenceMonotonic !== sequenceMonotonic ||
    result.drained !== drained ||
    result.backpressureHandled !== backpressureHandled
  ) {
    throw new Error(`${label} has inconsistent SAB backpressure evidence`);
  }
}

async function getValidator() {
  validatorPromise ??= (async () => {
    const schemaPath = new URL(
      "../docs/schemas/platform-probe-report.schema.json",
      import.meta.url,
    );
    const schema = JSON.parse(await readFile(schemaPath, "utf8"));
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    return { ajv, validate: ajv.compile(schema) };
  })();
  return validatorPromise;
}

function readMetrics(report) {
  return Object.fromEntries(
    Object.entries(metricDefinitions).flatMap(([name, definition]) => {
      const value = definition.read(report);
      return typeof value === "number" && Number.isFinite(value)
        ? [[name, { better: definition.better, unit: definition.unit, value }]]
        : [];
    }),
  );
}

function compareAdjacent(runs, groupKey) {
  const groups = new Map();
  for (const run of runs) {
    const key = groupKey(run);
    const group = groups.get(key) ?? [];
    group.push(run);
    groups.set(key, group);
  }

  return [...groups.entries()].flatMap(([group, entries]) =>
    entries.slice(1).map((current, index) => {
      const previous = entries[index];
      return {
        currentRunId: current.runId,
        group,
        metrics: compareMetrics(previous.metrics, current.metrics),
        previousRunId: previous.runId,
      };
    }),
  );
}

function compareMetrics(previous, current) {
  const sharedNames = Object.keys(previous).filter((name) => current[name] !== undefined);
  return Object.fromEntries(
    sharedNames.map((name) => {
      const from = previous[name].value;
      const to = current[name].value;
      const relativeChangePercent = from === 0 ? null : ((to - from) / from) * 100;
      return [
        name,
        {
          better: current[name].better,
          from,
          relativeChangePercent,
          to,
          unit: current[name].unit,
        },
      ];
    }),
  );
}

function summarizeBatches(reports) {
  const groups = new Map();
  for (const report of reports) {
    const collection = report.collection;
    if (collection?.kind !== "sample") continue;
    const key = `${report.roleId ?? "unassigned"}\0${report.deviceId}\0${report.build.id}\0${collection.batchId}`;
    const group = groups.get(key) ?? [];
    group.push(report);
    groups.set(key, group);
  }

  return [...groups.values()].map((entries) => {
    const first = entries[0];
    const batchId = first.collection.batchId;
    const expectedTotals = new Set(entries.map((report) => report.collection.total));
    const sequences = entries.map((report) => report.collection.sequence).sort((a, b) => a - b);
    const expectedSamples = expectedTotals.size === 1 ? entries[0].collection.total : null;
    const sequenceComplete =
      expectedSamples !== null &&
      sequences.length === expectedSamples &&
      sequences.every((sequence, index) => sequence === index + 1);
    const signatures = new Set(entries.map(capabilitySignature));
    return {
      batchId,
      buildId: first.build.id,
      capabilitySignature: signatures.size === 1 ? [...signatures][0] : null,
      complete:
        sequenceComplete &&
        entries.every(
          (report) =>
            report.finishedAt !== undefined && Object.keys(report.errors ?? {}).length === 0,
        ),
      deviceId: first.deviceId,
      expectedSamples,
      finishedAt: entries.at(-1)?.finishedAt ?? null,
      metrics: readBatchMetrics(entries),
      receivedSamples: entries.length,
      roleId: first.roleId ?? null,
      sequences,
      signatureConsistent: signatures.size === 1,
    };
  });
}

function readBatchMetrics(reports) {
  const frameSamples = reports.flatMap((report) => report.workerRaf?.samples ?? []);
  const selfDriveSamples = reports.flatMap((report) => report.selfDrive?.samples ?? []);
  const workerThroughput = reports.flatMap((report) =>
    finiteValues([report.canvas?.worker?.operationsPerSecond]),
  );
  const mainThroughput = reports.flatMap((report) =>
    finiteValues([report.canvas?.mainThread?.operationsPerSecond]),
  );
  const metrics = {};
  if (frameSamples.length > 0) {
    metrics.workerRafP95Ms = {
      better: "lower",
      sampleCount: frameSamples.length,
      unit: "ms",
      value: percentile(frameSamples, 0.95),
    };
  }
  if (selfDriveSamples.length > 0) {
    metrics.selfDriveP95Ms = {
      better: "lower",
      sampleCount: selfDriveSamples.length,
      unit: "ms",
      value: percentile(selfDriveSamples, 0.95),
    };
  }
  if (workerThroughput.length > 0) {
    metrics.workerCanvasOperationsPerSecondMedian = {
      better: "higher",
      sampleCount: workerThroughput.length,
      unit: "operations/s",
      value: percentile(workerThroughput, 0.5),
    };
  }
  if (mainThroughput.length > 0) {
    metrics.mainCanvasOperationsPerSecondMedian = {
      better: "higher",
      sampleCount: mainThroughput.length,
      unit: "operations/s",
      value: percentile(mainThroughput, 0.5),
    };
  }
  return metrics;
}

function compareBatches(batches) {
  const groups = new Map();
  for (const batch of batches) {
    const key = `${batch.roleId ?? "unassigned"}\0${batch.deviceId}\0${batch.buildId}`;
    const group = groups.get(key) ?? [];
    group.push(batch);
    groups.set(key, group);
  }
  return [...groups.entries()].flatMap(([group, entries]) =>
    entries.slice(1).map((current, index) => {
      const previous = entries[index];
      const metrics = compareMetrics(previous.metrics, current.metrics);
      const reasons = [];
      if (!previous.complete || !current.complete) reasons.push("both batches must be complete");
      if (!previous.signatureConsistent || !current.signatureConsistent) {
        reasons.push("capability/transport signature changed within a batch");
      }
      if (previous.capabilitySignature !== current.capabilitySignature) {
        reasons.push("capability/transport signature differs between batches");
      }
      checkFirstAvailableDelta(metrics, ["workerRafP95Ms", "selfDriveP95Ms"], 10, reasons);
      checkFirstAvailableDelta(
        metrics,
        ["workerCanvasOperationsPerSecondMedian", "mainCanvasOperationsPerSecondMedian"],
        5,
        reasons,
      );
      return {
        currentBatchId: current.batchId,
        group,
        metrics,
        pass: reasons.length === 0,
        previousBatchId: previous.batchId,
        reasons,
      };
    }),
  );
}

function checkFirstAvailableDelta(metrics, names, maximumPercent, reasons) {
  const name = names.find((candidate) => metrics[candidate] !== undefined);
  if (name === undefined) {
    reasons.push(`${names.join(" or ")} is missing`);
    return;
  }
  checkDelta(metrics, name, maximumPercent, reasons);
}

function checkDelta(metrics, name, maximumPercent, reasons) {
  const metric = metrics[name];
  if (metric === undefined || metric.relativeChangePercent === null) {
    reasons.push(`${name} is missing or has a zero baseline`);
  } else if (Math.abs(metric.relativeChangePercent) > maximumPercent) {
    reasons.push(`${name} differs by more than ${String(maximumPercent)}%`);
  }
}

function capabilitySignature(report) {
  return JSON.stringify({
    buildMode: report.build.mode,
    crossOriginIsolated: report.environment?.crossOriginIsolated ?? null,
    deviceMemoryGiB: report.environment?.deviceMemoryGiB ?? null,
    devicePixelRatio: report.environment?.devicePixelRatio ?? null,
    editContext: report.environment?.editContext ?? null,
    hardwareConcurrency: report.environment?.hardwareConcurrency ?? null,
    messageBackpressureHandled: report.messageBackpressure?.backpressureHandled ?? null,
    messageCopyCostPayloadBytes:
      report.messageCopyCost?.cases.map((result) => result.payloadBytes) ?? null,
    offscreenCanvas: report.environment?.offscreenCanvas ?? null,
    recommendedTransport: report.transport?.recommendedMode ?? null,
    sabBackpressureHandled: report.sabBackpressure?.backpressureHandled ?? null,
    sharedArrayBuffer: report.environment?.sharedArrayBuffer ?? null,
    transportStatuses:
      report.transport === undefined
        ? null
        : Object.fromEntries(
            Object.entries(report.transport.modes).map(([mode, outcome]) => [mode, outcome.status]),
          ),
    worker: report.environment?.worker ?? null,
    userAgent: report.environment?.userAgent ?? null,
    viewport: report.environment?.viewport ?? null,
  });
}

function percentile(values, quantile) {
  const sorted = finiteValues(values).sort((left, right) => left - right);
  if (sorted.length === 0) return Number.NaN;
  const index = (sorted.length - 1) * quantile;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function finiteValues(values) {
  return values.filter((value) => typeof value === "number" && Number.isFinite(value));
}

function reportTime(report) {
  return report.finishedAt ?? report.startedAt ?? "";
}

async function main() {
  const { allowLocal, filenames, output } = parseArguments(process.argv.slice(2));
  if (filenames.length === 0) {
    throw new Error(
      "Usage: pnpm probe:summary [--allow-local] [--output summary.json] <report.json>...",
    );
  }
  const reports = await loadProbeReports(filenames, { allowLocal });
  const serialized = `${JSON.stringify(summarizeReports(reports), null, 2)}\n`;
  if (output === undefined) {
    process.stdout.write(serialized);
  } else {
    await writeFile(path.resolve(output), serialized, { encoding: "utf8", flag: "wx" });
    process.stdout.write(`wrote ${output}\n`);
  }
}

function parseArguments(arguments_) {
  const filenames = [];
  let allowLocal = false;
  let output;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--") {
      continue;
    } else if (argument === "--allow-local") {
      allowLocal = true;
    } else if (argument === "--output") {
      output = arguments_[index + 1];
      if (output === undefined) throw new Error("--output requires a filename");
      index += 1;
    } else if (argument.startsWith("--")) {
      throw new Error(`Unknown option: ${argument}`);
    } else {
      filenames.push(argument);
    }
  }
  return { allowLocal, filenames, output };
}

const runtimeProcess = Reflect.get(globalThis, "process");
if (
  runtimeProcess !== undefined &&
  runtimeProcess.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(runtimeProcess.argv[1]).href
) {
  await main();
}
