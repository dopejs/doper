import {
  createElement,
  createHostedCanvasRoot,
  type EditTransaction,
  type FrameReport,
  type NodeHandle,
} from "@dopejs/pingo";
import { afterEach, describe, expect, it } from "vitest";

interface BrowserEditContext extends EventTarget {
  readonly selectionEnd: number;
  readonly selectionStart: number;
  readonly text: string;
}

describe("M4 native editing vertical slice", () => {
  const roots: Array<{ close(): Promise<void> }> = [];

  afterEach(async () => {
    for (const root of roots.splice(0).reverse()) await root.close();
    document.body.replaceChildren();
  });

  it("edits without Shell rerenders in every transport and input fallback", async () => {
    expect(crossOriginIsolated).toBe(true);
    const cases = [
      ["main-thread", "auto"],
      ["main-thread", "textarea-proxy"],
      ["post-message", "auto"],
      ["sab", "auto"],
    ] as const;
    for (const [preference, nativeTextInputMode] of cases) {
      const canvas = document.createElement("canvas");
      canvas.width = 180;
      canvas.height = 60;
      document.body.append(canvas);
      let handle: NodeHandle | null = null;
      const frames: FrameReport[] = [];
      const transactions: EditTransaction[] = [];
      const controlledValues: Array<readonly [string, bigint]> = [];
      const errors: Error[] = [];
      const root = await createHostedCanvasRoot(canvas, {
        nativeTextInputMode,
        onEditTransaction: (transaction) => transactions.push(transaction),
        onFrame: (report) => frames.push(report),
        onHostError: (error) => errors.push(error),
        transport: { preference, strict: true },
      });
      roots.push(root);
      root.render(
        createElement("editableText", {
          height: 40,
          ref: (value: NodeHandle | null) => {
            handle = value;
          },
          revision: 1n,
          value: "ab",
          width: 160,
          onTransaction: (transaction: EditTransaction) =>
            controlledValues.push([
              applyTransactionValue(controlledValues.at(-1)?.[0] ?? "ab", transaction),
              transaction.revision,
            ]),
        }),
      );
      await withTimeout(
        waitUntil(() => frames.some((frame) => frame.cause === "mutation")),
        3_000,
        `${preference}/${nativeTextInputMode} initial frame`,
      );
      if (handle === null) throw new Error("editable ref was not attached");
      root.focusEditable(handle);

      dispatchText(canvas, nativeTextInputMode, "文", 2);
      await withTimeout(
        waitUntil(() => transactions.length === 1),
        3_000,
        `${preference}/${nativeTextInputMode} first transaction`,
      );
      expect(transactions[0]).toMatchObject({ baseRevision: 1n, revision: 2n });
      expect(controlledValues).toEqual([["ab文", 2n]]);
      expect(nativeSurfaceValue(canvas, nativeTextInputMode)).toBe("ab文");

      // A stale controlled render must not overwrite the newer Core/Shell mirror.
      root.render(
        createElement("editableText", {
          height: 40,
          ref: (value: NodeHandle | null) => {
            handle = value;
          },
          revision: 1n,
          value: "ab",
          width: 160,
          onTransaction: (transaction: EditTransaction) =>
            controlledValues.push([
              applyTransactionValue(controlledValues.at(-1)?.[0] ?? "ab", transaction),
              transaction.revision,
            ]),
        }),
      );
      await withTimeout(
        waitUntil(() => frames.filter((frame) => frame.cause === "mutation").length >= 2),
        3_000,
        `${preference}/${nativeTextInputMode} stale controlled frame`,
      );
      dispatchText(canvas, nativeTextInputMode, "字", 3);
      await withTimeout(
        waitUntil(() => transactions.length === 2),
        3_000,
        `${preference}/${nativeTextInputMode} second transaction`,
      );
      expect(transactions[1]).toMatchObject({ baseRevision: 2n, revision: 3n });
      expect(controlledValues.at(-1)).toEqual(["ab文字", 3n]);
      expect(nativeSurfaceValue(canvas, nativeTextInputMode)).toBe("ab文字");
      expect(frames.some((frame) => frame.cause === "input")).toBe(true);
      expect(root.mode).toBe(preference);
      expect(errors).toEqual([]);
      await root.close();
      roots.pop();
    }
  });

  it("focuses, places the caret, drag-selects, and word-selects from pointer input", async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 180;
    canvas.height = 60;
    document.body.append(canvas);
    const frames: FrameReport[] = [];
    const errors: Error[] = [];
    const root = await createHostedCanvasRoot(canvas, {
      onFrame: (report) => frames.push(report),
      onHostError: (error) => errors.push(error),
      transport: { preference: "main-thread", strict: true },
    });
    roots.push(root);
    root.render(
      createElement("editableText", {
        height: 40,
        revision: 1n,
        value: "ab cd",
        width: 160,
      }),
    );
    await withTimeout(
      waitUntil(() => frames.some((frame) => frame.cause === "mutation")),
      3_000,
      "pointer editing initial frame",
    );
    const rect = canvas.getBoundingClientRect();
    const pointer = (type: string, x: number, y: number, buttons: number): void => {
      canvas.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          buttons,
          clientX: rect.left + x,
          clientY: rect.top + y,
          pointerId: 5,
        }),
      );
    };

    // Clicking an unfocused editable activates it and places the caret.
    pointer("pointerdown", 150, 20, 1);
    const context = (): BrowserEditContext =>
      Reflect.get(canvas, "editContext") as BrowserEditContext;
    await withTimeout(
      waitUntil(() => context().text === "ab cd" && context().selectionStart === 5),
      3_000,
      "click to caret",
    );
    pointer("pointerup", 150, 20, 0);

    // Dragging from the end to the left extends the selection.
    pointer("pointerdown", 150, 20, 1);
    pointer("pointermove", 2, 20, 1);
    await withTimeout(
      waitUntil(() => context().selectionStart === 0 && context().selectionEnd === 5),
      3_000,
      "drag selection",
    );
    pointer("pointerup", 2, 20, 0);

    // Double-clicking near the end selects the trailing word.
    canvas.dispatchEvent(
      new MouseEvent("dblclick", {
        bubbles: true,
        clientX: rect.left + 150,
        clientY: rect.top + 20,
      }),
    );
    await withTimeout(
      waitUntil(() => context().selectionStart === 3 && context().selectionEnd === 5),
      3_000,
      "double-click word selection",
    );

    // Keyboard navigation flows through Core caret movement.
    const press = (key: string, init: KeyboardEventInit = {}): void => {
      canvas.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key, ...init }));
    };
    press("ArrowLeft");
    await withTimeout(
      waitUntil(() => context().selectionStart === 3 && context().selectionEnd === 3),
      3_000,
      "arrow collapses selection",
    );
    press("End", { shiftKey: true });
    await withTimeout(
      waitUntil(() => context().selectionStart === 3 && context().selectionEnd === 5),
      3_000,
      "shift-end extends to line end",
    );
    press("ArrowUp");
    await withTimeout(
      waitUntil(() => context().selectionStart === 0 && context().selectionEnd === 0),
      3_000,
      "arrow-up clamps to text start",
    );
    expect(errors).toEqual([]);
  });

  it("feeds Core editor geometry to the IME surface and answers character queries", async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 180;
    canvas.height = 60;
    document.body.append(canvas);
    let handle: NodeHandle | null = null;
    const frames: FrameReport[] = [];
    const transactions: EditTransaction[] = [];
    const errors: Error[] = [];
    const root = await createHostedCanvasRoot(canvas, {
      onEditTransaction: (transaction) => transactions.push(transaction),
      onFrame: (report) => frames.push(report),
      onHostError: (error) => errors.push(error),
      transport: { preference: "main-thread", strict: true },
    });
    roots.push(root);
    root.render(
      createElement("editableText", {
        height: 40,
        ref: (value: NodeHandle | null) => {
          handle = value;
        },
        revision: 1n,
        value: "ab",
        width: 160,
      }),
    );
    await withTimeout(
      waitUntil(() => frames.some((frame) => frame.cause === "mutation")),
      3_000,
      "geometry initial frame",
    );
    if (handle === null) throw new Error("editable ref was not attached");
    root.focusEditable(handle);
    const context = Reflect.get(canvas, "editContext") as BrowserEditContext;
    const controlBounds: DOMRect[] = [];
    const selectionBounds: DOMRect[] = [];
    const characterBounds: Array<readonly [number, readonly DOMRect[]]> = [];
    Object.assign(context, {
      updateControlBounds: (rect: DOMRect) => controlBounds.push(rect),
      updateSelectionBounds: (rect: DOMRect) => selectionBounds.push(rect),
      updateCharacterBounds: (rangeStart: number, rects: readonly DOMRect[]) =>
        characterBounds.push([rangeStart, rects]),
    });

    dispatchText(canvas, "auto", "文", 2);
    await withTimeout(
      waitUntil(() => transactions.length === 1 && controlBounds.length > 0),
      3_000,
      "geometry after edit",
    );
    const control = controlBounds.at(-1);
    if (control === undefined) throw new Error("control bounds were not published");
    expect(control.width).toBeGreaterThan(0);
    expect(control.height).toBeGreaterThan(0);
    expect(Number.isFinite(control.x)).toBe(true);
    const selection = selectionBounds.at(-1);
    if (selection === undefined) throw new Error("selection bounds were not published");
    expect(Number.isFinite(selection.x)).toBe(true);

    context.dispatchEvent(
      Object.assign(new Event("characterboundsupdate"), { rangeStart: 0, rangeEnd: 2 }),
    );
    await withTimeout(
      waitUntil(() => characterBounds.length > 0),
      3_000,
      "character bounds answer",
    );
    const [rangeStart, rects] = characterBounds.at(-1) ?? [Number.NaN, []];
    expect(rangeStart).toBe(0);
    expect(rects).toHaveLength(2);
    for (const rect of rects) {
      expect(rect.width).toBeGreaterThan(0);
      expect(rect.height).toBeGreaterThan(0);
    }
    expect(errors).toEqual([]);
  });
});

function dispatchText(
  canvas: HTMLCanvasElement,
  mode: "auto" | "textarea-proxy",
  text: string,
  offset: number,
): void {
  if (mode === "textarea-proxy") {
    const proxy = document.querySelector<HTMLTextAreaElement>("[data-pingo-input-proxy]");
    if (proxy === null) throw new Error("textarea proxy is unavailable");
    proxy.dispatchEvent(
      new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        data: text,
        inputType: "insertText",
      }),
    );
    return;
  }
  const context = Reflect.get(canvas, "editContext") as BrowserEditContext | undefined;
  if (context === undefined) throw new Error("EditContext is unavailable");
  context.dispatchEvent(
    Object.assign(new Event("textupdate"), {
      selectionEnd: offset + text.length,
      selectionStart: offset + text.length,
      text,
      updateRangeEnd: offset,
      updateRangeStart: offset,
    }),
  );
}

function nativeSurfaceValue(canvas: HTMLCanvasElement, mode: "auto" | "textarea-proxy"): string {
  if (mode === "textarea-proxy") {
    return document.querySelector<HTMLTextAreaElement>("[data-pingo-input-proxy]")?.value ?? "";
  }
  return (Reflect.get(canvas, "editContext") as BrowserEditContext).text;
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  while (!predicate()) await new Promise<void>((resolve) => setTimeout(resolve, 5));
}

function applyTransactionValue(value: string, transaction: EditTransaction): string {
  const delta = transaction.delta;
  return delta === undefined
    ? value
    : value.slice(0, delta.range.start) + delta.text + value.slice(delta.range.end);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let handle: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        handle = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
      }),
    ]);
  } finally {
    if (handle !== undefined) clearTimeout(handle);
  }
}
