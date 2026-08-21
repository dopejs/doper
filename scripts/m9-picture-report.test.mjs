import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { validateM9PictureReport } from "./m9-picture-report.mjs";

const fixture = JSON.parse(
  await readFile(new URL("../benchmarks/m9/rich-scroll.fixture.v1.json", import.meta.url), "utf8"),
);

function validReport() {
  const run = (incremental, complexity, drawCommands) => ({
    incremental,
    complexity,
    initialDisplayBytes: incremental ? 32 : 10_000,
    initialLogicalCommands: 100 * complexity,
    fixtureDrawCommands: drawCommands,
    maximumResourceBytes: incremental ? 184 : 0,
    maximumResidentBytes: incremental ? 10_000 : 0,
    maximumLayoutVisitedNodes: 0,
    maximumUnchangedSubtreeRebuilds: 0,
    shellMutationFrames: 0,
    p95Ms: 1,
    p99Ms: 2,
    droppedFrameRate: 0,
    checksum: "1",
  });
  return {
    version: 1,
    seed: fixture.seed,
    viewport: fixture.viewport,
    dpr: fixture.dpr,
    frames: fixture.frames,
    simple: run(true, 1, 24),
    complex: run(true, 4, 96),
    inline: run(false, 4, 96),
  };
}

describe("M9 Picture report validation", () => {
  it("accepts a self-consistent report", () => {
    expect(validateM9PictureReport(validReport(), fixture)).toEqual(validReport());
  });

  it.each([
    ["non-finite timing", (report) => (report.complex.p99Ms = Number.NaN)],
    ["forged fixture seed", (report) => (report.seed += 1)],
    ["layout work", (report) => (report.complex.maximumLayoutVisitedNodes = 1)],
    ["subtree rebuild", (report) => (report.complex.maximumUnchangedSubtreeRebuilds = 1)],
    ["complexity-dependent payload", (report) => (report.complex.maximumResourceBytes += 4)],
    ["forged complexity", (report) => (report.complex.fixtureDrawCommands -= 1)],
    ["inline residency", (report) => (report.inline.maximumResidentBytes = 1)],
    ["lossy u64 checksum", (report) => (report.complex.checksum = Number.MAX_SAFE_INTEGER + 1)],
  ])("rejects %s", (_label, corrupt) => {
    const report = validReport();
    corrupt(report);
    expect(() => validateM9PictureReport(report, fixture)).toThrow();
  });
});
