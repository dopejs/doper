import { describe, expect, it } from "vitest";

import { applyOtpEdit } from "./input-otp";

describe("applyOtpEdit", () => {
  it("writes one character and advances", () => {
    expect(applyOtpEdit("", 0, "1", 6)).toEqual({ value: "1     ", focus: 1 });
  });

  it("spreads a paste across the remaining slots", () => {
    // A paste lands in one slot but belongs to all of them; a browser autofill
    // looks exactly like this.
    expect(applyOtpEdit("", 0, "123456", 6)).toEqual({ value: "123456", focus: 5 });
    // Focus lands on the slot after the last one written, not on it.
    expect(applyOtpEdit("", 2, "99", 6)).toEqual({ value: "  99  ", focus: 4 });
  });

  it("drops the overflow rather than wrapping it", () => {
    expect(applyOtpEdit("", 4, "123456", 6)).toEqual({ value: "    12", focus: 5 });
  });

  it("clears a slot in place instead of pulling the rest left", () => {
    // Shifting would silently rewrite digits the user did not touch.
    expect(applyOtpEdit("123456", 2, "", 6)).toEqual({ value: "12 456", focus: 2 });
  });

  it("pads to a fixed length so slot i is always value[i]", () => {
    // A dense string cannot express a hole, and a hole is exactly what clearing
    // a middle slot produces.
    expect(applyOtpEdit("", 0, "1", 6).value).toHaveLength(6);
    expect(applyOtpEdit("123456", 2, "", 6).value).toHaveLength(6);
  });

  it("ignores a pasted space rather than storing it as a digit", () => {
    expect(applyOtpEdit("", 0, "1 2", 6)).toEqual({ value: "12    ", focus: 2 });
  });

  it("keeps focus on the last slot when the code is already full", () => {
    expect(applyOtpEdit("123456", 5, "7", 6)).toEqual({ value: "123457", focus: 5 });
  });

  it("overwrites rather than inserting when a filled slot is edited", () => {
    expect(applyOtpEdit("123456", 0, "9", 6)).toEqual({ value: "923456", focus: 1 });
  });
});
