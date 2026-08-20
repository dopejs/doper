import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  archiveImeRecording,
  archiveProbeReport,
  createProbeCollector,
  safeArchiveSegment,
} from "./collect-probes.mjs";
import { verifyEvidenceDigest } from "./evidence-integrity.mjs";

const temporaryDirectories = [];
const servers = [];
const imeFixture = JSON.parse(
  await readFile(new URL("../benchmarks/ime/recording.fixture.v2.json", import.meta.url), "utf8"),
);

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
  }
  for (const directory of temporaryDirectories.splice(0)) {
    const resolved = await realpath(directory);
    const temporaryRoot = await realpath(tmpdir());
    if (!resolved.startsWith(`${temporaryRoot}${path.sep}`)) {
      throw new Error(`refusing to remove unexpected test directory: ${resolved}`);
    }
    await rm(resolved, { recursive: true });
  }
});

describe("probe collector archive", () => {
  it("accepts bounded identifiers and rejects traversal", () => {
    expect(safeArchiveSegment("android-low-01", "deviceId")).toBe("android-low-01");
    expect(() => safeArchiveSegment("../escape", "deviceId")).toThrow(/safe archive/u);
    expect(() => safeArchiveSegment("contains/slash", "deviceId")).toThrow(/safe archive/u);
  });

  it("writes each run once without overwriting prior evidence", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "pingo-probe-collector-"));
    temporaryDirectories.push(directory);
    const report = {
      build: { id: "abc123", mode: "production" },
      deviceId: "dev-mac-01",
      runId: "00000000-0000-4000-8000-000000000001",
      version: 1,
    };

    const archived = await archiveProbeReport(report, directory);
    expect(archived).toBe("v1/dev-mac-01/abc123/00000000-0000-4000-8000-000000000001.json");
    const filename = path.join(directory, archived);
    expect(JSON.parse(await readFile(filename, "utf8"))).toEqual(report);
    await expect(verifyEvidenceDigest(filename)).resolves.toMatchObject({
      bytes: expect.any(Number),
    });
    await expect(readFile(`${filename}.sha256`, "utf8")).resolves.toMatch(
      /^[a-f0-9]{64} {2}00000000-0000-4000-8000-000000000001\.json\n$/u,
    );
    await expect(archiveProbeReport(report, directory)).rejects.toThrow(/already archived/u);
  });

  it("archives IME recordings in a separate versioned namespace", async () => {
    const directory = await temporaryDirectory();
    const recording = formalImeRecording();

    const archived = await archiveImeRecording(recording, directory);
    expect(archived).toBe(`ime/v2/dev-mac-01/abc123/${recording.recordingId}.json`);
    const filename = path.join(directory, archived);
    expect(JSON.parse(await readFile(filename, "utf8"))).toEqual(recording);
    await expect(verifyEvidenceDigest(filename)).resolves.toMatchObject({
      digest: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    await expect(archiveImeRecording(recording, directory)).rejects.toThrow(/already archived/u);
  });

  it("detects archived evidence changed after collection", async () => {
    const directory = await temporaryDirectory();
    const report = {
      build: { id: "abc123", mode: "production" },
      deviceId: "dev-mac-01",
      runId: "00000000-0000-4000-8000-000000000003",
      version: 1,
    };
    const archived = await archiveProbeReport(report, directory);
    const filename = path.join(directory, archived);
    await chmod(filename, 0o600);
    await writeFile(filename, "{}\n", "utf8");

    await expect(verifyEvidenceDigest(filename)).rejects.toThrow(/SHA-256 does not match/u);
  });

  it("fails closed when a prior archive commit is incomplete", async () => {
    const directory = await temporaryDirectory();
    const report = {
      build: { id: "abc123", mode: "production" },
      deviceId: "dev-mac-01",
      runId: "00000000-0000-4000-8000-000000000004",
      version: 1,
    };
    const destination = path.join(directory, "v1", "dev-mac-01", "abc123");
    await mkdir(destination, { recursive: true });
    await writeFile(path.join(destination, `${report.runId}.json`), "{}\n", "utf8");

    await expect(archiveProbeReport(report, directory)).rejects.toThrow(
      /incomplete or corrupt evidence conflict/u,
    );
  });

  it("authenticates, validates, and archives IME uploads without polluting probe summaries", async () => {
    const directory = await temporaryDirectory();
    const distribution = path.join(directory, "dist");
    const archive = path.join(directory, "archive");
    await mkdir(distribution);
    await writeFile(path.join(distribution, "index.html"), "<!doctype html><title>probe</title>");
    const token = "collector-test-token-123456789";
    const server = await createProbeCollector({
      allowLocal: false,
      dist: distribution,
      output: archive,
      token,
    });
    servers.push(server);
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("missing server address");
    const baseUrl = `http://127.0.0.1:${String(address.port)}`;
    const recording = formalImeRecording();

    const unauthorized = await fetch(`${baseUrl}/api/ime-recordings`, {
      body: JSON.stringify(recording),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    expect(unauthorized.status).toBe(401);

    const uploaded = await fetch(`${baseUrl}/api/ime-recordings`, {
      body: JSON.stringify(recording),
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      method: "POST",
    });
    expect(uploaded.status).toBe(201);
    await expect(uploaded.json()).resolves.toMatchObject({
      archivedPath: `ime/v2/dev-mac-01/abc123/${recording.recordingId}.json`,
      recordingId: recording.recordingId,
    });

    const duplicate = await fetch(`${baseUrl}/api/ime-recordings`, {
      body: JSON.stringify(recording),
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      method: "POST",
    });
    expect(duplicate.status).toBe(409);

    const invalid = structuredClone(recording);
    invalid.recordingId = "20000000-0000-4000-8000-000000000002";
    invalid.events[1].data.insertedText = "corrupt";
    const rejected = await fetch(`${baseUrl}/api/ime-recordings`, {
      body: JSON.stringify(invalid),
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      method: "POST",
    });
    expect(rejected.status).toBe(400);

    const summary = await fetch(`${baseUrl}/api/summary`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(summary.status).toBe(200);
    await expect(summary.json()).resolves.toMatchObject({ reportCount: 0 });
  });
});

async function temporaryDirectory() {
  const directory = await mkdtemp(path.join(tmpdir(), "pingo-probe-collector-"));
  temporaryDirectories.push(directory);
  return directory;
}

function formalImeRecording() {
  const recording = structuredClone(imeFixture);
  recording.provenance = "recorded";
  recording.environment.buildId = "abc123";
  recording.environment.deviceId = "dev-mac-01";
  recording.environment.inputMethod = "Test IME 1.0";
  return recording;
}
