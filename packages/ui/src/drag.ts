import { type PingoEvent } from "@dopejs/pingo-jsx";
import { useMemo } from "@dopejs/pingo-runtime";

/** Pointer handlers a draggable node spreads onto itself. */
export interface DragHandlers {
  readonly onPointerDown: (event: PingoEvent) => void;
  readonly onPointerMove: (event: PingoEvent) => void;
  readonly onPointerUp: (event: PingoEvent) => void;
  readonly onPointerCancel: (event: PingoEvent) => void;
}

export interface DragCallbacks {
  /** Fires on press with the starting position, before any movement. */
  readonly onStart?: (position: readonly [number, number]) => void;
  /** Fires per move with the offset from where the drag began. */
  readonly onMove: (delta: readonly [number, number], position: readonly [number, number]) => void;
  /** Fires once on release or cancel; `cancelled` distinguishes the two. */
  readonly onEnd?: (cancelled: boolean) => void;
}

/**
 * Pointer-drag primitive shared by Slider, Resizable and Carousel.
 *
 * Capture is taken on press and released on end, which is the whole reason
 * this exists as a primitive: without it a drag stops the moment the pointer
 * leaves the node, and every draggable control gets the same bug separately.
 *
 * Pure factory: safe to call without a component scope (tests use this).
 */
export function createDrag(callbacks: DragCallbacks): DragHandlers {
  let origin: readonly [number, number] | undefined;
  let pointerId: number | undefined;
  const finish = (event: PingoEvent, cancelled: boolean): void => {
    // Ignore a second pointer's release: only the one that started the drag
    // can end it, or a stray touch would drop the capture mid-gesture.
    if (pointerId !== event.pointerId) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    origin = undefined;
    pointerId = undefined;
    callbacks.onEnd?.(cancelled);
  };
  return {
    onPointerDown: (event) => {
      if (origin !== undefined) return;
      origin = [event.x, event.y];
      pointerId = event.pointerId;
      event.currentTarget.setPointerCapture(event.pointerId);
      event.currentTarget.focus();
      callbacks.onStart?.(origin);
    },
    onPointerMove: (event) => {
      if (origin === undefined || pointerId !== event.pointerId) return;
      callbacks.onMove([event.x - origin[0], event.y - origin[1]], [event.x, event.y]);
    },
    onPointerUp: (event) => finish(event, false),
    onPointerCancel: (event) => finish(event, true),
  };
}

/** Component-scoped {@link createDrag}, memoized so handlers keep identity. */
export function useDrag(callbacks: DragCallbacks): DragHandlers {
  // The callbacks object changes identity every render, so the memo cannot
  // depend on it; the closure below reads the latest through a stable box.
  const box = useMemo(() => ({ callbacks }), []);
  box.callbacks = callbacks;
  return useMemo(
    () =>
      createDrag({
        onStart: (position) => box.callbacks.onStart?.(position),
        onMove: (delta, position) => box.callbacks.onMove(delta, position),
        onEnd: (cancelled) => box.callbacks.onEnd?.(cancelled),
      }),
    [box],
  );
}

/** Maps a pointer position along an axis to a value in `[min, max]`. */
export function positionToValue(
  position: number,
  track: { readonly start: number; readonly length: number },
  range: { readonly min: number; readonly max: number; readonly step?: number },
): number {
  if (!(track.length > 0)) return range.min;
  const ratio = Math.min(Math.max((position - track.start) / track.length, 0), 1);
  const raw = range.min + ratio * (range.max - range.min);
  const step = range.step;
  if (step === undefined || !(step > 0)) return raw;
  // The result is always on the step grid measured from `min`, and always
  // inside the range. Clamping a snapped value to `max` instead would emit a
  // value off the grid whenever the span is not a whole number of steps, so
  // the top end steps back to the last grid point rather than to `max` itself.
  const snapped = range.min + Math.round((raw - range.min) / step) * step;
  if (snapped > range.max) {
    return range.min + Math.floor((range.max - range.min) / step) * step;
  }
  return Math.max(snapped, range.min);
}
