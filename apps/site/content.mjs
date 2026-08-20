import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import matter from "gray-matter";
import MarkdownIt from "markdown-it";
import anchor from "markdown-it-anchor";
import container from "markdown-it-container";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const docsRoot = path.join(repositoryRoot, "docs");
const localePaths = ["zh-Hant", "ja", "ko", "es", "fr", "de", "ru", "ar", "he"];

function contentSourcePath(sourcePath) {
  const segments = sourcePath.split("/");
  if (localePaths.includes(segments[0])) segments.shift();
  return segments.join("/");
}

function routeForSource(sourcePath) {
  const withoutExtension = contentSourcePath(sourcePath).replace(/\.md$/u, "");
  if (withoutExtension === "index") return "/";
  if (withoutExtension.endsWith("/index")) return `/${withoutExtension.slice(0, -6)}`;
  return `/${withoutExtension}`;
}

function hrefForRoute(route) {
  return route === "/" ? route : `${route}/`;
}

function localeForSource(sourcePath) {
  const first = sourcePath.split("/")[0];
  return localePaths.includes(first) ? first : "";
}

function splitSuffix(value) {
  const index = value.search(/[?#]/u);
  return index === -1 ? [value, ""] : [value.slice(0, index), value.slice(index)];
}

function normalizeMarkdownLink(value, sourcePath) {
  if (/^(?:[a-z]+:|#|\/\/)/iu.test(value)) return value;
  const [pathname, suffix] = splitSuffix(value);
  if (pathname.startsWith("/")) {
    const segments = pathname.split("/").filter(Boolean);
    if (localePaths.includes(segments[0])) segments.shift();
    const canonical =
      segments.length === 0 ? "/" : `/${segments.join("/")}${pathname.endsWith("/") ? "/" : ""}`;
    if (canonical === "/" || path.posix.extname(canonical) !== "") {
      return `${canonical}${suffix}`;
    }
    return `${hrefForRoute(canonical.replace(/\/$/u, ""))}${suffix}`;
  }
  if (!pathname.endsWith(".md")) return value;
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(sourcePath), pathname));
  if (resolved.startsWith("../")) return value;
  return `${hrefForRoute(routeForSource(resolved))}${suffix}`;
}

function slugify(value) {
  return value
    .trim()
    .toLocaleLowerCase()
    .replace(/[^\p{Letter}\p{Number}\s_-]/gu, "")
    .replace(/[\s_]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

function createMarkdown() {
  const markdown = new MarkdownIt({ html: true, linkify: true });
  markdown.use(anchor, { slugify });
  for (const name of ["tip", "warning", "danger", "info", "details"]) {
    markdown.use(container, name, {
      render(tokens, index) {
        if (tokens[index].nesting === 1) {
          const title = tokens[index].info.trim().slice(name.length).trim() || name;
          return `<div class="callout callout--${name}"><p class="callout__title">${markdown.utils.escapeHtml(title)}</p>\n`;
        }
        return "</div>\n";
      },
    });
  }
  const originalLink = markdown.renderer.rules.link_open;
  markdown.renderer.rules.link_open = (tokens, index, options, environment, self) => {
    const href = tokens[index].attrGet("href");
    if (href !== null) {
      tokens[index].attrSet("href", normalizeMarkdownLink(href, environment.sourcePath));
      if (/^https?:/u.test(href)) {
        tokens[index].attrSet("target", "_blank");
        tokens[index].attrSet("rel", "noreferrer");
      }
    }
    return (
      originalLink?.(tokens, index, options, environment, self) ??
      self.renderToken(tokens, index, options)
    );
  };
  return markdown;
}

async function markdownFiles(directory, prefix = "") {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...(await markdownFiles(path.join(directory, entry.name), relative)));
    } else if (entry.name.endsWith(".md")) {
      files.push(relative);
    }
  }
  return files.sort();
}

function inlineText(token) {
  if (token.type !== "inline") return "";
  return token.content
    .replace(/<[^>]+>/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function pageLayout(route, frontmatter) {
  if (frontmatter.layout === "home") return "home";
  if (route.endsWith("/playground") || route === "/playground") return "playground";
  return "doc";
}

function navigationOrder() {
  return [
    "/guide/getting-started",
    "/guide/architecture",
    "/guide/scrolling",
    "/guide/editing",
    "/guide/events",
    "/guide/accessibility",
    "/api",
    "/changelog",
  ];
}

function requestRoute(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    decoded = pathname;
  }
  if (decoded === "/" || decoded === "/index.html") return "/";
  if (decoded.endsWith("/index.html")) return decoded.slice(0, -11);
  return decoded.replace(/\/+$/u, "");
}

export async function loadSiteContent() {
  const markdown = createMarkdown();
  const pages = [];
  for (const sourcePath of await markdownFiles(docsRoot)) {
    const absolute = path.join(docsRoot, sourcePath);
    const [source, metadata] = await Promise.all([readFile(absolute, "utf8"), stat(absolute)]);
    const parsed = matter(source);
    const environment = { sourcePath };
    const tokens = markdown.parse(parsed.content, environment);
    const headings = [];
    const tableOfContents = [];
    let firstHeading = "";
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (token.type !== "heading_open") continue;
      const level = Number(token.tag.slice(1));
      const title = inlineText(tokens[index + 1]);
      if (firstHeading === "" && title !== "") firstHeading = title;
      if (title !== "") headings.push(title);
      if ((level === 2 || level === 3) && title !== "") {
        tableOfContents.push({ id: token.attrGet("id") ?? slugify(title), level, title });
      }
    }
    const route = routeForSource(sourcePath);
    const layout = pageLayout(route, parsed.data);
    const hero = parsed.data.hero;
    const title = parsed.data.title ?? hero?.name ?? firstHeading ?? hero?.text ?? "Pingo";
    const description = parsed.data.description ?? hero?.tagline ?? "";
    const plainText = tokens.map(inlineText).filter(Boolean).join(" ").slice(0, 8_000);
    pages.push({
      route,
      href: hrefForRoute(route),
      sourcePath,
      title,
      description,
      localePath: localeForSource(sourcePath),
      layout,
      html:
        layout === "playground"
          ? ""
          : markdown.renderer.render(tokens, markdown.options, environment),
      tableOfContents,
      lastUpdated: metadata.mtime.toISOString(),
      ...(hero === undefined ? {} : { hero }),
      ...(parsed.data.features === undefined ? {} : { features: parsed.data.features }),
      headings,
      plainText,
    });
  }

  const byRoute = new Map();
  for (const page of pages) {
    const translations = byRoute.get(page.route) ?? new Map();
    if (translations.has(page.localePath)) {
      throw new Error(`duplicate ${page.localePath || "zh-Hans"} source for ${page.route}`);
    }
    translations.set(page.localePath, page);
    byRoute.set(page.route, translations);
  }
  const payloadForPage = (page) => {
    const order = navigationOrder();
    const index = order.indexOf(page.route);
    const pageInLocale = (route) => {
      const translations = byRoute.get(route);
      return translations?.get(page.localePath) ?? translations?.get("");
    };
    const previousPage = index > 0 ? pageInLocale(order[index - 1]) : undefined;
    const nextPage =
      index >= 0 && index < order.length - 1 ? pageInLocale(order[index + 1]) : undefined;
    const publicPage = {
      route: page.route,
      href: page.href,
      title: page.title,
      description: page.description,
      localePath: page.localePath,
      layout: page.layout,
      html: page.html,
      tableOfContents: page.tableOfContents,
      lastUpdated: page.lastUpdated,
      ...(page.hero === undefined ? {} : { hero: page.hero }),
      ...(page.features === undefined ? {} : { features: page.features }),
    };
    return {
      page: publicPage,
      ...(previousPage === undefined
        ? {}
        : { previous: { href: previousPage.href, title: previousPage.title } }),
      ...(nextPage === undefined ? {} : { next: { href: nextPage.href, title: nextPage.title } }),
    };
  };

  const documents = [...byRoute.entries()].map(([route, translations]) => {
    const defaultPage = translations.get("") ?? translations.values().next().value;
    if (defaultPage === undefined) throw new Error(`site route ${route} has no content`);
    return defaultPage;
  });
  const documentForPage = (page) => {
    const translations = byRoute.get(page.route);
    if (translations === undefined) throw new Error(`unknown site route ${page.route}`);
    return {
      translations: Object.fromEntries(
        [...translations.entries()].map(([localePath, translation]) => [
          localePath,
          payloadForPage(translation),
        ]),
      ),
    };
  };
  const root = byRoute.get("/")?.get("");
  if (root === undefined) throw new Error("site content is missing docs/index.md");
  return {
    pages: documents,
    searchIndex: pages.map((page) => ({
      route: page.route,
      href: page.href,
      title: page.title,
      description: page.description,
      localePath: page.localePath,
      headings: page.headings,
      text: page.plainText,
    })),
    payloadForPage,
    documentForPage,
    payloadForPath(pathname) {
      const translations = byRoute.get(requestRoute(pathname));
      return documentForPage(translations?.get("") ?? root);
    },
  };
}
