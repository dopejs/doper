import type { StorybookConfig } from "@storybook/html-vite";

const config: StorybookConfig = {
  stories: ["../src/**/*.stories.ts"],
  framework: { name: "@storybook/html-vite", options: {} },
  addons: [],
  viteFinal: (config) => ({
    ...config,
    // Cross-origin isolation unlocks the SharedArrayBuffer transport locally.
    // GitHub Pages cannot send these headers, so the deployed catalog runs on
    // the postMessage/main-thread fallback instead.
    server: {
      ...config.server,
      headers: {
        "Cross-Origin-Embedder-Policy": "require-corp",
        "Cross-Origin-Opener-Policy": "same-origin",
      },
    },
  }),
};

export default config;
