import { type Canvas2DContext } from "@dopejs/doper-backend-canvas2d";
import {
  ABI_VERSION,
  ResourceKind,
  encodeMutationBatch,
  type Mutation,
} from "@dopejs/doper-reconciler";
import { describe, expect, it, vi } from "vitest";

import { CanvasFrameSink, type CoreClient, type FrameReport } from "./main-thread.js";

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
        Uint32Array.of(1, 1, 2, 2, 2, 0, 2, 2, 2, 2, 7, 1, 0x89ab_cdef, 0x0123_4567),
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
        pictureHash: 0x0123_4567_89ab_cdefn,
      },
    });
    expect(onFrame.mock.calls[0]?.[0].mutationBytes).toBeGreaterThan(0);
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
    fillRect: (...values: number[]) => calls.push(["fillRect", ...values, state.fillStyle]),
  } as unknown as Canvas2DContext;
}
