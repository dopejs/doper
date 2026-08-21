import { memo, View, type PingoEvent, type PingoNode } from "@dopejs/pingo-jsx";

import { useTheme } from "../theme";

// Type alias (not interface) so the implicit index signature satisfies
// memo's Props extends Record<string, unknown> constraint.
export type SwitchProps = {
  readonly checked: boolean;
  readonly onCheckedChange?: (checked: boolean) => void;
  readonly disabled?: boolean;
  readonly className?: string;
  readonly semanticLabel?: string;
};

function SwitchImpl(props: SwitchProps): PingoNode {
  const theme = useTheme();
  const dark = theme === "dark";
  const disabled = props.disabled === true;
  const toggle = (): void => props.onCheckedChange?.(!props.checked);
  return View({
    className: [
      "pui-switch",
      props.checked ? "pui-switch--checked" : undefined,
      disabled ? "pui-switch--disabled" : undefined,
      dark ? "pui-dark" : undefined,
      props.className,
    ]
      .filter((part) => part !== undefined && part !== "")
      .join(" "),
    semanticRole: "switch",
    semanticValue: disabled ? "disabled" : props.checked ? "on" : "off",
    ...(props.semanticLabel === undefined ? {} : { semanticLabel: props.semanticLabel }),
    ...(disabled
      ? {}
      : {
          onPointerDown: (event: PingoEvent): void => event.currentTarget.focus(),
          onTap: toggle,
          onClick: toggle,
        }),
    children: View({
      className: [
        "pui-switch__thumb",
        props.checked ? "pui-switch__thumb--checked" : undefined,
        dark ? "pui-dark" : undefined,
      ]
        .filter((part) => part !== undefined)
        .join(" "),
    }),
  });
}

/**
 * shadcn-style switch. Controlled: the parent owns `checked` and updates it
 * from `onCheckedChange`. Uses no hooks, so `Switch.component(props)` is safe
 * to call directly. Memoized: re-renders only when props change.
 */
export const Switch = memo(SwitchImpl);
