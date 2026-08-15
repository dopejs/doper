import { createElement, createRoot, createWasmCore, type FrameReport } from "@dopejs/doper";
import { afterEach, describe, expect, it } from "vitest";

describe("browser product vertical slice", () => {
  const disposals: Array<() => void> = [];

  afterEach(() => {
    for (const dispose of disposals.splice(0).reverse()) dispose();
    document.body.replaceChildren();
  });

  it("renders TSX data through product WASM into real Canvas2D pixels", async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 160;
    canvas.height = 80;
    document.body.append(canvas);
    const context = canvas.getContext("2d", { alpha: true });
    expect(context).not.toBeNull();
    if (context === null) throw new Error("Chromium did not provide Canvas2D");

    const core = await createWasmCore(canvas.width, canvas.height);
    disposals.push(() => core.free?.());
    const reports: FrameReport[] = [];
    const root = createRoot(context, core, { onFrame: (report) => reports.push(report) });
    disposals.push(() => root.unmount());

    root.render(
      createElement("container", {
        width: 120,
        height: 48,
        backgroundColor: "#1a73e8",
        children: createElement("text", {
          value: "doper",
          color: "#ffffff",
          fontSize: 16,
        }),
      }),
    );

    expect(reports).toHaveLength(1);
    const report = reports[0];
    expect(report).toBeDefined();
    if (report === undefined) throw new Error("Canvas root did not report its committed frame");
    expect(report.commands).toBeGreaterThan(0);
    expect(report.mutationBytes).toBeGreaterThan(0);
    expect(report.displayListBytes).toBeGreaterThan(0);
    expect(report.core?.frameSeq).toBe(1);
    expect(report.core?.sceneNodes).toBe(3);
    expect(report.core?.paintRebuilt).toBe(true);
    expect(typeof report.core?.pictureHash).toBe("bigint");
    expect(report.core?.dirtyLayoutNodes).toBeGreaterThan(0);
    expect(report.core?.layoutVisitedNodes).toBeGreaterThan(0);
    expect(report.core?.displayCommands).toBe(report.commands);

    // Sample outside the system-font fallback glyph bounds so the exact pixel
    // assertion is independent of platform font rasterization.
    const interior = context.getImageData(100, 40, 1, 1).data;
    expect([...interior]).toEqual([26, 115, 232, 255]);
    const exterior = context.getImageData(140, 70, 1, 1).data;
    expect([...exterior]).toEqual([0, 0, 0, 0]);
  });
});
