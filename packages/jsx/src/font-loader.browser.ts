import { describe, expect, it } from "vitest";
import { compress } from "woff2-encoder";

import { loadFont } from "./font-loader";

describe("browser font loading", () => {
  it("loads a real WOFF2 through the default lazy decoder", async () => {
    const url = new URL(
      "../../../node_modules/.pnpm/playwright-core@1.62.1/node_modules/playwright-core/lib/vite/traceViewer/codicon.DCmgc-ay.ttf",
      import.meta.url,
    );
    const response = await fetch(url);
    expect(response.ok).toBe(true);
    const sfnt = new Uint8Array(await response.arrayBuffer());
    const font = await loadFont(await compress(sfnt), { fallbackFamily: "Codicon" });
    const decoded = font.copyBytes();
    expect(decoded.byteLength).toBe(sfnt.byteLength);
    expect(decoded.slice(0, 4)).toEqual(Uint8Array.of(0, 1, 0, 0));
    expect(font.fallbackFamily).toBe("Codicon");
  });
});
