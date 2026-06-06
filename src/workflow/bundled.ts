import type { WorkflowSpec } from "./types";

/**
 * Built-in workflows — steamtrain's analog of Claude Code's bundled
 * `/deep-research`. Each one shows the core value: heterogeneous steps (a mix
 * of agents and models) that fan out, then an independent agent cross-checks
 * the results before they converge into one answer.
 *
 * Models match the dev defaults: claude uses `claude-…` ids; opencode uses
 * `provider/model` and must be an authenticated provider. Steps run in the
 * session cwd by default — to target other repos/dirs, add a per-step `cwd`
 * (and optional `env` / `extraArgs`), e.g.:
 *
 *   { id: "scan-api", agent: "claude", model: "claude-sonnet-4-6",
 *     cwd: "../api-service", env: { FOO: "bar" }, extraArgs: ["--add-dir", "."],
 *     prompt: "Audit {{input}} in this repo" }
 */

const multiPlan: WorkflowSpec = {
  name: "multi-plan",
  description:
    "Draft a plan from independent angles, stress-test it, then synthesize the strongest version.",
  phases: [
    {
      id: "scope",
      title: "Distribute planning lenses",
      steps: [
        {
          id: "planning-lenses",
          kind: "distributor",
          items: [
            "correctness lens: validate invariants, edge cases, and existing patterns for {{input}}",
            "pragmatic lens: minimize risk and surface assumptions for {{input}}",
          ],
        },
      ],
    },
    {
      id: "draft",
      title: "Draft plans from independent angles",
      steps: [
        {
          id: "draft-correctness",
          kind: "worker",
          agent: "claude",
          model: "claude-sonnet-4-6",
          dependsOn: ["planning-lenses"],
          prompt:
            "Draft a concise, step-by-step implementation plan for the task below. Optimize for correctness, simplicity, and reuse of existing patterns. List concrete files/steps.\n\nPlanning lenses:\n{{steps.planning-lenses.items}}\n\nTask: {{input}}",
        },
        {
          id: "draft-pragmatic",
          kind: "worker",
          agent: "opencode",
          model: "openai/gpt-5.4-mini",
          dependsOn: ["planning-lenses"],
          prompt:
            "Draft a concise, step-by-step implementation plan for the task below. Optimize for speed of delivery and pragmatism; call out the riskiest assumptions.\n\nPlanning lenses:\n{{steps.planning-lenses.items}}\n\nTask: {{input}}",
        },
      ],
    },
    {
      id: "critique",
      title: "Adversarial critique of both drafts",
      steps: [
        {
          id: "critique",
          kind: "consolidator",
          agent: "claude",
          model: "claude-opus-4-8",
          dependsOn: ["draft-correctness", "draft-pragmatic"],
          prompt:
            "You are a skeptical reviewer. Critique these two plans for the same task. Identify gaps, risks, and where each is stronger. Be specific and adversarial.\n\nTask: {{input}}\n\n--- PLAN A (correctness-first) ---\n{{steps.draft-correctness.output}}\n\n--- PLAN B (pragmatic) ---\n{{steps.draft-pragmatic.output}}",
        },
      ],
    },
    {
      id: "synthesize",
      title: "Synthesize the strongest plan",
      steps: [
        {
          id: "synthesize",
          kind: "consolidator",
          agent: "claude",
          model: "claude-sonnet-4-6",
          dependsOn: ["draft-correctness", "draft-pragmatic", "critique"],
          prompt:
            "Using the two drafts and the critique below, produce a single, final implementation plan that takes the strongest parts of each and addresses the critique. Output only the final plan.\n\nTask: {{input}}\n\n--- PLAN A ---\n{{steps.draft-correctness.output}}\n\n--- PLAN B ---\n{{steps.draft-pragmatic.output}}\n\n--- CRITIQUE ---\n{{steps.critique.output}}",
        },
      ],
    },
  ],
};

const bugHunt: WorkflowSpec = {
  name: "bug-hunt",
  description:
    "Sweep a scope for distinct bug classes in parallel, cross-check findings, then report the real ones.",
  phases: [
    {
      id: "scan",
      title: "Parallel scan for distinct bug classes",
      steps: [
        {
          id: "scan-logic",
          kind: "worker",
          agent: "claude",
          model: "claude-sonnet-4-6",
          prompt:
            "Hunt for logic and edge-case bugs in the scope below: off-by-one errors, incorrect conditionals, unhandled cases, race conditions. For each finding give file:line, why it's a bug, and a fix. Scope: {{input}}",
        },
        {
          id: "scan-errors",
          kind: "worker",
          agent: "opencode",
          model: "openai/gpt-5.4-mini",
          prompt:
            "Hunt for error-handling and resource bugs in the scope below: swallowed errors, missing awaits, leaked handles/processes, unchecked failures. For each finding give file:line, the risk, and a fix. Scope: {{input}}",
        },
        {
          id: "scan-security",
          kind: "worker",
          agent: "claude",
          model: "claude-haiku-4-5-20251001",
          prompt:
            "Hunt for security issues in the scope below: missing input validation, injection, unsafe shell/exec, missing authz checks. For each finding give file:line, the risk, and a fix. Scope: {{input}}",
        },
      ],
    },
    {
      id: "cross-check",
      title: "Cross-check and filter false positives",
      steps: [
        {
          id: "cross-check",
          kind: "consolidator",
          agent: "claude",
          model: "claude-opus-4-8",
          dependsOn: ["scan-logic", "scan-errors", "scan-security"],
          prompt:
            "Review these three independent bug reports for the same scope. Merge duplicates, discard false positives and anything you can't substantiate, and keep only findings you're confident are real. Scope: {{input}}\n\n--- LOGIC ---\n{{steps.scan-logic.output}}\n\n--- ERROR HANDLING ---\n{{steps.scan-errors.output}}\n\n--- SECURITY ---\n{{steps.scan-security.output}}",
        },
      ],
    },
    {
      id: "gate",
      title: "Gate verified findings",
      steps: [
        {
          id: "findings-ready",
          kind: "gate",
          dependsOn: ["cross-check"],
          condition: { step: "cross-check", ok: true },
          target: "verified-findings",
          onFalse: "fail",
        },
      ],
    },
    {
      id: "report",
      title: "Prioritized report",
      steps: [
        {
          id: "report",
          kind: "consolidator",
          agent: "claude",
          model: "claude-sonnet-4-6",
          dependsOn: ["cross-check", "findings-ready"],
          prompt:
            "Turn the verified findings below into a prioritized report (highest-severity first). For each: a one-line summary, file:line, severity, and the recommended fix. Output only the report.\n\n{{steps.cross-check.output}}",
        },
      ],
    },
  ],
};

/** name → spec. Merged under any user `workflows` from steamtrain.json. */
export const BUNDLED_WORKFLOWS: Record<string, WorkflowSpec> = {
  [multiPlan.name]: multiPlan,
  [bugHunt.name]: bugHunt,
};
