import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { replayImeRecording } from "./replay-ime.mjs";

const fixture = JSON.parse(
  await readFile(new URL("../benchmarks/ime/recording.fixture.v2.json", import.meta.url), "utf8"),
);

describe("replayImeRecording", () => {
  it("replays a schema-valid composition recording", async () => {
    await expect(
      replayImeRecording(fixture, { allowFixture: true, allowLocal: true }),
    ).resolves.toMatchObject({
      characterBoundsObserved: true,
      compositionCount: 1,
      eventCount: 4,
      finalTextUtf16Length: 4,
    });
  });

  it("rejects a textupdate that does not reproduce the recorded text", async () => {
    const corrupted = structuredClone(fixture);
    corrupted.events[1].data.insertedText = "错";
    await expect(
      replayImeRecording(corrupted, { allowFixture: true, allowLocal: true }),
    ).rejects.toThrow(/recorded text does not match/u);
  });

  it("rejects a selection that splits a surrogate pair", async () => {
    const corrupted = structuredClone(fixture);
    corrupted.events[3].selectionStart = 2;
    corrupted.events[3].selectionEnd = 2;
    corrupted.finalSelection = { end: 2, start: 2 };
    await expect(
      replayImeRecording(corrupted, { allowFixture: true, allowLocal: true }),
    ).rejects.toThrow(/splits a UTF-16 surrogate pair/u);
  });

  it("does not accept a fixture as formal device evidence", async () => {
    await expect(replayImeRecording(fixture)).rejects.toThrow(/not formal device evidence/u);
  });

  it("replays textarea proxy composition snapshots", async () => {
    const proxy = proxyRecording();
    await expect(
      replayImeRecording(proxy, { allowFixture: true, allowLocal: true }),
    ).resolves.toMatchObject({
      characterBoundsObserved: false,
      compositionCount: 1,
      eventCount: 5,
      mode: "textarea-proxy",
    });
  });

  it("rejects a soft-keyboard flag without matching viewport evidence", async () => {
    const corrupted = structuredClone(fixture);
    corrupted.softKeyboardObserved = true;
    await expect(
      replayImeRecording(corrupted, { allowFixture: true, allowLocal: true }),
    ).rejects.toThrow(/softKeyboardObserved does not match/u);
  });

  it("rejects recorded evidence with local build or device placeholders", async () => {
    const local = structuredClone(fixture);
    local.provenance = "recorded";
    await expect(replayImeRecording(local)).rejects.toThrow(/Local build\/device placeholders/u);
  });

  it("rejects a non-composition selection inside a grapheme cluster", async () => {
    const corrupted = proxyRecording();
    corrupted.initialText = "";
    corrupted.finalText = "e\u0301";
    corrupted.finalSelection = { end: 1, start: 1 };
    corrupted.events = [
      eventRecord({
        atMs: 0,
        composing: false,
        event: "input",
        message: "input",
        selectionEnd: 1,
        selectionStart: 1,
        text: "e\u0301",
      }),
    ];
    await expect(
      replayImeRecording(corrupted, { allowFixture: true, allowLocal: true }),
    ).rejects.toThrow(/splits a grapheme cluster/u);
  });
});

function proxyRecording() {
  const recording = structuredClone(fixture);
  recording.characterBoundsObserved = false;
  recording.description = "Textarea proxy composition replay fixture";
  recording.environment.mode = "textarea-proxy";
  recording.events = [
    eventRecord({
      atMs: 0,
      composing: true,
      event: "compositionstart",
      message: "compositionstart",
      selectionEnd: 3,
      selectionStart: 3,
      text: "A😀",
    }),
    eventRecord({
      atMs: 5,
      composing: true,
      data: { inputType: "insertCompositionText", insertedText: "你" },
      event: "beforeinput",
      message: "beforeinput insertCompositionText",
      selectionEnd: 3,
      selectionStart: 3,
      text: "A😀",
    }),
    eventRecord({
      atMs: 10,
      composing: true,
      data: { insertedText: "你" },
      event: "compositionupdate",
      message: "compositionupdate",
      selectionEnd: 4,
      selectionStart: 4,
      text: "A😀你",
    }),
    eventRecord({
      atMs: 15,
      composing: true,
      event: "input",
      message: "input",
      selectionEnd: 4,
      selectionStart: 4,
      text: "A😀你",
    }),
    eventRecord({
      atMs: 20,
      composing: false,
      event: "compositionend",
      message: "compositionend",
      selectionEnd: 4,
      selectionStart: 4,
      text: "A😀你",
    }),
  ];
  return recording;
}

function eventRecord(overrides) {
  return {
    ...overrides,
    data: {
      ...structuredClone(fixture.events[0].data),
      ...overrides.data,
    },
  };
}
