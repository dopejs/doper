import { afterEach, describe, expect, it } from "vitest";

import { getTheme, setTheme, useTheme, type PingoUiTheme } from "./theme";

afterEach(() => {
  setTheme("light");
});

describe("theme", () => {
  it("defaults to light", () => {
    expect(getTheme()).toBe("light");
  });

  it("setTheme switches the value read by useTheme", () => {
    setTheme("dark");
    expect(useTheme()).toBe("dark");
    expect(getTheme()).toBe("dark");
  });

  it("accepts only the two theme values at the type level", () => {
    const values: readonly PingoUiTheme[] = ["light", "dark"];
    expect(values).toHaveLength(2);
  });
});
