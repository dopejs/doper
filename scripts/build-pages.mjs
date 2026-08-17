import { execFile } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(repositoryRoot, "dist-pages");

// GitHub Pages is static hosting and cannot send COOP/COEP headers, so the
// deployed site runs the postMessage/main-thread fallback. Both apps report
// which transport capability detection selected.
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

await run("pnpm", ["--filter", "@dopejs/playground", "exec", "vite", "build", "--mode", "pages"], {
  cwd: repositoryRoot,
});
await run("pnpm", ["--filter", "@dopejs/storybook", "build"], { cwd: repositoryRoot });

await cp(path.join(repositoryRoot, "apps/playground/dist"), path.join(output, "playground"), {
  recursive: true,
});
await cp(path.join(repositoryRoot, "apps/storybook/dist"), path.join(output, "storybook"), {
  recursive: true,
});

const version = JSON.parse(
  await readFile(path.join(repositoryRoot, "packages/facade/package.json"), "utf8"),
).version;

await writeFile(path.join(output, "index.html"), landingPage(version));
// Jekyll would otherwise drop files and directories starting with an underscore.
await writeFile(path.join(output, ".nojekyll"), "");

process.stdout.write(`Pages site built at dist-pages (doper v${version})\n`);

function landingPage(version) {
  return `<!doctype html>
<html lang="zh">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>doper · canvas rendering engine</title>
    <style>
      :root { color-scheme: dark; }
      body {
        margin: 0; min-height: 100vh; display: grid; place-items: center;
        background: #0f1218; color: #e6ebf2;
        font: 15px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
      }
      main { width: min(720px, 90vw); padding: 40px 0; }
      h1 { margin: 0; font-size: 40px; letter-spacing: -0.02em; }
      .version { color: #5aa9ff; font-size: 14px; font-family: ui-monospace, monospace; }
      p { color: #8d99ab; max-width: 60ch; }
      .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 16px; margin: 32px 0; }
      a.card {
        display: block; padding: 20px; border: 1px solid #232b38; border-radius: 12px;
        background: #161b24; color: inherit; text-decoration: none;
      }
      a.card:hover { border-color: #5aa9ff; }
      a.card strong { display: block; font-size: 16px; margin-bottom: 6px; }
      a.card span { color: #8d99ab; font-size: 13px; }
      .links { display: flex; gap: 16px; font-size: 14px; }
      .links a { color: #5aa9ff; }
      .note { margin-top: 32px; padding: 14px 16px; border-left: 2px solid #232b38; font-size: 13px; }
    </style>
  </head>
  <body>
    <main>
      <h1>doper</h1>
      <p class="version">v${version} · Rust/WASM core + TypeScript shell + Canvas2D backend</p>
      <p>
        面向高性能交互、虚拟滚动与 canvas 原生编辑的 Web 渲染引擎。
        组件树在 TypeScript 侧，Scene 在 Rust 核心；两者通过版本化的二进制流通信。
      </p>
      <div class="cards">
        <a class="card" href="./playground/">
          <strong>Playground →</strong>
          <span>百万行滚动、原生编辑与 IME、命中测试、语义树、降级链，附实时帧指标</span>
        </a>
        <a class="card" href="./storybook/">
          <strong>Storybook →</strong>
          <span>TextField / TextArea / Text 组件目录，可调参数</span>
        </a>
      </div>
      <div class="links">
        <a href="https://github.com/dopejs/doper">GitHub</a>
        <a href="https://www.npmjs.com/package/@dopejs/doper">npm</a>
        <a href="https://github.com/dopejs/doper/blob/main/docs/design.md">设计文档</a>
      </div>
      <p class="note">
        GitHub Pages 无法下发 COOP/COEP 响应头，因此站点上 SharedArrayBuffer 不可用，
        引擎会自动降级到 postMessage 或主线程 Canvas2D 路径——页面里的 transport 标记会显示实际选中的路径。
        本地 <code>pnpm playground:dev</code> 启用跨源隔离后可体验 SAB 路径。
      </p>
    </main>
  </body>
</html>
`;
}
