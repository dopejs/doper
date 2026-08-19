import type { EditTransaction } from "./edit-transactions";
import {
  InputAffinity,
  type CaretMoveDirection,
  type CaretMoveGranularity,
  type InputCommand,
  type InputSelection,
} from "./input-stream";

interface EditContextLike extends EventTarget {
  readonly selectionEnd: number;
  readonly selectionStart: number;
  readonly text: string;
  updateCharacterBounds(rangeStart: number, characterBounds: readonly DOMRect[]): void;
  updateControlBounds(controlBounds: DOMRect): void;
  updateSelection(selectionStart: number, selectionEnd: number): void;
  updateSelectionBounds(selectionBounds: DOMRect): void;
  updateText?(rangeStart: number, rangeEnd: number, text: string): void;
}

interface EditContextConstructor {
  new (options: { text: string; selectionStart: number; selectionEnd: number }): EditContextLike;
}

interface TextUpdateEventLike extends Event {
  readonly selectionEnd: number;
  readonly selectionStart: number;
  readonly text: string;
  readonly updateRangeEnd: number;
  readonly updateRangeStart: number;
}

interface CharacterBoundsUpdateEventLike extends Event {
  readonly rangeEnd: number;
  readonly rangeStart: number;
}

export type NativeTextInputMode = "edit-context" | "textarea-proxy";

export interface EditingSelection {
  readonly anchor: number;
  readonly focus: number;
}

export interface EditingTargetState {
  /** Soft-keyboard layout hint; defaults to plain text. */
  readonly inputMode?: string;
  readonly multiline: boolean;
  readonly nodeId: number;
  readonly password: boolean;
  readonly readOnly: boolean;
  readonly revision: bigint;
  readonly selection: EditingSelection;
  readonly value: string;
}

export interface EditingGeometry {
  readonly characterBounds?: (start: number, end: number) => readonly DOMRect[];
  readonly controlBounds: DOMRect;
  readonly selectionBounds: DOMRect;
}

export interface NativeTextInputBridgeOptions {
  readonly dispatch: (command: InputCommand) => void;
  readonly editContext?: EditContextConstructor | null;
  readonly ownerDocument?: Document;
  readonly onSubmit?: (nodeId: number) => void;
  readonly onError?: (error: Error) => void;
  readonly requestCharacterBounds?: (nodeId: number, start: number, end: number) => void;
}

/** One canvas-wide OS input bridge shared by every editable Scene node. */
export class NativeTextInputBridge {
  readonly #canvas: HTMLCanvasElement;
  readonly #dispatch: (command: InputCommand) => void;
  readonly #editContext: EditContextLike | undefined;
  readonly #onSubmit: ((nodeId: number) => void) | undefined;
  readonly #onError: ((error: Error) => void) | undefined;
  readonly #requestCharacterBounds:
    ((nodeId: number, start: number, end: number) => void) | undefined;
  readonly #proxy: HTMLTextAreaElement | undefined;
  readonly #removeListeners: Array<() => void> = [];
  readonly mode: NativeTextInputMode;

  #appliedRevision = 0n;
  #composing = false;
  #disposed = false;
  #geometry: EditingGeometry | undefined;
  #pendingCharacterBounds: readonly [number, number] | undefined;
  #selection: EditingSelection = { anchor: 0, focus: 0 };
  #sentRevision = 0n;
  #syncingSurface = false;
  #target: EditingTargetState | undefined;
  #value = "";

  public constructor(canvas: HTMLCanvasElement, options: NativeTextInputBridgeOptions) {
    this.#canvas = canvas;
    this.#dispatch = options.dispatch;
    this.#onSubmit = options.onSubmit;
    this.#onError = options.onError;
    this.#requestCharacterBounds = options.requestCharacterBounds;
    const ownerDocument = options.ownerDocument ?? canvas.ownerDocument;
    const constructor =
      options.editContext === undefined
        ? (Reflect.get(ownerDocument.defaultView ?? globalThis, "EditContext") as
            EditContextConstructor | undefined)
        : (options.editContext ?? undefined);
    if (constructor !== undefined) {
      this.mode = "edit-context";
      this.#editContext = new constructor({ text: "", selectionStart: 0, selectionEnd: 0 });
      Reflect.set(canvas, "editContext", this.#editContext);
      this.listen(this.#editContext, "textupdate", this.handleTextUpdate);
      this.listen(this.#editContext, "compositionstart", this.handleCompositionStart);
      this.listen(this.#editContext, "compositionend", this.handleCompositionEnd);
      this.listen(this.#editContext, "characterboundsupdate", this.handleCharacterBoundsUpdate);
      this.listen(canvas, "keydown", this.handleKeyDown);
    } else {
      this.mode = "textarea-proxy";
      this.#proxy = createProxy(ownerDocument);
      this.listen(this.#proxy, "beforeinput", this.handleBeforeInput);
      this.listen(this.#proxy, "compositionstart", this.handleCompositionStart);
      this.listen(this.#proxy, "compositionupdate", this.handleCompositionUpdate);
      this.listen(this.#proxy, "compositionend", this.handleCompositionEnd);
      this.listen(this.#proxy, "select", this.handleProxySelection);
      this.listen(this.#proxy, "copy", this.handleCopy);
      this.listen(this.#proxy, "cut", this.handleCut);
      this.listen(this.#proxy, "paste", this.handlePaste);
    }
  }

  public get activeNodeId(): number | undefined {
    return this.#target?.nodeId;
  }

  /**
   * Whether a DOM node belongs to the surface this bridge owns.
   *
   * The host ends a session when a press lands outside the editor, and the
   * proxy lives in `document.body` rather than inside the canvas, so a press on
   * it would otherwise read as a press somewhere else on the page.
   */
  /**
   * Dictionary word boundaries for the value this bridge currently mirrors.
   *
   * UAX #29 has no dictionary, so Core alone makes every Han ideograph its own
   * word and a double click selects one character. `Intl.Segmenter` does have
   * one, and ICU picks it by script rather than by locale, so the host locale
   * is the right one to ask with. Returns `undefined` when the platform has no
   * segmenter or nothing is being edited, and Core keeps its own segmentation.
   */
  public wordBoundaries():
    { readonly baseRevision: bigint; readonly offsets: number[] } | undefined {
    if (this.#target === undefined || typeof Intl.Segmenter !== "function") return undefined;
    const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });
    const offsets: number[] = [];
    let utf16 = 0;
    for (const segment of segmenter.segment(this.#value)) {
      offsets.push(utf16);
      utf16 += segment.segment.length;
    }
    // Offsets index the value this bridge mirrors, so they are only valid for
    // the revision it has applied; Core drops them when that has moved on.
    return { baseRevision: this.#appliedRevision, offsets };
  }

  public ownsNode(node: Node | null): boolean {
    if (node === null || this.#proxy === undefined) return false;
    return this.#proxy === node || this.#proxy.contains(node);
  }

  public activate(target: EditingTargetState): void {
    this.assertUsable();
    validateTarget(target);
    this.#target = { ...target, selection: { ...target.selection } };
    this.#value = target.value;
    this.#selection = { ...target.selection };
    this.#appliedRevision = target.revision;
    this.#sentRevision = target.revision;
    this.#composing = false;
    this.#pendingCharacterBounds = undefined;
    this.syncSurface();
    this.applyInputMode(target.inputMode ?? "text");
    this.attachEditContext(true);
    this.#canvas.focus({ preventScroll: true });
    this.#proxy?.focus({ preventScroll: true });
  }

  public deactivate(): void {
    this.#target = undefined;
    this.#composing = false;
    this.applyInputMode("none");
    // Detached, not just logically ended. An EditContext left on a focused
    // element keeps the OS text service engaged: the soft keyboard stays up and
    // the IME stays armed on a field the user has clicked away from. Pressing
    // outside the canvas hides that, because the browser moves focus off the
    // canvas itself; pressing elsewhere inside it does not, which is what made
    // the two look like different features.
    this.attachEditContext(false);
    this.#proxy?.blur();
  }

  private attachEditContext(attached: boolean): void {
    if (this.#editContext === undefined) return;
    Reflect.set(this.#canvas, "editContext", attached ? this.#editContext : null);
  }

  /** Forwards the soft-keyboard hint to whichever surface owns OS input. */
  private applyInputMode(inputMode: string): void {
    if (this.#proxy !== undefined) {
      this.#proxy.inputMode = inputMode;
      return;
    }
    if (typeof this.#canvas.setAttribute === "function") {
      this.#canvas.setAttribute("inputmode", inputMode);
    }
  }

  public applyTransaction(transaction: EditTransaction): void {
    this.assertUsable();
    const target = this.#target;
    if (target === undefined || transaction.nodeId !== target.nodeId) return;
    if (transaction.baseRevision !== this.#appliedRevision) {
      throw new Error("edit transaction is out of order for the native input bridge");
    }
    if (transaction.revision > this.#sentRevision) {
      // Core-initiated transitions (caret placement, corrections) fast-forward
      // the optimistic counter so later local input uses the right base.
      this.#sentRevision = transaction.revision;
    }
    if (transaction.delta !== undefined) {
      this.#value = applyUtf16Replacement(
        this.#value,
        transaction.delta.range.start,
        transaction.delta.range.end,
        transaction.delta.text,
      );
    }
    this.#selection = {
      anchor: transaction.selection.anchor,
      focus: transaction.selection.focus,
    };
    this.#appliedRevision = transaction.revision;
    this.#composing = transaction.composition !== undefined;
    this.syncSurface();
  }

  public updateGeometry(geometry: EditingGeometry): void {
    this.assertUsable();
    this.#geometry = geometry;
    this.#editContext?.updateControlBounds(geometry.controlBounds);
    this.#editContext?.updateSelectionBounds(geometry.selectionBounds);
    this.fulfillCharacterBoundsRequest();
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const remove of this.#removeListeners.splice(0)) remove();
    this.#proxy?.remove();
    if (this.#editContext !== undefined) Reflect.set(this.#canvas, "editContext", null);
    this.#target = undefined;
  }

  private emit(command: BrowserCommand): void {
    const target = this.#target;
    if (target === undefined || target.readOnly) return;
    const baseRevision = this.#sentRevision;
    this.#sentRevision += 1n;
    try {
      this.#dispatch({ ...command, nodeId: target.nodeId, baseRevision });
    } catch (cause) {
      this.#sentRevision = baseRevision;
      throw cause;
    }
  }

  private emitSelection(anchor: number, focus: number): void {
    const target = this.#target;
    if (target === undefined) return;
    const baseRevision = this.#sentRevision;
    this.#sentRevision += 1n;
    const selection: InputSelection = {
      anchor: { offset: anchor, affinity: InputAffinity.Downstream },
      focus: { offset: focus, affinity: InputAffinity.Downstream },
    };
    try {
      this.#dispatch({ type: "setSelection", nodeId: target.nodeId, baseRevision, selection });
    } catch (cause) {
      this.#sentRevision = baseRevision;
      throw cause;
    }
  }

  private syncSurface(): void {
    this.#syncingSurface = true;
    try {
      const start = Math.min(this.#selection.anchor, this.#selection.focus);
      const end = Math.max(this.#selection.anchor, this.#selection.focus);
      if (this.#editContext !== undefined) {
        if (this.#editContext.text !== this.#value) {
          this.#editContext.updateText?.(0, this.#editContext.text.length, this.#value);
        }
        this.#editContext.updateSelection(start, end);
      }
      if (this.#proxy !== undefined) {
        this.#proxy.value = this.#value;
        this.#proxy.readOnly = this.#target?.readOnly ?? true;
        this.#proxy.setSelectionRange(start, end);
      }
    } finally {
      this.#syncingSurface = false;
    }
  }

  private readonly handleTextUpdate = (event: Event): void => {
    const update = event as TextUpdateEventLike;
    if (this.#composing) {
      this.emit({ type: "updateComposition", text: update.text });
      return;
    }
    this.emit({
      type: "replace",
      start: update.updateRangeStart,
      end: update.updateRangeEnd,
      text: update.text,
    });
    const naturalCaret = update.updateRangeStart + update.text.length;
    if (update.selectionStart !== naturalCaret || update.selectionEnd !== naturalCaret) {
      this.emitSelection(update.selectionStart, update.selectionEnd);
    }
  };

  private readonly handleCompositionStart = (): void => {
    if (this.#target === undefined || this.#composing) return;
    this.#composing = true;
    this.emit({ type: "beginComposition" });
  };

  private readonly handleCompositionUpdate = (event: Event): void => {
    if (!this.#composing) return;
    this.emit({ type: "updateComposition", text: (event as CompositionEvent).data ?? "" });
  };

  private readonly handleCompositionEnd = (event: Event): void => {
    if (!this.#composing) return;
    this.emit({ type: "commitComposition", text: (event as CompositionEvent).data ?? undefined });
    this.#composing = false;
  };

  private readonly handleBeforeInput = (event: Event): void => {
    const input = event as InputEvent;
    if (this.#target === undefined || this.#composing || this.#target.readOnly) return;
    const command = beforeInputCommand(input, this.#target.multiline);
    if (command === "submit") {
      input.preventDefault();
      this.#onSubmit?.(this.#target.nodeId);
      return;
    }
    if (command === undefined) return;
    input.preventDefault();
    this.emit(command);
  };

  private readonly handleProxySelection = (): void => {
    if (this.#syncingSurface || this.#proxy === undefined || this.#target === undefined) return;
    const anchor = this.#proxy.selectionStart;
    const focus = this.#proxy.selectionEnd;
    if (anchor === this.#selection.anchor && focus === this.#selection.focus) return;
    this.emitSelection(anchor, focus);
  };

  private readonly handleCopy = (event: Event): void => {
    const clipboard = (event as ClipboardEvent).clipboardData;
    const target = this.#target;
    if (clipboard === null || target === undefined || target.password) return;
    event.preventDefault();
    clipboard.setData("text/plain", selectedText(this.#value, this.#selection));
  };

  private readonly handleCut = (event: Event): void => {
    this.handleCopy(event);
    const target = this.#target;
    if (target === undefined || target.readOnly || target.password) return;
    const [start, end] = orderedSelection(this.#selection);
    this.emit({ type: "replace", start, end, text: "" });
  };

  private readonly handlePaste = (event: Event): void => {
    const clipboard = (event as ClipboardEvent).clipboardData;
    const target = this.#target;
    if (clipboard === null || target === undefined || target.readOnly) return;
    event.preventDefault();
    this.emit({ type: "insert", text: clipboard.getData("text/plain") });
  };

  /** EditContext leaves navigation keys to the app; map them to Core moves. */
  private readonly handleKeyDown = (event: Event): void => {
    const key = event as KeyboardEvent;
    const target = this.#target;
    if (target === undefined || this.#composing) return;
    const word = key.ctrlKey || key.altKey;
    let direction: CaretMoveDirection;
    let granularity: CaretMoveGranularity = "grapheme";
    switch (key.key) {
      case "ArrowLeft":
        direction = key.metaKey ? "lineStart" : "backward";
        granularity = word ? "word" : "grapheme";
        break;
      case "ArrowRight":
        direction = key.metaKey ? "lineEnd" : "forward";
        granularity = word ? "word" : "grapheme";
        break;
      case "ArrowUp":
        direction = "up";
        break;
      case "ArrowDown":
        direction = "down";
        break;
      case "Home":
        direction = "lineStart";
        break;
      case "End":
        direction = "lineEnd";
        break;
      default:
        return;
    }
    if (key.cancelable) key.preventDefault();
    try {
      this.#dispatch({
        type: "moveCaret",
        nodeId: target.nodeId,
        direction,
        granularity,
        extend: key.shiftKey,
      });
    } catch (cause) {
      this.#onError?.(toError(cause, "caret movement dispatch failed"));
    }
  };

  private readonly handleCharacterBoundsUpdate = (event: Event): void => {
    const request = event as CharacterBoundsUpdateEventLike;
    this.#pendingCharacterBounds = [request.rangeStart, request.rangeEnd];
    if (this.fulfillCharacterBoundsRequest()) return;
    const nodeId = this.#target?.nodeId;
    if (nodeId !== undefined) {
      this.#requestCharacterBounds?.(nodeId, request.rangeStart, request.rangeEnd);
    }
  };

  private fulfillCharacterBoundsRequest(): boolean {
    const request = this.#pendingCharacterBounds;
    if (request === undefined || this.#editContext === undefined) return false;
    const bounds = this.#geometry?.characterBounds?.(request[0], request[1]);
    if (bounds === undefined || bounds.length !== request[1] - request[0]) return false;
    this.#editContext.updateCharacterBounds(request[0], bounds);
    this.#pendingCharacterBounds = undefined;
    return true;
  }

  private listen(target: EventTarget, type: string, listener: EventListener): void {
    const guarded: EventListener = (event) => {
      try {
        listener(event);
      } catch (cause) {
        this.#onError?.(toError(cause, `native text input ${type} handler failed`));
      }
    };
    target.addEventListener(type, guarded);
    this.#removeListeners.push(() => target.removeEventListener(type, guarded));
  }

  private assertUsable(): void {
    if (this.#disposed) throw new Error("native text input bridge is disposed");
  }
}

type TargetedInputCommand = Extract<InputCommand, { readonly baseRevision: bigint }>;
type BrowserCommand = TargetedInputCommand extends infer Command
  ? Command extends TargetedInputCommand
    ? Omit<Command, "baseRevision" | "nodeId">
    : never
  : never;

function beforeInputCommand(
  event: InputEvent,
  multiline: boolean,
): BrowserCommand | "submit" | undefined {
  switch (event.inputType) {
    case "insertText":
    case "insertReplacementText":
    case "insertFromDrop":
      return { type: "insert", text: event.data ?? "" };
    case "insertLineBreak":
    case "insertParagraph":
      return multiline ? { type: "insert", text: "\n" } : "submit";
    case "deleteContentBackward":
    case "deleteWordBackward":
      return { type: "deleteBackward" };
    case "deleteContentForward":
    case "deleteWordForward":
      return { type: "deleteForward" };
    case "historyUndo":
      return { type: "undo" };
    case "historyRedo":
      return { type: "redo" };
    default:
      return undefined;
  }
}

function createProxy(ownerDocument: Document): HTMLTextAreaElement {
  const proxy = ownerDocument.createElement("textarea");
  proxy.dataset.doperInputProxy = "true";
  proxy.autocapitalize = "off";
  proxy.autocomplete = "off";
  proxy.spellcheck = false;
  Object.assign(proxy.style, {
    height: "1px",
    left: "-10000px",
    opacity: "0",
    position: "fixed",
    top: "0",
    width: "1px",
  });
  ownerDocument.body.append(proxy);
  return proxy;
}

function validateTarget(target: EditingTargetState): void {
  if (!Number.isInteger(target.nodeId) || target.nodeId < 0 || target.nodeId > 0xffff_ffff) {
    throw new RangeError("editing target nodeId must be a u32");
  }
  if (target.revision < 0n) throw new RangeError("editing target revision must be non-negative");
  for (const offset of [target.selection.anchor, target.selection.focus]) {
    if (!Number.isInteger(offset) || offset < 0 || offset > target.value.length) {
      throw new RangeError("editing target selection is outside its UTF-16 value");
    }
    assertUtf16Boundary(target.value, offset, "editing target selection");
  }
}

function applyUtf16Replacement(
  value: string,
  start: number,
  end: number,
  replacement: string,
): string {
  if (start < 0 || start > end || end > value.length) throw new RangeError("edit delta is invalid");
  assertUtf16Boundary(value, start, "edit delta start");
  assertUtf16Boundary(value, end, "edit delta end");
  return value.slice(0, start) + replacement + value.slice(end);
}

function assertUtf16Boundary(value: string, offset: number, label: string): void {
  if (
    offset > 0 &&
    offset < value.length &&
    isHighSurrogate(value.charCodeAt(offset - 1)) &&
    isLowSurrogate(value.charCodeAt(offset))
  ) {
    throw new RangeError(`${label} splits a surrogate pair`);
  }
}

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

function orderedSelection(selection: EditingSelection): readonly [number, number] {
  return selection.anchor <= selection.focus
    ? [selection.anchor, selection.focus]
    : [selection.focus, selection.anchor];
}

function selectedText(value: string, selection: EditingSelection): string {
  const [start, end] = orderedSelection(selection);
  return value.slice(start, end);
}

function toError(cause: unknown, message: string): Error {
  return cause instanceof Error ? cause : new Error(message, { cause });
}
