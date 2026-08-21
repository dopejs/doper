import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import { replayImeRecording } from "./replay-ime.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schemaDirectory = path.join(repositoryRoot, "docs/schemas");
const schemaFiles = [
  "benchmark-run.schema.json",
  "benchmark-suite.schema.json",
  "ime-recording.schema.json",
  "ime-sequence.schema.json",
  "m0-business-audit.schema.json",
  "m0-decision.schema.json",
  "m0-evidence-manifest.schema.json",
  "m0-storage-verification.schema.json",
  "m9-raw-evidence.schema.json",
  "m9-evidence-manifest.schema.json",
  "platform-probe-report.schema.json",
];

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);

const schemas = new Map();
for (const filename of schemaFiles) {
  const schema = await readJson(path.join(schemaDirectory, filename));
  schemas.set(filename, schema);
  ajv.addSchema(schema);
}

for (const [filename, schema] of schemas) {
  ajv.compile(schema);
  process.stdout.write(`schema compiled: ${filename}\n`);
}

const suite = await readJson(path.join(repositoryRoot, "benchmarks/suite.v1.json"));
validate(
  ajv.getSchema("https://dopejs.dev/schemas/benchmark-suite-v1.json"),
  suite,
  "suite.v1.json",
);

const requiredScenarios = new Set([
  "static-table",
  "continuous-scroll",
  "dynamic-height-list",
  "image-list",
  "high-frequency-updates",
  "cell-editing-ime",
]);
const scenarioIds = new Set(suite.scenarios.map((scenario) => scenario.id));
if (scenarioIds.size !== suite.scenarios.length) {
  throw new Error("Benchmark scenario IDs must be unique");
}
for (const required of requiredScenarios) {
  if (!scenarioIds.has(required)) {
    throw new Error(`Missing required benchmark scenario: ${required}`);
  }
}

const sequencePath = path.join(repositoryRoot, "benchmarks/ime/synthetic-composition.v1.json");
const sequence = await readJson(sequencePath);
validate(
  ajv.getSchema("https://dopejs.dev/schemas/ime-sequence-v1.json"),
  sequence,
  "synthetic-composition.v1.json",
);
for (let index = 1; index < sequence.events.length; index += 1) {
  if (sequence.events[index].atMs < sequence.events[index - 1].atMs) {
    throw new Error("IME sequence event timestamps must be monotonic");
  }
}

const recordingPath = path.join(repositoryRoot, "benchmarks/ime/recording.fixture.v2.json");
const recording = await readJson(recordingPath);
validate(
  ajv.getSchema("https://dopejs.dev/schemas/ime-recording-v2.json"),
  recording,
  "recording.fixture.v2.json",
);
await replayImeRecording(recording, { allowFixture: true, allowLocal: true });

const platformReportPath = path.join(
  repositoryRoot,
  "benchmarks/platform-probe/report.fixture.v1.json",
);
const platformReport = await readJson(platformReportPath);
validate(
  ajv.getSchema("https://dopejs.dev/schemas/platform-probe-report-v1.json"),
  platformReport,
  "report.fixture.v1.json",
);
if (platformReport.editing !== undefined) {
  for (let index = 0; index < platformReport.editing.records.length; index += 1) {
    const record = platformReport.editing.records[index];
    if (index > 0 && record.atMs < platformReport.editing.records[index - 1].atMs) {
      throw new Error("Editing event timestamps must be monotonic");
    }
    if (record.selectionStart > record.selectionEnd || record.selectionEnd > record.text.length) {
      throw new Error(`Editing event ${String(index)} has an invalid UTF-16 selection`);
    }
  }
}

const m0ManifestPath = path.join(repositoryRoot, "benchmarks/m0/evidence-manifest.fixture.v1.json");
const m0Manifest = await readJson(m0ManifestPath);
validate(
  ajv.getSchema("https://dopejs.dev/schemas/m0-evidence-manifest-v1.json"),
  m0Manifest,
  "evidence-manifest.fixture.v1.json",
);

validate(
  ajv.getSchema("https://dopejs.dev/schemas/m9-evidence-manifest-v2.json"),
  await readJson(path.join(repositoryRoot, "docs/evidence/m9-evidence-manifest.v2.json")),
  "m9-evidence-manifest.v2.json",
);

for (const [filename, schemaId] of [
  ["business-audit.fixture.v1.json", "https://dopejs.dev/schemas/m0-business-audit-v1.json"],
  ["decision.fixture.v1.json", "https://dopejs.dev/schemas/m0-decision-v1.json"],
  [
    "storage-verification.fixture.v1.json",
    "https://dopejs.dev/schemas/m0-storage-verification-v1.json",
  ],
]) {
  validate(
    ajv.getSchema(schemaId),
    await readJson(path.join(repositoryRoot, "benchmarks/m0", filename)),
    filename,
  );
}

process.stdout.write("contract fixtures valid\n");

async function readJson(filename) {
  return JSON.parse(await readFile(filename, "utf8"));
}

function validate(validator, value, label) {
  if (validator === undefined) {
    throw new Error(`Missing validator for ${label}`);
  }
  if (!validator(value)) {
    throw new Error(`${label} failed validation: ${ajv.errorsText(validator.errors)}`);
  }
}
