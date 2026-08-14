interface EditContextInitLike {
  readonly selectionEnd?: number;
  readonly selectionStart?: number;
  readonly text?: string;
}

interface EditContextLike extends EventTarget {
  readonly selectionEnd: number;
  readonly selectionStart: number;
  readonly text: string;
  updateCharacterBounds(rangeStart: number, characterBounds: readonly DOMRect[]): void;
  updateControlBounds(controlBounds: DOMRect): void;
  updateSelection(selectionStart: number, selectionEnd: number): void;
  updateSelectionBounds(selectionBounds: DOMRect): void;
}

interface EditContextConstructor {
  new (options?: EditContextInitLike): EditContextLike;
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

export type EditingProbeMode = "edit-context" | "textarea-proxy";

export interface EditingProbeSnapshot {
  readonly composing: boolean;
  readonly events: readonly string[];
  readonly mode: EditingProbeMode;
  readonly selectionEnd: number;
  readonly selectionStart: number;
  readonly text: string;
}

const canvasPadding = 28;
const font = "28px ui-monospace, SFMono-Regular, Menlo, monospace";

export class EditingProbe {
  readonly #canvas: HTMLCanvasElement;
  readonly #context: CanvasRenderingContext2D;
  readonly #events: string[] = [];
  readonly #onUpdate: (snapshot: EditingProbeSnapshot) => void;
  readonly #proxy: HTMLTextAreaElement | null;
  readonly #editContext: EditContextLike | null;
  readonly mode: EditingProbeMode;

  #composing = false;
  #selectionEnd = 0;
  #selectionStart = 0;
  #text = "点击这里，测试中文输入法 / IME";

  constructor(canvas: HTMLCanvasElement, onUpdate: (snapshot: EditingProbeSnapshot) => void) {
    const context = canvas.getContext("2d");
    if (context === null) {
      throw new Error("Canvas2D is required for the editing probe");
    }

    this.#canvas = canvas;
    this.#context = context;
    this.#onUpdate = onUpdate;

    const EditContext = Reflect.get(window, "EditContext") as EditContextConstructor | undefined;
    if (typeof EditContext === "function") {
      this.mode = "edit-context";
      this.#editContext = new EditContext({
        selectionEnd: this.#text.length,
        selectionStart: this.#text.length,
        text: this.#text,
      });
      this.#proxy = null;
      this.#selectionStart = this.#text.length;
      this.#selectionEnd = this.#text.length;
      Reflect.set(this.#canvas, "editContext", this.#editContext);
      this.#attachEditContext();
    } else {
      this.mode = "textarea-proxy";
      this.#editContext = null;
      this.#proxy = this.#createInputProxy();
      this.#selectionStart = this.#text.length;
      this.#selectionEnd = this.#text.length;
    }

    this.#canvas.addEventListener("pointerdown", this.#handlePointerDown);
    this.#canvas.addEventListener("keydown", this.#handleKeyDown);
    window.addEventListener("resize", this.#handleGeometryChange);
    this.#draw();
  }

  dispose(): void {
    this.#canvas.removeEventListener("pointerdown", this.#handlePointerDown);
    this.#canvas.removeEventListener("keydown", this.#handleKeyDown);
    window.removeEventListener("resize", this.#handleGeometryChange);
    this.#proxy?.remove();
    if (this.#editContext !== null) {
      Reflect.set(this.#canvas, "editContext", null);
    }
  }

  snapshot(): EditingProbeSnapshot {
    return {
      composing: this.#composing,
      events: [...this.#events],
      mode: this.mode,
      selectionEnd: this.#selectionEnd,
      selectionStart: this.#selectionStart,
      text: this.#text,
    };
  }

  #attachEditContext(): void {
    const editContext = this.#editContext;
    if (editContext === null) {
      return;
    }

    editContext.addEventListener("textupdate", (event) => {
      const update = event as TextUpdateEventLike;
      this.#text =
        this.#text.slice(0, update.updateRangeStart) +
        update.text +
        this.#text.slice(update.updateRangeEnd);
      this.#selectionStart = update.selectionStart;
      this.#selectionEnd = update.selectionEnd;
      this.#record(
        `textupdate ${String(update.updateRangeStart)}:${String(update.updateRangeEnd)}`,
      );
      this.#draw();
    });
    editContext.addEventListener("compositionstart", () => {
      this.#composing = true;
      this.#record("compositionstart");
      this.#draw();
    });
    editContext.addEventListener("compositionend", () => {
      this.#composing = false;
      this.#record("compositionend");
      this.#draw();
    });
    editContext.addEventListener("characterboundsupdate", (event) => {
      const request = event as CharacterBoundsUpdateEventLike;
      const bounds: DOMRect[] = [];
      for (let index = request.rangeStart; index < request.rangeEnd; index += 1) {
        bounds.push(this.#characterBounds(index));
      }
      editContext.updateCharacterBounds(request.rangeStart, bounds);
      this.#record(`characterbounds ${String(request.rangeStart)}:${String(request.rangeEnd)}`);
    });
  }

  #createInputProxy(): HTMLTextAreaElement {
    const proxy = document.createElement("textarea");
    proxy.dataset.doperInputProxy = "true";
    proxy.value = this.#text;
    proxy.setSelectionRange(this.#text.length, this.#text.length);
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
    document.body.append(proxy);

    proxy.addEventListener("beforeinput", (event) => {
      this.#record(`beforeinput ${event.inputType}`);
    });
    proxy.addEventListener("input", () => {
      this.#text = proxy.value;
      this.#selectionStart = proxy.selectionStart;
      this.#selectionEnd = proxy.selectionEnd;
      this.#record("input");
      this.#draw();
    });
    proxy.addEventListener("compositionstart", () => {
      this.#composing = true;
      this.#record("compositionstart");
      this.#draw();
    });
    proxy.addEventListener("compositionupdate", () => {
      this.#text = proxy.value;
      this.#selectionStart = proxy.selectionStart;
      this.#selectionEnd = proxy.selectionEnd;
      this.#record("compositionupdate");
      this.#draw();
    });
    proxy.addEventListener("compositionend", () => {
      this.#composing = false;
      this.#text = proxy.value;
      this.#selectionStart = proxy.selectionStart;
      this.#selectionEnd = proxy.selectionEnd;
      this.#record("compositionend");
      this.#draw();
    });
    proxy.addEventListener("select", () => {
      this.#selectionStart = proxy.selectionStart;
      this.#selectionEnd = proxy.selectionEnd;
      this.#record("selectionchange");
      this.#draw();
    });
    return proxy;
  }

  readonly #handlePointerDown = (event: PointerEvent): void => {
    event.preventDefault();
    this.#canvas.focus();
    this.#proxy?.focus({ preventScroll: true });
    const point = this.#canvasPoint(event.clientX, event.clientY);
    const offset = this.#offsetAtX(point.x);
    this.#selectionStart = offset;
    this.#selectionEnd = offset;
    this.#editContext?.updateSelection(offset, offset);
    this.#proxy?.setSelectionRange(offset, offset);
    this.#record(`pointer selection=${String(offset)}`);
    this.#draw();
  };

  readonly #handleKeyDown = (event: KeyboardEvent): void => {
    if (this.mode !== "edit-context" || this.#composing) {
      return;
    }

    const next = navigateSelection(event.key, this.#selectionEnd, this.#text);
    if (next === null) {
      return;
    }
    event.preventDefault();
    const start = event.shiftKey ? this.#selectionStart : next;
    this.#selectionStart = Math.min(start, next);
    this.#selectionEnd = Math.max(start, next);
    this.#editContext?.updateSelection(this.#selectionStart, this.#selectionEnd);
    this.#record(`keydown ${event.key}`);
    this.#draw();
  };

  readonly #handleGeometryChange = (): void => {
    this.#draw();
  };

  #draw(): void {
    const canvas = this.#canvas;
    const context = this.#context;
    const scaleX = canvas.width / canvas.clientWidth;
    const scaleY = canvas.height / canvas.clientHeight;
    context.setTransform(scaleX, 0, 0, scaleY, 0, 0);
    context.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
    context.fillStyle = "#0b1020";
    context.fillRect(0, 0, canvas.clientWidth, canvas.clientHeight);
    context.font = font;
    context.textBaseline = "middle";

    const baseline = canvas.clientHeight / 2;
    const selectionLeft = canvasPadding + this.#measure(this.#text.slice(0, this.#selectionStart));
    const selectionRight = canvasPadding + this.#measure(this.#text.slice(0, this.#selectionEnd));
    if (selectionRight > selectionLeft) {
      context.fillStyle = "rgba(92, 179, 255, 0.32)";
      context.fillRect(selectionLeft, baseline - 24, selectionRight - selectionLeft, 48);
    }

    context.fillStyle = "#f4f7ff";
    context.fillText(this.#text, canvasPadding, baseline);
    context.fillStyle = this.#composing ? "#ffca65" : "#61e7b2";
    context.fillRect(selectionRight, baseline - 25, 2, 50);
    if (this.#composing) {
      context.fillRect(
        selectionLeft,
        baseline + 25,
        Math.max(2, selectionRight - selectionLeft),
        2,
      );
    }

    this.#updateEditContextGeometry();
    this.#onUpdate(this.snapshot());
  }

  #updateEditContextGeometry(): void {
    const editContext = this.#editContext;
    if (editContext === null) {
      return;
    }
    const controlBounds = this.#canvas.getBoundingClientRect();
    const caretBounds = this.#characterBounds(this.#selectionEnd);
    editContext.updateControlBounds(controlBounds);
    editContext.updateSelectionBounds(caretBounds);
  }

  #characterBounds(offset: number): DOMRect {
    const canvasBounds = this.#canvas.getBoundingClientRect();
    const left = canvasBounds.left + canvasPadding + this.#measure(this.#text.slice(0, offset));
    const next = Math.min(this.#text.length, offset + 1);
    const width = Math.max(2, this.#measure(this.#text.slice(offset, next)));
    return new DOMRect(left, canvasBounds.top + canvasBounds.height / 2 - 25, width, 50);
  }

  #offsetAtX(x: number): number {
    const relative = Math.max(0, x - canvasPadding);
    for (const index of graphemeBoundaries(this.#text)) {
      const before = this.#measure(this.#text.slice(0, index));
      const next = nextBoundary(this.#text, index);
      const after = this.#measure(this.#text.slice(0, next));
      if (relative < before + (after - before) / 2) {
        return index;
      }
    }
    return this.#text.length;
  }

  #measure(text: string): number {
    this.#context.font = font;
    return this.#context.measureText(text).width;
  }

  #canvasPoint(clientX: number, clientY: number): { readonly x: number; readonly y: number } {
    const bounds = this.#canvas.getBoundingClientRect();
    return { x: clientX - bounds.left, y: clientY - bounds.top };
  }

  #record(message: string): void {
    this.#events.unshift(`${performance.now().toFixed(1)}ms · ${message}`);
    this.#events.length = Math.min(this.#events.length, 12);
  }
}

function navigateSelection(key: string, current: number, text: string): number | null {
  const boundaries = graphemeBoundaries(text);
  switch (key) {
    case "ArrowLeft":
      return boundaries.findLast((boundary) => boundary < current) ?? 0;
    case "ArrowRight":
      return boundaries.find((boundary) => boundary > current) ?? text.length;
    case "End":
      return text.length;
    case "Home":
      return 0;
    default:
      return null;
  }
}

function graphemeBoundaries(text: string): number[] {
  const boundaries = [0];
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  for (const segment of segmenter.segment(text)) {
    if (segment.index > 0) {
      boundaries.push(segment.index);
    }
  }
  if (boundaries.at(-1) !== text.length) {
    boundaries.push(text.length);
  }
  return boundaries;
}

function nextBoundary(text: string, current: number): number {
  return graphemeBoundaries(text).find((boundary) => boundary > current) ?? text.length;
}
