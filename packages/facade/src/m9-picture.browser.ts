import { afterEach, describe, expect, it } from "vitest";

import {
  Video,
  createElement,
  createHostedCanvasRoot,
  createImage,
  type FrameReport,
  type HostTransportMode,
  type HostedCanvasRoot,
  type ViewHandle,
} from "./index";

const roots: HostedCanvasRoot[] = [];

afterEach(async () => {
  while (roots.length > 0) await roots.pop()?.close();
  document.body.replaceChildren();
});

describe("M9 incremental Picture differential", () => {
  it("is pixel exact with inline after Core-owned scrolling", async () => {
    const optimized = await mount(true);
    const reference = await mount(false);
    const optimizedInitial = await waitForReport(optimized.reports, 0, "optimized initial");
    const referenceInitial = await waitForReport(reference.reports, 0, "inline initial");
    expect(optimizedInitial.core?.pictureDefines).toBeGreaterThan(0);
    expect(referenceInitial.core?.pictureDefines).toBe(0);
    expect(referenceInitial.core?.pictureResidentBytes).toBe(0);

    const optimizedBuilds = optimizedInitial.core?.pictureSubtreeBuilds ?? 0;
    const referenceBuilds = referenceInitial.core?.pictureSubtreeBuilds ?? 0;
    optimized.handle.current?.scrollTo(0, 96);
    reference.handle.current?.scrollTo(0, 96);
    const optimizedScroll = await waitForReport(optimized.reports, 1, "optimized scroll");
    const referenceScroll = await waitForReport(reference.reports, 1, "inline scroll");

    expect(optimizedScroll.mutationBytes).toBe(0);
    expect(referenceScroll.mutationBytes).toBe(0);
    expect(optimizedScroll.core?.layoutVisitedNodes).toBe(0);
    expect(referenceScroll.core?.layoutVisitedNodes).toBe(0);
    expect((optimizedScroll.core?.pictureSubtreeBuilds ?? 0) - optimizedBuilds).toBeLessThanOrEqual(
      2,
    );
    expect((referenceScroll.core?.pictureSubtreeBuilds ?? 0) - referenceBuilds).toBeLessThanOrEqual(
      2,
    );
    expect(optimizedScroll.core?.pictureResourceBytes).toBeGreaterThan(0);
    expect(referenceScroll.core?.pictureResourceBytes).toBe(0);
    expect(optimizedScroll.displayListBytes).toBeLessThan(referenceScroll.displayListBytes);
    expect(snapshot(optimized.context)).toEqual(snapshot(reference.context));
  });

  it("publishes the same Picture lifecycle across all transports", async () => {
    expect(crossOriginIsolated).toBe(true);
    const reports: FrameReport[] = [];
    for (const mode of ["main-thread", "post-message", "sab"] as const) {
      const mounted = await mountTransport(mode);
      const initial = await waitForReport(mounted.reports, 0, `${mode} initial`);
      mounted.handle.current?.scrollTo(0, 96);
      const scroll = await waitForReport(mounted.reports, 1, `${mode} scroll`);
      expect(initial.core?.pictureDefines).toBeGreaterThan(0);
      expect(initial.core?.pictureResidentCount).toBeGreaterThan(0);
      expect(scroll.mutationBytes).toBe(0);
      expect(scroll.core?.layoutVisitedNodes).toBe(0);
      expect(scroll.core?.pictureResourceBytes).toBeGreaterThan(0);
      reports.push(scroll);
    }
    const reference = reports[0];
    for (const report of reports.slice(1)) {
      expect(report.displayListBytes).toBe(reference?.displayListBytes);
      expect(report.core?.displayCommands).toBe(reference?.core?.displayCommands);
      expect(report.core?.pictureResidentCount).toBe(reference?.core?.pictureResidentCount);
      expect(report.core?.pictureResidentBytes).toBe(reference?.core?.pictureResidentBytes);
      expect(report.core?.pictureResourceBytes).toBe(reference?.core?.pictureResourceBytes);
    }
  });
});

async function mount(incrementalPicturesEnabled: boolean): Promise<{
  context: CanvasRenderingContext2D;
  handle: { current: ViewHandle | null };
  reports: FrameReport[];
}> {
  const canvas = document.createElement("canvas");
  canvas.width = 320;
  canvas.height = 240;
  document.body.append(canvas);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (context === null) throw new Error("canvas has no 2d context");
  const reports: FrameReport[] = [];
  const handle = { current: null as ViewHandle | null };
  const root = await createHostedCanvasRoot(canvas, {
    incrementalPicturesEnabled,
    onFrame: (report) => reports.push(report),
    rasterCache: false,
    transport: { preference: "main-thread", strict: true },
  });
  roots.push(root);
  root.render(richScene(handle));
  return { context, handle, reports };
}

async function mountTransport(mode: HostTransportMode): Promise<{
  handle: { current: ViewHandle | null };
  reports: FrameReport[];
}> {
  const canvas = document.createElement("canvas");
  canvas.width = 320;
  canvas.height = 240;
  document.body.append(canvas);
  const reports: FrameReport[] = [];
  const handle = { current: null as ViewHandle | null };
  const root = await createHostedCanvasRoot(canvas, {
    incrementalPicturesEnabled: true,
    onFrame: (report) => reports.push(report),
    rasterCache: false,
    transport: { preference: mode, strict: true },
  });
  roots.push(root);
  root.render(richScene(handle));
  return { handle, reports };
}

function richScene(handle: { current: ViewHandle | null }) {
  const pixels = new Uint8Array([
    255, 64, 64, 255, 64, 255, 64, 255, 64, 64, 255, 255, 255, 220, 64, 255,
  ]);
  const image = createImage(pixels, 2, 2, { label: "M9 image" });
  const poster = createImage(pixels.slice().reverse(), 2, 2, { label: "M9 video poster" });
  const rows = Array.from({ length: 12 }, (_, index) =>
    createElement("container", {
      key: index,
      width: 320,
      height: 48,
      direction: "row",
      gap: 8,
      padding: [4, 8, 4, 8],
      backgroundColor: index % 2 === 0 ? "#142238ff" : "#1c3048ff",
      children: [
        createElement("text", {
          key: "text",
          color: "#ffffffff",
          fontSize: 13,
          value: `M9 rich row ${String(index).padStart(2, "0")}`,
        }),
        createElement("image", { key: "image", source: image, width: 32, height: 32 }),
        Video({
          key: "video",
          src: "data:video/mp4;base64,AAAA",
          poster,
          preload: "none",
          muted: true,
          width: 32,
          height: 32,
        }),
        createElement("container", {
          key: "animated-layer",
          width: 32,
          height: 32,
          opacity: 0.75,
          backgroundColor: "#ffb020ff",
          transition: { durationMs: 120, easing: "linear", property: "opacity" },
        }),
      ],
    }),
  );
  return createElement("scroll", {
    ref: handle,
    width: 320,
    height: 240,
    children: createElement("container", {
      width: 320,
      height: rows.length * 48,
      children: rows,
    }),
  });
}

async function waitForReport(
  reports: readonly FrameReport[],
  index: number,
  label: string,
): Promise<FrameReport> {
  const deadline = performance.now() + 3_000;
  while (reports.length <= index) {
    if (performance.now() >= deadline) throw new Error(`${label} timed out`);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
  const report = reports[index];
  if (report === undefined) throw new Error(`${label} omitted its report`);
  return report;
}

function snapshot(context: CanvasRenderingContext2D): number[] {
  return Array.from(context.getImageData(0, 0, 320, 240).data);
}
