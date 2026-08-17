import DefaultTheme from "vitepress/theme";
import type { Theme } from "vitepress";

import AppFrame from "./AppFrame.vue";

// The playground and Storybook stay standalone static apps; embedding them
// through a registered component keeps one shared site header without
// duplicating their build into the docs bundle.
export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component("AppFrame", AppFrame);
  },
} satisfies Theme;
