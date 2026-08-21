import { describe, expect, it } from "vitest";

import { isMemoComponent } from "@dopejs/pingo-jsx";

import { Accordion, AccordionItem } from "./accordion";

import { Badge } from "./badge";
import { Alert } from "./alert";
import { Avatar } from "./avatar";
import { Button } from "./button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "./card";
import { Checkbox } from "./checkbox";
import { Divider } from "./divider";
import { IconButton } from "./icon-button";
import { Label } from "./label";
import { Progress } from "./progress";
import { RadioGroup, RadioGroupItem } from "./radio-group";
import { Skeleton } from "./skeleton";
import { Switch } from "./switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./tabs";
import { TextArea } from "./text-area";

describe("memoized components", () => {
  it("all presentational components are memo-wrapped", () => {
    for (const component of [
      Accordion,
      AccordionItem,
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
      Checkbox,
      RadioGroup,
      RadioGroupItem,
      Tabs,
      TabsList,
      TabsTrigger,
      TabsContent,
      TextArea,
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
