import { Image, memo, Text, View, type PingoImage, type PingoNode } from "@dopejs/pingo-jsx";

import { useTheme } from "../theme";

// Type alias (not interface) so the implicit index signature satisfies
// memo's Props extends Record<string, unknown> constraint.
export type AvatarProps = {
  /** Pre-decoded image resource; falls back to initials when absent. */
  readonly image?: PingoImage;
  readonly fallback: string;
  /** Square edge length in px; when omitted the skin's $avatar-size default applies. */
  readonly size?: number;
  readonly className?: string;
};

function AvatarImpl(props: AvatarProps): PingoNode {
  const theme = useTheme();
  const size = props.size;
  const dark = theme === "dark" ? "pui-dark" : undefined;
  const className = ["pui-avatar", dark, props.className]
    .filter((part) => part !== undefined && part !== "")
    .join(" ");
  const child =
    props.image === undefined
      ? Text({
          className: ["pui-avatar__fallback", dark].filter((part) => part !== undefined).join(" "),
          value: props.fallback,
        })
      : Image({
          source: props.image,
          style: { objectFit: "cover" },
          ...(size === undefined ? {} : { width: size, height: size }),
        });
  // Direct props and the inline style override the skin only when size is
  // explicit; otherwise the skin's $avatar-size default (40px square, fully
  // rounded) applies.
  return View({
    className,
    ...(size === undefined ? {} : { width: size, height: size, style: { borderRadius: size / 2 } }),
    children: child,
  });
}

/** shadcn-style avatar: circular image with an initials fallback. Memoized: re-renders only when props change. */
export const Avatar = memo(AvatarImpl);
