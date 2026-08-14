import { readFile } from "node:fs/promises";

import { beforeAll, describe, expect, it } from "vitest";

import { evaluateM0Evidence } from "./audit-m0-evidence.mjs";

let fixtureManifest;

beforeAll(async () => {
  fixtureManifest = JSON.parse(
    await readFile(new URL("../benchmarks/m0/evidence-manifest.fixture.v1.json", import.meta.url)),
  );
});

describe("P0/M0 evidence gate", () => {
  it("passes only with registered roles, two 5+15 batches, and complete IME coverage", () => {
    const manifest = structuredClone(fixtureManifest);
    const result = evaluateM0Evidence({
      artifactResults: passingArtifacts(),
      imeEvidence: imeEvidence(manifest),
      manifest,
      reports: platformReports(manifest),
    });

    expect(result.status).toBe("pass");
    expect(result.issueCount).toBe(0);
    expect(result.checks).toHaveLength(18);
  });

  it("reports missing warmups, cross-role duplication, IME gaps, and artifact tampering", () => {
    const manifest = structuredClone(fixtureManifest);
    manifest.devices[1].roleId = manifest.devices[0].roleId;
    const reports = platformReports(fixtureManifest).filter(
      (report) =>
        !(
          report.roleId === "android-low" &&
          report.collection.batchId === fixtureManifest.devices[0].batchIds[0] &&
          report.collection.kind === "warmup" &&
          report.collection.sequence === 5
        ),
    );
    const evidence = imeEvidence(fixtureManifest).filter(
      ({ recording }) =>
        !(
          recording.environment.roleId === "android-low" &&
          recording.environment.mode === "textarea-proxy" &&
          recording.environment.language === "ja"
        ),
    );
    const artifacts = passingArtifacts();
    artifacts[0] = { ...artifacts[0], issue: "artifact SHA-256 does not match", pass: false };

    const result = evaluateM0Evidence({
      artifactResults: artifacts,
      imeEvidence: evidence,
      manifest,
      reports,
    });

    expect(result.status).toBe("fail");
    expect(result.issues.join("\n")).toMatch(/device role IDs must be unique/u);
    expect(result.issues.join("\n")).toMatch(/5 ordered warmup reports/u);
    expect(result.issues.join("\n")).toMatch(/textarea-proxy\/ja recording is missing/u);
    expect(result.issues.join("\n")).toMatch(/SHA-256/u);
  });
});

function passingArtifacts() {
  return ["business-audit-artifact", "storage-artifact", "decision-adr-artifact"].map((id) => ({
    actualSha256: "a".repeat(64),
    bytes: 100,
    id,
    issue: null,
    pass: true,
    path: `evidence/${id}.md`,
  }));
}

function platformReports(manifest) {
  const reports = [];
  let run = 1;
  for (const device of manifest.devices) {
    for (const batchId of device.batchIds) {
      for (const [kind, count] of [
        ["warmup", 5],
        ["sample", 15],
      ]) {
        for (let sequence = 1; sequence <= count; sequence += 1) {
          reports.push(
            platformReport(manifest.buildId, device, batchId, kind, sequence, count, run),
          );
          run += 1;
        }
      }
    }
  }
  return reports;
}

function platformReport(buildId, device, batchId, kind, sequence, total, run) {
  const capabilities = device.capabilities;
  const recommendedMode =
    capabilities.crossOriginIsolated &&
    capabilities.sharedArrayBuffer &&
    capabilities.workerOffscreenCanvas
      ? "sab"
      : capabilities.workerOffscreenCanvas
        ? "post-message"
        : "main-thread";
  const outcome = {
    result: {
      continuousDuringStall: recommendedMode !== "main-thread",
      maxFrameGapMs: recommendedMode === "main-thread" ? 210 : 20,
    },
    status: "ok",
  };
  const timing = {
    durationMs: 1000,
    samples: [16, 17],
    summary: { count: 2, max: 17, mean: 16.5, min: 16, p50: 16.5, p95: 16.95, p99: 16.99 },
  };
  return {
    build: { id: buildId, mode: "production" },
    canvas: {
      mainThread: { operationsPerSecond: 1000 },
      ...(capabilities.workerOffscreenCanvas ? { worker: { operationsPerSecond: 1000 } } : {}),
    },
    collection: { batchId, kind, sequence, total },
    deviceId: device.deviceId,
    environment: {
      crossOriginIsolated: capabilities.crossOriginIsolated,
      deviceMemoryGiB: device.memoryGiB,
      devicePixelRatio: device.devicePixelRatio,
      editContext: capabilities.editContext,
      hardwareConcurrency: 4,
      offscreenCanvas: capabilities.workerOffscreenCanvas,
      sharedArrayBuffer: capabilities.sharedArrayBuffer,
      userAgent: `${device.roleId} fixture browser`,
      viewport: device.viewport,
      worker: {
        offscreenCanvas: capabilities.workerOffscreenCanvas,
        requestAnimationFrame: capabilities.workerRaf,
        sharedArrayBuffer: capabilities.sharedArrayBuffer,
      },
    },
    errors: {},
    finishedAt: `2026-08-14T00:00:${String(run).padStart(2, "0")}.000Z`,
    messageBackpressure: { backpressureHandled: true },
    messageCopyCost: {
      cases: [
        {
          effectiveMiBPerSecond: 100,
          payloadBytes: 1_048_576,
          summary: { p95: 10 },
          verified: true,
        },
      ],
    },
    roleId: device.roleId,
    runId: `run-${String(run)}`,
    ...(capabilities.sharedArrayBuffer
      ? { sabBackpressure: { backpressureHandled: true }, sabLatency: timing }
      : {}),
    selfDrive: timing,
    transport: {
      modes: {
        "main-thread":
          recommendedMode === "main-thread"
            ? outcome
            : { reason: "not selected", status: "unsupported" },
        "post-message":
          recommendedMode === "post-message"
            ? outcome
            : { reason: "not selected", status: "unsupported" },
        "sab":
          recommendedMode === "sab" ? outcome : { reason: "not selected", status: "unsupported" },
      },
      recommendedMode,
    },
    wasmBudget: {
      compileAndInstantiateMs: 1,
      fetchMs: 1,
      firstCallMs: 1,
      gzipBytes: 200_000,
      maximumGzipBytes: 307_200,
      productBudgetBytes: 409_600,
    },
    ...(capabilities.workerRaf ? { workerRaf: timing } : {}),
  };
}

function imeEvidence(manifest) {
  return manifest.devices.flatMap((device) => {
    const modes = device.capabilities.editContext
      ? ["edit-context", "textarea-proxy"]
      : ["textarea-proxy"];
    return modes.flatMap((mode) =>
      ["complex", "ja", "ko", "unicode", "zh"].map((language) => ({
        recording: {
          environment: {
            buildId: manifest.buildId,
            deviceId: device.deviceId,
            language,
            mode,
            roleId: device.roleId,
          },
        },
        replay: {
          characterBoundsObserved: mode === "edit-context",
          compositionCount: language === "unicode" ? 0 : 1,
          softKeyboardObserved: [
            "android-low",
            "android-mid",
            "ios-baseline",
            "ios-current",
          ].includes(device.roleId),
        },
      })),
    );
  });
}
