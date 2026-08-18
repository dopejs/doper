import {
  RasterTileCache,
  type Canvas2DContext,
  type ReplayStats,
} from "@dopejs/doper-backend-canvas2d";
import {
  ABI_VERSION,
  NodeKind,
  ResourceKind,
  encodeMutationBatch,
  type Mutation,
} from "@dopejs/doper-reconciler";
import { describe, expect, it, vi } from "vitest";

import { CanvasFrameSink, parseSemantics, type CoreClient, type FrameReport } from "./main-thread";
import {
  EDIT_TRANSACTIONS_MAGIC,
  EVENT_TRANSACTIONS_MAGIC,
  FRAME_DIAGNOSTICS_VERSION,
  FRAME_DIAGNOSTICS_WORDS,
} from "./generated";
import { decodeSystemTextMetricBatch } from "./system-text-metrics";

const DISPLAY_LIST_MAGIC = 0x4450_4f44;
const STREAM_HEADER_BYTES = 16;
const FILL_RECT_OPCODE = 16;

/**
 * Builds a diagnostics payload of the generated length.
 *
 * Writing the words out by hand meant every new diagnostic field broke these
 * fakes with a decode error that said nothing about the change that caused it.
 */
function diagnostics(...values: readonly number[]): Uint32Array {
  const words = new Uint32Array(FRAME_DIAGNOSTICS_WORDS);
  words.set(values.slice(0, FRAME_DIAGNOSTICS_WORDS));
  words[0] = FRAME_DIAGNOSTICS_VERSION;
  return words;
}

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
        diagnostics(3, 1, 2, 2, 2, 0, 2, 2, 2, 2, 7, 1, 1, 0, 2, 0, 0, 0x89ab_cdef, 0x0123_4567, 0),
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

  it("scales replay by the device pixel ratio so logical units stay CSS pixels", () => {
    const calls: unknown[][] = [];
    const sink = new CanvasFrameSink(fakeContext(calls, []), {
      commit: () => fillRectDisplayList(7),
    });
    sink.commit(
      mutationFrame([
        { type: "defineResource", resourceId: 7, kind: ResourceKind.Paint, bytes: solidPaint() },
      ]),
    );
    // At ratio 1 the replay must not push a transform at all.
    expect(calls.filter(([operation]) => operation === "scale")).toHaveLength(0);
    expect(calls).toContainEqual(["fillRect", 1, 2, 30, 40, "#123456ff"]);

    calls.length = 0;
    sink.setDevicePixelRatio(2);
    sink.commit(mutationFrame([]));
    // The rect keeps its logical coordinates; the context carries the scale.
    expect(calls).toContainEqual(["scale", 2, 2]);
    expect(calls).toContainEqual(["fillRect", 1, 2, 30, 40, "#123456ff"]);
    const scaleIndex = calls.findIndex(([operation]) => operation === "scale");
    const restoreIndex = calls.findIndex(([operation]) => operation === "restore");
    expect(scaleIndex).toBeGreaterThan(-1);
    expect(restoreIndex).toBeGreaterThan(scaleIndex);
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
          diagnostics(3, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0x1234_5678, 0, 0),
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
        diagnostics(3, 1, 0, 0, 1, 0, 1, 0, 0, 0, 0, 1, 2, 0, 0, 0, 0, 0x1234, 0, 0),
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

  it("drains validated edit transactions even when selection input does not repaint", () => {
    const onEditTransaction = vi.fn();
    const sink = new CanvasFrameSink(
      fakeContext([], []),
      {
        commit: () => emptyDisplayList(),
        input: () => undefined,
        take_edit_transactions: () => selectionTransactionStream(),
      },
      undefined,
      undefined,
      undefined,
      undefined,
      onEditTransaction,
    );

    expect(sink.input(Uint8Array.of(1, 2, 3, 4))).toBeNull();
    expect(onEditTransaction).toHaveBeenCalledWith({
      nodeId: 7,
      baseRevision: 0n,
      revision: 1n,
      selection: {
        anchor: 1,
        anchorAffinity: "downstream",
        focus: 1,
        focusAffinity: "downstream",
      },
      kind: "edit",
    });
  });

  it("drains and validates hit-tested event paths before returning from input", () => {
    const onEventTransaction = vi.fn();
    const sink = new CanvasFrameSink(
      fakeContext([], []),
      {
        commit: () => emptyDisplayList(),
        input: () => undefined,
        take_event_transactions: () => eventTransactionStream(),
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      onEventTransaction,
    );

    expect(sink.input(Uint8Array.of(1, 2, 3, 4))).toBeNull();
    expect(onEventTransaction).toHaveBeenCalledWith({
      eventId: 9,
      kind: "click",
      target: 3,
      x: 12,
      y: 20,
      deltaX: 0,
      deltaY: 0,
      buttons: 0,
      modifiers: 1,
      pointerId: 0,
      elapsedMicros: 16_667,
      path: [1, 2, 3],
    });
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

  it("validates synchronous non-passive regions before publishing them", () => {
    const regions = vi.fn();
    const bits = (value: number): number => {
      const scratch = new DataView(new ArrayBuffer(4));
      scratch.setFloat32(0, value, true);
      return scratch.getUint32(0, true);
    };
    const sink = new CanvasFrameSink(
      fakeContext([], []),
      {
        commit: () => emptyDisplayList(),
        non_passive_regions: () => Uint32Array.of(1, 1, 1, bits(1), bits(2), bits(30), bits(40)),
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      regions,
    );
    sink.commit(mutationFrame([]));
    expect(regions).toHaveBeenCalledWith([{ flags: 1, left: 1, top: 2, right: 30, bottom: 40 }]);

    const malformed = new CanvasFrameSink(fakeContext([], []), {
      commit: () => emptyDisplayList(),
      non_passive_regions: () => Uint32Array.of(1, 1),
    });
    expect(() => malformed.commit(mutationFrame([]))).toThrow(/count/u);
  });

  it("validates and publishes active editing geometry for the IME loop", () => {
    const geometry = vi.fn();
    const bits = (value: number): number => {
      const scratch = new DataView(new ArrayBuffer(4));
      scratch.setFloat32(0, value, true);
      return scratch.getUint32(0, true);
    };
    const words = Uint32Array.of(
      1,
      17,
      2,
      3,
      1,
      bits(5),
      bits(6),
      bits(100),
      bits(20),
      bits(7),
      bits(8),
      bits(9),
      bits(10),
      2,
      3,
      bits(11),
      bits(12),
      bits(13),
      bits(14),
    );
    const sink = new CanvasFrameSink(
      fakeContext([], []),
      { commit: () => emptyDisplayList(), editing_geometry: () => words },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      geometry,
    );
    sink.commit(mutationFrame([]));
    expect(geometry).toHaveBeenCalledWith({
      nodeId: 17,
      selectionStart: 2,
      selectionEnd: 3,
      controlBounds: { left: 5, top: 6, width: 100, height: 20 },
      selectionBounds: { left: 7, top: 8, width: 9, height: 10 },
      characterBounds: [{ start: 2, end: 3, rect: { left: 11, top: 12, width: 13, height: 14 } }],
    });

    const idle = vi.fn();
    const idleSink = new CanvasFrameSink(
      fakeContext([], []),
      {
        commit: () => emptyDisplayList(),
        editing_geometry: () => Uint32Array.of(1, 0xffff_ffff, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0),
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      idle,
    );
    idleSink.commit(mutationFrame([]));
    expect(idle).not.toHaveBeenCalled();

    const malformed = new CanvasFrameSink(
      fakeContext([], []),
      { commit: () => emptyDisplayList(), editing_geometry: () => Uint32Array.of(1, 17, 2) },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      vi.fn(),
    );
    expect(() => malformed.commit(mutationFrame([]))).toThrow(/layout/u);
  });

  it("parses semantic snapshots strictly and fails closed on hostile bytes", () => {
    const encoder = new TextEncoder();
    const role = encoder.encode("textbox");
    const label = encoder.encode("Email");
    const value = encoder.encode("a@b.c");
    const stringBytes = role.length + label.length + value.length;
    const padded = stringBytes + ((4 - (stringBytes % 4)) % 4);
    const bytes = new Uint8Array(8 + 36 + padded);
    const view = new DataView(bytes.buffer);
    const bits = (input: number): number => {
      const scratch = new DataView(new ArrayBuffer(4));
      scratch.setFloat32(0, input, true);
      return scratch.getUint32(0, true);
    };
    const words = [1, 1, 17, 0b011, bits(4), bits(6), bits(120), bits(30), 7, 5, 5];
    words.forEach((word, index) => {
      view.setUint32(index * 4, word, true);
    });
    bytes.set(role, 44);
    bytes.set(label, 44 + role.length);
    bytes.set(value, 44 + role.length + label.length);
    expect(parseSemantics(bytes)).toEqual([
      {
        nodeId: 17,
        focusable: true,
        focused: true,
        password: false,
        role: "textbox",
        label: "Email",
        value: "a@b.c",
        bounds: { left: 4, top: 6, width: 120, height: 30 },
      },
    ]);

    const reserved = bytes.slice();
    new DataView(reserved.buffer).setUint32(3 * 4, 0xff, true);
    expect(() => parseSemantics(reserved)).toThrow(/reserved/u);
    const truncated = bytes.slice(0, 20);
    expect(() => parseSemantics(truncated)).toThrow(/truncated/u);
    const overflow = bytes.slice();
    new DataView(overflow.buffer).setUint32(8 * 4, 0xffff, true);
    expect(() => parseSemantics(overflow)).toThrow(/overflow|truncated/u);
    let state = 0x8badf00d;
    for (let sample = 0; sample < 500; sample += 1) {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      const hostile = new Uint8Array((state % 32) * 4);
      for (let index = 0; index < hostile.length; index += 1) {
        state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
        hostile[index] = state & 0xff;
      }
      try {
        parseSemantics(hostile);
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
      }
    }
  });

  it("upserts and releases browser text metrics with exact pair reference lifetimes", () => {
    const commit = vi.fn((_mutations: Uint8Array, _metrics?: Uint8Array) => emptyDisplayList());
    const sink = new CanvasFrameSink(fakeContext([], []), { commit });
    const firstTextNode = 0x0010_0001;
    const secondTextNode = 0x0010_0002;
    sink.commit(
      mutationFrame([
        {
          type: "createNode",
          nodeId: firstTextNode,
          kind: NodeKind.Text,
          parent: 0,
          beforeSibling: 0,
        },
        {
          type: "createNode",
          nodeId: secondTextNode,
          kind: NodeKind.Text,
          parent: 0,
          beforeSibling: 0,
        },
        {
          type: "defineResource",
          resourceId: 1,
          kind: ResourceKind.Paint,
          bytes: solidPaint(),
        },
        {
          type: "defineResource",
          resourceId: 2,
          kind: ResourceKind.Utf8String,
          bytes: new TextEncoder().encode("abcd\nxy"),
        },
        {
          type: "defineResource",
          resourceId: 3,
          kind: ResourceKind.TextStyle,
          bytes: textStyle(1, 16, 20, 400, "Inter"),
        },
        { type: "setTextRun", nodeId: firstTextNode, stringId: 2, styleId: 3 },
        { type: "setTextRun", nodeId: secondTextNode, stringId: 2, styleId: 3 },
      ]),
    );

    const initialMetrics = commit.mock.calls[0]?.[1];
    expect(initialMetrics).toBeInstanceOf(Uint8Array);
    if (initialMetrics === undefined) throw new Error("initial metric batch is missing");
    expect(decodeSystemTextMetricBatch(initialMetrics)).toEqual([
      {
        type: "upsert",
        metric: { stringId: 2, styleId: 3, maxLineWidth: 40, lineCount: 2 },
      },
    ]);

    sink.commit(mutationFrame([{ type: "removeNode", nodeId: firstTextNode }]));
    expect(commit.mock.calls[1]?.[1]).toBeUndefined();

    sink.commit(mutationFrame([{ type: "removeNode", nodeId: secondTextNode }]));
    const releasedMetrics = commit.mock.calls[2]?.[1];
    if (releasedMetrics === undefined) throw new Error("release metric batch is missing");
    expect(decodeSystemTextMetricBatch(releasedMetrics)).toEqual([
      { type: "release", stringId: 2, styleId: 3 },
    ]);
  });

  it("refreshes every active pair through the Core metric-only entry point", () => {
    const setSystemTextMetrics = vi.fn((_metrics: Uint8Array) => emptyDisplayList());
    const sink = new CanvasFrameSink(fakeContext([], []), {
      commit: () => emptyDisplayList(),
      set_system_text_metrics: setSystemTextMetrics,
    });
    const textNode = 0x0010_0001;
    sink.commit(
      mutationFrame([
        { type: "createNode", nodeId: textNode, kind: NodeKind.Text, parent: 0, beforeSibling: 0 },
        {
          type: "defineResource",
          resourceId: 1,
          kind: ResourceKind.Paint,
          bytes: solidPaint(),
        },
        {
          type: "defineResource",
          resourceId: 2,
          kind: ResourceKind.Utf8String,
          bytes: new TextEncoder().encode("font"),
        },
        {
          type: "defineResource",
          resourceId: 3,
          kind: ResourceKind.TextStyle,
          bytes: textStyle(1, 16, 20, 400, "Inter"),
        },
        { type: "setTextRun", nodeId: textNode, stringId: 2, styleId: 3 },
      ]),
    );

    expect(sink.refreshSystemTextMetrics()).toMatchObject({ commands: 0 });
    expect(setSystemTextMetrics).toHaveBeenCalledOnce();
    const refreshedMetrics = setSystemTextMetrics.mock.calls[0]?.[0];
    if (refreshedMetrics === undefined) throw new Error("refreshed metric batch is missing");
    expect(decodeSystemTextMetricBatch(refreshedMetrics)).toEqual([
      {
        type: "upsert",
        metric: { stringId: 2, styleId: 3, maxLineWidth: 40, lineCount: 1 },
      },
    ]);
  });
});

function mutationFrame(mutations: readonly Mutation[]): Uint8Array {
  return encodeMutationBatch({ frameSeq: 1, mutations });
}

function solidPaint(): Uint8Array {
  return Uint8Array.of(1, 1, 0, 0, 0x12, 0x34, 0x56, 0xff);
}

function textStyle(
  paintId: number,
  fontSize: number,
  lineHeight: number,
  weight: number,
  family: string,
): Uint8Array {
  const encodedFamily = new TextEncoder().encode(family);
  const bytes = new Uint8Array((24 + encodedFamily.length + 3) & ~3);
  const view = new DataView(bytes.buffer);
  bytes[0] = 1;
  bytes[1] = 1;
  view.setUint32(4, paintId, true);
  view.setFloat32(8, fontSize, true);
  view.setFloat32(12, lineHeight, true);
  view.setUint16(16, weight, true);
  view.setUint32(20, encodedFamily.length, true);
  bytes.set(encodedFamily, 24);
  return bytes;
}

function emptyDisplayList(): Uint8Array {
  return displayList([]);
}

function selectionTransactionStream(): Uint8Array {
  const bytes = new Uint8Array(72);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, EDIT_TRANSACTIONS_MAGIC, true);
  view.setUint16(4, ABI_VERSION, true);
  view.setUint16(6, STREAM_HEADER_BYTES, true);
  view.setUint32(8, bytes.byteLength, true);
  view.setUint32(12, 1, true);
  bytes[16] = 1;
  view.setUint32(20, 7, true);
  view.setUint32(32, 1, true);
  view.setUint32(48, 1, true);
  view.setUint32(52, 1, true);
  bytes[64] = 1;
  bytes[66] = 1;
  bytes[67] = 1;
  return bytes;
}

function eventTransactionStream(): Uint8Array {
  const bytes = new Uint8Array(80);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, EVENT_TRANSACTIONS_MAGIC, true);
  view.setUint16(4, ABI_VERSION, true);
  view.setUint16(6, STREAM_HEADER_BYTES, true);
  view.setUint32(8, bytes.byteLength, true);
  view.setUint32(12, 1, true);
  bytes[16] = 1;
  view.setUint32(20, 9, true);
  view.setUint16(24, 5, true);
  view.setUint32(28, 3, true);
  view.setFloat32(32, 12, true);
  view.setFloat32(36, 20, true);
  view.setUint32(52, 1, true);
  view.setUint32(60, 16_667, true);
  view.setUint32(64, 3, true);
  view.setUint32(68, 1, true);
  view.setUint32(72, 2, true);
  view.setUint32(76, 3, true);
  return bytes;
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
  const state = { fillStyle: "", font: "", globalAlpha: 1 };
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
    get font() {
      return state.font;
    },
    set font(value: string) {
      state.font = value;
    },
    measureText: (text: string) => ({ width: text.length * 10 }) as TextMetrics,
    scale: (...values: number[]) => calls.push(["scale", ...values]),
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
