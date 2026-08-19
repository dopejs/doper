import { describe, expect, it } from "vitest";

import {
  checkShimDependencyDirection,
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

  it("accepts the representative migration fixture and the shim dependency direction", async () => {
    const findings = await scanMigrationSources([
      new URL("../fixtures/migration", import.meta.url).pathname,
    ]);
    expect(findings).toEqual([]);
    expect(await checkShimDependencyDirection()).toEqual([]);
  });
});
