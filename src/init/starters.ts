import type { AgentInstanceId } from "../types/events";
import type { CommandStep, WorkflowSpec, WorkflowStep } from "../workflow/types";
import type { DetectedCheck } from "./detect";

/**
 * Starter workflows `steamtrain init` offers, built from what detection found
 * in THIS repo — so the very first workflows a new user owns gate on their
 * real test/lint commands rather than placeholder prompts.
 */

/**
 * Agentless verification: every detected check runs as a parallel `command`
 * step (a failing check fails the run, so the exit code is an honest CI
 * signal), then an agentless consolidator renders the combined report.
 */
export function buildVerifyWorkflow(checks: DetectedCheck[]): WorkflowSpec {
  const steps: WorkflowStep[] = checks.map(
    (check): CommandStep => ({ id: check.id, kind: "command", cmd: check.cmd }),
  );
  const sections = checks
    .map((check) => `--- ${check.label} ---\n{{steps.${check.id}.output}}`)
    .join("\n\n");
  return {
    name: "verify",
    description: `Run this repo's checks (${checks.map((c) => c.label).join(", ")}) as parallel steps, then report. Agentless — costs $0.`,
    phases: [
      {
        id: "checks",
        title: "Run every detected check in parallel",
        steps,
      },
      {
        id: "report",
        title: "Combined report",
        steps: [
          {
            id: "report",
            kind: "consolidator",
            dependsOn: checks.map((check) => check.id),
            prompt: `Check results for: {{input}}\n\n${sections}`,
          },
        ],
      },
    ],
  };
}

/**
 * The trust pipeline: an agent implements the task in an isolated worktree,
 * the repo's real test command re-runs against those edits (worktree
 * inheritance), a gate blocks anything that doesn't pass, and a merge step
 * applies only verified changes to the checkout.
 */
export function buildImplementVerifiedWorkflow(
  agent: AgentInstanceId,
  model: string,
  test: DetectedCheck,
): WorkflowSpec {
  return {
    name: "implement-verified",
    description: `Agent (${agent}) implements the task in an isolated worktree, ${test.label} verifies the edits, and only verified changes are applied to your checkout.`,
    phases: [
      {
        id: "implement",
        title: "Implement in an isolated worktree",
        steps: [
          {
            id: "impl",
            kind: "worker",
            agent,
            model,
            prompt:
              "Implement the following task in this repository. Keep the change focused and consistent with the existing code style. Do not commit.\n\nTask: {{input}}",
          },
        ],
      },
      {
        id: "verify",
        title: `Verify with ${test.label}`,
        steps: [
          {
            id: "test",
            kind: "command",
            dependsOn: ["impl"],
            workspace: "inherit:impl",
            cmd: test.cmd,
          },
        ],
      },
      {
        id: "gate",
        title: "Only verified changes proceed",
        steps: [
          {
            id: "tests-pass",
            kind: "gate",
            dependsOn: ["test"],
            condition: { step: "test", ok: true },
            target: "verified",
            onFalse: "fail",
          },
        ],
      },
      {
        id: "land",
        title: "Apply verified changes to your checkout",
        steps: [
          {
            id: "land",
            kind: "merge",
            dependsOn: ["tests-pass"],
            from: ["impl"],
            mode: "apply",
          },
        ],
      },
    ],
  };
}
