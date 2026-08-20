import { describe, expect, it } from "vitest";

import { matchSupportedLanguage } from "./language-preference";

describe("site language preference", () => {
  it("maps simplified and traditional Chinese regions explicitly", () => {
    expect(matchSupportedLanguage("zh-CN")).toBe("");
    expect(matchSupportedLanguage("zh-SG")).toBe("");
    expect(matchSupportedLanguage("zh-TW")).toBe("zh-Hant");
    expect(matchSupportedLanguage("zh-HK")).toBe("zh-Hant");
  });

  it("matches supported languages with regional browser tags", () => {
    expect(matchSupportedLanguage("ja-JP")).toBe("ja");
    expect(matchSupportedLanguage("es-MX")).toBe("es");
    expect(matchSupportedLanguage("AR-sa")).toBe("ar");
  });

  it("ignores unsupported or missing values", () => {
    expect(matchSupportedLanguage("pt-BR")).toBeUndefined();
    expect(matchSupportedLanguage(null)).toBeUndefined();
  });
});
