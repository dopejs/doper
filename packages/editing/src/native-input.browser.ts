import { afterEach, describe, expect, it } from "vitest";

import type { EditTransaction } from "./edit-transactions";
import type { InputCommand } from "./input-stream";
import { NativeTextInputBridge } from "./native-input";

interface BrowserEditContext extends EventTarget {
  readonly selectionEnd: number;
  readonly selectionStart: number;
  readonly text: string;
}

function editableTarget(overrides: Partial<Parameters<NativeTextInputBridge["activate"]>[0]> = {}) {
  return {
    multiline: false,
    nodeId: 17,
    password: false,
    readOnly: false,
    revision: 7n,
    selection: { anchor: 2, focus: 2 },
    value: "ab",
    ...overrides,
  };
}

function textUpdate(detail: {
  text: string;
  updateRangeStart: number;
  updateRangeEnd: number;
  selectionStart?: number;
  selectionEnd?: number;
}): Event {
  return Object.assign(new Event("textupdate"), {
    selectionEnd: detail.selectionEnd ?? detail.updateRangeStart + detail.text.length,
    selectionStart: detail.selectionStart ?? detail.updateRangeStart + detail.text.length,
    ...detail,
  });
}

function transaction(overrides: Partial<EditTransaction> = {}): EditTransaction {
  return {
    baseRevision: 7n,
    delta: { range: { start: 2, end: 2 }, text: "文" },
    kind: "edit",
    nodeId: 17,
    revision: 8n,
    selection: {
      anchor: 3,
      anchorAffinity: "downstream",
      focus: 3,
      focusAffinity: "downstream",
    },
    ...overrides,
  };
}

const bridges: NativeTextInputBridge[] = [];

afterEach(() => {
  for (const bridge of bridges.splice(0)) bridge.dispose();
  document.querySelectorAll("[data-pingo-input-proxy]").forEach((node) => node.remove());
});

describe("NativeTextInputBridge", () => {
  it("binds one EditContext and preserves exact revision ordering", () => {
    const canvas = document.createElement("canvas");
    document.body.append(canvas);
    const commands: InputCommand[] = [];
    const bridge = new NativeTextInputBridge(canvas, {
      dispatch: (command) => commands.push(command),
    });
    bridges.push(bridge);
    bridge.activate(editableTarget());

    const context = Reflect.get(canvas, "editContext") as BrowserEditContext;
    expect(bridge.mode).toBe("edit-context");
    expect(context.text).toBe("ab");
    context.dispatchEvent(textUpdate({ text: "文", updateRangeStart: 2, updateRangeEnd: 2 }));
    expect(commands).toEqual([
      { type: "replace", nodeId: 17, baseRevision: 7n, start: 2, end: 2, text: "文" },
    ]);

    bridge.applyTransaction(transaction());
    expect(context.text).toBe("ab文");
    expect([context.selectionStart, context.selectionEnd]).toEqual([3, 3]);
    context.dispatchEvent(textUpdate({ text: "字", updateRangeStart: 3, updateRangeEnd: 3 }));
    expect(commands[1]).toMatchObject({ baseRevision: 8n, text: "字" });
  });

  it("rolls back its optimistic revision when dispatch fails synchronously", () => {
    const canvas = document.createElement("canvas");
    let attempts = 0;
    const commands: InputCommand[] = [];
    const errors: Error[] = [];
    const bridge = new NativeTextInputBridge(canvas, {
      dispatch: (command) => {
        attempts += 1;
        if (attempts === 1) throw new Error("transport unavailable");
        commands.push(command);
      },
      onError: (error) => errors.push(error),
    });
    bridges.push(bridge);
    bridge.activate(editableTarget());
    const context = Reflect.get(canvas, "editContext") as BrowserEditContext;

    context.dispatchEvent(textUpdate({ text: "x", updateRangeStart: 2, updateRangeEnd: 2 }));
    expect(errors[0]?.message).toBe("transport unavailable");
    context.dispatchEvent(textUpdate({ text: "y", updateRangeStart: 2, updateRangeEnd: 2 }));
    expect(commands[0]).toMatchObject({ baseRevision: 7n, text: "y" });
  });

  it("uses one centralized textarea proxy for beforeinput and submit", () => {
    const canvas = document.createElement("canvas");
    document.body.append(canvas);
    const commands: InputCommand[] = [];
    const submits: number[] = [];
    const bridge = new NativeTextInputBridge(canvas, {
      dispatch: (command) => commands.push(command),
      editContext: null,
      onSubmit: (nodeId) => submits.push(nodeId),
    });
    bridges.push(bridge);
    bridge.activate(editableTarget());
    const proxy = document.querySelector<HTMLTextAreaElement>("[data-pingo-input-proxy]");
    expect(bridge.mode).toBe("textarea-proxy");
    expect(proxy).not.toBeNull();
    expect(proxy?.value).toBe("ab");

    proxy?.dispatchEvent(
      new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        data: "c",
        inputType: "insertText",
      }),
    );
    expect(commands[0]).toMatchObject({ type: "insert", baseRevision: 7n, text: "c" });
    proxy?.dispatchEvent(
      new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        inputType: "insertParagraph",
      }),
    );
    expect(submits).toEqual([17]);
    expect(commands).toHaveLength(1);
  });

  it("answers IME geometry requests and rejects split surrogate offsets", () => {
    const canvas = document.createElement("canvas");
    const bridge = new NativeTextInputBridge(canvas, {
      dispatch: () => undefined,
    });
    bridges.push(bridge);
    expect(() =>
      bridge.activate(editableTarget({ value: "😀", selection: { anchor: 1, focus: 1 } })),
    ).toThrow("splits a surrogate pair");

    bridge.activate(editableTarget());
    const context = Reflect.get(canvas, "editContext") as BrowserEditContext;
    const controlBounds = new DOMRect(1, 2, 30, 12);
    const selectionBounds = new DOMRect(10, 2, 1, 12);
    const requested: Array<readonly [number, number]> = [];
    bridge.updateGeometry({
      characterBounds: (start, end) => {
        requested.push([start, end]);
        return Array.from(
          { length: end - start },
          (_, index) => new DOMRect(start + index, 2, 5, 12),
        );
      },
      controlBounds,
      selectionBounds,
    });
    context.dispatchEvent(
      Object.assign(new Event("characterboundsupdate"), { rangeStart: 0, rangeEnd: 2 }),
    );
    expect(requested).toEqual([[0, 2]]);
  });
});
