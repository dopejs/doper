import { describe, expect, it } from "vitest";

import { cva } from "./cva";

const buttonClass = cva({
  base: "pui-button",
  variants: {
    variant: {
      default: "pui-button--default",
      secondary: "pui-button--secondary",
      ghost: "pui-button--ghost",
    },
    size: {
      default: "",
      sm: "pui-button--sm",
      lg: "pui-button--lg",
    },
    theme: {
      light: "",
      dark: "pui-dark",
    },
  },
  compoundVariants: [
    { when: { variant: "ghost", theme: "dark" }, className: "pui-button--ghost-dark" },
  ],
  defaultVariants: { variant: "default", size: "default", theme: "light" },
});

describe("cva", () => {
  it("composes base with default variants and skips empty classes", () => {
    expect(buttonClass()).toBe("pui-button pui-button--default");
  });

  it("applies explicit variants in config key order", () => {
    expect(buttonClass({ variant: "secondary", size: "sm" })).toBe(
      "pui-button pui-button--secondary pui-button--sm",
    );
  });

  it("emits dark marker and matching compound variants", () => {
    expect(buttonClass({ variant: "ghost", theme: "dark" })).toBe(
      "pui-button pui-button--ghost pui-dark pui-button--ghost-dark",
    );
  });

  it("explicit props override defaults; unknown values contribute nothing", () => {
    expect(buttonClass({ variant: "default", size: "lg" })).toBe(
      "pui-button pui-button--default pui-button--lg",
    );
  });

  it("is deterministic across calls", () => {
    expect(buttonClass({ variant: "ghost", theme: "dark" })).toBe(
      buttonClass({ theme: "dark", variant: "ghost" }),
    );
  });
});
