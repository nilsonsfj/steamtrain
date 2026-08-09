import { defineConfig } from "@playwright/test";

/**
 * End-to-end coverage for the Electron shell and the browser Web UI.
 *
 * Separate from vitest on purpose: everything here launches a real process
 * (Electron or Chromium + the engine), which is slow, needs a display (for
 * Electron on Linux), and cannot run in the same worker pool as thousands of
 * fast unit tests. Vitest's `include` only globs `tests/`, so the two suites
 * never see each other's files.
 *
 * Two projects keep the legs independent:
 *  - `electron` — desktop shell smoke (`e2e/desktop.spec.ts`)
 *  - `web` — Chromium against a real `--web-ui` engine (`e2e/web-*.spec.ts`)
 *
 * CI jobs select a project so the desktop matrix does not need Playwright's
 * Chromium download, and the web job does not need Electron.
 */
export default defineConfig({
  testDir: "e2e",
  // Each test forks an engine that binds a port and writes state. Concurrent
  // workers would work, but a failure would be far harder to read.
  workers: 1,
  fullyParallel: false,
  // Generous: a cold launch resolves a PATH, forks the CLI, waits for the
  // engine to bind, and then waits on UI readiness.
  timeout: 120_000,
  expect: { timeout: 30_000 },
  // No retries. A smoke test that only passes on the second attempt is telling
  // us something, and hiding it behind a retry is how launch flakiness becomes
  // permanent.
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: [["list"]],
  projects: [
    {
      name: "electron",
      testMatch: /desktop\.spec\.ts/,
    },
    {
      name: "web",
      testMatch: /web-.*\.spec\.ts/,
      use: {
        // Headless Chromium is enough: we are asserting product wiring, not
        // visual polish. The desktop project already covers a real windowed
        // shell on Linux (xvfb) and macOS.
        headless: true,
      },
    },
  ],
});
