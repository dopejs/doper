# Pingo website

The public website is a Vite-built React application with build-time rendered
Markdown pages. It deliberately does not depend on a documentation framework at
runtime:

- `content.mjs` reads `docs/**/*.md`, parses frontmatter and Markdown, and owns
  source-path to public-URL conversion.
- `src/ssr.tsx` renders every route to complete HTML during `pnpm docs:build`.
- `src/main.tsx` hydrates the static markup for search, theme, navigation, and
  Playground integration.
- All languages share canonical URLs. The selected language is resolved from
  the current origin's local storage, the `dopejs.com` preference cookie, and
  browser language settings; localized source directories are content inputs,
  not public route prefixes.
- Public pages use directory URLs such as `/guide/getting-started/` and
  `/playground/`; `.html` filenames are never part of the public address.
- `src/locale-data.ts` owns the ten locale dictionaries used by the site shell.

Run `pnpm docs:dev` from the repository root to serve the React site on port 5174. Run `pnpm docs:build` for the static output in `apps/site/dist`.

## Runtime fallback boundaries

GitHub Pages receives only static files, so the production Playground still
uses the existing postMessage/main-thread fallback when cross-origin isolation
is unavailable. The site implementation does not change engine capability
detection.
