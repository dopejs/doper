import { describe, expect, it } from "vitest";

import { isMemoComponent } from "@dopejs/pingo-jsx";

import { Badge } from "./badge";
import { Alert } from "./alert";
import { Avatar } from "./avatar";
import { Button } from "./button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "./card";
import { Divider } from "./divider";
import { IconButton } from "./icon-button";
import { Label } from "./label";
import { Progress } from "./progress";
import { Skeleton } from "./skeleton";
import { Switch } from "./switch";

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
      IconButton,
      Divider,
      Skeleton,
      Alert,
      Avatar,
      Progress,
      Switch,
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
