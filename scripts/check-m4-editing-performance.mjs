import { spawn } from "node:child_process";

const maximumP95Ms = 8;
const maximumP99Ms = 16.7;
const maximumDroppedFrameRate = 0.005;
const output = await runCapture("cargo", [
  "run",
  "--locked",
  "--release",
  "--package",
  "doper-core",
  "--example",
  "m4_editing_benchmark",
]);
const line = output
  .trim()
  .split("\n")
  .findLast((candidate) => candidate.startsWith("{"));
if (line === undefined) throw new Error("M4 editing benchmark produced no JSON report");
const report = JSON.parse(line);
for (const field of ["p95Ms", "p99Ms", "droppedFrameRate"]) {
  if (typeof report[field] !== "number" || !Number.isFinite(report[field])) {
    throw new Error(`M4 editing benchmark field ${field} is invalid`);
  }
}
if (report.p95Ms > maximumP95Ms) {
  throw new Error(`M4 editing P95 ${String(report.p95Ms)}ms exceeds ${String(maximumP95Ms)}ms`);
}
if (report.p99Ms > maximumP99Ms) {
  throw new Error(`M4 editing P99 ${String(report.p99Ms)}ms exceeds ${String(maximumP99Ms)}ms`);
}
if (report.droppedFrameRate >= maximumDroppedFrameRate) {
  throw new Error(
    `M4 editing dropped-frame rate ${String(report.droppedFrameRate)} must be below ${String(maximumDroppedFrameRate)}`,
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
