export type PageLayout = "doc" | "home" | "playground";

export interface TableOfContentsItem {
  readonly id: string;
  readonly level: 2 | 3;
  readonly title: string;
}

export interface HeroAction {
  readonly text: string;
  readonly link: string;
  readonly theme?: "brand" | "alt";
}

export interface HomeHero {
  readonly name?: string;
  readonly text?: string;
  readonly tagline?: string;
  readonly actions?: readonly HeroAction[];
}

export interface HomeFeature {
  readonly title: string;
  readonly details: string;
}

export interface SitePage {
  readonly route: string;
  readonly href: string;
  readonly title: string;
  readonly description: string;
  readonly localePath: string;
  readonly layout: PageLayout;
  readonly html: string;
  readonly tableOfContents: readonly TableOfContentsItem[];
  readonly lastUpdated: string;
  readonly hero?: HomeHero;
  readonly features?: readonly HomeFeature[];
}

export interface PageSummary {
  readonly route: string;
  readonly href: string;
  readonly title: string;
  readonly description: string;
  readonly localePath: string;
  readonly headings: readonly string[];
  readonly text: string;
}

export interface PageLink {
  readonly href: string;
  readonly title: string;
}

export interface SitePayload {
  readonly page: SitePage;
  readonly previous?: PageLink;
  readonly next?: PageLink;
}

/** All available translations for one canonical, language-neutral URL. */
export interface SiteDocumentPayload {
  readonly translations: Readonly<Record<string, SitePayload>>;
}
