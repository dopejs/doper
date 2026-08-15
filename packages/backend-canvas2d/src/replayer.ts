import { readDisplayListHeader, validateInstructionSize } from "./display-list.js";
import type { DisplayListReader } from "./display-list.js";
import { DisplayOpcode } from "./generated.js";

/** Canvas 2D contexts supported on the main thread and in workers. */
export type Canvas2DContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** Host-resolved font and fill state for the system-text fallback path. */
export interface CanvasTextStyle {
  readonly font: string;
  readonly fillStyle: string | CanvasGradient | CanvasPattern;
  readonly direction?: CanvasDirection;
  readonly textAlign?: CanvasTextAlign;
  readonly textBaseline?: CanvasTextBaseline;
}

/** Resource table consulted by the allocation-conscious replay loop. */
export interface Canvas2DResources {
  getPaint(id: number): string | CanvasGradient | CanvasPattern | undefined;
  getPath(id: number): Path2D | undefined;
  getImage(id: number): CanvasImageSource | undefined;
  getText(id: number): string | undefined;
  getTextStyle(id: number): CanvasTextStyle | undefined;
  getFont(id: number): object | undefined;
  getGlyphSpan(id: number): object | undefined;
  getPicture(id: number): Uint8Array | undefined;
  drawGlyphRun:
    | ((
        context: Canvas2DContext,
        fontId: number,
        size: number,
        x: number,
        y: number,
        glyphSpanId: number,
      ) => void)
    | undefined;
}

/** Deterministic validation failure raised before any canvas pixels are touched. */
export class Canvas2DReplayError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "Canvas2DReplayError";
  }
}

/** Work counters from one fully validated replay. */
export interface ReplayStats {
  /** Commands including recursively expanded pictures. */
  readonly commands: number;
  /** DrawPicture expansions. */
  readonly pictures: number;
  /** Deepest picture nesting, with the root list at depth zero. */
  readonly maximumPictureDepth: number;
}

const MAX_PICTURE_DEPTH = 64;
const MAX_EXPANDED_COMMANDS = 4_194_304;

interface ValidationState {
  commands: number;
  pictures: number;
  maximumPictureDepth: number;
  readonly activePictures: Set<number>;
}

/** Validates complete lists/resources before executing a thin typed-reader loop. */
export class Canvas2DReplayer {
  readonly #activePictures = new Set<number>();

  /**
   * Replays one immutable frame. Resource getters must remain stable for the
   * synchronous validation/replay call; malformed input never reaches canvas.
   */
  public replay(
    context: Canvas2DContext,
    bytes: Uint8Array,
    resources: Canvas2DResources,
  ): ReplayStats {
    this.#activePictures.clear();
    const state: ValidationState = {
      commands: 0,
      pictures: 0,
      maximumPictureDepth: 0,
      activePictures: this.#activePictures,
    };
    validateList(bytes, resources, state, 0);

    context.save();
    try {
      replayList(context, bytes, resources);
    } finally {
      context.restore();
    }
    return {
      commands: state.commands,
      pictures: state.pictures,
      maximumPictureDepth: state.maximumPictureDepth,
    };
  }
}

function validateList(
  bytes: Uint8Array,
  resources: Canvas2DResources,
  state: ValidationState,
  depth: number,
): void {
  if (depth > MAX_PICTURE_DEPTH) replayFail("picture nesting exceeds the maximum depth");
  state.maximumPictureDepth = Math.max(state.maximumPictureDepth, depth);
  const { reader, declaredCount } = readDisplayListHeader(bytes);
  state.commands += declaredCount;
  if (state.commands > MAX_EXPANDED_COMMANDS) {
    replayFail("expanded picture command count exceeds the replay budget");
  }
  let actualCount = 0;
  let saveDepth = 0;
  while (reader.remaining > 0) {
    const offset = reader.offset;
    const opcode = reader.instruction();
    actualCount += 1;
    if (opcode === DisplayOpcode.Save) saveDepth += 1;
    if (opcode === DisplayOpcode.Restore) {
      if (saveDepth === 0) replayFail("Restore underflows the graphics-state stack");
      saveDepth -= 1;
    }
    validateCommand(reader, opcode, resources, state, depth);
    validateInstructionSize(opcode, offset, reader.offset);
  }
  if (actualCount !== declaredCount) replayFail("instruction count does not match input");
  if (saveDepth !== 0) replayFail("display list has unmatched Save commands");
}

function validateCommand(
  reader: DisplayListReader,
  opcode: DisplayOpcode,
  resources: Canvas2DResources,
  state: ValidationState,
  depth: number,
): void {
  switch (opcode) {
    case DisplayOpcode.Save:
    case DisplayOpcode.Restore:
      return;
    case DisplayOpcode.Transform:
      reader.skipF32(6);
      return;
    case DisplayOpcode.ClipRect:
      reader.skipF32(4);
      return;
    case DisplayOpcode.Alpha: {
      const alpha = reader.f32();
      if (alpha < 0 || alpha > 1) replayFail("alpha is outside the zero-to-one range");
      return;
    }
    case DisplayOpcode.FillRect:
      reader.skipF32(4);
      required(resources.getPaint(reader.u32()), "paint");
      return;
    case DisplayOpcode.FillRRect: {
      reader.skipF32(4);
      for (let index = 0; index < 4; index += 1) {
        if (reader.f32() < 0) replayFail("rounded-rectangle radius is negative");
      }
      required(resources.getPaint(reader.u32()), "paint");
      return;
    }
    case DisplayOpcode.FillPath:
      required(resources.getPath(reader.u32()), "path");
      required(resources.getPaint(reader.u32()), "paint");
      return;
    case DisplayOpcode.DrawGlyphRun: {
      const fontId = reader.u32();
      const size = reader.f32();
      if (size < 0) replayFail("glyph-run font size is negative");
      reader.skipF32(2);
      const glyphSpanId = reader.u32();
      required(resources.getFont(fontId), "font");
      required(resources.getGlyphSpan(glyphSpanId), "glyph span");
      if (resources.drawGlyphRun === undefined) replayFail("glyph-run renderer is unavailable");
      return;
    }
    case DisplayOpcode.DrawTextFallback:
      required(resources.getText(reader.u32()), "text");
      required(resources.getTextStyle(reader.u32()), "text style");
      reader.skipF32(2);
      return;
    case DisplayOpcode.DrawImage:
      required(resources.getImage(reader.u32()), "image");
      reader.skipF32(8);
      return;
    case DisplayOpcode.DrawPicture: {
      const pictureId = reader.u32();
      reader.skipF32(2);
      const picture = required(resources.getPicture(pictureId), "picture");
      if (state.activePictures.has(pictureId)) replayFail("picture graph contains a cycle");
      state.pictures += 1;
      state.activePictures.add(pictureId);
      try {
        validateList(picture, resources, state, depth + 1);
      } finally {
        state.activePictures.delete(pictureId);
      }
      return;
    }
    default:
      return assertNeverOpcode(opcode);
  }
}

function replayList(
  context: Canvas2DContext,
  bytes: Uint8Array,
  resources: Canvas2DResources,
): void {
  const { reader } = readDisplayListHeader(bytes);
  while (reader.remaining > 0) {
    const opcode = reader.instruction();
    replayCommand(context, reader, opcode, resources);
  }
}

function replayCommand(
  context: Canvas2DContext,
  reader: DisplayListReader,
  opcode: DisplayOpcode,
  resources: Canvas2DResources,
): void {
  switch (opcode) {
    case DisplayOpcode.Save:
      context.save();
      return;
    case DisplayOpcode.Restore:
      context.restore();
      return;
    case DisplayOpcode.Transform:
      context.transform(
        reader.f32(),
        reader.f32(),
        reader.f32(),
        reader.f32(),
        reader.f32(),
        reader.f32(),
      );
      return;
    case DisplayOpcode.ClipRect: {
      const x = reader.f32();
      const y = reader.f32();
      const width = reader.f32();
      const height = reader.f32();
      context.beginPath();
      context.rect(x, y, width, height);
      context.clip();
      return;
    }
    case DisplayOpcode.Alpha:
      context.globalAlpha *= reader.f32();
      return;
    case DisplayOpcode.FillRect: {
      const x = reader.f32();
      const y = reader.f32();
      const width = reader.f32();
      const height = reader.f32();
      context.fillStyle = required(resources.getPaint(reader.u32()), "paint");
      context.fillRect(x, y, width, height);
      return;
    }
    case DisplayOpcode.FillRRect: {
      const x = reader.f32();
      const y = reader.f32();
      const width = reader.f32();
      const height = reader.f32();
      const topLeft = reader.f32();
      const topRight = reader.f32();
      const bottomRight = reader.f32();
      const bottomLeft = reader.f32();
      context.fillStyle = required(resources.getPaint(reader.u32()), "paint");
      context.beginPath();
      context.roundRect(x, y, width, height, [topLeft, topRight, bottomRight, bottomLeft]);
      context.fill();
      return;
    }
    case DisplayOpcode.FillPath: {
      const path = required(resources.getPath(reader.u32()), "path");
      context.fillStyle = required(resources.getPaint(reader.u32()), "paint");
      context.fill(path);
      return;
    }
    case DisplayOpcode.DrawGlyphRun: {
      const fontId = reader.u32();
      const size = reader.f32();
      const x = reader.f32();
      const y = reader.f32();
      const glyphSpanId = reader.u32();
      resources.drawGlyphRun?.(context, fontId, size, x, y, glyphSpanId);
      return;
    }
    case DisplayOpcode.DrawTextFallback: {
      const text = required(resources.getText(reader.u32()), "text");
      const style = required(resources.getTextStyle(reader.u32()), "text style");
      const x = reader.f32();
      const y = reader.f32();
      context.font = style.font;
      context.fillStyle = style.fillStyle;
      if (style.direction !== undefined) context.direction = style.direction;
      if (style.textAlign !== undefined) context.textAlign = style.textAlign;
      if (style.textBaseline !== undefined) context.textBaseline = style.textBaseline;
      context.fillText(text, x, y);
      return;
    }
    case DisplayOpcode.DrawImage: {
      const image = required(resources.getImage(reader.u32()), "image");
      const sourceX = reader.f32();
      const sourceY = reader.f32();
      const sourceWidth = reader.f32();
      const sourceHeight = reader.f32();
      const destinationX = reader.f32();
      const destinationY = reader.f32();
      const destinationWidth = reader.f32();
      const destinationHeight = reader.f32();
      context.drawImage(
        image,
        sourceX,
        sourceY,
        sourceWidth,
        sourceHeight,
        destinationX,
        destinationY,
        destinationWidth,
        destinationHeight,
      );
      return;
    }
    case DisplayOpcode.DrawPicture: {
      const picture = required(resources.getPicture(reader.u32()), "picture");
      const x = reader.f32();
      const y = reader.f32();
      context.save();
      context.translate(x, y);
      try {
        replayList(context, picture, resources);
      } finally {
        context.restore();
      }
      return;
    }
    default:
      return assertNeverOpcode(opcode);
  }
}

function required<T>(value: T | undefined, kind: string): T {
  if (value === undefined) replayFail(`referenced ${kind} resource is missing`);
  return value;
}

function replayFail(message: string): never {
  throw new Canvas2DReplayError(message);
}

function assertNeverOpcode(opcode: never): never {
  return replayFail(`unsupported display opcode ${String(opcode)}`);
}
