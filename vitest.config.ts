import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    // Git worktree / merge suites routinely need >10s under parallel CI load
    // (spawn + multiple worktree add/remove). Keep hooks in sync so setup
    // fixtures do not time out first.
    testTimeout: 60_000,
    hookTimeout: 60_000,
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
