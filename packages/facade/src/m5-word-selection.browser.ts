import { createElement, createHostedCanvasRoot, type EditTransaction } from "@dopejs/doper";
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
});
