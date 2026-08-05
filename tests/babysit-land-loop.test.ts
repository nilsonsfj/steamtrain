import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BUNDLED_WORKFLOWS } from "../src/workflow/bundled";
import { runWorkflow } from "../src/workflow/engine";
import type { WorkflowEvent } from "../src/workflow/events";
import type { WorkflowSpec } from "../src/workflow/types";

/**
 * The `gate-landed` loop in `babysit-pr`, exercised on its own.
 *
 * The property under test is the one the fan-out depends on: the FIRST PR to
 * reach the land lock wins, and a sibling whose base moved under it re-runs the
 * whole prepare pipeline and lands on a later iteration — instead of the
 * stalemate where every PR was rebased against a base nobody has any more.
 *
 * Structure mirrors babysit-pr exactly (command land step + `{ step, ok }` gate
 * looping to the first phase); the cmds stand in for rebase/prepare/land so the
 * test needs no GitHub and no agent.
 */
function landLoopSpec(counterFile: string, succeedOnAttempt: number): WorkflowSpec {
  const sh = (body: string) => body.replace(/COUNTER/g, JSON.stringify(counterFile));
  return {
    name: "land-loop",
    phases: [
      {
        id: "rebase",
        title: "rebase",
        steps: [{ id: "rebase", kind: "command", cmd: 'echo "rebased"' }],
      },
      {
        id: "prepare",
        title: "prepare",
        steps: [{ id: "prepare", kind: "command", dependsOn: ["rebase"], cmd: 'echo "prepared"' }],
      },
      {
        id: "land",
        title: "land",
        steps: [
          {
            id: "wait-or-merge",
            kind: "command",
            dependsOn: ["prepare"],
            // Fails with babysit's real conflict message until `succeedOnAttempt`.
            cmd: sh(
              `n=$(cat COUNTER); n=$((n+1)); echo "$n" > COUNTER; if [ "$n" -ge ${succeedOnAttempt} ]; then echo "merged PR #42 (squash)"; else echo "PR #42 has merge conflicts with the base branch"; exit 1; fi`,
            ),
          },
        ],
      },
      {
        id: "gate-landed",
        title: "gate-landed",
        steps: [
          {
            id: "landed",
            kind: "gate",
            dependsOn: ["wait-or-merge"],
            condition: { step: "wait-or-merge", ok: true },
            loopTo: "rebase",
            maxIterations: 3,
            onFalse: "continue",
          },
        ],
      },
    ],
  };
}

async function run(spec: WorkflowSpec): Promise<WorkflowEvent[]> {
  const events: WorkflowEvent[] = [];
  for await (const e of runWorkflow(
    spec,
    { input: "babysit PR 42" },
    {
      // Every step here is a command step; no agent is ever constructed.
      createAdapter: () => {
        throw new Error("the land loop must not need an agent adapter");
      },
      maxConcurrency: 2,
      cwd: tmpdir(),
      loopMaxIterations: 10,
    },
  )) {
    events.push(e);
  }
  return events;
}

function counter(): string {
  const file = join(mkdtempSync(join(tmpdir(), "babysit-loop-")), "n");
  writeFileSync(file, "0");
  return file;
}

describe("babysit-pr land loop", () => {
  it("re-prepares and lands a PR whose base a sibling took, and the run is ok", async () => {
    const file = counter();
    const events = await run(landLoopSpec(file, 2));

    const loops = events.filter((e) => e.kind === "loop_iteration");
    expect(loops).toHaveLength(1); // conflicted once, landed on the retry

    // The whole pipeline re-ran — a re-land alone would not have re-rebased.
    for (const stepId of ["rebase", "prepare", "wait-or-merge"]) {
      const starts = events.filter(
        (e) => e.kind === "step_start" && (e as { stepId: string }).stepId === stepId,
      );
      expect(starts, `${stepId} starts`).toHaveLength(2);
    }

    // The first iteration's failure must not survive the loop-back.
    const done = events.find((e) => e.kind === "workflow_done") as { ok: boolean };
    expect(done.ok).toBe(true);
    expect(readFileSync(file, "utf8").trim()).toBe("2");
  });

  it("gives up after the iteration cap and reports the land failure honestly", async () => {
    const file = counter();
    const events = await run(landLoopSpec(file, 99)); // never lands

    expect(events.filter((e) => e.kind === "loop_iteration")).toHaveLength(2); // 3 attempts
    const done = events.find((e) => e.kind === "workflow_done") as { ok: boolean };
    expect(done.ok).toBe(false);
    expect(readFileSync(file, "utf8").trim()).toBe("3");
  });

  it("converges without looping when the first land succeeds", async () => {
    const file = counter();
    const events = await run(landLoopSpec(file, 1));

    expect(events.filter((e) => e.kind === "loop_iteration")).toHaveLength(0);
    const done = events.find((e) => e.kind === "workflow_done") as { ok: boolean };
    expect(done.ok).toBe(true);
  });
});

describe("bundled babysit-pr wiring", () => {
  const spec = BUNDLED_WORKFLOWS["babysit-pr"]!;

  it("loops the land gate back to the rebase phase, not just the land step", () => {
    const gate = spec.phases.at(-1)!.steps[0]!;
    expect(gate).toMatchObject({
      id: "landed",
      kind: "gate",
      loopTo: "rebase",
      onFalse: "continue",
      condition: { step: "wait-or-merge", ok: true },
    });
    expect(spec.phases[0]!.id).toBe("rebase");
  });

  it("only loops in merge mode — report mode never contends for the base", () => {
    const gate = spec.phases.at(-1)!.steps[0]!;
    expect(gate).toHaveProperty("when", { value: "{{inputs.land}}", equals: "merge" });
  });

  it("asks merge-when-ready to replay a mechanical rebase before the loop pays for an agent", () => {
    const land = spec.phases.flatMap((p) => p.steps).find((s) => s.id === "wait-or-merge") as {
      cmd: string;
    };
    expect(land.cmd).toContain("--auto-rebase");
  });
});
