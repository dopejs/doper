import { afterEach, describe, expect, it } from "vitest";

import { setTheme } from "../theme";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "./card";

afterEach(() => setTheme("light"));

type Host = { props: Record<string, unknown> };

describe("Card family", () => {
  it("composes card classes with dark marker", () => {
    setTheme("dark");
    expect((Card({ children: null }) as Host).props.className).toBe("pui-card pui-dark");
  });

  it("each section carries its own skin class", () => {
    expect((CardHeader({ children: null }) as Host).props.className).toBe("pui-card-header");
    expect((CardTitle({ children: "t" }) as Host).props.className).toBe("pui-card-title");
    expect((CardContent({ children: null }) as Host).props.className).toBe("pui-card-content");
    expect((CardFooter({ children: null }) as Host).props.className).toBe("pui-card-footer");
  });

  it("description picks up the dark marker and user className goes last", () => {
    setTheme("dark");
    const node = CardDescription({ children: "d", className: "mine" }) as Host;
    expect(node.props.className).toBe("pui-card-description pui-dark mine");
  });

  it("unthemed sections never subscribe to theme: className identical in light and dark", () => {
    setTheme("light");
    const lightHeader = (CardHeader({ children: null }) as Host).props.className;
    const lightTitle = (CardTitle({ children: "t" }) as Host).props.className;
    const lightContent = (CardContent({ children: null }) as Host).props.className;
    const lightFooter = (CardFooter({ children: null }) as Host).props.className;
    setTheme("dark");
    expect((CardHeader({ children: null }) as Host).props.className).toBe(lightHeader);
    expect((CardTitle({ children: "t" }) as Host).props.className).toBe(lightTitle);
    expect((CardContent({ children: null }) as Host).props.className).toBe(lightContent);
    expect((CardFooter({ children: null }) as Host).props.className).toBe(lightFooter);
    expect(lightHeader).toBe("pui-card-header");
  });

  it("children pass through untouched (slot identity contract)", () => {
    const child = CardTitle({ children: "keep-me" });
    const node = CardHeader({ children: child }) as {
      props: { children: unknown };
    };
    expect(node.props.children).toBe(child);
  });
});
