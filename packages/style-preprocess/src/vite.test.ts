import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { build } from "vite";

import { pingoStylePreprocess } from "./vite.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("pingo Vite stylesheet integration", () => {
  it("builds SCSS and Less query modules without emitting or injecting CSS", async () => {
    const root = await fixtureRoot();
    const output = asOutput(
      await build({
        ...baseConfig(root),
        build: {
          lib: { entry: path.join(root, "main.ts"), formats: ["es"] },
          minify: false,
          rollupOptions: { external: ["@dopejs/pingo"] },
          write: false,
        },
      }),
    );
    const chunks = output.output.filter((item) => item.type === "chunk");
    const code = chunks.map(({ code }) => code).join("\n");
    expect(code).toContain('from "@dopejs/pingo"');
    expect(code).toContain(".scss-button:hover");
    expect(code).toContain(".less-button:hover");
    expect(code).toContain('expectedVersion = "1.1.0"');
    expect(
      output.output.some((item) => item.type === "asset" && item.fileName.endsWith(".css")),
    ).toBe(false);
    expect(code).not.toMatch(/compileString|less\.render|@plugin/u);
  });

  it("supports the same query modules in an SSR build", async () => {
    const root = await fixtureRoot();
    const output = asOutput(
      await build({
        ...baseConfig(root),
        build: {
          minify: false,
          rollupOptions: { external: ["@dopejs/pingo"] },
          ssr: path.join(root, "main.ts"),
          write: false,
        },
      }),
    );
    const code = output.output
      .filter((item) => item.type === "chunk")
      .map(({ code: chunkCode }) => chunkCode)
      .join("\n");
    expect(code).toContain("createStyleSheet");
    expect(code).toContain("scss-button");
    expect(code).toContain("less-button");
  });

  it("adds SCSS partials and Less imports to the real watch graph", async () => {
    const root = await fixtureRoot();
    const outputDirectory = path.join(root, "dist-watch");
    const watcher = asWatcher(
      await build({
        ...baseConfig(root),
        build: {
          emptyOutDir: true,
          lib: { entry: path.join(root, "main.ts"), formats: ["es"] },
          minify: false,
          outDir: outputDirectory,
          rollupOptions: {
            external: ["@dopejs/pingo"],
            output: { entryFileNames: "main.js" },
          },
          watch: {},
        },
      }),
    );
    try {
      await waitForBundle(watcher);
      const before = await readFile(path.join(outputDirectory, "main.js"), "utf8");
      await writeFile(path.join(root, "_tokens.scss"), "$primary: #abcdef;\n");
      await waitForBundle(watcher);
      const afterScss = await readFile(path.join(outputDirectory, "main.js"), "utf8");
      expect(afterScss).not.toBe(before);
      expect(afterScss).toContain("#abcdef");

      await writeFile(path.join(root, "tokens.less"), "@primary: #fedcba;\n");
      await waitForBundle(watcher);
      const afterLess = await readFile(path.join(outputDirectory, "main.js"), "utf8");
      expect(afterLess).not.toBe(afterScss);
      expect(afterLess).toContain("#fedcba");
    } finally {
      await watcher.close();
    }
  }, 20_000);

  it("keeps ordinary Vite SCSS/Less imports on the DOM CSS path", async () => {
    const root = await fixtureRoot();
    await writeFile(path.join(root, "dom.ts"), 'import "./shell.scss";\nimport "./probe.less";\n');
    await writeFile(path.join(root, "shell.scss"), "$gap: 6px; .shell { gap: $gap * 2; }\n");
    await writeFile(path.join(root, "probe.less"), "@alpha: 0.5; .probe { opacity: @alpha; }\n");
    const output = asOutput(
      await build({
        root,
        logLevel: "silent",
        build: {
          lib: {
            cssFileName: "styles",
            entry: path.join(root, "dom.ts"),
            formats: ["es"],
          },
          write: false,
        },
      }),
    );
    const css = output.output
      .filter(
        (item): item is OutputAssetLike => item.type === "asset" && item.fileName.endsWith(".css"),
      )
      .map((item) => String(item.source))
      .join("\n");
    expect(css).toContain("gap:12px");
    expect(css).toContain("opacity:.5");
  });
});

function baseConfig(root: string) {
  return {
    root,
    logLevel: "silent" as const,
    plugins: [pingoStylePreprocess()],
  };
}

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "pingo-vite-style-"));
  temporaryRoots.push(root);
  await writeFile(path.join(root, "_tokens.scss"), "$primary: #123456;\n");
  await writeFile(
    path.join(root, "button.scss"),
    '@use "tokens";\n.scss-button { color: tokens.$primary; &:hover { opacity: 0.5; } }\n',
  );
  await writeFile(path.join(root, "tokens.less"), "@primary: #654321;\n");
  await writeFile(
    path.join(root, "button.less"),
    '@import "tokens.less";\n.less-button { color: @primary; &:hover { opacity: 0.5; } }\n',
  );
  await writeFile(
    path.join(root, "main.ts"),
    [
      'import scss from "./button.scss?pingo-style";',
      'import less from "./button.less?pingo-style";',
      "export { less, scss };",
    ].join("\n"),
  );
  return root;
}

interface OutputChunkLike {
  readonly code: string;
  readonly fileName: string;
  readonly type: "chunk";
}

interface OutputAssetLike {
  readonly fileName: string;
  readonly source: string | Uint8Array;
  readonly type: "asset";
}

interface BuildOutputLike {
  readonly output: readonly (OutputAssetLike | OutputChunkLike)[];
}

function asOutput(value: unknown): BuildOutputLike {
  if (Array.isArray(value)) {
    const outputs = value.map(asOutput);
    return { output: outputs.flatMap(({ output }) => output) };
  }
  if (
    typeof value !== "object" ||
    value === null ||
    !("output" in value) ||
    !Array.isArray(value.output)
  ) {
    throw new TypeError("Expected one Vite build output");
  }
  return value as BuildOutputLike;
}

interface WatcherLike {
  close(): Promise<void>;
  on(event: "event", listener: (event: WatchEvent) => void): void;
}

interface WatchEvent {
  readonly code: string;
  readonly error?: Error;
}

function asWatcher(value: unknown): WatcherLike {
  if (
    typeof value !== "object" ||
    value === null ||
    !("on" in value) ||
    typeof value.on !== "function" ||
    !("close" in value) ||
    typeof value.close !== "function"
  ) {
    throw new TypeError("Expected a Vite watcher");
  }
  return value as WatcherLike;
}

function waitForBundle(watcher: WatcherLike): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Timed out waiting for Vite watch build")),
      8000,
    );
    watcher.on("event", (event) => {
      if (event.code === "ERROR") {
        clearTimeout(timeout);
        reject(event.error ?? new Error("Vite watch build failed"));
      } else if (event.code === "BUNDLE_END") {
        clearTimeout(timeout);
        resolve();
      }
    });
  });
}
