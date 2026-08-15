import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts"],
      exclude: [
        "packages/*/src/**/*.test.ts",
        "packages/*/src/**/*.browser.ts",
        "packages/*/src/generated.ts",
        "packages/*/src/index.ts",
        "packages/*/src/jsx-dev-runtime.ts",
        "packages/*/src/jsx-runtime.ts",
      ],
      reporter: ["text", "json-summary"],
      thresholds: {
        lines: 80,
      },
    },
  },
});
