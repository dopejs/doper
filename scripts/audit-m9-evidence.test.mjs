import { createHash } from "node:crypto";
import { mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  assertQualifiedEvidenceBuild,
  auditM9Evidence,
  evaluateM9Evidence,
} from "./audit-m9-evidence.mjs";

const build = {
  commit: "a".repeat(40),
  digest: "b".repeat(64),
  abiVersion: 17,
  workerProtocolVersion: 12,
};
const environment = {
  os: "Fixture OS",
  osVersion: "1.0",
  browser: "Chromium",
  browserMajor: 151,
  inputMethod: "Fixture IME",
  transport: "sab",
  inputPath: "edit-context",
  videoPath: "video-frame",
  capabilities: { editContext: true, sharedArrayBuffer: true },
};

describe("M9 evidence v2", () => {
  it("recomputes raw batches and emits a fail-closed support matrix", async () => {
    const archive = await fixtureArchive();
    const report = await auditM9Evidence({
      archiveRoot: archive.root,
      manifestPath: archive.manifestPath,
      now: new Date("2026-08-21T00:00:00.000Z"),
      allowFixture: true,
    });
    expect(report.status).toBe("pass");
    expect(report.matrix.find((entry) => entry.roleId === "desktop-chromium")?.status).toBe(
      "qualified",
    );
    expect(report.matrix.find((entry) => entry.roleId === "android-low")?.status).toBe(
      "unqualified",
    );
  });

  it("rejects digest tampering before parsing derived claims", async () => {
    const archive = await fixtureArchive();
    await writeFile(path.join(archive.root, "raw-a.json"), "{}\n", "utf8");
    await expect(
      auditM9Evidence({
        archiveRoot: archive.root,
        manifestPath: archive.manifestPath,
        now: new Date("2026-08-21T00:00:00.000Z"),
        allowFixture: true,
      }),
    ).rejects.toThrow(/digest mismatch/u);
  });

  it("rejects evidence reached through a symlinked archive directory", async () => {
    const archive = await fixtureArchive();
    const outside = await mkdtemp(path.join(tmpdir(), "pingo-m9-evidence-outside-"));
    const manifest = JSON.parse(await readFile(archive.manifestPath, "utf8"));
    await writeFile(
      path.join(outside, "raw-a.json"),
      await readFile(path.join(archive.root, "raw-a.json")),
    );
    await symlink(outside, path.join(archive.root, "linked"), "dir");
    manifest.roles[0].batches[0].path = "linked/raw-a.json";
    await writeFile(archive.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await expect(
      auditM9Evidence({
        archiveRoot: archive.root,
        manifestPath: archive.manifestPath,
        now: new Date("2026-08-21T00:00:00.000Z"),
        allowFixture: true,
      }),
    ).rejects.toThrow(/escapes archive root|must not traverse a symlink/u);
  });

  it("rejects forged summaries, mixed environments, reused batches, and build drift", () => {
    for (const corrupt of [
      (manifest) => (manifest.roles[0].batches[0].summary.p99Ms = 0),
      (_manifest, batches) =>
        (batches.get(
          "desktop-chromium:10000000-0000-4000-8000-000000000002",
        ).environment.browserMajor = 152),
      (manifest) => (manifest.roles[0].batches[1].batchId = manifest.roles[0].batches[0].batchId),
      (_manifest, batches) =>
        (batches.get("desktop-chromium:10000000-0000-4000-8000-000000000002").build.digest =
          "c".repeat(64)),
    ]) {
      const { manifest, batches } = memoryFixture();
      corrupt(manifest, batches);
      const report = evaluateM9Evidence({
        allowFixture: true,
        batches,
        manifest,
        now: new Date("2026-08-21T00:00:00.000Z"),
      });
      expect(report.status).toBe("fail");
      expect(report.matrix.find((entry) => entry.roleId === "desktop-chromium")?.status).toBe(
        "unqualified",
      );
    }
  });

  it("expires otherwise valid evidence with an injectable clock", () => {
    const { manifest, batches } = memoryFixture();
    const report = evaluateM9Evidence({
      allowFixture: true,
      batches,
      manifest,
      now: new Date("2026-09-25T00:00:00.000Z"),
    });
    expect(report.status).toBe("pass");
    expect(report.matrix.find((entry) => entry.roleId === "desktop-chromium")?.status).toBe(
      "expired",
    );
  });

  it("binds qualified evidence to the candidate commit and WASM digest", () => {
    const { manifest, batches } = memoryFixture();
    const report = evaluateM9Evidence({
      allowFixture: true,
      batches,
      manifest,
      now: new Date("2026-08-21T00:00:00.000Z"),
    });
    expect(() =>
      assertQualifiedEvidenceBuild(report, { commit: build.commit, digest: build.digest }),
    ).not.toThrow();
    expect(() =>
      assertQualifiedEvidenceBuild(report, { commit: "c".repeat(40), digest: build.digest }),
    ).toThrow(/not bound/u);
  });

  it("does not let fixture evidence qualify a formal support claim", () => {
    const { manifest, batches } = memoryFixture();
    const report = evaluateM9Evidence({
      batches,
      manifest,
      now: new Date("2026-08-21T00:00:00.000Z"),
    });
    expect(report.status).toBe("fail");
    expect(report.issues).toContain("fixture evidence is not formal");
  });

  it("rejects unknown roles and an invalid qualification clock", () => {
    const { manifest, batches } = memoryFixture();
    manifest.roles[0].roleId = "desktop-unknown";
    const report = evaluateM9Evidence({
      allowFixture: true,
      batches,
      manifest,
      now: new Date("2026-08-21T00:00:00.000Z"),
    });
    expect(report.status).toBe("fail");
    expect(report.issues).toContain("unknown role desktop-unknown");

    expect(() =>
      evaluateM9Evidence({
        allowFixture: true,
        batches,
        manifest,
        now: new Date(Number.NaN),
      }),
    ).toThrow(/clock is invalid/u);
  });
});

async function fixtureArchive() {
  const root = await mkdtemp(path.join(tmpdir(), "pingo-m9-evidence-"));
  const { manifest, batches } = memoryFixture();
  for (const entry of manifest.roles[0].batches) {
    const raw = batches.get(`desktop-chromium:${entry.batchId}`);
    const bytes = `${JSON.stringify(raw, null, 2)}\n`;
    entry.sha256 = createHash("sha256").update(bytes).digest("hex");
    await writeFile(path.join(root, entry.path), bytes, "utf8");
  }
  const manifestPath = path.join(root, "manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { manifestPath, root };
}

function memoryFixture() {
  const firstId = "10000000-0000-4000-8000-000000000001";
  const secondId = "10000000-0000-4000-8000-000000000002";
  const first = raw(firstId, "2026-08-20T00:00:00.000Z");
  const second = raw(secondId, "2026-08-20T01:00:00.000Z");
  const summary = {
    p95Ms: 1,
    p99Ms: 1,
    droppedFrameRate: 0,
    peakMemoryBytes: 200,
    coldStartMs: 10,
  };
  const manifest = {
    $schema: "https://dopejs.dev/schemas/m9-evidence-manifest-v2.json",
    version: 2,
    fixture: true,
    build: structuredClone(build),
    policy: {
      maximumAgeDays: 30,
      minimumFramesPerBatch: 20,
      maximumP95Ms: 16.7,
      maximumP99Ms: 25,
      maximumDroppedFrameRate: 0.005,
      maximumColdStartMs: 50,
      maximumMemoryGrowthBytes: 16_777_216,
    },
    roles: [
      {
        roleId: "desktop-chromium",
        deviceId: "fixture-device",
        environment: structuredClone(environment),
        limitations: ["fixture only"],
        batches: [
          {
            batchId: firstId,
            path: "raw-a.json",
            sha256: "0".repeat(64),
            summary: structuredClone(summary),
          },
          {
            batchId: secondId,
            path: "raw-b.json",
            sha256: "0".repeat(64),
            summary: structuredClone(summary),
          },
        ],
      },
    ],
  };
  return {
    manifest,
    batches: new Map([
      [`desktop-chromium:${firstId}`, first],
      [`desktop-chromium:${secondId}`, second],
    ]),
  };
}

function raw(batchId, collectedAt) {
  const ime = [];
  for (const mode of ["edit-context", "textarea-proxy"]) {
    for (const language of ["zh", "ja", "ko"]) {
      ime.push({ language, mode, compositionCommitted: true, replayDigest: "d".repeat(64) });
    }
  }
  return {
    $schema: "https://dopejs.dev/schemas/m9-raw-evidence-v2.json",
    version: 2,
    batchId,
    collectedAt,
    roleId: "desktop-chromium",
    deviceId: "fixture-device",
    build: structuredClone(build),
    environment: structuredClone(environment),
    frames: Array.from({ length: 20 }, () => ({
      coreMs: 0.25,
      encodeMs: 0.25,
      transportMs: 0.25,
      replayMs: 0.25,
      totalMs: 1,
      memoryBytes: 150,
      dropped: false,
    })),
    coldStartMs: 10,
    memory: { beforeBytes: 100, peakBytes: 200, afterBytes: 100 },
    ime,
    accessibility: {
      screenReader: "Fixture Reader",
      checks: ["focus", "role", "value"],
      digest: "e".repeat(64),
    },
    media: {
      events: ["background", "seek", "loop", "error", "recover"],
      createdFrames: 10,
      releasedFrames: 10,
      maximumInFlight: 1,
      digest: "f".repeat(64),
    },
  };
}
