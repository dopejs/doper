import { describe, expect, it } from "vitest";

import { isMemoComponent } from "@dopejs/pingo-jsx";

import { Badge } from "./badge";
import { Button } from "./button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "./card";
import { Label } from "./label";

describe("memoized components", () => {
  it("all presentational components are memo-wrapped", () => {
    for (const component of [
      Button,
      Badge,
      Card,
      CardHeader,
      CardTitle,
      CardDescription,
      CardContent,
      CardFooter,
      Label,
    ]) {
      expect(isMemoComponent(component)).toBe(true);
    }
  });

  it("wrapped components keep their descriptor behavior", () => {
    const node = Button.component({ children: "保存" }) as unknown as {
      props: Record<string, unknown>;
    };
    expect(node.props.className).toBe("pui-button pui-button--default");
  });
});
