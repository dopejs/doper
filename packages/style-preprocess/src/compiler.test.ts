import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  compileLessString,
  compilePingoStyleFile,
  compileScssString,
  createStyleSheetFromLess,
  createStyleSheetFromScss,
  StylePreprocessError,
} from "./index.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("SCSS preprocessing", () => {
  it("expands variables, mixins, loops, arithmetic, and same-node interaction selectors", () => {
    const result = compileScssString(`
      $primary: rgba(51, 102, 153, 0.5);
      @mixin spacing($unit) { padding: $unit ($unit * 2); }
      .button {
        @include spacing(4px);
        color: $primary;
        &:hover { opacity: 0.5; }
      }
      @each $name, $alpha in (quiet: 0.4, loud: 1) {
        .button.#{$name} { opacity: $alpha; }
      }
    `);
    expect(result.styleSheet?.ruleCount).toBe(4);
    expect(result.diagnostics.filter(({ severity }) => severity === "error")).toEqual([]);
    expect(result.cssText).toContain(".button:hover");
    expect(result.dependencies).toEqual([]);
    expect(createStyleSheetFromScss(".button { color: hsl(120, 100%, 50%); }").ruleCount).toBe(1);
  });

  it("normalizes syntax errors and pingo-subset errors without throwing", () => {
    const syntax = compileScssString(".button { color: }");
    expect(syntax.styleSheet).toBeNull();
    expect(syntax.diagnostics[0]).toMatchObject({ stage: "scss", code: "compile-error" });

    const subset = compileScssString(".parent { .child { width: 1rem; } }");
    expect(subset.styleSheet).toBeNull();
    expect(subset.diagnostics).toContainEqual(
      expect.objectContaining({ stage: "pingo-css", code: "unsupported-selector" }),
    );
    expect(subset.diagnostics[0]?.sourceLocation?.line).toBeGreaterThan(0);
    expect(() => createStyleSheetFromScss(".button { width: 1rem; }")).toThrow(
      StylePreprocessError,
    );
  });
});

describe("Less preprocessing", () => {
  it("expands variables, guarded mixins, arithmetic, and same-node interaction selectors", async () => {
    const result = await compileLessString(`
      @primary: rgba(51, 102, 153, 0.5);
      .skin(@alpha) when (@alpha > 0) { opacity: @alpha; }
      .button {
        color: @primary;
        padding: 4px (4px * 2);
        .skin(0.8);
        &:hover { opacity: 0.5; }
      }
    `);
    expect(result.styleSheet?.ruleCount).toBe(2);
    expect(result.diagnostics.filter(({ severity }) => severity === "error")).toEqual([]);
    expect(result.cssText).toContain("padding: 4px 8px");
    expect((await createStyleSheetFromLess(".button { color: #abc; }")).ruleCount).toBe(1);
  });

  it("rejects executable plugins, remote imports, and invalid pingo output", async () => {
    await expect(
      compileLessString('@plugin "code.js"; .button { color: #fff; }'),
    ).resolves.toMatchObject({
      styleSheet: null,
      diagnostics: [expect.objectContaining({ code: "plugin-not-allowed" })],
    });
    await expect(
      compileLessString('@import "https://example.com/theme.less"; .button { color: #fff; }'),
    ).resolves.toMatchObject({
      styleSheet: null,
      diagnostics: [expect.objectContaining({ code: "remote-import-not-allowed" })],
    });
    const javascript = await compileLessString(".button { width: (1 + `process.exit()`); }");
    expect(javascript.styleSheet).toBeNull();
    expect(javascript.diagnostics[0]).toMatchObject({ stage: "less" });
    const subset = await compileLessString(".button { width: 1rem; }");
    expect(subset.diagnostics).toEqual([
      expect.objectContaining({ stage: "pingo-css", code: "unsupported-value" }),
    ]);
  });
});

describe("file preprocessing and dependency boundaries", () => {
  it("tracks SCSS partials and Less imports as canonical dependencies", async () => {
    const root = await temporaryRoot("pingo-style-dependencies-");
    await writeFile(path.join(root, "_tokens.scss"), "$primary: #123456;\n");
    await writeFile(
      path.join(root, "button.scss"),
      '@use "tokens";\n.button { color: tokens.$primary; }\n',
    );
    await writeFile(path.join(root, "tokens.less"), "@primary: #654321;\n");
    await writeFile(
      path.join(root, "button.less"),
      '@import "tokens.less";\n.button { color: @primary; }\n',
    );

    const scss = await compilePingoStyleFile(path.join(root, "button.scss"));
    const less = await compilePingoStyleFile(path.join(root, "button.less"));
    expect(scss.styleSheet?.ruleCount).toBe(1);
    expect(scss.dependencies).toEqual([path.join(root, "_tokens.scss")]);
    expect(less.styleSheet?.ruleCount).toBe(1);
    expect(less.dependencies).toEqual([path.join(root, "tokens.less")]);
  });

  it("maps generated pingo diagnostics back to an SCSS partial", async () => {
    const root = await temporaryRoot("pingo-style-source-map-");
    const partial = path.join(root, "_tokens.scss");
    await writeFile(partial, "@mixin unsupported { width: 1rem; }\n");
    await writeFile(
      path.join(root, "button.scss"),
      '@use "tokens";\n.button { @include tokens.unsupported; }\n',
    );

    const result = await compilePingoStyleFile(path.join(root, "button.scss"));
    expect(result.styleSheet).toBeNull();
    const diagnostic = result.diagnostics.find(({ code }) => code === "unsupported-value");
    expect(diagnostic).toMatchObject({ stage: "pingo-css", code: "unsupported-value" });
    expect(diagnostic?.sourceLocation).toMatchObject({ sourceName: partial, line: 1 });
  });

  it("maps generated pingo diagnostics back to a Less import", async () => {
    const root = await temporaryRoot("pingo-style-less-source-map-");
    const imported = path.join(root, "tokens.less");
    await writeFile(imported, ".unsupported() { width: 1rem; }\n");
    await writeFile(
      path.join(root, "button.less"),
      '@import "tokens.less";\n.button { .unsupported(); }\n',
    );

    const result = await compilePingoStyleFile(path.join(root, "button.less"));
    expect(result.styleSheet).toBeNull();
    const diagnostic = result.diagnostics.find(({ code }) => code === "unsupported-value");
    expect(diagnostic).toMatchObject({ stage: "pingo-css", code: "unsupported-value" });
    expect(diagnostic?.sourceLocation).toMatchObject({ sourceName: imported, line: 1 });
  });

  it("fails closed when an import resolves through a symlink outside the allow root", async () => {
    const root = await temporaryRoot("pingo-style-root-");
    const outside = await temporaryRoot("pingo-style-outside-");
    await writeFile(path.join(outside, "secret.less"), "@secret: #123456;\n");
    await symlink(path.join(outside, "secret.less"), path.join(root, "linked.less"));
    await writeFile(
      path.join(root, "button.less"),
      '@import "linked.less";\n.button { color: @secret; }\n',
    );
    const result = await compilePingoStyleFile(path.join(root, "button.less"));
    expect(result.styleSheet).toBeNull();
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: "dependency-outside-allow-root" }),
    ]);
  });

  it("enforces entry, dependency count, and dependency byte budgets", async () => {
    expect(
      compileScssString(".button { color: #fff; }", { maximumEntryCodeUnits: 4 }).diagnostics,
    ).toEqual([expect.objectContaining({ code: "entry-too-large" })]);

    const root = await temporaryRoot("pingo-style-budget-");
    await writeFile(path.join(root, "tokens.less"), "@primary: #123456;\n");
    await writeFile(
      path.join(root, "button.less"),
      '@import "tokens.less";\n.button { color: @primary; }\n',
    );
    const count = await compilePingoStyleFile(path.join(root, "button.less"), {
      maximumDependencies: 0,
    });
    expect(count.diagnostics).toEqual([
      expect.objectContaining({ code: "dependency-count-exceeded" }),
    ]);
    const bytes = await compilePingoStyleFile(path.join(root, "button.less"), {
      maximumDependencyBytes: 1,
    });
    expect(bytes.diagnostics).toEqual([
      expect.objectContaining({ code: "dependency-bytes-exceeded" }),
    ]);
  });

  it("rejects unsupported file extensions", async () => {
    const root = await temporaryRoot("pingo-style-extension-");
    const filename = path.join(root, "button.css");
    await writeFile(filename, ".button { color: #fff; }\n");
    await expect(compilePingoStyleFile(filename)).rejects.toThrow(/Unsupported/u);
  });
});

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryRoots.push(root);
  await mkdir(root, { recursive: true });
  return root;
}
