import {
  RasterTileCache,
  type Canvas2DContext,
  type ReplayStats,
} from "@dopejs/doper-backend-canvas2d";
import {
  ABI_VERSION,
  ResourceKind,
  encodeMutationBatch,
  type Mutation,
} from "@dopejs/doper-reconciler";
import { describe, expect, it, vi } from "vitest";

import { CanvasFrameSink, type CoreClient, type FrameReport } from "./main-thread";

const DISPLAY_LIST_MAGIC = 0x4450_4f44;
const STREAM_HEADER_BYTES = 16;
const FILL_RECT_OPCODE = 16;

describe("CanvasFrameSink", () => {
  it("commits Core, applies resources, replays, and reports one frame in order", () => {
    const events: string[] = [];
    const calls: unknown[][] = [];
    const displayList = fillRectDisplayList(7);
    const core: CoreClient = {
      commit: () => {
        events.push("core");
        return displayList;
      },
      frame_diagnostics: () =>
        Uint32Array.of(2, 1, 2, 2, 2, 0, 2, 2, 2, 2, 7, 1, 1, 0, 2, 0, 0, 0x89ab_cdef, 0x0123_4567),
    };
    const onFrame = vi.fn((_report: FrameReport) => events.push("report"));
    const sink = new CanvasFrameSink(fakeContext(calls, events), core, onFrame);

    sink.commit(
      mutationFrame([
        {
          type: "defineResource",
          resourceId: 7,
          kind: ResourceKind.Paint,
          bytes: solidPaint(),
        },
      ]),
    );

    expect(events).toEqual(["core", "canvas", "canvas", "report"]);
    expect(calls).toContainEqual(["fillRect", 1, 2, 30, 40, "#123456ff"]);
    expect(onFrame.mock.calls[0]?.[0]).toMatchObject({
      commands: 1,
      pictures: 0,
      maximumPictureDepth: 0,
      displayListBytes: displayList.byteLength,
      core: {
        frameSeq: 1,
        sceneNodes: 2,
        dirtyLayoutNodes: 2,
        dirtyPaintNodes: 2,
        dirtyPaintSelfNodes: 0,
        dirtyHitNodes: 2,
        dirtySemanticsNodes: 2,
        layoutChangedNodes: 2,
        layoutVisitedNodes: 2,
        displayCommands: 7,
        paintRebuilt: true,
        pictureBuilds: 1,
        pictureCacheHits: 0,
        pictureSubtreeBuilds: 2,
        pictureSubtreeCacheHits: 0,
        overInvalidatedFrames: 0,
        pictureHash: 0x0123_4567_89ab_cdefn,
      },
    });
    expect(onFrame.mock.calls[0]?.[0].mutationBytes).toBeGreaterThan(0);
    const canvasCalls = calls.length;
    expect(sink.replayLastFrame()).toMatchObject({ commands: 1 });
    expect(calls.length).toBeGreaterThan(canvasCalls);
  });

  it("does not mutate host resources when Core rejects the transaction", () => {
    let reject = true;
    const core: CoreClient = {
      commit: () => {
        if (reject) throw new Error("Core rejected frame");
        return emptyDisplayList();
      },
    };
    const sink = new CanvasFrameSink(fakeContext([], []), core);
    const define = mutationFrame([
      {
        type: "defineResource",
        resourceId: 1,
        kind: ResourceKind.Paint,
        bytes: solidPaint(),
      },
    ]);

    expect(() => sink.commit(define)).toThrow(/Core rejected/u);
    reject = false;
    expect(() => sink.commit(define)).not.toThrow();
  });

  it("preflights malformed and invalid resource lifecycles before Core", () => {
    const commit = vi.fn(() => emptyDisplayList());
    const sink = new CanvasFrameSink(fakeContext([], []), { commit });

    expect(() => sink.commit(Uint8Array.of(1, 2, 3, 4))).toThrow();
    expect(commit).not.toHaveBeenCalled();
    expect(() => sink.commit(mutationFrame([{ type: "releaseResource", resourceId: 99 }]))).toThrow(
      /not defined/u,
    );
    expect(commit).not.toHaveBeenCalled();
  });

  it("rejects incompatible Core diagnostics before mutating backend resources", () => {
    const core: CoreClient = {
      commit: () => emptyDisplayList(),
      frame_diagnostics: () => Uint32Array.of(99),
    };
    const sink = new CanvasFrameSink(fakeContext([], []), core, vi.fn());
    const define = mutationFrame([
      {
        type: "defineResource",
        resourceId: 1,
        kind: ResourceKind.Paint,
        bytes: solidPaint(),
      },
    ]);

    expect(() => sink.commit(define)).toThrow(/diagnostics/u);
  });

  it("removes released resources only after an accepted frame", () => {
    const sink = new CanvasFrameSink(fakeContext([], []), {
      commit: () => emptyDisplayList(),
    });
    sink.commit(
      mutationFrame([
        {
          type: "defineResource",
          resourceId: 1,
          kind: ResourceKind.Paint,
          bytes: solidPaint(),
        },
      ]),
    );
    sink.commit(mutationFrame([{ type: "releaseResource", resourceId: 1 }]));
    expect(() => sink.commit(mutationFrame([{ type: "releaseResource", resourceId: 1 }]))).toThrow(
      /not defined/u,
    );
  });

  it("reuses bounded raster tiles for an immutable picture and exposes metrics", () => {
    const targetCalls: unknown[][] = [];
    const onFrame = vi.fn();
    const cache = new RasterTileCache<ReplayStats>({
      budgetBytes: 64 * 64 * 4,
      surfaceFactory: () => ({
        context: fakeContext([], []),
        image: {} as CanvasImageSource,
      }),
      tileSize: 64,
    });
    const sink = new CanvasFrameSink(
      fakeContext(targetCalls, []),
      {
        commit: () => emptyDisplayList(),
        frame_diagnostics: () =>
          Uint32Array.of(2, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0x1234_5678, 0),
      },
      onFrame,
      cache,
    );

    sink.commit(mutationFrame([]));
    expect(onFrame.mock.calls[0]?.[0]).toMatchObject({
      rasterCache: { bytes: 64 * 64 * 4, entries: 1, hits: 0, misses: 1 },
      rasterFrame: { bypassed: false, hits: 0, misses: 1 },
    });
    expect(sink.replayLastFrame()).toMatchObject({ commands: 0 });
    expect(sink.rasterCacheMetrics()).toMatchObject({ entries: 1, hits: 1, misses: 1 });
    expect(targetCalls.filter(([operation]) => operation === "drawImage")).toHaveLength(2);
  });

  it("routes input and animation frames without requiring a Shell mutation", () => {
    const reports: FrameReport[] = [];
    let animationChanged = false;
    const core: CoreClient = {
      commit: () => emptyDisplayList(),
      input: () => emptyDisplayList(),
      advance: () => (animationChanged ? emptyDisplayList() : undefined),
      frame_diagnostics: () =>
        Uint32Array.of(2, 1, 0, 0, 1, 0, 1, 0, 0, 0, 0, 1, 2, 0, 0, 0, 0, 0x1234, 0),
    };
    const sink = new CanvasFrameSink(fakeContext([], []), core, (report) => reports.push(report));
    sink.commit(mutationFrame([]));
    expect(sink.input(Uint8Array.of(1, 2, 3, 4))).toMatchObject({ commands: 0 });
    expect(sink.advance(1 / 60)).toMatchObject({ commands: 0 });
    animationChanged = true;
    expect(sink.advance(1 / 60)).toMatchObject({ commands: 0 });

    expect(reports.map(({ cause }) => cause)).toEqual(["mutation", "input", "animation"]);
    expect(reports[1]).toMatchObject({ inputBytes: 4, mutationBytes: 0 });
    expect(reports[2]).toMatchObject({ animationDeltaMs: 1000 / 60, mutationBytes: 0 });
    expect(() => sink.advance(Number.NaN)).toThrow(/elapsedSeconds/u);
  });

  it("drains and validates versioned virtual refill ranges after Core frames", () => {
    const refills = vi.fn();
    let first = true;
    const sink = new CanvasFrameSink(
      fakeContext([], []),
      {
        commit: () => emptyDisplayList(),
        take_virtual_refills: () => {
          if (!first) return Uint32Array.of(1, 0);
          first = false;
          return Uint32Array.of(1, 1, 0x0010_0001, 4, 8);
        },
      },
      undefined,
      undefined,
      refills,
    );
    sink.commit(mutationFrame([]));
    sink.commit(mutationFrame([]));
    expect(refills).toHaveBeenCalledOnce();
    expect(refills).toHaveBeenCalledWith([{ nodeId: 0x0010_0001, start: 4, end: 8 }]);

    const malformed = new CanvasFrameSink(fakeContext([], []), {
      commit: () => emptyDisplayList(),
      take_virtual_refills: () => Uint32Array.of(1, 1),
    });
    expect(() => malformed.commit(mutationFrame([]))).toThrow(/request count/u);
  });
});

function mutationFrame(mutations: readonly Mutation[]): Uint8Array {
  return encodeMutationBatch({ frameSeq: 1, mutations });
}

function solidPaint(): Uint8Array {
  return Uint8Array.of(1, 1, 0, 0, 0x12, 0x34, 0x56, 0xff);
}

function emptyDisplayList(): Uint8Array {
  return displayList([]);
}

function fillRectDisplayList(paintId: number): Uint8Array {
  const command = new Uint8Array(24);
  const view = new DataView(command.buffer);
  command[0] = FILL_RECT_OPCODE;
  view.setFloat32(4, 1, true);
  view.setFloat32(8, 2, true);
  view.setFloat32(12, 30, true);
  view.setFloat32(16, 40, true);
  view.setUint32(20, paintId, true);
  return displayList([command]);
}

function displayList(commands: readonly Uint8Array[]): Uint8Array {
  const length = STREAM_HEADER_BYTES + commands.reduce((sum, command) => sum + command.length, 0);
  const bytes = new Uint8Array(length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, DISPLAY_LIST_MAGIC, true);
  view.setUint16(4, ABI_VERSION, true);
  view.setUint16(6, STREAM_HEADER_BYTES, true);
  view.setUint32(8, length, true);
  view.setUint32(12, commands.length, true);
  let offset = STREAM_HEADER_BYTES;
  for (const command of commands) {
    bytes.set(command, offset);
    offset += command.byteLength;
  }
  return bytes;
}

function fakeContext(calls: unknown[][], events: string[]): Canvas2DContext {
  const state = { fillStyle: "", globalAlpha: 1 };
  return {
    canvas: { height: 64, width: 64 },
    clearRect: (...values: number[]) => calls.push(["clearRect", ...values]),
    drawImage: (...values: unknown[]) => calls.push(["drawImage", ...values]),
    get fillStyle() {
      return state.fillStyle;
    },
    set fillStyle(value: string | CanvasGradient | CanvasPattern) {
      state.fillStyle = typeof value === "string" ? value : "[canvas-style]";
    },
    get globalAlpha() {
      return state.globalAlpha;
    },
    set globalAlpha(value: number) {
      state.globalAlpha = value;
    },
    save: () => {
      events.push("canvas");
      calls.push(["save"]);
    },
    restore: () => {
      events.push("canvas");
      calls.push(["restore"]);
    },
    resetTransform: () => calls.push(["resetTransform"]),
    fillRect: (...values: number[]) => calls.push(["fillRect", ...values, state.fillStyle]),
    translate: (...values: number[]) => calls.push(["translate", ...values]),
  } as unknown as Canvas2DContext;
}
