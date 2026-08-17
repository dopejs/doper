import { createElement } from "@dopejs/doper";
import { afterEach, describe, expect, it } from "vitest";

import { mountCompatPage, type CompatFallbackReason, type LegacyRenderer } from "./index";

describe("M5 rollout and rollback drill", () => {
  const pages: Array<{ close(): Promise<void> }> = [];

  afterEach(async () => {
    for (const page of pages.splice(0).reverse()) await page.close();
    document.body.replaceChildren();
  });

  it("switches a live page between doper and the legacy path in both directions", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const reasons: CompatFallbackReason[] = [];
    const legacyNode = document.createElement("p");
    legacyNode.textContent = "legacy orders page";
    const legacy: LegacyRenderer = {
      mount: (target) => target.append(legacyNode),
      unmount: () => legacyNode.remove(),
    };

    // Rollout switch off: the legacy DOM owns the container.
    const page = await mountCompatPage({
      pageId: "orders",
      container,
      canvasWidth: 200,
      canvasHeight: 120,
      render: () =>
        createElement("container", {
          width: 200,
          height: 120,
          backgroundColor: "#2266aaff",
        }),
      legacy,
      enabled: false,
      onFallback: (reason) => reasons.push(reason),
      rootOptions: { transport: { preference: "main-thread", strict: true } },
    });
    pages.push(page);
    expect(page.active).toBe("legacy");
    expect(container.contains(legacyNode)).toBe(true);
    expect(container.querySelector("canvas")).toBeNull();

    // Flip the switch: doper renders real frames and legacy DOM leaves.
    expect(await page.enable()).toBe("doper");
    const canvas = container.querySelector("canvas");
    expect(canvas).not.toBeNull();
    expect(container.contains(legacyNode)).toBe(false);

    // Operator rollback restores the legacy DOM and removes the canvas.
    page.fallback("incident drill");
    expect(page.active).toBe("legacy");
    expect(reasons.at(-1)).toEqual({ kind: "manual", detail: "incident drill" });
    expect(container.contains(legacyNode)).toBe(true);
    expect(container.querySelector("canvas")).toBeNull();

    // The page can be re-enabled after the incident is resolved.
    expect(await page.enable()).toBe("doper");
    expect(container.querySelector("canvas")).not.toBeNull();
  });

  it("falls back automatically when doper initialization fails", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const reasons: CompatFallbackReason[] = [];
    const legacyNode = document.createElement("p");
    const legacy: LegacyRenderer = {
      mount: (target) => target.append(legacyNode),
      unmount: () => legacyNode.remove(),
    };
    const page = await mountCompatPage({
      pageId: "orders",
      container,
      render: () => undefined,
      legacy,
      onFallback: (reason) => reasons.push(reason),
      rootFactory: () => Promise.reject(new Error("injected initialization fault")),
    });
    pages.push(page);
    expect(page.active).toBe("legacy");
    expect(container.contains(legacyNode)).toBe(true);
    expect(reasons[0]).toMatchObject({
      kind: "initialization-failed",
      error: { message: "injected initialization fault" },
    });
  });
});
