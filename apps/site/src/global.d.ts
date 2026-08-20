import type { SiteDocumentPayload } from "./types";

declare global {
  interface Window {
    __PINGO_SITE_PAYLOAD__?: SiteDocumentPayload;
  }
}

export {};
