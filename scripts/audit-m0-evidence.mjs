import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import { replayImeRecording } from "./replay-ime.mjs";
import { loadProbeReports, summarizeReports } from "./summarize-probes.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestSchemaPath = path.join(
  repositoryRoot,
  "docs/schemas/m0-evidence-manifest.schema.json",
);
const requiredRoles = [
  "android-low",
  "android-mid",
  "desktop-chromium",
  "desktop-firefox",
  "desktop-safari",
  "ios-baseline",
  "ios-current",
];
const requiredImeLanguages = ["complex", "ja", "ko", "unicode", "zh"];
const compositionLanguages = new Set(["complex", "ja", "ko", "zh"]);
const mobileRoles = new Set(["android-low", "android-mid", "ios-baseline", "ios-current"]);
let manifestValidatorPromise;

export async function auditM0Evidence({ archiveRoot, manifestPath }) {
  const resolvedArchiveRoot = await realpath(path.resolve(archiveRoot));
  const resolvedManifestPath = await realpath(path.resolve(manifestPath));
  const manifest = JSON.parse(await readFile(resolvedManifestPath, "utf8"));
  await validateManifest(manifest);

  const reportDirectories = new Set(
    manifest.devices.map((device) =>
      path.join(resolvedArchiveRoot, "v1", device.deviceId, manifest.buildId),
    ),
  );
  const imeDirectories = new Set(
    manifest.devices.map((device) =>
      path.join(resolvedArchiveRoot, "ime", "v2", device.deviceId, manifest.buildId),
    ),
  );
  const reportFiles = await listJsonFiles([...reportDirectories], resolvedArchiveRoot);
  const imeFiles = await listJsonFiles([...imeDirectories], resolvedArchiveRoot);
  const reports = await loadProbeReports(reportFiles);
  const imeEvidence = await loadImeEvidence(imeFiles);
  const artifactResults = await Promise.all(
    [
      ["business-audit-artifact", manifest.businessAudit.artifact],
      ["storage-artifact", manifest.storage.artifact],
      ["decision-adr-artifact", manifest.decision.adr],
    ].map(([id, artifact]) => verifyArtifact(path.dirname(resolvedManifestPath), id, artifact)),
  );

  return evaluateM0Evidence({ artifactResults, imeEvidence, manifest, reports });
}

export function evaluateM0Evidence({ artifactResults, imeEvidence, manifest, reports }) {
  const checks = [];
  const addCheck = (id, issues, evidence = {}) => {
    checks.push({ evidence, id, issues, pass: issues.length === 0 });
  };

  const manifestIssues = validateManifestSemantics(manifest);
  addCheck("manifest", manifestIssues, {
    buildId: manifest.buildId,
    deviceCount: manifest.devices.length,
  });

  for (const result of artifactResults) {
    addCheck(result.id, result.pass ? [] : [result.issue], {
      bytes: result.bytes,
      path: result.path,
      sha256: result.actualSha256,
    });
  }

  for (const device of manifest.devices) {
    const roleReports = reports.filter(
      (report) =>
        report.build.id === manifest.buildId &&
        report.deviceId === device.deviceId &&
        report.roleId === device.roleId &&
        report.collection !== undefined &&
        device.batchIds.includes(report.collection.batchId),
    );
    const batchIssues = validateRoleBatches(device, roleReports, manifest.decision.status);
    addCheck(`platform:${device.roleId}`, batchIssues, {
      batchIds: device.batchIds,
      deviceId: device.deviceId,
      reportCount: roleReports.length,
    });

    const roleIme = imeEvidence.filter(
      ({ recording }) =>
        recording.environment.buildId === manifest.buildId &&
        recording.environment.deviceId === device.deviceId &&
        recording.environment.roleId === device.roleId,
    );
    const imeIssues = validateImeCoverage(device, roleIme);
    addCheck(`ime:${device.roleId}`, imeIssues, {
      deviceId: device.deviceId,
      recordingCount: roleIme.length,
    });
  }

  const allIssues = checks.flatMap((check) => check.issues.map((issue) => `${check.id}: ${issue}`));
  return {
    buildId: manifest.buildId,
    checks,
    decision: manifest.decision.status,
    issueCount: allIssues.length,
    issues: allIssues,
    status: allIssues.length === 0 ? "pass" : "fail",
    version: 1,
  };
}

function validateManifestSemantics(manifest) {
  const issues = [];
  const roles = manifest.devices.map((device) => device.roleId);
  if (new Set(roles).size !== roles.length) issues.push("device role IDs must be unique");
  for (const role of requiredRoles) {
    if (!roles.includes(role)) issues.push(`required role ${role} is missing`);
  }
  if (manifest.buildId === "local-uncommitted") {
    issues.push("local-uncommitted is not a formal build ID");
  }
  for (const device of manifest.devices) {
    if (device.deviceId === "local-dev") issues.push(`${device.roleId} uses local-dev`);
    if (device.temperatureRangeC.minimum > device.temperatureRangeC.maximum) {
      issues.push(`${device.roleId} temperature range is inverted`);
    }
    if (device.capabilities.sharedArrayBuffer && !device.capabilities.crossOriginIsolated) {
      issues.push(`${device.roleId} claims SharedArrayBuffer without cross-origin isolation`);
    }
  }
  const decisionTime = Date.parse(manifest.decision.decidedAt);
  for (const [label, timestamp] of [
    ["business review", manifest.businessAudit.reviewedAt],
    ["backup verification", manifest.storage.backupVerifiedAt],
    ["restore verification", manifest.storage.restoreVerifiedAt],
  ]) {
    if (decisionTime < Date.parse(timestamp)) issues.push(`decision predates ${label}`);
  }
  return issues;
}

function validateRoleBatches(device, reports, decisionStatus) {
  const issues = [];
  for (const batchId of device.batchIds) {
    const batchReports = reports.filter((report) => report.collection.batchId === batchId);
    validateCollection(batchReports, "warmup", 5, batchId, issues);
    validateCollection(batchReports, "sample", 15, batchId, issues);
    for (const report of batchReports) validatePlatformReport(device, report, issues);
  }

  const summary = summarizeReports(reports, "1970-01-01T00:00:00.000Z");
  const batches = summary.batches.filter((batch) => device.batchIds.includes(batch.batchId));
  if (batches.length !== 2) issues.push("exactly two summarized sample batches are required");
  for (const batch of batches) {
    if (!batch.complete || batch.expectedSamples !== 15 || batch.receivedSamples !== 15) {
      issues.push(`batch ${batch.batchId} is not a complete 15-sample batch`);
    }
  }
  if (summary.reproducibility.length !== 1 || !summary.reproducibility[0]?.pass) {
    const reasons = summary.reproducibility.flatMap((comparison) => comparison.reasons);
    issues.push(
      `two batches are not reproducible${reasons.length === 0 ? "" : `: ${reasons.join(", ")}`}`,
    );
  }

  if (
    decisionStatus === "go" &&
    device.roleId === "android-low" &&
    !device.capabilities.workerOffscreenCanvas
  ) {
    issues.push("Go requires android-low to prove a Worker rendering path");
  }
  return [...new Set(issues)];
}

function validateCollection(reports, kind, expected, batchId, issues) {
  const entries = reports.filter((report) => report.collection.kind === kind);
  const sequences = entries.map((report) => report.collection.sequence).sort((a, b) => a - b);
  if (
    entries.length !== expected ||
    entries.some((report) => report.collection.total !== expected) ||
    sequences.some((sequence, index) => sequence !== index + 1)
  ) {
    issues.push(`batch ${batchId} must contain ${String(expected)} ordered ${kind} reports`);
  }
}

function validatePlatformReport(device, report, issues) {
  const label = `${report.collection.kind} ${report.collection.sequence} in ${report.collection.batchId}`;
  if (report.finishedAt === undefined || Object.keys(report.errors ?? {}).length > 0) {
    issues.push(`${label} is incomplete or contains errors`);
  }
  const environment = report.environment;
  if (environment === undefined) {
    issues.push(`${label} has no environment snapshot`);
    return;
  }
  const capabilityPairs = [
    ["crossOriginIsolated", environment.crossOriginIsolated],
    ["editContext", environment.editContext],
    ["sharedArrayBuffer", environment.sharedArrayBuffer && environment.worker.sharedArrayBuffer],
    ["workerOffscreenCanvas", environment.worker.offscreenCanvas],
    ["workerRaf", environment.worker.requestAnimationFrame],
  ];
  for (const [name, actual] of capabilityPairs) {
    if (actual !== device.capabilities[name]) issues.push(`${label} capability ${name} changed`);
  }
  if (
    environment.devicePixelRatio !== device.devicePixelRatio ||
    environment.viewport.width !== device.viewport.width ||
    environment.viewport.height !== device.viewport.height
  ) {
    issues.push(`${label} viewport or DPR differs from the device registration`);
  }

  const expectedTransport =
    device.capabilities.crossOriginIsolated &&
    device.capabilities.sharedArrayBuffer &&
    device.capabilities.workerOffscreenCanvas
      ? "sab"
      : device.capabilities.workerOffscreenCanvas
        ? "post-message"
        : "main-thread";
  const transport = report.transport;
  if (transport?.recommendedMode !== expectedTransport) {
    issues.push(`${label} selected an unexpected transport`);
  } else {
    const outcome = transport.modes[expectedTransport];
    if (outcome?.status !== "ok") issues.push(`${label} recommended transport did not run`);
    else if (expectedTransport !== "main-thread" && !outcome.result.continuousDuringStall) {
      issues.push(`${label} Worker transport stopped during the main-thread stall`);
    }
  }
  if (report.messageBackpressure?.backpressureHandled !== true) {
    issues.push(`${label} lacks bounded postMessage evidence`);
  }
  if (report.messageCopyCost?.cases.some((entry) => !entry.verified) !== false) {
    issues.push(`${label} lacks verified postMessage payload-cost evidence`);
  }
  if (
    device.capabilities.sharedArrayBuffer &&
    (report.sabLatency === undefined || report.sabBackpressure?.backpressureHandled !== true)
  ) {
    issues.push(`${label} lacks required SAB evidence`);
  }
  if (report.selfDrive === undefined) issues.push(`${label} lacks Worker self-drive evidence`);
  if (device.capabilities.workerRaf && report.workerRaf === undefined) {
    issues.push(`${label} lacks Worker rAF samples`);
  }
  if (report.canvas?.mainThread === undefined)
    issues.push(`${label} lacks main-thread Canvas data`);
  if (device.capabilities.workerOffscreenCanvas && report.canvas?.worker === undefined) {
    issues.push(`${label} lacks Worker Canvas data`);
  }
  const wasm = report.wasmBudget;
  if (
    wasm === undefined ||
    wasm.gzipBytes > wasm.maximumGzipBytes ||
    wasm.maximumGzipBytes > wasm.productBudgetBytes
  ) {
    issues.push(`${label} violates the representative WASM budget envelope`);
  }
}

function validateImeCoverage(device, evidence) {
  const issues = [];
  const requiredModes = device.capabilities.editContext
    ? ["edit-context", "textarea-proxy"]
    : ["textarea-proxy"];
  for (const mode of requiredModes) {
    for (const language of requiredImeLanguages) {
      const matches = evidence.filter(
        ({ recording }) =>
          recording.environment.mode === mode && recording.environment.language === language,
      );
      if (matches.length === 0) {
        issues.push(`${mode}/${language} recording is missing`);
        continue;
      }
      if (
        compositionLanguages.has(language) &&
        matches.every(({ replay }) => replay.compositionCount < 1)
      ) {
        issues.push(`${mode}/${language} has no completed composition`);
      }
      if (
        mobileRoles.has(device.roleId) &&
        matches.every(({ replay }) => !replay.softKeyboardObserved)
      ) {
        issues.push(`${mode}/${language} has no soft-keyboard evidence`);
      }
      if (
        mode === "edit-context" &&
        matches.every(({ replay }) => !replay.characterBoundsObserved)
      ) {
        issues.push(`${mode}/${language} has no character-bounds evidence`);
      }
    }
  }
  return issues;
}

async function loadImeEvidence(filenames) {
  return Promise.all(
    filenames.map(async (filename) => {
      const recording = JSON.parse(await readFile(filename, "utf8"));
      const replay = await replayImeRecording(recording);
      if (recording.environment.roleId === undefined) {
        throw new Error(`${filename} has no platform roleId`);
      }
      return { recording, replay };
    }),
  );
}

async function verifyArtifact(root, id, artifact) {
  const rootPath = await realpath(root);
  const candidate = path.resolve(rootPath, artifact.path);
  assertWithin(rootPath, candidate, `${id} path`);
  let metadata;
  try {
    metadata = await lstat(candidate);
  } catch (error) {
    if (error !== null && typeof error === "object" && error.code === "ENOENT") {
      return { id, issue: "artifact is missing", pass: false, path: artifact.path };
    }
    throw error;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    return { id, issue: "artifact is not a regular file", pass: false, path: artifact.path };
  }
  const resolved = await realpath(candidate);
  assertWithin(rootPath, resolved, `${id} resolved path`);
  const bytes = await readFile(resolved);
  const actualSha256 = createHash("sha256").update(bytes).digest("hex");
  return {
    actualSha256,
    bytes: bytes.byteLength,
    id,
    issue:
      bytes.byteLength === 0
        ? "artifact is empty"
        : actualSha256 === artifact.sha256
          ? null
          : "artifact SHA-256 does not match",
    pass: actualSha256 === artifact.sha256 && bytes.byteLength > 0,
    path: artifact.path,
  };
}

async function listJsonFiles(roots, evidenceRoot) {
  const filenames = [];
  for (const root of roots) {
    let rootMetadata;
    try {
      rootMetadata = await lstat(root);
    } catch (error) {
      if (error !== null && typeof error === "object" && error.code === "ENOENT") continue;
      throw error;
    }
    if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
      throw new Error(`${root} is not a regular evidence directory`);
    }
    assertWithin(evidenceRoot, await realpath(root), "evidence directory");
    async function visit(directory) {
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        if (error !== null && typeof error === "object" && error.code === "ENOENT") return;
        throw error;
      }
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const filename = path.join(directory, entry.name);
        if (entry.isDirectory()) await visit(filename);
        else if (entry.isFile() && entry.name.endsWith(".json")) filenames.push(filename);
      }
    }
    await visit(root);
  }
  return [...new Set(filenames)];
}

function assertWithin(root, candidate, label) {
  const relative = path.relative(root, candidate);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return;
  throw new Error(`${label} escapes its evidence root`);
}

async function validateManifest(manifest) {
  const { ajv, validate } = await manifestValidator();
  if (!validate(manifest)) {
    throw new Error(`M0 evidence manifest failed validation: ${ajv.errorsText(validate.errors)}`);
  }
}

async function manifestValidator() {
  manifestValidatorPromise ??= (async () => {
    const schema = JSON.parse(await readFile(manifestSchemaPath, "utf8"));
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    return { ajv, validate: ajv.compile(schema) };
  })();
  return manifestValidatorPromise;
}

function parseArguments(arguments_) {
  const options = {
    archive: "target/probe-archive",
    manifest: "target/probe-archive/m0-evidence.v1.json",
  };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--") continue;
    if (!["--archive", "--manifest", "--output"].includes(argument)) {
      throw new Error(`Unknown option: ${argument}`);
    }
    const value = arguments_[index + 1];
    if (value === undefined) throw new Error(`${argument} requires a value`);
    options[argument.slice(2)] = value;
    index += 1;
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const result = await auditM0Evidence({
    archiveRoot: options.archive,
    manifestPath: options.manifest,
  });
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  if (options.output === undefined) process.stdout.write(serialized);
  else await writeFile(options.output, serialized, { encoding: "utf8", flag: "wx" });
  if (result.status !== "pass") process.exitCode = 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(
      `M0 evidence audit failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
