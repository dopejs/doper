import { afterEach, describe, expect, it } from "vitest";

import { setTheme } from "../theme";
import { toastDescriptor } from "./toast";

afterEach(() => setTheme("light"));

type Host = { props: Record<string, unknown> & { className?: string } };
type Tree = Host & { props: { children: readonly Host[] } };

describe("toastDescriptor", () => {
  it("renders nothing while closed", () => {
    expect(toastDescriptor({ open: false, title: "t" })).toBeNull();
  });

  it("renders a title and an optional description", () => {
    const bare = toastDescriptor({ open: true, title: "已保存" }) as unknown as Tree;
    expect(bare.props.children).toHaveLength(1);
    expect(bare.props.semanticRole).toBe("status");

    const full = toastDescriptor({
      open: true,
      title: "已保存",
      description: "文件已写入",
    }) as unknown as Tree;
    expect(full.props.children[1]?.props.className).toBe("pui-toast__description");
  });

  it("inverts a destructive toast instead of muting its description", () => {
    const node = toastDescriptor({
      open: true,
      title: "失败",
      description: "网络错误",
      variant: "destructive",
    }) as unknown as Tree;
    expect(node.props.className).toBe("pui-toast pui-toast--destructive");
    // Muting on top of the inverted foreground would put grey on red.
    expect(node.props.children[1]?.props.className).toBe("");
  });

  it("themes the surface", () => {
    setTheme("dark");
    expect((toastDescriptor({ open: true, title: "t" }) as unknown as Host).props.className).toBe(
      "pui-toast pui-dark",
    );
  });
});
