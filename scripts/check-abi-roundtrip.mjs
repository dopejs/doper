import { execFileSync, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createServer } from "vite";

const root = path.resolve(import.meta.dirname, "..");
const moduleRunner = await createServer({
  appType: "custom",
  logLevel: "error",
  root,
  server: { middlewareMode: true },
  ssr: { noExternal: [/^@dopejs\//u] },
});

try {
  await checkAbiRoundtrip();
} finally {
  await moduleRunner.close();
}

async function checkAbiRoundtrip() {
  for (const packageName of [
    "@dopejs/pingo-reconciler",
    "@dopejs/pingo-editing",
    "@dopejs/pingo-backend-canvas2d",
    "@dopejs/pingo-host",
  ]) {
    execFileSync("pnpm", ["--filter", packageName, "build"], {
      cwd: root,
      stdio: "inherit",
    });
  }

  const reconciler = await moduleRunner.ssrLoadModule("/packages/reconciler/dist/index.js");
  const editing = await moduleRunner.ssrLoadModule("/packages/editing/dist/index.js");
  const backend = await moduleRunner.ssrLoadModule("/packages/backend-canvas2d/dist/index.js");
  const host = await moduleRunner.ssrLoadModule("/packages/host/dist/index.js");
  const mutationGolden = await readGolden("mutation-stream.v1.json");
  const inputGolden = await readGolden("input-stream.v1.json");
  const displayGolden = await readGolden("display-list.v1.json");
  const glyphGolden = await readGolden("glyph-resources.v1.json");
  const textMetricsGolden = await readGolden("system-text-metrics.v1.json");
  const recordingGolden = await readGolden("replay-recording.v1.json");
  const resourceGolden = JSON.parse(
    await readFile(path.join(root, "benchmarks/abi/resources.v1.json"), "utf8"),
  );

  const mutationBytes = reconciler.encodeMutationBatch({
    frameSeq: 42,
    mutations: [
      {
        type: "createNode",
        nodeId: 7,
        kind: reconciler.NodeKind.Text,
        parent: reconciler.NULL_NODE_ID,
        beforeSibling: reconciler.NULL_NODE_ID,
      },
      { type: "setF32", nodeId: 7, prop: reconciler.Prop.Width, value: 320.5 },
      {
        type: "defineResource",
        resourceId: 9,
        kind: reconciler.ResourceKind.Utf8String,
        bytes: new TextEncoder().encode("hello"),
      },
      { type: "setTextRun", nodeId: 7, stringId: 9, styleId: 10 },
    ],
  });
  const mutationHex = encodeHex(mutationBytes);
  assertEqual(mutationHex, mutationGolden, "TypeScript mutation encoder vs golden");
  assertEqual(
    roundTripInRust("mutation", mutationHex),
    mutationHex,
    "TypeScript to Rust mutation round trip",
  );

  const inputBytes = editing.encodeInputBatch({
    frameSeq: 77,
    commands: [
      {
        type: "setSelection",
        nodeId: 0x0010_0007,
        baseRevision: 0x0123_4567_89ab_cdefn,
        selection: {
          anchor: { offset: 8, affinity: editing.InputAffinity.Upstream },
          focus: { offset: 3, affinity: editing.InputAffinity.Downstream },
        },
      },
      {
        type: "beginComposition",
        nodeId: 0x0010_0007,
        baseRevision: 0x0123_4567_89ab_cdf0n,
      },
      {
        type: "updateComposition",
        nodeId: 0x0010_0007,
        baseRevision: 0x0123_4567_89ab_cdf1n,
        text: "你",
      },
      {
        type: "commitComposition",
        nodeId: 0x0010_0007,
        baseRevision: 0x0123_4567_89ab_cdf2n,
        text: "你好",
      },
    ],
  });
  const inputHex = encodeHex(inputBytes);
  assertEqual(inputHex, inputGolden, "TypeScript input encoder vs golden");
  assertEqual(roundTripInRust("input", inputHex), inputHex, "TypeScript to Rust input round trip");

  const textMetricBytes = host.encodeSystemTextMetricBatch([
    {
      type: "upsert",
      metric: {
        stringId: 7,
        styleId: 9,
        maxLineWidth: 123.5,
        lineCount: 2,
        advances: [
          [10, 0],
          [97, 6.5],
          [0x4e2d, 12],
        ],
        positionalAdvances: [6.5, 0, 11.5],
        contractions: [[0x3001, 0x3001, -8, -8]],
      },
    },
    { type: "release", stringId: 8, styleId: 10 },
  ]);
  const textMetricHex = encodeHex(textMetricBytes);
  assertEqual(textMetricHex, textMetricsGolden, "TypeScript system text metrics vs golden");
  assertEqual(
    roundTripInRust("text-metrics", textMetricHex),
    textMetricHex,
    "TypeScript to Rust system text metrics round trip",
  );

  const recordingBytes = host.encodeReplayRecording({
    records: [
      { type: "mutation", bytes: mutationBytes },
      { type: "systemTextMetrics", bytes: textMetricBytes },
      { type: "input", bytes: inputBytes },
    ],
  });
  const recordingHex = encodeHex(recordingBytes);
  assertEqual(recordingHex, recordingGolden, "TypeScript replay recorder vs golden");
  assertEqual(
    roundTripInRust("recording", recordingHex),
    recordingHex,
    "TypeScript to Rust replay recording round trip",
  );

  if (
    resourceGolden.schemaVersion !== 1 ||
    typeof resourceGolden.solidPaint !== "string" ||
    typeof resourceGolden.textStyle !== "string"
  ) {
    throw new Error("resource fixture is malformed");
  }
  const resources = new backend.Canvas2DResourceRegistry();
  resources.defineEncodedResource(
    1,
    backend.ResourceKind.Paint,
    decodeHex(resourceGolden.solidPaint),
  );
  resources.defineEncodedResource(
    2,
    backend.ResourceKind.TextStyle,
    decodeHex(resourceGolden.textStyle),
  );
  assertEqual(resources.getPaint(1), "#12345680", "portable solid paint fixture");
  // Unquoted: a bare CSS identifier needs no quotes, and quoting a generic
  // keyword would name a family no font has.
  assertEqual(resources.getTextStyle(2)?.font, "400 16px Inter", "portable text-style fixture");

  const display = backend.decodeDisplayList(decodeHex(displayGolden));
  if (display.commands.length !== 4 || display.commands[0]?.type !== "save") {
    throw new Error("TypeScript display-list decoder did not accept the golden contract");
  }
  assertEqual(
    roundTripInRust("display", displayGolden),
    displayGolden,
    "Rust display-list round trip",
  );

  const glyphBytes = backend.encodeGlyphResourceBatch([
    {
      type: "define",
      span: {
        spanId: 7,
        paintId: 3,
        bitmaps: [
          {
            glyphId: 42,
            left: -1,
            top: 9,
            width: 2,
            height: 2,
            devicePixelRatio: 2,
            data: new Uint8Array([0, 127, 255, 64]),
          },
        ],
        placements: [{ bitmapIndex: 0, x: 1.5, y: 12 }],
      },
    },
    { type: "release", spanId: 8 },
  ]);
  const glyphHex = encodeHex(glyphBytes);
  assertEqual(glyphHex, glyphGolden, "TypeScript glyph resource encoder vs golden");
  assertEqual(
    roundTripInRust("glyph", glyphHex),
    glyphHex,
    "TypeScript to Rust glyph resource round trip",
  );

  console.log("ABI cross-language round trips passed");
}

async function readGolden(name) {
  const value = JSON.parse(await readFile(path.join(root, "benchmarks/abi", name), "utf8"));
  if (typeof value.hex !== "string" || !/^(?:[0-9a-f]{2})+$/u.test(value.hex)) {
    throw new Error(`${name} does not contain canonical lowercase hex`);
  }
  return value.hex;
}

function roundTripInRust(kind, hex) {
  const result = spawnSync(
    "cargo",
    ["run", "--quiet", "-p", "pingo-abi", "--example", "abi_roundtrip", "--", kind],
    { cwd: root, encoding: "utf8", input: `${hex}\n` },
  );
  if (result.status !== 0) {
    throw new Error(`Rust ${kind} round trip failed: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

function encodeHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function decodeHex(hex) {
  return Uint8Array.from(hex.match(/../gu) ?? [], (byte) => Number.parseInt(byte, 16));
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label} mismatch`);
}
