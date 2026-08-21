import { defineConfig } from "vite";

export default defineConfig({
  build: {
    emptyOutDir: true,
    lib: {
      entry: {
        index: "src/index.ts",
        vite: "src/vite.ts",
      },
      formats: ["es"],
    },
    minify: false,
    rollupOptions: {
      external: [/^node:/u, "@jridgewell/trace-mapping", "less", "sass", "vite"],
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name]-[hash].js",
      },
    },
    sourcemap: true,
    target: "node22",
  },
});
