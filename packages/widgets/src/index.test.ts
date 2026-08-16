import { describe, expect, it } from "vitest";

import { TextArea, TextField } from "./index";

interface ElementLike {
  readonly type: unknown;
  readonly props: Record<string, unknown>;
}

function children(element: ElementLike): ElementLike[] {
  const value = element.props.children;
  if (value === undefined) return [];
  return (Array.isArray(value) ? value : [value]) as ElementLike[];
}

function findEditable(element: ElementLike): ElementLike | undefined {
  if (element.type === "editableText") return element;
  for (const child of children(element)) {
    const found = findEditable(child);
    if (found !== undefined) return found;
  }
  return undefined;
}

describe("decorated text widgets", () => {
  it("composes only the engine editable primitive with passthrough props", () => {
    const field = TextField({
      value: "hello",
      revision: 3n,
      password: true,
      inputMode: "email",
      semanticLabel: "Email",
      width: 200,
    }) as ElementLike;
    expect(field.type).toBe("container");
    const editable = findEditable(field);
    if (editable === undefined) throw new Error("editableText missing");
    expect(editable.props).toMatchObject({
      value: "hello",
      revision: 3n,
      password: true,
      inputMode: "email",
      multiline: false,
      semanticLabel: "Email",
      semanticRole: "textbox",
    });
  });

  it("switches the border to the error color and renders an alert caption", () => {
    const field = TextField({ value: "", error: "Required" }) as ElementLike;
    const [bordered, caption] = children(field);
    if (bordered === undefined || caption === undefined) throw new Error("error layout missing");
    expect(bordered.props.backgroundColor).toBe("#d03050ff");
    expect(caption.props).toMatchObject({ value: "Required", semanticRole: "alert" });
  });

  it("sizes the multiline area from rows and keeps multiline semantics", () => {
    const area = TextArea({ value: "", rows: 4, fontSize: 14 }) as ElementLike;
    const editable = findEditable(area);
    if (editable === undefined) throw new Error("editableText missing");
    expect(editable.props.multiline).toBe(true);
    expect(editable.props.height).toBe(4 * 21);
  });
});
