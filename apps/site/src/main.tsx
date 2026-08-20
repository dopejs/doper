import { createRoot, hydrateRoot } from "react-dom/client";

import { App } from "./App";
import { readLanguagePreference } from "./language-preference";
import { localeForPath } from "./locales";
import "./styles.css";
import type { SiteDocumentPayload } from "./types";

async function payload(): Promise<{
  readonly embedded: boolean;
  readonly value: SiteDocumentPayload;
}> {
  const embedded = document.querySelector<HTMLScriptElement>("#pingo-site-payload");
  if (embedded?.textContent !== null && embedded?.textContent !== undefined) {
    return { embedded: true, value: JSON.parse(embedded.textContent) as SiteDocumentPayload };
  }
  const endpoint = new URL("/__pingo/site-page", location.origin);
  endpoint.searchParams.set("path", location.pathname);
  const response = await fetch(endpoint);
  if (!response.ok) throw new Error(`site page: ${String(response.status)}`);
  return { embedded: false, value: (await response.json()) as SiteDocumentPayload };
}

const container = document.querySelector("#root");
if (container === null) throw new Error("Pingo site root is missing");

void payload().then(({ embedded, value }) => {
  const localePath = readLanguagePreference();
  const locale = localeForPath(localePath);
  document.documentElement.lang = locale.lang;
  document.documentElement.dir = locale.dir ?? "ltr";
  const app = <App siteDocument={value} initialLocalePath={localePath} />;
  if (embedded && localePath === "") {
    hydrateRoot(container, app);
  } else {
    container.replaceChildren();
    createRoot(container).render(app);
  }
});
