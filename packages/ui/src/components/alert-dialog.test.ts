import { describe, expect, it, vi } from "vitest";

import { createOverlayFocus } from "../overlay";

import { alertDialogDescriptor } from "./alert-dialog";

type Node = { readonly props: Record<string, unknown> };

function tree(node: unknown): Node {
  return node as Node;
}

function children(node: unknown): unknown[] {
  const value = tree(node).props["children"];
  return Array.isArray(value) ? value : [value];
}

function actions(node: unknown): Node[] {
  // panel is the second child of the overlay layer; the actions row is last.
  const panel = children(node)[1];
  const body = children(panel);
  return children(body[body.length - 1]).map(tree);
}

describe("alertDialogDescriptor", () => {
  const base = { open: true, title: "删除", children: null } as const;

  it("renders nothing while closed", () => {
    expect(alertDialogDescriptor({ ...base, open: false }, createOverlayFocus())).toBeNull();
  });

  it("puts both actions in the Tab cycle", () => {
    const focus = createOverlayFocus();
    const node = alertDialogDescriptor(base, focus);
    const [cancel, action] = actions(node);

    // Registering is what lets a keyboard user reach the buttons at all: focus
    // lands on the panel, and Core has no tab order to carry it further.
    (cancel?.props["ref"] as (handle: unknown) => void)({ focus: vi.fn() });
    (action?.props["ref"] as (handle: unknown) => void)({ focus: vi.fn() });
    expect(focus.ordered()).toHaveLength(2);
  });

  it("runs the caller's handler and then closes, for both buttons", () => {
    for (const [key, position] of [
      ["onCancel", 0],
      ["onAction", 1],
    ] as const) {
      const onOpenChange = vi.fn();
      const callback = vi.fn();
      const node = alertDialogDescriptor(
        { ...base, onOpenChange, [key]: callback },
        createOverlayFocus(),
      );
      (actions(node)[position]?.props["onTap"] as () => void)();
      expect(callback).toHaveBeenCalledOnce();
      expect(onOpenChange).toHaveBeenCalledWith(false);
    }
  });

  it("colours only the confirm action as destructive", () => {
    const [cancel, action] = actions(
      alertDialogDescriptor({ ...base, destructive: true }, createOverlayFocus()),
    );
    expect(action?.props["className"]).toContain("pui-alert-dialog__button--destructive");
    expect(cancel?.props["className"]).not.toContain("--destructive");
  });

  it("falls back to default labels", () => {
    const [cancel, action] = actions(alertDialogDescriptor(base, createOverlayFocus()));
    expect(tree(children(cancel)[0]).props["value"]).toBe("取消");
    expect(tree(children(action)[0]).props["value"]).toBe("确定");
  });
});
