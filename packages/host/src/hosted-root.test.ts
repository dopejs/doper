import { ABI_VERSION, decodeMutationBatch } from "@dopejs/pingo-reconciler";
import {
  decodeInputBatch,
  encodeInputBatch,
  EVENT_FLAG_PRECISE_WHEEL,
  KEY_FLAG_REPEAT,
} from "@dopejs/pingo-editing";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createHostedCanvasRoot } from "./hosted-root";
import {
  KEYBOARD_CODES_BY_NAME,
  KEYBOARD_KEY_NAMES_BY_NAME,
  VIRTUAL_REFILL_VERSION,
} from "./generated";
import type { CoreClient } from "./main-thread";
import { SabMutationRing } from "./sab-ring";

const DISPLAY_LIST_MAGIC = 0x4450_4f44;

afterEach(() => vi.unstubAllGlobals());

describe("createHostedCanvasRoot", () => {
  it("uses the deterministic main-thread path when Worker policy is disabled", async () => {
    installCanvasGlobal();
    const canvas = new FakeCanvas();
    const core = fakeCore();
    const onModeChange = vi.fn();
    const root = await createHostedCanvasRoot(canvas as unknown as HTMLCanvasElement, {
      capabilities: allCapabilities(),
      coreFactory: () => Promise.resolve(core),
      onModeChange,
      transport: { pageWorkerEnabled: false },
    });
    expect(root.mode).toBe("main-thread");
    root.render(undefined);
    expect(core.commits).toHaveLength(1);
    await root.close();
    expect(core.commits).toHaveLength(2);
    expect(core.freed).toBe(true);
    expect(onModeChange).toHaveBeenCalledWith("main-thread", expect.any(Object));
  });

  it("keeps the newest observed geometry and refuses a frame that arrives late", async () => {
    installCanvasGlobal();
    const canvas = new FakeCanvas();
    const core = fakeCore();
    // frameSeq is driven by the fixture, so out-of-order delivery is
    // reproducible instead of depending on transport timing.
    let frameSeq = 10;
    let width = 100;
    core.layout_geometry = (): Uint32Array => {
      const bits = (input: number): number => {
        const scratch = new DataView(new ArrayBuffer(4));
        scratch.setFloat32(0, input, true);
        return scratch.getUint32(0, true);
      };
      return Uint32Array.of(
        1,
        frameSeq,
        1,
        7,
        0,
        bits(0),
        bits(0),
        bits(width),
        bits(20),
        ...[bits(0), bits(0), bits(Number.POSITIVE_INFINITY), bits(Number.POSITIVE_INFINITY)],
      );
    };
    const root = await createHostedCanvasRoot(canvas as unknown as HTMLCanvasElement, {
      capabilities: allCapabilities(),
      coreFactory: () => Promise.resolve(core),
      transport: { pageWorkerEnabled: false },
    });

    // Each render changes the tree, because an unchanged one produces no
    // mutations and therefore no frame to carry geometry.
    root.render(editableElement(10));
    expect(root.layoutGeometry(7)?.bounds.width).toBe(100);
    expect(root.staleLayoutGeometryFrames()).toBe(0);

    // Newer frame: adopted.
    frameSeq = 11;
    width = 140;
    root.render(editableElement(11));
    expect(root.layoutGeometry(7)?.bounds.width).toBe(140);

    // Older frame reaching the Shell after a newer one would move the overlay
    // back to where it used to be. It must be dropped, not applied.
    frameSeq = 10;
    width = 100;
    root.render(editableElement(12));
    expect(root.layoutGeometry(7)?.bounds.width).toBe(140);
    expect(root.staleLayoutGeometryFrames()).toBe(1);

    // A node that stops being observed disappears rather than going stale.
    frameSeq = 12;
    core.layout_geometry = (): Uint32Array => Uint32Array.of(1, frameSeq, 0);
    root.render(editableElement(13));
    expect(root.layoutGeometry(7)).toBeUndefined();

    await root.close();
  });

  it("tracks live prefers-reduced-motion changes and detaches on close", async () => {
    installCanvasGlobal();
    let changeListener: ((event: MediaQueryListEvent) => void) | undefined;
    const removeEventListener = vi.fn(
      (_type: string, listener: (event: MediaQueryListEvent) => void) => {
        if (changeListener === listener) changeListener = undefined;
      },
    );
    vi.stubGlobal("matchMedia", () => ({
      addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
        changeListener = listener;
      },
      matches: true,
      media: "(prefers-reduced-motion: reduce)",
      onchange: null,
      removeEventListener,
    }));
    const core = fakeCore();
    const root = await createHostedCanvasRoot(new FakeCanvas() as unknown as HTMLCanvasElement, {
      capabilities: allCapabilities(),
      coreFactory: () => Promise.resolve(core),
      reducedMotion: "auto",
      transport: { pageWorkerEnabled: false },
    });
    expect(core.reducedMotion).toEqual([true]);
    root.setReducedMotion(false);
    expect(core.reducedMotion).toEqual([true, false]);
    changeListener?.({ matches: true } as MediaQueryListEvent);
    expect(core.reducedMotion).toEqual([true, false, true]);
    await root.close();
    expect(removeEventListener).toHaveBeenCalledOnce();
    expect(changeListener).toBeUndefined();
  });

  it("propagates explicit reduced-motion changes over the active Worker protocol", async () => {
    installCanvasGlobal();
    const worker = readyWorker();
    const root = await createHostedCanvasRoot(new FakeCanvas() as unknown as HTMLCanvasElement, {
      capabilities: { ...allCapabilities(), crossOriginIsolated: false },
      clockAnchorDriver: null,
      reducedMotion: false,
      workerFactory: () => worker as unknown as Worker,
    });
    root.setReducedMotion(true);
    expect(worker.posts.at(-1)).toMatchObject({
      kind: "pingo:reduced-motion",
      reduced: true,
    });
    await root.close();
  });

  it("encodes high-level scroll samples with monotonic Input Stream sequences", async () => {
    installCanvasGlobal();
    const core = fakeCore();
    const root = await createHostedCanvasRoot(new FakeCanvas() as unknown as HTMLCanvasElement, {
      capabilities: allCapabilities(),
      coreFactory: () => Promise.resolve(core),
      transport: { pageWorkerEnabled: false },
    });
    root.beginScroll({ nodeId: 0x0010_0001 });
    root.scrollBy({ nodeId: 0x0010_0001 }, -2.5, 30, 16.667);
    root.endScroll(0x0010_0001);
    root.setScrollVelocity(0x0010_0001, 0, 216);

    expect(core.inputs.map((bytes) => decodeInputBatch(bytes))).toEqual([
      { frameSeq: 1, commands: [{ type: "scrollBegin", nodeId: 0x0010_0001 }] },
      {
        frameSeq: 2,
        commands: [
          {
            type: "scrollDelta",
            nodeId: 0x0010_0001,
            deltaX: -2.5,
            deltaY: 30,
            elapsedMicros: 16_667,
          },
        ],
      },
      { frameSeq: 3, commands: [{ type: "scrollEnd", nodeId: 0x0010_0001 }] },
      {
        frameSeq: 4,
        commands: [
          {
            type: "setScrollVelocity",
            nodeId: 0x0010_0001,
            velocityX: 0,
            velocityY: 216,
          },
        ],
      },
    ]);
    expect(() => root.scrollBy(0x0010_0001, 0, 1, 0)).toThrow(/elapsedMs/u);
    await root.close();
  });

  it("does not re-enter Shell style resolution on the scroll hot path", async () => {
    installCanvasGlobal();
    const root = await createHostedCanvasRoot(new FakeCanvas() as unknown as HTMLCanvasElement, {
      capabilities: allCapabilities(),
      coreFactory: () => Promise.resolve(fakeCore()),
      transport: { pageWorkerEnabled: false },
    });
    root.render(hostElement("text", { style: { color: "#123456" }, value: "label" }));
    const before = root.styleMetrics();
    expect(before.resolutions).toBeGreaterThan(0);
    root.beginScroll(0x0010_0001);
    root.scrollBy(0x0010_0001, 0, 10, 16.667);
    root.endScroll(0x0010_0001);
    expect(root.styleMetrics()).toEqual(before);
    await root.close();
  });

  it("converts passive canvas pointer input into isolated logical event commands", async () => {
    installCanvasGlobal();
    const core = fakeCore();
    const canvas = new FakeCanvas();
    const root = await createHostedCanvasRoot(canvas as unknown as HTMLCanvasElement, {
      capabilities: allCapabilities(),
      coreFactory: () => Promise.resolve(core),
      transport: { pageWorkerEnabled: false },
    });

    canvas.emit("pointerdown", {
      type: "pointerdown",
      clientX: 30,
      clientY: 25,
      buttons: 1,
      pointerId: 7,
      pointerType: "mouse",
      isPrimary: true,
      pressure: 0.5,
      tiltX: 4,
      tiltY: -2,
      width: 1,
      height: 1,
      shiftKey: true,
      ctrlKey: false,
      altKey: true,
      metaKey: false,
    });
    expect(decodeInputBatch(core.inputs[0] ?? new Uint8Array())).toEqual({
      frameSeq: 1,
      commands: [
        {
          type: "dispatchEvent",
          eventId: 1,
          kind: "pointerdown",
          flags: 0,
          x: 40,
          y: 20,
          deltaX: 0,
          deltaY: 0,
          buttons: 1,
          modifiers: 5,
          pointerId: 7,
          elapsedMicros: 16_667,
          pointerType: "mouse",
          isPrimary: true,
          pressure: 0.5,
          tiltX: 4,
          tiltY: -2,
          width: 1,
          height: 1,
        },
      ],
    });
    await root.close();
    canvas.emit("pointerdown", {
      type: "pointerdown",
      clientX: 30,
      clientY: 25,
      buttons: 1,
      shiftKey: false,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
    });
    expect(core.inputs).toHaveLength(1);
  });

  it("normalizes an unspecified pointer type before encoding browser input", async () => {
    installCanvasGlobal();
    const core = fakeCore();
    const canvas = new FakeCanvas();
    const root = await createHostedCanvasRoot(canvas as unknown as HTMLCanvasElement, {
      capabilities: allCapabilities(),
      coreFactory: () => Promise.resolve(core),
      transport: { pageWorkerEnabled: false },
    });

    canvas.emit("pointerdown", {
      type: "pointerdown",
      clientX: 30,
      clientY: 25,
      buttons: 1,
      pointerId: 1,
      pointerType: "",
      isPrimary: false,
      shiftKey: false,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
    });

    const input = decodeInputBatch(core.inputs[0] ?? new Uint8Array());
    expect(input.commands).toHaveLength(1);
    expect(input.commands[0]).toMatchObject({
      type: "dispatchEvent",
      kind: "pointerdown",
      pointerId: 1,
      pointerType: "mouse",
    });
    await root.close();
  });

  it("interns key identifiers and makes the canvas focusable so keys arrive", async () => {
    installCanvasGlobal();
    const core = fakeCore();
    const canvas = new FakeCanvas();
    const root = await createHostedCanvasRoot(canvas as unknown as HTMLCanvasElement, {
      capabilities: allCapabilities(),
      coreFactory: () => Promise.resolve(core),
      transport: { pageWorkerEnabled: false },
    });

    // A canvas that is not focusable never receives a key event at all.
    expect(canvas.tabIndex).toBe(0);

    canvas.emit("keydown", {
      type: "keydown",
      key: "ArrowDown",
      code: "ArrowDown",
      repeat: true,
      shiftKey: false,
      ctrlKey: true,
      altKey: false,
      metaKey: false,
    });
    canvas.emit("keyup", {
      type: "keyup",
      key: "a",
      code: "KeyA",
      repeat: false,
      shiftKey: false,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
    });

    const commands = core.inputs.flatMap((bytes) => decodeInputBatch(bytes).commands);
    expect(commands).toHaveLength(2);
    expect(commands[0]).toMatchObject({
      type: "dispatchKeyEvent",
      kind: "keydown",
      keyName: KEYBOARD_KEY_NAMES_BY_NAME.get("ArrowDown"),
      keyCode: KEYBOARD_CODES_BY_NAME.get("ArrowDown"),
      keyText: 0,
      flags: KEY_FLAG_REPEAT,
      modifiers: 2,
    });
    // A printable key travels as its code point, not as a name.
    expect(commands[1]).toMatchObject({
      type: "dispatchKeyEvent",
      kind: "keyup",
      keyName: 0,
      keyCode: KEYBOARD_CODES_BY_NAME.get("KeyA"),
      keyText: 0x61,
      flags: 0,
    });
    await root.close();
  });

  it("reports a composing key as Process rather than assembling text from it", async () => {
    installCanvasGlobal();
    const core = fakeCore();
    const canvas = new FakeCanvas();
    const root = await createHostedCanvasRoot(canvas as unknown as HTMLCanvasElement, {
      capabilities: allCapabilities(),
      coreFactory: () => Promise.resolve(core),
      transport: { pageWorkerEnabled: false },
    });

    canvas.emit("keydown", {
      type: "keydown",
      key: "a",
      code: "KeyA",
      isComposing: true,
      repeat: false,
      shiftKey: false,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
    });

    const [command] = decodeInputBatch(core.inputs[0] ?? new Uint8Array()).commands;
    expect(command).toMatchObject({
      type: "dispatchKeyEvent",
      keyName: KEYBOARD_KEY_NAMES_BY_NAME.get("Process"),
      keyText: 0,
    });
    await root.close();
  });

  it("applies the Core-resolved cursor before dispatching Shell event handlers", async () => {
    installCanvasGlobal();
    const core = fakeCore();
    let pending = true;
    core.take_event_transactions = () => {
      if (!pending) return new Uint8Array();
      pending = false;
      return pointerEventTransaction("pointer");
    };
    const canvas = new FakeCanvas();
    const root = await createHostedCanvasRoot(canvas as unknown as HTMLCanvasElement, {
      capabilities: allCapabilities(),
      coreFactory: () => Promise.resolve(core),
      transport: { pageWorkerEnabled: false },
    });

    canvas.emit("pointermove", {
      type: "pointermove",
      clientX: 30,
      clientY: 25,
      buttons: 0,
      pointerId: 7,
      pointerType: "mouse",
      isPrimary: true,
    });

    expect(canvas.style.cursor).toBe("pointer");
    await root.close();
  });

  it.each(["post-message", "sab"] as const)(
    "applies the same Core event transaction on the %s Worker transport",
    async (preference) => {
      installCanvasGlobal();
      const worker = readyWorker();
      const canvas = new FakeCanvas();
      const observed = vi.fn();
      const root = await createHostedCanvasRoot(canvas as unknown as HTMLCanvasElement, {
        capabilities: allCapabilities(),
        clockAnchorDriver: null,
        onEventTransaction: observed,
        transport: { preference, strict: true },
        workerFactory: () => worker as unknown as Worker,
      });
      const activation = worker.posts.find((message) => hasKind(message, "pingo:activate"));
      worker.emitMessage({
        kind: "pingo:event-transaction",
        sessionId: sessionOf(activation),
        transaction: {
          eventId: 1,
          kind: "pointermove",
          target: 2,
          x: 1,
          y: 2,
          deltaX: 0,
          deltaY: 0,
          buttons: 0,
          modifiers: 0,
          pointerId: 7,
          elapsedMicros: 16_667,
          relatedTarget: null,
          cursor: "pointer",
          pointerType: "mouse",
          isPrimary: true,
          pressure: 0,
          tiltX: 0,
          tiltY: 0,
          width: 1,
          height: 1,
          path: [1, 2],
        },
      });
      expect(canvas.style.cursor).toBe("pointer");
      expect(observed).toHaveBeenCalledOnce();
      await root.close();
    },
  );

  it.each(["post-message", "sab"] as const)(
    "keeps key event order intact on the %s Worker transport",
    async (preference) => {
      installCanvasGlobal();
      const worker = readyWorker();
      const canvas = new FakeCanvas();
      const root = await createHostedCanvasRoot(canvas as unknown as HTMLCanvasElement, {
        capabilities: allCapabilities(),
        clockAnchorDriver: null,
        transport: { preference, strict: true },
        workerFactory: () => worker as unknown as Worker,
      });

      const modifiers = {
        shiftKey: false,
        ctrlKey: false,
        altKey: false,
        metaKey: false,
        repeat: false,
      };
      canvas.emit("keydown", { type: "keydown", key: "a", code: "KeyA", ...modifiers });
      canvas.emit("keyup", { type: "keyup", key: "a", code: "KeyA", ...modifiers });

      expect(workerKeyEvents(worker)).toEqual(["keydown", "keyup"]);
      await root.close();
    },
  );

  it("keeps key event order intact on the main-thread transport", async () => {
    installCanvasGlobal();
    const core = fakeCore();
    const canvas = new FakeCanvas();
    const root = await createHostedCanvasRoot(canvas as unknown as HTMLCanvasElement, {
      capabilities: allCapabilities(),
      coreFactory: () => Promise.resolve(core),
      transport: { pageWorkerEnabled: false },
    });

    const modifiers = {
      shiftKey: false,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      repeat: false,
    };
    canvas.emit("keydown", { type: "keydown", key: "a", code: "KeyA", ...modifiers });
    canvas.emit("keyup", { type: "keyup", key: "a", code: "KeyA", ...modifiers });

    expect(
      core.inputs
        .flatMap((bytes) => decodeInputBatch(bytes).commands)
        .filter((command) => command.type === "dispatchKeyEvent")
        .map((command) => command.kind),
    ).toEqual(["keydown", "keyup"]);
    await root.close();
  });

  it("hands touch gestures to Core instead of letting the browser pan the page", async () => {
    // A non-passive listener and preventDefault are not enough on a touch
    // screen: the browser decides at pointerdown whether the compositor pans,
    // and consults only touch-action for it. Without this a drag scrolled the
    // page and the list never moved.
    installCanvasGlobal();
    const core = fakeCore();
    core.non_passive_regions = () =>
      Uint32Array.of(1, 1, 2, floatBits(0), floatBits(0), floatBits(160), floatBits(80));
    const canvas = new FakeCanvas();
    const root = await createHostedCanvasRoot(canvas as unknown as HTMLCanvasElement, {
      capabilities: allCapabilities(),
      coreFactory: () => Promise.resolve(core),
      transport: { pageWorkerEnabled: false },
    });
    root.render(undefined);
    expect(canvas.style.touchAction).toBe("none");
    await root.close();
    // Released with the listeners: a canvas the engine no longer drives must
    // not keep the page's own gestures suppressed.
    expect(canvas.style.touchAction).toBe("");
  });

  it("reflows the canvas when it changes size", async () => {
    // A missed resize does not fail loudly: the last frame is simply stretched
    // to the new box, or clipped by it. Both halves have to move -- the backing
    // store in device pixels and Core's viewport in logical ones.
    installCanvasGlobal();
    const core = fakeCore() as FakeCore & {
      set_viewport?: (width: number, height: number) => Uint8Array | undefined;
      viewports: Array<readonly [number, number]>;
    };
    core.viewports = [];
    core.set_viewport = (width, height) => {
      core.viewports.push([width, height]);
      return undefined;
    };
    const canvas = new FakeCanvas();
    const root = await createHostedCanvasRoot(canvas as unknown as HTMLCanvasElement, {
      capabilities: allCapabilities(),
      coreFactory: () => Promise.resolve(core),
      transport: { pageWorkerEnabled: false },
    });
    root.render(undefined);

    root.resize(320, 200);
    expect(core.viewports).toEqual([[320, 200]]);
    expect([canvas.width, canvas.height]).toEqual([320, 200]);
    expect(() => root.resize(0, 200)).toThrow(/positive/u);
    await root.close();
  });

  it("accepts a fractional device pixel ratio", async () => {
    // A phone reports ratios like 2.75, so the logical size -- the backing
    // store divided by that ratio -- almost never lands on an integer.
    // Requiring one rejected every such device at startup.
    installCanvasGlobal();
    const globals = globalThis as { devicePixelRatio?: number };
    const previous = globals.devicePixelRatio;
    globals.devicePixelRatio = 2.75;
    try {
      const canvas = new FakeCanvas();
      canvas.width = Math.round(393 * 2.75);
      canvas.height = Math.round(852 * 2.75);
      const root = await createHostedCanvasRoot(canvas as unknown as HTMLCanvasElement, {
        capabilities: allCapabilities(),
        coreFactory: () => Promise.resolve(fakeCore()),
        transport: { pageWorkerEnabled: false },
      });
      root.render(undefined);
      await root.close();
    } finally {
      if (previous === undefined) delete globals.devicePixelRatio;
      else globals.devicePixelRatio = previous;
    }
  });

  it("prevents wheel defaults synchronously only inside Core-published regions", async () => {
    installCanvasGlobal();
    const core = fakeCore();
    core.non_passive_regions = () =>
      Uint32Array.of(1, 1, 1, floatBits(20), floatBits(10), floatBits(80), floatBits(60));
    const canvas = new FakeCanvas();
    const root = await createHostedCanvasRoot(canvas as unknown as HTMLCanvasElement, {
      capabilities: allCapabilities(),
      coreFactory: () => Promise.resolve(core),
      transport: { pageWorkerEnabled: false },
    });
    root.render(undefined);
    const preventDefault = vi.fn();
    canvas.emit("wheel", {
      type: "wheel",
      clientX: 30,
      clientY: 25,
      buttons: 0,
      shiftKey: false,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      cancelable: true,
      preventDefault,
      deltaMode: 0,
      deltaX: 0,
      deltaY: 12,
      timeStamp: 10,
    });
    expect(preventDefault).toHaveBeenCalledOnce();
    await root.close();
  });

  it("classifies wheel gestures so Core animates notches but not trackpad deltas", async () => {
    installCanvasGlobal();
    const core = fakeCore();
    const canvas = new FakeCanvas();
    const root = await createHostedCanvasRoot(canvas as unknown as HTMLCanvasElement, {
      capabilities: allCapabilities(),
      coreFactory: () => Promise.resolve(core),
      transport: { pageWorkerEnabled: false },
    });
    root.render(undefined);
    const wheel = (timeStamp: number, deltaY: number, wheelDeltaY?: number): void => {
      canvas.emit("wheel", {
        type: "wheel",
        clientX: 30,
        clientY: 25,
        buttons: 0,
        shiftKey: false,
        ctrlKey: false,
        altKey: false,
        metaKey: false,
        cancelable: false,
        deltaMode: 0,
        deltaX: 0,
        deltaY,
        timeStamp,
        ...(wheelDeltaY === undefined ? {} : { wheelDeltaY }),
      });
    };
    const flags = (): readonly number[] =>
      core.inputs
        .flatMap((bytes) => decodeInputBatch(bytes).commands)
        .filter((command) => command.type === "dispatchEvent" && command.kind === "wheel")
        .map((command) => (command as { readonly flags: number }).flags);

    // A classic notched wheel: multiple-of-120 legacy delta, far apart in time.
    wheel(1_000, 100, -120);
    wheel(1_400, 100, -120);
    expect(flags()).toEqual([0, 0]);

    // A trackpad: fractional legacy delta, then a continuous stream. The
    // gesture stays high-precision once any sample shows a trackpad trait.
    core.inputs.length = 0;
    wheel(2_000, 12, -36);
    wheel(2_016, 40, -120);
    expect(flags()).toEqual([EVENT_FLAG_PRECISE_WHEEL, EVENT_FLAG_PRECISE_WHEEL]);

    // An unknown platform without the legacy field applies one-to-one.
    core.inputs.length = 0;
    wheel(9_000, 100);
    expect(flags()).toEqual([EVENT_FLAG_PRECISE_WHEEL]);
    await root.close();
  });

  it("materializes Core-requested virtual windows without an application callback", async () => {
    installCanvasGlobal();
    const core = fakeCore() as FakeCore & { take_virtual_refills(): Uint32Array };
    const renderItem = vi.fn((index: number) => hostElement("text", { value: `item ${index}` }));
    const onVirtualRefills = vi.fn();
    let emitted = false;
    core.take_virtual_refills = () => {
      if (emitted || core.commits.length === 0) return new Uint32Array([VIRTUAL_REFILL_VERSION, 0]);
      const configuration = decodeMutationBatch(core.commits[0] ?? new Uint8Array()).mutations.find(
        (mutation) => mutation.type === "configureVirtualList",
      );
      if (configuration === undefined) return new Uint32Array([VIRTUAL_REFILL_VERSION, 0]);
      emitted = true;
      return new Uint32Array([VIRTUAL_REFILL_VERSION, 1, configuration.nodeId, 0, 3]);
    };
    const root = await createHostedCanvasRoot(new FakeCanvas() as unknown as HTMLCanvasElement, {
      capabilities: allCapabilities(),
      coreFactory: () => Promise.resolve(core),
      onVirtualRefills,
      transport: { pageWorkerEnabled: false },
    });

    root.render(
      hostElement("virtualList", {
        height: 80,
        itemCount: 1_000_000,
        estimatedItemHeight: 20,
        renderItem,
      }),
    );
    expect(renderItem).not.toHaveBeenCalled();
    await Promise.resolve();

    expect(renderItem.mock.calls.map(([index]) => index)).toEqual([0, 1, 2]);
    expect(core.commits).toHaveLength(2);
    expect(
      decodeMutationBatch(core.commits[1] ?? new Uint8Array())
        .mutations.filter((mutation) => mutation.type === "setVirtualItem")
        .map((mutation) => mutation.itemIndex),
    ).toEqual([0, 1, 2]);
    expect(onVirtualRefills).toHaveBeenCalledWith([expect.objectContaining({ start: 0, end: 3 })]);
    await root.close();
  });

  it("renders only the newest virtual window when Core asks several times a frame", async () => {
    // Regression: each refill message was rendered in its own microtask, so a
    // gesture made the Shell rebuild the whole window once per message, every
    // rebuild one stride behind the last. The commits queued up and Core kept
    // being handed windows the offset had already left, which left the viewport
    // on skeletons long after it had stopped moving.
    installCanvasGlobal();
    const frames: Array<() => void> = [];
    const globals = globalThis as {
      requestAnimationFrame?: unknown;
      cancelAnimationFrame?: unknown;
    };
    const previousRequest = globals.requestAnimationFrame;
    const previousCancel = globals.cancelAnimationFrame;
    globals.requestAnimationFrame = (callback: () => void): number => frames.push(callback);
    globals.cancelAnimationFrame = (): void => {};
    try {
      const core = fakeCore() as FakeCore & { take_virtual_refills(): Uint32Array };
      const renderItem = vi.fn((index: number) => hostElement("text", { value: `item ${index}` }));
      let listNode: number | undefined;
      const windows: Array<[number, number]> = [
        [0, 3],
        [10, 13],
        [20, 23],
      ];
      core.take_virtual_refills = () => {
        if (core.commits.length === 0) return new Uint32Array([VIRTUAL_REFILL_VERSION, 0]);
        listNode ??= decodeMutationBatch(core.commits[0] ?? new Uint8Array()).mutations.find(
          (mutation) => mutation.type === "configureVirtualList",
        )?.nodeId;
        const next = windows.shift();
        if (listNode === undefined || next === undefined)
          return new Uint32Array([VIRTUAL_REFILL_VERSION, 0]);
        return new Uint32Array([VIRTUAL_REFILL_VERSION, 1, listNode, next[0], next[1]]);
      };
      const root = await createHostedCanvasRoot(new FakeCanvas() as unknown as HTMLCanvasElement, {
        capabilities: allCapabilities(),
        coreFactory: () => Promise.resolve(core),
        transport: { pageWorkerEnabled: false },
      });

      const list = (height: number) =>
        hostElement("virtualList", {
          height,
          itemCount: 1_000_000,
          estimatedItemHeight: 20,
          renderItem,
        });
      // Three windows arrive before the frame runs; the first two are dead.
      root.render(list(80));
      root.render(list(81));
      root.render(list(82));
      await Promise.resolve();
      expect(renderItem).not.toHaveBeenCalled();

      for (const frame of frames.splice(0, frames.length)) frame();
      expect(renderItem.mock.calls.map(([index]) => index)).toEqual([20, 21, 22]);
      await root.close();
    } finally {
      globals.requestAnimationFrame = previousRequest;
      globals.cancelAnimationFrame = previousCancel;
    }
  });

  it("routes scroll input to the active Worker without a mutation round trip", async () => {
    installCanvasGlobal();
    const worker = readyWorker();
    const root = await createHostedCanvasRoot(new FakeCanvas() as unknown as HTMLCanvasElement, {
      capabilities: { ...allCapabilities(), crossOriginIsolated: false },
      clockAnchorDriver: null,
      workerFactory: () => worker as unknown as Worker,
    });
    root.beginScroll(0x0010_0001);
    const message = worker.posts.findLast((candidate) => hasKind(candidate, "pingo:input"));
    expect(message).toMatchObject({ kind: "pingo:input" });
    expect(decodeInputBatch((message as { bytes: Uint8Array }).bytes)).toEqual({
      frameSeq: 1,
      commands: [{ type: "scrollBegin", nodeId: 0x0010_0001 }],
    });
    await root.close();
  });

  it("publishes scroll input through the dedicated SAB ring and exposes pressure metrics", async () => {
    installCanvasGlobal();
    const worker = readyWorker();
    const root = await createHostedCanvasRoot(new FakeCanvas() as unknown as HTMLCanvasElement, {
      capabilities: allCapabilities(),
      clockAnchorDriver: null,
      transport: { preference: "sab", strict: true },
      workerFactory: () => worker as unknown as Worker,
    });
    const activation = worker.posts.find((candidate) => hasKind(candidate, "pingo:activate")) as {
      inputRingBuffer: SharedArrayBuffer;
    };
    const inputRing = SabMutationRing.attach(activation.inputRingBuffer);

    root.beginScroll(0x0010_0001);

    expect(worker.posts.some((candidate) => hasKind(candidate, "pingo:input"))).toBe(false);
    expect(worker.posts.some((candidate) => hasKind(candidate, "pingo:input-wake"))).toBe(true);
    const frame = inputRing.take();
    expect(frame?.frameSeq).toBe(1);
    expect(decodeInputBatch(frame?.bytes ?? new Uint8Array())).toEqual({
      frameSeq: 1,
      commands: [{ type: "scrollBegin", nodeId: 0x0010_0001 }],
    });
    expect(root.inputTransportMetrics()).toMatchObject({
      directFrames: 0,
      mode: "sab",
      ring: { consumed: 1, published: 1 },
      sabFallbackFrames: 0,
    });
    await root.close();
  });

  it("orders a wake before the bounded SAB input fallback", async () => {
    installCanvasGlobal();
    const worker = readyWorker();
    const root = await createHostedCanvasRoot(new FakeCanvas() as unknown as HTMLCanvasElement, {
      capabilities: allCapabilities(),
      clockAnchorDriver: null,
      transport: { preference: "sab", strict: true },
      workerFactory: () => worker as unknown as Worker,
    });
    const oversized = encodeInputBatch({
      frameSeq: 1,
      commands: Array.from({ length: 600 }, () => ({
        type: "scrollBegin" as const,
        nodeId: 0x0010_0001,
      })),
    });
    expect(oversized.byteLength).toBeGreaterThan(4 * 1024);

    root.dispatchInput(oversized);

    const wakeIndex = worker.posts.findIndex((candidate) => hasKind(candidate, "pingo:input-wake"));
    const directIndex = worker.posts.findIndex((candidate) => hasKind(candidate, "pingo:input"));
    expect(wakeIndex).toBeGreaterThanOrEqual(0);
    expect(directIndex).toBeGreaterThan(wakeIndex);
    expect(root.inputTransportMetrics()).toMatchObject({
      directFrames: 1,
      mode: "sab",
      sabFallbackFrames: 1,
    });
    await root.close();
  });

  it("holds a double click until its editor reports geometry", async () => {
    // The press that focuses an editor round-trips through Core, and with a
    // Worker transport that has not landed when the browser reports the double
    // click. Dropping the gesture made the first double click on an untouched
    // field select nothing at all.
    installCanvasGlobal();
    const canvas = new FakeCanvas();
    const core = fakeCore();
    const node = 0x0010_0001;
    // The null node id is Core's "no editor" frame, which the host discards.
    const geometry = { current: editingGeometry(0) };
    core.editing_geometry = () => geometry.current;
    const root = await createHostedCanvasRoot(canvas as unknown as HTMLCanvasElement, {
      capabilities: allCapabilities(),
      coreFactory: () => Promise.resolve(core),
      transport: { pageWorkerEnabled: false },
    });
    root.render(editableElement());
    const nodeId = decodeMutationBatch(core.commits.at(-1) ?? new Uint8Array()).mutations.find(
      (mutation) => mutation.type === "configureEditable",
    )?.nodeId;
    expect(nodeId).toBeDefined();

    const wordCommands = (): number =>
      core.inputs.filter((bytes) =>
        decodeInputBatch(bytes).commands.some(
          (command) => command.type === "placeCaret" && command.word,
        ),
      ).length;

    // Inside the canvas, before any editor is active.
    canvas.emit("dblclick", { clientX: 30, clientY: 25, detail: 2 });
    expect(wordCommands(), "nothing to address the gesture to yet").toBe(0);

    geometry.current = editingGeometry(nodeId ?? node);
    root.focusEditable(nodeId ?? node);
    // Focus activates the bridge after the frame that carried this geometry, so
    // the gesture flushes on the next one -- in production the caret placement
    // that follows the press.
    root.render(editableElement(81));
    expect(wordCommands(), "the held gesture is applied once geometry arrives").toBe(1);

    // A later geometry frame must not replay it.
    root.render(editableElement(82));
    expect(wordCommands()).toBe(1);
    await root.close();
  });

  it("falls back before canvas transfer when Worker preparation fails", async () => {
    installCanvasGlobal();
    const canvas = new FakeCanvas();
    const worker = new FakeWorker();
    worker.onPost = (message) => {
      if (hasKind(message, "pingo:prepare")) {
        worker.emitMessage({
          error: "WASM unavailable",
          kind: "pingo:fatal",
          sessionId: sessionOf(message),
        });
      }
    };
    const onHostError = vi.fn();
    const root = await createHostedCanvasRoot(canvas as unknown as HTMLCanvasElement, {
      capabilities: allCapabilities(),
      clockAnchorDriver: null,
      coreFactory: () => Promise.resolve(fakeCore()),
      onHostError,
      workerFactory: () => worker as unknown as Worker,
    });
    expect(root.mode).toBe("main-thread");
    expect(canvas.transferCount).toBe(0);
    expect(worker.terminated).toBe(true);
    expect((onHostError.mock.calls[0]?.[0] as Error | undefined)?.message).toMatch(
      /WASM unavailable/u,
    );
    await root.close();
  });

  it("replaces a transferred canvas and rebuilds current Scene after Worker crash", async () => {
    installCanvasGlobal();
    const canvas = new FakeCanvas();
    const worker = readyWorker();
    const fallbackCore = fakeCore();
    const modes: string[] = [];
    const root = await createHostedCanvasRoot(canvas as unknown as HTMLCanvasElement, {
      capabilities: { ...allCapabilities(), crossOriginIsolated: false },
      clockAnchorDriver: null,
      coreFactory: () => Promise.resolve(fallbackCore),
      onModeChange: (mode) => modes.push(mode),
      workerFactory: () => worker as unknown as Worker,
    });
    expect(root.mode).toBe("post-message");
    root.render(undefined);
    await Promise.resolve();
    worker.emitError("synthetic render crash");
    await waitFor(() => root.mode === "main-thread");

    expect(root.canvas).not.toBe(canvas);
    expect(canvas.replacement).toBe(root.canvas);
    expect(fallbackCore.commits).toHaveLength(1);
    expect(modes).toEqual(["post-message", "main-thread"]);
    await root.close();
    expect(fallbackCore.commits).toHaveLength(2);
  });

  it("detects a stalled Worker and recovers the last accepted Shell state", async () => {
    installCanvasGlobal();
    const canvas = new FakeCanvas();
    const worker = readyWorker(false);
    const fallbackCore = fakeCore();
    const onHostError = vi.fn();
    const root = await createHostedCanvasRoot(canvas as unknown as HTMLCanvasElement, {
      capabilities: { ...allCapabilities(), crossOriginIsolated: false },
      clockAnchorDriver: null,
      coreFactory: () => Promise.resolve(fallbackCore),
      mutationAcknowledgementTimeoutMs: 5,
      onHostError,
      workerFactory: () => worker as unknown as Worker,
    });
    root.render(undefined);
    await waitFor(() => root.mode === "main-thread");
    expect(fallbackCore.commits).toHaveLength(1);
    expect((onHostError.mock.calls[0]?.[0] as Error | undefined)?.message).toMatch(/timed out/u);
    await root.close();
  });

  it("treats bounded transport exhaustion as recoverable and rebuilds the latest Scene", async () => {
    for (const preference of ["post-message", "sab"] as const) {
      installCanvasGlobal();
      const canvas = new FakeCanvas();
      const worker = readyWorker(false);
      const fallbackCore = fakeCore();
      const onHostError = vi.fn();
      const root = await createHostedCanvasRoot(canvas as unknown as HTMLCanvasElement, {
        capabilities: allCapabilities(),
        clockAnchorDriver: null,
        coreFactory: () => Promise.resolve(fallbackCore),
        mutationBufferBytes: 4,
        onHostError,
        transport: { preference, strict: true },
        workerFactory: () => worker as unknown as Worker,
      });

      root.render("latest state");
      await waitFor(() => root.mode === "main-thread");

      expect(root.failed).toBe(false);
      expect(fallbackCore.commits).toHaveLength(1);
      expect(root.transportMetrics()).toMatchObject({ mode: preference, rejected: 1 });
      expect((onHostError.mock.calls[0]?.[0] as Error | undefined)?.message).toMatch(/buffer/u);
      await root.close();
    }
  });
});

class FakeEditContext extends EventTarget {
  public text = "";
  public selectionStart = 0;
  public selectionEnd = 0;

  public constructor(_options: object) {
    super();
  }

  public updateText(start: number, end: number, value: string): void {
    this.text = this.text.slice(0, start) + value + this.text.slice(end);
  }

  public updateSelection(start: number, end: number): void {
    this.selectionStart = start;
    this.selectionEnd = end;
  }

  public updateControlBounds(): void {}
  public updateSelectionBounds(): void {}
  public updateCharacterBounds(): void {}
}

class FakeCanvas {
  readonly #domListeners = new Map<string, Set<(event: never) => void>>();
  public height = 80;
  public width = 160;
  public clientHeight = 80;
  public ownerDocument = { defaultView: { EditContext: FakeEditContext } };
  public replacement: unknown;
  public transferCount = 0;
  public style: { cursor?: string; touchAction?: string } = {};
  public focused = false;
  public tabIndex = -1;

  public getAttribute(): string | null {
    return null;
  }

  public focus(): void {
    this.focused = true;
  }

  public blur(): void {
    this.focused = false;
  }

  public setAttribute(): void {}

  public cloneNode(): FakeCanvas {
    const clone = new FakeCanvas();
    clone.height = this.height;
    clone.width = this.width;
    return clone;
  }

  public addEventListener(type: string, listener: (event: never) => void): void {
    const listeners = this.#domListeners.get(type) ?? new Set();
    listeners.add(listener);
    this.#domListeners.set(type, listeners);
  }

  public removeEventListener(type: string, listener: (event: never) => void): void {
    this.#domListeners.get(type)?.delete(listener);
  }

  public emit(type: string, event: object): void {
    for (const listener of this.#domListeners.get(type) ?? []) listener(event as never);
  }

  public getBoundingClientRect(): Pick<DOMRect, "height" | "left" | "top" | "width"> {
    return { height: 80, left: 10, top: 5, width: 80 };
  }

  public getContext(): object {
    return {
      canvas: this,
      clearRect() {},
      drawImage() {},
      font: "",
      measureText(value: string) {
        return { width: value.length * 8 };
      },
      resetTransform() {},
      restore() {},
      save() {},
      scale() {},
      translate() {},
    };
  }

  public replaceWith(replacement: unknown): void {
    this.replacement = replacement;
  }

  public transferControlToOffscreen(): object {
    this.transferCount += 1;
    return {};
  }
}

interface FakeCore extends CoreClient {
  readonly commits: Uint8Array[];
  readonly inputs: Uint8Array[];
  readonly reducedMotion: boolean[];
  freed: boolean;
}

/** An editable element without importing the JSX package. */
function editableElement(width = 80): RenderNode {
  // The descriptor is a plain object keyed by a globally registered symbol, so
  // this stays a test detail rather than a new edge in the package graph.
  return {
    $$typeof: Symbol.for("dopejs.pingo.element"),
    type: "editableText",
    key: null,
    props: { height: 40, revision: 1n, value: "ab cd", width },
  } as unknown as RenderNode;
}

type RenderNode = Parameters<Awaited<ReturnType<typeof createHostedCanvasRoot>>["render"]>[0];

/** A one-character editor covering the whole fake canvas. */
function editingGeometry(nodeId: number): Uint32Array {
  const bits = (value: number): number => {
    const scratch = new DataView(new ArrayBuffer(4));
    scratch.setFloat32(0, value, true);
    return scratch.getUint32(0, true);
  };
  const rect = [bits(0), bits(0), bits(160), bits(80)];
  return Uint32Array.from([1, nodeId, 0, 0, 0, ...rect, ...rect]);
}

function fakeCore(): FakeCore {
  const commits: Uint8Array[] = [];
  const inputs: Uint8Array[] = [];
  const reducedMotion: boolean[] = [];
  return {
    commit: (bytes) => {
      commits.push(bytes.slice());
      return emptyDisplayList();
    },
    commits,
    input: (bytes) => {
      inputs.push(bytes.slice());
      return undefined;
    },
    inputs,
    reducedMotion,
    set_reduced_motion(value) {
      reducedMotion.push(value);
      return undefined;
    },
    free() {
      this.freed = true;
    },
    freed: false,
  };
}

type Listener = (event: never) => void;

class FakeWorker {
  readonly #listeners = {
    error: new Set<Listener>(),
    message: new Set<Listener>(),
    messageerror: new Set<Listener>(),
  };
  public onPost: ((message: unknown) => void) | undefined;
  public readonly posts: unknown[] = [];
  public terminated = false;

  public addEventListener(type: "error" | "message" | "messageerror", listener: Listener): void {
    this.#listeners[type].add(listener);
  }

  public removeEventListener(type: "error" | "message" | "messageerror", listener: Listener): void {
    this.#listeners[type].delete(listener);
  }

  public postMessage(message: unknown): void {
    this.posts.push(message);
    this.onPost?.(message);
  }

  public terminate(): void {
    this.terminated = true;
  }

  public emitMessage(data: unknown): void {
    for (const listener of this.#listeners.message) listener({ data } as never);
  }

  public emitError(message: string): void {
    for (const listener of this.#listeners.error) {
      listener({ error: new Error(message), message } as never);
    }
  }
}

/**
 * Key event kinds in the order the transport actually carried them.
 *
 * Every transport moves the same encoded bytes, so ordering is checked at the
 * bytes rather than at whatever each transport wraps them in.
 */
function workerKeyEvents(worker: FakeWorker): string[] {
  const batches: Uint8Array[] = [];
  const activation = worker.posts.find((candidate) => hasKind(candidate, "pingo:activate")) as
    { inputRingBuffer?: SharedArrayBuffer } | undefined;
  if (activation?.inputRingBuffer !== undefined) {
    const ring = SabMutationRing.attach(activation.inputRingBuffer);
    for (let frame = ring.take(); frame !== null && frame !== undefined; frame = ring.take()) {
      batches.push(frame.bytes);
    }
  }
  for (const post of worker.posts) {
    if (!hasKind(post, "pingo:input")) continue;
    batches.push((post as { bytes: Uint8Array }).bytes);
  }
  return batches
    .flatMap((bytes) => decodeInputBatch(bytes).commands)
    .filter((command) => command.type === "dispatchKeyEvent")
    .map((command) => command.kind);
}

function readyWorker(acknowledgeMutations = true): FakeWorker {
  const worker = new FakeWorker();
  let sessionId = 0;
  worker.onPost = (message) => {
    if (hasKind(message, "pingo:prepare")) {
      sessionId = sessionOf(message);
      worker.emitMessage({
        capabilities: { offscreenCanvas: true, sharedArrayBuffer: true },
        kind: "pingo:prepared",
        sessionId,
      });
    } else if (hasKind(message, "pingo:activate")) {
      worker.emitMessage({
        kind: "pingo:ready",
        mode: (message as { mode: "post-message" | "sab" }).mode,
        sessionId,
      });
    } else if (hasKind(message, "pingo:mutation")) {
      if (!acknowledgeMutations) return;
      const frameSeq = (message as { frameSeq: number }).frameSeq;
      queueMicrotask(() => {
        worker.emitMessage({ frameSeq, kind: "pingo:mutation-ack", sessionId, version: 1 });
      });
    } else if (hasKind(message, "pingo:shutdown")) {
      worker.emitMessage({ kind: "pingo:shutdown-complete", sessionId });
    }
  };
  return worker;
}

function sessionOf(value: unknown): number {
  if (typeof value !== "object" || value === null) throw new Error("message is not an object");
  const sessionId = (value as { sessionId?: unknown }).sessionId;
  if (typeof sessionId !== "number") throw new Error("message session is missing");
  return sessionId;
}

function installCanvasGlobal(): void {
  vi.stubGlobal("HTMLCanvasElement", FakeCanvas);
}

function allCapabilities() {
  return {
    crossOriginIsolated: true,
    offscreenCanvas: true,
    sharedArrayBuffer: true,
    transferableCanvas: true,
    worker: true,
  } as const;
}

function emptyDisplayList(): Uint8Array {
  const bytes = new Uint8Array(16);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, DISPLAY_LIST_MAGIC, true);
  view.setUint16(4, ABI_VERSION, true);
  view.setUint16(6, 16, true);
  view.setUint32(8, 16, true);
  return bytes;
}

function pointerEventTransaction(cursor: "pointer"): Uint8Array {
  const bytes = new Uint8Array(112);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x5650_4f44, true);
  view.setUint16(4, ABI_VERSION, true);
  view.setUint16(6, 16, true);
  view.setUint32(8, bytes.byteLength, true);
  view.setUint32(12, 1, true);
  bytes[16] = 1;
  view.setUint16(18, (bytes.byteLength - 16) / 4, true);
  view.setUint32(20, 1, true);
  view.setUint16(24, 3, true);
  view.setUint32(28, 1, true);
  view.setUint32(56, 7, true);
  view.setUint32(60, 16_667, true);
  view.setUint32(64, 0xffff_ffff, true);
  bytes[68] = 1;
  bytes[69] = 1;
  view.setFloat32(84, 1, true);
  view.setFloat32(88, 1, true);
  view.setUint16(92, cursor === "pointer" ? 34 : 2, true);
  // 94..102 is the key payload, which a pointer event leaves zeroed.
  view.setUint32(104, 1, true);
  view.setUint32(108, 1, true);
  return bytes;
}

function floatBits(value: number): number {
  const scratch = new DataView(new ArrayBuffer(4));
  scratch.setFloat32(0, value, true);
  return scratch.getUint32(0, true);
}

function hasKind(value: unknown, kind: string): boolean {
  return typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === kind;
}

function hostElement(type: "text" | "virtualList", props: Readonly<Record<string, unknown>>) {
  return {
    $$typeof: Symbol.for("dopejs.pingo.element"),
    key: null,
    props,
    type,
  } as const;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("condition did not become true");
}
