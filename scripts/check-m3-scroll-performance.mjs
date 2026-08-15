import { spawn } from "node:child_process";
import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const output = await run("cargo", [
  "run",
  "--locked",
  "--release",
  "--quiet",
  "--package",
  "doper-scroll",
  "--example",
  "m3_scroll_benchmark",
]);
const lines = output.trim().split(/\r?\n/u);
const report = JSON.parse(lines.at(-1) ?? "null");
if (
  report === null ||
  report.version !== 1 ||
  report.items !== 1_000_000 ||
  report.frames !== 20_000 ||
  !Number.isFinite(report.checksum) ||
  report.checksum === 0
) {
  throw new Error("M3 scroll benchmark emitted an invalid fixture report");
}

const limits = {
  heapBytes: 16 * 1024 * 1024,
  initializationMicros: 250_000,
  p99Micros: 1_000,
};
for (const [metric, maximum] of Object.entries(limits)) {
  const value = report[metric];
  if (!Number.isFinite(value) || value > maximum) {
    throw new Error(
      `M3 scroll ${metric} ${String(value)} exceeds absolute limit ${String(maximum)}`,
    );
  }
}
process.stdout.write(`M3 million-item scroll: ${JSON.stringify(report)}\n`);

function run(command, arguments_) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, {
      cwd: repositoryRoot,
      stdio: ["ignore", "pipe", "inherit"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve(stdout);
      else {
        reject(new Error(`${command} failed with code ${String(code)} signal ${String(signal)}`));
      }
    });
  });
}
