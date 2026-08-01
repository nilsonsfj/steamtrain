import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PUBLIC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src", "web", "public");

type LiveRun = {
  id: string;
  workflow: string;
  input: string;
  status: string;
  startedAt: number;
  external?: boolean;
};

type FindRecentLiveLaunch = (
  runs: LiveRun[],
  workflow: string,
  input: string,
  launchedAt: number,
) => LiveRun | null;

function loadMatcher(): FindRecentLiveLaunch {
  const source = readFileSync(join(PUBLIC_DIR, "st-run.js"), "utf8");
  const windowStub: {
    Steamtrain: {
      state: Record<string, unknown>;
      run?: { findRecentLiveLaunch?: FindRecentLiveLaunch };
    };
  } = { Steamtrain: { state: {} } };
  const evaluate = new Function("window", source) as (window: typeof windowStub) => void;
  evaluate(windowStub);
  const matcher = windowStub.Steamtrain.run?.findRecentLiveLaunch;
  if (!matcher) throw new Error("st-run.js did not expose launch recovery matcher");
  return matcher;
}

describe("web launch recovery", () => {
  it("selects the newest matching running or queued run", () => {
    const findRecentLiveLaunch = loadMatcher();
    const launchedAt = 100_000;
    const runs: LiveRun[] = [
      {
        id: "older",
        workflow: "demo",
        input: "deploy",
        status: "running",
        startedAt: launchedAt - 1_000,
      },
      {
        id: "newer",
        workflow: "demo",
        input: "deploy",
        status: "queued",
        startedAt: launchedAt + 100,
      },
      {
        id: "done",
        workflow: "demo",
        input: "deploy",
        status: "done",
        startedAt: launchedAt + 200,
      },
    ];

    expect(findRecentLiveLaunch(runs, "demo", "deploy", launchedAt)?.id).toBe("newer");
  });

  it("rejects stale, external, completed, and unrelated runs", () => {
    const findRecentLiveLaunch = loadMatcher();
    const launchedAt = 100_000;
    const runs: LiveRun[] = [
      {
        id: "stale",
        workflow: "demo",
        input: "deploy",
        status: "running",
        startedAt: launchedAt - 30_001,
      },
      {
        id: "external",
        workflow: "demo",
        input: "deploy",
        status: "running",
        startedAt: launchedAt,
        external: true,
      },
      { id: "done", workflow: "demo", input: "deploy", status: "done", startedAt: launchedAt },
      {
        id: "other-input",
        workflow: "demo",
        input: "test",
        status: "running",
        startedAt: launchedAt,
      },
      {
        id: "other-workflow",
        workflow: "other",
        input: "deploy",
        status: "running",
        startedAt: launchedAt,
      },
    ];

    expect(findRecentLiveLaunch(runs, "demo", "deploy", launchedAt)).toBeNull();
  });
});
