import { describe, expect, it } from "vitest";

import {
  checkShimDependencyDirection,
  scanM6MigrationHints,
  scanM6Source,
  scanMigrationSources,
  scanSource,
} from "./check-migration.mjs";

describe("migration scanner", () => {
  it("flags internal imports, embedded inputs, and forceUpdate escapes", () => {
    const source = [
      'import { createHostedCanvasRoot } from "@dopejs/pingo-host";',
      'import { createElement } from "@dopejs/pingo";',
      'import { jsx } from "@dopejs/pingo/jsx-runtime";',
      'const input = createElement("input", { value });',
      "widget.forceUpdate();",
    ].join("\n");
    const findings = scanSource("app/page.ts", source);
    expect(findings.map((finding) => finding.rule)).toEqual([
      "internal-package-import",
      "embed-dom-input",
      "force-update",
    ]);
    expect(findings[0]).toMatchObject({ file: "app/page.ts", line: 1 });
  });

  it("reports M6 facade and style migration hints without blocking legacy pages", async () => {
    expect(
      scanM6Source(
        "app/page.ts",
        `createElement("virtualList", { width: 320, itemCount: 100 })`,
      ).map((hint) => hint.rule),
    ).toEqual(["m6-legacy-intrinsic", "m6-legacy-direct-prop"]);
    const hints = await scanM6MigrationHints([
      new URL("../fixtures/migration", import.meta.url).pathname,
    ]);
    expect(hints.some((hint) => hint.detail.includes("View with overflow and virtual"))).toBe(true);
  });

  it("accepts the representative migration fixture and the shim dependency direction", async () => {
    const findings = await scanMigrationSources([
      new URL("../fixtures/migration", import.meta.url).pathname,
    ]);
    expect(findings).toEqual([]);
    expect(await checkShimDependencyDirection()).toEqual([]);
  });
});
