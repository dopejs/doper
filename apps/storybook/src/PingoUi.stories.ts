import { createElement, type PingoNode } from "@dopejs/pingo";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Input,
  Label,
  createPingoUiStyleSheet,
  setTheme,
  type PingoUiTheme,
} from "@dopejs/pingo-ui";
import type { Meta, StoryObj } from "@storybook/html-vite";

import { mountStory } from "./mount";

interface ShowcaseArgs {
  theme: PingoUiTheme;
}

// flexDirection/alignItems are not CommonProps direct props (the legacy
// direct-prop set covers direction/gap but no cross-axis alignment), so they
// go through the typed inline `style` channel instead.
function row(children: PingoNode[]) {
  return createElement("container", {
    style: { flexDirection: "row", alignItems: "center" },
    children: children.flatMap((node, index) =>
      index === 0 ? [node] : [createElement("container", { width: 8 }), node],
    ),
  });
}

function column(children: PingoNode[]) {
  return createElement("container", {
    style: { flexDirection: "column" },
    children,
  });
}

const meta: Meta<ShowcaseArgs> = {
  title: "pingo-ui/Showcase",
  render: (args) => {
    setTheme(args.theme);
    return mountStory(
      () =>
        createElement("container", {
          width: 460,
          padding: 24,
          style: { flexDirection: "column" },
          backgroundColor: args.theme === "dark" ? "#09090bff" : "#ffffffff",
          children: [
            row([
              Button({ children: "Default", onPress: () => {} }),
              Button({ children: "Secondary", variant: "secondary", onPress: () => {} }),
              Button({ children: "Outline", variant: "outline", onPress: () => {} }),
            ]),
            createElement("container", { height: 12 }),
            row([
              Button({ children: "Ghost", variant: "ghost", onPress: () => {} }),
              Button({ children: "Destructive", variant: "destructive", onPress: () => {} }),
              Button({ children: "Disabled", disabled: true }),
            ]),
            createElement("container", { height: 12 }),
            row([
              Badge({ children: "Default" }),
              Badge({ children: "Secondary", variant: "secondary" }),
              Badge({ children: "Destructive", variant: "destructive" }),
              Badge({ children: "Outline", variant: "outline" }),
            ]),
            createElement("container", { height: 16 }),
            Card({
              children: column([
                CardHeader({
                  children: column([
                    CardTitle({ children: "账户设置" }),
                    CardDescription({ children: "管理你的账户偏好与通知。" }),
                  ]),
                }),
                CardContent({
                  children: column([
                    Label({ children: "邮箱" }),
                    createElement("container", { height: 8 }),
                    // Input uses hooks (useMemo) — it MUST be mounted as a
                    // component via createElement, never called directly.
                    createElement(Input, { semanticLabel: "邮箱", width: 360 }),
                  ]),
                }),
                CardFooter({
                  children: row([
                    Button({ children: "保存", onPress: () => {} }),
                    Button({ children: "取消", variant: "outline", onPress: () => {} }),
                  ]),
                }),
              ]),
            }),
          ],
        }),
      { width: 480, height: 560, styleSheets: [createPingoUiStyleSheet()] },
    );
  },
  args: { theme: "light" },
  argTypes: {
    theme: { control: "radio", options: ["light", "dark"] },
  },
};

export default meta;
type Story = StoryObj<ShowcaseArgs>;

export const Light: Story = { args: { theme: "light" } };
export const Dark: Story = { args: { theme: "dark" } };
