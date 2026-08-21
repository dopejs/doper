import { signal } from "@dopejs/pingo-runtime";

export type PingoUiTheme = "light" | "dark";

/**
 * Module-level theme signal. pingo has no context API; components reading
 * `useTheme()` during render are auto-subscribed by the reconciler's
 * observer tracking, so `setTheme` re-renders every subscribed component.
 */
const themeSignal = signal<PingoUiTheme>("light");

/** Switches the active theme. Every subscribed component re-renders. */
export function setTheme(next: PingoUiTheme): void {
  themeSignal.set(next);
}

/** Reads the theme without subscribing (for non-render call sites). */
export function getTheme(): PingoUiTheme {
  return themeSignal.peek();
}

/** Reads the theme inside component render; auto-subscribes the component. */
export function useTheme(): PingoUiTheme {
  return themeSignal.get();
}
