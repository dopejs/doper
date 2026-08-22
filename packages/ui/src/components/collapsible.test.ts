import { describe, expect, it, vi } from "vitest";

import { collapsibleDescriptor } from "./collapsible";

type Node = { readonly props: Record<string, unknown> };

function tree(node: unknown): Node {
  return node as Node;
}

function children(node: unknown): unknown[] {
  return (tree(node).props["children"] as unknown[]) ?? [];
}

describe("collapsibleDescriptor", () => {
  it("keeps the content mounted and hides it while closed", () => {
    const closed = children(collapsibleDescriptor({ trigger: "T", children: null }, false));
    const content = tree(closed[1]);
    // display:none rather than unmounting: unmounting would discard scroll
    // position and any editing state inside the section.
    expect(content.props["style"]).toMatchObject({ display: "none" });

    const open = children(collapsibleDescriptor({ trigger: "T", children: null }, true));
    expect(tree(open[1]).props["style"]).toMatchObject({ display: "flex" });
  });

  it("reports its state to assistive technology and flips the indicator", () => {
    const closed = tree(
      children(collapsibleDescriptor({ trigger: "T", children: null }, false))[0],
    );
    expect(closed.props["semanticRole"]).toBe("button");
    expect(closed.props["semanticValue"]).toBe("collapsed");

    const open = tree(children(collapsibleDescriptor({ trigger: "T", children: null }, true))[0]);
    expect(open.props["semanticValue"]).toBe("expanded");

    // The two states draw different chevrons rather than different glyphs, so
    // compare the geometry instead of a character.
    const outline = (node: unknown): unknown =>
      (tree(children(node)[1]).props["children"] as { props: Record<string, unknown> }[])[0]?.props[
        "d"
      ];
    expect(outline(closed)).not.toBe(outline(open));
  });

  it("toggles on tap and on Enter or Space, and claims neither other key", () => {
    const onOpenChange = vi.fn();
    const trigger = tree(
      children(collapsibleDescriptor({ trigger: "T", children: null, onOpenChange }, false))[0],
    );
    (trigger.props["onTap"] as () => void)();
    expect(onOpenChange).toHaveBeenLastCalledWith(true);

    const keyDown = trigger.props["onKeyDown"] as (event: unknown) => void;
    for (const key of ["Enter", " "]) {
      const preventDefault = vi.fn();
      keyDown({ key, preventDefault });
      expect(preventDefault).toHaveBeenCalledOnce();
    }
    expect(onOpenChange).toHaveBeenCalledTimes(3);

    const preventDefault = vi.fn();
    keyDown({ key: "ArrowDown", preventDefault });
    expect(preventDefault).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledTimes(3);
  });

  it("attaches no handlers at all when disabled", () => {
    const trigger = tree(
      children(
        collapsibleDescriptor(
          { trigger: "T", children: null, disabled: true, onOpenChange: vi.fn() },
          false,
        ),
      )[0],
    );
    // Absent rather than early-returning, so nothing can observe a dead press.
    for (const handler of ["onTap", "onClick", "onKeyDown", "onPointerDown"]) {
      expect(trigger.props[handler]).toBeUndefined();
    }
    expect(trigger.props["className"]).toContain("pui-collapsible__trigger--disabled");
  });
});
