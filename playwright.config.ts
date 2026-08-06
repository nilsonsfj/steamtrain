import { defineConfig } from "@playwright/test";

/**
 * End-to-end coverage for the Electron shell.
 *
 * Separate from vitest on purpose: everything here launches a real Electron
 * process, which is slow, needs a display, and cannot run in the same worker
 * pool as 2,900 fast unit tests. Vitest's `include` only globs `tests/`, so the
 * two suites never see each other's files.
 *
 * This is deliberately a *smoke* suite. Every decision the main process makes
 * already has a unit test against a pure module; what nothing else can prove is
 * that the wiring holds together well enough for the app to launch at all —
 * which is exactly what #199 turned out to be.
 */
export default defineConfig({
  testDir: "e2e",
  // Each test forks an engine that binds a port and writes to a user-data
  // directory. Running them concurrently would work, but a failure would be far
  // harder to read, and the whole suite is only a couple of launches.
  workers: 1,
  fullyParallel: false,
  // Generous: a cold launch resolves a PATH, forks the CLI, waits for the
  // engine to bind, and then waits on an agent-health probe.
  timeout: 120_000,
  expect: { timeout: 30_000 },
  // No retries. A smoke test that only passes on the second attempt is telling
  // us something, and hiding it behind a retry is how launch flakiness becomes
  // permanent.
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: [["list"]],
});
