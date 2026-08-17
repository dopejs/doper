import DefaultTheme from "vitepress/theme";
import type { Theme } from "vitepress";

import AppFrame from "./AppFrame.vue";
import Playground from "./playground/Playground.vue";

// The playground is part of the site itself: it mounts the engine directly in a
// page component, so it shares the header, router and theme with the docs.
// Storybook stays a separate build and is embedded through AppFrame, because it
// is a foreign tool with its own shell.
export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component("AppFrame", AppFrame);
    app.component("Playground", Playground);
  },
} satisfies Theme;
