import { describe, expect, it } from "vitest";

import { formFieldDescriptor } from "./form";

type Node = { readonly props: Record<string, unknown> };

function field(props: Parameters<typeof formFieldDescriptor>[0]): {
  root: Node;
  children: (Node | null)[];
} {
  const root = formFieldDescriptor(props) as unknown as Node;
  return { root, children: root.props["children"] as (Node | null)[] };
}

describe("formFieldDescriptor", () => {
  it("replaces the description with the error rather than stacking them", () => {
    // Two lines of guidance where one is a failure buries the one that matters.
    const { children } = field({
      label: "邮箱",
      children: null,
      description: "我们不会公开它",
      error: "格式不正确",
    });
    expect(children[2]?.props["value"]).toBe("格式不正确");
    expect(children[2]?.props["className"]).toContain("pui-form-field__error");
  });

  it("shows the description when there is no error", () => {
    const { children } = field({ label: "邮箱", children: null, description: "说明" });
    expect(children[2]?.props["value"]).toBe("说明");
  });

  it("renders no message row when there is neither", () => {
    expect(field({ label: "邮箱", children: null }).children[2]).toBeNull();
  });

  it("treats an empty error string as no error", () => {
    // A caller clearing an error to "" means valid, not "invalid with no reason".
    const { root, children } = field({
      label: "邮箱",
      children: null,
      description: "说明",
      error: "",
    });
    expect(root.props["semanticValue"]).toBeUndefined();
    expect(children[2]?.props["value"]).toBe("说明");
  });

  it("announces invalidity on the group, the only element it owns", () => {
    const { root } = field({ label: "邮箱", children: null, error: "错误" });
    expect(root.props["semanticValue"]).toBe("invalid");
    expect(root.props["semanticLabel"]).toBe("邮箱");
  });

  it("marks a required field in its label", () => {
    const { children } = field({ label: "邮箱", children: null, required: true });
    expect(children[0]?.props["value"]).toBe("邮箱 *");
  });
});
