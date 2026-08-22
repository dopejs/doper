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
  Command,
  Dialog,
  ListRow,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Select,
  SelectContent,
  Sidebar,
  SidebarItem,
  SidebarSection,
  StatCard,
  SelectItem,
  SelectTrigger,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  TextArea,
  Toast,
  Tooltip,
  TopBar,
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
              createElement(Button, {
                children: "Secondary",
                variant: "secondary",
                onPress: () => {},
              }),
              createElement(Button, { children: "Outline", variant: "outline", onPress: () => {} }),
            ]),
            spacer(12),
            row([
              createElement(Button, { children: "Ghost", variant: "ghost", onPress: () => {} }),
              createElement(Button, {
                children: "Destructive",
                variant: "destructive",
                onPress: () => {},
              }),
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
                    spacer(8),
                    createElement(Label, { children: "金额" }),
                    spacer(8),
                    // prefix/suffix ride on flexGrow (E5): the field takes the
                    // line that the adornments leave.
                    createElement(Input, {
                      semanticLabel: "金额",
                      width: 360,
                      prefix: "¥",
                      suffix: "CNY",
                    }),
                  ]),
                }),
                createElement(CardFooter, {
                  children: row([
                    createElement(Button, { children: "保存", onPress: () => {} }),
                    createElement(Button, {
                      children: "取消",
                      variant: "outline",
                      onPress: () => {},
                    }),
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
                      children:
                        "Batch A/B 全部组件。Switch/Checkbox 为受控组件，此处以静态开/关对展示；交互由组件测试覆盖。",
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
                        createElement(Checkbox, {
                          checked: true,
                          label: "已启用通知",
                          onCheckedChange: () => {},
                        }),
                        spacer(8),
                        createElement(Checkbox, {
                          checked: false,
                          label: "接收营销邮件",
                          onCheckedChange: () => {},
                        }),
                        spacer(8),
                        createElement(Checkbox, {
                          checked: false,
                          label: "禁用项",
                          disabled: true,
                        }),
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
                            children: createElement("text", {
                              value: "一套 shadcn 风格的 pingo 组件皮肤。",
                            }),
                          }),
                          createElement(AccordionItem, {
                            value: "two",
                            title: "支持暗色主题吗？",
                            children: createElement("text", {
                              value: "支持，右上角切换 light/dark。",
                            }),
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
            spacer(16),
            createElement(Card, {
              children: column([
                createElement(CardHeader, {
                  children: column([
                    createElement(CardTitle, { children: "弹层" }),
                    createElement(CardDescription, {
                      children:
                        "第二批弹层组件。开合与键盘由组件测试覆盖；此处静态展开，展示层叠、锚定与皮肤。",
                    }),
                  ]),
                }),
                createElement(CardContent, {
                  children: column([
                    // An anchored surface is a child of its anchor, so it stays
                    // pinned as the page scrolls with nothing repositioning it.
                    field(
                      "Popover",
                      createElement(Popover, {
                        defaultOpen: true,
                        children: [
                          createElement(PopoverTrigger, {
                            children: createElement(Button, {
                              children: "打开浮层",
                              variant: "outline",
                              onPress: () => {},
                            }),
                          }),
                          createElement(PopoverContent, {
                            children: createElement("text", { value: "锚定在触发器下方。" }),
                          }),
                        ],
                      }),
                    ),
                    spacer(140),
                    createElement(Divider, {}),
                    spacer(16),
                    field(
                      "Select",
                      createElement(Select, {
                        defaultOpen: true,
                        value: "乙",
                        onValueChange: () => {},
                        children: [
                          createElement(SelectTrigger, { placeholder: "选择一项" }),
                          createElement(SelectContent, {
                            children: [
                              createElement(SelectItem, { value: "甲", children: "甲" }),
                              createElement(SelectItem, { value: "乙", children: "乙" }),
                              createElement(SelectItem, { value: "丙", children: "丙" }),
                            ],
                          }),
                        ],
                      }),
                    ),
                    spacer(160),
                    createElement(Divider, {}),
                    spacer(16),
                    field(
                      "Tooltip",
                      createElement(Tooltip, {
                        content: "这是一段说明文字。",
                        children: createElement(Button, {
                          children: "悬停我",
                          variant: "ghost",
                          onPress: () => {},
                        }),
                      }),
                    ),
                    spacer(16),
                    createElement(Divider, {}),
                    spacer(16),
                    field(
                      "Toast",
                      column([
                        createElement(Toast, {
                          open: true,
                          title: "已保存",
                          description: "配置已写入。",
                        }),
                        spacer(8),
                        createElement(Toast, {
                          open: true,
                          title: "同步失败",
                          description: "请检查网络后重试。",
                          variant: "destructive",
                        }),
                      ]),
                    ),
                    spacer(16),
                    createElement(Divider, {}),
                    spacer(16),
                    field(
                      "Command",
                      createElement(Command, {
                        items: [
                          { value: "open", label: "打开文件" },
                          { value: "save", label: "保存文件" },
                          { value: "quit", label: "退出" },
                        ],
                        onSelect: () => {},
                      }),
                    ),
                  ]),
                }),
              ]),
            }),
            spacer(16),
            createElement(Card, {
              children: column([
                createElement(CardHeader, {
                  children: column([
                    createElement(CardTitle, { children: "碰撞感知定位（E8）" }),
                    createElement(CardDescription, {
                      children:
                        "三种会踩到边界的摆放。定位需要 layoutReadbackEnabled；关闭时这三处退回静态方向，" +
                        "位置仍然正确，只是不翻转、不收缩、不隐藏。",
                    }),
                  ]),
                }),
                createElement(CardContent, {
                  children: column([
                    // Near the bottom edge: with readback on, `flip` moves this
                    // above the trigger instead of letting it run off.
                    field(
                      "贴近下边缘（flip）",
                      createElement(Popover, {
                        defaultOpen: true,
                        children: [
                          createElement(PopoverTrigger, {
                            children: createElement(Button, {
                              children: "靠近边缘",
                              variant: "outline",
                              onPress: () => {},
                            }),
                          }),
                          createElement(PopoverContent, {
                            children: createElement("text", {
                              value: "空间不足时翻到上方。",
                            }),
                          }),
                        ],
                      }),
                    ),
                    spacer(140),
                    createElement(Divider, {}),
                    spacer(16),
                    // Inside a scroller: the bound is the scroller, not the
                    // canvas, which a viewport-only rule gets wrong.
                    field(
                      "可滚动容器内（clip 而非视口）",
                      createElement("container", {
                        style: { height: 120, overflowY: "scroll" },
                        children: column([
                          createElement(Popover, {
                            defaultOpen: true,
                            children: [
                              createElement(PopoverTrigger, {
                                children: createElement(Button, {
                                  children: "容器内触发",
                                  variant: "outline",
                                  onPress: () => {},
                                }),
                              }),
                              createElement(PopoverContent, {
                                children: createElement("text", {
                                  value: "被滚动容器裁剪，不是被画布。",
                                }),
                              }),
                            ],
                          }),
                          spacer(200),
                        ]),
                      }),
                    ),
                    spacer(16),
                    createElement(Divider, {}),
                    spacer(16),
                    // A long list is the case `size` exists for: constrain the
                    // panel and let it scroll rather than overflow.
                    field(
                      "长列表（size）",
                      createElement(Select, {
                        defaultOpen: true,
                        children: [
                          createElement(SelectTrigger, { children: "选择一项" }),
                          createElement(SelectContent, {
                            children: Array.from({ length: 24 }, (_, index) =>
                              createElement(SelectItem, {
                                key: String(index),
                                value: String(index),
                                children: `选项 ${String(index + 1)}`,
                              }),
                            ),
                          }),
                        ],
                      }),
                    ),
                    spacer(200),
                  ]),
                }),
              ]),
            }),
            spacer(16),
            createElement(Card, {
              children: column([
                createElement(CardHeader, {
                  children: column([
                    createElement(CardTitle, { children: "产品分子" }),
                    createElement(CardDescription, {
                      children:
                        "第三批。都是第一/二批原子的组合，也是 flexGrow 的第一批真实用法——尾部 slot 由伸缩列推到边缘。",
                    }),
                  ]),
                }),
                createElement(CardContent, {
                  children: column([
                    field(
                      "TopBar",
                      createElement(TopBar, {
                        title: "仪表盘",
                        actions: row([
                          createElement(Button, {
                            children: "新建",
                            variant: "outline",
                            onPress: () => {},
                          }),
                          createElement(Avatar, { fallback: "ZJ", size: 32 }),
                        ]),
                      }),
                    ),
                    spacer(16),
                    createElement(Divider, {}),
                    spacer(16),
                    field(
                      "StatCard",
                      row([
                        createElement(StatCard, {
                          label: "本月营收",
                          value: "¥128,400",
                          delta: "+12.5%",
                          trend: "up",
                          description: "较上月",
                        }),
                        createElement(StatCard, {
                          label: "退款率",
                          value: "1.8%",
                          delta: "-0.4%",
                          trend: "down",
                          description: "较上月",
                        }),
                      ]),
                    ),
                    spacer(16),
                    createElement(Divider, {}),
                    spacer(16),
                    field(
                      "Sidebar",
                      createElement(Sidebar, {
                        defaultValue: "stats",
                        onValueChange: () => {},
                        children: [
                          createElement(SidebarSection, {
                            title: "工作区",
                            children: [
                              createElement(SidebarItem, { value: "home", label: "首页" }),
                              createElement(SidebarItem, { value: "stats", label: "统计" }),
                            ],
                          }),
                          createElement(SidebarSection, {
                            title: "系统",
                            children: createElement(SidebarItem, {
                              value: "settings",
                              label: "设置",
                            }),
                          }),
                        ],
                      }),
                    ),
                    spacer(16),
                    createElement(Divider, {}),
                    spacer(16),
                    field(
                      "ListRow",
                      column([
                        createElement(ListRow, {
                          title: "张三",
                          description: "zhangsan@example.com",
                          leading: createElement(Avatar, { fallback: "张", size: 32 }),
                          trailing: createElement(Badge, { children: "管理员" }),
                          onPress: () => {},
                        }),
                        createElement(ListRow, {
                          title: "李四",
                          description: "lisi@example.com",
                          leading: createElement(Avatar, { fallback: "李", size: 32 }),
                          trailing: createElement(Badge, {
                            children: "只读",
                            variant: "secondary",
                          }),
                          selected: true,
                          onPress: () => {},
                        }),
                        createElement(ListRow, {
                          title: "王五",
                          description: "已停用",
                          leading: createElement(Avatar, { fallback: "王", size: 32 }),
                          disabled: true,
                        }),
                      ]),
                    ),
                  ]),
                }),
              ]),
            }),
            // A viewport overlay fills its own parent, so it is mounted last
            // and on its own rather than inside a card.
            createElement(Dialog, {
              open: false,
              children: createElement("text", { value: "对话框" }),
            }),
          ],
        }),
      { width: 560, height: 3700, styleSheets: [createPingoUiStyleSheet()] },
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
