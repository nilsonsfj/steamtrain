# Sub-Workflows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `"kind": "workflow"` step that invokes another named workflow as a child run, so a workflow (e.g. `bug-hunt`) can be embedded as one stage of a bigger pipeline, per roadmap 2.5 (scoped to sub-workflows only — step templates are a separate follow-up).

**Architecture:** A new discriminated-union step kind (`WorkflowCallStep`) with an executor (`executeWorkflowStep` in `engine.ts`) that recursively calls the existing `runWorkflow` async generator on a catalog-resolved child spec, translates the child's event stream into the parent's own namespaced (`<workflowStepId>::<childId>`) phase/step ids, and returns the child's leaf results as `childResults` on the parent step's `StepResult` — reusing the *existing* fan-out cost/token summation and run-history flattening machinery unchanged.

**Tech Stack:** TypeScript, zod (schema validation), vitest (tests). No new dependencies.

## Global Constraints

- Design doc: `docs/superpowers/specs/2026-07-04-sub-workflows-design.md` — read it before starting; every decision below traces back to a numbered decision there.
- `validateWorkflow` (`src/workflow/types.ts`) stays pure and synchronous — no catalog access at validate time (design decision 4). Do not add `resolveWorkflow`-style parameters to it.
- A workflow step is never eligible as a `workspace: "inherit:<stepId>"` source. This is already enforced generically by the existing allowlist check in `validateWorkflow` (only `worker`/`processor`/`command` source kinds pass) — **no code change needed for this**, only verify it via a test.
- `MAX_WORKFLOW_NESTING_DEPTH = 5` is a hardcoded constant, not configurable (YAGNI — no evidence yet that it needs to be).
- Namespacing separator is the literal string `"::"` (e.g. `myWorkflowStep::childStep`). Do not use `.` or `/` — `.` collides with template field separators, `/` looks like a path.
- Every new/modified function must follow the existing executor convention in `engine.ts`: never throw: catch and convert failures to a `StepResult` with `ok: false`; always set `durationMs`.

---

### Task 1: `WorkflowCallStep` type, schema, and constant

**Files:**
- Modify: `src/workflow/types.ts:24-31` (kind union), `src/workflow/types.ts:322-328` (step union), `src/workflow/types.ts:446-453` (constants), `src/workflow/types.ts:674-681` (zod union)
- Modify: `src/workflow/index.ts:1-31` (exports)
- Test: `tests/workflow-spec.test.ts`

**Interfaces:**
- Produces: `WorkflowCallStep` interface (`kind: "workflow"`, `workflow: string`, `input?: string`, `outputStep?: string`), exported from `src/workflow/types.ts` and re-exported from `src/workflow/index.ts`.
- Produces: `MAX_WORKFLOW_NESTING_DEPTH` constant (`= 5`), exported the same way.
- Produces: `workflowCallStepSchema` (zod), added to the `workflowStepSchema` union — later tasks don't consume this by name, but it must exist so `workflowSpecSchema.safeParse` accepts `kind: "workflow"` specs.

- [ ] **Step 1: Write the failing schema tests**

Add to `tests/workflow-spec.test.ts` (check the existing file's `describe`/`it` structure first with `grep -n "describe(\|it(" tests/workflow-spec.test.ts` and match its style — it validates specs via `workflowSpecSchema.safeParse` and/or `validateWorkflow`). Add a new `describe("workflow (sub-workflow) step", ...)` block:

```ts
describe("workflow (sub-workflow) step", () => {
  function specWith(step: Record<string, unknown>): WorkflowSpec {
    return {
      name: "parent",
      phases: [{ id: "p1", title: "P1", steps: [step as never] }],
    };
  }

  it("accepts a minimal workflow step", () => {
    const result = validateWorkflow(specWith({ id: "call", kind: "workflow", workflow: "child" }));
    expect(result.ok).toBe(true);
  });

  it("accepts input and outputStep fields", () => {
    const result = validateWorkflow(
      specWith({
        id: "call",
        kind: "workflow",
        workflow: "child",
        input: "{{input}} extra",
        outputStep: "final",
      }),
    );
    expect(result.ok).toBe(true);
  });

  it("rejects a workflow step with an empty workflow name", () => {
    const result = validateWorkflow(specWith({ id: "call", kind: "workflow", workflow: "" }));
    expect(result.ok).toBe(false);
  });

  it("rejects a workflow step missing the workflow field", () => {
    const result = validateWorkflow(specWith({ id: "call", kind: "workflow" }));
    expect(result.ok).toBe(false);
  });

  it("rejects a later step from inheriting a workflow step's workspace", () => {
    const spec: WorkflowSpec = {
      name: "parent",
      phases: [
        { id: "p1", title: "P1", steps: [{ id: "call", kind: "workflow", workflow: "child" } as never] },
        {
          id: "p2",
          title: "P2",
          steps: [
            {
              id: "next",
              kind: "command",
              cmd: "echo hi",
              workspace: "inherit:call",
            },
          ],
        },
      ],
    };
    const result = validateWorkflow(spec);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("workflow");
  });
});
```

Import `type { WorkflowSpec }` at the top if not already imported (check the existing import block first).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/workflow-spec.test.ts -t "workflow (sub-workflow) step"`
Expected: FAIL — zod rejects `kind: "workflow"` as not matching any schema in the union (or a TypeScript error if `as never` doesn't satisfy the `WorkflowStep` cast — that's fine, the cast is deliberately loose until Step 3 adds the real type).

- [ ] **Step 3: Add the type, constant, and schema**

In `src/workflow/types.ts`, change the kind union (currently lines 24-31):

```ts
export type WorkflowStepKind =
  | "worker"
  | "processor"
  | "distributor"
  | "consolidator"
  | "gate"
  | "merge"
  | "command"
  | "workflow";
```

After the `CommandStep` interface (ends at line 280, right before `export interface GateCondition`), add:

```ts
/**
 * Invokes another named workflow as a child run. The child run's own steps
 * fold into THIS run's history under a namespaced id
 * (`<thisStepId>::<childStepId>`) — see `executeWorkflowStep` in engine.ts.
 * Never itself owns a worktree or spawns an agent; the child's own steps
 * handle that internally, so it deliberately does NOT mix in
 * `AgentRunFields`/`WorkspaceFields` and is not an eligible
 * `workspace: "inherit:<stepId>"` source (enforced by the same allowlist
 * check that already excludes gate/distributor/consolidator/merge steps).
 *
 * Budget note: this step counts as a fixed cost of 1 toward the PARENT
 * spec's own `MAX_STEPS`; the child spec enforces its own independent
 * `MAX_STEPS` at its own validate time. See
 * docs/superpowers/specs/2026-07-04-sub-workflows-design.md
 * ("Step budget decision") for why this is a deliberate deviation from
 * combining both into one static ceiling.
 */
export interface WorkflowCallStep extends WorkflowStepBase {
  kind: "workflow";
  /** Name of the workflow to invoke (resolved via `WorkflowDeps.resolveWorkflow` at run time). */
  workflow: string;
  /** Template rendered to become the child run's `{{input}}`. Omitted ⇒ this run's own `{{input}}` passes through unchanged. */
  input?: string;
  /**
   * Id of the child step whose `output`/`json` surface as this step's own
   * result. Omitted ⇒ the child spec's last step (last phase, last step by
   * array position — NOT chronological completion order, which is
   * non-deterministic under concurrent scheduling).
   */
  outputStep?: string;
}
```

Change the `WorkflowStep` union (currently lines 322-328):

```ts
export type WorkflowStep =
  | WorkerStep
  | DistributorStep
  | ConsolidatorStep
  | GateStep
  | MergeStep
  | CommandStep
  | WorkflowCallStep;
```

After `LOOP_MAX_ITERATIONS_CEILING` (currently line 453), add:

```ts
/** Hard ceiling on nested `workflow` step call-stack depth (cycle/blast-radius backstop). */
export const MAX_WORKFLOW_NESTING_DEPTH = 5;
```

After `workflowCommandStepSchema` (ends at line 672, right before `const workflowStepSchema = z.union([...`), add:

```ts
const workflowCallStepSchema = z.object({
  ...baseStepShape,
  kind: z.literal("workflow"),
  workflow: z.string().min(1),
  input: z.string().min(1).optional(),
  outputStep: z.string().min(1).optional(),
});
```

Change the union (currently lines 674-681):

```ts
const workflowStepSchema = z.union([
  workflowGateStepSchema,
  workflowDistributorStepSchema,
  workflowConsolidatorStepSchema,
  workflowMergeStepSchema,
  workflowCommandStepSchema,
  workflowCallStepSchema,
  workflowWorkerStepSchema,
]);
```

(`workflowWorkerStepSchema` stays last — it's the only schema whose `kind` is optional/defaulted, so it must be tried last or it could shadow a more specific literal-`kind` match in some zod union edge cases; this matches the existing ordering convention where all literal-`kind` schemas precede it.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/workflow-spec.test.ts -t "workflow (sub-workflow) step"`
Expected: PASS (all 5 cases)

- [ ] **Step 5: Export the new symbols**

In `src/workflow/index.ts`, in the first `export { ... } from "./types"` block (lines 1-31), add `type WorkflowCallStep` (alongside the other step-kind types) and `MAX_WORKFLOW_NESTING_DEPTH` (alongside `MAX_STEPS`, `MAX_CONCURRENCY`):

```ts
export {
  type AgentBackedWorkflowStep,
  type AgentRunFields,
  type AgentWorktreeInfo,
  type CommandStep,
  type ConsolidatorStep,
  type DistributorStep,
  type GateCondition,
  type GateStep,
  type MergeStep,
  type WorkerStep,
  type WorkflowCallStep,
  type WorkflowItem,
  type WorkflowStep,
  type WorkflowStepKind,
  type WorkflowPhase,
  type WorkflowSpec,
  type WorkspaceFields,
  type StepArtifact,
  type StepResult,
  type ValidationResult,
  workflowSpecSchema,
  validateWorkflow,
  workflowStepKind,
  parseForEachSource,
  workspaceSourceId,
  artifactName,
  isAgentBackedStep,
  workflowAgentIds,
  MAX_STEPS,
  MAX_CONCURRENCY,
  MAX_WORKFLOW_NESTING_DEPTH,
} from "./types";
```

- [ ] **Step 6: Type-check and run the full existing types/spec test suite**

Run: `npx tsc --noEmit`
Expected: no errors (existing switch statements over `WorkflowStepKind`/`WorkflowStep` in engine.ts will now be missing the `"workflow"` case — that's expected and fixed in Task 3; if `tsc` errors on `engine.ts`'s exhaustiveness right now, that's fine, it'll be resolved before this plan finishes. Confirm the errors are ONLY in `engine.ts`, not in `types.ts` or `index.ts`.)

Run: `npx vitest run tests/workflow-spec.test.ts`
Expected: PASS (all cases, not just the new ones — confirms no regression)

- [ ] **Step 7: Commit**

```bash
git add src/workflow/types.ts src/workflow/index.ts tests/workflow-spec.test.ts
git commit -m "feat(workflow): add workflow (sub-workflow) step type and schema"
```

---

### Task 2: Engine plumbing — `resolveWorkflow`, call-stack threading

**Files:**
- Modify: `src/workflow/engine.ts:60-79` (`WorkflowDeps`), `src/workflow/engine.ts:81-90` (`WorkflowRunContext`), `src/workflow/engine.ts:969-986` (`ExecuteContext`), `src/workflow/engine.ts:795-810` (the `executeStep` call site inside `runSingleStep`)
- Test: none in this task — this is pure plumbing with no behavior yet; Task 3's tests exercise it end to end. (Per the task-sizing rule, this could be folded into Task 3, but it's kept separate because it changes three shared interfaces that Task 3, Task 4, and Task 5 all build on — worth its own compile-and-typecheck checkpoint before the executor logic lands.)

**Interfaces:**
- Consumes: nothing new.
- Produces: `WorkflowDeps.resolveWorkflow?: (name: string) => WorkflowSpec | undefined`; `WorkflowRunContext.workflowCallStack?: string[]`; `ExecuteContext.workflowCallStack: string[]` (always defined here, defaulted from `ctx.workflowCallStack ?? []`) — Task 3's `executeWorkflowStep` reads `ctx.workflowCallStack` and passes an extended array as the child's own `WorkflowRunContext.workflowCallStack`.

- [ ] **Step 1: Add `resolveWorkflow` to `WorkflowDeps`**

In `src/workflow/engine.ts`, in the `WorkflowDeps` interface (currently lines 60-79), add after `loopMaxIterations`:

```ts
  /** Default per-loop iteration cap; a gate's own `maxIterations` overrides it. */
  loopMaxIterations?: number;
  /**
   * Resolves a `workflow`-kind step's `workflow` name to its spec, e.g. via
   * an already-loaded catalog (`Record<string, WorkflowSpec>` lookup).
   * Injected (not imported from `catalog.ts`) so the engine stays decoupled
   * from filesystem/home-dir concerns and unit-testable with fakes. Omitted
   * ⇒ any `workflow` step fails immediately with a clear "not supported in
   * this context" error rather than crashing.
   */
  resolveWorkflow?: (name: string) => WorkflowSpec | undefined;
```

- [ ] **Step 2: Add `workflowCallStack` to `WorkflowRunContext`**

In the same file, in `WorkflowRunContext` (currently lines 81-90):

```ts
export interface WorkflowRunContext {
  /** The user's prompt; available to steps as `{{input}}` / `{{args}}`. */
  input: string;
  /**
   * In-session cache of completed step results. Successful steps are stored
   * here; on a re-run they replay without spawning, which is how a cancelled
   * run resumes. Pass the same Map across runs to enable resume.
   */
  cache?: Map<string, StepResult>;
  /**
   * Names of workflows currently being invoked in the call stack that led to
   * this run (outermost first). Only ever set internally, when a `workflow`
   * step recurses into `runWorkflow` for a child spec — used to detect
   * cycles (A invokes B invokes A) and to enforce
   * `MAX_WORKFLOW_NESTING_DEPTH`. Callers starting a top-level run should
   * never set this.
   */
  workflowCallStack?: string[];
}
```

- [ ] **Step 3: Add `workflowCallStack` to `ExecuteContext` and thread it through**

In `ExecuteContext` (currently lines 969-986), add:

```ts
  /** Loop iteration this step is executing under (1-based). */
  iteration: number;
  /** Names of workflows already on the call stack (see `WorkflowRunContext.workflowCallStack`). Always an array (never undefined) once inside `executeStep`. */
  workflowCallStack: string[];
```

In `runSingleStep` (currently lines 795-810), the call to `executeStep` builds its `ExecuteContext` inline. Add `workflowCallStack: ctx.workflowCallStack ?? []` to that object literal:

```ts
  const execution = await executeStep(
    step,
    {
      input: ctx.input,
      outputs,
      results,
      cache,
      reserveDynamicSteps: env.reserveDynamicSteps,
      deps,
      signal,
      workflowName: spec.name,
      artifactsDir: env.artifactsDir,
      retryDefault: spec.retry,
      stepTimeoutDefault: spec.stepTimeoutSec,
      iteration,
      workflowCallStack: ctx.workflowCallStack ?? [],
    },
    {
```

(`ctx` here is `env.ctx`, the `WorkflowRunContext` — confirm this by checking the destructure at the top of `runSingleStep`: `const { spec, ctx, deps, signal, cache, outputs, results, allResults } = env;`.)

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: the only remaining errors should be in `engine.ts`'s `executeStep` function (missing exhaustive handling of `kind === "workflow"`) — that's resolved in Task 3.

- [ ] **Step 5: Commit**

```bash
git add src/workflow/engine.ts
git commit -m "feat(workflow): thread resolveWorkflow and call-stack through engine context"
```

---

### Task 3: `executeWorkflowStep` executor

**Files:**
- Modify: `src/workflow/engine.ts` — add `executeWorkflowStep` and `lastStepId` functions (near `executeCommandStep`, currently ending at line 1873 — insert the new functions right after it, before `executeMergeStep`), and wire the dispatch branch into `executeStep` (currently lines 1001-1128)
- Test: Create `tests/workflow-workflow-step.test.ts`

**Interfaces:**
- Consumes: `WorkflowDeps.resolveWorkflow`, `ExecuteContext.workflowCallStack`, `WorkflowCallStep` (all from Tasks 1-2); `runWorkflow` (self-recursive call, already exported from this same file); `renderPrompt` from `./template` (already imported).
- Produces: `executeWorkflowStep(step: WorkflowCallStep, ctx: ExecuteContext, hooks: ExecuteHooks): Promise<ExecutionOutcome>` and `lastStepId(spec: WorkflowSpec): string` — both internal to `engine.ts`, not exported. Later tasks (4, 6) don't call these directly; they exercise them through `runWorkflow`.

- [ ] **Step 1: Write the failing executor tests**

Create `tests/workflow-workflow-step.test.ts`:

```ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentAdapter, AgentRunOptions } from "../src/agents";
import type { AgentEvent, AgentId } from "../src/types/events";
import {
  type StepResult,
  type WorkflowDeps,
  type WorkflowEvent,
  type WorkflowSpec,
  runWorkflow,
} from "../src/workflow";

const tempRoots: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "steamtrain-workflow-step-test-"));
  tempRoots.push(dir);
  return dir;
}

function fakeAdapter(id: AgentId, textOf: (opts: AgentRunOptions) => string = (o) => `out:${o.prompt}`): AgentAdapter {
  return {
    id,
    binary: "fake",
    run(opts: AgentRunOptions) {
      return (async function* () {
        yield {
          kind: "result",
          agent: id,
          ts: 0,
          isError: false,
          text: textOf(opts),
          costUsd: 0.01,
        } satisfies AgentEvent;
      })();
    },
  };
}

function deps(cwd: string, over: Partial<WorkflowDeps> = {}): WorkflowDeps {
  return {
    createAdapter: (() => fakeAdapter("claude" as AgentId)) as WorkflowDeps["createAdapter"],
    maxConcurrency: 4,
    cwd,
    ...over,
  };
}

async function runToEvents(spec: WorkflowSpec, d: WorkflowDeps, input = "task"): Promise<WorkflowEvent[]> {
  const events: WorkflowEvent[] = [];
  for await (const ev of runWorkflow(spec, { input }, d)) events.push(ev);
  return events;
}

function doneResults(events: WorkflowEvent[]): Map<string, StepResult> {
  const map = new Map<string, StepResult>();
  for (const ev of events) if (ev.kind === "step_done") map.set(ev.stepId, ev.result);
  return map;
}

function workflowOk(events: WorkflowEvent[]): boolean {
  const done = events.find((ev) => ev.kind === "workflow_done");
  return done?.kind === "workflow_done" ? done.ok : false;
}

const childSpec: WorkflowSpec = {
  name: "child",
  phases: [
    {
      id: "only",
      title: "Only",
      steps: [{ id: "greet", agent: "claude", model: "m", prompt: "hi {{input}}" }],
    },
  ],
};

const parentSpec: WorkflowSpec = {
  name: "parent",
  phases: [
    {
      id: "p1",
      title: "P1",
      steps: [{ id: "call", kind: "workflow", workflow: "child", input: "{{input}}-sub" }],
    },
  ],
};

describe("workflow (sub-workflow) step", () => {
  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("invokes the child workflow, flattens its steps under a namespaced id, and surfaces the last step's output", async () => {
    const cwd = await tempDir();
    const events = await runToEvents(
      parentSpec,
      deps(cwd, { resolveWorkflow: (name) => (name === "child" ? childSpec : undefined) }),
      "go",
    );
    const results = doneResults(events);
    expect(results.has("call::greet")).toBe(true);
    expect(results.get("call::greet")?.output).toBe("hi go-sub");
    expect(results.get("call")?.output).toBe("hi go-sub");
    expect(results.get("call")?.ok).toBe(true);
    expect(workflowOk(events)).toBe(true);
  });

  it("rolls up the child's leaf cost onto the parent run without double-counting the workflow step itself", async () => {
    const cwd = await tempDir();
    const events = await runToEvents(
      parentSpec,
      deps(cwd, { resolveWorkflow: (name) => (name === "child" ? childSpec : undefined) }),
    );
    const results = doneResults(events);
    expect(results.get("call")?.costUsd).toBeUndefined();
    expect(results.get("call::greet")?.costUsd).toBeCloseTo(0.01);
    expect(results.get("call")?.childResults?.length).toBe(1);
  });

  it("uses an explicit outputStep instead of the child's last step", async () => {
    const cwd = await tempDir();
    const twoStepChild: WorkflowSpec = {
      name: "child2",
      phases: [
        {
          id: "only",
          title: "Only",
          steps: [
            { id: "first", agent: "claude", model: "m", prompt: "first" },
            { id: "second", dependsOn: ["first"], agent: "claude", model: "m", prompt: "second" },
          ],
        },
      ],
    };
    const spec: WorkflowSpec = {
      name: "parent2",
      phases: [
        {
          id: "p1",
          title: "P1",
          steps: [{ id: "call", kind: "workflow", workflow: "child2", outputStep: "first" }],
        },
      ],
    };
    const events = await runToEvents(
      spec,
      deps(cwd, { resolveWorkflow: () => twoStepChild }),
    );
    const results = doneResults(events);
    expect(results.get("call")?.output).toBe("out:first");
  });

  it("fails clearly when resolveWorkflow is not configured", async () => {
    const cwd = await tempDir();
    const events = await runToEvents(parentSpec, deps(cwd));
    const results = doneResults(events);
    expect(results.get("call")?.ok).toBe(false);
    expect(results.get("call")?.error).toContain("not supported in this context");
    expect(workflowOk(events)).toBe(false);
  });

  it("fails clearly on an unknown workflow name", async () => {
    const cwd = await tempDir();
    const events = await runToEvents(parentSpec, deps(cwd, { resolveWorkflow: () => undefined }));
    const results = doneResults(events);
    expect(results.get("call")?.ok).toBe(false);
    expect(results.get("call")?.error).toContain("unknown workflow 'child'");
  });

  it("rejects a direct self-cycle", async () => {
    const cwd = await tempDir();
    const selfSpec: WorkflowSpec = {
      name: "loopy",
      phases: [{ id: "p1", title: "P1", steps: [{ id: "call", kind: "workflow", workflow: "loopy" }] }],
    };
    const events = await runToEvents(selfSpec, deps(cwd, { resolveWorkflow: () => selfSpec }));
    const results = doneResults(events);
    expect(results.get("call")?.ok).toBe(false);
    expect(results.get("call")?.error).toContain("cycle");
  });

  it("rejects an indirect A->B->A cycle", async () => {
    const cwd = await tempDir();
    const specA: WorkflowSpec = {
      name: "a",
      phases: [{ id: "p1", title: "P1", steps: [{ id: "callB", kind: "workflow", workflow: "b" }] }],
    };
    const specB: WorkflowSpec = {
      name: "b",
      phases: [{ id: "p1", title: "P1", steps: [{ id: "callA", kind: "workflow", workflow: "a" }] }],
    };
    const catalog: Record<string, WorkflowSpec> = { a: specA, b: specB };
    const events = await runToEvents(specA, deps(cwd, { resolveWorkflow: (name) => catalog[name] }));
    const results = doneResults(events);
    expect(results.get("callB")?.ok).toBe(false);
    // callB's own child run (b) fails at its "callA" step; that failure
    // bubbles up as callB's own not-ok result.
    expect(results.get("callB")?.error).toBeDefined();
    expect(workflowOk(events)).toBe(false);
  });

  it("enforces the nesting depth cap", async () => {
    const cwd = await tempDir();
    // Six levels deep (0..5), one more than MAX_WORKFLOW_NESTING_DEPTH (5).
    const catalog: Record<string, WorkflowSpec> = {};
    for (let i = 0; i < 6; i++) {
      catalog[`level${i}`] = {
        name: `level${i}`,
        phases: [
          {
            id: "p1",
            title: "P1",
            steps:
              i < 5
                ? [{ id: "next", kind: "workflow", workflow: `level${i + 1}` }]
                : [{ id: "leaf", agent: "claude", model: "m", prompt: "leaf" }],
          },
        ],
      };
    }
    const events = await runToEvents(
      catalog.level0 as WorkflowSpec,
      deps(cwd, { resolveWorkflow: (name) => catalog[name] }),
    );
    expect(workflowOk(events)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/workflow-workflow-step.test.ts`
Expected: FAIL — `executeStep`'s fallback branch returns `unsupported workflow step kind 'workflow'` for every case (or a TS compile error on `kind: "workflow"` if Task 1 wasn't merged first — it was, per this plan's ordering).

- [ ] **Step 3: Implement `executeWorkflowStep` and `lastStepId`**

In `src/workflow/engine.ts`, add the import of `WorkflowCallStep` and `MAX_WORKFLOW_NESTING_DEPTH` to the existing `from "./types"` import block (currently lines 33-52):

```ts
import {
  type AgentBackedWorkflowStep,
  type AgentWorktreeInfo,
  type CommandStep,
  DEFAULT_LOOP_MAX_ITERATIONS,
  type GateCondition,
  MAX_CONCURRENCY,
  MAX_STEPS,
  MAX_WORKFLOW_NESTING_DEPTH,
  type MergeStep,
  type StepResult,
  type WorkerStep,
  type WorkflowCallStep,
  type WorkflowItem,
  type WorkflowPhase,
  type WorkflowSpec,
  type WorkflowStep,
  isAgentBackedStep,
  parseForEachSource,
  validateWorkflow,
  workflowStepKind,
  workspaceSourceId,
} from "./types";
```

Right after `executeCommandStep` (currently ends at line 1873, right before `/** * Execute a \`merge\` step: ... */`), add:

```ts
/** The last step (by array position, NOT chronological completion order) of a spec's last phase. Deterministic default output source for a `workflow` step that omits `outputStep`. */
function lastStepId(spec: WorkflowSpec): string | undefined {
  const lastPhase = spec.phases[spec.phases.length - 1];
  const steps = lastPhase?.steps ?? [];
  return steps[steps.length - 1]?.id;
}

/**
 * Execute a `workflow` step: recursively run another named workflow (resolved
 * via `ctx.deps.resolveWorkflow`) and fold its event stream into this run's
 * own, under the namespace `<thisStepId>::<childId>` for both phase and step
 * ids. The child's leaf step results become this step's `childResults` —
 * exactly the shape a `forEach` fan-out parent already produces — so the
 * existing cost/token summation (`runSingleStep`) and run-history flattening
 * (`computeRunTotals`, which already skips any step whose result carries
 * `childResults`) apply completely unmodified. Cycle/depth-guarded via
 * `ctx.workflowCallStack`; never itself allocates a worktree (no agent, no
 * `WorkspaceFields`) — the child's own steps handle that internally.
 */
async function executeWorkflowStep(
  step: WorkflowCallStep,
  ctx: ExecuteContext,
  hooks: ExecuteHooks,
): Promise<ExecutionOutcome> {
  const started = Date.now();
  const fail = (message: string): ExecutionOutcome => ({
    result: {
      stepId: step.id,
      ok: false,
      output: message,
      error: message,
      durationMs: Date.now() - started,
    },
  });

  const resolveWorkflow = ctx.deps.resolveWorkflow;
  if (!resolveWorkflow) {
    return fail("workflow steps are not supported in this context (no resolveWorkflow configured)");
  }
  const childSpec = resolveWorkflow(step.workflow);
  if (!childSpec) return fail(`unknown workflow '${step.workflow}'`);

  const stack = ctx.workflowCallStack;
  if (stack.includes(step.workflow)) {
    return fail(`workflow cycle detected: ${[...stack, step.workflow].join(" -> ")}`);
  }
  if (stack.length >= MAX_WORKFLOW_NESTING_DEPTH) {
    return fail(
      `workflow nesting depth exceeded ${MAX_WORKFLOW_NESTING_DEPTH} (invoking '${step.workflow}')`,
    );
  }

  const childInput = step.input
    ? renderPrompt(step.input, {
        input: ctx.input,
        outputs: ctx.outputs,
        results: ctx.results,
        iteration: ctx.iteration,
      })
    : ctx.input;

  const namespace = (id: string): string => `${step.id}::${id}`;
  const childResults: StepResult[] = [];
  const rawResults = new Map<string, StepResult>();
  let childOk = false;

  for await (const event of runWorkflow(
    childSpec,
    { input: childInput, workflowCallStack: [...stack, step.workflow] },
    ctx.deps,
    ctx.signal,
  )) {
    switch (event.kind) {
      case "workflow_start":
        break;
      case "workflow_done":
        childOk = event.ok;
        break;
      case "phase_start":
      case "phase_done":
        hooks.pushWorkflowEvent({ ...event, phaseId: namespace(event.phaseId) });
        break;
      case "step_start":
        hooks.pushWorkflowEvent({
          ...event,
          phaseId: namespace(event.phaseId),
          stepId: namespace(event.stepId),
          parentStepId: event.parentStepId ? namespace(event.parentStepId) : step.id,
        });
        break;
      case "step_done": {
        rawResults.set(event.result.stepId, event.result);
        const namespaced: StepResult = {
          ...event.result,
          stepId: namespace(event.result.stepId),
          parentStepId: event.result.parentStepId ? namespace(event.result.parentStepId) : step.id,
        };
        childResults.push(namespaced);
        hooks.pushWorkflowEvent({
          ...event,
          phaseId: namespace(event.phaseId),
          stepId: namespace(event.stepId),
          result: namespaced,
        });
        break;
      }
      case "step_event":
      case "step_retry":
      case "gate_evaluated":
        hooks.pushWorkflowEvent({
          ...event,
          phaseId: namespace(event.phaseId),
          stepId: namespace(event.stepId),
        });
        break;
      case "fan_out":
        hooks.pushWorkflowEvent({
          ...event,
          phaseId: namespace(event.phaseId),
          parentStepId: namespace(event.parentStepId),
        });
        break;
      case "loop_iteration":
        hooks.pushWorkflowEvent({ ...event, gateStepId: namespace(event.gateStepId) });
        break;
      case "budget_exceeded":
        hooks.pushWorkflowEvent(event.stepId ? { ...event, stepId: namespace(event.stepId) } : event);
        break;
    }
  }

  const outputStepId = step.outputStep ?? lastStepId(childSpec);
  const outputResult = outputStepId ? rawResults.get(outputStepId) : undefined;
  if (!outputResult) {
    return fail(
      step.outputStep
        ? `outputStep '${step.outputStep}' did not produce a result in workflow '${step.workflow}'`
        : `workflow '${step.workflow}' produced no step results`,
    );
  }

  return {
    result: {
      stepId: step.id,
      ok: childOk,
      output: outputResult.output,
      json: outputResult.json,
      error: childOk ? undefined : `sub-workflow '${step.workflow}' did not complete successfully`,
      durationMs: Date.now() - started,
      childResults,
    },
    childResults,
  };
}
```

- [ ] **Step 4: Wire the dispatch branch into `executeStep`**

In `executeStep` (currently lines 1001-1128), add a branch before the final fallback (right after the `if (kind === "gate" && step.kind === "gate") { ... }` block, currently ending at line 1117):

```ts
  if (kind === "workflow" && step.kind === "workflow") {
    return executeWorkflowStep(step, ctx, hooks);
  }

  return {
    result: {
      stepId: step.id,
      ok: false,
      output: `unsupported workflow step kind '${kind}'`,
      error: `unsupported workflow step kind '${kind}'`,
      durationMs: 0,
    },
  };
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/workflow-workflow-step.test.ts`
Expected: PASS (all 8 cases)

- [ ] **Step 6: Type-check and run the full workflow test suite**

Run: `npx tsc --noEmit`
Expected: no errors

Run: `npx vitest run tests/workflow-*.test.ts`
Expected: PASS (no regressions in any existing workflow test file)

- [ ] **Step 7: Commit**

```bash
git add src/workflow/engine.ts tests/workflow-workflow-step.test.ts
git commit -m "feat(workflow): implement the workflow (sub-workflow) step executor"
```

---

### Task 4: Fix template-reference dependency scanning for namespaced child ids

**Files:**
- Modify: `src/workflow/engine.ts:600-606` (`computeEffectiveDeps`'s `addEarlier` helper)
- Test: add to `tests/workflow-workflow-step.test.ts`

**Why this is its own task:** discovered during design — `{{steps.<workflowStepId>::<childStepId>.output}}` is a valid, already-working *template render* (§ design doc decision 6 — no new template syntax needed since `template.ts`'s regexes are unanchored on `::`). But `computeEffectiveDeps` (the DAG scheduler's implicit-dependency scanner) currently maps an unrecognized ref straight through unless it matches the `\[\d+\]$` forEach-child suffix pattern — a namespaced child ref like `wf::child` isn't in `phaseIndexOf` (which only has top-level static ids) and doesn't match that suffix, so the ref is silently dropped and the scheduler would **not** wait for the `wf` workflow step before starting a step that reads `{{steps.wf::child.output}}`. This is a real under-match race, not just a cosmetic gap (the code comment at `engine.ts:576-579` explicitly says under-matching is a bug, over-matching is fine).

**Interfaces:**
- Consumes: nothing new — same `computeEffectiveDeps` signature.
- Produces: nothing new — internal behavior fix only.

- [ ] **Step 1: Write the failing test**

This asserts on **event ordering**, not just final output, because that's the
only way to deterministically prove the scheduling dependency exists: under
`runDagScheduler`, a step is launched the instant its recognized deps are a
subset of `settled` (`engine.ts:513-524`) — launching happens synchronously
within the driver's scan, before any `await`. Concretely: if `downstream` has
NO recognized dependency on `call`, both are ready in the very first scan
(each has an empty recognized-deps set) and `downstream`'s `step_start` is
pushed in that same synchronous pass, before `call` has settled. If the
dependency IS recognized, `downstream` cannot launch until `call` is in
`settled` — so its `step_start` is strictly ordered after `call`'s
`step_done`. Fake-adapter timing doesn't matter here; this is about
scheduler-internal ordering, not wall-clock races.

Add to `tests/workflow-workflow-step.test.ts` (reuse `deps`/`runToEvents` from Task 3):

```ts
  it("schedules a step referencing a namespaced child output strictly after the workflow step settles", async () => {
    const cwd = await tempDir();
    const spec: WorkflowSpec = {
      name: "parent3",
      phases: [
        {
          id: "p1",
          title: "P1",
          steps: [{ id: "call", kind: "workflow", workflow: "child" }],
        },
        {
          id: "p2",
          title: "P2",
          steps: [
            {
              id: "downstream",
              kind: "command",
              // No explicit dependsOn — this reaches into the child's own
              // step by namespaced id, which must still create an implicit
              // scheduling dependency on the "call" workflow step.
              cmd: "echo got:{{steps.call::greet.output}}",
            },
          ],
        },
      ],
    };
    const events = await runToEvents(spec, deps(cwd, { resolveWorkflow: () => childSpec }));
    const callDoneIndex = events.findIndex((ev) => ev.kind === "step_done" && ev.stepId === "call");
    const downstreamStartIndex = events.findIndex(
      (ev) => ev.kind === "step_start" && ev.stepId === "downstream",
    );
    expect(callDoneIndex).toBeGreaterThanOrEqual(0);
    expect(downstreamStartIndex).toBeGreaterThan(callDoneIndex);
    const results = doneResults(events);
    expect(results.get("downstream")?.output).toContain("got:hi task");
    expect(workflowOk(events)).toBe(true);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/workflow-workflow-step.test.ts -t "strictly after the workflow step settles"`
Expected: FAIL on `expect(downstreamStartIndex).toBeGreaterThan(callDoneIndex)` — before the fix, `downstream`'s recognized deps are empty (the `call::greet` ref doesn't resolve to `call`), so it launches in the same synchronous scan as `call`, before `call` settles.

- [ ] **Step 3: Fix `addEarlier`**

In `computeEffectiveDeps` (currently lines 581-650), change the `addEarlier` closure (currently lines 600-606):

```ts
      const addEarlier = (ref: string | undefined): void => {
        if (!ref) return;
        // A namespaced sub-workflow child reference (`wf::child`) depends on
        // its owning `workflow` step; strip to the owner BEFORE the existing
        // forEach `[n]`-suffix stripping, so `wf::child[2]`-shaped refs (a
        // forEach step nested inside a sub-workflow) still resolve correctly.
        const owner = ref.includes("::") ? ref.slice(0, ref.indexOf("::")) : ref;
        // A `work[3]` fan-out child reference depends on its `work` parent.
        const id = phaseIndexOf.has(owner) ? owner : owner.replace(/\[\d+\]$/, "");
        const refPhase = phaseIndexOf.get(id);
        if (refPhase !== undefined && refPhase < pi) stepDeps.add(id);
      };
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/workflow-workflow-step.test.ts`
Expected: PASS (all cases, including the new one)

Run: `npx vitest run tests/workflow-dag-scheduling.test.ts`
Expected: PASS (no regression — this fix only adds behavior for refs containing `::`, which no existing spec produces)

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add src/workflow/engine.ts tests/workflow-workflow-step.test.ts
git commit -m "fix(workflow): schedule on namespaced sub-workflow child template refs"
```

---

### Task 5: Wire `resolveWorkflow` into the production orchestrator

**Files:**
- Modify: `src/orchestrator/orchestrator.ts:192-218` (`Orchestrator.runWorkflow`)
- Test: check for an existing `tests/orchestrator*.test.ts` file (`grep -rln "class Orchestrator\|new Orchestrator" tests/`) and add a case there if one exists; otherwise this task's behavior is already covered end-to-end by Task 3's tests (which construct `WorkflowDeps` directly) — add a small targeted test only if an orchestrator test file already exists and testing this is cheap there.

**Interfaces:**
- Consumes: `this.workflowCatalog: Record<string, WorkflowSpec>` (already a private field, populated in the constructor and `setCatalog`).
- Produces: nothing new — this just wires an existing field into an existing call.

- [ ] **Step 1: Check for an existing orchestrator test file**

Run: `grep -rl "new Orchestrator(" tests/`

If a file is found, open it and note its `WorkflowDeps`/catalog construction pattern before proceeding (skip ahead to Step 3 with that pattern in mind for an optional test addition). If none is found, skip straight to Step 2 (no test-first cycle for this trivial wiring change — it's a one-line addition to an object literal, and it's exercised transitively by any CLI/TUI/web integration test that runs a real workflow through the orchestrator).

- [ ] **Step 2: Wire `resolveWorkflow`**

In `src/orchestrator/orchestrator.ts`, in `runWorkflow` (currently lines 192-218), add `resolveWorkflow` to the `WorkflowDeps` object literal:

```ts
    return runWorkflow(
      spec,
      { input, cache },
      {
        createAdapter,
        binaries: this.config.binaries,
        agentConfig: this.config,
        stepTimeoutSec: resolveStepTimeoutSec(undefined, undefined, this.config),
        maxConcurrency: this.config.maxConcurrency ?? DEFAULT_CONFIG.maxConcurrency!,
        cwd,
        agentWorkspace: createGitWorktreeManager(),
        loopMaxIterations: this.config.loopMaxIterations,
        resolveWorkflow: (name) => this.workflowCatalog[name],
      },
      signal,
    );
```

- [ ] **Step 3 (only if an orchestrator test file exists from Step 1): add a targeted test**

Follow that file's existing setup pattern (a real or fake config + workspace + catalog) to construct an `Orchestrator` with a catalog containing two workflows where one invokes the other via a `"kind": "workflow"` step, run it through `orchestrator.runWorkflow(...)`, and assert the child's namespaced step appears in the resulting events — mirroring the assertions already written in Task 3's `tests/workflow-workflow-step.test.ts`. Skip this step if no such file exists (do not create a new orchestrator test file — the orchestrator's own responsibilities are otherwise untested at this granularity per the codebase's existing conventions, and adding one is out of scope for this plan).

- [ ] **Step 4: Type-check and run the orchestrator suite (if any) plus the full test suite**

Run: `npx tsc --noEmit`
Expected: no errors

Run: `npx vitest run`
Expected: PASS (full suite, no regressions)

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/orchestrator.ts
git commit -m "feat(workflow): wire the workflow catalog into resolveWorkflow for sub-workflow steps"
```

---

### Task 6: Run-history compatibility test (no source changes expected)

**Files:**
- Modify: `tests/workflow-history.test.ts` (add a test case only)

**Why this task exists:** design decision 5 claims the existing `RunRecordBuilder`/`computeRunTotals` machinery needs **zero changes** to correctly flatten a sub-workflow's steps (verified by inspection during planning: `computeRunTotals` already skips any step whose `result.childResults?.length` is truthy, `RunRecordBuilder.handle` already keys phases by the raw `phaseId` string it's given with no assumption it matches a static spec id). This task is the test that proves that claim rather than just asserting it in a design doc.

**Interfaces:**
- Consumes: `RunRecordBuilder`, `computeRunTotals` (already exported from `src/workflow/history.ts`), `runWorkflow` with `resolveWorkflow` (from Tasks 2-3).
- Produces: nothing new.

- [ ] **Step 1: Write the test**

Add to `tests/workflow-history.test.ts`, inside the `describe("RunRecordBuilder", ...)` block (after the existing fan-out test, which ends around line 94 per the file read during planning — confirm the exact line with `grep -n "^describe\|^  it(" tests/workflow-history.test.ts` first):

```ts
  it("flattens a sub-workflow step's child run under a namespaced id without double-counting cost", async () => {
    const cwd = tempDir();
    const childSpec: WorkflowSpec = {
      name: "child",
      phases: [
        { id: "only", title: "Only", steps: [{ id: "greet", agent: "claude", model: "m", prompt: "hi" }] },
      ],
    };
    const parentSpec: WorkflowSpec = {
      name: "parent",
      phases: [
        { id: "p1", title: "P1", steps: [{ id: "call", kind: "workflow", workflow: "child" } as never] },
      ],
    };
    const builder = new RunRecordBuilder({ id: "run-2", workflow: parentSpec.name, input: "go", cwd });
    let ok = true;
    for await (const event of runWorkflow(
      parentSpec,
      { input: "go" },
      { createAdapter: fakeAdapter, maxConcurrency: 2, cwd, resolveWorkflow: () => childSpec },
    )) {
      builder.handle(event as WorkflowEvent);
      if (event.kind === "workflow_done") ok = event.ok;
    }
    const record = builder.build({ status: ok ? "done" : "error" });

    expect(record.ok).toBe(true);
    // The child's phase is its own HistoryPhase, namespaced.
    const childPhase = record.phases.find((p) => p.phaseId === "call::only");
    expect(childPhase).toBeDefined();
    expect(childPhase?.steps.map((s) => s.stepId)).toContain("call::greet");
    // The workflow step itself is excluded from totals (its childResults are
    // counted instead) — same rule that already applies to forEach parents.
    expect(record.totals.steps).toBe(1); // only call::greet
    expect(record.totals.costUsd).toBeCloseTo(0.01);
  });
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run tests/workflow-history.test.ts -t "flattens a sub-workflow"`
Expected: PASS with zero source changes (this is the point of the task — if it fails, that falsifies design decision 5 and the design doc needs revisiting before continuing, not a source-side workaround).

- [ ] **Step 3: Run the full history suite**

Run: `npx vitest run tests/workflow-history.test.ts`
Expected: PASS (no regressions, including the "builder tree matches the live reducer" test)

- [ ] **Step 4: Commit**

```bash
git add tests/workflow-history.test.ts
git commit -m "test(workflow): verify sub-workflow history flattening needs no history.ts changes"
```

---

### Task 7: Documentation

**Files:**
- Modify: `docs/workflow-spec.md` (shared step fields table, new "Workflow (sub-workflow invocation)" building-block section, validation rules)
- Modify: `docs/workflow-examples.md` (one bundled example)

**Interfaces:** none (docs only).

- [ ] **Step 1: Update the shared step fields table**

In `docs/workflow-spec.md`, in the `## Shared step fields` table (currently line 99), change the `kind` row:

```markdown
| `kind` | no | One of `worker`, `processor`, `distributor`, `consolidator`, `gate`, `merge`, `command`, `workflow`. Missing means `worker`. |
```

- [ ] **Step 2: Add the new building-block section**

In `docs/workflow-spec.md`, after the `### Command (deterministic shell step)` section and before `## Workspace inheritance and artifacts (file handoff)` (currently the section boundary is around line 424 — insert right before that `##` heading), add:

```markdown
### Workflow (sub-workflow invocation)

Invokes another named workflow as a child run, so a proven workflow (e.g.
`bug-hunt`) can be embedded as one stage of a bigger pipeline instead of being
copy-pasted or hand-unrolled. Never spawns an agent or owns a worktree itself
— the child run's own steps handle that internally — so it is not an eligible
`workspace: "inherit:<stepId>"` source (like gate/distributor/consolidator/
merge steps).

Required field: `workflow` — the name of the workflow to invoke, resolved
against the same catalog `steamtrain workflow list` shows.

Optional fields: `input` (a template rendered to become the child run's
`{{input}}`; omitted means this run's own `{{input}}` passes through
unchanged), `outputStep` (the id of the child step whose `output`/`json`
surface as this step's own result; omitted means the child spec's last step,
by phase/array position — not by which step happens to finish last, which is
not deterministic under concurrent scheduling).

```jsonc
{
  "id": "bug-sweep",
  "kind": "workflow",
  "workflow": "bug-hunt",
  "input": "{{input}} — focus on the changed files in this release"
}
```

The child run's own phases and steps fold into this run's own history and
live view under a namespaced id, `<thisStepId>::<childStepId>` (and
`<thisStepId>::<childPhaseId>` for phases) — e.g. `bug-sweep::triage`,
`bug-sweep::report`. Downstream steps normally just reference
`{{steps.bug-sweep.output}}` (the resolved output step's text) or
`{{steps.bug-sweep.json.<path>}}`, but can reach a specific child step
directly by its namespaced id, e.g. `{{steps.bug-sweep::report.output}}` —
this works with no special syntax, and (like any other `{{steps.<id>…}}`
reference) creates an implicit scheduling dependency on the `bug-sweep` step.

The child run enforces its own independent 1000-step budget (`MAX_STEPS`) —
it is not combined with the parent's. Nesting more than 5 `workflow` steps
deep, or a cycle (workflow A invoking B invoking A, directly or through
further nesting), fails the step with a clear error at run time.
```

- [ ] **Step 3: Add the validation-rules bullets**

In `docs/workflow-spec.md`, in `## Validation rules` (currently lines 663-692), add after the "Command steps require a non-empty `cmd`." bullet:

```markdown
- Workflow steps require a non-empty `workflow` name. The referenced
  workflow's existence, cycle-freedom, and nesting depth (≤5) are checked at
  **run time**, not at validate time — see
  [the sub-workflows design doc](superpowers/specs/2026-07-04-sub-workflows-design.md)
  for why. A workflow step counts as a fixed cost of 1 toward its own spec's
  1000-step budget regardless of how large the invoked child workflow is;
  the child enforces its own independent 1000-step budget.
```

- [ ] **Step 4: Add a bundled example**

Open `docs/workflow-examples.md`, find where existing bundled-workflow walkthroughs live (`grep -n "^##" docs/workflow-examples.md` first to match its structure/heading level), and add a new example following that same structure — a `release` workflow with one phase whose step invokes `bug-hunt`:

```jsonc
{
  "name": "release",
  "description": "Release checklist that runs the bug-hunt sweep as one of its stages.",
  "phases": [
    {
      "id": "checks",
      "title": "Checks",
      "steps": [
        {
          "id": "bug-sweep",
          "kind": "workflow",
          "workflow": "bug-hunt",
          "input": "{{input}} — pre-release sweep"
        }
      ]
    },
    {
      "id": "gate",
      "title": "Gate",
      "steps": [
        {
          "id": "clean",
          "kind": "gate",
          "dependsOn": ["bug-sweep"],
          "condition": { "step": "bug-sweep", "ok": true },
          "onFalse": "fail"
        }
      ]
    }
  ]
}
```

Add one paragraph of prose above it explaining the composition (matching the tone/length of the surrounding examples in that file), and mention that `bug-sweep`'s internal steps show up in `steamtrain workflow history show <id>` namespaced as `bug-sweep::<step>`.

- [ ] **Step 5: Proofread against the design doc**

Re-read `docs/superpowers/specs/2026-07-04-sub-workflows-design.md` decisions 1-7 side by side with the new `docs/workflow-spec.md` section and confirm no contradictions (in particular: the design doc's "outputStep... default: last step in execution order" phrasing is looser than what got implemented — array-order, not completion-order; confirm the design doc's wording doesn't mislead a future reader, and tighten it in place if so, matching the plan's Task 1/3 wording).

- [ ] **Step 6: Commit**

```bash
git add docs/workflow-spec.md docs/workflow-examples.md docs/superpowers/specs/2026-07-04-sub-workflows-design.md
git commit -m "docs: document the workflow (sub-workflow) step"
```

---

## Post-plan follow-ups (not part of this plan, tracked for later)

- `stepDefaults`/`extends` step templates (the other half of roadmap 2.5) — separate design.
- `generate.ts`'s LLM authoring meta-prompt does not yet teach the model about the `workflow` step kind — an author using the LLM drafter won't get one generated. Worth a small follow-up (one bullet + one worked example, mirroring the existing per-kind sections) once real usage patterns exist.
- The shared budget counter idea from the design doc's "Step budget decision" follow-up, if the independent-per-level 1000-step ceiling ever proves insufficient in practice.
- `workflowAgentIds` (used by `canDispatchWorkflowSpec` for pre-flight agent-health gating) does not look inside an invoked child workflow, so a workflow step's child agents aren't health-checked before dispatch the way a top-level workflow's are — the child's own agent-resolution failure surfaces at run time instead (as a normal `agentBacked` step failure inside the child run). Acceptable given decision 4, but worth a one-line mention if a doctor/dispatch-gating enhancement is ever scoped.
- A `workflow` step's translated child events always carry the *child* run's own `iteration` field, not the parent spec's current loop iteration. If a `workflow` step sits inside a loop-back gate's body (`runPhasedScheduler`) and that loop re-runs multiple times, every pass's namespaced nested steps will show the child's own iteration (typically always 1) instead of being attributed to the parent's 1st/2nd/3rd… pass. This is a live-view/history display limitation, not a cost or correctness bug — worth fixing if nested `workflow` steps inside loop bodies become a common pattern.
