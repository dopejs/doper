import { createElement, type PingoNode } from "@dopejs/pingo";
import {
  Accordion,
  AccordionItem,
  Alert,
  Avatar,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Checkbox,
  Divider,
  IconButton,
  Input,
  Label,
  Progress,
  RadioGroup,
  RadioGroupItem,
  Skeleton,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  TextArea,
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

function spacer(height: number) {
  return createElement("container", { height });
}

// Labeled field block: pingo has no gap property, so spacing is a fixed
// 8px container between the Label and the control.
function field(label: string, control: PingoNode) {
  return column([createElement(Label, { children: label }), spacer(8), control]);
}

// Every pingo-ui component is a memo-wrapped object (and Input/TextArea/
// RadioGroup/Tabs/Accordion additionally use hooks), so ALL of them are
// rendered via createElement(Component, props) — never called directly.
const meta: Meta<ShowcaseArgs> = {
  title: "pingo-ui/Showcase",
  render: (args) => {
    setTheme(args.theme);
    return mountStory(
      () =>
        createElement("container", {
          width: 520,
          padding: 24,
          style: { flexDirection: "column" },
          backgroundColor: args.theme === "dark" ? "#09090bff" : "#ffffffff",
          children: [
            row([
              createElement(Button, { children: "Default", onPress: () => {} }),
              createElement(Button, { children: "Secondary", variant: "secondary", onPress: () => {} }),
              createElement(Button, { children: "Outline", variant: "outline", onPress: () => {} }),
            ]),
            spacer(12),
            row([
              createElement(Button, { children: "Ghost", variant: "ghost", onPress: () => {} }),
              createElement(Button, { children: "Destructive", variant: "destructive", onPress: () => {} }),
              createElement(Button, { children: "Disabled", disabled: true }),
            ]),
            spacer(12),
            row([
              createElement(Badge, { children: "Default" }),
              createElement(Badge, { children: "Secondary", variant: "secondary" }),
              createElement(Badge, { children: "Destructive", variant: "destructive" }),
              createElement(Badge, { children: "Outline", variant: "outline" }),
            ]),
            spacer(16),
            createElement(Card, {
              children: column([
                createElement(CardHeader, {
                  children: column([
                    createElement(CardTitle, { children: "账户设置" }),
                    createElement(CardDescription, { children: "管理你的账户偏好与通知。" }),
                  ]),
                }),
                createElement(CardContent, {
                  children: column([
                    createElement(Label, { children: "邮箱" }),
                    spacer(8),
                    // Input uses hooks (useMemo) — it MUST be mounted as a
                    // component via createElement, never called directly.
                    createElement(Input, { semanticLabel: "邮箱", width: 360 }),
                  ]),
                }),
                createElement(CardFooter, {
                  children: row([
                    createElement(Button, { children: "保存", onPress: () => {} }),
                    createElement(Button, { children: "取消", variant: "outline", onPress: () => {} }),
                  ]),
                }),
              ]),
            }),
            spacer(16),
            createElement(Card, {
              children: column([
                createElement(CardHeader, {
                  children: column([
                    createElement(CardTitle, { children: "组件总览" }),
                    createElement(CardDescription, {
                      children: "Batch A/B 全部组件。Switch/Checkbox 为受控组件，此处以静态开/关对展示；交互由组件测试覆盖。",
                    }),
                  ]),
                }),
                createElement(CardContent, {
                  children: column([
                    field(
                      "IconButton",
                      row([
                        // The icon slot accepts any PingoNode; a host text
                        // element stands in for a real icon asset here.
                        createElement(IconButton, {
                          icon: createElement("text", { value: "★" }),
                          semanticLabel: "收藏",
                          onPress: () => {},
                        }),
                        createElement(IconButton, {
                          icon: createElement("text", { value: "★" }),
                          semanticLabel: "收藏",
                          variant: "outline",
                          onPress: () => {},
                        }),
                        createElement(IconButton, {
                          icon: createElement("text", { value: "★" }),
                          semanticLabel: "收藏",
                          variant: "ghost",
                          onPress: () => {},
                        }),
                      ]),
                    ),
                    spacer(16),
                    createElement(Divider, {}),
                    spacer(16),
                    field(
                      "Switch",
                      row([
                        createElement(Switch, { checked: true, onCheckedChange: () => {} }),
                        createElement(Switch, { checked: false, onCheckedChange: () => {} }),
                        createElement(Switch, { checked: true, disabled: true }),
                      ]),
                    ),
                    spacer(16),
                    createElement(Divider, {}),
                    spacer(16),
                    field(
                      "Checkbox",
                      column([
                        createElement(Checkbox, { checked: true, label: "已启用通知", onCheckedChange: () => {} }),
                        spacer(8),
                        createElement(Checkbox, { checked: false, label: "接收营销邮件", onCheckedChange: () => {} }),
                        spacer(8),
                        createElement(Checkbox, { checked: false, label: "禁用项", disabled: true }),
                      ]),
                    ),
                    spacer(16),
                    createElement(Divider, {}),
                    spacer(16),
                    field(
                      "RadioGroup",
                      createElement(RadioGroup, {
                        defaultValue: "b",
                        children: column([
                          createElement(RadioGroupItem, { value: "a", label: "选项 A" }),
                          spacer(8),
                          createElement(RadioGroupItem, { value: "b", label: "选项 B" }),
                          spacer(8),
                          createElement(RadioGroupItem, { value: "c", label: "选项 C" }),
                        ]),
                      }),
                    ),
                    spacer(16),
                    createElement(Divider, {}),
                    spacer(16),
                    field(
                      "Tabs",
                      createElement(Tabs, {
                        defaultValue: "account",
                        children: column([
                          createElement(TabsList, {
                            children: row([
                              createElement(TabsTrigger, { value: "account", children: "账户" }),
                              createElement(TabsTrigger, { value: "password", children: "密码" }),
                            ]),
                          }),
                          spacer(8),
                          createElement(TabsContent, {
                            value: "account",
                            children: createElement("text", { value: "管理你的账户信息。" }),
                          }),
                          createElement(TabsContent, {
                            value: "password",
                            children: createElement("text", { value: "修改你的登录密码。" }),
                          }),
                        ]),
                      }),
                    ),
                    spacer(16),
                    createElement(Divider, {}),
                    spacer(16),
                    field(
                      "Accordion",
                      createElement(Accordion, {
                        defaultOpenValue: "one",
                        children: column([
                          createElement(AccordionItem, {
                            value: "one",
                            title: "什么是 pingo-ui？",
                            children: createElement("text", { value: "一套 shadcn 风格的 pingo 组件皮肤。" }),
                          }),
                          createElement(AccordionItem, {
                            value: "two",
                            title: "支持暗色主题吗？",
                            children: createElement("text", { value: "支持，右上角切换 light/dark。" }),
                          }),
                        ]),
                      }),
                    ),
                    spacer(16),
                    createElement(Divider, {}),
                    spacer(16),
                    field(
                      "Alert",
                      column([
                        createElement(Alert, { title: "提示", children: "你的配置已自动保存。" }),
                        spacer(8),
                        createElement(Alert, {
                          title: "出错",
                          variant: "destructive",
                          children: "同步失败，请检查网络后重试。",
                        }),
                      ]),
                    ),
                    spacer(16),
                    createElement(Divider, {}),
                    spacer(16),
                    field(
                      "Avatar",
                      // Storybook has no image asset; the initials fallback
                      // path is the representative one here.
                      createElement(Avatar, { fallback: "ZJ" }),
                    ),
                    spacer(16),
                    createElement(Divider, {}),
                    spacer(16),
                    field("Progress", createElement(Progress, { value: 60 })),
                    spacer(16),
                    createElement(Divider, {}),
                    spacer(16),
                    field(
                      "Skeleton",
                      column([
                        createElement(Skeleton, { width: 320, height: 16 }),
                        spacer(8),
                        createElement(Skeleton, { width: 320, height: 16 }),
                      ]),
                    ),
                    spacer(16),
                    createElement(Divider, {}),
                    spacer(16),
                    field(
                      "TextArea",
                      createElement(TextArea, { semanticLabel: "备注", width: 360, rows: 4 }),
                    ),
                  ]),
                }),
              ]),
            }),
          ],
        }),
      { width: 560, height: 1900, styleSheets: [createPingoUiStyleSheet()] },
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
