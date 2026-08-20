# Pingo website

The public website is a Vite-built React application with build-time rendered
Markdown pages. It deliberately does not depend on a documentation framework at
runtime:

- `content.mjs` reads `docs/**/*.md`, parses frontmatter and Markdown, and owns
  source-path to public-URL conversion.
- `src/ssr.tsx` renders every route to complete HTML during `pnpm docs:build`.
- `src/main.tsx` hydrates the static markup for search, theme, navigation,
  Playground, and Storybook integration.
- All languages share canonical URLs. The selected language is resolved from
  the current origin's local storage, the `dopejs.com` preference cookie, and
  browser language settings; localized source directories are content inputs,
  not public route prefixes.
- Public pages use directory URLs such as `/guide/getting-started/` and
  `/playground/`; `.html` filenames are never part of the public address.
- `docs/.vitepress/locales.ts` remains the temporary shared source for the ten
  locale dictionaries while the legacy VitePress rollback build exists.

Run `pnpm docs:dev` from the repository root to serve the React site on port 5174. Run `pnpm docs:build` for the static output in `apps/site/dist`.

## Failure and rollback boundaries

GitHub Pages receives only static files, so the production Playground still
uses the existing postMessage/main-thread fallback when cross-origin isolation
is unavailable. The site migration does not change engine capability
detection.

Until the React build has shipped successfully, `pnpm docs:build:vitepress` and
`pnpm docs:dev:vitepress` retain the previous site as an explicit rollback
path. They are not used by the default development or Pages deployment flow.
