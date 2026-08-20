import { useEffect, useState, type ReactNode } from "react";

import { AppFrame } from "./AppFrame";
import { SITE_LOCALES, localeForPath, pageHref, type SiteLocale } from "./locales";
import { writeLanguagePreference } from "./language-preference";
import { Playground } from "./playground/Playground";
import { SearchDialog } from "./SearchDialog";
import type { PageLink, SiteDocumentPayload, SitePage, SitePayload } from "./types";

interface AppProps {
  readonly siteDocument: SiteDocumentPayload;
  readonly initialLocalePath: string;
}

interface NavItem {
  readonly text: string;
  readonly route: string;
}

interface NavSection {
  readonly text: string;
  readonly items: readonly NavItem[];
}

function linkFor(route: string): string {
  if (/^(?:https?:|mailto:|#)/u.test(route)) return route;
  const hashIndex = route.indexOf("#");
  const localizedBase = hashIndex === -1 ? route : route.slice(0, hashIndex);
  const hash = hashIndex === -1 ? "" : route.slice(hashIndex);
  const segments = localizedBase.split("/").filter(Boolean);
  if (SITE_LOCALES.some((locale) => locale.path !== "" && locale.path === segments[0])) {
    segments.shift();
  }
  const base =
    segments.length === 0 ? "/" : `/${segments.join("/")}${localizedBase.endsWith("/") ? "/" : ""}`;
  return `${pageHref(base)}${hash}`;
}

function navItems(locale: SiteLocale): readonly NavItem[] {
  return [
    { text: locale.ui.guide, route: "/guide/getting-started" },
    { text: locale.ui.api, route: "/api" },
    { text: locale.ui.playground, route: "/playground" },
    { text: locale.ui.storybook, route: "/storybook" },
  ];
}

function sidebarSections(page: SitePage, locale: SiteLocale): readonly NavSection[] {
  if (page.route.includes("/guide/")) {
    return [
      {
        text: locale.ui.sectionStart,
        items: [
          { text: locale.ui.gettingStarted, route: "/guide/getting-started" },
          { text: locale.ui.architecture, route: "/guide/architecture" },
        ],
      },
      {
        text: locale.ui.sectionCapabilities,
        items: [
          { text: locale.ui.scrolling, route: "/guide/scrolling" },
          { text: locale.ui.editing, route: "/guide/editing" },
          { text: locale.ui.events, route: "/guide/events" },
          { text: locale.ui.accessibility, route: "/guide/accessibility" },
        ],
      },
      {
        text: locale.ui.sectionShipping,
        items: [
          { text: locale.ui.migration, route: "/migration" },
          { text: locale.ui.release, route: "/release" },
          { text: locale.ui.diagnostics, route: "/diagnostics" },
          { text: locale.ui.runbook, route: "/runbook" },
        ],
      },
    ];
  }
  if (page.route === "/api") {
    return [
      {
        text: locale.ui.api,
        items: [{ text: locale.ui.publicApi, route: "/api" }],
      },
    ];
  }
  return [
    {
      text: locale.ui.sectionEngineering,
      items: [
        { text: locale.ui.design, route: "/design" },
        { text: locale.ui.plan, route: "/plan" },
        { text: locale.ui.adr, route: "/adr/0007-css-events-and-foundation-components" },
        { text: locale.ui.changelog, route: "/changelog" },
      ],
    },
  ];
}

function SiteHeader({
  page,
  locale,
  onLocaleChange,
}: {
  page: SitePage;
  locale: SiteLocale;
  onLocaleChange: (path: string) => void;
}): ReactNode {
  const [menuOpen, setMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);

  useEffect(() => {
    const openSearch = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", openSearch);
    return () => window.removeEventListener("keydown", openSearch);
  }, []);

  const toggleTheme = (): void => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    localStorage.setItem("pingo-theme", next);
  };

  return (
    <>
      <header className="site-header">
        <a className="brand" href="/" aria-label="Pingo home">
          <picture>
            <source srcSet="/pingo-mark-dark.svg" media="(prefers-color-scheme: dark)" />
            <img src="/pingo-mark.svg" width="30" height="30" alt="" />
          </picture>
          <span>Pingo</span>
        </a>
        <nav className={menuOpen ? "top-nav top-nav--open" : "top-nav"} aria-label="Primary">
          {navItems(locale).map((item) => (
            <a
              key={item.route}
              href={linkFor(item.route)}
              aria-current={page.route === item.route ? "page" : undefined}
            >
              {item.text}
            </a>
          ))}
          <details className="engineering-menu">
            <summary>{locale.ui.engineering}</summary>
            <div>
              <a href={pageHref("/design")}>{locale.ui.design}</a>
              <a href={pageHref("/plan")}>{locale.ui.plan}</a>
              <a href={pageHref("/adr/0007-css-events-and-foundation-components")}>
                {locale.ui.adr}
              </a>
            </div>
          </details>
        </nav>
        <div className="header-tools">
          <button className="search-trigger" type="button" onClick={() => setSearchOpen(true)}>
            <span aria-hidden="true">⌕</span>
            <span>{locale.ui.searchButton}</span>
            <kbd>⌘ K</kbd>
          </button>
          <select
            className="locale-select"
            aria-label={locale.ui.languageMenu}
            value={locale.path}
            onChange={(event) => {
              onLocaleChange(event.currentTarget.value);
            }}
          >
            {SITE_LOCALES.map((candidate) => (
              <option key={candidate.path || "root"} value={candidate.path}>
                {candidate.label}
              </option>
            ))}
          </select>
          <button
            className="icon-button"
            type="button"
            aria-label={locale.ui.darkMode}
            title={locale.ui.appearance}
            onClick={toggleTheme}
          >
            ◐
          </button>
          <a
            className="icon-button github-link"
            href="https://github.com/dopejs/pingo"
            aria-label="GitHub"
          >
            GH
          </a>
          <button
            className="mobile-menu-button"
            type="button"
            aria-expanded={menuOpen}
            aria-label={locale.ui.menu}
            onClick={() => setMenuOpen((value) => !value)}
          >
            {menuOpen ? "×" : "☰"}
          </button>
        </div>
      </header>
      <SearchDialog locale={locale} open={searchOpen} onClose={() => setSearchOpen(false)} />
    </>
  );
}

function Sidebar({ page, locale }: { page: SitePage; locale: SiteLocale }): ReactNode {
  return (
    <aside className="sidebar" aria-label={locale.ui.sidebarMenu}>
      {sidebarSections(page, locale).map((section) => (
        <section key={section.text}>
          <h2>{section.text}</h2>
          {section.items.map((item) => (
            <a
              key={item.route}
              href={linkFor(item.route)}
              aria-current={page.route === item.route ? "page" : undefined}
            >
              {item.text}
            </a>
          ))}
        </section>
      ))}
    </aside>
  );
}

function PageOutline({ page, locale }: { page: SitePage; locale: SiteLocale }): ReactNode {
  if (page.tableOfContents.length === 0) return null;
  return (
    <aside className="page-outline" aria-label={locale.ui.outline}>
      <h2>{locale.ui.outline}</h2>
      {page.tableOfContents.map((item) => (
        <a key={item.id} className={`outline-level-${String(item.level)}`} href={`#${item.id}`}>
          {item.title}
        </a>
      ))}
    </aside>
  );
}

function Pagination({ previous, next, locale }: SitePayload & { locale: SiteLocale }): ReactNode {
  if (previous === undefined && next === undefined) return null;
  const item = (link: PageLink | undefined, direction: "previous" | "next"): ReactNode =>
    link === undefined ? (
      <span />
    ) : (
      <a className={`page-link page-link--${direction}`} href={link.href}>
        <small>{direction === "previous" ? locale.ui.previousPage : locale.ui.nextPage}</small>
        <strong>{link.title}</strong>
      </a>
    );
  return (
    <nav className="pagination" aria-label="Pagination">
      {item(previous, "previous")}
      {item(next, "next")}
    </nav>
  );
}

function HomePage({ page }: { page: SitePage }): ReactNode {
  const hero = page.hero;
  return (
    <main className="home-page">
      <section className="home-hero">
        <div className="home-hero__copy">
          <span className="eyebrow">Rust · WASM · TypeScript</span>
          <h1>
            <span>{hero?.name ?? "Pingo"}</span>
            {hero?.text ?? page.title}
          </h1>
          <p>{hero?.tagline ?? page.description}</p>
          <div className="hero-actions">
            {hero?.actions?.map((action) => (
              <a
                key={action.text}
                className={action.theme === "brand" ? "button button--brand" : "button"}
                href={linkFor(action.link)}
              >
                {action.text}
              </a>
            ))}
          </div>
        </div>
        <div className="home-hero__mark" aria-hidden="true">
          <img src="/pingo-mark.svg" alt="" />
          <div className="orbit orbit--one" />
          <div className="orbit orbit--two" />
        </div>
      </section>
      <section className="features" aria-label="Features">
        {page.features?.map((feature, index) => (
          <article key={feature.title}>
            <span>{String(index + 1).padStart(2, "0")}</span>
            <h2>{feature.title}</h2>
            <p>{feature.details}</p>
          </article>
        ))}
      </section>
      <article
        className="doc-content home-content"
        dangerouslySetInnerHTML={{ __html: page.html }}
      />
    </main>
  );
}

function SiteFooter({ locale }: { locale: SiteLocale }): ReactNode {
  return (
    <footer className="site-footer">
      <span>{locale.ui.footerMessage}</span>
      <span>© 2026 Pingo contributors</span>
    </footer>
  );
}

export function App({ siteDocument, initialLocalePath }: AppProps): ReactNode {
  const [localePath, setLocalePath] = useState(initialLocalePath);
  const payload =
    siteDocument.translations[localePath] ??
    siteDocument.translations[""] ??
    Object.values(siteDocument.translations)[0]!;
  const { page } = payload;
  const locale = localeForPath(localePath);
  const special = page.layout === "playground" || page.layout === "storybook";
  const changeLocale = (path: string): void => {
    const next = localeForPath(path).path;
    writeLanguagePreference(next);
    setLocalePath(next);
    document.documentElement.lang = localeForPath(next).lang;
    document.documentElement.dir = localeForPath(next).dir ?? "ltr";
  };

  let content: ReactNode;
  if (page.layout === "home") {
    content = <HomePage page={page} />;
  } else if (page.layout === "playground") {
    content = <Playground lang={locale.lang} />;
  } else if (page.layout === "storybook") {
    content = <AppFrame src="/storybook-app/" title={page.title} />;
  } else {
    content = (
      <div className="docs-grid">
        <Sidebar page={page} locale={locale} />
        <main className="doc-main">
          <article className="doc-content" dangerouslySetInnerHTML={{ __html: page.html }} />
          <p className="last-updated">
            {locale.ui.lastUpdated}:{" "}
            <time dateTime={page.lastUpdated}>{page.lastUpdated.slice(0, 10)}</time>
          </p>
          <Pagination {...payload} locale={locale} />
        </main>
        <PageOutline page={page} locale={locale} />
      </div>
    );
  }

  return (
    <div className={special ? "site site--full" : "site"} dir={locale.dir ?? "ltr"}>
      <SiteHeader page={page} locale={locale} onLocaleChange={changeLocale} />
      {content}
      {!special && <SiteFooter locale={locale} />}
    </div>
  );
}
