import { Button, createHostedCanvasRoot, getByRole } from "@dopejs/pingo";
import { afterEach, describe, expect, it } from "vitest";

describe("M8 foundation controls", () => {
  const roots: Array<{ close(): Promise<void> }> = [];

  afterEach(async () => {
    for (const root of roots.splice(0).reverse()) await root.close();
    document.body.replaceChildren();
  });

  it("uses native focus/keyboard defaults without a Core control node kind", async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 160;
    canvas.height = 60;
    document.body.append(canvas);
    let presses = 0;
    const root = await createHostedCanvasRoot(canvas, {
      transport: { preference: "main-thread", strict: true },
    });
    roots.push(root);
    root.render(
      Button({ children: "Save", onPress: () => (presses += 1), width: 100, height: 40 }),
    );
    await waitUntil(
      () => document.querySelector('[data-pingo-semantics] [role="button"]') !== null,
    );
    const button = getByRole(document, "button", { name: "Save" });
    button.focus();
    button.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" }),
    );
    button.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: " " }),
    );
    button.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, cancelable: true, key: " " }));
    expect(presses).toBe(2);

    root.render(Button({ children: "Save", disabled: true, onPress: () => (presses += 1) }));
    await waitUntil(
      () =>
        getByRole(document, "button", { name: "Save" }).getAttribute("aria-disabled") === "true",
    );
    const disabled = getByRole(document, "button", { name: "Save" });
    expect(disabled.tabIndex).toBe(-1);
    disabled.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
    expect(presses).toBe(2);
  });
});

async function waitUntil(condition: () => boolean): Promise<void> {
  const deadline = performance.now() + 3_000;
  while (!condition()) {
    if (performance.now() > deadline) throw new Error("timed out waiting for semantic control");
    await new Promise<void>((resolve) => setTimeout(resolve, 16));
  }
}
