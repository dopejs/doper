import { type NodeHandle, type PingoEvent } from "@dopejs/pingo-jsx";
import { createContext, useContext, useMemo } from "@dopejs/pingo-runtime";

/**
 * Focus handoff and keyboard reach for an overlay that opens and closes.
 *
 * Core routes a key event to the focused node and nowhere else, so an overlay
 * that never takes focus never sees Escape. Focus moves to the panel as it
 * mounts and returns to whatever opened it when the panel goes away — otherwise
 * the next key press lands on nothing.
 *
 * **There is nothing to trap.** Core has no tab order at all, so Tab never
 * moves focus on its own and focus cannot leak out of an overlay by keyboard;
 * a modal's backdrop absorbs the only other thing that moves focus, a pointer
 * press. What is actually missing without help is the opposite: a keyboard user
 * has no way to *reach* the controls inside a panel. `focusable` and
 * `keyHandler` supply that, by cycling Tab over whatever the panel registered.
 */
export interface OverlayFocus {
  /** Ref for the element that opens the overlay. */
  readonly trigger: (handle: NodeHandle | null) => void;
  /** Ref for the panel; focuses it as it mounts and restores on unmount. */
  readonly panel: (handle: NodeHandle | null) => void;
  /**
   * Ref for one control inside the panel, at a caller-chosen Tab position.
   *
   * Opt-in rather than discovered: panel content is an arbitrary tree and the
   * Shell cannot tell which of it is meant to be reachable, nor in what order.
   */
  readonly focusable: (order: number) => (handle: NodeHandle | null) => void;
  /** Currently registered controls, in Tab order. */
  readonly ordered: () => readonly NodeHandle[];
  /**
   * Moves focus to the next (or previous) registered control, wrapping around.
   *
   * The cursor lives here rather than in the key handler because the handler is
   * rebuilt on every render while this object is memoized for the overlay's
   * lifetime — a cursor in the handler would silently rewind mid-cycle.
   * Returns false when nothing is registered, so the caller can leave the key
   * alone instead of swallowing it.
   */
  readonly cycle: (backward: boolean) => boolean;
}

export function useOverlayFocus(): OverlayFocus {
  return useMemo(() => createOverlayFocus(), []);
}

/** Pure factory: safe to call without a component scope (tests use this). */
export function createOverlayFocus(): OverlayFocus {
  let trigger: NodeHandle | null = null;
  const controls = new Map<number, NodeHandle>();
  // Position, not handle: a control that remounts at the same order keeps its
  // place. -1 means focus is still on the panel itself.
  let cursor = -1;
  const ordered = (): NodeHandle[] =>
    [...controls.entries()].sort(([left], [right]) => left - right).map(([, handle]) => handle);
  return {
    trigger: (handle) => {
      trigger = handle;
    },
    panel: (handle) => {
      if (handle === null) {
        // Registrations belong to the panel instance going away; a reopened
        // panel re-registers, so keeping them would cycle onto dead handles.
        controls.clear();
        cursor = -1;
        trigger?.focus();
        return;
      }
      handle.focus();
    },
    focusable: (order) => (handle) => {
      if (handle === null) controls.delete(order);
      else controls.set(order, handle);
    },
    ordered,
    cycle: (backward) => {
      const list = ordered();
      if (list.length === 0) return false;
      // From the panel itself, forward lands on the first control and backward
      // on the last — what a freshly opened panel wants.
      cursor =
        cursor < 0
          ? backward
            ? list.length - 1
            : 0
          : (cursor + (backward ? list.length - 1 : 1)) % list.length;
      list[cursor]?.focus();
      return true;
    },
  };
}

/**
 * Builds an `onKeyDown` that closes on Escape, cycles Tab over the panel's
 * registered controls, and leaves every other key alone.
 *
 * Swallowing keys the overlay does not act on would stop them reaching whatever
 * else is listening, so only Escape and Tab are claimed — and Tab only when
 * something is registered to move to. A panel that registers nothing keeps the
 * plain Escape-only behavior.
 */
export function overlayKeyHandler(
  focus: OverlayFocus,
  close: () => void,
): (event: PingoEvent) => void {
  return (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key !== "Tab") return;
    if (!focus.cycle(event.shiftKey)) return;
    event.preventDefault();
    event.stopPropagation();
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

/**
 * Publishes the enclosing overlay's focus registry to its content.
 *
 * An overlay creates its `OverlayFocus` internally, so without this the
 * `focusable` registry would be unreachable from the content the caller
 * actually renders — the Tab cycle would exist but never have anything in it.
 */
export const OverlayFocusContext = createContext<OverlayFocus | undefined>(undefined);

/**
 * Ref that registers a control at `order` in the enclosing overlay's Tab cycle.
 *
 * Outside an overlay it is a no-op, so the same component can be used both
 * inside and outside one without branching.
 */
export function useFocusableRef(order: number): (handle: NodeHandle | null) => void {
  const focus = useContext(OverlayFocusContext);
  // Memoized on the registry and position: a fresh ref identity every render
  // would make the reconciler detach and reattach the handle each time.
  return useMemo(
    () => (focus === undefined ? (): void => {} : focus.focusable(order)),
    [focus, order],
  );
}
