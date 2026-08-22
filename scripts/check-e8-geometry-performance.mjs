import { spawn } from "node:child_process";

// Measured on the reference machine: idle export p95 0.46us, and per-observed
// cost 0.115us in a 1k-node scene against 0.151us in an 8k one. The bounds
// below sit well clear of that while still failing if the export ever becomes
// proportional to scene size, which is the property the design depends on.
const maximumIdleP95Micros = 5;
const maximumCappedP95Micros = 200;
const maximumSceneGrowthFactor = 3;
const cap = 64;

const output = await runCapture("cargo", [
  "run",
  "--locked",
  "--release",
  "--package",
  "pingo-core",
  "--example",
  "e8_geometry_benchmark",
]);
const line = output
  .trim()
  .split("\n")
  .findLast((candidate) => candidate.startsWith("{"));
if (line === undefined) throw new Error("E8 geometry benchmark produced no JSON report");
const report = JSON.parse(line);
if (!Array.isArray(report.cases) || report.cases.length === 0) {
  throw new Error("E8 geometry benchmark reported no cases");
}

for (const entry of report.cases) {
  for (const field of ["nodes", "observed", "records", "exportP50Micros", "exportP95Micros"]) {
    if (typeof entry[field] !== "number" || !Number.isFinite(entry[field])) {
      throw new Error(`E8 geometry benchmark field ${field} is invalid`);
    }
  }
  // A run that exported nothing would look like perfect scaling.
  if (entry.records !== entry.observed) {
    throw new Error(
      `E8 case ${String(entry.nodes)}/${String(entry.observed)} exported ${String(entry.records)} records`,
    );
  }
  if (entry.observed === 0 && entry.exportP95Micros > maximumIdleP95Micros) {
    throw new Error(
      `E8 idle export P95 ${String(entry.exportP95Micros)}us exceeds ${String(maximumIdleP95Micros)}us`,
    );
  }
  if (entry.observed === cap && entry.exportP95Micros > maximumCappedP95Micros) {
    throw new Error(
      `E8 capped export P95 ${String(entry.exportP95Micros)}us exceeds ${String(maximumCappedP95Micros)}us`,
    );
  }
}

// The claim under test: cost follows the observed set, not the scene. A residual
// dependence remains because resolving a node to its index is a binary search
// over every node, so the term is logarithmic; linear growth is what must fail.
const capped = report.cases
  .filter((entry) => entry.observed === cap)
  .sort((left, right) => left.nodes - right.nodes);
if (capped.length < 2) throw new Error("E8 benchmark needs two scene sizes at the cap");
const smallest = capped[0];
const largest = capped[capped.length - 1];
const growth = largest.exportP50Micros / smallest.exportP50Micros;
const sceneGrowth = largest.nodes / smallest.nodes;
if (growth > maximumSceneGrowthFactor) {
  throw new Error(
    `E8 export grew ${growth.toFixed(2)}x for a ${sceneGrowth.toFixed(0)}x scene, above ${String(maximumSceneGrowthFactor)}x`,
  );
}

process.stdout.write(`${JSON.stringify({ ...report, sceneGrowthFactor: growth }, null, 2)}\n`);

function runCapture(command, arguments_) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, { stdio: ["ignore", "pipe", "inherit"] });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve(stdout);
      else
        reject(new Error(`${command} failed with code ${String(code)} signal ${String(signal)}`));
    });
  });
}
