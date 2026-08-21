const runNames = ["simple", "complex", "inline"];
const numericFields = [
  "complexity",
  "initialDisplayBytes",
  "initialLogicalCommands",
  "fixtureDrawCommands",
  "maximumResourceBytes",
  "maximumResidentBytes",
  "maximumLayoutVisitedNodes",
  "maximumUnchangedSubtreeRebuilds",
  "shellMutationFrames",
  "p95Ms",
  "p99Ms",
  "droppedFrameRate",
];

/** Fails closed for malformed, forged, or semantically inconsistent reports. */
export function validateM9PictureReport(report, fixture) {
  if (!isRecord(report) || report.version !== 1) throw new Error("invalid report version");
  if (!isRecord(fixture) || fixture.version !== 1) throw new Error("invalid fixture version");
  for (const field of ["seed", "dpr", "frames"]) {
    if (report[field] !== fixture[field]) throw new Error(`report ${field} differs from fixture`);
  }
  if (
    !Array.isArray(report.viewport) ||
    report.viewport.length !== 2 ||
    report.viewport.some((value, index) => value !== fixture.viewport?.[index])
  ) {
    throw new Error("report viewport differs from fixture");
  }
  for (const name of runNames) {
    const run = report[name];
    if (!isRecord(run)) throw new Error(`report ${name} run is missing`);
    for (const field of numericFields) {
      if (!Number.isFinite(run[field]) || run[field] < 0) {
        throw new Error(`report ${name}.${field} must be finite and non-negative`);
      }
    }
    if (typeof run.checksum !== "string" || !/^[1-9][0-9]*$/u.test(run.checksum)) {
      throw new Error(`report ${name}.checksum must be a non-zero u64 decimal string`);
    }
    if (run.p99Ms < run.p95Ms) throw new Error(`report ${name} percentiles are not monotonic`);
    if (run.droppedFrameRate > 1) throw new Error(`report ${name} dropped-frame rate exceeds one`);
    if (run.maximumLayoutVisitedNodes !== 0) {
      throw new Error(`report ${name} performed layout during pure scroll`);
    }
    if (run.maximumUnchangedSubtreeRebuilds !== 0) {
      throw new Error(`report ${name} rebuilt an unchanged scroll subtree`);
    }
    if (run.shellMutationFrames !== 0) {
      throw new Error(`report ${name} used Shell mutations during Core-owned scroll`);
    }
    if (run.p95Ms > fixture.maximumP95Ms || run.p99Ms > fixture.maximumP99Ms) {
      throw new Error(`report ${name} exceeds the absolute frame-time limit`);
    }
    if (run.droppedFrameRate >= fixture.maximumDroppedFrameRate) {
      throw new Error(`report ${name} exceeds the dropped-frame limit`);
    }
    if (run.maximumResidentBytes > fixture.maximumPictureResidentBytes) {
      throw new Error(`report ${name} exceeds the Picture resident budget`);
    }
  }
  if (!report.simple.incremental || !report.complex.incremental || report.inline.incremental) {
    throw new Error("report paths do not match the fixture");
  }
  if (
    report.simple.complexity !== fixture.simpleComplexity ||
    report.complex.complexity !== fixture.complexComplexity ||
    report.inline.complexity !== fixture.complexComplexity
  ) {
    throw new Error("report complexity does not match the fixture");
  }
  if (report.complex.fixtureDrawCommands !== report.simple.fixtureDrawCommands * 4) {
    throw new Error("complex fixture does not contain four times the draw commands");
  }
  if (report.complex.maximumResourceBytes !== report.simple.maximumResourceBytes) {
    throw new Error("steady Picture payload scales with immutable subtree complexity");
  }
  if (report.complex.initialDisplayBytes !== report.simple.initialDisplayBytes) {
    throw new Error("root composition payload scales with immutable subtree complexity");
  }
  if (report.inline.maximumResourceBytes !== 0 || report.inline.maximumResidentBytes !== 0) {
    throw new Error("inline reference path retained Picture resources");
  }
  return report;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
