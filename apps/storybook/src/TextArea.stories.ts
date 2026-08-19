import { TextArea } from "@dopejs/pingo";
import type { Meta, StoryObj } from "@storybook/html-vite";

import { mountStory } from "./mount";

interface TextAreaArgs {
  value: string;
  semanticLabel: string;
  rows: number;
  error?: string;
  readOnly: boolean;
  width: number;
}

const meta: Meta<TextAreaArgs> = {
  title: "Widgets/TextArea",
  render: (args) =>
    mountStory(
      () =>
        TextArea({
          value: args.value,
          revision: 1n,
          semanticLabel: args.semanticLabel,
          rows: args.rows,
          readOnly: args.readOnly,
          width: args.width,
          ...(args.error === undefined || args.error === "" ? {} : { error: args.error }),
        }),
      { width: args.width + 40, height: args.rows * 21 + 90 },
    ),
  args: {
    value: "多行文本：\n换行、跨行方向键导航与 desired-x 保持都在 Core 内实现。",
    semanticLabel: "说明",
    rows: 4,
    readOnly: false,
    width: 380,
  },
  argTypes: {
    rows: { control: { type: "range", min: 2, max: 8, step: 1 } },
    width: { control: { type: "range", min: 200, max: 520, step: 20 } },
    error: { control: "text" },
  },
  parameters: {
    docs: {
      description: {
        component:
          "多行输入。Enter 插入换行而不触发 submit；上下方向键跨行移动时保持期望列（desired-x）。",
      },
    },
  },
};

export default meta;
type Story = StoryObj<TextAreaArgs>;

export const Default: Story = {};

export const WithError: Story = {
  args: { value: "", error: "说明至少填写 10 个字" },
};

export const Tall: Story = {
  args: { rows: 8 },
};
