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
      reporter: ["text-summary", "json-summary"],
      // Only the product source tree. Worktree checkouts under `.claude/`,
      // Electron, e2e, and the static client bundles would otherwise drown the
      // signal (those client files are exercised via string-eval unit tests,
      // not V8 instrumentation).
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/web/public/**", "**/*.d.ts", "**/steamtrain-reducer.bundle.js"],
      // Soft floor against the current suite. Raise deliberately as coverage
      // grows — the point of Phase 3 is a CI signal, not a perfection chase.
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 60,
        statements: 70,
      },
    },
  },
  // ink-testing-library renders TSX; let esbuild use the automatic JSX runtime.
  esbuild: {
    jsx: "automatic",
    jsxImportSource: "react",
  },
});
