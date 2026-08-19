import { describe, expect, it } from "vitest";

import { NativeTextInputBridge, type EditingTargetState } from "./native-input";
import type { EditTransaction } from "./edit-transactions";
import type { InputCommand } from "./input-stream";

class FakeSurface extends EventTarget {
  public readonly attributes = new Map<string, string>();
  public readonly dataset: Record<string, string> = {};
  public readonly style: Record<string, string> = {};
  public autocapitalize = "";
  public autocomplete = "";
  public focused = false;
  public inputMode = "";
  public readOnly = false;
  public removed = false;
  public selectionEnd = 0;
  public selectionStart = 0;
  public spellcheck = true;
  public value = "";

  public blur(): void {
    this.focused = false;
  }

  public focus(): void {
    this.focused = true;
  }

  public getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  public remove(): void {
    this.removed = true;
  }

  public setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  public setSelectionRange(start: number, end: number): void {
    this.selectionStart = start;
    this.selectionEnd = end;
  }
}

class FakeEditContext extends EventTarget {
  public readonly calls: Array<readonly [string, unknown[]]> = [];
  public selectionEnd = 0;
  public selectionStart = 0;
  public text = "";

  public constructor(options: { text: string; selectionStart: number; selectionEnd: number }) {
    super();
    this.text = options.text;
    this.selectionStart = options.selectionStart;
    this.selectionEnd = options.selectionEnd;
  }

  public updateCharacterBounds(rangeStart: number, bounds: readonly unknown[]): void {
    this.calls.push(["updateCharacterBounds", [rangeStart, bounds]]);
  }

  public updateControlBounds(bounds: unknown): void {
    this.calls.push(["updateControlBounds", [bounds]]);
  }

  public updateSelection(start: number, end: number): void {
    this.selectionStart = start;
    this.selectionEnd = end;
    this.calls.push(["updateSelection", [start, end]]);
  }

  public updateSelectionBounds(bounds: unknown): void {
    this.calls.push(["updateSelectionBounds", [bounds]]);
  }

  public updateText(rangeStart: number, rangeEnd: number, text: string): void {
    this.text = this.text.slice(0, rangeStart) + text + this.text.slice(rangeEnd);
    this.calls.push(["updateText", [rangeStart, rangeEnd, text]]);
  }
}

interface Harness {
  readonly bridge: NativeTextInputBridge;
  readonly canvas: FakeSurface;
  readonly commands: InputCommand[];
  readonly context: FakeEditContext | undefined;
  readonly errors: Error[];
  readonly proxy: FakeSurface | undefined;
  readonly submits: number[];
  readonly boundsRequests: Array<readonly [number, number, number]>;
}

function harness(options: { editContext?: boolean } = {}): Harness {
  const commands: InputCommand[] = [];
  const errors: Error[] = [];
  const submits: number[] = [];
  const boundsRequests: Array<readonly [number, number, number]> = [];
  const created: FakeSurface[] = [];
  const canvas = new FakeSurface();
  const fakeDocument = {
    body: { append: () => undefined },
    createElement: () => {
      const element = new FakeSurface();
      created.push(element);
      return element;
    },
    defaultView: undefined,
  };
  Reflect.set(canvas, "ownerDocument", fakeDocument);
  const bridge = new NativeTextInputBridge(canvas as unknown as HTMLCanvasElement, {
    dispatch: (command) => commands.push(command),
    editContext: options.editContext === true ? FakeEditContext : null,
    onError: (error) => errors.push(error),
    onSubmit: (nodeId) => submits.push(nodeId),
    requestCharacterBounds: (nodeId, start, end) => boundsRequests.push([nodeId, start, end]),
  });
  const context =
    options.editContext === true
      ? (Reflect.get(canvas, "editContext") as FakeEditContext)
      : undefined;
  return {
    bridge,
    canvas,
    commands,
    context,
    errors,
    proxy: options.editContext === true ? undefined : created[0],
    submits,
    boundsRequests,
  };
}

function target(overrides: Partial<EditingTargetState> = {}): EditingTargetState {
  return {
    inputMode: "text",
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

function transaction(overrides: Partial<EditTransaction> = {}): EditTransaction {
  return {
    baseRevision: 7n,
    delta: { range: { start: 2, end: 2 }, text: "c" },
    kind: "edit",
    nodeId: 17,
    revision: 8n,
    selection: { anchor: 3, anchorAffinity: "downstream", focus: 3, focusAffinity: "downstream" },
    ...overrides,
  };
}

describe("NativeTextInputBridge (unit)", () => {
  it("detaches the EditContext when the session ends", () => {
    // An EditContext left on a focused element keeps the OS text service
    // engaged, so the soft keyboard and the IME stay on a field the user has
    // clicked away from. Ending the session logically is not enough.
    const { bridge, canvas } = harness({ editContext: true });
    bridge.activate(target());
    expect(Reflect.get(canvas, "editContext")).not.toBeNull();
    bridge.deactivate();
    expect(Reflect.get(canvas, "editContext")).toBeNull();
    bridge.activate(target());
    expect(Reflect.get(canvas, "editContext")).not.toBeNull();
  });

  it("maps EditContext keydown navigation onto Core caret movement", () => {
    const { bridge, canvas, commands } = harness({ editContext: true });
    bridge.activate(target());
    const press = (key: string, init: Record<string, unknown> = {}): void => {
      canvas.dispatchEvent(
        Object.assign(
          new Event("keydown", { cancelable: true }),
          { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false },
          init,
          { key },
        ),
      );
    };
    press("ArrowLeft");
    press("ArrowRight", { altKey: true });
    press("ArrowLeft", { metaKey: true });
    press("ArrowUp", { shiftKey: true });
    press("ArrowDown");
    press("Home");
    press("End", { shiftKey: true });
    press("Escape");
    expect(commands).toEqual([
      {
        type: "moveCaret",
        nodeId: 17,
        direction: "backward",
        granularity: "grapheme",
        extend: false,
      },
      { type: "moveCaret", nodeId: 17, direction: "forward", granularity: "word", extend: false },
      {
        type: "moveCaret",
        nodeId: 17,
        direction: "lineStart",
        granularity: "grapheme",
        extend: false,
      },
      { type: "moveCaret", nodeId: 17, direction: "up", granularity: "grapheme", extend: true },
      { type: "moveCaret", nodeId: 17, direction: "down", granularity: "grapheme", extend: false },
      {
        type: "moveCaret",
        nodeId: 17,
        direction: "lineStart",
        granularity: "grapheme",
        extend: false,
      },
      {
        type: "moveCaret",
        nodeId: 17,
        direction: "lineEnd",
        granularity: "grapheme",
        extend: true,
      },
    ]);
  });

  it("applies inputMode to the surface on activation and clears it on deactivate", () => {
    const withContext = harness({ editContext: true });
    withContext.bridge.activate(target({ inputMode: "email" }));
    expect(withContext.canvas.getAttribute("inputmode")).toBe("email");
    withContext.bridge.deactivate();
    expect(withContext.canvas.getAttribute("inputmode")).toBe("none");

    const withProxy = harness();
    withProxy.bridge.activate(target({ inputMode: "numeric" }));
    expect(withProxy.proxy?.inputMode).toBe("numeric");
    expect(withProxy.proxy?.focused).toBe(true);
    withProxy.bridge.deactivate();
    expect(withProxy.proxy?.inputMode).toBe("none");
    expect(withProxy.proxy?.focused).toBe(false);
  });

  it("fast-forwards its optimistic revision on Core-initiated transactions", () => {
    const { bridge, context, commands } = harness({ editContext: true });
    bridge.activate(target());
    bridge.applyTransaction(transaction());
    expect(context?.text).toBe("abc");
    bridge.applyTransaction({
      baseRevision: 8n,
      revision: 9n,
      kind: "edit",
      nodeId: 17,
      selection: {
        anchor: 0,
        anchorAffinity: "downstream",
        focus: 3,
        focusAffinity: "downstream",
      },
    });
    expect([context?.selectionStart, context?.selectionEnd]).toEqual([0, 3]);
    // A later local intent uses the fast-forwarded base revision.
    context?.dispatchEvent(
      Object.assign(new Event("textupdate"), {
        text: "x",
        updateRangeStart: 3,
        updateRangeEnd: 3,
        selectionStart: 4,
        selectionEnd: 4,
      }),
    );
    expect(commands.at(-1)).toMatchObject({ type: "replace", baseRevision: 9n, text: "x" });
  });

  it("answers character bounds locally or falls back to a Core request", () => {
    const { bridge, context, boundsRequests } = harness({ editContext: true });
    bridge.activate(target());
    context?.dispatchEvent(
      Object.assign(new Event("characterboundsupdate"), { rangeStart: 0, rangeEnd: 2 }),
    );
    expect(boundsRequests).toEqual([[17, 0, 2]]);
    bridge.updateGeometry({
      controlBounds: { x: 0 } as DOMRect,
      selectionBounds: { x: 0 } as DOMRect,
      characterBounds: (start, end) =>
        Array.from({ length: end - start }, () => ({ width: 5 }) as DOMRect),
    });
    const answered = context?.calls.filter(([name]) => name === "updateCharacterBounds");
    expect(answered).toHaveLength(1);
  });

  it("routes proxy beforeinput, selection, clipboard, and submit correctly", () => {
    const { bridge, proxy, commands, submits } = harness();
    bridge.activate(target());
    const input = (inputType: string, data?: string): void => {
      proxy?.dispatchEvent(
        Object.assign(new Event("beforeinput", { cancelable: true }), { inputType, data }),
      );
    };
    input("insertText", "c");
    input("deleteContentBackward");
    input("deleteWordForward");
    input("historyUndo");
    input("historyRedo");
    input("insertParagraph");
    expect(submits).toEqual([17]);
    expect(commands.map((command) => command.type)).toEqual([
      "insert",
      "deleteBackward",
      "deleteForward",
      "undo",
      "redo",
    ]);

    if (proxy !== undefined) {
      proxy.selectionStart = 0;
      proxy.selectionEnd = 2;
    }
    proxy?.dispatchEvent(new Event("select"));
    expect(commands.at(-1)?.type).toBe("setSelection");

    // Clipboard operates on the bridge-visible selection.
    bridge.activate(target({ selection: { anchor: 0, focus: 2 } }));
    const clipboard = new Map<string, string>();
    const clipboardEvent = (type: string): Event =>
      Object.assign(new Event(type, { cancelable: true }), {
        clipboardData: {
          getData: (format: string) => clipboard.get(format) ?? "",
          setData: (format: string, value: string) => clipboard.set(format, value),
        },
      });
    proxy?.dispatchEvent(clipboardEvent("copy"));
    expect(clipboard.get("text/plain")).toBe("ab");
    clipboard.set("text/plain", "pasted");
    proxy?.dispatchEvent(clipboardEvent("paste"));
    expect(commands.at(-1)).toMatchObject({ type: "insert", text: "pasted" });
    proxy?.dispatchEvent(clipboardEvent("cut"));
    expect(commands.at(-1)).toMatchObject({ type: "replace", start: 0, end: 2, text: "" });
  });

  it("blocks password clipboard reads and read-only mutations", () => {
    const { bridge, proxy, commands } = harness();
    bridge.activate(target({ password: true, readOnly: true }));
    const clipboard = new Map<string, string>();
    const clipboardEvent = (type: string): Event =>
      Object.assign(new Event(type, { cancelable: true }), {
        clipboardData: {
          getData: (format: string) => clipboard.get(format) ?? "",
          setData: (format: string, value: string) => clipboard.set(format, value),
        },
      });
    proxy?.dispatchEvent(clipboardEvent("copy"));
    proxy?.dispatchEvent(clipboardEvent("cut"));
    proxy?.dispatchEvent(clipboardEvent("paste"));
    proxy?.dispatchEvent(
      Object.assign(new Event("beforeinput", { cancelable: true }), {
        inputType: "insertText",
        data: "x",
      }),
    );
    expect(clipboard.size).toBe(0);
    expect(commands).toEqual([]);
  });

  it("runs proxy composition sequences and rejects invalid activation targets", () => {
    const { bridge, proxy, commands } = harness();
    bridge.activate(target());
    proxy?.dispatchEvent(new Event("compositionstart"));
    proxy?.dispatchEvent(Object.assign(new Event("compositionupdate"), { data: "に" }));
    proxy?.dispatchEvent(Object.assign(new Event("compositionend"), { data: "日本" }));
    expect(commands.map((command) => command.type)).toEqual([
      "beginComposition",
      "updateComposition",
      "commitComposition",
    ]);
    expect(() => bridge.activate(target({ selection: { anchor: 9, focus: 9 } }))).toThrow(
      /selection/u,
    );
  });

  it("rolls back the optimistic revision when dispatch fails", () => {
    const commands: InputCommand[] = [];
    const errors: Error[] = [];
    let attempts = 0;
    const canvas = new FakeSurface();
    Reflect.set(canvas, "ownerDocument", {
      body: { append: () => undefined },
      createElement: () => new FakeSurface(),
      defaultView: undefined,
    });
    const bridge = new NativeTextInputBridge(canvas as unknown as HTMLCanvasElement, {
      dispatch: (command) => {
        attempts += 1;
        if (attempts === 1) throw new Error("transport unavailable");
        commands.push(command);
      },
      editContext: FakeEditContext,
      onError: (error) => errors.push(error),
    });
    bridge.activate(target());
    const context = Reflect.get(canvas, "editContext") as FakeEditContext;
    const type = (text: string): void => {
      context.dispatchEvent(
        Object.assign(new Event("textupdate"), {
          text,
          updateRangeStart: 2,
          updateRangeEnd: 2,
          selectionStart: 2 + text.length,
          selectionEnd: 2 + text.length,
        }),
      );
    };
    type("x");
    expect(errors[0]?.message).toBe("transport unavailable");
    type("y");
    expect(commands[0]).toMatchObject({ baseRevision: 7n, text: "y" });
    bridge.dispose();
    expect(() => bridge.activate(target())).toThrow(/disposed|usable/iu);
  });
});
