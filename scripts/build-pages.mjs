import { execFile } from "node:child_process";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(repositoryRoot, "dist-pages");

// GitHub Pages is static hosting and cannot send COOP/COEP headers, so the
// deployed site runs the postMessage/main-thread fallback. The playground and
// the Storybook demos report which transport capability detection selected.
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

// The VitePress site is the root of the deployment and already contains the
// playground page. Storybook keeps its own build and is copied in beside it.
await run("pnpm", ["exec", "vitepress", "build", "docs"], { cwd: repositoryRoot });
await run("pnpm", ["--filter", "@dopejs/storybook", "build"], { cwd: repositoryRoot });

await cp(path.join(repositoryRoot, "docs/.vitepress/dist"), output, { recursive: true });
await cp(path.join(repositoryRoot, "apps/storybook/dist"), path.join(output, "storybook"), {
  recursive: true,
});

const version = JSON.parse(
  await readFile(path.join(repositoryRoot, "packages/facade/package.json"), "utf8"),
).version;

// Jekyll would otherwise drop files and directories starting with an underscore.
await writeFile(path.join(output, ".nojekyll"), "");

await preloadEngineAssets(output);

/**
 * Starts the render worker and the Core WASM downloading with the page.
 *
 * Both are reached only through `await import()` inside the playground
 * component, so without this they queue behind the framework chunk, the theme
 * chunk and the page chunk -- four serialized round trips before the engine
 * begins to load at all. Measured on the deployed site the worker script did
 * not start until nine seconds in. The filenames are content-hashed, so they
 * are discovered from the build rather than hardcoded.
 */
async function preloadEngineAssets(root) {
  const assets = await collectAssets(path.join(root, "assets"));
  const worker = assets.find((asset) => /render-worker-.*\.js$/u.test(asset));
  const wasm = assets.find((asset) => /doper_core_bg-.*\.wasm$/u.test(asset));
  if (worker === undefined || wasm === undefined) {
    throw new Error("pages build is missing the render worker or Core WASM asset");
  }
  // The engine chunk is whichever one names the worker: it is the module that
  // constructs it. Deriving it that way rather than by filename means a
  // rename or a chunking change cannot silently leave a dead preload behind.
  const workerFile = path.basename(worker);
  const candidates = [];
  for (const asset of assets.filter((name) => name.endsWith(".js"))) {
    const source = await readFile(path.join(root, "assets", asset), "utf8");
    if (source.includes(workerFile)) candidates.push(asset);
  }
  const engine = candidates.at(0);
  if (candidates.length !== 1 || engine === undefined) {
    throw new Error(
      `expected exactly one chunk to reference ${workerFile}, found ${String(candidates.length)}`,
    );
  }
  const links = [
    `<link rel="modulepreload" href="/assets/${engine}">`,
    `<link rel="modulepreload" href="/assets/${worker}">`,
    // Fetched by the worker, not the page, so it needs an explicit type and
    // crossorigin to share the preload cache rather than download twice.
    `<link rel="preload" as="fetch" type="application/wasm" crossorigin href="/assets/${wasm}">`,
  ].join("");

  let patched = 0;
  for (const page of await playgroundPages(root)) {
    const html = await readFile(page, "utf8");
    if (html.includes(workerFile)) continue;
    await writeFile(page, html.replace("</head>", `${links}</head>`));
    patched += 1;
  }
  process.stdout.write(`Preloaded engine assets on ${String(patched)} playground pages\n`);
}

/** Returns every built asset path, relative to the assets directory. */
async function collectAssets(root, prefix = "") {
  const found = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      found.push(...(await collectAssets(path.join(root, entry.name), relative)));
    } else {
      found.push(relative);
    }
  }
  return found;
}

/** Returns every localized playground HTML file in the build output. */
async function playgroundPages(root) {
  const pages = [];
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "assets" && entry.name !== "storybook") await walk(full);
      } else if (entry.name === "playground.html") {
        pages.push(full);
      }
    }
  };
  await walk(root);
  return pages;
}

process.stdout.write(`Pages site built at dist-pages (doper v${version})\n`);
