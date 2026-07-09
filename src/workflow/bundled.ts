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

const reviewLoop: WorkflowSpec = {
  name: "review-loop",
  description: "Implement, then review and fix in a bounded loop until clean.",
  phases: [
    {
      id: "implement",
      title: "Implement",
      steps: [
        {
          id: "impl",
          kind: "worker",
          agent: "opencode",
          model: FREE.mimo,
          prompt: "Implement the task fully:\n{{input}}",
        },
      ],
    },
    {
      id: "review",
      title: "Review",
      steps: [
        {
          id: "review",
          kind: "worker",
          agent: "opencode",
          model: FREE.mimo,
          dependsOn: ["impl"],
          workspace: "inherit:impl",
          prompt:
            "Review ONLY the changes you can see in this worktree (diff from the base commit). Ignore pre-existing code — focus on issues in the new/changed code. If there are NO issues, reply with the single word DONE. Otherwise list each issue with file:line and a short description.",
        },
      ],
    },
    {
      id: "fix",
      title: "Fix",
      steps: [
        {
          id: "fix",
          kind: "worker",
          agent: "opencode",
          model: FREE.mimo,
          dependsOn: ["review"],
          workspace: "inherit:review",
          prompt:
            "Fix every issue listed below. Apply the minimal fix for each — don't refactor unrelated code. Summarize what you changed.\n{{steps.review.output}}",
        },
      ],
    },
    {
      id: "gate",
      title: "Converged?",
      steps: [
        {
          // The gate re-checks REVIEW (not fix): the loop converges when the
          // reviewer reports nothing left to fix, so the gate must test the
          // review step's output for "DONE". Gating on fix instead is a common
          // authoring mistake — fix always runs and always produces output, so
          // a fix-conditioned gate never converges and the loop burns its cap.
          id: "loop-gate",
          kind: "gate",
          dependsOn: ["review"],
          condition: { step: "review", contains: "DONE" },
          loopTo: "review",
          maxIterations: 5,
          onFalse: "continue",
        },
      ],
    },
    {
      id: "merge",
      title: "Merge",
      steps: [
        {
          id: "merge",
          kind: "merge",
          dependsOn: ["loop-gate"],
          from: ["fix"],
          mode: "apply",
        },
      ],
    },
  ],
};

/**
 * The onboarding ride: a fully agentless workflow that demonstrates the engine
 * — fan-out, parallel execution, template data flow, a `when` skip, a bounded
 * loop-back gate, and a consolidated report — for $0, before any agent CLI is
 * installed or authenticated. Command steps only echo fixed text; `{{input}}`
 * is deliberately never templated into a `cmd` (user input must not reach the
 * shell), only into the agentless consolidator's rendered report.
 */
const tour: WorkflowSpec = {
  name: "tour",
  description:
    "A zero-cost guided ride through the engine: fan-out, parallel command cars, a when-skip, a loop-back gate, and an arrival report. No agents, no credentials, $0.",
  phases: [
    {
      id: "depart",
      title: "Departure — a distributor fans one input into items",
      steps: [
        {
          id: "stations",
          kind: "distributor",
          items: [
            "Union Station: one normalized event stream, no matter which agent produced it",
            "Junction: dependency scheduling — steps depart the moment the steps they reference arrive",
            "Roundhouse: every run is recorded to history and resumable from the on-disk cache",
          ],
        },
      ],
    },
    {
      id: "ride",
      title: "Open track — three cars run in parallel",
      steps: [
        {
          id: "car-fanout",
          kind: "command",
          dependsOn: ["stations"],
          cmd: 'echo "This car received the distributor items through a template:" && echo "{{steps.stations.items}}"',
        },
        {
          id: "car-parallel",
          kind: "command",
          dependsOn: ["stations"],
          cmd: 'echo "All three cars in this phase run at the same time — steps start as soon as their dependencies finish, bounded by maxConcurrency."',
        },
        {
          id: "car-isolation",
          kind: "command",
          dependsOn: ["stations"],
          cmd: 'echo "Command steps like this one cost nothing and run inside the same worktree isolation as agent steps — in a git repo, writes never touch your checkout."',
        },
        {
          id: "express-service",
          kind: "command",
          dependsOn: ["stations"],
          when: { step: "stations", contains: "express" },
          cmd: 'echo "You should never see this: the express service only runs when a station mentions it, and none does — so this step is SKIPPED, not failed."',
        },
      ],
    },
    {
      id: "laps",
      title: "Loop track — this phase re-runs until the signal clears",
      steps: [
        {
          id: "lap",
          kind: "command",
          cmd: 'echo "lap {{iteration}} of 3 around the loop track"',
        },
      ],
    },
    {
      id: "signal",
      title: "Signal gate — loops the train back until laps complete",
      steps: [
        {
          id: "loop-signal",
          kind: "gate",
          dependsOn: ["lap"],
          condition: { step: "lap", contains: "lap 3" },
          loopTo: "laps",
          maxIterations: 3,
          onFalse: "continue",
          target: "all-laps-complete",
        },
      ],
    },
    {
      id: "arrive",
      title: "Arrival — an agentless consolidator renders the report",
      steps: [
        {
          id: "conductor",
          kind: "consolidator",
          // express-service is skipped by its when-condition, and that is
          // fine here: a skipped dependency doesn't block a consolidator
          // (skipped ≠ failed) — it is treated as an absent input.
          dependsOn: [
            "car-fanout",
            "car-parallel",
            "car-isolation",
            "express-service",
            "lap",
            "loop-signal",
          ],
          prompt:
            '🚂 END OF THE LINE — tour complete for: {{input}}\n\nWhat just happened, in one $0 run:\n- A distributor fanned the departure into 3 station items (no agent involved).\n- Three command cars ran in parallel; their outputs are below.\n- The express-service step was skipped by its when-condition — skips cascade sensibly, and this report simply treats it as absent.\n- A gate looped the train around the track until "{{steps.lap.output}}" satisfied its condition, then emitted target "{{steps.loop-signal.target}}".\n\n--- CAR: fan-out ---\n{{steps.car-fanout.output}}\n--- CAR: parallel ---\n{{steps.car-parallel.output}}\n--- CAR: isolation ---\n{{steps.car-isolation.output}}\n\nNext stops:\n- steamtrain                                              → the TUI: pick a workflow, watch the live phase→step tree\n- steamtrain --web-ui                                     → the same engine behind a browser pipeline view\n- steamtrain init                                         → check agent readiness and add starter workflows for THIS repo\n- steamtrain workflow run tour --input "again" --fresh    → re-ride (runs resume from cache by default)\n\nEvery block you just rode — distributor, command, gate + loop, consolidator — is declarative JSON (docs/workflow-spec.md). Agent-backed workers and processors slot into the same tracks.',
        },
      ],
    },
  ],
};

/**
 * A workflow built entirely on direct-API `llm` steps — the lightweight tier
 * between command steps and full coding agents. Demonstrates the llm-step
 * repertoire end to end: a structured splitter (`output` + `itemsPath`) acting
 * as a fan-out source, a per-item `forEach` judge, a typed verdict feeding a
 * gate `path` condition, and an llm consolidator. Needs no agent CLI at all —
 * only `ANTHROPIC_API_KEY` in the environment — so it runs in CI and on
 * machines with no agent installed. (The other bundled workflows keep their
 * agent-backed free-tier models on purpose: they must run with zero API keys.)
 *
 * The model on each step is swappable without forking: session overrides
 * (`{ steps: { concerns: { model: "…" } } }` via the TUI editor or the web
 * API) patch llm steps' `model`/`prompt`/`effort` like any agent step's.
 */
const quickTriage: WorkflowSpec = {
  name: "quick-triage",
  description:
    "Split a request into concerns, assess each with direct API calls, and gate on a typed verdict — llm steps only, no agent CLI required (uses ANTHROPIC_API_KEY).",
  phases: [
    {
      id: "split",
      title: "Split the request into concerns (llm splitter)",
      steps: [
        {
          id: "concerns",
          kind: "llm",
          model: "claude-opus-4-8",
          prompt:
            "List the 3 to 5 most important, distinct concerns to evaluate before doing the following. Keep each concern to one short sentence.\n\nRequest: {{input}}",
          output: {
            type: "object",
            required: ["concerns"],
            properties: {
              concerns: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 5 },
            },
          },
          itemsPath: "concerns",
        },
      ],
    },
    {
      id: "assess",
      title: "Assess each concern in parallel (llm forEach)",
      steps: [
        {
          id: "assess-each",
          kind: "llm",
          model: "claude-opus-4-8",
          dependsOn: ["concerns"],
          forEach: "steps.concerns.items",
          prompt:
            "Assess this concern for the request below in 2-3 sentences: how risky is it, and what would mitigate it?\n\nConcern: {{item}}\n\nRequest: {{input}}",
        },
      ],
    },
    {
      id: "verdict",
      title: "Typed go / no-go verdict (llm judge)",
      steps: [
        {
          id: "verdict",
          kind: "llm",
          model: "claude-opus-4-8",
          dependsOn: ["assess-each"],
          prompt:
            'Given the per-concern assessments below, judge whether the request is ready to proceed. Answer "go" only when no assessment describes an unmitigated high risk.\n\n{{steps.assess-each.output}}',
          output: {
            type: "object",
            required: ["verdict", "rationale"],
            properties: {
              verdict: { type: "string", enum: ["go", "no-go"] },
              rationale: { type: "string" },
            },
          },
        },
      ],
    },
    {
      id: "gate",
      title: "Gate on the verdict",
      steps: [
        {
          id: "ready",
          kind: "gate",
          dependsOn: ["verdict"],
          condition: { step: "verdict", path: "verdict", equals: "go" },
          target: "cleared",
          onFalse: "continue",
        },
      ],
    },
    {
      id: "report",
      title: "Consolidated triage report (llm merge)",
      steps: [
        {
          id: "report",
          kind: "llm",
          model: "claude-opus-4-8",
          dependsOn: ["assess-each", "verdict", "ready"],
          prompt:
            "Write a short triage report for the request below: the verdict ({{steps.verdict.json.verdict}}), why ({{steps.verdict.json.rationale}}), then a prioritized list of the concerns and their assessments.\n\nRequest: {{input}}\n\nAssessments:\n{{steps.assess-each.output}}",
        },
      ],
    },
  ],
};

/** name → spec. Merged under any user `workflows` from steamtrain.json. */
export const BUNDLED_WORKFLOWS: Record<string, WorkflowSpec> = {
  [tour.name]: tour,
  [multiPlan.name]: multiPlan,
  [bugHunt.name]: bugHunt,
  [targetSweep.name]: targetSweep,
  [reviewLoop.name]: reviewLoop,
  [quickTriage.name]: quickTriage,
};
