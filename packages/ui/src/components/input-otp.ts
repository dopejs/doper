import { createElement, memo, View, type NodeHandle, type PingoNode } from "@dopejs/pingo-jsx";
import { useMemo, useSignal } from "@dopejs/pingo-runtime";

import { classes } from "../overlay";
import { useTheme } from "../theme";

import { Input } from "./input";

export type InputOTPProps = {
  readonly length?: number;
  readonly value?: string;
  readonly defaultValue?: string;
  /** Receives the fixed-length code, space-padded for empty slots. */
  readonly onValueChange?: (value: string) => void;
  /** Fires once every slot is filled, with the space-free code. */
  readonly onComplete?: (value: string) => void;
  readonly disabled?: boolean;
  readonly semanticLabel?: string;
  readonly className?: string;
};

/** Empty-slot marker. See {@link applyOtpEdit} for why the code is padded. */
const EMPTY_SLOT = " ";

/**
 * Applies one slot's edit to the whole code.
 *
 * The code is a **fixed-length string padded with spaces**, so slot `i` is
 * always `value[i]`. A dense string cannot express a hole: clearing the third
 * slot of a full code would shift every later digit one place left and show
 * the user digits they never typed there.
 *
 * Exported because this is where an OTP field is usually wrong: a paste lands
 * in one slot but belongs to all of them, and a deletion has to leave the slot
 * empty rather than pulling the rest of the code left. Both are far easier to
 * pin down here than through a rendered tree.
 */
export function applyOtpEdit(
  current: string,
  index: number,
  edited: string,
  length: number,
): { readonly value: string; readonly focus: number } {
  const slots = Array.from({ length }, (_, slot) => current[slot] ?? EMPTY_SLOT);
  // Anything that is not a single character is treated as a paste starting
  // here, which is what a browser autofill or a clipboard drop looks like.
  const incoming = [...edited]
    .filter((character) => character !== EMPTY_SLOT)
    .slice(0, length - index);
  if (incoming.length === 0) {
    slots[index] = EMPTY_SLOT;
    return { value: slots.join(""), focus: index };
  }
  incoming.forEach((character, offset) => {
    slots[index + offset] = character;
  });
  return {
    value: slots.join(""),
    focus: Math.min(index + incoming.length, length - 1),
  };
}

/** Pure builder: safe to call without a component scope (tests use this). */
export function inputOtpDescriptor(
  props: InputOTPProps,
  value: string,
  actions: {
    readonly onSlotChange: (index: number, edited: string) => void;
    readonly registerSlot: (index: number, handle: NodeHandle | null) => void;
  },
): PingoNode {
  const dark = useTheme() === "dark" ? "pui-dark" : undefined;
  const length = props.length ?? 6;
  return View({
    className: classes("pui-input-otp", props.className),
    direction: "row",
    semanticRole: "group",
    ...(props.semanticLabel === undefined ? {} : { semanticLabel: props.semanticLabel }),
    // createElement rather than a direct call: Input is a memo component, and
    // memoization is what keeps a six-slot field from re-rendering all six on
    // every keystroke.
    children: Array.from({ length }, (_, index) =>
      createElement(Input, {
        key: String(index),
        className: classes("pui-input-otp__slot", dark),
        // A padded slot renders empty rather than as a literal space.
        value: (value[index] ?? EMPTY_SLOT) === EMPTY_SLOT ? "" : (value[index] ?? ""),
        onValueChange: (edited: string) => actions.onSlotChange(index, edited),
        ref: (handle: NodeHandle | null) => actions.registerSlot(index, handle),
        ...(props.disabled === undefined ? {} : { disabled: props.disabled }),
        inputMode: "numeric",
        semanticLabel: `${String(index + 1)}/${String(length)}`,
      }),
    ),
  });
}

/** shadcn-style one-time-code field. JSX-only: uses hooks. */
export const InputOTP = memo(function InputOTPImpl(props: InputOTPProps): PingoNode {
  const length = props.length ?? 6;
  const internal = useSignal(props.defaultValue ?? "");
  const handles = useMemo(() => new Map<number, NodeHandle>(), []);
  // .get() (not .peek()): an uncontrolled edit must re-render this component.
  const value = props.value ?? internal.get();
  return inputOtpDescriptor(props, value, {
    onSlotChange: (index, edited) => {
      const next = applyOtpEdit(value, index, edited, length);
      internal.set(next.value);
      props.onValueChange?.(next.value);
      handles.get(next.focus)?.focus();
      // Completion is reported once the code is full, not once the last slot is
      // touched: a correction in slot one still completes the code.
      if (!next.value.includes(EMPTY_SLOT)) props.onComplete?.(next.value);
    },
    registerSlot: (index, handle) => {
      if (handle === null) handles.delete(index);
      else handles.set(index, handle);
    },
  });
});
