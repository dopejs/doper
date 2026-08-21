import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
export const M9_REQUIRED_ROLES = Object.freeze([
  "android-low",
  "android-mid",
  "ios-baseline",
  "ios-current",
  "desktop-chromium",
  "desktop-safari",
  "desktop-firefox",
]);
const requiredMediaEvents = ["background", "seek", "loop", "error", "recover"];
const requiredA11yChecks = ["focus", "role", "value"];
let validatorsPromise;

/** Reads, integrity-checks, recomputes, and classifies M9 qualification evidence. */
export async function auditM9Evidence({
  manifestPath,
  archiveRoot,
  now = new Date(),
  allowFixture = false,
}) {
  const [validateManifest, validateRaw] = await validators();
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assertSchema(validateManifest, manifest, "M9 evidence manifest");
  const root = await realpath(archiveRoot);
  const batches = new Map();
  for (const role of manifest.roles) {
    for (const entry of role.batches) {
      const filename = path.resolve(root, entry.path);
      assertWithin(root, filename);
      const resolvedFilename = await realpath(filename);
      assertWithin(root, resolvedFilename);
      if (resolvedFilename !== filename) {
        throw new Error(`evidence ${entry.path} must not traverse a symlink`);
      }
      const metadata = await lstat(filename);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new Error(`evidence ${entry.path} must be a regular non-symlink file`);
      }
      if (metadata.size > 16 * 1024 * 1024) throw new Error(`evidence ${entry.path} is too large`);
      const bytes = await readFile(filename);
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (digest !== entry.sha256) throw new Error(`evidence ${entry.path} digest mismatch`);
      const raw = JSON.parse(bytes.toString("utf8"));
      assertSchema(validateRaw, raw, `raw evidence ${entry.path}`);
      batches.set(`${role.roleId}:${entry.batchId}`, raw);
    }
  }
  return evaluateM9Evidence({ allowFixture, batches, manifest, now });
}

/** Pure evaluator used by hostile fixture tests and candidate reporting. */
export function evaluateM9Evidence({ manifest, batches, now, allowFixture = false }) {
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) throw new Error("qualification clock is invalid");
  const duplicateRoles = duplicates(manifest.roles.map((role) => role.roleId));
  const unknownRoles = manifest.roles
    .map((role) => role.roleId)
    .filter((role) => !M9_REQUIRED_ROLES.includes(role));
  const globalBatchIds = manifest.roles.flatMap((role) =>
    role.batches.map((batch) => batch.batchId),
  );
  const globalIssues = [
    ...duplicateRoles.map((role) => `duplicate role ${role}`),
    ...unknownRoles.map((role) => `unknown role ${role}`),
    ...duplicates(globalBatchIds).map((batch) => `batch ${batch} is reused across roles`),
  ];
  if (manifest.fixture === true && !allowFixture)
    globalIssues.push("fixture evidence is not formal");
  const roleResults = new Map();
  for (const role of manifest.roles) {
    const issues = [];
    let expired = false;
    const summaries = [];
    for (const entry of role.batches) {
      const raw = batches.get(`${role.roleId}:${entry.batchId}`);
      if (raw === undefined) {
        issues.push(`batch ${entry.batchId} is missing`);
        continue;
      }
      for (const [field, expected, actual] of [
        ["batchId", entry.batchId, raw.batchId],
        ["roleId", role.roleId, raw.roleId],
        ["deviceId", role.deviceId, raw.deviceId],
      ]) {
        if (actual !== expected) issues.push(`batch ${entry.batchId} ${field} mismatch`);
      }
      if (canonical(raw.build) !== canonical(manifest.build)) {
        issues.push(`batch ${entry.batchId} build mismatch`);
      }
      if (canonical(raw.environment) !== canonical(role.environment)) {
        issues.push(`batch ${entry.batchId} environment drift`);
      }
      const collected = Date.parse(raw.collectedAt);
      const ageMs = nowMs - collected;
      if (!Number.isFinite(collected) || ageMs < 0)
        issues.push(`batch ${entry.batchId} timestamp invalid`);
      else if (ageMs > manifest.policy.maximumAgeDays * 86_400_000) expired = true;
      const summary = summarize(raw);
      summaries.push(summary);
      if (raw.frames.length < manifest.policy.minimumFramesPerBatch) {
        issues.push(`batch ${entry.batchId} has too few raw frames`);
      }
      for (const field of [
        "p95Ms",
        "p99Ms",
        "droppedFrameRate",
        "peakMemoryBytes",
        "coldStartMs",
      ]) {
        if (entry.summary[field] !== summary[field]) {
          issues.push(`batch ${entry.batchId} submitted ${field} is not reproducible`);
        }
      }
      for (const [index, frame] of raw.frames.entries()) {
        const recomputed = frame.coreMs + frame.encodeMs + frame.transportMs + frame.replayMs;
        if (Math.abs(recomputed - frame.totalMs) > 0.000_001) {
          issues.push(`batch ${entry.batchId} frame ${index} total is forged`);
          break;
        }
      }
      if (summary.p95Ms > manifest.policy.maximumP95Ms)
        issues.push(`batch ${entry.batchId} P95 exceeds limit`);
      if (summary.p99Ms > manifest.policy.maximumP99Ms)
        issues.push(`batch ${entry.batchId} P99 exceeds limit`);
      if (summary.droppedFrameRate >= manifest.policy.maximumDroppedFrameRate)
        issues.push(`batch ${entry.batchId} dropped-frame rate exceeds limit`);
      if (summary.coldStartMs >= manifest.policy.maximumColdStartMs)
        issues.push(`batch ${entry.batchId} cold start exceeds limit`);
      if (
        raw.memory.afterBytes - raw.memory.beforeBytes >
        manifest.policy.maximumMemoryGrowthBytes
      ) {
        issues.push(`batch ${entry.batchId} retained memory exceeds limit`);
      }
      validateIme(raw, issues, entry.batchId);
      for (const check of requiredA11yChecks) {
        if (!raw.accessibility.checks.includes(check))
          issues.push(`batch ${entry.batchId} lacks a11y ${check}`);
      }
      for (const event of requiredMediaEvents) {
        if (!raw.media.events.includes(event))
          issues.push(`batch ${entry.batchId} lacks media ${event}`);
      }
      if (raw.media.createdFrames !== raw.media.releasedFrames || raw.media.maximumInFlight > 1) {
        issues.push(`batch ${entry.batchId} media resources are not bounded and reclaimed`);
      }
    }
    if (summaries.length === 2) {
      const [left, right] = summaries;
      const denominator = Math.max(left.p95Ms, right.p95Ms, 0.001);
      if (Math.abs(left.p95Ms - right.p95Ms) / denominator > 0.2) {
        issues.push("two batches are not reproducible within 20% P95");
      }
    }
    roleResults.set(role.roleId, { expired, issues: [...new Set(issues)], role });
  }
  const matrix = M9_REQUIRED_ROLES.map((roleId) => {
    const result = roleResults.get(roleId);
    if (result === undefined)
      return { roleId, status: "unqualified", limitations: ["no valid physical-device evidence"] };
    const status =
      globalIssues.length > 0 || result.issues.length > 0
        ? "unqualified"
        : result.expired
          ? "expired"
          : "qualified";
    return {
      roleId,
      status,
      deviceId: result.role.deviceId,
      browser: `${result.role.environment.browser} ${String(result.role.environment.browserMajor)}`,
      transport: result.role.environment.transport,
      inputPath: result.role.environment.inputPath,
      videoPath: result.role.environment.videoPath,
      limitations: [...result.role.limitations, ...globalIssues, ...result.issues],
    };
  });
  const evidenceIssues = [
    ...globalIssues,
    ...[...roleResults.values()].flatMap((result) => result.issues),
  ];
  return {
    version: 2,
    build: manifest.build,
    status: evidenceIssues.length === 0 ? "pass" : "fail",
    issueCount: evidenceIssues.length,
    issues: evidenceIssues,
    matrix,
  };
}

/** Prevents a valid report for another artifact from authorizing this candidate. */
export function assertQualifiedEvidenceBuild(report, candidate) {
  if (
    report.matrix.some((entry) => entry.status === "qualified") &&
    (report.build.commit !== candidate.commit || report.build.digest !== candidate.digest)
  ) {
    throw new Error("qualified platform evidence is not bound to the candidate commit and WASM");
  }
}

function validateIme(raw, issues, batchId) {
  const modes = raw.environment.capabilities.editContext
    ? ["edit-context", "textarea-proxy"]
    : ["textarea-proxy"];
  for (const mode of modes) {
    for (const language of ["zh", "ja", "ko"]) {
      if (!raw.ime.some((entry) => entry.mode === mode && entry.language === language)) {
        issues.push(`batch ${batchId} lacks IME ${mode}/${language}`);
      }
    }
  }
}

function summarize(raw) {
  const totals = raw.frames.map((frame) => frame.totalMs).sort((left, right) => left - right);
  return {
    p95Ms: percentile(totals, 95),
    p99Ms: percentile(totals, 99),
    droppedFrameRate: raw.frames.filter((frame) => frame.dropped).length / raw.frames.length,
    peakMemoryBytes: Math.max(
      raw.memory.peakBytes,
      ...raw.frames.map((frame) => frame.memoryBytes),
    ),
    coldStartMs: raw.coldStartMs,
  };
}

function percentile(values, value) {
  return values[Math.ceil((values.length * value) / 100) - 1];
}

async function validators() {
  validatorsPromise ??= (async () => {
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    const raw = JSON.parse(
      await readFile(path.join(repositoryRoot, "docs/schemas/m9-raw-evidence.schema.json"), "utf8"),
    );
    const manifest = JSON.parse(
      await readFile(
        path.join(repositoryRoot, "docs/schemas/m9-evidence-manifest.schema.json"),
        "utf8",
      ),
    );
    ajv.addSchema(raw);
    return [ajv.compile(manifest), ajv.getSchema(raw.$id)];
  })();
  return validatorsPromise;
}

function assertSchema(validate, value, label) {
  if (validate(value)) return;
  throw new Error(`${label} schema rejected: ${JSON.stringify(validate.errors)}`);
}

function assertWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error("evidence path escapes archive root");
}

function duplicates(values) {
  const seen = new Set();
  const duplicate = new Set();
  for (const value of values) (seen.has(value) ? duplicate : seen).add(value);
  return [...duplicate];
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

const isMain =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(import.meta.filename);
if (isMain) {
  const report = await auditM9Evidence({
    manifestPath:
      process.argv[2] ?? path.join(repositoryRoot, "docs/evidence/m9-evidence-manifest.v2.json"),
    archiveRoot: process.argv[3] ?? repositoryRoot,
    now: new Date(process.env.PINGO_QUALIFICATION_NOW ?? Date.now()),
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.status !== "pass") process.exitCode = 1;
}
