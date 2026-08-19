import { createElement, createHostedCanvasRoot } from "@dopejs/doper";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Focus is observed through the input proxy rather than through engine state:
 * losing focus has to reach the OS text service, and the proxy is what owns it
 * in the fallback mode. Asserting on engine state alone would pass while the
 * keyboard stayed attached to a field the user had clicked away from.
 */
describe("editable blur on a press outside the editor", () => {
  const roots: Array<{ close(): Promise<void> }> = [];

  afterEach(async () => {
    for (const root of roots.splice(0).reverse()) await root.close();
    document.body.replaceChildren();
  });

  const settle = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 120));
  };

  it("ends the session for a press elsewhere on the canvas and off the canvas", async () => {
    const outside = document.createElement("button");
    outside.textContent = "elsewhere";
    document.body.append(outside);
    const canvas = document.createElement("canvas");
    canvas.style.width = "300px";
    canvas.style.height = "200px";
    canvas.width = 300;
    canvas.height = 200;
    document.body.append(canvas);

    const errors: Error[] = [];
    const root = await createHostedCanvasRoot(canvas, {
      nativeTextInputMode: "textarea-proxy",
      onHostError: (error) => errors.push(error),
      transport: { preference: "main-thread" },
    });
    roots.push(root);
    root.render(
      createElement("container", {
        width: 300,
        height: 200,
        backgroundColor: "#ffffffff",
        children: [
          createElement("editableText", { height: 40, revision: 1n, value: "ab", width: 280 }),
          // Empty space below the field: a press here hits no node at all, so
          // Core emits no event transaction and only the host can react.
          createElement("container", { width: 280, height: 120 }),
        ],
      }),
    );
    await settle();

    const proxy = document.querySelector("textarea");
    expect(proxy).not.toBeNull();
    const press = (target: EventTarget, clientX: number, clientY: number): void => {
      target.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, clientX, clientY, pointerId: 1 }),
      );
    };
    const rect = (): DOMRect => canvas.getBoundingClientRect();

    press(canvas, rect().left + 40, rect().top + 20);
    await settle();
    expect(document.activeElement).toBe(proxy);

    press(canvas, rect().left + 140, rect().top + 150);
    await settle();
    expect(document.activeElement).not.toBe(proxy);

    press(canvas, rect().left + 40, rect().top + 20);
    await settle();
    expect(document.activeElement).toBe(proxy);

    press(outside, 0, 0);
    await settle();
    expect(document.activeElement).not.toBe(proxy);

    // A press back inside must still start a new session.
    press(canvas, rect().left + 40, rect().top + 20);
    await settle();
    expect(document.activeElement).toBe(proxy);
    expect(errors.map((error) => error.message)).toEqual([]);
  });
});
