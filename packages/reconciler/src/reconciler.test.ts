import {
  Fragment,
  Input,
  Text,
  TextArea as UnstyledTextArea,
  View,
  Video,
  createImage,
  createElement,
  createFont,
  memo,
  type PingoEvent,
  type PingoNode,
  type NodeHandle,
  type ViewHandle,
  type VideoHandle,
} from "@dopejs/pingo-jsx";
import {
  createContext,
  signal,
  useContext,
  useEffect,
  useLayoutValue,
} from "@dopejs/pingo-runtime";
import { createStyleSheet } from "@dopejs/pingo-style";
import type { EventTransaction } from "@dopejs/pingo-editing";
import { describe, expect, it, vi } from "vitest";

import {
  NodeKind,
  Prop,
  ResourceKind,
  SOLID_PAINT_RED_OFFSET,
  TEXT_STYLE_FONT_SIZE_OFFSET,
  TEXT_STYLE_LINE_HEIGHT_OFFSET,
  TEXT_STYLE_PAINT_ID_OFFSET,
  TEXT_STYLE_WEIGHT_OFFSET,
  TEXT_STYLE_V2_FONT_STYLE_OFFSET,
  TEXT_STYLE_V2_OVERFLOW_WRAP_OFFSET,
  TEXT_STYLE_V2_RESOURCE_VARIANT,
  TEXT_STYLE_V2_TEXT_ALIGN_OFFSET,
  TEXT_STYLE_V2_TEXT_OVERFLOW_OFFSET,
  TEXT_STYLE_V2_VARIANT_OFFSET,
  TEXT_STYLE_V2_WHITE_SPACE_OFFSET,
  VirtualAxis,
} from "./generated";
import { MAX_OBSERVED_GEOMETRY_NODES } from "./generated";
import { decodeMutationBatch, type Mutation, type MutationBatch } from "./mutation-stream";
import { createRoot, type MutationSink } from "./reconciler";

class RecordingSink implements MutationSink {
  public readonly batches: MutationBatch[] = [];
  public readonly events: string[] = [];

  public commit(bytes: Uint8Array): void {
    this.events.push("commit");
    this.batches.push(decodeMutationBatch(bytes));
  }
}

describe("reconciler", () => {
  it("observes a node once for many watchers and withdraws when the last one goes", () => {
    const sink = new RecordingSink();
    const root = createRoot(sink);
    let attachA: ((handle: { readonly nodeId: number } | null) => void) | undefined;
    let attachB: ((handle: { readonly nodeId: number } | null) => void) | undefined;
    let widthA: number | undefined;
    // Signals, not plain variables: flipping a variable does not invalidate the
    // component, so the hook would never see the new `enabled`.
    const both = signal(true);
    const watching = signal(true);

    function Watchers(): PingoNode {
      const [refA, valueA] = useLayoutValue((geometry) => geometry.bounds.width, {
        enabled: watching.get(),
      });
      const [refB] = useLayoutValue((geometry) => geometry.bounds.height, {
        enabled: both.get(),
      });
      attachA = refA;
      attachB = refB;
      widthA = valueA;
      return View({ children: undefined });
    }

    root.render(createElement(Watchers, {}));
    const observations = (index: number): Array<{ nodeId: number; flags: number }> =>
      mutationsOfType(sink.batches[index], "observeGeometry");
    const nodeId = sink.batches[0]?.mutations.find(
      (mutation) => mutation.type === "createNode" && mutation.kind === NodeKind.Container,
    );
    expect(nodeId?.type).toBe("createNode");
    const target = nodeId?.type === "createNode" ? nodeId.nodeId : 0;

    // Two watchers, one node: Core's bounded set must see a single slot taken.
    attachA?.({ nodeId: target });
    attachB?.({ nodeId: target });
    root.flushSync();
    const requested = sink.batches.flatMap((_, index) => observations(index));
    expect(requested.filter((mutation) => mutation.flags === 1)).toHaveLength(1);

    root.applyLayoutGeometry([
      {
        nodeId: target,
        bounds: { left: 0, top: 0, width: 64, height: 20 },
        clip: { left: 0, top: 0, width: 500, height: 500 },
      },
    ]);
    root.flushSync();
    expect(widthA).toBe(64);

    const withdrawals = (): number =>
      sink.batches.flatMap((_, index) => observations(index)).filter((m) => m.flags === 0).length;

    // Dropping one watcher must not withdraw while the other still watches.
    both.set(false);
    root.flushSync();
    root.flushSync();
    expect(withdrawals()).toBe(0);

    // Last watcher of a still-mounted node: now it withdraws, or the slot is
    // held for the life of the application.
    watching.set(false);
    root.flushSync();
    // Two flushes, not one, and that is inherent: effects run after the commit,
    // so the unsubscribe they trigger cannot join the batch that caused it. In
    // an application the scheduler supplies the second commit; Core keeps
    // reporting for exactly one extra frame.
    expect(withdrawals()).toBe(0);
    root.flushSync();
    expect(withdrawals()).toBe(1);

    // Unmounting sends nothing further: Core prunes observations whose node no
    // longer resolves, so a removal already implies withdrawal and an explicit
    // command would name a stale id.
    root.render(undefined);
    root.flushSync();
    expect(withdrawals()).toBe(1);
  });

  it("queues observations past the cap and promotes the oldest when a slot frees", () => {
    const sink = new RecordingSink();
    const root = createRoot(sink);
    const total = MAX_OBSERVED_GEOMETRY_NODES + 2;
    const first = signal(true);

    // Real children with real refs: an invented node id would be dropped by the
    // mounted check on the way out, and the test would prove nothing.
    function Watchers(): PingoNode {
      const children = [];
      for (let index = 0; index < total; index += 1) {
        const [ref] = useLayoutValue((geometry) => geometry.bounds.width, {
          enabled: index !== 0 || first.get(),
        });
        children.push(View({ key: String(index), ref, children: undefined }));
      }
      return View({ children });
    }

    root.render(createElement(Watchers, {}));
    root.flushSync();
    const created = sink.batches
      .flatMap((batch) => batch.mutations)
      .filter((mutation) => mutation.type === "createNode" && mutation.kind === NodeKind.Container)
      .map((mutation) => (mutation.type === "createNode" ? mutation.nodeId : 0));
    // One wrapper plus one child per watcher.
    expect(created).toHaveLength(total + 1);
    const firstChild = created[1] ?? 0;
    const lastDeferred = created[total] ?? 0;

    const enabled = (): number[] =>
      sink.batches
        .flatMap((batch) => batch.mutations)
        .filter((mutation) => mutation.type === "observeGeometry" && mutation.flags === 1)
        .map((mutation) => (mutation.type === "observeGeometry" ? mutation.nodeId : 0));

    // Core must never be asked for more than it can hold; the surplus waits in
    // the Shell instead of being rejected and forgotten.
    expect(enabled()).toHaveLength(MAX_OBSERVED_GEOMETRY_NODES);
    expect(root.layoutObservationDeferrals()).toBe(2);
    expect(enabled()).toContain(firstChild);
    expect(enabled()).not.toContain(lastDeferred);

    // Freeing one slot promotes the oldest waiter rather than leaving it stuck.
    first.set(false);
    root.flushSync();
    root.flushSync();
    expect(enabled()).not.toContain(lastDeferred);
    expect(enabled()).toHaveLength(MAX_OBSERVED_GEOMETRY_NODES + 1);
  });

  it("binds Video lifecycle, metadata replacement, events, and imperative controls", () => {
    const sink = new RecordingSink();
    const bindings = vi.fn();
    const requestTypes: string[] = [];
    const loaded = vi.fn();
    const failed = vi.fn();
    const ref = { current: null as VideoHandle | null };
    const poster = createImage(new Uint8Array(2 * 2 * 4), 2, 2);
    const root = createRoot(sink, {
      onMediaBinding: bindings,
      onInteractionRequest: (request) => requestTypes.push(request.type),
    });
    root.render(
      Video({
        src: "movie.mp4",
        poster,
        muted: true,
        ref,
        onLoadedMetadata: loaded,
        onError: failed,
      }),
    );

    expect(createdKinds(sink.batches[0])).toEqual([NodeKind.Root, NodeKind.Video]);
    const resource = resourceForProp(sink.batches[0], Prop.VideoFrame);
    expect(resource?.kind).toBe(ResourceKind.VideoFrame);
    expect(bindings).toHaveBeenLastCalledWith(
      expect.objectContaining({ nodeId: ref.current?.nodeId, resourceId: resource?.resourceId }),
      ref.current?.nodeId,
    );

    ref.current?.play();
    ref.current?.pause();
    ref.current?.seek(3.5);
    expect(requestTypes).toEqual(["mediaPlay", "mediaPause", "mediaSeek"]);

    const nodeId = ref.current?.nodeId;
    if (nodeId === undefined) throw new Error("Video ref missing");
    root.updateMediaMetadata(nodeId, 320, 180);
    expect(mutationsOfType(sink.batches[1], "releaseResource")).toHaveLength(1);
    root.render(
      Video({
        src: "movie.mp4",
        poster,
        muted: false,
        ref,
        onLoadedMetadata: loaded,
        onError: failed,
      }),
    );
    expect(resourceForProp(sink.batches[2], Prop.VideoFrame)).toBeUndefined();
    expect(mutationsOfType(sink.batches[2], "releaseResource")).toHaveLength(0);
    root.applyMediaEvent(nodeId, {
      type: "loadedmetadata",
      currentTime: 0,
      duration: 12,
    });
    root.applyMediaEvent(nodeId, { code: "decode", message: "bad frame" });
    expect(loaded).toHaveBeenCalledOnce();
    expect(failed).toHaveBeenCalledWith({ code: "decode", message: "bad frame" });
    root.unmount();
    expect(bindings).toHaveBeenLastCalledWith(undefined, nodeId);
  });

  it("maps foundation components to the compatible Core node contract", () => {
    const sink = new RecordingSink();
    createRoot(sink).render(
      createElement(View, {
        children: createElement(Fragment, {
          children: [
            createElement(Text, { value: "label" }),
            createElement(Input, { value: "single", revision: 0n }),
            createElement(UnstyledTextArea, { value: "multi", revision: 0n }),
          ],
        }),
      }),
    );

    expect(createdKinds(sink.batches[0])).toEqual([
      NodeKind.Root,
      NodeKind.Container,
      NodeKind.Text,
      NodeKind.EditableText,
      NodeKind.EditableText,
    ]);
    expect(
      mutationsOfType(sink.batches[0], "configureEditable").map(({ flags }) => flags & 1),
    ).toEqual([0, 1]);
  });

  it("resolves registered class and inline styles into one computed-style resource", () => {
    const sink = new RecordingSink();
    const diagnostics: StyleDiagnosticRecord[] = [];
    const styleSheet = createStyleSheet(`
      .card { width: 120px; background-color: #123456; }
      .card:hover { opacity: 0.5; }
    `);
    createRoot(sink, {
      styleSheets: [styleSheet],
      onStyleDiagnostics: (items, context) => diagnostics.push({ items, context }),
    }).render(
      createElement(View, {
        className: "card",
        style: { height: 80 },
        width: 140,
      }),
    );

    const batch = sink.batches[0];
    const resource = resourceForProp(batch, Prop.ComputedStyle);
    expect(resource?.kind).toBe(ResourceKind.ComputedStyle);
    expect(
      new DataView(resource?.bytes.buffer ?? new ArrayBuffer(0)).getUint32(8, true),
    ).toBeGreaterThan(1);
    expect(diagnostics).toEqual([
      expect.objectContaining({
        items: [
          expect.objectContaining({
            code: "legacy-direct-prop-conflict",
            property: "width",
          }),
        ],
      }),
    ]);
  });

  it("recomputes inherited styles for a reused child descriptor", () => {
    const sink = new RecordingSink();
    const child = createElement(Text, { value: "inherited" });
    const root = createRoot(sink);
    root.render(createElement(View, { style: { color: "#112233" }, children: child }));
    const initialChildBinding = mutationsOfType(sink.batches[0], "setRef").filter(
      (mutation) => mutation.prop === Prop.ComputedStyle,
    );
    expect(initialChildBinding).toHaveLength(2);

    root.render(createElement(View, { style: { color: "#445566" }, children: child }));
    expect(
      mutationsOfType(sink.batches[1], "setRef").filter(
        (mutation) => mutation.prop === Prop.ComputedStyle,
      ),
    ).toHaveLength(2);
  });

  it("feeds inherited computed typography into the existing text resource contract", () => {
    const sink = new RecordingSink();
    createRoot(sink).render(
      createElement(View, {
        style: {
          color: "#123456",
          fontFamily: "Fixture Sans",
          fontSize: 20,
          fontWeight: 650,
          lineHeight: 1.5,
        },
        children: createElement(Text, { value: "styled" }),
      }),
    );

    const batch = sink.batches[0];
    const textRun = mutationsOfType(batch, "setTextRun")[0];
    const styleResource = mutationsOfType(batch, "defineResource").find(
      (mutation) => mutation.resourceId === textRun?.styleId,
    );
    expect(styleResource?.kind).toBe(ResourceKind.TextStyle);
    const styleBytes = styleResource?.bytes ?? new Uint8Array();
    const styleView = new DataView(styleBytes.buffer, styleBytes.byteOffset, styleBytes.byteLength);
    expect(styleView.getFloat32(TEXT_STYLE_FONT_SIZE_OFFSET, true)).toBe(20);
    expect(styleView.getFloat32(TEXT_STYLE_LINE_HEIGHT_OFFSET, true)).toBe(30);
    expect(styleView.getUint16(TEXT_STYLE_WEIGHT_OFFSET, true)).toBe(650);
    const paintId = styleView.getUint32(TEXT_STYLE_PAINT_ID_OFFSET, true);
    const paint = mutationsOfType(batch, "defineResource").find(
      (mutation) => mutation.resourceId === paintId,
    );
    expect(paint?.bytes[SOLID_PAINT_RED_OFFSET]).toBe(0x12);
  });

  it("encodes M6 text semantics into the validated TextStyle v2 resource", () => {
    const sink = new RecordingSink();
    createRoot(sink).render(
      createElement(Text, {
        value: "styled",
        style: {
          fontStyle: "italic",
          overflowWrap: "anywhere",
          textAlign: "center",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        },
      }),
    );
    const batch = sink.batches[0];
    const textRun = mutationsOfType(batch, "setTextRun")[0];
    const bytes = mutationsOfType(batch, "defineResource").find(
      (mutation) => mutation.resourceId === textRun?.styleId,
    )?.bytes;
    expect(bytes?.[TEXT_STYLE_V2_VARIANT_OFFSET]).toBe(TEXT_STYLE_V2_RESOURCE_VARIANT);
    expect(bytes?.[TEXT_STYLE_V2_FONT_STYLE_OFFSET]).toBe(24);
    expect(bytes?.[TEXT_STYLE_V2_TEXT_ALIGN_OFFSET]).toBe(6);
    expect(bytes?.[TEXT_STYLE_V2_WHITE_SPACE_OFFSET]).toBe(31);
    expect(bytes?.[TEXT_STYLE_V2_OVERFLOW_WRAP_OFFSET]).toBe(1);
    expect(bytes?.[TEXT_STYLE_V2_TEXT_OVERFLOW_OFFSET]).toBe(15);
  });

  it("keeps the direct-prop path byte-for-byte free of styles when rollback is enabled", () => {
    const sink = new RecordingSink();
    createRoot(sink, { styleResolverEnabled: false }).render(
      createElement(View, { style: { width: 20 }, width: 40 }),
    );
    expect(resourceForProp(sink.batches[0], Prop.ComputedStyle)).toBeUndefined();
    expect(mutationsOfType(sink.batches[0], "setF32")).toContainEqual(
      expect.objectContaining({ prop: Prop.Width, value: 40 }),
    );
  });

  it("rolls back the foundation facade without disabling legacy intrinsics", () => {
    const disabled = createRoot(new RecordingSink(), { foundationComponentsEnabled: false });
    expect(() => disabled.render(createElement(View, { width: 40 }))).toThrow(
      /foundation components are disabled/u,
    );

    const legacySink = new RecordingSink();
    createRoot(legacySink, { foundationComponentsEnabled: false }).render(
      createElement("container", { width: 40 }),
    );
    expect(mutationsOfType(legacySink.batches[0], "createNode")).toHaveLength(2);
  });

  it("rolls back interaction variants independently while retaining base CSS", () => {
    const sink = new RecordingSink();
    const root = createRoot(sink, {
      interactionStylesEnabled: false,
      styleSheets: [createStyleSheet(`.button { opacity: 0.8 } .button:hover { opacity: 0.5 }`)],
    });
    root.render(createElement("container", { className: "button" }));
    expect(resourceForProp(sink.batches[0], Prop.ComputedStyle)).toBeDefined();
    expect(root.styleMetrics()).toMatchObject({ interactionVariants: 0, resolutions: 1 });
  });

  it("reports cumulative style resolution work and no-change cache hits", () => {
    const sheet = createStyleSheet(`.button:hover { opacity: 0.5; }`);
    const root = createRoot(new RecordingSink(), { styleSheets: [sheet] });
    const element = createElement(View, { className: "button", width: 40 });

    root.render(element);
    expect(root.styleMetrics()).toMatchObject({
      cacheHits: 0,
      diagnostics: 0,
      interactionVariants: 8,
      resolutions: 1,
    });
    root.render(element);
    expect(root.styleMetrics()).toMatchObject({ cacheHits: 1, resolutions: 1 });
  });

  it("mounts a deterministic host tree and removes cleared resources", () => {
    const sink = new RecordingSink();
    const root = createRoot(sink);
    root.render(
      createElement("container", {
        backgroundColor: "#123456",
        children: createElement("text", { value: "hello" }),
      }),
    );

    expect(createdKinds(sink.batches[0])).toEqual([
      NodeKind.Root,
      NodeKind.Container,
      NodeKind.Text,
    ]);
    expect(mutationsOfType(sink.batches[0], "setTextRun")).toHaveLength(1);

    root.render(
      createElement("container", {
        children: createElement("text", { value: "hello" }),
      }),
    );
    expect(sink.batches).toHaveLength(2);
    expect(mutationsOfType(sink.batches[1], "clearProp")).toContainEqual(
      expect.objectContaining({ prop: Prop.BackgroundColor }),
    );
    expect(mutationsOfType(sink.batches[1], "releaseResource")).toHaveLength(1);
  });

  it("binds an explicit immutable font independently from fallback text style", () => {
    const sink = new RecordingSink();
    const root = createRoot(sink);
    const font = createFont(Uint8Array.of(0x4f, 0x54, 0x54, 0x4f, 0, 0, 0, 0), {
      fallbackFamily: "Fixture",
    });
    root.render(createElement("text", { value: "hello", font }));

    const batch = sink.batches[0];
    expect(mutationsOfType(batch, "defineResource")).toContainEqual(
      expect.objectContaining({ kind: ResourceKind.Font }),
    );
    expect(mutationsOfType(batch, "setRef")).toContainEqual(
      expect.objectContaining({ prop: Prop.Font }),
    );

    root.render(createElement("text", { value: "hello" }));
    expect(mutationsOfType(sink.batches[1], "clearProp")).toContainEqual(
      expect.objectContaining({ prop: Prop.Font }),
    );
  });

  it("accepts every documented editable prop and still rejects unknown ones", () => {
    const sink = new RecordingSink();
    const root = createRoot(sink);
    // Every prop on EditableTextProps must survive the allowlist; a prop that
    // reaches normalization but not the allowlist fails only at runtime.
    expect(() =>
      root.render(
        createElement("editableText", {
          value: "a",
          revision: 1n,
          multiline: true,
          readOnly: false,
          password: false,
          maxGraphemes: 100,
          inputMode: "email",
          onTransaction: () => undefined,
          onSubmit: () => undefined,
        }),
      ),
    ).not.toThrow();
    expect(() =>
      root.render(createElement("editableText", { value: "a", revision: 1n, bogus: 1 })),
    ).toThrow(/unknown editableText prop bogus/u);
  });

  it("applies revisioned edit deltas to the Shell mirror without stale prop overwrite", () => {
    const sink = new RecordingSink();
    const onTransaction = vi.fn();
    const root = createRoot(sink);
    root.render(createElement("editableText", { value: "a", revision: 0n, onTransaction }));
    const configuration = mutationsOfType(sink.batches[0], "configureEditable")[0];
    if (configuration === undefined) throw new Error("editable configuration missing");

    root.applyEditTransaction({
      nodeId: configuration.nodeId,
      baseRevision: 0n,
      revision: 1n,
      delta: { range: { start: 1, end: 1 }, text: "🙂" },
      selection: {
        anchor: 3,
        anchorAffinity: "downstream",
        focus: 3,
        focusAffinity: "downstream",
      },
      kind: "edit",
    });
    expect(onTransaction).toHaveBeenLastCalledWith(
      expect.objectContaining({ baseRevision: 0n, revision: 1n }),
    );

    root.render(createElement("editableText", { value: "a", revision: 0n, onTransaction }));
    root.applyEditTransaction({
      nodeId: configuration.nodeId,
      baseRevision: 1n,
      revision: 2n,
      delta: { range: { start: 3, end: 3 }, text: "!" },
      selection: {
        anchor: 4,
        anchorAffinity: "downstream",
        focus: 4,
        focusAffinity: "downstream",
      },
      kind: "edit",
    });
    expect(onTransaction).toHaveBeenLastCalledWith(
      expect.objectContaining({ baseRevision: 1n, revision: 2n }),
    );
  });

  it("preserves keyed host identity while reordering siblings", () => {
    const sink = new RecordingSink();
    const root = createRoot(sink);
    const list = (order: readonly string[]): PingoNode =>
      createElement("container", {
        children: order.map((value) => createElement("text", { value, key: value })),
      });

    root.render(list(["a", "b", "c"]));
    root.render(list(["c", "a", "b"]));

    const update = sink.batches[1];
    expect(mutationsOfType(update, "createNode")).toHaveLength(0);
    expect(mutationsOfType(update, "removeNode")).toHaveLength(0);
    expect(mutationsOfType(update, "reparent")).toHaveLength(1);
  });

  it("rerenders only the component invalidated by a signal", () => {
    const sink = new RecordingSink();
    const scheduled: Array<() => void> = [];
    const value = signal("first");
    const root = createRoot(sink, { schedule: (task) => scheduled.push(task) });
    const App = (): PingoNode => createElement("text", { value: value.get() });

    root.render(createElement(App, {}));
    value.set("second");
    expect(scheduled).toHaveLength(1);
    root.flushSync();

    const update = sink.batches[1];
    expect(mutationsOfType(update, "createNode")).toHaveLength(0);
    expect(mutationsOfType(update, "removeNode")).toHaveLength(0);
    expect(mutationsOfType(update, "setTextRun")).toHaveLength(1);
  });

  it("runs refs and effects only after the mutation frame commits", () => {
    const sink = new RecordingSink();
    const ref = vi.fn((_handle: NodeHandle | null) => sink.events.push("ref"));
    const App = (): PingoNode => {
      useEffect(() => {
        sink.events.push("effect");
      }, []);
      return createElement("container", { ref });
    };

    createRoot(sink).render(createElement(App, {}));

    expect(sink.events).toEqual(["commit", "ref", "effect"]);
    expect(ref.mock.calls[0]?.[0]?.nodeId).toEqual(expect.any(Number));
  });

  it("routes callback identifiers and invalidates them when their prop is removed", () => {
    const sink = new RecordingSink();
    const callback = vi.fn();
    const root = createRoot(sink);
    root.render(createElement("container", { onTap: callback }));
    const binding = mutationsOfType(sink.batches[0], "setRef").find(
      (mutation) => mutation.prop === Prop.OnTap,
    );
    expect(binding).toBeDefined();

    root.invokeCallback(binding?.resourceId ?? 0);
    expect(callback).toHaveBeenCalledOnce();
    root.render(createElement("container", {}));
    expect(() => root.invokeCallback(binding?.resourceId ?? 0)).toThrow(/unknown callback/u);
  });

  it("propagates Core-hit-tested events through capture, target, and bubble phases", () => {
    const sink = new RecordingSink();
    const calls: string[] = [];
    const errors: Error[] = [];
    const root = createRoot(sink, { onPostCommitError: (error) => errors.push(error) });
    root.render(
      createElement("container", {
        onClickCapture: (event: PingoEvent) => {
          calls.push(`outer:${String(event.eventPhase)}:${String(event.currentTarget.nodeId)}`);
          throw new Error("observed callback failure");
        },
        onClick: () => calls.push("outer-bubble"),
        children: createElement("text", {
          value: "target",
          onClickCapture: (event: PingoEvent) =>
            calls.push(`target-capture:${String(event.eventPhase)}`),
          onClick: (event: PingoEvent) => {
            calls.push(`target-bubble:${String(event.eventPhase)}:${String(event.target.nodeId)}`);
            event.preventDefault();
            event.stopPropagation();
            expect(event.defaultPrevented).toBe(true);
          },
        }),
      }),
    );
    const nodes = mutationsOfType(sink.batches[0], "createNode");
    const rootId = nodes[0]?.nodeId ?? 0;
    const outerId = nodes[1]?.nodeId ?? 0;
    const targetId = nodes[2]?.nodeId ?? 0;

    root.applyEventTransaction(
      eventTransaction({
        eventId: 7,
        kind: "click",
        target: targetId,
        x: 12,
        y: 8,
        deltaX: 0,
        deltaY: 0,
        buttons: 0,
        modifiers: 5,
        path: [rootId, outerId, targetId],
      }),
    );

    expect(calls).toEqual([
      `outer:1:${String(outerId)}`,
      "target-capture:2",
      `target-bubble:2:${String(targetId)}`,
    ]);
    expect(errors).toHaveLength(1);
    expect(root.failed).toBe(false);

    root.applyEventTransaction(
      eventTransaction({
        eventId: 8,
        kind: "click",
        target: 0xffff_fffe,
        x: 0,
        y: 0,
        deltaX: 0,
        deltaY: 0,
        buttons: 0,
        modifiers: 0,
        path: [rootId, 0xffff_fffe],
      }),
    );
    expect(calls).toHaveLength(3);
  });

  it("delivers non-bubbling lifecycle events at target and bridges imperative capture and focus", () => {
    const sink = new RecordingSink();
    const calls: string[] = [];
    const requests: unknown[] = [];
    const targetRef: { current: NodeHandle | null } = { current: null };
    const root = createRoot(sink, { onInteractionRequest: (request) => requests.push(request) });
    root.render(
      createElement("container", {
        onPointerEnterCapture: () => calls.push("outer-capture"),
        onPointerEnter: () => calls.push("outer-bubble"),
        children: createElement("text", {
          ref: targetRef,
          value: "target",
          onPointerEnterCapture: () => calls.push("target-capture"),
          onPointerEnter: (event: PingoEvent) => {
            calls.push("target");
            event.currentTarget.setPointerCapture(event.pointerId);
          },
        }),
      }),
    );
    const nodes = mutationsOfType(sink.batches[0], "createNode");
    const [rootNode, outer, target] = nodes.map((mutation) => mutation.nodeId);
    root.applyEventTransaction(
      eventTransaction({
        kind: "pointerenter",
        target: target ?? 0,
        pointerId: 7,
        pointerType: "mouse",
        isPrimary: true,
        relatedTarget: outer ?? null,
        cursor: "auto",
        path: [rootNode ?? 0, outer ?? 0, target ?? 0],
      }),
    );

    expect(calls).toEqual(["outer-capture", "target-capture", "target"]);
    expect(requests).toEqual([{ type: "setPointerCapture", nodeId: target, pointerId: 7 }]);

    root.applyEventTransaction(
      eventTransaction({
        kind: "gotpointercapture",
        target: target ?? 0,
        pointerId: 7,
        pointerType: "mouse",
        path: [rootNode ?? 0, outer ?? 0, target ?? 0],
      }),
    );
    expect(targetRef.current?.hasPointerCapture(7)).toBe(true);
    targetRef.current?.releasePointerCapture(7);
    targetRef.current?.focus();
    targetRef.current?.blur();
    expect(requests.slice(1)).toEqual([
      { type: "releasePointerCapture", nodeId: target, pointerId: 7 },
      { type: "focus", nodeId: target },
      { type: "blur", nodeId: target },
    ]);

    root.applyEventTransaction(
      eventTransaction({
        kind: "lostpointercapture",
        target: target ?? 0,
        pointerId: 7,
        pointerType: "mouse",
        path: [rootNode ?? 0, outer ?? 0, target ?? 0],
      }),
    );
    expect(targetRef.current?.hasPointerCapture(7)).toBe(false);
  });

  it("bridges ViewHandle programmatic scrolling without a Shell render", () => {
    const sink = new RecordingSink();
    const requests: unknown[] = [];
    const viewRef: { current: ViewHandle | null } = { current: null };
    const root = createRoot(sink, { onInteractionRequest: (request) => requests.push(request) });

    root.render(View({ ref: viewRef, style: { overflowX: "scroll", overflowY: "scroll" } }));
    const nodeId = viewRef.current?.nodeId;
    viewRef.current?.scrollTo(120, 48);
    viewRef.current?.scrollBy(-20, 12);
    viewRef.current?.setScrollVelocity(30, -15);

    expect(requests).toEqual([
      { type: "scrollTo", nodeId, x: 120, y: 48 },
      { type: "scrollBy", nodeId, deltaX: -20, deltaY: 12 },
      { type: "setScrollVelocity", nodeId, velocityX: 30, velocityY: -15 },
    ]);
    expect(sink.batches).toHaveLength(1);
    expect(() => viewRef.current?.scrollTo(Number.NaN, 0)).toThrow("scroll x must be finite");
  });

  it("attaches versioned animation resources without introducing a Core node kind", () => {
    const sink = new RecordingSink();
    const root = createRoot(sink);
    root.render(
      View({
        style: { opacity: 0.5 },
        transition: { property: "opacity", durationMs: 250, easing: "ease-out" },
        animation: {
          property: "transform",
          durationMs: 1_000,
          fill: "both",
          keyframes: [
            { offset: 0, value: [1, 0, 0, 1, 0, 0] },
            { offset: 1, value: [1, 0, 0, 1, 40, 20] },
          ],
        },
      }),
    );

    const creates = mutationsOfType(sink.batches[0], "createNode");
    expect(creates).toHaveLength(2);
    const resource = mutationsOfType(sink.batches[0], "defineResource").find(
      (mutation) => mutation.kind === ResourceKind.Animation,
    );
    expect(resource?.bytes.slice(0, 4)).toEqual(new Uint8Array([1, 1, 1, 0]));
    expect(mutationsOfType(sink.batches[0], "setRef")).toContainEqual(
      expect.objectContaining({ prop: Prop.Animation, resourceId: resource?.resourceId }),
    );
  });

  it("rolls back Core animation independently while keeping durable targets", () => {
    const sink = new RecordingSink();
    createRoot(sink, { coreAnimationEnabled: false }).render(
      View({
        opacity: 0.75,
        transition: { property: "opacity", durationMs: 250 },
      }),
    );
    expect(
      mutationsOfType(sink.batches[0], "defineResource").find(
        (mutation) => mutation.kind === ResourceKind.Animation,
      ),
    ).toBeUndefined();
    expect(resourceForProp(sink.batches[0], Prop.Animation)).toBeUndefined();
    expect(mutationsOfType(sink.batches[0], "setF32")).toContainEqual(
      expect.objectContaining({ prop: Prop.Opacity, value: 0.75 }),
    );
  });

  it("materializes only Core-requested virtual-list windows and reuses overlapping items", () => {
    const sink = new RecordingSink();
    const renderItem = vi.fn((index: number) => createElement("text", { value: `item ${index}` }));
    const root = createRoot(sink);
    root.render(
      createElement("virtualList", {
        height: 320,
        itemCount: 1_000_000,
        estimatedItemHeight: 40,
        renderItem,
      }),
    );

    expect(renderItem).not.toHaveBeenCalled();
    expect(mutationsOfType(sink.batches[0], "createNode")).toHaveLength(2);
    const configuration = mutationsOfType(sink.batches[0], "configureVirtualList")[0];
    expect(configuration).toEqual(
      expect.objectContaining({
        itemCount: 1_000_000,
        estimatedItemSize: 40,
        baseOverscanViewports: 1,
        velocityHorizonSeconds: 0.25,
        maximumAheadViewports: 4,
      }),
    );

    const nodeId = configuration?.nodeId ?? 0;
    root.refillVirtualRanges([{ nodeId, start: 0, end: 3 }]);
    expect(renderItem.mock.calls.map(([index]) => index)).toEqual([0, 1, 2]);
    expect(
      mutationsOfType(sink.batches[1], "setVirtualItem").map(({ itemIndex }) => itemIndex),
    ).toEqual([0, 1, 2]);
    expect(mutationsOfType(sink.batches[1], "createNode")).toHaveLength(6);

    root.refillVirtualRanges([{ nodeId, start: 2, end: 5 }]);
    expect(renderItem.mock.calls.map(([index]) => index)).toEqual([0, 1, 2, 3, 4]);
    expect(
      mutationsOfType(sink.batches[2], "setVirtualItem").map(({ itemIndex }) => itemIndex),
    ).toEqual([3, 4]);
    expect(mutationsOfType(sink.batches[2], "createNode")).toHaveLength(4);
    expect(mutationsOfType(sink.batches[2], "removeNode")).toHaveLength(2);

    root.refillVirtualRanges([{ nodeId: 0xffff_fffe, start: 0, end: 1 }]);
    expect(sink.batches).toHaveLength(3);
  });

  it("maps View.virtual onto the same vertical window contract without a Scroll node", () => {
    const sink = new RecordingSink();
    const renderItem = vi.fn((index: number) => createElement(Text, { value: `row ${index}` }));
    const getItemKey = vi.fn((index: number) => `order-${index}`);
    const root = createRoot(sink);
    root.render(
      createElement(View, {
        style: { width: 240, height: 320, overflowY: "auto" },
        virtual: {
          axis: "y",
          itemCount: 100,
          estimatedItemSize: 32,
          getItemKey,
          renderItem,
        },
      }),
    );

    expect(createdKinds(sink.batches[0])).toEqual([NodeKind.Root, NodeKind.Container]);
    expect(renderItem).not.toHaveBeenCalled();
    const configuration = mutationsOfType(sink.batches[0], "configureVirtualList")[0];
    expect(configuration).toEqual(
      expect.objectContaining({
        itemCount: 100,
        estimatedItemSize: 32,
        axis: VirtualAxis.Y,
      }),
    );
    const nodeId = configuration?.nodeId ?? 0;
    expect(
      mutationsOfType(sink.batches[0], "setRef").find(
        (mutation) => mutation.nodeId === nodeId && mutation.prop === Prop.ComputedStyle,
      ),
    ).toBeDefined();

    root.refillVirtualRanges([{ nodeId, start: 4, end: 7 }]);
    expect(renderItem.mock.calls.map(([index]) => index)).toEqual([4, 5, 6]);
    expect(getItemKey.mock.calls.map(([index]) => index)).toEqual([4, 5, 6]);
    expect(
      mutationsOfType(sink.batches[1], "setVirtualItem").map(({ itemIndex }) => itemIndex),
    ).toEqual([4, 5, 6]);
  });

  it("maps horizontal View.virtual to the same axis-neutral mutation contract", () => {
    const sink = new RecordingSink();
    const root = createRoot(sink);
    root.render(
      createElement(View, {
        style: { width: 320, height: 80, overflowX: "auto" },
        virtual: {
          axis: "x",
          itemCount: 1_000_000,
          estimatedItemSize: 48,
          renderItem: (index) => createElement(Text, { value: String(index) }),
        },
      }),
    );

    expect(mutationsOfType(sink.batches[0], "configureVirtualList")).toEqual([
      expect.objectContaining({
        axis: VirtualAxis.X,
        itemCount: 1_000_000,
        estimatedItemSize: 48,
      }),
    ]);
  });

  it("rejects conflicting View.virtual declarations before committing", () => {
    const cases: PingoNode[] = [
      createElement(View, {
        style: { overflowX: "visible", overflowY: "visible" },
        children: createElement(Text, { value: "header" }),
        virtual: { itemCount: 1, estimatedItemSize: 20, renderItem: () => null },
      }),
      createElement(View, {
        style: { overflowY: "visible" },
        virtual: { itemCount: 1, estimatedItemSize: 20, renderItem: () => null },
      }),
      createElement(View, {
        style: { overflowX: "visible", overflowY: "visible" },
        virtual: {
          axis: "x",
          itemCount: 1,
          estimatedItemSize: 20,
          renderItem: () => null,
        },
      }),
      createElement(View, {
        style: { overflowY: "auto" },
        virtual: {
          axis: "z" as "y",
          itemCount: 1,
          estimatedItemSize: 20,
          renderItem: () => null,
        },
      }),
    ];

    for (const node of cases) {
      const sink = new RecordingSink();
      expect(() => createRoot(sink).render(node)).toThrow();
      expect(sink.batches).toHaveLength(0);
    }
  });

  it("coalesces virtual windows and clamps a request racing a smaller itemCount", () => {
    const sink = new RecordingSink();
    const root = createRoot(sink);
    root.render(
      createElement("virtualList", {
        itemCount: 10,
        estimatedItemHeight: 20,
        renderItem: (index: number) => createElement("text", { value: String(index) }),
      }),
    );
    const nodeId = mutationsOfType(sink.batches[0], "configureVirtualList")[0]?.nodeId ?? 0;
    root.refillVirtualRanges([
      { nodeId, start: 0, end: 2 },
      { nodeId, start: 3, end: 5 },
    ]);
    expect(
      mutationsOfType(sink.batches[1], "setVirtualItem").map(({ itemIndex }) => itemIndex),
    ).toEqual([3, 4]);

    root.refillVirtualRanges([{ nodeId, start: 9, end: 11 }]);
    expect(
      mutationsOfType(sink.batches[2], "setVirtualItem").map(({ itemIndex }) => itemIndex),
    ).toEqual([9]);
    root.refillVirtualRanges([{ nodeId, start: 11, end: 12 }]);
    expect(sink.batches).toHaveLength(3);
    expect(root.failed).toBe(false);
  });

  it("validates virtual-list policy before producing a frame", () => {
    const sink = new RecordingSink();
    const root = createRoot(sink);
    expect(() =>
      root.render(
        createElement("virtualList", {
          itemCount: 4_000_001,
          estimatedItemHeight: 20,
          renderItem: () => null,
        }),
      ),
    ).toThrow(/itemCount/u);
    expect(sink.batches).toHaveLength(0);
  });

  it("fails closed after a sink rejects a frame", () => {
    const error = new Error("transport unavailable");
    const onFatalError = vi.fn();
    const root = createRoot(
      {
        commit: () => {
          throw error;
        },
      },
      { onFatalError },
    );

    expect(() => root.render(createElement("container", {}))).toThrow(error);
    expect(root.failed).toBe(true);
    expect(onFatalError).toHaveBeenCalledWith(error);
    expect(() => root.render(null)).toThrow(/requires remount/u);
  });

  it("disposes component subscriptions after a fatal initial frame", () => {
    const scheduled: Array<() => void> = [];
    const source = signal("first");
    const App = (): PingoNode => createElement("text", { value: source.get() });
    const root = createRoot(
      {
        commit: () => {
          throw new Error("rejected");
        },
      },
      { schedule: (task) => scheduled.push(task) },
    );

    expect(() => root.render(createElement(App, {}))).toThrow("rejected");
    source.set("second");
    expect(scheduled).toHaveLength(0);
  });

  it("runs effect cleanup after a successful removal commit", () => {
    const sink = new RecordingSink();
    const App = (): PingoNode => {
      useEffect(() => {
        sink.events.push("effect");
        return () => sink.events.push("cleanup");
      }, []);
      return createElement("container", {});
    };
    const root = createRoot(sink);
    root.render(createElement(App, {}));
    root.render(null);

    expect(sink.events).toEqual(["commit", "effect", "commit", "cleanup"]);
  });

  it("runs effect cleanup after a rejected removal without masking the sink error", () => {
    const events: string[] = [];
    let reject = false;
    const sink: MutationSink = {
      commit: () => {
        events.push(reject ? "reject" : "commit");
        if (reject) throw new Error("sink failure");
      },
    };
    const App = (): PingoNode => {
      useEffect(() => {
        events.push("effect");
        return () => events.push("cleanup");
      }, []);
      return createElement("container", {});
    };
    const root = createRoot(sink);
    root.render(createElement(App, {}));
    reject = true;

    expect(() => root.render(null)).toThrow("sink failure");
    expect(events).toEqual(["commit", "effect", "reject", "cleanup"]);
  });

  it("unmounts once and releases all live resources", () => {
    const sink = new RecordingSink();
    const root = createRoot(sink);
    root.render(createElement("text", { value: "bye", color: "#abcdef" }));
    root.unmount();
    root.unmount();

    expect(sink.batches).toHaveLength(2);
    expect(mutationsOfType(sink.batches[1], "removeNode")).toHaveLength(2);
    expect(mutationsOfType(sink.batches[1], "releaseResource")).toHaveLength(3);
    expect(() => root.render(null)).toThrow(/unmounted/u);
  });
});

describe("memo", () => {
  it("skips re-render when props are shallowly equal", () => {
    const sink = new RecordingSink();
    const root = createRoot(sink);
    let renders = 0;
    const Leaf = (props: { readonly label: string }): PingoNode => {
      renders += 1;
      return createElement("text", { value: props.label });
    };
    const MemoLeaf = memo(Leaf);
    const tree = (label: string): PingoNode =>
      createElement("container", { children: createElement(MemoLeaf, { label }) });
    root.render(tree("a"));
    const afterFirst = renders;
    root.render(tree("a"));
    expect(renders).toBe(afterFirst);
  });

  it("re-renders when a prop changes", () => {
    const sink = new RecordingSink();
    const root = createRoot(sink);
    let renders = 0;
    const Leaf = (props: { readonly label: string }): PingoNode => {
      renders += 1;
      return createElement("text", { value: props.label });
    };
    const MemoLeaf = memo(Leaf);
    const tree = (label: string): PingoNode =>
      createElement("container", { children: createElement(MemoLeaf, { label }) });
    root.render(tree("a"));
    root.render(tree("b"));
    expect(renders).toBe(2);
  });

  it("re-renders on inline handler identity change", () => {
    const sink = new RecordingSink();
    const root = createRoot(sink);
    let renders = 0;
    const Leaf = (props: { readonly onTap: () => void }): PingoNode => {
      renders += 1;
      return createElement("container", { onTap: props.onTap });
    };
    const MemoLeaf = memo(Leaf);
    root.render(createElement(MemoLeaf, { onTap: () => {} }));
    root.render(createElement(MemoLeaf, { onTap: () => {} }));
    expect(renders).toBe(2);
  });

  it("honors a custom compare", () => {
    const sink = new RecordingSink();
    const root = createRoot(sink);
    let renders = 0;
    const Leaf = (props: { readonly label: string }): PingoNode => {
      renders += 1;
      return createElement("text", { value: props.label });
    };
    const MemoLeaf = memo(Leaf, () => true);
    const tree = (label: string): PingoNode =>
      createElement("container", { children: createElement(MemoLeaf, { label }) });
    root.render(tree("a"));
    const afterFirst = renders;
    root.render(tree("b"));
    expect(renders).toBe(afterFirst);
  });

  it("remounts when key changes even under memo", () => {
    const sink = new RecordingSink();
    const root = createRoot(sink);
    let renders = 0;
    const Leaf = (): PingoNode => {
      renders += 1;
      return createElement("text", { value: "x" });
    };
    const MemoLeaf = memo(Leaf);
    root.render(createElement("container", { children: createElement(MemoLeaf, {}, "k1") }));
    root.render(createElement("container", { children: createElement(MemoLeaf, {}, "k2") }));
    expect(renders).toBe(2);
  });

  it("memo never blocks signal-driven re-renders", () => {
    const sink = new RecordingSink();
    const root = createRoot(sink);
    const count = signal(0);
    let renders = 0;
    const Leaf = (): PingoNode => {
      renders += 1;
      return createElement("text", { value: String(count.get()) });
    };
    const MemoLeaf = memo(Leaf);
    root.render(createElement("container", { children: createElement(MemoLeaf, {}) }));
    const afterMount = renders;
    count.set(1);
    root.flushSync();
    expect(renders).toBeGreaterThan(afterMount);
  });
});

describe("context", () => {
  const Theme = createContext("light");

  interface Observed {
    readonly value?: string;
  }
  type ConsumerProps = {
    readonly observed: { value?: string };
    readonly counter?: { count: number };
  };
  const Consumer = (props: ConsumerProps): PingoNode => {
    const value = useContext(Theme);
    props.observed.value = value;
    if (props.counter !== undefined) props.counter.count += 1;
    return createElement("text", { value });
  };

  it("delivers the provider value through non-consuming layers", () => {
    const sink = new RecordingSink();
    const root = createRoot(sink);
    const observed: { value?: string } = {};
    const Middle = (props: { readonly children: PingoNode }): PingoNode => props.children;
    root.render(
      createElement(Theme.Provider, {
        value: "dark",
        children: createElement("container", {
          children: createElement(Middle, {
            children: createElement(Consumer, { observed }),
          }),
        }),
      }),
    );
    expect(observed.value).toBe("dark");
  });

  it("returns the default without a provider", () => {
    const sink = new RecordingSink();
    const observed: Observed = {};
    createRoot(sink).render(
      createElement("container", { children: createElement(Consumer, { observed }) }),
    );
    expect(observed.value).toBe("light");
  });

  it("nearest provider wins", () => {
    const sink = new RecordingSink();
    const observed: Observed = {};
    createRoot(sink).render(
      createElement(Theme.Provider, {
        value: "outer",
        children: createElement(Theme.Provider, {
          value: "inner",
          children: createElement(Consumer, { observed }),
        }),
      }),
    );
    expect(observed.value).toBe("inner");
  });

  it("signal delivery re-renders the consumer without touching siblings", () => {
    const sink = new RecordingSink();
    const root = createRoot(sink);
    const consumerRenders = { count: 0 };
    const siblingRenders = { count: 0 };
    const Sibling = (): PingoNode => {
      siblingRenders.count += 1;
      return createElement("text", { value: "sibling" });
    };
    // Identical children reference across renders: provider updates deliver the
    // new value through the signal while the subtree bails out on identity.
    const children = createElement("container", {
      children: [
        createElement(Consumer, { observed: {}, counter: consumerRenders }),
        createElement(Sibling, {}),
      ],
    });
    const tree = (theme: string): PingoNode =>
      createElement(Theme.Provider, { value: theme, children });
    root.render(tree("a"));
    const consumerAfterMount = consumerRenders.count;
    const siblingAfterMount = siblingRenders.count;
    root.render(tree("b"));
    root.flushSync();
    expect(consumerRenders.count).toBeGreaterThan(consumerAfterMount);
    expect(siblingRenders.count).toBe(siblingAfterMount);
  });

  it("memo-wrapped consumers still re-render on context change", () => {
    const sink = new RecordingSink();
    const root = createRoot(sink);
    let renders = 0;
    const MemoConsumer = memo((): PingoNode => {
      renders += 1;
      return createElement("text", { value: useContext(Theme) });
    });
    const tree = (theme: string): PingoNode =>
      createElement(Theme.Provider, { value: theme, children: createElement(MemoConsumer, {}) });
    root.render(tree("a"));
    const afterMount = renders;
    root.render(tree("b"));
    root.flushSync();
    expect(renders).toBeGreaterThan(afterMount);
  });

  it("provider children structure still reconciles on update", () => {
    const sink = new RecordingSink();
    const root = createRoot(sink);
    let childRenders = 0;
    const Child = (props: { readonly label: string }): PingoNode => {
      childRenders += 1;
      return createElement("text", { value: props.label });
    };
    const tree = (label: string): PingoNode =>
      createElement(Theme.Provider, {
        value: "dark",
        children: createElement(Child, { label }),
      });
    root.render(tree("a"));
    const afterMount = childRenders;
    root.render(tree("b"));
    root.flushSync();
    expect(childRenders).toBeGreaterThan(afterMount);
  });

  it("falls back to the default after the provider unmounts", () => {
    const sink = new RecordingSink();
    const root = createRoot(sink);
    const observed: Observed = {};
    const tree = (withProvider: boolean): PingoNode =>
      withProvider
        ? createElement(Theme.Provider, {
            value: "dark",
            children: createElement(Consumer, { observed }),
          })
        : createElement("container", { children: createElement(Consumer, { observed }) });
    root.render(tree(true));
    expect(observed.value).toBe("dark");
    root.render(tree(false));
    expect(observed.value).toBe("light");
  });
});

describe("keyboard events", () => {
  it("propagates key events and exposes key, code and repeat", () => {
    const sink = new RecordingSink();
    const root = createRoot(sink);
    const calls: string[] = [];
    root.render(
      createElement("container", {
        onKeyDownCapture: (event: PingoEvent) => calls.push(`capture:${event.key}`),
        children: createElement("text", {
          value: "target",
          onKeyDown: (event: PingoEvent) => {
            calls.push(`down:${event.key}:${event.code}:${String(event.repeat)}`);
            calls.push(`mods:${String(event.ctrlKey)}${String(event.shiftKey)}`);
          },
          onKeyUp: (event: PingoEvent) => calls.push(`up:${event.key}`),
        }),
      }),
    );
    const nodes = mutationsOfType(sink.batches[0], "createNode");
    const rootId = nodes[0]?.nodeId ?? 0;
    const outerId = nodes[1]?.nodeId ?? 0;
    const targetId = nodes[2]?.nodeId ?? 0;

    root.applyEventTransaction(
      eventTransaction({
        eventId: 1,
        kind: "keydown",
        target: targetId,
        modifiers: 3,
        key: "ArrowDown",
        code: "ArrowDown",
        repeat: true,
        path: [rootId, outerId, targetId],
      }),
    );
    root.applyEventTransaction(
      eventTransaction({
        eventId: 2,
        kind: "keyup",
        target: targetId,
        key: "a",
        code: "KeyA",
        path: [rootId, outerId, targetId],
      }),
    );

    expect(calls).toEqual([
      "capture:ArrowDown",
      "down:ArrowDown:ArrowDown:true",
      "mods:truetrue",
      "up:a",
    ]);
  });

  it("stops a key event at a handler that stops propagation", () => {
    const sink = new RecordingSink();
    const root = createRoot(sink);
    const calls: string[] = [];
    root.render(
      createElement("container", {
        onKeyDown: () => calls.push("outer"),
        children: createElement("text", {
          value: "target",
          onKeyDown: (event: PingoEvent) => {
            calls.push("target");
            event.stopPropagation();
          },
        }),
      }),
    );
    const nodes = mutationsOfType(sink.batches[0], "createNode");

    root.applyEventTransaction(
      eventTransaction({
        eventId: 1,
        kind: "keydown",
        target: nodes[2]?.nodeId ?? 0,
        key: "Escape",
        code: "Escape",
        path: [nodes[0]?.nodeId ?? 0, nodes[1]?.nodeId ?? 0, nodes[2]?.nodeId ?? 0],
      }),
    );

    expect(calls).toEqual(["target"]);
  });
});

interface StyleDiagnosticRecord {
  readonly items: readonly { readonly code: string }[];
  readonly context: { readonly nodeId: number; readonly hostType: string };
}

function eventTransaction(
  overrides: Pick<EventTransaction, "kind" | "path" | "target"> & Partial<EventTransaction>,
): EventTransaction {
  return {
    eventId: 1,
    x: 0,
    y: 0,
    deltaX: 0,
    deltaY: 0,
    buttons: 0,
    modifiers: 0,
    pointerId: 0,
    elapsedMicros: 16_667,
    relatedTarget: null,
    cursor: "auto",
    pointerType: "none",
    isPrimary: false,
    pressure: 0,
    tiltX: 0,
    tiltY: 0,
    width: 0,
    height: 0,
    code: "",
    key: "",
    repeat: false,
    ...overrides,
  };
}

function createdKinds(batch: MutationBatch | undefined): NodeKind[] {
  return mutationsOfType(batch, "createNode").map((mutation) => mutation.kind);
}

function mutationsOfType<Type extends Mutation["type"]>(
  batch: MutationBatch | undefined,
  type: Type,
): Array<Extract<Mutation, { readonly type: Type }>> {
  return (
    batch?.mutations.filter(
      (mutation): mutation is Extract<Mutation, { readonly type: Type }> => mutation.type === type,
    ) ?? []
  );
}

function resourceForProp(
  batch: MutationBatch | undefined,
  prop: Prop,
): Extract<Mutation, { readonly type: "defineResource" }> | undefined {
  const binding = mutationsOfType(batch, "setRef").find((mutation) => mutation.prop === prop);
  if (binding === undefined) return;
  return mutationsOfType(batch, "defineResource").find(
    (mutation) => mutation.resourceId === binding.resourceId,
  );
}
