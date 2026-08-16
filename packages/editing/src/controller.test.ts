import { describe, expect, it } from "vitest";

import { TextEditingController } from "./controller";
import type { EditTransaction } from "./edit-transactions";

function transaction(overrides: Partial<EditTransaction> = {}): EditTransaction {
  return {
    baseRevision: 0n,
    delta: { range: { start: 1, end: 1 }, text: "🙂" },
    kind: "edit",
    nodeId: 1,
    revision: 1n,
    selection: {
      anchor: 3,
      anchorAffinity: "downstream",
      focus: 3,
      focusAffinity: "downstream",
    },
    ...overrides,
  };
}

describe("TextEditingController", () => {
  it("applies transactions and ignores a stale revisionless rerender", () => {
    const controller = new TextEditingController({ value: "a" });
    controller.applyTransaction(transaction());
    expect(controller.value).toBe("a🙂");
    expect(controller.revision).toBe(1n);
    expect(controller.selection).toEqual({ anchor: 3, focus: 3 });

    controller.synchronize({ value: "a" });
    expect(controller.value).toBe("a🙂");
    controller.synchronize({ value: "a🙂" });
    expect(controller.value).toBe("a🙂");
  });

  it("accepts a newer external correction and rejects equal-revision conflicts", () => {
    const controller = new TextEditingController({ value: "a", revision: 4n });
    controller.synchronize({ value: "corrected", revision: 5n });
    expect(controller.value).toBe("corrected");
    expect(controller.revision).toBe(5n);
    expect(() => controller.synchronize({ value: "wrong", revision: 5n })).toThrow(
      "equal controller revision",
    );
  });

  it("rejects out-of-order transactions and split surrogate selections", () => {
    const controller = new TextEditingController({ value: "😀" });
    expect(() =>
      controller.applyTransaction({
        baseRevision: 1n,
        kind: "edit",
        nodeId: 1,
        revision: 2n,
        selection: {
          anchor: 2,
          anchorAffinity: "downstream",
          focus: 2,
          focusAffinity: "downstream",
        },
      }),
    ).toThrow("base revision");
    expect(
      () => new TextEditingController({ value: "😀", selection: { anchor: 1, focus: 1 } }),
    ).toThrow("splits a surrogate pair");
  });
});
