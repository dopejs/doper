import type { PageSummary, SiteDocumentPayload, SitePayload } from "./src/types";

export interface LoadedSiteContent {
  readonly pages: readonly unknown[];
  readonly searchIndex: readonly PageSummary[];
  payloadForPage(page: unknown): SitePayload;
  documentForPage(page: unknown): SiteDocumentPayload;
  payloadForPath(pathname: string): SiteDocumentPayload;
}

export function loadSiteContent(): Promise<LoadedSiteContent>;
