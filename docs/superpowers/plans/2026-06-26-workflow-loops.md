# Workflow Loops Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let workflows express bounded cycles (loop-back gates) so authors no longer unroll iterative work, with a configurable per-loop iteration cap defaulting to 10.

**Architecture:** Extend the existing `gate` step with `loopTo` (an earlier phase id) and `maxIterations`. The engine's phase walk can jump its index backward when a loop gate's condition is unmet and budget remains; each iteration re-emits the body phases tagged with an `iteration` number so the live tree and history unroll naturally. The static spec stays a flat phase list with one back-edge.

**Tech Stack:** TypeScript, Zod (schema/validation), Vitest (tests), tsup (build), Ink/React (TUI), vanilla JS (web SSE), Biome (lint).

## Global Constraints

- No `Co-Authored-By` trailers in commits (commits appear as the user's own work).
- Per-loop iteration cap default = **10** (`DEFAULT_LOOP_MAX_ITERATIONS`), hard ceiling = **100** (`LOOP_MAX_ITERATIONS_CEILING`).
- A loop gate must sit in a phase **after** the phases it re-runs (preserves "gate condition.step must be in an earlier phase").
- Loop regions may **nest** but must not **partially overlap** (proper nesting only).
- Non-loop runs must behave **byte-identically** to today (the `iteration` field is optional everywhere; absent ⇒ treated as 1). The reducer↔history-builder lockstep test (`tests/workflow-history.test.ts`) must keep passing.
- Validation is shared: `validateWorkflow` is the single gate for CLI / TUI / web / LLM-repair.
- Verify each task with: `npx vitest run <file>` (targeted), `npx tsc --noEmit` (typecheck), `npx biome check` (lint). Full suite: `npx vitest run`. Build: `npm run build`.
- Web-server socket tests need `dangerouslyDisableSandbox: true` (EPERM on listen in sandbox).

---

## File Structure

- `src/workflow/types.ts` — loop fields on `GateStep`, schema, constants, `validateWorkflow` loop rules + budget. (Task 1)
- `src/config/types.ts`, `src/config/defaults.ts`, `src/config/load.ts` — `loopMaxIterations` config. (Task 2)
- `src/workflow/template.ts` — `{{iteration}}` rendering. (Task 3)
- `src/workflow/events.ts` — `iteration?` on events + `LoopIterationEvent`. (Task 4, with engine)
- `src/workflow/engine.ts` — backward phase jump, per-gate counters, cache invalidation, effectiveMax, event tagging. (Task 4)
- `src/orchestrator/orchestrator.ts` — thread `loopMaxIterations` into `WorkflowDeps`. (Task 4)
- `src/tui/workflow-state.ts`, `src/workflow/history.ts` — iteration-composite fold keys + render-model `iteration`. (Task 5)
- `src/tui/workflow-spec-ui.ts`, `src/tui/WorkflowView.tsx`, `src/tui/WorkflowStepDetails.tsx` — display loop edge + iteration badges. (Task 6)
- `src/web/html.ts`, `src/web/server.ts` — web spec render + iteration-aware live view + authoring round-trip. (Task 7)
- `src/workflow/generate.ts`, `src/workflow/bundled.ts`, `docs/workflow-creation.md`, `README.md` — meta-prompt, example, docs. (Task 8)

---

### Task 1: Data model, constants & validation

**Files:**
- Modify: `src/workflow/types.ts`
- Test: `tests/workflow-loops-validation.test.ts` (create)

**Interfaces:**
- Produces:
  - `GateStep` gains `loopTo?: string` and `maxIterations?: number`.
  - `export const DEFAULT_LOOP_MAX_ITERATIONS = 10;`
  - `export const LOOP_MAX_ITERATIONS_CEILING = 100;`
  - `validateWorkflow(spec: WorkflowSpec): ValidationResult` (signature unchanged) now enforces loop rules.

- [ ] **Step 1: Write the failing tests**

Create `tests/workflow-loops-validation.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  DEFAULT_LOOP_MAX_ITERATIONS,
  LOOP_MAX_ITERATIONS_CEILING,
  type WorkflowSpec,
  validateWorkflow,
} from "../src/workflow/types";

/** A worker phase with one agent step. */
function workerPhase(id: string, prompt = "do {{input}}") {
  return {
    id,
    title: id,
    steps: [
      { id: `${id}-step`, agent: "opencode", model: "opencode/x", prompt } as const,
    ],
  };
}

/** A gate phase that loops back to `loopTo` when `recheck-step` is not ok. */
function loopGatePhase(id: string, loopTo: string, conditionStep: string, maxIterations?: number) {
  return {
    id,
    title: id,
    steps: [
      {
        id: `${id}-gate`,
        kind: "gate" as const,
        dependsOn: [conditionStep],
        condition: { step: conditionStep, ok: true },
        loopTo,
        ...(maxIterations !== undefined ? { maxIterations } : {}),
        onFalse: "fail" as const,
      },
    ],
  };
}

function spec(phases: WorkflowSpec["phases"]): WorkflowSpec {
  return { name: "w", phases };
}

describe("loop constants", () => {
  it("defaults to 10, ceiling 100", () => {
    expect(DEFAULT_LOOP_MAX_ITERATIONS).toBe(10);
    expect(LOOP_MAX_ITERATIONS_CEILING).toBe(100);
  });
});

describe("validateWorkflow loop topology", () => {
  it("accepts a gate looping back to an earlier phase", () => {
    const s = spec([
      workerPhase("review"),
      workerPhase("fix"),
      loopGatePhase("check", "review", "fix-step", 5),
    ]);
    expect(validateWorkflow(s)).toEqual({ ok: true });
  });

  it("rejects loopTo referencing a later phase", () => {
    const s = spec([
      workerPhase("review"),
      loopGatePhase("check", "later", "review-step", 5),
      workerPhase("later"),
    ]);
    const r = validateWorkflow(s);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("loopTo");
  });

  it("rejects loopTo referencing an unknown phase", () => {
    const s = spec([workerPhase("review"), loopGatePhase("check", "nope", "review-step", 5)]);
    const r = validateWorkflow(s);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("nope");
  });

  it("rejects partially overlapping loop regions", () => {
    // region A: a..gateB ; region B: b..gateC  → partial overlap
    const s = spec([
      workerPhase("a"),
      workerPhase("b"),
      loopGatePhase("gateB", "a", "b-step", 3),
      loopGatePhase("gateC", "b", "gateB-gate", 3),
    ]);
    const r = validateWorkflow(s);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("overlap");
  });

  it("accepts properly nested loop regions", () => {
    // inner region: b..gateInner ; outer region: a..gateOuter fully contains inner
    const s = spec([
      workerPhase("a"),
      workerPhase("b"),
      loopGatePhase("gateInner", "b", "b-step", 2),
      loopGatePhase("gateOuter", "a", "gateInner-gate", 2),
    ]);
    expect(validateWorkflow(s)).toEqual({ ok: true });
  });

  it("rejects maxIterations above the ceiling via schema", () => {
    const s = spec([workerPhase("review"), loopGatePhase("check", "review", "review-step", 101)]);
    expect(validateWorkflow(s).ok).toBe(false);
  });

  it("rejects a loop whose worst-case expansion exceeds MAX_STEPS", () => {
    // 200-step body × ceiling(100) blows past MAX_STEPS (1000) when maxIterations omitted.
    const body = Array.from({ length: 200 }, (_, i) => workerPhase(`p${i}`));
    const s = spec([
      ...body,
      // condition references the last body step; omit maxIterations → bounded by ceiling
      {
        id: "check",
        title: "check",
        steps: [
          {
            id: "check-gate",
            kind: "gate" as const,
            dependsOn: ["p199-step"],
            condition: { step: "p199-step", ok: true },
            loopTo: "p0",
            onFalse: "fail" as const,
          },
        ],
      },
    ]);
    const r = validateWorkflow(s);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("max");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/workflow-loops-validation.test.ts`
Expected: FAIL (constants undefined / loop rules not enforced).

- [ ] **Step 3: Add fields, constants, and schema**

In `src/workflow/types.ts`, extend `GateStep` (after the `onFalse` field, ~line 117):

```ts
export interface GateStep extends WorkflowStepBase {
  kind: "gate";
  condition: GateCondition;
  /** Optional state/label emitted when the gate evaluates. */
  target?: string;
  /** What to do when the condition is false (default: continue). */
  onFalse?: "continue" | "fail" | "stop";
  /**
   * When set, this gate is a loop: while its condition is false and the
   * per-loop iteration budget remains, execution jumps back to this (earlier)
   * phase id and re-runs the body. When the budget is exhausted, `onFalse`
   * applies. Omitting `loopTo` makes a plain (non-looping) gate.
   */
  loopTo?: string;
  /** Per-loop iteration cap (1..LOOP_MAX_ITERATIONS_CEILING). Omitted → config default. */
  maxIterations?: number;
}
```

Add constants next to `MAX_STEPS` (~line 166):

```ts
/** Default per-loop iteration cap when a loop gate omits `maxIterations`. */
export const DEFAULT_LOOP_MAX_ITERATIONS = 10;
/** Hard ceiling on a loop gate's `maxIterations` (runaway backstop). */
export const LOOP_MAX_ITERATIONS_CEILING = 100;
```

Extend `workflowGateStepSchema` (~line 281):

```ts
const workflowGateStepSchema = z.object({
  ...baseStepShape,
  kind: z.literal("gate"),
  condition: gateConditionSchema,
  target: z.string().min(1).optional(),
  onFalse: z.enum(["continue", "fail", "stop"]).optional(),
  loopTo: z.string().min(1).optional(),
  maxIterations: z.number().int().min(1).max(LOOP_MAX_ITERATIONS_CEILING).optional(),
});
```

- [ ] **Step 4: Implement loop validation in `validateWorkflow`**

In `src/workflow/types.ts`, replace the body of `validateWorkflow` from the phase-index map down through the budget check. Keep the existing per-step earlier-phase checks; add loop region computation. Insert this block AFTER the existing `dependsOn`/`gate condition`/`forEach` loop completes (after the `for (const phase of spec.phases)` validation loop that promotes `earlierIds`, just before the `maxPossibleSteps > MAX_STEPS` check ~line 450):

```ts
  // ---- Loop (loopTo) validation ----
  const phaseIndexById = new Map<string, number>();
  spec.phases.forEach((p, i) => phaseIndexById.set(p.id, i));

  // Each loop gate defines a region [loopToIndex .. gatePhaseIndex].
  interface LoopRegion {
    gateId: string;
    start: number; // loopTo phase index
    end: number; // gate phase index
    maxIterations: number; // effective bound for the static budget (ceiling when omitted)
  }
  const regions: LoopRegion[] = [];
  for (let pi = 0; pi < spec.phases.length; pi++) {
    const phase = spec.phases[pi];
    if (!phase) continue;
    for (const step of phase.steps) {
      if (step.kind !== "gate" || step.loopTo === undefined) continue;
      const start = phaseIndexById.get(step.loopTo);
      if (start === undefined) {
        return { ok: false, error: `gate '${step.id}' loopTo references unknown phase '${step.loopTo}'` };
      }
      if (start > pi) {
        return {
          ok: false,
          error: `gate '${step.id}' loopTo '${step.loopTo}' must be an earlier-or-equal phase (loops only go backward)`,
        };
      }
      regions.push({
        gateId: step.id,
        start,
        end: pi,
        maxIterations: step.maxIterations ?? LOOP_MAX_ITERATIONS_CEILING,
      });
    }
  }

  // Regions must be disjoint or properly nested — never partially overlapping.
  for (let i = 0; i < regions.length; i++) {
    for (let j = i + 1; j < regions.length; j++) {
      const a = regions[i] as LoopRegion;
      const b = regions[j] as LoopRegion;
      const disjoint = a.end < b.start || b.end < a.start;
      const aContainsB = a.start <= b.start && b.end <= a.end;
      const bContainsA = b.start <= a.start && a.end <= b.end;
      if (!disjoint && !aContainsB && !bContainsA) {
        return {
          ok: false,
          error: `loop regions for gates '${a.gateId}' and '${b.gateId}' partially overlap (loops must be nested or disjoint)`,
        };
      }
    }
  }

  // Worst-case step budget with loops: a region's body steps run `maxIterations`
  // times; nested regions multiply by every region that fully contains them.
  const phaseStepCount = spec.phases.map((p) => p.steps.length);
  let loopExpansion = 0;
  for (const r of regions) {
    let bodySteps = 0;
    for (let k = r.start; k <= r.end; k++) bodySteps += phaseStepCount[k] ?? 0;
    // multiplier from every OTHER region that fully contains this one
    let outerMultiplier = 1;
    for (const o of regions) {
      if (o === r) continue;
      if (o.start <= r.start && r.end <= o.end) outerMultiplier *= o.maxIterations;
    }
    // (maxIterations - 1) extra passes beyond the first, times outer multiplier
    loopExpansion += bodySteps * (r.maxIterations - 1) * outerMultiplier;
  }
  maxPossibleSteps += loopExpansion;
```

The existing final check then naturally fires:

```ts
  if (maxPossibleSteps > MAX_STEPS) {
    return {
      ok: false,
      error: `workflow can expand to ${maxPossibleSteps} steps (max ${MAX_STEPS})`,
    };
  }
  return { ok: true };
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/workflow-loops-validation.test.ts`
Expected: PASS (all cases).

- [ ] **Step 6: Typecheck and lint**

Run: `npx tsc --noEmit && npx biome check src/workflow/types.ts tests/workflow-loops-validation.test.ts`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/workflow/types.ts tests/workflow-loops-validation.test.ts
git commit -m "Add loop-back gate schema, constants, and validation"
```

---

### Task 2: Config — `loopMaxIterations`

**Files:**
- Modify: `src/config/types.ts`, `src/config/defaults.ts`, `src/config/load.ts`
- Test: `tests/config-loop.test.ts` (create)

**Interfaces:**
- Consumes: `LOOP_MAX_ITERATIONS_CEILING`, `DEFAULT_LOOP_MAX_ITERATIONS` from `src/workflow/types`.
- Produces: `SteamtrainConfig.loopMaxIterations?: number`; default value `DEFAULT_LOOP_MAX_ITERATIONS`; parsed/merged in `load.ts`.

- [ ] **Step 1: Write the failing test**

Create `tests/config-loop.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { configFileSchema } from "../src/config/types";
import { DEFAULT_CONFIG } from "../src/config/defaults";
import { DEFAULT_LOOP_MAX_ITERATIONS } from "../src/workflow/types";

describe("loopMaxIterations config", () => {
  it("defaults to DEFAULT_LOOP_MAX_ITERATIONS", () => {
    expect(DEFAULT_CONFIG.loopMaxIterations).toBe(DEFAULT_LOOP_MAX_ITERATIONS);
  });

  it("accepts a valid override", () => {
    const r = configFileSchema.safeParse({ loopMaxIterations: 25 });
    expect(r.success).toBe(true);
  });

  it("rejects values above the ceiling", () => {
    const r = configFileSchema.safeParse({ loopMaxIterations: 101 });
    expect(r.success).toBe(false);
  });

  it("rejects zero / negatives", () => {
    expect(configFileSchema.safeParse({ loopMaxIterations: 0 }).success).toBe(false);
  });
});
```

Check the exact export name of the defaults object first: `grep -n "export const" src/config/defaults.ts`. If it is not `DEFAULT_CONFIG`, use the actual name in the test and Step 3.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/config-loop.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `src/config/types.ts`:

```ts
import { LOOP_MAX_ITERATIONS_CEILING, MAX_CONCURRENCY, type WorkflowSpec, workflowSpecSchema } from "../workflow/types";
```

Add to `SteamtrainConfig`:

```ts
  /** Default per-loop iteration cap; a loop gate's own `maxIterations` overrides it. */
  loopMaxIterations?: number;
```

Add to `configFileSchema` object (before `.strict()`):

```ts
    loopMaxIterations: z
      .number()
      .int()
      .min(1)
      .max(LOOP_MAX_ITERATIONS_CEILING)
      .optional(),
```

In `src/config/defaults.ts`, import and set the default:

```ts
import { DEFAULT_LOOP_MAX_ITERATIONS } from "../workflow/types";
// inside the defaults object, alongside maxConcurrency: 3
  loopMaxIterations: DEFAULT_LOOP_MAX_ITERATIONS,
```

In `src/config/load.ts`, add the merge line next to `maxConcurrency` (~line 124):

```ts
    loopMaxIterations: override.loopMaxIterations ?? base.loopMaxIterations,
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/config-loop.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck, lint, commit**

```bash
npx tsc --noEmit && npx biome check src/config tests/config-loop.test.ts
git add src/config tests/config-loop.test.ts
git commit -m "Add loopMaxIterations config option"
```

---

### Task 3: Templating — `{{iteration}}`

**Files:**
- Modify: `src/workflow/template.ts`
- Test: `tests/template.test.ts` (modify; if absent, create `tests/template-iteration.test.ts`)

**Interfaces:**
- Produces: `TemplateContext.iteration?: number`; `{{iteration}}` renders that number (default 1); `{{steps.<id>.iteration}}` renders a result's `iteration`.

- [ ] **Step 1: Write the failing test**

Add to `tests/template-iteration.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { renderPrompt } from "../src/workflow/template";

describe("iteration templating", () => {
  it("renders {{iteration}} from context, default 1", () => {
    expect(renderPrompt("pass {{iteration}}", { input: "", outputs: new Map(), iteration: 3 })).toBe(
      "pass 3",
    );
    expect(renderPrompt("pass {{iteration}}", { input: "", outputs: new Map() })).toBe("pass 1");
  });

  it("renders {{steps.<id>.iteration}} from a result", () => {
    const results = new Map([["g", { ok: true, iteration: 4 }]]);
    expect(
      renderPrompt("loop {{steps.g.iteration}}", { input: "", outputs: new Map(), results }),
    ).toBe("loop 4");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/template-iteration.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `src/workflow/template.ts`:

```ts
export interface TemplateContext {
  input: string;
  outputs: Map<string, string>;
  results?: Map<
    string,
    { ok: boolean; error?: string; items?: string[]; target?: string; iteration?: number }
  >;
  item?: WorkflowItem;
  /** Current loop iteration (1-based); default 1. */
  iteration?: number;
}
```

Update the field regex and handler:

```ts
const STEP_FIELD = /^steps\.(.+)\.(output|items|ok|error|target|iteration)$/;
```

In `renderPrompt`, add the bare `iteration` handler (next to `item.index`):

```ts
    if (expr === "iteration") return String(ctx.iteration ?? 1);
```

And in the `STEP_FIELD` branch, after the `target` line:

```ts
      if (field === "iteration") return result.iteration !== undefined ? String(result.iteration) : "";
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/template-iteration.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck, lint, commit**

```bash
npx tsc --noEmit && npx biome check src/workflow/template.ts tests/template-iteration.test.ts
git add src/workflow/template.ts tests/template-iteration.test.ts
git commit -m "Render {{iteration}} and step iteration in prompts"
```

---

### Task 4: Engine loop execution + events

**Files:**
- Modify: `src/workflow/events.ts`, `src/workflow/engine.ts`, `src/orchestrator/orchestrator.ts`
- Modify: `src/workflow/types.ts` (add `iteration?: number` to `StepResult`)
- Test: `tests/workflow-loops-engine.test.ts` (create)

**Interfaces:**
- Consumes: validation (Task 1), `{{iteration}}` (Task 3), `loopMaxIterations` config (Task 2).
- Produces:
  - `events.ts`: `iteration?: number` on `PhaseStartEvent`, `StepStartEvent`, `StepDoneEvent`, `StepStreamEvent`, `StepRetryEvent`, `GateEvaluatedEvent`, `FanOutEvent`; new `LoopIterationEvent { kind: "loop_iteration"; gateStepId: string; loopTo: string; iteration: number; maxIterations: number; ts: number }` added to the `WorkflowEvent` union.
  - `engine.ts`: `WorkflowDeps.loopMaxIterations?: number`. The phase walk jumps backward on an unmet loop gate.
  - `types.ts`: `StepResult.iteration?: number`.

- [ ] **Step 1: Write the failing tests**

Create `tests/workflow-loops-engine.test.ts`. Use the existing fake-adapter pattern (copy the helper shape from `tests/workflow-engine*.test.ts` — inspect one first with `grep -n "createAdapter" tests/*.ts`). The fake below returns a scripted sequence of results per step id and counts calls so a loop's convergence can be driven.

```ts
import { describe, expect, it } from "vitest";
import { runWorkflow } from "../src/workflow/engine";
import type { WorkflowEvent } from "../src/workflow/events";
import type { WorkflowSpec } from "../src/workflow/types";
import type { AgentAdapter } from "../src/agents";
import type { AgentEvent } from "../src/types/events";

/** Fake adapter: emits a result whose text is provided by `script(stepPrompt, callIndex)`. */
function fakeAdapter(script: (prompt: string, call: number) => { text: string; isError?: boolean }) {
  let call = 0;
  const adapter: AgentAdapter = {
    id: "opencode",
    binary: "opencode",
    run(opts): AsyncIterable<AgentEvent> {
      const c = call++;
      const out = script(opts.prompt, c);
      async function* gen() {
        yield { kind: "text_delta", agent: "opencode", ts: 0, text: out.text } as AgentEvent;
        yield {
          kind: "result",
          agent: "opencode",
          ts: 0,
          isError: Boolean(out.isError),
          text: out.text,
        } as AgentEvent;
      }
      return gen();
    },
  };
  return adapter;
}

async function collect(spec: WorkflowSpec, deps: Parameters<typeof runWorkflow>[2], input = "go") {
  const events: WorkflowEvent[] = [];
  for await (const e of runWorkflow(spec, { input }, deps)) events.push(e);
  return events;
}

function workerPhase(id: string, prompt: string) {
  return { id, title: id, steps: [{ id: `${id}-step`, agent: "opencode" as const, model: "m", prompt }] };
}

/** A loop: review → fix → check(gate loops to review until fix output contains DONE). */
function loopSpec(maxIterations?: number): WorkflowSpec {
  return {
    name: "loop",
    phases: [
      workerPhase("review", "review {{input}} (iter {{iteration}})"),
      workerPhase("fix", "fix based on {{steps.review-step.output}}"),
      {
        id: "check",
        title: "check",
        steps: [
          {
            id: "check-gate",
            kind: "gate" as const,
            dependsOn: ["fix-step"],
            condition: { step: "fix-step", contains: "DONE" },
            loopTo: "review",
            ...(maxIterations !== undefined ? { maxIterations } : {}),
            onFalse: "fail" as const,
          },
        ],
      },
    ],
  };
}

describe("engine loops", () => {
  it("re-runs the body until the gate condition is met", async () => {
    // fix-step returns NOPE on first 2 calls, DONE on the 3rd.
    let fixCalls = 0;
    const deps = {
      createAdapter: () =>
        fakeAdapter((prompt) => {
          if (prompt.startsWith("fix")) {
            fixCalls++;
            return { text: fixCalls >= 3 ? "DONE" : "NOPE" };
          }
          return { text: "reviewed" };
        }),
      maxConcurrency: 2,
      cwd: "/tmp",
      loopMaxIterations: 10,
    };
    const events = await collect(loopSpec(), deps);
    const loops = events.filter((e) => e.kind === "loop_iteration");
    expect(loops.length).toBe(2); // looped back twice, converged on iteration 3
    const done = events.find((e) => e.kind === "workflow_done");
    expect(done && (done as { ok: boolean }).ok).toBe(true);
    // review re-ran each iteration (3 review-step starts across iterations 1,2,3)
    const reviewStarts = events.filter(
      (e) => e.kind === "step_start" && (e as { stepId: string }).stepId === "review-step",
    );
    expect(reviewStarts.length).toBe(3);
  });

  it("stops at the cap and applies onFalse=fail when never converging", async () => {
    const deps = {
      createAdapter: () => fakeAdapter(() => ({ text: "NOPE" })),
      maxConcurrency: 2,
      cwd: "/tmp",
      loopMaxIterations: 10,
    };
    const events = await collect(loopSpec(3), deps); // cap 3
    const loops = events.filter((e) => e.kind === "loop_iteration");
    expect(loops.length).toBe(2); // iterations 2 and 3 (first pass is iteration 1)
    const done = events.find((e) => e.kind === "workflow_done") as { ok: boolean };
    expect(done.ok).toBe(false); // onFalse=fail after exhaustion
  });

  it("falls back to deps.loopMaxIterations when the gate omits maxIterations", async () => {
    const deps = {
      createAdapter: () => fakeAdapter(() => ({ text: "NOPE" })),
      maxConcurrency: 2,
      cwd: "/tmp",
      loopMaxIterations: 2, // cap via config
    };
    const events = await collect(loopSpec(), deps); // no per-gate cap
    const loops = events.filter((e) => e.kind === "loop_iteration");
    expect(loops.length).toBe(1); // iteration 2 only (cap 2)
  });

  it("exposes {{iteration}} to the body each pass", async () => {
    const seenPrompts: string[] = [];
    let fixCalls = 0;
    const deps = {
      createAdapter: () =>
        fakeAdapter((prompt) => {
          seenPrompts.push(prompt);
          if (prompt.startsWith("fix")) {
            fixCalls++;
            return { text: fixCalls >= 2 ? "DONE" : "NOPE" };
          }
          return { text: "reviewed" };
        }),
      maxConcurrency: 2,
      cwd: "/tmp",
      loopMaxIterations: 10,
    };
    await collect(loopSpec(), deps);
    expect(seenPrompts).toContain("review go (iter 1)");
    expect(seenPrompts).toContain("review go (iter 2)");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/workflow-loops-engine.test.ts`
Expected: FAIL (`loop_iteration` never emitted; no looping).

- [ ] **Step 3: Add event types**

In `src/workflow/events.ts`, add `iteration?: number` to `PhaseStartEvent`, `StepStartEvent`, `StepDoneEvent`, `StepStreamEvent`, `StepRetryEvent`, `GateEvaluatedEvent`, `FanOutEvent` (one line each, documented `/** Loop iteration (1-based); omitted ⇒ 1 (no loop). */`). Add the new event and union member:

```ts
/**
 * A loop-back gate's condition was not met and the iteration budget still
 * remains, so execution is about to jump back to `loopTo` and re-run the body.
 * `iteration` is the iteration that is ABOUT TO START (2 = the first re-run).
 */
export interface LoopIterationEvent {
  kind: "loop_iteration";
  gateStepId: string;
  loopTo: string;
  iteration: number;
  maxIterations: number;
  ts: number;
}
```

Add `| LoopIterationEvent` to the `WorkflowEvent` union.

- [ ] **Step 4: Add `StepResult.iteration` and `WorkflowDeps.loopMaxIterations`**

In `src/workflow/types.ts` `StepResult`, add:

```ts
  /** Loop iteration this result belongs to (1-based); omitted ⇒ 1. */
  iteration?: number;
```

In `src/workflow/engine.ts` `WorkflowDeps`, add:

```ts
  /** Default per-loop iteration cap; a gate's own `maxIterations` overrides it. */
  loopMaxIterations?: number;
```

- [ ] **Step 5: Implement the loop in `runWorkflow`**

In `src/workflow/engine.ts`, restructure the phase walk. Replace the `for (let pi = 0; pi < spec.phases.length; pi++)` loop with a `while` loop over a mutable index, threading an `iteration` per loop region. Concretely:

1. Before the loop, precompute loop regions and per-gate state:

```ts
  // Loop bookkeeping: gateId → { loopToIndex, iteration count so far }.
  const phaseIndexById = new Map<string, number>();
  spec.phases.forEach((p, i) => phaseIndexById.set(p.id, i));
  const loopState = new Map<string, { loopToIndex: number; iteration: number }>();
  for (const phase of spec.phases) {
    for (const step of phase.steps) {
      if (step.kind === "gate" && step.loopTo !== undefined) {
        const loopToIndex = phaseIndexById.get(step.loopTo);
        if (loopToIndex !== undefined) {
          loopState.set(step.id, { loopToIndex, iteration: 1 });
        }
      }
    }
  }
  const effectiveLoopMax =
    deps.loopMaxIterations ?? DEFAULT_LOOP_MAX_ITERATIONS; // (import the constant)
```

   The engine tags the phases currently executing with a single `currentIteration`. It starts at 1; when a loop gate jumps back, `currentIteration` is set to that gate's next iteration number until the gate is reached again, then resets to 1 on leaving the region. The test only requires that body phases re-run with the incremented number and that `{{iteration}}` reflects it. The reference implementation:

```ts
  let pi = 0;
  let currentIteration = 1; // iteration tag for the phases currently executing
  while (pi < spec.phases.length) {
    const phase = spec.phases[pi];
    if (!phase) { pi++; continue; }
    const iteration = currentIteration;

    yield { kind: "phase_start", phaseId: phase.id, title: phase.title, index: pi,
            stepCount: phase.steps.length, iteration, ts: Date.now() };
    // ... existing per-phase channel/runStep machinery, but every channel.push
    //     of step_start/step_done/step_event/step_retry/gate_evaluated/fan_out
    //     now includes `iteration` ...
    // ... after `for await (const ev of channel) yield ev; await poolDone;` ...

    if (!phaseOk) workflowOk = false;
    yield { kind: "phase_done", phaseId: phase.id, ok: phaseOk, iteration, ts: Date.now() };

    if (signal?.aborted) break;

    // Loop-back decision: did this phase contain an unmet loop gate?
    const jump = decideLoopJump(phase, results, loopState, effectiveLoopMax);
    if (jump) {
      // invalidate cache + results for the region so the body re-runs
      invalidateRegion(spec, jump.loopToIndex, pi, cache, results, outputs);
      currentIteration = jump.iteration;
      yield {
        kind: "loop_iteration",
        gateStepId: jump.gateId,
        loopTo: spec.phases[jump.loopToIndex]?.id ?? "",
        iteration: jump.iteration,
        maxIterations: jump.maxIterations,
        ts: Date.now(),
      };
      pi = jump.loopToIndex;
      continue;
    }

    if (stopAfterPhase) break;
    // Leaving a loop region: reset the iteration tag to 1 for subsequent phases.
    currentIteration = 1;
    pi++;
  }
```

2. Add the helper functions near the bottom of `engine.ts`:

```ts
/**
 * If `phase` holds a loop gate whose condition failed and whose iteration budget
 * remains, return the jump (target index, next iteration, cap, gateId). The gate's
 * own StepResult (already in `results`) tells us whether it passed.
 */
function decideLoopJump(
  phase: WorkflowSpec["phases"][number],
  results: Map<string, StepResult>,
  loopState: Map<string, { loopToIndex: number; iteration: number }>,
  effectiveLoopMax: number,
): { gateId: string; loopToIndex: number; iteration: number; maxIterations: number } | undefined {
  for (const step of phase.steps) {
    if (step.kind !== "gate" || step.loopTo === undefined) continue;
    const state = loopState.get(step.id);
    if (!state) continue;
    const res = results.get(step.id);
    // Gate "passed" (condition true) ⇒ converged, no loop.
    if (res?.gate?.passed) return undefined;
    const cap = step.maxIterations ?? effectiveLoopMax;
    if (state.iteration >= cap) return undefined; // exhausted ⇒ onFalse already applied
    state.iteration += 1;
    return { gateId: step.id, loopToIndex: state.loopToIndex, iteration: state.iteration, maxIterations: cap };
  }
  return undefined;
}

/** Delete cache/results/outputs for every step id in phases [start..end] so they re-run. */
function invalidateRegion(
  spec: WorkflowSpec,
  start: number,
  end: number,
  cache: Map<string, StepResult>,
  results: Map<string, StepResult>,
  outputs: Map<string, string>,
): void {
  for (let i = start; i <= end; i++) {
    const phase = spec.phases[i];
    if (!phase) continue;
    for (const step of phase.steps) {
      cache.delete(step.id);
      results.delete(step.id);
      // outputs intentionally NOT deleted: the previous iteration's text stays
      // readable (e.g. a fix step reads the prior review) until each step
      // overwrites its own output as it re-runs.
      // Also drop generated forEach children (id like `step[<n>]`).
      for (const key of [...cache.keys()]) if (key.startsWith(`${step.id}[`)) cache.delete(key);
      for (const key of [...results.keys()]) if (key.startsWith(`${step.id}[`)) results.delete(key);
    }
  }
}
```

3. **Crucial gate-onFalse interaction:** when the budget is exhausted, the gate's existing evaluation already sets `stop`/fails via `onFalse` (see `executeStep` gate branch returning `stop` and the `result.ok` based on `onFalse`). The loop must only short-circuit `stopAfterPhase` AFTER confirming there is no jump. Since `decideLoopJump` returns `undefined` when exhausted, the normal `stopAfterPhase`/`phaseOk` path runs and `onFalse=fail` marks the phase not-ok ⇒ `workflowOk=false`. Confirm the gate branch in `executeStep` still computes `ok`/`stop` from `onFalse` (no change needed there).

4. Pass `iteration` into the executing context so prompts see `{{iteration}}`. In `runStep`, thread `iteration` into the `executeStep(... ctx ...)` call by adding `iteration` to `ExecuteContext` and to the `renderPrompt` calls in `executeAgentStep` / distributor / consolidator / gate. Add to `ExecuteContext`:

```ts
  iteration: number;
```

   and set it from the per-phase `iteration` when constructing the context inside `runStep`. In each `renderPrompt({...})` call inside `executeStep`/`executeAgentStep`, add `iteration: ctx.iteration`. Set `result.iteration = ctx.iteration` on returned StepResults (at minimum for the gate result so `{{steps.<gate>.iteration}}` works; setting it on all results is fine and cheap).

   Import `DEFAULT_LOOP_MAX_ITERATIONS` from `./types` at the top of `engine.ts`.

- [ ] **Step 6: Thread config into deps (orchestrator)**

In `src/orchestrator/orchestrator.ts` (~line 174), add to the `WorkflowDeps` object:

```ts
        loopMaxIterations: this.config.loopMaxIterations,
```

- [ ] **Step 7: Run the engine tests to verify they pass**

Run: `npx vitest run tests/workflow-loops-engine.test.ts`
Expected: PASS (all 4 cases).

- [ ] **Step 8: Run the full suite to catch fold/lockstep regressions early**

Run: `npx vitest run`
Expected: PASS. If `tests/workflow-history.test.ts` fails because new `iteration` fields appear on events, that is handled in Task 5 — but the field is optional so non-loop event streams (used by that test) should be unaffected. If it fails, the cause is an unconditional `iteration` on a non-loop event; ensure `iteration` is only attached as a numeric value (default 1) and the existing test asserts via `toMatchObject` (extra fields tolerated). Inspect and fix before committing.

- [ ] **Step 9: Typecheck, lint, commit**

```bash
npx tsc --noEmit && npx biome check src/workflow/engine.ts src/workflow/events.ts src/workflow/types.ts src/orchestrator/orchestrator.ts tests/workflow-loops-engine.test.ts
git add src/workflow/engine.ts src/workflow/events.ts src/workflow/types.ts src/orchestrator/orchestrator.ts tests/workflow-loops-engine.test.ts
git commit -m "Execute bounded loop-back gates in the workflow engine"
```

---

### Task 5: Iteration-aware folds (reducer + history)

**Files:**
- Modify: `src/tui/workflow-state.ts`, `src/workflow/history.ts`
- Test: `tests/workflow-loops-folds.test.ts` (create)

**Interfaces:**
- Consumes: events with `iteration?` and `loop_iteration` (Task 4).
- Produces: `PhaseState.iteration?: number`, `HistoryPhase.iteration?: number`. Both folds match phases/steps by composite `phaseId + (iteration ?? 1)`.

- [ ] **Step 1: Write the failing test**

Create `tests/workflow-loops-folds.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { initialWorkflowState, workflowReducer } from "../src/tui/workflow-state";
import { RunRecordBuilder } from "../src/workflow/history";
import type { WorkflowEvent } from "../src/workflow/events";

/** Two iterations of a single phase "fix" with step "fix-step". */
const events: WorkflowEvent[] = [
  { kind: "workflow_start", name: "w", phaseCount: 1, stepCount: 1, ts: 0 },
  { kind: "phase_start", phaseId: "fix", title: "fix", index: 0, stepCount: 1, iteration: 1, ts: 0 },
  { kind: "step_start", phaseId: "fix", stepId: "fix-step", iteration: 1, ts: 0 },
  { kind: "step_done", phaseId: "fix", stepId: "fix-step", iteration: 1, cached: false,
    result: { stepId: "fix-step", ok: true, output: "v1", durationMs: 1 }, ts: 0 },
  { kind: "phase_done", phaseId: "fix", ok: true, iteration: 1, ts: 0 },
  { kind: "loop_iteration", gateStepId: "g", loopTo: "fix", iteration: 2, maxIterations: 5, ts: 0 },
  { kind: "phase_start", phaseId: "fix", title: "fix", index: 0, stepCount: 1, iteration: 2, ts: 0 },
  { kind: "step_start", phaseId: "fix", stepId: "fix-step", iteration: 2, ts: 0 },
  { kind: "step_done", phaseId: "fix", stepId: "fix-step", iteration: 2, cached: false,
    result: { stepId: "fix-step", ok: true, output: "v2", durationMs: 1 }, ts: 0 },
  { kind: "phase_done", phaseId: "fix", ok: true, iteration: 2, ts: 0 },
  { kind: "workflow_done", ok: true, results: [], ts: 0 },
];

describe("loop folds", () => {
  it("reducer creates one phase instance per iteration", () => {
    let state = initialWorkflowState;
    for (const e of events) state = workflowReducer(state, { type: "event", event: e });
    const fixPhases = state.phases.filter((p) => p.phaseId === "fix");
    expect(fixPhases.length).toBe(2);
    expect(fixPhases[0]?.steps[0]?.result?.output).toBe("v1");
    expect(fixPhases[1]?.steps[0]?.result?.output).toBe("v2");
  });

  it("history builder creates one phase instance per iteration", () => {
    const b = new RunRecordBuilder({ id: "r", workflow: "w", input: "", cwd: "/tmp" });
    for (const e of events) b.handle(e);
    const rec = b.build({ status: "done" });
    const fixPhases = rec.phases.filter((p) => p.phaseId === "fix");
    expect(fixPhases.length).toBe(2);
    expect(fixPhases[1]?.steps[0]?.result?.output).toBe("v2");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/workflow-loops-folds.test.ts`
Expected: FAIL (only one `fix` phase; second iteration overwrites the first / appends but `find` resolves the first).

- [ ] **Step 3: Implement composite keying — reducer**

In `src/tui/workflow-state.ts`:
- Add `iteration?: number` to `PhaseState`.
- `phase_start`: set `iteration: e.iteration` on the pushed phase.
- The matchers that resolve a phase by id must also match iteration. Introduce a helper:

```ts
const sameInstance = (p: PhaseState, phaseId: string, iteration?: number) =>
  p.phaseId === phaseId && (p.iteration ?? 1) === (iteration ?? 1);
```

- In `updateStep`, add an `iteration` parameter and use `sameInstance(p, phaseId, iteration)` instead of `p.phaseId === phaseId`. Thread `e.iteration` from `step_event`, `step_retry`, `gate_evaluated`, `step_done` into `updateStep`.
- In `step_start` and `fan_out`, replace `p.phaseId === e.phaseId` with `sameInstance(p, e.phaseId, e.iteration)`.
- `phase_done`: match with `sameInstance(p, e.phaseId, e.iteration)`.
- `loop_iteration`: no tree mutation needed (it's a marker); return `state` unchanged (add a `case "loop_iteration": return state;`).
- `workflowStateFromRecord`: carry `iteration: phase.iteration` through.

- [ ] **Step 4: Implement composite keying — history builder**

In `src/workflow/history.ts`:
- Add `iteration?: number` to `HistoryPhase`.
- `phase_start`: push with `iteration: event.iteration`.
- `phaseOf(phaseId, iteration?)` and `stepOf(phaseId, stepId, iteration?)` match the composite (mirror `sameInstance`). Update every call site (`fan_out`, `step_start`, `step_event`, `step_retry`, `gate_evaluated`, `step_done`, `phase_done`) to pass `event.iteration`.
- `case "loop_iteration":` — no-op (marker).
- Keep the unstarted-placeholder logic; it operates per phase instance so it still works.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/workflow-loops-folds.test.ts`
Expected: PASS.

- [ ] **Step 6: Confirm lockstep + full suite**

Run: `npx vitest run tests/workflow-history.test.ts && npx vitest run`
Expected: PASS (non-loop runs unchanged; the lockstep test still matches because both folds gained the same composite keying).

- [ ] **Step 7: Typecheck, lint, commit**

```bash
npx tsc --noEmit && npx biome check src/tui/workflow-state.ts src/workflow/history.ts tests/workflow-loops-folds.test.ts
git add src/tui/workflow-state.ts src/workflow/history.ts tests/workflow-loops-folds.test.ts
git commit -m "Make live and history folds iteration-aware for loops"
```

---

### Task 6: TUI visualization & detail

**Files:**
- Modify: `src/tui/workflow-spec-ui.ts`, `src/tui/WorkflowView.tsx`, `src/tui/WorkflowStepDetails.tsx`
- Test: `tests/workflow-spec-ui.test.ts` (modify; if absent, create `tests/workflow-spec-ui-loop.test.ts`)

**Interfaces:**
- Consumes: `GateStep.loopTo`/`maxIterations` (Task 1), `PhaseState.iteration` (Task 5).
- Produces: `formatGateLoop(step)` exported from `workflow-spec-ui.ts`; loop line in `specDetailLines`/`specStepRowMeta`; iteration badge in `WorkflowView`; `phase-<id>-<iteration>` React keys.

- [ ] **Step 1: Write the failing test**

Create `tests/workflow-spec-ui-loop.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { specDetailLines, specStepRowMeta } from "../src/tui/workflow-spec-ui";
import type { GateStep } from "../src/workflow";

const gate: GateStep = {
  id: "check-gate",
  kind: "gate",
  dependsOn: ["fix-step"],
  condition: { step: "fix-step", contains: "DONE" },
  loopTo: "review",
  maxIterations: 5,
  onFalse: "fail",
};

describe("loop gate display", () => {
  it("shows the loop back-edge in detail lines", () => {
    const lines = specDetailLines(gate);
    expect(lines.some((l) => l.includes("loops back to review") && l.includes("max 5"))).toBe(true);
  });

  it("shows the loop in the compact row meta", () => {
    expect(specStepRowMeta(gate)).toContain("↺ review");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/workflow-spec-ui-loop.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement display helpers**

In `src/tui/workflow-spec-ui.ts` add:

```ts
import {
  type GateCondition,
  type GateStep,
  // ...existing imports
} from "../workflow";

/** Compact loop summary for a gate, or "" when it is not a loop. */
export function formatGateLoop(step: WorkflowStep): string {
  if (step.kind !== "gate" || step.loopTo === undefined) return "";
  const max = step.maxIterations !== undefined ? ` · max ${step.maxIterations}` : "";
  return `↺ ${step.loopTo}${max}`;
}
```

In `specStepRowMeta`, after the gate condition push:

```ts
  if (step.kind === "gate" && step.loopTo) bits.push(`↺ ${step.loopTo}`);
```

In `specDetailLines`, inside the `if (step.kind === "gate")` block, after the `onFalse` line:

```ts
    if (step.loopTo) {
      const max = step.maxIterations !== undefined ? ` (max ${step.maxIterations})` : " (max: config default)";
      lines.push(`loops back to ${step.loopTo}${max}`);
    }
```

- [ ] **Step 4: Implement live iteration badge & React keys**

In `src/tui/WorkflowView.tsx`:
- The `PhaseHeader` React key (`key={`phase-${row.phase.phaseId}`}`, ~line 113) must include iteration: `key={`phase-${row.phase.phaseId}-${row.phase.iteration ?? 1}`}`. Do the same for any step keys that use `stepId` alone within a phase if they could now repeat across iterations (they are scoped per phase instance, so `key={`step-${row.phase.phaseId}-${row.phase.iteration ?? 1}-${row.step.stepId}`}`).
- In `PhaseHeader`, when `phase.iteration && phase.iteration > 1`, append a dim ` · iter ${phase.iteration}` to the title line.

In `src/tui/WorkflowStepDetails.tsx`: in the gate summary block (~line 247-253), append the loop info when present:

```ts
  if (step.gate) {
    // existing gate line ...
  }
```
   Add (using the spec step if available, else skip) — since `WorkflowStepDetails` already calls `specDetailLines(step)` for the spec view at line 207, the loop line from Step 3 is already rendered there; no extra change needed for the spec panel. Only add an iteration note if the live `StepState` carries one (it does not by default; skip to keep YAGNI).

- [ ] **Step 5: Run the test + typecheck**

Run: `npx vitest run tests/workflow-spec-ui-loop.test.ts && npx tsc --noEmit`
Expected: PASS / no type errors.

- [ ] **Step 6: Lint, commit**

```bash
npx biome check src/tui/workflow-spec-ui.ts src/tui/WorkflowView.tsx src/tui/WorkflowStepDetails.tsx tests/workflow-spec-ui-loop.test.ts
git add src/tui/workflow-spec-ui.ts src/tui/WorkflowView.tsx src/tui/WorkflowStepDetails.tsx tests/workflow-spec-ui-loop.test.ts
git commit -m "Show loop back-edge and iteration badges in the TUI"
```

---

### Task 7: Web visualization, live view & authoring round-trip

**Files:**
- Modify: `src/web/html.ts`, (verify only) `src/web/server.ts`
- Test: `tests/web-loops.test.ts` (create)

**Interfaces:**
- Consumes: events with `iteration`/`loop_iteration` (Task 4); validation accepts loop specs (Task 1).
- Produces: web SSE consumer keys live phases/steps by `phaseId + iteration`; static spec render draws the loop edge; authoring PUT round-trips a loop spec.

- [ ] **Step 1: Write the failing test (authoring round-trip)**

Create `tests/web-loops.test.ts`. Model it on the existing web authoring test (find with `grep -ln "PUT\|/api/workflows\|author" tests/*.ts`); reuse that file's server/host setup helper. The assertion: a workflow whose gate has `loopTo`/`maxIterations` is accepted by `validateWorkflow` (the shared gate the PUT handler uses) and survives a save/load cycle.

```ts
import { describe, expect, it } from "vitest";
import { validateWorkflow, type WorkflowSpec } from "../src/workflow/types";

const loopWorkflow: WorkflowSpec = {
  name: "review-loop",
  phases: [
    { id: "review", title: "review", steps: [{ id: "r", agent: "opencode", model: "m", prompt: "review {{input}}" }] },
    { id: "fix", title: "fix", steps: [{ id: "f", agent: "opencode", model: "m", prompt: "fix {{steps.r.output}}" }] },
    { id: "check", title: "check", steps: [{ id: "g", kind: "gate", dependsOn: ["f"], condition: { step: "f", contains: "DONE" }, loopTo: "review", maxIterations: 4, onFalse: "fail" }] },
  ],
};

describe("web accepts loop workflows", () => {
  it("validates a loop spec the authoring layer would persist", () => {
    expect(validateWorkflow(loopWorkflow)).toEqual({ ok: true });
  });
});
```

If the existing web authoring test exercises the real PUT route with a running server, extend that test instead to PUT `loopWorkflow` and GET it back, asserting the gate's `loopTo` survives. Run web-server tests with `dangerouslyDisableSandbox: true`.

- [ ] **Step 2: Run to verify it passes/fails appropriately**

Run: `npx vitest run tests/web-loops.test.ts`
Expected: PASS for the validation-level test (validation already landed in Task 1) — this test guards against regressions. If you extended the real PUT-route test, it should PASS once the route uses shared validation (it already does); confirm.

- [ ] **Step 3: Implement web spec render (static loop edge)**

In `src/web/html.ts`, where the static spec is turned into the phase/step cards (the block reading `st.kind`, `st.dependsOn`, `st.forEach` ~line 499-501), capture loop fields:

```js
          id: st.id, phaseId: p.id, kind: st.kind || "worker", agent: st.agent, model: st.model,
          dependsOn: st.dependsOn, forEach: st.forEach, loopTo: st.loopTo, maxIterations: st.maxIterations,
          status: "pending", text: "", activity: null,
          result: null, cached: false, gate: null, item: null, child: false
```

In the card-rendering function (find where `forEach`/`dependsOn` chips are drawn), add a loop chip when `s.loopTo`:

```js
    if (s.loopTo) parts.push('<span class="chip warn">\\u21ba ' + s.loopTo + (s.maxIterations ? ' \\u00b7 max ' + s.maxIterations : '') + '</span>');
```

(Use the existing chip/escape helpers in `html.ts`; match the surrounding string-building style and HTML-escape `s.loopTo`.)

- [ ] **Step 4: Implement web live iteration-awareness**

In `src/web/html.ts` live SSE consumer:
- `ensureLive(stepId, phaseId)` and the `phaseOrder` push (`phase_start` handler ~line 523-525) key by `phaseId`. Introduce an iteration-qualified key: the live store keys `S.live[stepId]` by step id today; to support re-runs, key by `phaseId + "#" + (ev.iteration||1) + ":" + stepId`. Update `ensureLive`, the `childOf` map, and the `phaseOrder` entries to carry `{ id, iteration }` and render one block per (id, iteration).
- `phase_start`: push a new phaseOrder entry when `(id, iteration)` not present (not just `id`).
- Handle `loop_iteration`: append a small marker row ("↺ loop → <loopTo> · iteration N/Max") to the live log.

   Keep the change minimal and mirror the TS reducer's composite-key rule (Task 5). If the web live store proves too invasive to fully re-key within this task, the acceptable minimum is: (a) render the static loop edge (Step 3), (b) show the `loop_iteration` marker, and (c) tag re-run phase headers with the iteration number — full per-iteration step de-dup in the live DOM can reuse the latest values. Document whichever scope you ship in the commit message.

- [ ] **Step 5: Run web tests**

Run (sandbox disabled if the suite binds a socket): `npx vitest run tests/web-loops.test.ts`
Expected: PASS. Also run any existing `tests/web*.test.ts` to ensure no regression.

- [ ] **Step 6: Typecheck, lint, commit**

```bash
npx tsc --noEmit && npx biome check src/web/html.ts tests/web-loops.test.ts
git add src/web/html.ts tests/web-loops.test.ts
git commit -m "Render loop edge and iteration markers in the web UI"
```

---

### Task 8: LLM meta-prompt, bundled example & docs

**Files:**
- Modify: `src/workflow/generate.ts`, `src/workflow/bundled.ts`, `docs/workflow-creation.md`, `README.md`
- Test: `tests/generate.test.ts` (modify; if absent create `tests/generate-loops.test.ts`), `tests/bundled.test.ts` (modify; if absent create `tests/bundled-loops.test.ts`)

**Interfaces:**
- Consumes: validation (Task 1), engine semantics (Task 4).
- Produces: meta-prompt teaches loop-back gates; a bundled `review-loop` workflow validates.

- [ ] **Step 1: Write the failing tests**

Create `tests/generate-loops.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildWorkflowGenerationPrompt } from "../src/workflow/generate";

describe("meta-prompt teaches loops", () => {
  it("mentions loop-back gates and stops telling models to unroll", () => {
    const p = buildWorkflowGenerationPrompt("review and fix until clean");
    expect(p).toMatch(/loopTo/);
    expect(p).toMatch(/maxIterations/);
    expect(p).not.toMatch(/Loops are NOT supported/);
  });
});
```

Create `tests/bundled-loops.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { BUNDLED_WORKFLOWS } from "../src/workflow/bundled"; // confirm export name first
import { validateWorkflow } from "../src/workflow/types";

describe("bundled loop workflow", () => {
  it("ships a valid review-loop using a loop-back gate", () => {
    const wf = BUNDLED_WORKFLOWS.find((w) => w.name === "review-loop");
    expect(wf).toBeDefined();
    if (wf) expect(validateWorkflow(wf)).toEqual({ ok: true });
  });
});
```

Confirm the bundled export shape first: `grep -n "export" src/workflow/bundled.ts`.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/generate-loops.test.ts tests/bundled-loops.test.ts`
Expected: FAIL.

- [ ] **Step 3: Rewrite the meta-prompt loop section**

In `src/workflow/generate.ts` `buildWorkflowGenerationPrompt`, replace the "# Loops are NOT supported — UNROLL them" section with:

```
# Loops (bounded cycles) ARE supported — use a loop-back gate
For iterative work ("review then fix then re-review until clean"), use a gate
with a "loopTo" pointing to an EARLIER phase, plus an optional "maxIterations":
  { "kind": "gate", "dependsOn": ["fix"], "condition": { "step": "fix", "contains": "DONE" },
    "loopTo": "review", "maxIterations": 5, "onFalse": "fail" }
Semantics:
  - condition TRUE  → loop converged; continue forward.
  - condition FALSE and iterations remain → jump back to "loopTo" and re-run the body.
  - condition FALSE and the cap is hit → apply "onFalse" (fail/stop/continue).
Rules: the gate must be in a phase AFTER the phases it re-runs; "loopTo" names an
earlier phase; the loop body re-runs each pass; the current pass is available as
{{iteration}}. Keep maxIterations small (default cap is 10). Loops must be nested
or disjoint, never partially overlapping.
```

Update the "# Before you answer — self-check" section to add:

```
For any gate with "loopTo", confirm it points to an EARLIER phase and that the
gate sits in a phase BELOW the body it re-runs.
```

Also update the worked example or add a second worked example showing a review→fix→check loop with `loopTo`. (Add a compact second example block right after the existing one.)

- [ ] **Step 4: Add the bundled loop workflow**

In `src/workflow/bundled.ts`, add a `review-loop` workflow to the exported list (mirror the existing `bug-hunt` gate style). Use free opencode models consistent with the others in the file:

```ts
{
  name: "review-loop",
  description: "Implement, then review and fix in a bounded loop until clean.",
  phases: [
    { id: "implement", title: "Implement", steps: [
      { id: "impl", agent: "opencode", model: "opencode/mimo-v2.5-free",
        prompt: "Implement the task fully:\n{{input}}" } ] },
    { id: "review", title: "Review", steps: [
      { id: "review", agent: "opencode", model: "opencode/mimo-v2.5-free", dependsOn: ["impl"],
        prompt: "Review the current implementation for issues (iteration {{iteration}}). If there are NO remaining issues, reply with the single word DONE. Otherwise list the issues.\n{{steps.impl.output}}" } ] },
    { id: "fix", title: "Fix", steps: [
      { id: "fix", agent: "opencode", model: "opencode/mimo-v2.5-free", dependsOn: ["review"],
        prompt: "Apply fixes for these review findings, then summarize what changed:\n{{steps.review.output}}" } ] },
    { id: "gate", title: "Converged?", steps: [
      { id: "loop-gate", kind: "gate", dependsOn: ["review"],
        condition: { step: "review", contains: "DONE" },
        loopTo: "review", maxIterations: 5, onFalse: "continue" } ] },
  ],
},
```

(Confirm the exact list/const the file exports and append there. The condition tests the review output for "DONE"; the gate loops back to "review" so each pass re-reviews after the fix.)

- [ ] **Step 5: Update docs**

In `docs/workflow-creation.md`: add a "Loops" section documenting the loop-back gate (`loopTo`, `maxIterations`), the convergence/exhaustion semantics, the per-loop cap + `loopMaxIterations` config default (10), the gate-after-body rule, and the `{{iteration}}` template. Reference the `review-loop` bundled example.

In `README.md`: add one line under the workflow feature list noting bounded loops via loop-back gates.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run tests/generate-loops.test.ts tests/bundled-loops.test.ts`
Expected: PASS.

- [ ] **Step 7: Full suite, typecheck, lint, build**

```bash
npx vitest run && npx tsc --noEmit && npx biome check && npm run build
```
Expected: all green; build success.

- [ ] **Step 8: Commit**

```bash
git add src/workflow/generate.ts src/workflow/bundled.ts docs/workflow-creation.md README.md tests/generate-loops.test.ts tests/bundled-loops.test.ts
git commit -m "Teach loops to the workflow author, ship a loop example, document loops"
```

---

## Final verification (after all tasks)

- [ ] `npx vitest run` — all tests pass.
- [ ] `npx tsc --noEmit` — clean.
- [ ] `npx biome check` — clean (no new warnings beyond the pre-existing `noArrayIndexKey` in `src/tui/CommandSuggestionMenu.tsx`).
- [ ] `npm run build` — ESM build success.
- [ ] Manual smoke (optional): run the `review-loop` bundled workflow against a trivial input and confirm the live TUI shows iterations and the gate converges/exhausts.
- [ ] Open a PR; run the code-review loop until clean.
