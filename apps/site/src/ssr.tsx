import { renderToString } from "react-dom/server";

import { App } from "./App";
import type { SiteDocumentPayload } from "./types";

export function render(siteDocument: SiteDocumentPayload): string {
  return renderToString(<App siteDocument={siteDocument} initialLocalePath="" />);
}
