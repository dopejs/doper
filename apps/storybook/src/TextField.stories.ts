import { TextField, type EditableInputMode } from "@dopejs/pingo";
import type { Meta, StoryObj } from "@storybook/html-vite";

import { mountStory } from "./mount";

interface TextFieldArgs {
  value: string;
  semanticLabel: string;
  error?: string;
  readOnly: boolean;
  password: boolean;
  inputMode: EditableInputMode;
  width: number;
}

const meta: Meta<TextFieldArgs> = {
  title: "Widgets/TextField",
  render: (args) =>
    mountStory(
      () =>
        TextField({
          value: args.value,
          revision: 1n,
          semanticLabel: args.semanticLabel,
          readOnly: args.readOnly,
          password: args.password,
          inputMode: args.inputMode,
          width: args.width,
          ...(args.error === undefined || args.error === "" ? {} : { error: args.error }),
        }),
      { width: args.width + 40, height: 110 },
    ),
  args: {
    value: "订单备注",
    semanticLabel: "订单备注",
    readOnly: false,
    password: false,
    inputMode: "text",
    width: 320,
  },
  argTypes: {
    inputMode: {
      control: "select",
      options: ["text", "email", "numeric", "decimal", "search", "tel", "url", "none"],
    },
    width: { control: { type: "range", min: 160, max: 480, step: 20 } },
    error: { control: "text" },
  },
  parameters: {
    docs: {
      description: {
        component:
          "单行输入。只组合引擎的 editableText 原语，不创建任何 HTML 输入控件；" +
          "caret、选区、IME、剪贴板与撤销重做都由 Core 负责。点击画布内的输入框即可获得焦点。",
      },
    },
  },
};

export default meta;
type Story = StoryObj<TextFieldArgs>;

export const Default: Story = {};

export const WithError: Story = {
  args: { value: "", error: "收件人不能为空", semanticLabel: "收件人" },
};

export const Password: Story = {
  args: { value: "hunter2", password: true, semanticLabel: "密码" },
  parameters: {
    docs: {
      description: {
        story: "密码内容只在 Core 内以遮罩字形绘制，不进入 DisplayList、录制回放或无障碍值。",
      },
    },
  },
};

export const ReadOnly: Story = {
  args: { value: "只读内容", readOnly: true },
};

export const NumericKeyboard: Story = {
  args: { value: "13800000000", inputMode: "numeric", semanticLabel: "电话" },
};
