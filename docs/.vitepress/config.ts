import { defineConfig } from "vitepress";

import { SITE_LOCALES, localeConfig, searchLocale } from "./locales";

const locales = Object.fromEntries(
  SITE_LOCALES.map((locale) => [locale.path === "" ? "root" : locale.path, localeConfig(locale)]),
);

const searchLocales = Object.fromEntries(
  SITE_LOCALES.map((locale) => [locale.path === "" ? "root" : locale.path, searchLocale(locale)]),
);

export default defineConfig({
  title: "doper",
  lastUpdated: true,
  srcExclude: ["**/node_modules/**"],
  // Extensionless URLs need host-side rewriting; keeping .html makes the
  // build valid on any static host, including GitHub Pages.
  cleanUrls: false,
  // Storybook is a separate static build copied in beside the docs output, so
  // it resolves at runtime but is not a VitePress route.
  ignoreDeadLinks: [/^\/storybook\/$/u],
  head: [["meta", { name: "theme-color", content: "#5aa9ff" }]],
  // The playground links to itself in ten locales plus every guide page, and
  // prefetching all of them saturates the connection before the engine chunk
  // and the render worker are even requested. Measured on the deployed site,
  // blocking those route chunks roughly halved time-to-first-frame. On disk
  // they cost nothing, which is why this never showed up locally.
  router: { prefetchLinks: false },
  locales,
  themeConfig: {
    search: { provider: "local", options: { locales: searchLocales } },
  },
});
