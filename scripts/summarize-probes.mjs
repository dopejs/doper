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

export function summarizeReports(reports, generatedAt = new Date().toISOString()) {
  const runs = [...reports]
    .sort((left, right) => reportTime(left).localeCompare(reportTime(right)))
    .map((report) => ({
      buildId: report.build.id,
      complete: report.finishedAt !== undefined && Object.keys(report.errors ?? {}).length === 0,
      deviceId: report.deviceId,
      errors: report.errors ?? {},
      finishedAt: report.finishedAt ?? null,
      metrics: readMetrics(report),
      recommendedTransport: report.transport?.recommendedMode ?? null,
      runId: report.runId,
    }));

  return {
    generatedAt,
    reportCount: runs.length,
    reproducibility: compareAdjacent(runs, (run) => `${run.deviceId}\0${run.buildId}`),
    runs,
    trends: compareAdjacent(runs, (run) => run.deviceId),
    version: 1,
  };
}

export async function loadProbeReports(filenames, { allowLocal = false } = {}) {
  const schemaPath = new URL("../docs/schemas/platform-probe-report.schema.json", import.meta.url);
  const schema = JSON.parse(await readFile(schemaPath, "utf8"));
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const validate = ajv.compile(schema);

  return Promise.all(
    filenames.map(async (filename) => {
      const report = JSON.parse(await readFile(filename, "utf8"));
      if (!validate(report)) {
        throw new Error(`${filename} failed validation: ${ajv.errorsText(validate.errors)}`);
      }
      if (
        !allowLocal &&
        (report.build.id === "local-uncommitted" || report.deviceId === "local-dev")
      ) {
        throw new Error(
          `${filename} is local-only; provide VITE_DOPER_BUILD_ID and VITE_DOPER_DEVICE_ID or pass --allow-local`,
        );
      }
      return report;
    }),
  );
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

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
