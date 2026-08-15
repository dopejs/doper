import {
  createElement,
  createHostedCanvasRoot,
  type FrameReport,
  type HostTransportMode,
  type RenderClockMetrics,
} from "@dopejs/doper";
import { afterEach, describe, expect, it } from "vitest";

describe("M2 production transport matrix", () => {
  const roots: Array<{ close(): Promise<void> }> = [];

  afterEach(async () => {
    for (const root of roots.splice(0).reverse()) await root.close();
    document.body.replaceChildren();
  });

  it("keeps behavior equivalent across main-thread, postMessage, and SAB", async () => {
    expect(crossOriginIsolated).toBe(true);
    const results: Array<{ mode: HostTransportMode; report: FrameReport }> = [];
    for (const mode of ["main-thread", "post-message", "sab"] as const) {
      results.push(await renderMode(mode));
    }

    expect(results.map(({ mode }) => mode)).toEqual(["main-thread", "post-message", "sab"]);
    const reference = results[0]?.report;
    expect(reference?.core).toBeDefined();
    for (const { report } of results.slice(1)) {
      expect(report.commands).toBe(reference?.commands);
      expect(report.core?.pictureHash).toBe(reference?.core?.pictureHash);
      expect(report.core?.displayCommands).toBe(reference?.core?.displayCommands);
      expect(report.core?.sceneNodes).toBe(reference?.core?.sceneNodes);
    }
    expect(results.every(({ report }) => report.rasterCache !== undefined)).toBe(true);
  });

  it("keeps output equivalent when Raster Cache is disabled", async () => {
    const cached = await renderMode("post-message", true);
    const uncached = await renderMode("post-message", false);
    expect(cached.report.rasterCache).toBeDefined();
    expect(cached.report.rasterFrame).toMatchObject({ bypassed: false });
    expect(uncached.report.rasterCache).toBeUndefined();
    expect(uncached.report.commands).toBe(cached.report.commands);
    expect(uncached.report.core?.pictureHash).toBe(cached.report.core?.pictureHash);
    expect(uncached.report.core?.displayCommands).toBe(cached.report.core?.displayCommands);
  });

  it("continues Worker rendering while the main thread is blocked for 200ms", async () => {
    for (const preference of ["post-message", "sab"] as const) {
      const canvas = createCanvas();
      const firstFrame = deferred<FrameReport>();
      const clock = deferred<RenderClockMetrics>();
      const root = await createHostedCanvasRoot(canvas, {
        onClockMetrics: (metrics) => clock.resolve(metrics),
        onFrame: (report) => firstFrame.resolve(report),
        transport: { preference, strict: true },
      });
      roots.push(root);
      root.render(scene());
      await withTimeout(firstFrame.promise, 3_000, `${preference} first frame`);

      busyWait(200);
      const metrics = await withTimeout(clock.promise, 3_000, `${preference} clock metrics`);
      expect(root.mode).toBe(preference);
      expect(metrics.frames).toBeGreaterThanOrEqual(60);
      expect(metrics.selfDrivenFrames).toBeGreaterThan(0);
      expect(metrics.maximumFrameGapMs).toBeLessThan(45);
      await root.close();
      roots.pop();
    }
  });

  it("coalesces a burst above the bounded queue without losing the final scene", async () => {
    const finalSequence = 160;
    for (const preference of ["post-message", "sab"] as const) {
      const canvas = createCanvas();
      const finalFrame = deferred<FrameReport>();
      const hostErrors: Error[] = [];
      const root = await createHostedCanvasRoot(canvas, {
        onFrame: (report) => {
          if (report.core?.frameSeq === finalSequence) finalFrame.resolve(report);
        },
        onHostError: (error) => hostErrors.push(error),
        transport: { preference, strict: true },
      });
      roots.push(root);

      for (let sequence = 1; sequence <= finalSequence; sequence += 1) {
        root.render(scene(120 + (sequence % 17)));
      }

      const report = await withTimeout(
        finalFrame.promise,
        5_000,
        `${preference} burst final frame`,
      );
      expect(report.core?.frameSeq).toBe(finalSequence);
      expect(report.core?.sceneNodes).toBe(3);
      expect(root.failed).toBe(false);
      expect(root.mode).toBe(preference);
      expect(root.transportMetrics()).toMatchObject({ merged: 32, mode: preference, rejected: 0 });
      expect(hostErrors).toEqual([]);
      await root.close();
      roots.pop();
    }
  });
});

async function renderMode(
  preference: "main-thread" | "post-message" | "sab",
  rasterCache = true,
): Promise<{ mode: HostTransportMode; report: FrameReport }> {
  const canvas = createCanvas();
  const frame = deferred<FrameReport>();
  const root = await createHostedCanvasRoot(canvas, {
    onFrame: (report) => frame.resolve(report),
    rasterCache,
    transport: { preference, strict: true },
  });
  root.render(scene());
  const report = await withTimeout(frame.promise, 3_000, `${preference} frame`);
  const mode = root.mode;
  await root.close();
  return { mode, report };
}

function scene(width = 120) {
  return createElement("container", {
    backgroundColor: "#1a73e8",
    height: 48,
    width,
    children: createElement("text", {
      color: "#ffffff",
      fontSize: 16,
      value: "doper M2",
    }),
  });
}

function createCanvas(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.height = 80;
  canvas.width = 160;
  document.body.append(canvas);
  return canvas;
}

function busyWait(durationMs: number): void {
  const end = performance.now() + durationMs;
  while (performance.now() < end) {
    // Intentional deterministic main-thread fault injection.
  }
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: number | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = window.setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
