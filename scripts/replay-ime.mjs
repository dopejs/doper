import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const moduleFilename = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(moduleFilename), "..");
const schemaPath = path.join(repositoryRoot, "docs/schemas/ime-recording.schema.json");
const localPlaceholders = new Set(["local-dev", "local-uncommitted"]);
let validatorPromise;

export async function replayImeRecording(recording, options = {}) {
  const { ajv, validate } = await validator();
  if (!validate(recording)) {
    throw new Error(`IME recording failed schema validation: ${ajv.errorsText(validate.errors)}`);
  }

  validateProvenance(recording, options);
  if (recording.droppedRecords !== 0) {
    throw new Error("IME recording dropped events and cannot be replayed as evidence");
  }
  if (recording.finalComposing) {
    throw new Error("IME recording ended with an active composition");
  }

  let currentText = recording.initialText;
  let composing = false;
  let previousAtMs = -1;
  let characterBoundsObserved = false;
  let compositionCount = 0;
  let softKeyboardObserved = false;

  for (const [index, record] of recording.events.entries()) {
    if (record.atMs < previousAtMs) fail(index, "event timestamps are not monotonic");
    previousAtMs = record.atMs;
    softKeyboardObserved ||=
      record.data.visualViewportHeight < recording.initialVisualViewportHeight * 0.8;

    switch (record.event) {
      case "compositionstart":
        expectText(index, record.text, currentText);
        if (composing) fail(index, "compositionstart occurred during an active composition");
        composing = true;
        compositionCount += 1;
        break;
      case "compositionend":
        if (!composing) fail(index, "compositionend occurred without an active composition");
        if (recording.environment.mode === "textarea-proxy") currentText = record.text;
        else expectText(index, record.text, currentText);
        composing = false;
        break;
      case "compositionupdate":
        requireMode(recording, index, "textarea-proxy");
        if (!composing) fail(index, "compositionupdate occurred outside a composition");
        currentText = record.text;
        break;
      case "textupdate": {
        requireMode(recording, index, "edit-context");
        const rangeStart = requireInteger(record.data.rangeStart, index, "rangeStart");
        const rangeEnd = requireInteger(record.data.rangeEnd, index, "rangeEnd");
        const insertedText = requireString(record.data.insertedText, index, "insertedText");
        validateRange(currentText, rangeStart, rangeEnd, index, !composing);
        const updatedText =
          currentText.slice(0, rangeStart) + insertedText + currentText.slice(rangeEnd);
        expectText(index, record.text, updatedText);
        currentText = updatedText;
        break;
      }
      case "input":
        requireMode(recording, index, "textarea-proxy");
        currentText = record.text;
        break;
      case "beforeinput":
      case "selectionchange":
        requireMode(recording, index, "textarea-proxy");
        expectText(index, record.text, currentText);
        break;
      case "characterboundsupdate":
        requireMode(recording, index, "edit-context");
        validateCharacterBounds(record, currentText, index);
        characterBoundsObserved = true;
        expectText(index, record.text, currentText);
        break;
      case "keydown":
        requireMode(recording, index, "edit-context");
        expectText(index, record.text, currentText);
        break;
      case "geometrychange":
      case "pointerselection":
        expectText(index, record.text, currentText);
        break;
      default:
        fail(index, `unsupported event ${String(record.event)}`);
    }

    if (record.composing !== composing) {
      fail(index, `composing state is ${String(record.composing)}, expected ${String(composing)}`);
    }
    validateSelection(record.text, record.selectionStart, record.selectionEnd, index, !composing);
    expectText(index, record.text, currentText);
  }

  if (composing !== recording.finalComposing) {
    throw new Error("Final composition state does not match replayed state");
  }
  if (currentText !== recording.finalText) {
    throw new Error("Final text does not match replayed text");
  }
  validateSelection(
    recording.finalText,
    recording.finalSelection.start,
    recording.finalSelection.end,
    "final",
    true,
  );
  const finalEvent = recording.events.at(-1);
  if (
    finalEvent.selectionStart !== recording.finalSelection.start ||
    finalEvent.selectionEnd !== recording.finalSelection.end
  ) {
    throw new Error("Final selection does not match the last recorded event");
  }
  if (characterBoundsObserved !== recording.characterBoundsObserved) {
    throw new Error("characterBoundsObserved does not match the event stream");
  }
  if (softKeyboardObserved !== recording.softKeyboardObserved) {
    throw new Error("softKeyboardObserved does not match visual viewport evidence");
  }

  return {
    characterBoundsObserved,
    compositionCount,
    durationMs: finalEvent.atMs,
    eventCount: recording.events.length,
    finalTextUtf16Length: currentText.length,
    mode: recording.environment.mode,
    recordingId: recording.recordingId,
    softKeyboardObserved,
  };
}

function validateProvenance(recording, options) {
  if (recording.provenance === "fixture" && options.allowFixture !== true) {
    throw new Error("Fixture IME recordings are not formal device evidence");
  }
  if (
    options.allowLocal !== true &&
    (localPlaceholders.has(recording.environment.buildId) ||
      localPlaceholders.has(recording.environment.deviceId))
  ) {
    throw new Error("Local build/device placeholders are not formal IME evidence");
  }
}

function validateCharacterBounds(record, text, index) {
  const rangeStart = requireInteger(record.data.rangeStart, index, "rangeStart");
  const rangeEnd = requireInteger(record.data.rangeEnd, index, "rangeEnd");
  if (rangeStart < 0 || rangeStart > rangeEnd || rangeEnd > text.length) {
    fail(index, "character bounds range is outside the UTF-16 text");
  }
  if (rangeEnd > rangeStart) {
    for (const field of [
      "firstCharacterLeft",
      "firstCharacterTop",
      "lastCharacterRight",
      "lastCharacterTop",
    ]) {
      if (typeof record.data[field] !== "number") {
        fail(index, `${field} is required for a non-empty character bounds range`);
      }
    }
  }
}

function validateRange(text, start, end, index, requireGraphemeBoundary) {
  if (start < 0 || start > end || end > text.length) {
    fail(index, "text update range is outside the UTF-16 text");
  }
  validateBoundary(text, start, index, "rangeStart", requireGraphemeBoundary);
  validateBoundary(text, end, index, "rangeEnd", requireGraphemeBoundary);
}

function validateSelection(text, start, end, index, requireGraphemeBoundary) {
  if (start < 0 || start > end || end > text.length) {
    fail(index, "selection is outside the UTF-16 text");
  }
  validateBoundary(text, start, index, "selectionStart", requireGraphemeBoundary);
  validateBoundary(text, end, index, "selectionEnd", requireGraphemeBoundary);
}

function validateBoundary(text, offset, index, label, requireGraphemeBoundary) {
  if (splitsSurrogatePair(text, offset)) {
    fail(index, `${label} splits a UTF-16 surrogate pair`);
  }
  if (requireGraphemeBoundary && !graphemeBoundaries(text).has(offset)) {
    fail(index, `${label} splits a grapheme cluster`);
  }
}

function splitsSurrogatePair(text, offset) {
  if (offset <= 0 || offset >= text.length) return false;
  const previous = text.charCodeAt(offset - 1);
  const current = text.charCodeAt(offset);
  return previous >= 0xd800 && previous <= 0xdbff && current >= 0xdc00 && current <= 0xdfff;
}

function graphemeBoundaries(text) {
  const boundaries = new Set([0, text.length]);
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  for (const segment of segmenter.segment(text)) boundaries.add(segment.index);
  return boundaries;
}

function requireMode(recording, index, expected) {
  if (recording.environment.mode !== expected) {
    fail(index, `${recording.events[index].event} is invalid in ${recording.environment.mode}`);
  }
}

function requireInteger(value, index, label) {
  if (!Number.isInteger(value)) fail(index, `${label} must be an integer`);
  return value;
}

function requireString(value, index, label) {
  if (typeof value !== "string") fail(index, `${label} must be a string`);
  return value;
}

function expectText(index, actual, expected) {
  if (actual !== expected) fail(index, "recorded text does not match replayed text");
}

function fail(index, message) {
  throw new Error(`IME event ${String(index)}: ${message}`);
}

async function validator() {
  validatorPromise ??= (async () => {
    const schema = JSON.parse(await readFile(schemaPath, "utf8"));
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    return { ajv, validate: ajv.compile(schema) };
  })();
  return validatorPromise;
}

async function main(arguments_) {
  const options = {
    allowFixture: arguments_.includes("--allow-fixture"),
    allowLocal: arguments_.includes("--allow-local"),
  };
  const filenames = arguments_.filter((argument) => !argument.startsWith("--"));
  if (filenames.length === 0) {
    throw new Error(
      "usage: pnpm ime:replay -- [--allow-fixture] [--allow-local] <recording.json>...",
    );
  }
  for (const filename of filenames) {
    const recording = JSON.parse(await readFile(path.resolve(filename), "utf8"));
    const summary = await replayImeRecording(recording, options);
    runtimeProcess.stdout.write(`${filename}: ${JSON.stringify(summary)}\n`);
  }
}

const runtimeProcess = Reflect.get(globalThis, "process");
if (
  runtimeProcess !== undefined &&
  runtimeProcess.argv[1] !== undefined &&
  path.resolve(runtimeProcess.argv[1]) === moduleFilename
) {
  main(runtimeProcess.argv.slice(2)).catch((error) => {
    runtimeProcess.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    runtimeProcess.exitCode = 1;
  });
}
