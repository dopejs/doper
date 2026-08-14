import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { archiveProbeReport, safeArchiveSegment } from "./collect-probes.mjs";

const temporaryDirectories = [];

afterEach(async () => {
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
    const directory = await mkdtemp(path.join(tmpdir(), "doper-probe-collector-"));
    temporaryDirectories.push(directory);
    const report = {
      build: { id: "abc123", mode: "production" },
      deviceId: "dev-mac-01",
      runId: "00000000-0000-4000-8000-000000000001",
      version: 1,
    };

    const archived = await archiveProbeReport(report, directory);
    expect(archived).toBe("v1/dev-mac-01/abc123/00000000-0000-4000-8000-000000000001.json");
    expect(JSON.parse(await readFile(path.join(directory, archived), "utf8"))).toEqual(report);
    await expect(archiveProbeReport(report, directory)).rejects.toThrow(/already archived/u);
  });
});
