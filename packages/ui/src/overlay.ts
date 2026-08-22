import { type NodeHandle, type PingoEvent } from "@dopejs/pingo-jsx";
import { useMemo } from "@dopejs/pingo-runtime";

/**
 * Focus handoff for an overlay that opens and closes.
 *
 * Core routes a key event to the focused node and nowhere else, so an overlay
 * that never takes focus never sees Escape. Focus moves to the panel as it
 * mounts and returns to whatever opened it when the panel goes away — otherwise
 * the next key press lands on nothing.
 *
 * There is no focus trap: Tab cycling needs an engine-side tab order and the
 * engine deliberately has none (docs/e1-keyboard-events-design.md).
 */
export interface OverlayFocus {
  /** Ref for the element that opens the overlay. */
  readonly trigger: (handle: NodeHandle | null) => void;
  /** Ref for the panel; focuses it as it mounts and restores on unmount. */
  readonly panel: (handle: NodeHandle | null) => void;
}

export function useOverlayFocus(): OverlayFocus {
  return useMemo(() => createOverlayFocus(), []);
}

/** Pure factory: safe to call without a component scope (tests use this). */
export function createOverlayFocus(): OverlayFocus {
  let trigger: NodeHandle | null = null;
  return {
    trigger: (handle) => {
      trigger = handle;
    },
    panel: (handle) => {
      if (handle === null) {
        trigger?.focus();
        return;
      }
      handle.focus();
    },
  };
}

/**
 * Builds an `onKeyDown` that closes on Escape and leaves every other key alone.
 *
 * Swallowing keys an overlay does not act on would stop them reaching whatever
 * else is listening, so only Escape is claimed.
 */
export function escapeHandler(close: () => void): (event: PingoEvent) => void {
  return (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    close();
  };
}

/** Joins class names, dropping the empty ones. */
export function classes(...parts: readonly (string | undefined)[]): string {
  return parts.filter((part) => part !== undefined && part !== "").join(" ");
}
