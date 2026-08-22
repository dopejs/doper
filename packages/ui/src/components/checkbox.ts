import { memo, Svg, Text, View, type PingoEvent, type PingoNode } from "@dopejs/pingo-jsx";

import { CheckIcon } from "../icons";
import { useTheme } from "../theme";

// Type alias (not interface) so the implicit index signature satisfies
// memo's Props extends Record<string, unknown> constraint.
export type CheckboxProps = {
  readonly checked: boolean;
  readonly onCheckedChange?: (checked: boolean) => void;
  readonly disabled?: boolean;
  readonly label?: string;
  readonly className?: string;
  readonly semanticLabel?: string;
};

function CheckboxImpl(props: CheckboxProps): PingoNode {
  const theme = useTheme();
  const dark = theme === "dark";
  const disabled = props.disabled === true;
  const toggle = (): void => props.onCheckedChange?.(!props.checked);
  return View({
    className: [
      "pui-checkbox",
      disabled ? "pui-checkbox--disabled" : undefined,
      dark ? "pui-dark" : undefined,
      props.className,
    ]
      .filter((part) => part !== undefined && part !== "")
      .join(" "),
    direction: "row",
    semanticRole: "checkbox",
    semanticValue: disabled ? "disabled" : props.checked ? "checked" : "unchecked",
    ...(props.semanticLabel === undefined ? {} : { semanticLabel: props.semanticLabel }),
    ...(disabled
      ? {}
      : {
          onPointerDown: (event: PingoEvent): void => event.currentTarget.focus(),
          onTap: toggle,
          onClick: toggle,
        }),
    children: [
      View({
        className: [
          "pui-checkbox__box",
          props.checked ? "pui-checkbox__box--checked" : undefined,
          dark ? "pui-dark" : undefined,
        ]
          .filter((part) => part !== undefined)
          .join(" "),
        children: props.checked
          ? Svg({
              className: ["pui-checkbox__indicator", dark ? "pui-dark" : undefined]
                .filter((part) => part !== undefined)
                .join(" "),
              source: CheckIcon,
            })
          : null,
      }),
      ...(props.label === undefined
        ? []
        : [
            Text({
              className: ["pui-label", "pui-checkbox__label", dark ? "pui-dark" : undefined]
                .filter((part) => part !== undefined)
                .join(" "),
              value: props.label,
            }),
          ]),
    ],
  });
}

/**
 * shadcn-style checkbox. Controlled: the parent owns `checked` and updates it
 * from `onCheckedChange`. Uses no hooks, so `Checkbox.component(props)` is
 * safe to call directly. The ✓ indicator glyph depends on font coverage —
 * an acceptable placeholder until icon assets exist. Memoized.
 */
export const Checkbox = memo(CheckboxImpl);
