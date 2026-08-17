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
  // GitHub Pages serves the project site from /doper/playground/.
  base: mode === "pages" ? "/doper/playground/" : "/",
  build: {
    sourcemap: true,
    target: "es2022",
  },
  server: { headers: isolationHeaders },
  preview: { headers: isolationHeaders },
}));
