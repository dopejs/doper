import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { loadSiteContent } from "../apps/site/content.mjs";

const run = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const siteRoot = path.join(repositoryRoot, "apps/site");
const output = path.join(siteRoot, "dist");
const serverOutput = path.join(siteRoot, ".ssr");
const localeMetadata = {
  "": { lang: "zh-Hans", dir: "ltr" },
  "zh-Hant": { lang: "zh-Hant", dir: "ltr" },
  "ja": { lang: "ja", dir: "ltr" },
  "ko": { lang: "ko", dir: "ltr" },
  "es": { lang: "es", dir: "ltr" },
  "fr": { lang: "fr", dir: "ltr" },
  "de": { lang: "de", dir: "ltr" },
  "ru": { lang: "ru", dir: "ltr" },
  "ar": { lang: "ar", dir: "rtl" },
  "he": { lang: "he", dir: "rtl" },
};

function escapeAttribute(value) {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

function embeddedJson(value) {
  return JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll("-->", "--\\u003e");
}

function outputPathForRoute(route) {
  if (route === "/") return "index.html";
  return `${route.slice(1)}/index.html`;
}

await rm(output, { recursive: true, force: true });
await rm(serverOutput, { recursive: true, force: true });

try {
  await run("pnpm", ["exec", "vite", "build", "--config", "apps/site/vite.config.ts"], {
    cwd: repositoryRoot,
  });
  await run(
    "pnpm",
    [
      "exec",
      "vite",
      "build",
      "--config",
      "apps/site/vite.config.ts",
      "--ssr",
      "src/ssr.tsx",
      "--outDir",
      ".ssr",
      "--emptyOutDir",
    ],
    { cwd: repositoryRoot },
  );

  const [{ render }, template, content] = await Promise.all([
    import(pathToFileURL(path.join(serverOutput, "ssr.js")).href),
    readFile(path.join(output, "index.html"), "utf8"),
    loadSiteContent(),
  ]);

  for (const page of content.pages) {
    const siteDocument = content.documentForPage(page);
    const rendered = render(siteDocument);
    const metadata = localeMetadata[""];
    const title = page.layout === "home" ? "Pingo" : `${page.title} | Pingo`;
    const description = page.description || "Pingo Web canvas rendering engine";
    const html = template
      .replace('<html lang="zh-Hans">', `<html lang="${metadata.lang}" dir="${metadata.dir}">`)
      .replace("<title>Pingo</title>", `<title>${escapeAttribute(title)}</title>`)
      .replace(
        /<meta name="description" content="Pingo Web canvas rendering engine" \/?>/u,
        `<meta name="description" content="${escapeAttribute(description)}">`,
      )
      .replace(
        '<div id="root"></div>',
        `<div id="root">${rendered}</div><script id="pingo-site-payload" type="application/json">${embeddedJson(siteDocument)}</script>`,
      );
    const target = path.join(output, outputPathForRoute(page.route));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, html);
  }

  const searchDirectory = path.join(output, "__pingo");
  await mkdir(searchDirectory, { recursive: true });
  await writeFile(
    path.join(searchDirectory, "search-index.json"),
    JSON.stringify(content.searchIndex),
  );
  process.stdout.write(`React site built: ${String(content.pages.length)} static pages\n`);
} finally {
  await rm(serverOutput, { recursive: true, force: true });
}
