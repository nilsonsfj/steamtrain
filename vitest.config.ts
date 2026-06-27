import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    coverage: {
      provider: "v8",
    },
  },
  // ink-testing-library renders TSX; let esbuild use the automatic JSX runtime.
  esbuild: {
    jsx: "automatic",
    jsxImportSource: "react",
  },
});
