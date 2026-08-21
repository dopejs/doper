import { afterEach, describe, expect, it } from "vitest";

import { setTheme } from "../theme";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "./card";

afterEach(() => setTheme("light"));

type Host = { props: Record<string, unknown> };

describe("Card family", () => {
  it("composes card classes with dark marker", () => {
    setTheme("dark");
    expect((Card.component({ children: null }) as Host).props.className).toBe("pui-card pui-dark");
  });

  it("each section carries its own skin class", () => {
    expect((CardHeader.component({ children: null }) as Host).props.className).toBe(
      "pui-card-header",
    );
    expect((CardTitle.component({ children: "t" }) as Host).props.className).toBe("pui-card-title");
    expect((CardContent.component({ children: null }) as Host).props.className).toBe(
      "pui-card-content",
    );
    expect((CardFooter.component({ children: null }) as Host).props.className).toBe(
      "pui-card-footer",
    );
  });

  it("description picks up the dark marker and user className goes last", () => {
    setTheme("dark");
    const node = CardDescription.component({ children: "d", className: "mine" }) as Host;
    expect(node.props.className).toBe("pui-card-description pui-dark mine");
  });

  it("unthemed sections never subscribe to theme: className identical in light and dark", () => {
    setTheme("light");
    const lightHeader = (CardHeader.component({ children: null }) as Host).props.className;
    const lightTitle = (CardTitle.component({ children: "t" }) as Host).props.className;
    const lightContent = (CardContent.component({ children: null }) as Host).props.className;
    const lightFooter = (CardFooter.component({ children: null }) as Host).props.className;
    setTheme("dark");
    expect((CardHeader.component({ children: null }) as Host).props.className).toBe(lightHeader);
    expect((CardTitle.component({ children: "t" }) as Host).props.className).toBe(lightTitle);
    expect((CardContent.component({ children: null }) as Host).props.className).toBe(lightContent);
    expect((CardFooter.component({ children: null }) as Host).props.className).toBe(lightFooter);
    expect(lightHeader).toBe("pui-card-header");
  });

  it("children pass through untouched (slot identity contract)", () => {
    const child = CardTitle.component({ children: "keep-me" });
    const node = CardHeader.component({ children: child }) as unknown as {
      props: { children: unknown };
    };
    expect(node.props.children).toBe(child);
  });
});
