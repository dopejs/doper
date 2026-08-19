import { createElement, createHostedCanvasRoot, type EditTransaction } from "@dopejs/pingo";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Only a real browser has the dictionary. UAX #29, which Core carries, makes
 * every Han ideograph its own word, so this cannot be asserted in Rust alone.
 */
describe("double-click word selection", () => {
  const roots: Array<{ close(): Promise<void> }> = [];

  afterEach(async () => {
    for (const root of roots.splice(0).reverse()) await root.close();
    document.body.replaceChildren();
  });

  it("selects a dictionary word in a script without spaces", async () => {
    expect(typeof Intl.Segmenter).toBe("function");
    const canvas = document.createElement("canvas");
    canvas.style.width = "300px";
    canvas.style.height = "80px";
    canvas.width = 300;
    canvas.height = 80;
    document.body.append(canvas);
    const transactions: EditTransaction[] = [];
    const root = await createHostedCanvasRoot(canvas, {
      onEditTransaction: (transaction) => transactions.push(transaction),
      transport: { preference: "main-thread" },
    });
    roots.push(root);
    root.render(
      createElement("editableText", {
        height: 40,
        revision: 1n,
        // Segments as 今天 | 天气 | 很好, so a working double click selects two.
        value: "今天天气很好",
        width: 280,
      }),
    );
    const settle = async (): Promise<void> => {
      await new Promise((resolve) => setTimeout(resolve, 120));
    };
    await settle();

    const rect = canvas.getBoundingClientRect();
    // Third code point: inside the second dictionary word.
    const point = { clientX: rect.left + 42, clientY: rect.top + 20 };
    for (const kind of ["pointerdown", "pointerup", "pointerdown", "pointerup"] as const) {
      canvas.dispatchEvent(new PointerEvent(kind, { bubbles: true, pointerId: 1, ...point }));
      await settle();
    }
    canvas.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, detail: 2, ...point }));
    await settle();

    const selection = transactions.at(-1)?.selection;
    expect(selection).toBeDefined();
    const width = Math.abs((selection?.focus ?? 0) - (selection?.anchor ?? 0));
    expect(width, `selected ${String(selection?.anchor)}..${String(selection?.focus)}`).toBe(2);
  });

  it("selects on the first double click, before the editor has focus", async () => {
    // The press that focuses an editor round-trips through Core, and the
    // browser reports the double click first. Dropping the gesture made the
    // first double click on an untouched field select nothing at all.
    const canvas = document.createElement("canvas");
    canvas.style.width = "300px";
    canvas.style.height = "80px";
    canvas.width = 300;
    canvas.height = 80;
    document.body.append(canvas);
    const transactions: EditTransaction[] = [];
    // A Worker transport on purpose: on the main thread the focus a press
    // starts is applied synchronously, so the race this covers cannot happen.
    const root = await createHostedCanvasRoot(canvas, {
      onEditTransaction: (transaction) => transactions.push(transaction),
      transport: { preference: "post-message", strict: true },
    });
    roots.push(root);
    root.render(
      createElement("editableText", {
        height: 40,
        revision: 1n,
        value: "今天天气很好",
        width: 280,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 300));

    const rect = canvas.getBoundingClientRect();
    const point = { clientX: rect.left + 42, clientY: rect.top + 20 };
    // No settling between the presses and the double click: the focus this
    // starts has not been acknowledged when the gesture arrives.
    for (const kind of ["pointerdown", "pointerup", "pointerdown", "pointerup"] as const) {
      canvas.dispatchEvent(new PointerEvent(kind, { bubbles: true, pointerId: 1, ...point }));
    }
    canvas.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, detail: 2, ...point }));
    await new Promise((resolve) => setTimeout(resolve, 200));

    const selection = transactions.at(-1)?.selection;
    const width = Math.abs((selection?.focus ?? 0) - (selection?.anchor ?? 0));
    expect(width, `selected ${String(selection?.anchor)}..${String(selection?.focus)}`).toBe(2);
  });
});
