import { createElement, type Color } from "@dopejs/pingo";
import type { Meta, StoryObj } from "@storybook/html-vite";

import { mountStory } from "./mount";

interface TextArgs {
  value: string;
  fontSize: number;
  lineHeight: number;
  color: Color;
}

const meta: Meta<TextArgs> = {
  title: "Primitives/Text",
  render: (args) =>
    mountStory(
      () =>
        createElement("container", {
          width: 460,
          height: 120,
          backgroundColor: "#ffffffff",
          padding: 16,
          children: createElement("text", {
            value: args.value,
            fontSize: args.fontSize,
            lineHeight: args.lineHeight,
            color: args.color,
          }),
        }),
      { width: 460, height: 120 },
    ),
  args: {
    value: "pingo 文本原语：shaping、换行与 caret 几何都来自 Core。",
    fontSize: 16,
    lineHeight: 24,
    color: "#1f2329ff",
  },
  argTypes: {
    fontSize: { control: { type: "range", min: 10, max: 40, step: 1 } },
    lineHeight: { control: { type: "range", min: 12, max: 56, step: 2 } },
    color: { control: "text" },
  },
};

export default meta;
type Story = StoryObj<TextArgs>;

export const Default: Story = {};

export const Large: Story = {
  args: { fontSize: 28, lineHeight: 40 },
};

export const Muted: Story = {
  args: { color: "#8a94a3ff", fontSize: 13, lineHeight: 20 },
};
