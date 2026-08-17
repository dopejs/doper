import type { Preview } from "@storybook/html-vite";

const preview: Preview = {
  parameters: {
    controls: { expanded: true },
    options: { storySort: { order: ["Widgets", "Primitives"] } },
  },
};

export default preview;
