import { spawn } from "node:child_process";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const output = await run("cargo", [
  "run",
  "--locked",
  "--release",
  "--quiet",
  "--package",
  "pingo-core",
  "--example",
  "m9_picture_soak",
]);
const report = JSON.parse(output.trim().split(/\r?\n/u).at(-1) ?? "null");
if (
  report?.version !== 1 ||
  report.logicalMinutes !== 30 ||
  report.frames !== 108_000 ||
  report.scrollInputCommands !== report.frames ||
  !Number.isSafeInteger(report.inputOutputFrames) ||
  report.inputOutputFrames < report.frames - 1 ||
  report.animationFrames < report.frames ||
  report.editingOperations !== 180 ||
  report.editingLayoutFrames > report.editingOperations + 1 ||
  report.videoNodes !== 1 ||
  !Number.isSafeInteger(report.residentCount) ||
  report.residentCount < 1 ||
  !Number.isSafeInteger(report.residentBytes) ||
  report.residentBytes < 1 ||
  report.residentBytes > 16 * 1024 * 1024 ||
  report.finalResidentCount !== report.residentCount ||
  !Number.isSafeInteger(report.finalResidentBytes) ||
  report.finalResidentBytes < 1 ||
  !Number.isSafeInteger(report.maximumResidentBytes) ||
  report.maximumResidentBytes < report.residentBytes ||
  report.finalResidentBytes > report.maximumResidentBytes ||
  report.maximumResidentBytes > 16 * 1024 * 1024 ||
  !Number.isSafeInteger(report.maximumResourceBytes) ||
  report.maximumResourceBytes < 1 ||
  typeof report.checksum !== "string" ||
  !/^[1-9][0-9]*$/u.test(report.checksum)
) {
  throw new Error("M9 soak report is malformed or violates its resource budget");
}
process.stdout.write(`M9 accelerated 30-minute Picture soak: ${JSON.stringify(report)}\n`);

function run(command, arguments_) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, {
      cwd: root,
      stdio: ["ignore", "pipe", "inherit"],
    });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve(output);
      else
        reject(new Error(`${command} failed with code ${String(code)} signal ${String(signal)}`));
    });
  });
}
