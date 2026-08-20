import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LanguageMenu } from "./LanguageMenu";
import { SITE_LOCALES } from "./locales";

describe("site language menu", () => {
  let root: Root | undefined;

  afterEach(() => {
    root?.unmount();
    root = undefined;
    document.body.replaceChildren();
  });

  it("matches the shared dopejs language-menu interaction contract", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const onChange = vi.fn<(path: string) => void>();
    root = createRoot(container);
    root.render(createElement(LanguageMenu, { locale: SITE_LOCALES[0]!, onChange }));

    const trigger = await waitForElement<HTMLButtonElement>(
      () => container.querySelector(".language-menu__trigger"),
      "language-menu trigger",
    );
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.textContent).toContain(SITE_LOCALES[0]!.label);

    trigger.click();
    await waitUntil(() => trigger.getAttribute("aria-expanded") === "true");

    const options = [
      ...container.querySelectorAll<HTMLButtonElement>(".language-menu__list button"),
    ];
    expect(options).toHaveLength(SITE_LOCALES.length);
    expect(options[0]!.getAttribute("aria-current")).toBe("true");
    expect(options.map((option) => option.lang)).toEqual(
      SITE_LOCALES.map((candidate) => candidate.lang),
    );

    options[1]!.click();
    await waitUntil(() => trigger.getAttribute("aria-expanded") === "false");
    expect(onChange).toHaveBeenCalledWith(SITE_LOCALES[1]!.path);
  });

  it("closes on Escape and outside clicks while ignoring other keys", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    root.render(
      createElement(LanguageMenu, {
        locale: SITE_LOCALES[0]!,
        onChange: () => undefined,
      }),
    );

    const trigger = await waitForElement<HTMLButtonElement>(
      () => container.querySelector(".language-menu__trigger"),
      "language-menu trigger",
    );
    trigger.click();
    await waitUntil(() => trigger.getAttribute("aria-expanded") === "true");

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await waitUntil(() => trigger.getAttribute("aria-expanded") === "false");

    trigger.click();
    await waitUntil(() => trigger.getAttribute("aria-expanded") === "true");
    document.body.click();
    await waitUntil(() => trigger.getAttribute("aria-expanded") === "false");
  });
});

async function waitForElement<T extends Element>(query: () => T | null, label: string): Promise<T> {
  let result: T | null = null;
  await waitUntil(() => {
    result = query();
    return result !== null;
  }, label);
  return result!;
}

async function waitUntil(predicate: () => boolean, label = "condition"): Promise<void> {
  const deadline = performance.now() + 2_000;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error(`${label} timed out`);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
}
