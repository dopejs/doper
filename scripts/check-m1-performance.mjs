import { spawn } from "node:child_process";

const maximumP95Ms = 16.7;
const maximumP99Ms = 25;
const maximumDroppedFrameRate = 0.005;
const output = await runCapture("cargo", [
  "run",
  "--locked",
  "--release",
  "--package",
  "doper-core",
  "--example",
  "m1_benchmark",
]);
const line = output
  .trim()
  .split("\n")
  .findLast((candidate) => candidate.startsWith("{"));
if (line === undefined) throw new Error("M1 benchmark produced no JSON report");
const report = JSON.parse(line);
for (const field of ["p95Ms", "p99Ms", "droppedFrameRate", "overInvalidatedFrames"]) {
  if (typeof report[field] !== "number" || !Number.isFinite(report[field])) {
    throw new Error(`M1 benchmark field ${field} is invalid`);
  }
}
if (report.p95Ms > maximumP95Ms) {
  throw new Error(`M1 Core P95 ${String(report.p95Ms)}ms exceeds ${String(maximumP95Ms)}ms`);
}
if (report.p99Ms > maximumP99Ms) {
  throw new Error(`M1 Core P99 ${String(report.p99Ms)}ms exceeds ${String(maximumP99Ms)}ms`);
}
if (report.droppedFrameRate >= maximumDroppedFrameRate) {
  throw new Error(
    `M1 Core dropped-frame rate ${String(report.droppedFrameRate)} must be below ${String(maximumDroppedFrameRate)}`,
  );
}
if (report.overInvalidatedFrames !== 0) {
  throw new Error(
    `M1 Core reported ${String(report.overInvalidatedFrames)} over-invalidated frames`,
  );
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

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
