export { SITE_LOCALES, type SiteLocale } from "../../../docs/.vitepress/locales";

import { SITE_LOCALES, type SiteLocale } from "../../../docs/.vitepress/locales";

export function localeForPath(path: string): SiteLocale {
  return (
    SITE_LOCALES.find((locale) => locale.path === path) ??
    SITE_LOCALES.find((locale) => locale.path === "")!
  );
}

/** Returns a static-host-safe URL for a generated documentation route. */
export function pageHref(route: string): string {
  if (route === "/") return route;
  return `${route.replace(/\/$/u, "")}/`;
}
