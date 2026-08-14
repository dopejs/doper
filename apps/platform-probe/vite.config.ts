import { defineConfig } from "vite";

const isolationHeaders = {
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Opener-Policy": "same-origin",
};

export default defineConfig(({ mode }) => {
  const isolated = mode !== "non-isolated";
  return {
    build: {
      sourcemap: true,
      target: "es2022",
    },
    server: {
      ...(isolated ? { headers: isolationHeaders } : {}),
    },
    preview: {
      ...(isolated ? { headers: isolationHeaders } : {}),
    },
  };
});
