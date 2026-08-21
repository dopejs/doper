import { spawn } from "node:child_process";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const output = await capture("cargo", [
  "run",
  "--locked",
  "--release",
  "--quiet",
  "--package",
  "pingo-core",
  "--example",
  "m7_animation_benchmark",
]);
const report = JSON.parse(output.trim().split(/\r?\n/u).at(-1) ?? "null");
if (
  report === null ||
  report.version !== 1 ||
  report.animations !== 500 ||
  report.frames !== 240 ||
  !Number.isFinite(report.checksum) ||
  report.checksum === 0
) {
  throw new Error("M7 animation benchmark emitted an invalid report");
}
const limits = {
  p95Ms: 8,
  p99Ms: 16.7,
  retainedBytes: 512 * 1024,
};
for (const [field, maximum] of Object.entries(limits)) {
  const value = report[field];
  if (!Number.isFinite(value) || value > maximum) {
    throw new Error(`M7 animation ${field} ${String(value)} exceeds ${String(maximum)}`);
  }
}
process.stdout.write(`M7 animation benchmark: ${JSON.stringify(report)}\n`);

function capture(command, arguments_) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, {
      cwd: root,
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
      else
        reject(new Error(`${command} failed with code ${String(code)} signal ${String(signal)}`));
    });
  });
}
