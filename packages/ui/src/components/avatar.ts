import { Image, memo, Text, View, type PingoImage, type PingoNode } from "@dopejs/pingo-jsx";

import { useTheme } from "../theme";

// Type alias (not interface) so the implicit index signature satisfies
// memo's Props extends Record<string, unknown> constraint.
export type AvatarProps = {
  /** Pre-decoded image resource; falls back to initials when absent. */
  readonly image?: PingoImage;
  readonly fallback: string;
  /** Square edge length in px; defaults to the $avatar-size token (40). */
  readonly size?: number;
  readonly className?: string;
};

// Mirrors styles/tokens.scss $avatar-size; the runtime cannot read skin
// tokens, so the default is duplicated here and must move in lockstep.
const DEFAULT_AVATAR_SIZE = 40;

function AvatarImpl(props: AvatarProps): PingoNode {
  const theme = useTheme();
  const size = props.size ?? DEFAULT_AVATAR_SIZE;
  const dark = theme === "dark" ? "pui-dark" : undefined;
  const className = ["pui-avatar", dark, props.className]
    .filter((part) => part !== undefined && part !== "")
    .join(" ");
  const child =
    props.image === undefined
      ? Text({
          className: ["pui-avatar__fallback", dark]
            .filter((part) => part !== undefined)
            .join(" "),
          value: props.fallback,
        })
      : Image({ source: props.image, width: size, height: size, style: { objectFit: "cover" } });
  return View({
    className,
    width: size,
    height: size,
    style: { borderRadius: size / 2 },
    children: child,
  });
}

/** shadcn-style avatar: circular image with an initials fallback. Memoized: re-renders only when props change. */
export const Avatar = memo(AvatarImpl);
