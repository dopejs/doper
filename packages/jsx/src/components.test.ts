import { describe, expect, it } from "vitest";

import { Image, Input, Text, TextArea, Video, View } from "./components";
import { createImage } from "./image";

describe("foundation component compatibility adapters", () => {
  it("maps View, Text, and Image to the existing host contract", () => {
    const image = createImage(new Uint8Array([1, 2, 3, 4]), 1, 1);
    expect(View({ width: 10, children: Text({ value: "child" }) })).toMatchObject({
      type: "container",
      props: { width: 10 },
    });
    expect(Text({ value: "hello", fontSize: 14 })).toMatchObject({
      type: "text",
      props: { value: "hello", fontSize: 14 },
    });
    expect(Image({ source: image })).toMatchObject({
      type: "image",
      props: { source: image },
    });
  });

  it("maps Video to the dedicated media host contract", () => {
    const poster = createImage(new Uint8Array([1, 2, 3, 4]), 1, 1);
    expect(Video({ src: "movie.mp4", poster, muted: true, loop: true })).toMatchObject({
      type: "video",
      props: { src: "movie.mp4", poster, muted: true, loop: true },
    });
  });

  it("uses one editable primitive with immutable single/multiline semantics", () => {
    const shared = { value: "hello", revision: 3n, semanticLabel: "Editor" };
    expect(Input(shared)).toMatchObject({
      type: "editableText",
      props: { ...shared, multiline: false },
    });
    expect(TextArea(shared)).toMatchObject({
      type: "editableText",
      props: { ...shared, multiline: true },
    });
    expect(shared).toEqual({ value: "hello", revision: 3n, semanticLabel: "Editor" });
  });

  it("overrides a forged multiline field instead of exposing an escape hatch", () => {
    const forged = { value: "", revision: 0n, multiline: true };
    expect(Input(forged as never).props.multiline).toBe(false);
    expect(TextArea({ ...forged, multiline: false } as never).props.multiline).toBe(true);
  });
});
