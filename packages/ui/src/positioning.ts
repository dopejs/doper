import type { LayoutRect } from "@dopejs/pingo-runtime";

/** Side of the anchor the panel is placed on. */
export type Side = "top" | "bottom" | "left" | "right";

/** Result of placing a panel against an anchor inside some bounds. */
export interface Placement {
  /** Side actually used, which `flip` may change. */
  readonly side: Side;
  /** Panel origin in the same coordinate space as the inputs. */
  readonly left: number;
  readonly top: number;
  /** Extents the panel must not exceed; `Infinity` when unconstrained. */
  readonly maxWidth: number;
  readonly maxHeight: number;
  /** True when the anchor is entirely outside the bounds. */
  readonly hidden: boolean;
}

/** Inputs for {@link placeAnchored}. All rectangles share one coordinate space. */
export interface PlacementInput {
  readonly anchor: LayoutRect;
  /** The panel's natural size, measured before any constraint was applied. */
  readonly panel: LayoutRect;
  /** Effective clipping box reported by the engine. */
  readonly clip: LayoutRect;
  /** Visible surface, normally the canvas root box. */
  readonly viewport: LayoutRect;
  readonly side: Side;
  /** Gap between anchor and panel. */
  readonly offset?: number;
}

const HORIZONTAL: ReadonlySet<Side> = new Set<Side>(["left", "right"]);

/**
 * Intersection of two rectangles, empty when they do not overlap.
 *
 * The engine reports an unbounded clip for a node nothing clips, so this has to
 * survive infinities; a zero-sized result is meaningful rather than an error.
 */
export function intersectRects(first: LayoutRect, second: LayoutRect): LayoutRect {
  // `-Infinity + Infinity` is NaN, and an unclipped node reports exactly that
  // pair, so the far edge is taken rather than computed when the extent is
  // unbounded.
  const far = (start: number, extent: number): number =>
    extent === Number.POSITIVE_INFINITY ? Number.POSITIVE_INFINITY : start + extent;
  const left = Math.max(first.left, second.left);
  const top = Math.max(first.top, second.top);
  const right = Math.min(far(first.left, first.width), far(second.left, second.width));
  const bottom = Math.min(far(first.top, first.height), far(second.top, second.height));
  return { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

/** True when no part of the anchor is inside `bounds`. */
export function isAnchorHidden(anchor: LayoutRect, bounds: LayoutRect): boolean {
  const visible = intersectRects(anchor, bounds);
  return visible.width <= 0 || visible.height <= 0;
}

/**
 * Space available for a panel on one side of an anchor.
 *
 * Exported because every other strategy is defined in terms of it, and a
 * disagreement between them would place a panel where it does not fit.
 */
export function availableOn(
  side: Side,
  anchor: LayoutRect,
  bounds: LayoutRect,
  offset: number,
): number {
  switch (side) {
    case "top":
      return anchor.top - bounds.top - offset;
    case "bottom":
      return bounds.top + bounds.height - (anchor.top + anchor.height) - offset;
    case "left":
      return anchor.left - bounds.left - offset;
    case "right":
      return bounds.left + bounds.width - (anchor.left + anchor.width) - offset;
  }
}

/** The side opposite `side`. */
export function oppositeSide(side: Side): Side {
  switch (side) {
    case "top":
      return "bottom";
    case "bottom":
      return "top";
    case "left":
      return "right";
    case "right":
      return "left";
  }
}

/**
 * Chooses the side with room, preferring the requested one.
 *
 * Keeps the requested side when neither fits, rather than flipping to a side
 * that is equally bad: an unavoidable overflow should at least be predictable.
 */
export function flipSide(
  side: Side,
  anchor: LayoutRect,
  panel: LayoutRect,
  bounds: LayoutRect,
  offset: number,
): Side {
  const needed = HORIZONTAL.has(side) ? panel.width : panel.height;
  if (availableOn(side, anchor, bounds, offset) >= needed) return side;
  const other = oppositeSide(side);
  return availableOn(other, anchor, bounds, offset) >= needed ? other : side;
}

/**
 * Slides a rectangle along both axes until it lies inside `bounds`.
 *
 * When the rectangle is larger than the bounds on an axis it is pinned to the
 * start edge, because sliding cannot fix a size problem and `size` is the
 * strategy that can.
 */
export function shiftIntoBounds(
  rect: LayoutRect,
  bounds: LayoutRect,
): { left: number; top: number } {
  const clampAxis = (start: number, extent: number, min: number, span: number): number => {
    if (extent >= span) return min;
    return Math.min(Math.max(start, min), min + span - extent);
  };
  return {
    left: clampAxis(rect.left, rect.width, bounds.left, bounds.width),
    top: clampAxis(rect.top, rect.height, bounds.top, bounds.height),
  };
}

/** Origin for a panel of `panel` size on `side` of `anchor`, before shifting. */
function originFor(
  side: Side,
  anchor: LayoutRect,
  panel: LayoutRect,
  offset: number,
): { left: number; top: number } {
  switch (side) {
    case "top":
      return { left: anchor.left, top: anchor.top - panel.height - offset };
    case "bottom":
      return { left: anchor.left, top: anchor.top + anchor.height + offset };
    case "left":
      return { left: anchor.left - panel.width - offset, top: anchor.top };
    case "right":
      return { left: anchor.left + anchor.width + offset, top: anchor.top };
  }
}

/**
 * Places a panel against an anchor, applying size, shift, flip and hide.
 *
 * Pure: the same inputs always give the same placement, so the strategies can
 * be tested without an engine, a host, or a frame.
 */
export function placeAnchored(input: PlacementInput): Placement {
  const offset = input.offset ?? 0;
  const bounds = intersectRects(input.clip, input.viewport);
  if (isAnchorHidden(input.anchor, bounds)) {
    return {
      side: input.side,
      left: input.anchor.left,
      top: input.anchor.top,
      maxWidth: 0,
      maxHeight: 0,
      hidden: true,
    };
  }
  const side = flipSide(input.side, input.anchor, input.panel, bounds, offset);
  const available = Math.max(0, availableOn(side, input.anchor, bounds, offset));
  // The cross axis is limited by the whole bounds; the main axis by the side.
  const maxWidth = HORIZONTAL.has(side) ? available : bounds.width;
  const maxHeight = HORIZONTAL.has(side) ? bounds.height : available;
  // Origin comes from the constrained size, not the natural one: a panel that
  // `size` shortened on the top or left side starts lower or further right.
  const constrained: LayoutRect = {
    left: 0,
    top: 0,
    width: Math.min(input.panel.width, maxWidth),
    height: Math.min(input.panel.height, maxHeight),
  };
  const origin = originFor(side, input.anchor, constrained, offset);
  const shifted = shiftIntoBounds({ ...constrained, ...origin }, bounds);
  return { side, left: shifted.left, top: shifted.top, maxWidth, maxHeight, hidden: false };
}
