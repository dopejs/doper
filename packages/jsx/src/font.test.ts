import { describe, expect, it } from "vitest";

import { createFont } from "./font";

describe("explicit font handles", () => {
  it("copies source and returned resource bytes", () => {
    const source = Uint8Array.of(0x4f, 0x54, 0x54, 0x4f, 1, 2, 3, 4);
    const font = createFont(source, { faceIndex: 2, fallbackFamily: "Inter" });
    source[4] = 99;
    const first = font.copyBytes();
    first[5] = 88;

    expect(font.copyBytes()).toEqual(Uint8Array.of(0x4f, 0x54, 0x54, 0x4f, 1, 2, 3, 4));
    expect(font.faceIndex).toBe(2);
    expect(font.fallbackFamily).toBe("Inter");
  });

  it("rejects encoded web fonts and invalid metadata", () => {
    expect(() => createFont(new TextEncoder().encode("wOF2invalid"))).toThrow(/decoded/u);
    expect(() => createFont(Uint8Array.of(0x4f, 0x54, 0x54, 0x4f), { faceIndex: -1 })).toThrow(
      /faceIndex/u,
    );
    expect(() => createFont(Uint8Array.of(0x4f, 0x54, 0x54, 0x4f), { fallbackFamily: "" })).toThrow(
      /fallbackFamily/u,
    );
  });
});
