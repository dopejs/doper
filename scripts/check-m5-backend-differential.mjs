import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = path.join(repositoryRoot, "probes/webgpu-backend/Cargo.toml");

// The prototype lives in an isolated workspace so its heavy GPU dependencies
// never slow the product gates; this script is its only automated entry.
const test = await run("cargo", ["test", "--manifest-path", manifest]);
if (test.code !== 0) {
  process.stderr.write(test.output);
  throw new Error("WebGPU backend differential tests failed");
}
if (test.output.includes("skipped: no GPU adapter")) {
  process.stdout.write(
    "M5 backend differential: SKIPPED (no GPU adapter in this environment); " +
      "platform qualification data is required before any rollout decision\n",
  );
} else {
  process.stdout.write("M5 backend differential: GPU output matched the headless oracle\n");
}

const benchmark = await run("cargo", [
  "run",
  "--release",
  "--manifest-path",
  manifest,
  "--example",
  "m5_backend_benchmark",
]);
if (benchmark.code !== 0) {
  process.stderr.write(benchmark.output);
  throw new Error("WebGPU backend benchmark failed");
}
const line = benchmark.output
  .trim()
  .split("\n")
  .findLast((candidate) => candidate.startsWith("{"));
if (line === undefined) throw new Error("backend benchmark produced no JSON report");
process.stdout.write(`${line}\n`);

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, output }));
  });
}
