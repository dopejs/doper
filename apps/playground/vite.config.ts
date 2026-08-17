import { defineConfig } from "vite";

// Cross-origin isolation unlocks the SharedArrayBuffer transport locally.
// Static hosts such as GitHub Pages cannot send these headers, so the
// deployed playground exercises the postMessage/main-thread fallback and
// reports which path capability detection selected.
const isolationHeaders = {
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Opener-Policy": "same-origin",
};

export default defineConfig(({ mode }) => ({
  // Relative asset URLs keep the build valid under any deployment prefix,
  // including the /<repo>/playground/ path a GitHub project site serves.
  base: mode === "pages" ? "./" : "/",
  build: {
    sourcemap: true,
    target: "es2022",
  },
  server: { headers: isolationHeaders },
  preview: { headers: isolationHeaders },
}));
