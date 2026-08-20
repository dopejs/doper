import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { App } from "./App";
import type { SiteDocumentPayload } from "./types";

const SITE_DOCUMENT: SiteDocumentPayload = {
  translations: {
    "": {
      page: {
        route: "/api",
        href: "/api/",
        title: "API",
        description: "Public API",
        localePath: "",
        layout: "doc",
        html: "<h1>API</h1>",
        tableOfContents: [],
        lastUpdated: "2026-08-20T00:00:00.000Z",
      },
    },
  },
};

describe("site shell", () => {
  let root: Root | undefined;

  afterEach(() => {
    root?.unmount();
    root = undefined;
    document.body.replaceChildren();
  });

  it("does not expose the removed Storybook application", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    root.render(createElement(App, { siteDocument: SITE_DOCUMENT, initialLocalePath: "" }));

    await waitUntil(() => container.querySelector(".top-nav") !== null);

    expect(container.querySelector('a[href="/storybook/"]')).toBeNull();
    expect(container.querySelector("iframe")).toBeNull();
  });
});

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = performance.now() + 2_000;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error("site shell render timed out");
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
}
