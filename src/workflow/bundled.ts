import type { WorkflowSpec } from "./types";

/**
 * Built-in workflows — steamtrain's analog of Claude Code's bundled
 * `/deep-research`. Each one shows the core value: heterogeneous steps (a mix
 * of models) that fan out, then an independent model cross-checks the results
 * before they converge into one answer.
 *
 * Agent-backed steps default to free-tier models so bundled workflows run
 * without paid provider credentials. Prefer first-class `mimo/mimo-auto` for
 * tool-heavy steps: OpenCode Zen's `opencode/deepseek-v4-flash-free` is known
 * to hang on multi-turn tool loops (DeepSeek `reasoning_content` replay).
 * Steps run in the session cwd by default — to target other repos/dirs, add a
 * per-step `cwd` (and optional `env` / `extraArgs`), e.g.:
 *
 *   { id: "scan-api", model: "mimo/mimo-auto",
 *     cwd: "../api-service", env: { FOO: "bar" }, extraArgs: ["--add-dir", "."],
 *     prompt: "Audit {{input}} in this repo" }
 */

/** Free models used by bundled workflows (OpenCode Zen + MiMo Auto). */
const FREE = {
  nemotronUltra: "opencode/nemotron-3-ultra-free",
  mimoZen: "opencode/mimo-v2.5-free",
  /** First-class MiMo CLI free channel — reliable default for agent tool use. */
  mimoAuto: "mimo/mimo-auto",
  northMini: "opencode/north-mini-code-free",
  // Intentionally omit opencode/deepseek-v4-flash-free: it hangs on multi-turn
  // tool loops (DeepSeek reasoning_content replay) and was timing out babysit.
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
          model: FREE.mimoZen,
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
          agent: "mimo",
          model: FREE.mimoAuto,
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
          agent: "mimo",
          model: FREE.mimoAuto,
          prompt:
            "Hunt for logic and edge-case bugs in the scope below: off-by-one errors, incorrect conditionals, unhandled cases, race conditions. For each finding give file:line, why it's a bug, and a fix. Scope: {{input}}",
        },
        {
          id: "scan-errors",
          kind: "worker",
          agent: "opencode",
          model: FREE.mimoZen,
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
          agent: "mimo",
          model: FREE.mimoAuto,
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
          agent: "mimo",
          model: FREE.mimoAuto,
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
          model: FREE.mimoZen,
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
          model: FREE.mimoZen,
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
          model: FREE.mimoZen,
          dependsOn: ["impl"],
          // `attach` (not `inherit`) — review runs INSIDE impl's own worktree
          // rather than a copy of it. This is what makes the loop converge:
          // with `inherit`, every iteration's review step forks a FRESH copy
          // of impl's original (pre-fix) state, so iteration 2's review would
          // never see iteration 1's fix — the loop could run forever without
          // ever observing progress. With `attach`, review/fix/the next
          // review all share the one worktree, so each pass sees the previous
          // pass's edits.
          workspace: "attach:impl",
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
          model: FREE.mimoZen,
          dependsOn: ["review"],
          // Also attach:impl (not attach:review / inherit:review) — impl is
          // the one worktree the whole loop shares. fix's dependsOn on review
          // still orders it after review; attach only says which worktree to
          // run inside.
          workspace: "attach:impl",
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
          // review and fix both attach:impl, so all three share ONE
          // worktree (impl's). `from` can name any of them — merge dedupes
          // sources by worktree root — but naming the tail (fix) reads as
          // "the final state of the shared worktree".
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
            '🚂 END OF THE LINE — tour complete for: {{input}}\n\nWhat just happened, in one $0 run:\n- A distributor fanned the departure into 3 station items (no agent involved).\n- Three command cars ran in parallel; their outputs are below.\n- The express-service step was skipped by its when-condition — skips cascade sensibly, and this report simply treats it as absent.\n- A gate looped the train around the track until "{{steps.lap.output}}" satisfied its condition, then emitted target "{{steps.loop-signal.target}}".\n\n--- CAR: fan-out ---\n{{steps.car-fanout.output}}\n--- CAR: parallel ---\n{{steps.car-parallel.output}}\n--- CAR: isolation ---\n{{steps.car-isolation.output}}\n\nNext destinations:\n- Try multi-plan — draft a plan from independent angles, then synthesize the strongest version\n- Run steamtrain init — check agent readiness and add starter workflows for this repo\n- Re-ride with --fresh — runs resume from cache by default\n\nEvery block you just rode — distributor, command, gate + loop, consolidator — is declarative JSON. Agent-backed workers and processors slot into the same tracks.',
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

/**
 * The per-stream pipeline: implement a charter in its own worktree, then
 * loop review → fix → test until the reviewer is clean AND the tests pass.
 * Also useful standalone — run it directly with `{{input}}` as a plain task
 * description.
 *
 * All steps `attach` to `implement`'s worktree (never `inherit`), so every
 * iteration of the loop actually sees the previous iteration's fixes — see
 * the `review-loop` comments above for why that matters.
 *
 * `reviewerEffort` defaults to `""`: an empty rendered `effort` is treated as
 * "omit the flag" (building block 5), not a failure — only an empty rendered
 * `model` fails the step. So callers on agents/models with no effort concept
 * can leave it blank.
 *
 * `testCmd` defaults to `"true"` — the POSIX no-op that exits 0 — so the
 * workflow validates and runs keyless out of the box with no test suite
 * wired up; real users override it with `--param testCmd="npm test"` (or
 * whatever the repo uses).
 *
 * The `test` step's `cmd` embeds `{{inputs.testCmd}}`, which the template
 * linter flags as a command step interpolating template data into the shell
 * (see `lintTemplateRefs` in template.ts). That warning exists to catch
 * *unintended* input reaching a shell; here it's the entire point of the
 * step — running the user's own declared test command is not meaningfully
 * different from `init`'s generated test-check steps (`src/init/starters.ts`),
 * which embed the same detected command as a literal. The bundled-workflow
 * validation test (`tests/bundled-workflows.test.ts`) accepts this one
 * expected warning by name rather than requiring zero warnings for this spec.
 */
const mainlineStream: WorkflowSpec = {
  name: "mainline-stream",
  description:
    "Implement a charter in its own worktree, then loop review → fix → test until clean. The per-stream unit of the mainline pipeline; also useful standalone.",
  inputs: {
    coderModel: {
      type: "model",
      description: "Agent model that implements the charter and applies review fixes.",
      default: FREE.mimoAuto,
      fallbackModels: [FREE.mimoZen, FREE.northMini],
    },
    reviewerModel: {
      type: "model",
      description: "Agent model that reviews the diff each loop iteration.",
      default: FREE.nemotronUltra,
      fallbackModels: [FREE.mimoAuto, FREE.mimoZen],
    },
    reviewerEffort: {
      description: "Reasoning effort/variant for the reviewer model. Empty omits the flag.",
      default: "",
    },
    testCmd: {
      description: "Shell command that must exit 0 for the loop to converge.",
      default: "true",
    },
    issueTiming: {
      type: "enum",
      description: 'File out-of-scope findings "live" (as this stream finishes) or at "end".',
      choices: ["live", "end"],
      default: "end",
    },
    issueMode: {
      type: "enum",
      description: 'Findings become a "report" (safe default) or "github" issues.',
      choices: ["report", "github"],
      default: "report",
    },
  },
  phases: [
    {
      id: "implement",
      title: "Implement the stream charter",
      steps: [
        {
          id: "implement",
          kind: "worker",
          model: "{{inputs.coderModel}}",
          prompt:
            "Implement ONLY this stream's charter. Stay strictly inside its scope — if you notice a broken or wrong pre-existing behavior OUTSIDE the charter, do NOT fix it: record it as a finding instead and leave the code alone.\n\n" +
            "Charter:\n{{input}}\n\n" +
            'End your reply with JSON matching: { "summary": "what you implemented, in a few sentences", "findings": [{ "title": "...", "body": "...", "severity": "low"|"medium"|"high", "file": "path/to/file" }] } — findings are ONLY pre-existing, out-of-scope problems you noticed; use an empty array when there are none.',
          output: {
            type: "object",
            required: ["summary", "findings"],
            properties: {
              summary: { type: "string" },
              findings: {
                type: "array",
                items: {
                  type: "object",
                  required: ["title"],
                  properties: {
                    title: { type: "string" },
                    body: { type: "string" },
                    severity: { type: "string", enum: ["low", "medium", "high"] },
                    file: { type: "string" },
                  },
                },
              },
            },
          },
        },
      ],
    },
    {
      id: "review",
      title: "Review the stream's diff",
      steps: [
        {
          id: "review",
          kind: "worker",
          model: "{{inputs.reviewerModel}}",
          effort: "{{inputs.reviewerEffort}}",
          dependsOn: ["implement"],
          workspace: "attach:implement",
          prompt:
            "Review the diff from the base commit in this worktree — the NEW code from this stream's implementation (and any prior fix pass). `issues` are problems in that new code that MUST be fixed before this stream is done. `findings` are DIFFERENT: pre-existing, out-of-scope problems you noticed but that are not this stream's to fix — list every one still relevant, even ones you (or the implementer) reported before, since your findings list replaces the previous iteration's, it does not add to it.\n\n" +
            'End your reply with JSON matching: { "verdict": "clean"|"issues", "issues": [{ "title": "...", "detail": "...", "file": "path/to/file" }], "findings": [{ "title": "...", "body": "...", "severity": "low"|"medium"|"high", "file": "path/to/file" }] } — verdict is "clean" ONLY when issues is empty.',
          output: {
            type: "object",
            required: ["verdict", "issues", "findings"],
            properties: {
              verdict: { type: "string", enum: ["clean", "issues"] },
              issues: {
                type: "array",
                items: {
                  type: "object",
                  required: ["title"],
                  properties: {
                    title: { type: "string" },
                    detail: { type: "string" },
                    file: { type: "string" },
                  },
                },
              },
              findings: {
                type: "array",
                items: {
                  type: "object",
                  required: ["title"],
                  properties: {
                    title: { type: "string" },
                    body: { type: "string" },
                    severity: { type: "string", enum: ["low", "medium", "high"] },
                    file: { type: "string" },
                  },
                },
              },
            },
          },
        },
      ],
    },
    {
      id: "fix",
      title: "Fix the listed issues",
      steps: [
        {
          id: "fix",
          kind: "worker",
          model: "{{inputs.coderModel}}",
          dependsOn: ["review"],
          workspace: "attach:implement",
          prompt:
            'Apply exactly the issues listed below — the minimal fix for each, no unrelated refactors. If the verdict was "clean" (no issues), reply with the single word NO-OP and change nothing.\n\n{{steps.review.output}}',
        },
      ],
    },
    {
      id: "test",
      title: "Run the test command",
      steps: [
        {
          id: "test",
          kind: "command",
          dependsOn: ["fix"],
          workspace: "attach:implement",
          cmd: "{{inputs.testCmd}}",
        },
      ],
    },
    {
      id: "gate-test",
      title: "Converged? — tests pass",
      steps: [
        {
          // Checked first: if tests fail, there is no point re-reviewing —
          // loop back to review (which will re-review whatever fix produces
          // next). onFalse "continue" (not "fail"): a bounded loop must not
          // fail the whole stream just because it hit the iteration cap —
          // the merge still lands the best-effort work, and the summary
          // step reports the unconverged state honestly rather than hiding
          // it behind a hard failure.
          id: "test-gate",
          kind: "gate",
          dependsOn: ["test"],
          condition: { step: "test", ok: true },
          loopTo: "review",
          maxIterations: 4,
          onFalse: "continue",
        },
      ],
    },
    {
      id: "gate-review",
      title: "Converged? — review clean",
      steps: [
        {
          // A separate (later) phase from gate-test, but it loops to the
          // SAME target ("review") — the regions coincide rather than
          // partially overlap, which is the "properly nested" case
          // validation allows. Checked second: only once tests pass do we
          // ask whether the reviewer is satisfied.
          id: "review-gate",
          kind: "gate",
          dependsOn: ["test-gate"],
          condition: { step: "review", path: "verdict", equals: "clean" },
          loopTo: "review",
          maxIterations: 4,
          onFalse: "continue",
        },
      ],
    },
    {
      id: "stream-issues",
      title: "File live findings (optional)",
      steps: [
        {
          id: "stream-issues",
          kind: "issues",
          dependsOn: ["review-gate"],
          when: { value: "{{inputs.issueTiming}}", equals: "live" },
          from: ["implement", "review"],
          findingsPath: "findings",
          mode: "{{inputs.issueMode}}",
          titlePrefix: "[mainline]",
        },
      ],
    },
    {
      id: "summarize",
      title: "Stream summary",
      steps: [
        {
          // Depends on stream-issues even though that step only runs in the
          // "live" issue-timing flow: consolidators treat a skipped
          // dependency as absent (not failed), so in the default "end" flow
          // the summary renders exactly the same minus the issues section.
          id: "summary",
          kind: "consolidator",
          dependsOn: ["review-gate", "stream-issues"],
          prompt:
            "Stream complete.\n\nCharter:\n{{input}}\n\nFinal verdict: {{steps.review.json.verdict}}\nTest exit code: {{steps.test.exitCode}}\n\nImplementation summary:\n{{steps.implement.json.summary}}\n\nOut-of-scope findings noticed along the way:\n{{steps.review.json.findings}}",
        },
      ],
    },
  ],
};

/**
 * The full pipeline: a high-intelligence planner splits the incoming prompt
 * into independent execution streams, each stream runs `mainline-stream` in
 * parallel worktrees, an LLM-assisted merge integrates them, the merged
 * result goes through one more review/fix/test loop, and a PR is opened —
 * with every out-of-scope finding filed as a GitHub issue (or a report).
 *
 * Defaults use OpenCode Zen free-tier models throughout so the whole
 * pipeline validates and runs keyless; see docs/mainline-pipeline.md for the
 * premium/balanced/budget model-tier tables to override with `--param`.
 */
const mainline: WorkflowSpec = {
  name: "mainline",
  description:
    "One prompt in, one reviewed PR out: plan parallel streams, implement+review+fix+test each in its own worktree, merge, review the merge, open a PR, and file every out-of-scope finding as an issue.",
  inputs: {
    plannerModel: {
      type: "model",
      description: "Agent model that splits the prompt into independent streams.",
      default: FREE.mimoAuto,
      fallbackModels: [FREE.mimoZen, FREE.northMini],
    },
    plannerEffort: {
      description: "Reasoning effort/variant for the planner model. Empty omits the flag.",
      default: "",
    },
    coderModel: {
      type: "model",
      description: "Agent model that implements each stream and the final fixes.",
      default: FREE.mimoAuto,
      fallbackModels: [FREE.mimoZen, FREE.northMini],
    },
    reviewerModel: {
      type: "model",
      description: "Agent model that reviews each stream and the final merge.",
      default: FREE.nemotronUltra,
      fallbackModels: [FREE.mimoAuto, FREE.mimoZen],
    },
    reviewerEffort: {
      description: "Reasoning effort/variant for the reviewer model. Empty omits the flag.",
      default: "",
    },
    mergeModel: {
      type: "model",
      description: "Agent model that resolves merge conflicts between streams, if any arise.",
      default: FREE.northMini,
      fallbackModels: [FREE.mimoAuto, FREE.mimoZen],
    },
    maxStreams: {
      type: "number",
      description: "Upper bound on how many independent streams the planner may create.",
      default: 3,
    },
    testCmd: {
      description: "Shell command that must exit 0 for a loop to converge.",
      default: "true",
    },
    issueTiming: {
      type: "enum",
      description: 'File out-of-scope findings "live" (per-stream) or batched at "end".',
      choices: ["live", "end"],
      default: "end",
    },
    issueMode: {
      type: "enum",
      description: 'Findings become a "report" (safe default) or "github" issues.',
      choices: ["report", "github"],
      default: "report",
    },
    deliver: {
      type: "enum",
      description: 'Land the final result as a "pr" (default) or leave it on a local "branch".',
      choices: ["pr", "branch"],
      default: "pr",
    },
  },
  phases: [
    {
      id: "plan",
      title: "Plan independent streams",
      steps: [
        {
          id: "plan",
          kind: "distributor",
          model: "{{inputs.plannerModel}}",
          effort: "{{inputs.plannerEffort}}",
          itemsPath: "streams",
          prompt:
            "Explore this repository first (read the relevant files) before deciding how to split the work.\n\n" +
            "Split the task below into AT MOST {{inputs.maxStreams}} genuinely INDEPENDENT execution streams — each one a self-contained, parallelizable chunk of work with MINIMAL file overlap with the others. File overlap between streams becomes a merge conflict later, so prefer FEWER, cleanly-separated streams over many overlapping ones; a task that doesn't decompose cleanly should be ONE stream.\n\n" +
            "Each stream's implementer will see ONLY that stream's charter text — no other context. Write each charter to be fully self-contained: the relevant file paths, the exact change, and clear acceptance criteria.\n\n" +
            "Task: {{input}}\n\n" +
            'End your reply with JSON matching: { "streams": [{ "title": "short stream title", "charter": "the full self-contained charter text" }], "findings": [{ "title": "...", "body": "...", "severity": "low"|"medium"|"high", "file": "path/to/file" }] } — findings are pre-existing problems noticed while exploring, not part of any stream.',
          output: {
            type: "object",
            required: ["streams", "findings"],
            properties: {
              streams: {
                type: "array",
                minItems: 1,
                // Structural ceiling on fan-out, independent of the prompt's
                // soft "AT MOST {{inputs.maxStreams}}" instruction: schema
                // bounds are static, so this is the absolute cap a planner
                // that ignores its instructions can reach — the structured-
                // output validator rejects a longer list (one bounded fix
                // retry) instead of fanning out unbounded work.
                maxItems: 8,
                items: {
                  type: "object",
                  required: ["title", "charter"],
                  properties: {
                    title: { type: "string" },
                    charter: { type: "string" },
                  },
                },
              },
              findings: {
                type: "array",
                items: {
                  type: "object",
                  required: ["title"],
                  properties: {
                    title: { type: "string" },
                    body: { type: "string" },
                    severity: { type: "string", enum: ["low", "medium", "high"] },
                    file: { type: "string" },
                  },
                },
              },
            },
          },
        },
      ],
    },
    {
      id: "streams",
      title: "Run each stream's pipeline in parallel",
      steps: [
        {
          id: "streams",
          kind: "workflow",
          dependsOn: ["plan"],
          workflow: "mainline-stream",
          forEach: "steps.plan.items",
          input: "{{item}}",
          params: {
            coderModel: "{{inputs.coderModel}}",
            reviewerModel: "{{inputs.reviewerModel}}",
            reviewerEffort: "{{inputs.reviewerEffort}}",
            testCmd: "{{inputs.testCmd}}",
            issueTiming: "{{inputs.issueTiming}}",
            issueMode: "{{inputs.issueMode}}",
          },
          outputStep: "review",
          worktreeStep: "implement",
        },
      ],
    },
    {
      id: "integrate",
      title: "Merge the streams into a staging worktree",
      steps: [
        {
          id: "integrate",
          kind: "merge",
          dependsOn: ["streams"],
          from: ["streams"],
          mode: "worktree",
          onConflict: "agent",
          model: "{{inputs.mergeModel}}",
          commitMessage: "mainline: integrate streams for {{input}}",
        },
      ],
    },
    {
      id: "final-review",
      title: "Review the merged result",
      steps: [
        {
          id: "final-review",
          kind: "worker",
          model: "{{inputs.reviewerModel}}",
          effort: "{{inputs.reviewerEffort}}",
          dependsOn: ["integrate"],
          workspace: "attach:integrate",
          prompt:
            "Review the FULL diff from the base commit in this worktree — the merged result of every stream. Pay special attention to the SEAMS between streams: places where two streams' changes interact, duplicate work, or contradict each other, which no single stream's own review could have caught.\n\n" +
            "`issues` are problems in this merged code that MUST be fixed. `findings` are pre-existing, out-of-scope problems — list every one still relevant (your findings list replaces the previous iteration's).\n\n" +
            'End your reply with JSON matching: { "verdict": "clean"|"issues", "issues": [{ "title": "...", "detail": "...", "file": "path/to/file" }], "findings": [{ "title": "...", "body": "...", "severity": "low"|"medium"|"high", "file": "path/to/file" }] } — verdict is "clean" ONLY when issues is empty.',
          output: {
            type: "object",
            required: ["verdict", "issues", "findings"],
            properties: {
              verdict: { type: "string", enum: ["clean", "issues"] },
              issues: {
                type: "array",
                items: {
                  type: "object",
                  required: ["title"],
                  properties: {
                    title: { type: "string" },
                    detail: { type: "string" },
                    file: { type: "string" },
                  },
                },
              },
              findings: {
                type: "array",
                items: {
                  type: "object",
                  required: ["title"],
                  properties: {
                    title: { type: "string" },
                    body: { type: "string" },
                    severity: { type: "string", enum: ["low", "medium", "high"] },
                    file: { type: "string" },
                  },
                },
              },
            },
          },
        },
      ],
    },
    {
      id: "final-fix",
      title: "Fix the merged result's issues",
      steps: [
        {
          id: "final-fix",
          kind: "worker",
          model: "{{inputs.coderModel}}",
          dependsOn: ["final-review"],
          workspace: "attach:integrate",
          prompt:
            'Apply exactly the issues listed below — the minimal fix for each. If the verdict was "clean" (no issues), reply with the single word NO-OP and change nothing.\n\n{{steps.final-review.output}}',
        },
      ],
    },
    {
      id: "final-test",
      title: "Run the test command on the merged result",
      steps: [
        {
          id: "final-test",
          kind: "command",
          dependsOn: ["final-fix"],
          workspace: "attach:integrate",
          cmd: "{{inputs.testCmd}}",
        },
      ],
    },
    {
      id: "final-gate-test",
      title: "Converged? — final tests pass",
      steps: [
        {
          id: "final-test-gate",
          kind: "gate",
          dependsOn: ["final-test"],
          condition: { step: "final-test", ok: true },
          loopTo: "final-review",
          maxIterations: 4,
          onFalse: "continue",
        },
      ],
    },
    {
      id: "final-gate-review",
      title: "Converged? — final review clean",
      steps: [
        {
          id: "final-review-gate",
          kind: "gate",
          dependsOn: ["final-test-gate"],
          condition: { step: "final-review", path: "verdict", equals: "clean" },
          loopTo: "final-review",
          maxIterations: 4,
          onFalse: "continue",
        },
      ],
    },
    {
      id: "deliver",
      title: "Deliver the final result",
      steps: [
        {
          id: "deliver-pr",
          kind: "merge",
          dependsOn: ["final-review-gate"],
          from: ["final-fix"],
          mode: "pr",
          when: { value: "{{inputs.deliver}}", equals: "pr" },
          prTitle: "mainline: {{input}}",
          prBody:
            "Automated by the `mainline` workflow.\n\nTask:\n{{input}}\n\nStreams:\n{{steps.plan.items}}\n\nFinal review verdict: {{steps.final-review.json.verdict}}",
        },
        {
          // deliver-pr and deliver-branch are mutually exclusive alternatives:
          // their `when` conditions test the same rendered input with opposite
          // polarity, so exactly one runs and the other is SKIPPED (ok, empty
          // output). The arrival consolidator depends on both — consolidators
          // treat skipped dependencies as absent, so whichever alternative was
          // skipped simply vanishes from the report.
          //
          // Negated equality (not-"pr") rather than equals-"branch" is a
          // deliberate safety choice, not an oversight: with a positive match
          // on both sides, a typo'd deliver value ("Branch", "b") would skip
          // BOTH alternatives and silently deliver nothing after the whole
          // pipeline ran. With negation, anything that isn't exactly "pr"
          // still lands the work on a branch — the run's output is never lost
          // to an input typo.
          id: "deliver-branch",
          kind: "merge",
          dependsOn: ["final-review-gate"],
          from: ["final-fix"],
          mode: "branch",
          when: { value: "{{inputs.deliver}}", equals: "pr", not: true },
        },
        {
          id: "file-issues",
          kind: "issues",
          dependsOn: ["final-review-gate"],
          when: { value: "{{inputs.issueTiming}}", equals: "end" },
          from: ["plan", "streams", "final-review"],
          findingsPath: "findings",
          mode: "{{inputs.issueMode}}",
          titlePrefix: "[mainline]",
        },
      ],
    },
    {
      id: "arrival",
      title: "Arrival report",
      steps: [
        {
          // Depends on BOTH delivery alternatives and the conditionally-run
          // file-issues step: consolidators treat skipped dependencies as
          // absent (their section simply vanishes), so exactly one delivery
          // line renders — see the deliver-branch comment above for the
          // when-condition semantics.
          id: "arrival",
          kind: "consolidator",
          dependsOn: [
            "plan",
            "streams",
            "integrate",
            "final-review",
            "final-test",
            "deliver-pr",
            "deliver-branch",
            "file-issues",
          ],
          prompt:
            "mainline pipeline complete.\n\nTask:\n{{input}}\n\n" +
            "Streams planned:\n{{steps.plan.items}}\n\n" +
            "Integration: {{steps.integrate.output}}\n\n" +
            "Final review verdict: {{steps.final-review.json.verdict}}\n" +
            "Final test exit code: {{steps.final-test.exitCode}}\n\n" +
            "Delivery: {{steps.deliver-pr.output}}{{steps.deliver-branch.output}}\n\n" +
            "Issues filed: {{steps.file-issues.output}}",
        },
      ],
    },
  ],
};

/**
 * Per-PR babysit pipeline invoked by `babysit-all-prs`. The agent prepares the
 * PR (rebase, address comments, push) but is FORBIDDEN from merging or deleting
 * the remote branch — a deterministic `merge-when-ready` command step waits for
 * EVERY GitHub status check (including non-required external review bots) and
 * only then merges. That closes the race where a remote review dies with
 * `fatal: couldn't find remote ref <branch>` because the head was deleted while
 * it was still queued.
 *
 * `merge-when-ready` also survives the OTHER babysit race: when
 * `babysit-all-prs` fans out, each PR's land step is a SEPARATE process racing
 * to merge into the same base. The command serializes the actual land behind a
 * cross-process lock and, once it holds it, re-checks the PR — landing a
 * sibling that just moved the base leaves this PR behind (auto-updated) or
 * conflicting (reported), instead of a raw `gh pr merge` failure. See
 * `github-checks.ts` / `land-lock.ts`.
 */
const babysitPr: WorkflowSpec = {
  name: "babysit-pr",
  description:
    "Prepare one open GitHub PR (rebase, review comments, conflicts), wait for every CI/status check including external reviews, then merge only when green.",
  inputs: {
    pr: {
      description: "PR number, URL, head branch, or a 'number\\nbranch' line.",
    },
    babysitterModel: {
      type: "model",
      description: "Agent model that prepares the PR (does not merge).",
      default: FREE.mimoAuto,
      fallbackModels: [FREE.mimoZen, FREE.northMini],
    },
    checksTimeoutSec: {
      type: "number",
      description: "Max seconds to wait for all PR status checks before giving up.",
      default: 1800,
    },
    land: {
      type: "enum",
      description:
        'After checks are green: "merge" the PR (default), or "report" readiness without merging.',
      choices: ["merge", "report"],
      default: "merge",
    },
    mergeStrategy: {
      type: "enum",
      description: "gh pr merge strategy used when land=merge.",
      choices: ["squash", "merge", "rebase"],
      default: "squash",
    },
  },
  phases: [
    {
      id: "prepare",
      title: "Prepare the PR (do not land)",
      steps: [
        {
          id: "prepare",
          kind: "processor",
          // Model-only: babysitterModel may be mimo/* or opencode/* — agent
          // follows the rendered model family at execute time.
          model: "{{inputs.babysitterModel}}",
          // Conflict resolution + CI fixes routinely exceed the 15m default;
          // match the land-step budget so prepare is not cut mid-push.
          stepTimeoutSec: 2400,
          prompt:
            "You are babysitting GitHub pull request {{inputs.pr}} in this repository.\n\n" +
            "Goals (in order):\n" +
            "1. Inspect the PR with the gh CLI (`gh pr view`, `gh pr diff`, `gh api` for review comments / threads).\n" +
            "2. Check out the PR head (`gh pr checkout {{inputs.pr}}`) - you are in an isolated worktree, so you MUST push every fix to the remote PR head branch.\n" +
            "3. Rebase or update onto the base branch when behind; resolve conflicts.\n" +
            "4. Address or clearly document every unresolved review comment / CI failure you can fix in-scope. Push commits to the PR head branch and verify `gh pr view {{inputs.pr}} --json mergeable` is MERGEABLE.\n" +
            "5. Leave a short summary of what you did and what (if anything) is still blocking.\n\n" +
            "HARD RULES — a later deterministic step lands the PR:\n" +
            "- Do NOT run `gh pr merge`, enable auto-merge, or otherwise merge the PR.\n" +
            "- Do NOT delete the remote head branch (`git push --delete`, `gh pr merge --delete-branch`, repo branch cleanup).\n" +
            "- Do NOT close the PR.\n" +
            "Merging while CI or an external automated review is still queued deletes the remote ref those jobs need and makes them fail with 'couldn't find remote ref'. Waiting and landing is handled for you.\n\n" +
            "GitHub's 'mergeable' flag is NOT sufficient readiness — pending non-required checks (remote review bots especially) still need the branch.",
        },
      ],
    },
    {
      id: "land",
      title: "Wait for every check, then land",
      steps: [
        {
          id: "wait-or-merge",
          kind: "command",
          dependsOn: ["prepare"],
          // Longer than checksTimeoutSec default (1800) so the step wall-clock
          // does not kill the waiter first. Cmd templates are intentional —
          // same class of warning as mainline's {{inputs.testCmd}}.
          stepTimeoutSec: 2400,
          // STEAMTRAIN_CLI is injected by the engine so this works under
          // `bun src/index.tsx` without a global install. Fallback to PATH.
          when: { value: "{{inputs.land}}", equals: "merge" },
          cmd:
            '${STEAMTRAIN_CLI:-steamtrain} workflow pr merge-when-ready "{{inputs.pr}}" ' +
            "--timeout-sec {{inputs.checksTimeoutSec}} --strategy {{inputs.mergeStrategy}}",
        },
        {
          id: "wait-only",
          kind: "command",
          dependsOn: ["prepare"],
          stepTimeoutSec: 2400,
          when: { value: "{{inputs.land}}", equals: "report" },
          cmd:
            '${STEAMTRAIN_CLI:-steamtrain} workflow pr wait-checks "{{inputs.pr}}" ' +
            "--timeout-sec {{inputs.checksTimeoutSec}}",
        },
      ],
    },
  ],
};

/**
 * Fan out `babysit-pr` across every open PR. Listing is agent-driven (gh CLI);
 * landing is not — see `babysit-pr` for the wait-then-merge contract.
 */
const babysitAllPrs: WorkflowSpec = {
  name: "babysit-all-prs",
  description:
    "List every open GitHub PR and, for each one in parallel, rebase/fix review comments, wait for every CI and external review check to finish, then merge only when green.",
  inputs: {
    babysitterModel: {
      type: "model",
      description: "Agent model that lists PRs and prepares each one (does not merge).",
      default: FREE.mimoAuto,
      fallbackModels: [FREE.mimoZen, FREE.northMini],
    },
    checksTimeoutSec: {
      type: "number",
      description: "Per-PR max seconds to wait for all status checks.",
      default: 1800,
    },
    land: {
      type: "enum",
      description:
        'After checks are green: "merge" each PR (default), or "report" readiness without merging.',
      choices: ["merge", "report"],
      default: "merge",
    },
    mergeStrategy: {
      type: "enum",
      description: "gh pr merge strategy used when land=merge.",
      choices: ["squash", "merge", "rebase"],
      default: "squash",
    },
  },
  phases: [
    {
      id: "list",
      title: "List open pull requests",
      steps: [
        {
          id: "list-prs",
          kind: "distributor",
          // Model-only so {{inputs.babysitterModel}} can select mimo or opencode.
          model: "{{inputs.babysitterModel}}",
          itemsPath: "prs",
          prompt:
            "You are in a checkout of the current project. List all OPEN (non-draft) pull requests on GitHub using the gh CLI, e.g. " +
            "`gh pr list --state open --json number,headRefName,isDraft --limit 200`.\n\n" +
            "Skip drafts. Do not merge, close, or modify any PR.\n\n" +
            'End your reply with JSON matching: { "prs": ["123", "456"] } — each entry a PR number as a string. Use an empty array when there are no open non-draft PRs.',
          output: {
            type: "object",
            required: ["prs"],
            properties: {
              prs: {
                type: "array",
                items: { type: "string" },
              },
            },
          },
        },
      ],
    },
    {
      id: "babysit",
      title: "Babysit each PR",
      steps: [
        {
          id: "babysit",
          kind: "workflow",
          workflow: "babysit-pr",
          dependsOn: ["list-prs"],
          forEach: "steps.list-prs.items",
          input: "babysit PR {{item}}",
          params: {
            pr: "{{item}}",
            babysitterModel: "{{inputs.babysitterModel}}",
            checksTimeoutSec: "{{inputs.checksTimeoutSec}}",
            land: "{{inputs.land}}",
            mergeStrategy: "{{inputs.mergeStrategy}}",
          },
        },
      ],
    },
    {
      id: "summary",
      title: "Summarize",
      steps: [
        {
          id: "report",
          kind: "consolidator",
          // Depend on list-prs (not babysit) so a partial fan-out failure still
          // produces a summary. Template refs to babysit keep scheduling order
          // via computeEffectiveDeps without cascading the failure.
          dependsOn: ["list-prs"],
          prompt:
            "Babysit-all-PRs run complete.\n\n" +
            "Open PRs considered:\n{{steps.list-prs.items}}\n\n" +
            "Per-PR results:\n{{steps.babysit.output}}",
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
  [mainlineStream.name]: mainlineStream,
  [mainline.name]: mainline,
  [babysitPr.name]: babysitPr,
  [babysitAllPrs.name]: babysitAllPrs,
};
