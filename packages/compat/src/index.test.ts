import { describe, expect, it } from "vitest";

import { mountCompatPage, type CompatFallbackReason, type LegacyRenderer } from "./index";

interface FakeRootHooks {
  onHostError: ((error: Error) => void) | undefined;
}

function harness(behavior: { failInit?: boolean } = {}) {
  const events: string[] = [];
  const reasons: CompatFallbackReason[] = [];
  const hooks: FakeRootHooks = { onHostError: undefined };
  const canvas = {
    width: 0,
    height: 0,
    removed: false,
    remove() {
      events.push("canvas-removed");
    },
  };
  const container = {
    clientWidth: 320,
    clientHeight: 160,
    ownerDocument: {
      createElement: () => canvas,
    },
    append: () => events.push("canvas-appended"),
  } as unknown as HTMLElement;
  const legacy: LegacyRenderer = {
    mount: () => events.push("legacy-mount"),
    unmount: () => events.push("legacy-unmount"),
  };
  const rootFactory = (
    _canvas: HTMLCanvasElement,
    options: { onHostError?: (error: Error) => void },
  ) => {
    if (behavior.failInit === true) return Promise.reject(new Error("no canvas context"));
    hooks.onHostError = options.onHostError;
    events.push("root-created");
    return Promise.resolve({
      render: () => events.push("render"),
      close: () => {
        events.push("root-closed");
        return Promise.resolve();
      },
    } as never);
  };
  return { events, reasons, hooks, container, legacy, rootFactory };
}

describe("mountCompatPage", () => {
  it("keeps the legacy renderer when the rollout switch is off", async () => {
    const { events, reasons, container, legacy, rootFactory } = harness();
    const page = await mountCompatPage({
      pageId: "orders",
      container,
      render: () => undefined,
      legacy,
      enabled: false,
      onFallback: (reason) => reasons.push(reason),
      rootFactory: rootFactory,
    });
    expect(page.active).toBe("legacy");
    expect(events).toEqual(["legacy-mount"]);
    expect(reasons).toEqual([{ kind: "disabled" }]);

    // The switch can be flipped on later without re-mounting the page.
    expect(await page.enable()).toBe("doper");
    expect(events.slice(1)).toEqual([
      "root-created",
      "render",
      "legacy-unmount",
      "canvas-appended",
    ]);
    await page.close();
  });

  it("falls back to legacy when doper initialization fails", async () => {
    const { reasons, container, legacy, rootFactory } = harness({ failInit: true });
    const page = await mountCompatPage({
      pageId: "orders",
      container,
      render: () => undefined,
      legacy,
      onFallback: (reason) => reasons.push(reason),
      rootFactory: rootFactory,
    });
    expect(page.active).toBe("legacy");
    expect(reasons[0]).toMatchObject({
      kind: "initialization-failed",
      error: { message: "no canvas context" },
    });
    await page.close();
  });

  it("auto-falls-back after repeated runtime errors and supports manual return", async () => {
    const { events, reasons, hooks, container, legacy, rootFactory } = harness();
    const page = await mountCompatPage({
      pageId: "orders",
      container,
      render: () => undefined,
      legacy,
      maxRuntimeErrors: 2,
      onFallback: (reason) => reasons.push(reason),
      rootFactory: rootFactory,
    });
    expect(page.active).toBe("doper");
    hooks.onHostError?.(new Error("frame stall"));
    expect(page.active).toBe("doper");
    hooks.onHostError?.(new Error("frame stall"));
    expect(page.active).toBe("legacy");
    expect(reasons[0]).toMatchObject({ kind: "runtime-error" });
    expect(events).toContain("legacy-mount");

    // Manual fallback after re-enable reports the operator detail.
    await page.enable();
    page.fallback("operator rollback");
    expect(reasons.at(-1)).toEqual({ kind: "manual", detail: "operator rollback" });
    await page.close();
    await expect(page.enable()).rejects.toThrow(/closed/u);
  });
});
