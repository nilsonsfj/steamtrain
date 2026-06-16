import type { WorkflowSpec } from "./types";

/**
 * Built-in workflows — steamtrain's analog of Claude Code's bundled
 * `/deep-research`. Each one shows the core value: heterogeneous steps (a mix
 * of models) that fan out, then an independent model cross-checks the results
 * before they converge into one answer.
 *
 * Agent-backed steps default to OpenCode Zen free-tier models (`opencode/…-free`)
 * so bundled workflows run without paid provider credentials. Steps run in the
 * session cwd by default — to target other repos/dirs, add a per-step `cwd`
 * (and optional `env` / `extraArgs`), e.g.:
 *
 *   { id: "scan-api", agent: "opencode", model: "opencode/deepseek-v4-flash-free",
 *     cwd: "../api-service", env: { FOO: "bar" }, extraArgs: ["--add-dir", "."],
 *     prompt: "Audit {{input}} in this repo" }
 */

/** OpenCode Zen free models — see https://opencode.ai/zen/v1/models */
const FREE = {
  nemotronUltra: "opencode/nemotron-3-ultra-free",
  deepseekFlash: "opencode/deepseek-v4-flash-free",
  mimo: "opencode/mimo-v2.5-free",
  northMini: "opencode/north-mini-code-free",
} as const;

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
          agent: "opencode",
          model: FREE.northMini,
          dependsOn: ["planning-lenses"],
          prompt:
            "Draft a concise, step-by-step implementation plan for the task below. Optimize for correctness, simplicity, and reuse of existing patterns. List concrete files/steps.\n\nPlanning lenses:\n{{steps.planning-lenses.items}}\n\nTask: {{input}}",
        },
        {
          id: "draft-pragmatic",
          kind: "worker",
          agent: "opencode",
          model: FREE.mimo,
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
          agent: "opencode",
          model: FREE.nemotronUltra,
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
          agent: "opencode",
          model: FREE.deepseekFlash,
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
          agent: "opencode",
          model: FREE.deepseekFlash,
          prompt:
            "Hunt for logic and edge-case bugs in the scope below: off-by-one errors, incorrect conditionals, unhandled cases, race conditions. For each finding give file:line, why it's a bug, and a fix. Scope: {{input}}",
        },
        {
          id: "scan-errors",
          kind: "worker",
          agent: "opencode",
          model: FREE.mimo,
          prompt:
            "Hunt for error-handling and resource bugs in the scope below: swallowed errors, missing awaits, leaked handles/processes, unchecked failures. For each finding give file:line, the risk, and a fix. Scope: {{input}}",
        },
        {
          id: "scan-security",
          kind: "worker",
          agent: "opencode",
          model: FREE.northMini,
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
          agent: "opencode",
          model: FREE.nemotronUltra,
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
          agent: "opencode",
          model: FREE.deepseekFlash,
          dependsOn: ["cross-check", "findings-ready"],
          prompt:
            "Turn the verified findings below into a prioritized report (highest-severity first). For each: a one-line summary, file:line, severity, and the recommended fix. Output only the report.\n\n{{steps.cross-check.output}}",
        },
      ],
    },
  ],
};

const targetSweep: WorkflowSpec = {
  name: "target-sweep",
  description:
    "Split a request into target areas, run one processor per target, then consolidate the findings.",
  phases: [
    {
      id: "split",
      title: "Distribute target areas",
      steps: [
        {
          id: "targets",
          kind: "distributor",
          items: [
            "implementation concerns for {{input}}",
            "test coverage concerns for {{input}}",
            "documentation and rollout concerns for {{input}}",
          ],
        },
      ],
    },
    {
      id: "process",
      title: "Process one target per generated agent run",
      steps: [
        {
          id: "sweep-each",
          kind: "processor",
          agent: "opencode",
          model: FREE.deepseekFlash,
          dependsOn: ["targets"],
          forEach: "steps.targets.items",
          prompt:
            "Analyze this target area for the task. Be concrete and concise.\n\nTarget {{item.index}} from {{item.sourceStepId}}:\n{{item}}\n\nTask: {{input}}",
        },
      ],
    },
    {
      id: "report",
      title: "Consolidate target outputs",
      steps: [
        {
          id: "report",
          kind: "consolidator",
          agent: "opencode",
          model: FREE.mimo,
          dependsOn: ["sweep-each"],
          prompt:
            "Merge the per-target analyses below into one prioritized report. Deduplicate overlap and keep concrete action items.\n\n{{steps.sweep-each.output}}",
        },
      ],
    },
  ],
};

/** name → spec. Merged under any user `workflows` from steamtrain.json. */
export const BUNDLED_WORKFLOWS: Record<string, WorkflowSpec> = {
  [multiPlan.name]: multiPlan,
  [bugHunt.name]: bugHunt,
  [targetSweep.name]: targetSweep,
};
