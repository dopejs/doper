import { describe, expect, it } from "vitest";

import { decodeDisplayList } from "./display-list";

describe("DisplayList", () => {
  it("decodes the cross-language golden list", () => {
    const list = decodeDisplayList(
      fromHex(
        "444f504404001000440000000400000001000100040005000000000000000000000020440000f0431000060000008040000000410000c8420000a0410200000002000100",
      ),
    );
    expect(list.commands).toEqual([
      { type: "save" },
      { type: "clipRect", rect: [0, 0, 640, 480] },
      { type: "fillRect", rect: [4, 8, 100, 20], paintId: 2 },
      { type: "restore" },
    ]);
  });

  it("rejects unknown, truncated, and unbalanced streams", () => {
    const golden = fromHex(
      "444f504404001000440000000400000001000100040005000000000000000000000020440000f0431000060000008040000000410000c8420000a0410200000002000100",
    );
    const unknown = golden.slice();
    unknown[16] = 0xff;
    expect(() => decodeDisplayList(unknown)).toThrow(/unknown/u);
    expect(() => decodeDisplayList(golden.slice(0, -1))).toThrow(/aligned/u);

    const underflow = golden.slice();
    underflow[16] = 2;
    expect(() => decodeDisplayList(underflow)).toThrow(/underflows/u);
  });
});

function fromHex(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../gu) ?? [], (byte) => Number.parseInt(byte, 16));
}
