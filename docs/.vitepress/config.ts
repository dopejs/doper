import { defineConfig } from "vitepress";

export default defineConfig({
  title: "doper",
  description: "面向高性能交互、虚拟滚动与 canvas 原生编辑的 Web 渲染引擎",
  lang: "zh-CN",
  // Extensionless URLs need host-side rewriting; keeping .html makes the
  // build valid on any static host, including GitHub Pages.
  cleanUrls: false,
  lastUpdated: true,
  srcExclude: ["**/node_modules/**"],
  // The playground and Storybook are separate static apps copied in beside the
  // docs build, so they resolve at runtime but are not VitePress routes.
  ignoreDeadLinks: [/^\/playground\/$/u, /^\/storybook\/$/u],
  head: [["meta", { name: "theme-color", content: "#5aa9ff" }]],
  themeConfig: {
    nav: [
      { text: "指南", link: "/guide/getting-started" },
      { text: "API", link: "/api/" },
      { text: "Playground", link: "/playground" },
      { text: "Storybook", link: "/storybook" },
      {
        text: "工程",
        items: [
          { text: "技术设计", link: "/design" },
          { text: "实施计划", link: "/plan" },
          { text: "ADR", link: "/adr/0006-webgpu-backend-decision" },
        ],
      },
    ],
    sidebar: {
      "/guide/": [
        {
          text: "入门",
          items: [
            { text: "快速开始", link: "/guide/getting-started" },
            { text: "架构概览", link: "/guide/architecture" },
          ],
        },
        {
          text: "能力",
          items: [
            { text: "虚拟滚动", link: "/guide/scrolling" },
            { text: "文本与编辑", link: "/guide/editing" },
            { text: "事件与命中", link: "/guide/events" },
            { text: "无障碍与测试", link: "/guide/accessibility" },
          ],
        },
        {
          text: "上线",
          items: [
            { text: "迁移", link: "/migration" },
            { text: "发布", link: "/release" },
            { text: "诊断", link: "/diagnostics" },
            { text: "运行手册", link: "/runbook" },
          ],
        },
      ],
      "/api/": [{ text: "API", items: [{ text: "公开 API", link: "/api/" }] }],
      "/": [
        {
          text: "工程文档",
          items: [
            { text: "技术设计", link: "/design" },
            { text: "实施计划", link: "/plan" },
            { text: "变更日志", link: "/changelog" },
          ],
        },
      ],
    },
    socialLinks: [
      { icon: "github", link: "https://github.com/dopejs/doper" },
      { icon: "npm", link: "https://www.npmjs.com/package/@dopejs/doper" },
    ],
    search: { provider: "local" },
    outline: { level: [2, 3], label: "本页目录" },
    docFooter: { prev: "上一页", next: "下一页" },
    darkModeSwitchLabel: "外观",
    returnToTopLabel: "回到顶部",
    lastUpdatedText: "最后更新",
    footer: {
      message: "MIT 许可发布",
      copyright: "© 2026 doper contributors",
    },
  },
});
