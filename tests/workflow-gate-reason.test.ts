import { describe, expect, it } from "vitest";
import {
  type StepResult,
  type WorkflowDeps,
  type WorkflowEvent,
  type WorkflowSpec,
  runWorkflow,
} from "../src/workflow";

/**
 * A gate's `output` is what humans read — and, when the gate is the last step
 * of a sub-workflow, it is that whole child run's reported result. The bare
 * word "blocked" was all `babysit-all-prs` printed per PR: with the default
 * `onFalse: "continue"` the gate is `ok`, so the result carries no `error` and
 * the reason had nowhere to live. `target` stays the bare routing label.
 */

function deps(): WorkflowDeps {
  return {
    createAdapter: () => {
      throw new Error("this workflow must not create agent adapters");
    },
    maxConcurrency: 4,
    cwd: process.cwd(),
  };
}

async function results(
  spec: WorkflowSpec,
  inputs?: Record<string, string>,
): Promise<Map<string, StepResult>> {
  const map = new Map<string, StepResult>();
  const events: WorkflowEvent[] = [];
  for await (const ev of runWorkflow(spec, { input: "the run input", inputs }, deps()))
    events.push(ev);
  for (const ev of events) if (ev.kind === "step_done") map.set(ev.stepId, ev.result);
  return map;
}

describe("gate reasons", () => {
  it("names the failing step and its error when an ok: gate blocks", async () => {
    // babysit-pr's shape: the land step failed, the gate continues, and this
    // text is the only surviving account of why the PR did not land.
    const spec: WorkflowSpec = {
      name: "ok-gate",
      phases: [
        {
          id: "p1",
          title: "Land",
          steps: [
            {
              id: "land",
              kind: "command",
              cmd: "echo 'PR #441 is closed without being merged' >&2; exit 1",
            },
          ],
        },
        {
          id: "p2",
          title: "Landed?",
          steps: [
            {
              id: "landed",
              kind: "gate",
              dependsOn: ["land"],
              condition: { step: "land", ok: true },
              onFalse: "continue",
            },
          ],
        },
      ],
    };
    const landed = (await results(spec)).get("landed");
    expect(landed?.target).toBe("blocked");
    expect(landed?.output).toContain("blocked:");
    expect(landed?.output).toContain("step 'land'");
    expect(landed?.output).toContain("expected ok=true");
  });

  it("reports the actual text an equals gate saw", async () => {
    const spec: WorkflowSpec = {
      name: "equals-gate",
      inputs: { mode: { default: "report" } },
      phases: [
        {
          id: "p1",
          title: "Route",
          steps: [
            {
              id: "route",
              kind: "gate",
              condition: { value: "{{inputs.mode}}", equals: "merge" },
              onFalse: "continue",
            },
          ],
        },
      ],
    };
    const route = (await results(spec, { mode: "report" })).get("route");
    expect(route?.output).toContain('is "report", expected "merge"');
  });

  it("leaves a passing gate's output as the bare routing label", async () => {
    const spec: WorkflowSpec = {
      name: "passing-gate",
      phases: [
        {
          id: "p1",
          title: "Route",
          steps: [
            {
              id: "route",
              kind: "gate",
              condition: { value: "go", equals: "go" },
              onFalse: "continue",
            },
          ],
        },
      ],
    };
    const route = (await results(spec)).get("route");
    expect(route?.output).toBe("passed");
    expect(route?.target).toBe("passed");
  });

  it("does not explain a negated gate with the reasons its inner condition failed", async () => {
    // `not` blocks when the condition HELD, so the collected reasons (why it
    // did not hold) would read backwards.
    const spec: WorkflowSpec = {
      name: "not-gate",
      phases: [
        {
          id: "p1",
          title: "Route",
          steps: [
            {
              id: "route",
              kind: "gate",
              condition: { value: "go", equals: "go", not: true },
              onFalse: "continue",
            },
          ],
        },
      ],
    };
    const route = (await results(spec)).get("route");
    expect(route?.output).toContain("not: true");
    expect(route?.output).not.toContain("expected");
  });
});
