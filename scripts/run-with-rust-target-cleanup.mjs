import { spawn } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rustTarget = path.join(repositoryRoot, "target");
const [command, ...arguments_] = process.argv.slice(2);

if (command === undefined) {
  throw new Error("usage: run-with-rust-target-cleanup.mjs <command> [...arguments]");
}

let taskError;
try {
  await run(command, arguments_);
} catch (cause) {
  taskError = cause;
}

let cleanupError;
try {
  await cleanRustTarget();
} catch (cause) {
  cleanupError = cause;
}

if (taskError !== undefined && cleanupError !== undefined) {
  throw new AggregateError(
    [taskError, cleanupError],
    "command failed and the Rust target could not be cleaned",
  );
}
if (taskError !== undefined) throw taskError;
if (cleanupError !== undefined) throw cleanupError;

async function cleanRustTarget() {
  const repository = await realpath(repositoryRoot);
  if (repository !== repositoryRoot) {
    throw new Error(`repository root resolves unexpectedly: ${repository}`);
  }
  try {
    const target = await lstat(rustTarget);
    if (target.isSymbolicLink() || !target.isDirectory()) {
      throw new Error(`refusing to clean non-directory Rust target: ${rustTarget}`);
    }
    const resolvedTarget = await realpath(rustTarget);
    if (resolvedTarget !== rustTarget || path.dirname(resolvedTarget) !== repositoryRoot) {
      throw new Error(`Rust target resolves outside the repository: ${resolvedTarget}`);
    }
  } catch (cause) {
    if (isMissing(cause)) return;
    throw cause;
  }

  await run("cargo", ["clean", "--target-dir", rustTarget], false);
  try {
    await lstat(rustTarget);
  } catch (cause) {
    if (isMissing(cause)) return;
    throw cause;
  }
  throw new Error(`cargo clean left the Rust target behind: ${rustTarget}`);
}

function run(executable, args, forwardSignals = true) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: repositoryRoot, stdio: "inherit" });
    let receivedSignal;
    const relay = (signal) => {
      receivedSignal ??= signal;
      child.kill(signal);
    };
    const onInterrupt = () => relay("SIGINT");
    const onTerminate = () => relay("SIGTERM");
    if (forwardSignals) {
      process.once("SIGINT", onInterrupt);
      process.once("SIGTERM", onTerminate);
    }
    const detach = () => {
      process.off("SIGINT", onInterrupt);
      process.off("SIGTERM", onTerminate);
    };
    child.once("error", (error) => {
      detach();
      reject(error);
    });
    child.once("exit", (code, signal) => {
      detach();
      if (code === 0 && signal === null && receivedSignal === undefined) {
        resolve();
        return;
      }
      reject(
        new Error(
          `${executable} failed with code ${String(code)} signal ${String(signal ?? receivedSignal)}`,
        ),
      );
    });
  });
}

function isMissing(cause) {
  return typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT";
}
