import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { validateM9PictureReport } from "./m9-picture-report.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const fixture = JSON.parse(
  await readFile(path.join(repositoryRoot, "benchmarks/m9/rich-scroll.fixture.v1.json"), "utf8"),
);
const output = await run("cargo", [
  "run",
  "--locked",
  "--release",
  "--quiet",
  "--package",
  "pingo-core",
  "--example",
  "m9_picture_benchmark",
]);
const report = JSON.parse(output.trim().split(/\r?\n/u).at(-1) ?? "null");
validateM9PictureReport(report, fixture);
process.stdout.write(`M9 rich-scroll Picture benchmark: ${JSON.stringify(report)}\n`);

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
      else
        reject(new Error(`${command} failed with code ${String(code)} signal ${String(signal)}`));
    });
  });
}
