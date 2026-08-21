import { createImage } from "@dopejs/pingo-jsx";
import { afterEach, describe, expect, it } from "vitest";

import { setTheme } from "../theme";
import { Avatar, type AvatarProps } from "./avatar";

afterEach(() => setTheme("light"));

type Host = { type: unknown; props: Record<string, unknown> };

function render(props: AvatarProps) {
  // Components evaluate to host descriptors without a root.
  return Avatar.component(props) as Host;
}

describe("Avatar", () => {
  it("renders the fallback text with skin-default sizing", () => {
    const node = render({ fallback: "JD" });
    expect(node.props.className).toBe("pui-avatar");
    // No explicit size: the skin's $avatar-size default (40px, fully rounded) applies.
    expect(node.props.width).toBeUndefined();
    expect(node.props.height).toBeUndefined();
    expect(node.props.style).toBeUndefined();
    const child = node.props.children as Host;
    expect(child.type).toBe("text");
    expect(child.props.className).toBe("pui-avatar__fallback");
    expect(child.props.value).toBe("JD");
  });

  it("renders the image child when an image is provided", () => {
    const image = createImage(new Uint8Array([0, 0, 0, 255]), 1, 1);
    const node = render({ fallback: "JD", image, size: 64 });
    expect(node.props.width).toBe(64);
    expect(node.props.height).toBe(64);
    expect(node.props.style).toEqual({ borderRadius: 32 });
    const child = node.props.children as Host;
    expect(child.type).toBe("image");
    expect(child.props.source).toBe(image);
    expect(child.props.width).toBe(64);
    expect(child.props.height).toBe(64);
    expect(child.props.style).toEqual({ objectFit: "cover" });
  });

  it("appends dark markers from the theme signal", () => {
    setTheme("dark");
    const node = render({ fallback: "JD" });
    expect(node.props.className).toBe("pui-avatar pui-dark");
    const child = node.props.children as Host;
    expect(child.props.className).toBe("pui-avatar__fallback pui-dark");
  });

  it("appends user className last", () => {
    expect(render({ fallback: "JD", className: "mine" }).props.className).toBe("pui-avatar mine");
  });
});
