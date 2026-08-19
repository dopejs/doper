import {
  createElement,
  createHostedCanvasRoot,
  getByRole,
  queryAllByRole,
  TextField,
  type FrameReport,
} from "@dopejs/pingo";
import { afterEach, describe, expect, it } from "vitest";

describe("M4 semantic tree and accessibility mirror", () => {
  const roots: Array<{ close(): Promise<void> }> = [];

  afterEach(async () => {
    for (const root of roots.splice(0).reverse()) await root.close();
    document.body.replaceChildren();
  });

  it("mirrors roles into the DOM, drives semantic selectors, and hides passwords", async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 200;
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
      createElement("container", {
        children: [
          TextField({
            semanticLabel: "Email",
            value: "a@b.c",
            revision: 1n,
          }),
          TextField({
            semanticLabel: "Password",
            password: true,
            value: "hunter2",
            revision: 1n,
          }),
        ],
      }),
    );
    await withTimeout(
      waitUntil(() => queryAllByRole(document.body, "textbox").length === 2),
      3_000,
      "semantic mirror population",
    );
    const email = getByRole(document.body, "textbox", { name: "Email" });
    expect(email.textContent).toBe("a@b.c");
    expect(email.tabIndex).toBe(0);
    const emailBounds = email.getBoundingClientRect();
    expect(emailBounds.width).toBeGreaterThan(0);
    expect(emailBounds.height).toBeGreaterThan(0);

    // Password value must never reach the accessibility DOM.
    const password = getByRole(document.body, "textbox", { name: "Password" });
    expect(password.textContent).toBe("");
    expect(document.body.innerHTML.includes("hunter2")).toBe(false);

    // Keyboard-only activation: focusing the mirrored element focuses the
    // engine editable and native text services.
    email.focus();
    await withTimeout(
      waitUntil(() => {
        const context = Reflect.get(canvas, "editContext") as { text?: string } | undefined;
        return context?.text === "a@b.c";
      }),
      3_000,
      "semantic focus forwarding",
    );
    expect(errors).toEqual([]);
  });

  async function waitUntil(predicate: () => boolean): Promise<void> {
    while (!predicate()) await new Promise<void>((resolve) => setTimeout(resolve, 5));
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
});
