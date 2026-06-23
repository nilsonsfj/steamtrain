# Act on Run History (re-run / retry-failed) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make run history actionable — re-run a past run, or retry only its failed/not-run steps — from the CLI, TUI, and web UI.

**Architecture:** A pure shared core (`src/workflow/rerun.ts`) turns a `RunRecord` + mode into a launch plan (workflow, input, a seed cache of already-succeeded steps, and a drift-downgrade flag). The engine already resumes from a `cache: Map<stepId, StepResult>`, so each surface just feeds the seed into its existing run pipeline. A new optional `specHash` on `RunRecord` lets retry-failed detect when the workflow definition changed since the run and fall back to a full re-run.

**Tech Stack:** TypeScript (strict), Node, Ink (TUI), plain Node HTTP + embedded JS (web), vitest, biome, tsup/bun build.

## Global Constraints

- Record format change is **additive only**: keep `RUN_RECORD_VERSION = 1`; add `specHash?: string`. A version bump would make `validateRecord` drop all existing v1 records.
- No new runtime dependencies.
- Commit messages must NOT include `Co-Authored-By` trailers (user's global rule).
- Tests: `npx vitest run`. Typecheck: `npx tsc --noEmit`. Lint: `npx biome check`. Build: `npm run build`.
- Some web/socket tests need the sandbox disabled — run `tests/web-server.test.ts` with `dangerouslyDisableSandbox: true` if a bind/listen fails.
- `cwd` for a re-run is the current process cwd of each surface, never the record's cwd. `seedCacheFromRecord` is keyed by stepId and is cwd-independent.

---

### Task 1: Record the `specHash` (additive record field)

**Files:**
- Modify: `src/workflow/history.ts` (add `specHash?` to `RunRecord` + `RunRecordMeta`; emit it in `build()`)
- Modify: `src/workflow/history-store.ts` (pass `specHash` through `validateRecord`)
- Test: `tests/workflow-history.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `RunRecord.specHash?: string`
  - `RunRecordMeta.specHash?: string`
  - `RunRecordBuilder` constructed with a `meta.specHash` writes it into `build()` output; round-trips through the history store.

- [ ] **Step 1: Write the failing test**

Add to `tests/workflow-history.test.ts`:

```ts
it("records and round-trips an optional specHash", async () => {
  const builder = new RunRecordBuilder({
    id: "r-spec",
    workflow: "demo",
    input: "hi",
    cwd: "/tmp",
    specHash: "abc123",
  });
  builder.handle({ kind: "workflow_start", name: "demo", phaseCount: 0, stepCount: 0, ts: 1 });
  builder.handle({ kind: "workflow_done", ok: true, results: [], ts: 2 });
  const record = builder.build({ status: "done" });
  expect(record.specHash).toBe("abc123");

  const dir = await mkdtemp(join(tmpdir(), "st-hist-spec-"));
  const store = createWorkflowHistoryStore(dir);
  await store.save(record);
  const loaded = await store.get("r-spec");
  expect(loaded?.specHash).toBe("abc123");
});
```

Ensure these imports exist at the top of the test file (add any missing): `import { mkdtemp } from "node:fs/promises";`, `import { tmpdir } from "node:os";`, `import { join } from "node:path";`, and `createWorkflowHistoryStore`, `RunRecordBuilder` from `../src/workflow`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/workflow-history.test.ts -t "specHash"`
Expected: FAIL — `record.specHash` is `undefined` (field not yet stored).

- [ ] **Step 3: Add the field to the model and builder**

In `src/workflow/history.ts`, add to `RunRecord` (after `cwd: string;`):

```ts
  /** Hash of the workflow spec at run time; enables drift-safe retry-failed. */
  specHash?: string;
```

Add the same field to `RunRecordMeta` (after `cwd: string;`):

```ts
  specHash?: string;
```

In `RunRecordBuilder.build(...)`, add `specHash` to the returned object (place it right after `cwd: this.meta.cwd,`):

```ts
      specHash: this.meta.specHash,
```

- [ ] **Step 4: Pass specHash through the store reader**

In `src/workflow/history-store.ts`, inside `validateRecord`'s returned object (after `cwd: ...,`), add:

```ts
    specHash: typeof r.specHash === "string" ? r.specHash : undefined,
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/workflow-history.test.ts -t "specHash"`
Expected: PASS.

- [ ] **Step 6: Typecheck + commit**

Run: `npx tsc --noEmit`
Expected: no errors.

```bash
git add src/workflow/history.ts src/workflow/history-store.ts tests/workflow-history.test.ts
git commit -m "Record optional specHash on run records (additive, v1-compatible)"
```

---

### Task 2: Shared re-run core (`src/workflow/rerun.ts`)

**Files:**
- Create: `src/workflow/rerun.ts`
- Modify: `src/workflow/index.ts` (export the new module)
- Test: `tests/rerun.test.ts`

**Interfaces:**
- Consumes:
  - `RunRecord` (from `./history`), `RunStepStatus`
  - `hashWorkflowSpec(spec)` (from `./cache-store`)
  - `WorkflowSpec`, `StepResult` (from `./types`)
- Produces:
  - `type RerunMode = "rerun" | "retry-failed"`
  - `interface RerunPlan { workflow: string; input: string; seedCache: Map<string, StepResult>; downgraded?: "spec-changed" | "no-spec-hash" }`
  - `interface RerunError { error: string }`
  - `function seedCacheFromRecord(record: RunRecord): Map<string, StepResult>`
  - `function planRerun(record: RunRecord, mode: RerunMode, currentSpec: WorkflowSpec | undefined): RerunPlan | RerunError`
  - `function isRerunError(plan: RerunPlan | RerunError): plan is RerunError`

- [ ] **Step 1: Write the failing tests**

Create `tests/rerun.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  isRerunError,
  planRerun,
  seedCacheFromRecord,
  type RerunPlan,
} from "../src/workflow/rerun";
import { hashWorkflowSpec } from "../src/workflow/cache-store";
import type { RunRecord, HistoryStep, HistoryPhase } from "../src/workflow/history";
import { RUN_RECORD_VERSION } from "../src/workflow/history";
import type { StepResult, WorkflowSpec } from "../src/workflow/types";

function step(over: Partial<HistoryStep> & { stepId: string }): HistoryStep {
  return {
    blockKind: "worker",
    status: "done",
    text: "",
    cached: false,
    result: { stepId: over.stepId, ok: true, output: "out", durationMs: 1 },
    ...over,
  };
}

function phase(steps: HistoryStep[]): HistoryPhase {
  return { phaseId: "p1", title: "P1", index: 0, stepCount: steps.length, steps, done: true, ok: true };
}

function record(over: Partial<RunRecord>): RunRecord {
  return {
    version: RUN_RECORD_VERSION,
    id: "r1",
    workflow: "demo",
    input: "in",
    cwd: "/tmp",
    status: "error",
    ok: false,
    startedAt: 1,
    endedAt: 2,
    durationMs: 1,
    phases: [],
    totals: { steps: 0, ok: 0, failed: 0, cached: 0, costUsd: 0, durationMs: 0 },
    ...over,
  };
}

const spec: WorkflowSpec = {
  name: "demo",
  description: "d",
  phases: [{ id: "p1", title: "P1", steps: [{ id: "a", kind: "worker", agent: "claude", prompt: "x" }] }],
};

describe("seedCacheFromRecord", () => {
  it("includes done steps (parents and fan-out children), excludes others", () => {
    const rec = record({
      phases: [
        phase([
          step({ stepId: "a" }), // done
          step({ stepId: "b", status: "error", result: { stepId: "b", ok: false, output: "boom", durationMs: 1 } }),
          step({ stepId: "c", status: "pending", result: undefined }),
          step({ stepId: "fan" }), // done parent
          step({ stepId: "fan[0]", parentStepId: "fan" }), // done child
          step({ stepId: "fan[1]", parentStepId: "fan", status: "error", result: { stepId: "fan[1]", ok: false, output: "x", durationMs: 1 } }),
        ]),
      ],
    });
    const seed = seedCacheFromRecord(rec);
    expect([...seed.keys()].sort()).toEqual(["a", "fan", "fan[0]"]);
  });

  it("skips done steps that have no stored result", () => {
    const rec = record({ phases: [phase([step({ stepId: "a", result: undefined })])] });
    expect(seedCacheFromRecord(rec).size).toBe(0);
  });
});

describe("planRerun", () => {
  it("errors when the workflow no longer exists", () => {
    const plan = planRerun(record({}), "rerun", undefined);
    expect(isRerunError(plan)).toBe(true);
    if (isRerunError(plan)) expect(plan.error).toContain("demo");
  });

  it("rerun mode produces an empty seed and no downgrade", () => {
    const plan = planRerun(record({ specHash: hashWorkflowSpec(spec) }), "rerun", spec) as RerunPlan;
    expect(isRerunError(plan)).toBe(false);
    expect(plan.seedCache.size).toBe(0);
    expect(plan.downgraded).toBeUndefined();
    expect(plan.workflow).toBe("demo");
    expect(plan.input).toBe("in");
  });

  it("retry-failed seeds from the record when specHash matches", () => {
    const rec = record({ specHash: hashWorkflowSpec(spec), phases: [phase([step({ stepId: "a" })])] });
    const plan = planRerun(rec, "retry-failed", spec) as RerunPlan;
    expect(plan.seedCache.has("a")).toBe(true);
    expect(plan.downgraded).toBeUndefined();
  });

  it("retry-failed downgrades to a full re-run when specHash is absent", () => {
    const rec = record({ phases: [phase([step({ stepId: "a" })])] });
    const plan = planRerun(rec, "retry-failed", spec) as RerunPlan;
    expect(plan.seedCache.size).toBe(0);
    expect(plan.downgraded).toBe("no-spec-hash");
  });

  it("retry-failed downgrades when the spec changed", () => {
    const rec = record({ specHash: "stale", phases: [phase([step({ stepId: "a" })])] });
    const plan = planRerun(rec, "retry-failed", spec) as RerunPlan;
    expect(plan.seedCache.size).toBe(0);
    expect(plan.downgraded).toBe("spec-changed");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/rerun.test.ts`
Expected: FAIL — cannot find module `../src/workflow/rerun`.

- [ ] **Step 3: Implement the core module**

Create `src/workflow/rerun.ts`:

```ts
import { hashWorkflowSpec } from "./cache-store";
import type { RunRecord } from "./history";
import type { StepResult, WorkflowSpec } from "./types";

/** Re-run a past run fresh, or replay successes and re-run only failures. */
export type RerunMode = "rerun" | "retry-failed";

export interface RerunPlan {
  workflow: string;
  input: string;
  /** Steps to seed into the engine cache; empty for a full re-run. */
  seedCache: Map<string, StepResult>;
  /** Set when retry-failed could not safely seed and fell back to a full run. */
  downgraded?: "spec-changed" | "no-spec-hash";
}

export interface RerunError {
  error: string;
}

export function isRerunError(plan: RerunPlan | RerunError): plan is RerunError {
  return "error" in plan;
}

/**
 * Build an engine cache seed from a record's completed steps. Every step that
 * finished `done` with a stored result is replayable, keyed by its stepId — this
 * covers both fan-out parents (which the engine replays wholesale via
 * `result.childResults`) and individual done children of a partially-failed
 * fan-out (which the engine replays one-by-one while re-running failed siblings).
 * Pending / error / running steps are omitted so they re-execute.
 */
export function seedCacheFromRecord(record: RunRecord): Map<string, StepResult> {
  const seed = new Map<string, StepResult>();
  for (const phase of record.phases) {
    for (const step of phase.steps) {
      if (step.status === "done" && step.result) seed.set(step.stepId, step.result);
    }
  }
  return seed;
}

/**
 * Decide what a re-run / retry-failed should actually launch. The workflow and
 * input always come from the record; cwd is the caller's current cwd. For
 * retry-failed, the seed is only trusted when the recorded `specHash` matches
 * the current spec — otherwise replaying old outputs against a changed
 * definition could be wrong, so we downgrade to a full re-run.
 */
export function planRerun(
  record: RunRecord,
  mode: RerunMode,
  currentSpec: WorkflowSpec | undefined,
): RerunPlan | RerunError {
  if (!currentSpec) return { error: `workflow '${record.workflow}' no longer exists` };

  const base = { workflow: record.workflow, input: record.input };
  if (mode === "rerun") return { ...base, seedCache: new Map() };

  if (!record.specHash) return { ...base, seedCache: new Map(), downgraded: "no-spec-hash" };
  if (record.specHash !== hashWorkflowSpec(currentSpec)) {
    return { ...base, seedCache: new Map(), downgraded: "spec-changed" };
  }
  return { ...base, seedCache: seedCacheFromRecord(record) };
}
```

- [ ] **Step 4: Export from the workflow barrel**

In `src/workflow/index.ts`, add an export line alongside the other re-exports:

```ts
export * from "./rerun";
```

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run tests/rerun.test.ts`
Expected: PASS (all cases).
Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/workflow/rerun.ts src/workflow/index.ts tests/rerun.test.ts
git commit -m "Add shared re-run/retry-failed planning core"
```

---

### Task 3: Engine integration — seeded cache re-runs only failures

This task adds no production code; it proves the engine already does the right thing when fed a seed built by `seedCacheFromRecord`, locking the behavior the surfaces rely on.

**Files:**
- Test: `tests/rerun-engine.test.ts`

**Interfaces:**
- Consumes: `runWorkflow` (from `../src/workflow/engine`), `seedCacheFromRecord` (Task 2), `RunRecordBuilder` (from `../src/workflow`).

- [ ] **Step 1: Write the failing test**

Create `tests/rerun-engine.test.ts`. It runs a 2-step workflow with a fake adapter where the second step fails on the first attempt and succeeds on retry, builds a record from the first run, seeds a cache from it, and asserts the re-run only spawns the previously-failed step.

```ts
import { describe, expect, it } from "vitest";
import { runWorkflow } from "../src/workflow/engine";
import { RunRecordBuilder, seedCacheFromRecord } from "../src/workflow";
import type { AgentAdapter } from "../src/agents";
import type { AgentEvent, AgentId } from "../src/types/events";
import type { StepResult, WorkflowSpec } from "../src/workflow/types";

const spec: WorkflowSpec = {
  name: "demo",
  description: "d",
  phases: [
    {
      id: "p1",
      title: "P1",
      steps: [
        { id: "a", kind: "worker", agent: "claude", prompt: "do a" },
        { id: "b", kind: "worker", agent: "claude", prompt: "do b", dependsOn: ["a"] },
      ],
    },
  ],
};

// A counting adapter; `failOnce` makes step "b" fail the first time it is asked.
function makeDeps(spawns: string[], failStep?: string) {
  const createAdapter = (_id: AgentId): AgentAdapter => ({
    async *run(opts): AsyncGenerator<AgentEvent> {
      const which = opts.prompt.includes("do b") ? "b" : "a";
      spawns.push(which);
      if (which === failStep) {
        yield { kind: "result", text: "boom", isError: true };
        return;
      }
      yield { kind: "result", text: `${which}-ok` };
    },
  });
  return { createAdapter, maxConcurrency: 2, cwd: "/tmp" };
}

async function drain(spec: WorkflowSpec, cache: Map<string, StepResult>, deps: ReturnType<typeof makeDeps>) {
  const builder = new RunRecordBuilder({ id: "x", workflow: "demo", input: "in", cwd: "/tmp" });
  for await (const ev of runWorkflow(spec, { input: "in", cache }, deps)) builder.handle(ev);
  return builder;
}

describe("seeded cache re-run", () => {
  it("re-runs only the previously-failed step", async () => {
    const firstSpawns: string[] = [];
    const cache1 = new Map<string, StepResult>();
    const builder = await drain(spec, cache1, makeDeps(firstSpawns, "b"));
    expect(firstSpawns.sort()).toEqual(["a", "b"]); // both ran
    const record = builder.build({ status: "error" });

    const seed = seedCacheFromRecord(record);
    expect([...seed.keys()]).toEqual(["a"]); // only "a" succeeded

    const secondSpawns: string[] = [];
    await drain(spec, seed, makeDeps(secondSpawns)); // no failStep this time
    expect(secondSpawns).toEqual(["b"]); // "a" replayed from seed, only "b" re-ran
  });
});
```

- [ ] **Step 2: Run the test to verify it passes (behavior already exists)**

Run: `npx vitest run tests/rerun-engine.test.ts`
Expected: PASS. (If `AgentAdapter`'s `run` signature differs, adjust the fake to match `src/agents`’ exported interface — the adapter must be an async generator of `AgentEvent` accepting `{ prompt, model?, effort?, cwd, ... }`.)

- [ ] **Step 3: Typecheck + commit**

Run: `npx tsc --noEmit`
Expected: no errors.

```bash
git add tests/rerun-engine.test.ts
git commit -m "Lock in seeded-cache resume: retry re-runs only failed steps"
```

---

### Task 4: CLI — `workflow run --from <runId> [--retry-failed]`

**Files:**
- Modify: `src/cli.ts` (`RunOptions`, `parseRunOptions`, `runWorkflowCommand`, help/usage text)
- Test: `tests/cli.test.ts`

**Interfaces:**
- Consumes: `planRerun`, `isRerunError`, `RerunMode` (from `./workflow`), `createWorkflowHistoryStore`, `hashWorkflowSpec` (already imported or add).
- Produces: CLI behavior:
  - `workflow run --from <id>` → fresh re-run of the recorded workflow+input.
  - `workflow run --from <id> --retry-failed` → retry, seeding from the record.
  - `--input` still overrides the recorded input; `<name>` is optional when `--from` is given.
  - The new run records its own `specHash` (so subsequent retries of *it* work).

- [ ] **Step 1: Write the failing tests**

Add to `tests/cli.test.ts` a describe block. Use the existing test scaffolding patterns in that file (a fake orchestrator/catalog + temp cwd; mirror how other `runWorkflow` tests there set up `runCli`). The two behaviors to assert:

```ts
it("re-runs a recorded run with --from (fresh)", async () => {
  // 1. Seed history: run `demo` once (input "hello") so a record exists.
  // 2. Capture the record id from `.steamtrain/history`.
  // 3. Run: runCli(["workflow", "run", "--from", <id>], io)
  // 4. Assert exit 0 and that the run used workflow "demo" + input "hello"
  //    (e.g. the fake adapter recorded the prompt, or stdout shows the steps).
});

it("retries only failed steps with --from --retry-failed", async () => {
  // 1. Seed history with a run where step "b" failed (fake adapter fails "b").
  // 2. Run: runCli(["workflow","run","--from",<id>,"--retry-failed"], io) with
  //    an adapter that now succeeds.
  // 3. Assert step "a" is reported cached/replayed and "b" actually re-ran.
});
```

Implement these by following the established `tests/cli.test.ts` helpers (look for how it constructs `io`, the fake config, and reads/asserts on `out` lines). Read a fresh record id from disk with:

```ts
import { readdir, readFile } from "node:fs/promises";
async function latestRecordId(cwd: string): Promise<string> {
  const dir = join(cwd, ".steamtrain/history");
  const files = (await readdir(dir)).filter((f) => f.endsWith(".json"));
  const records = await Promise.all(
    files.map(async (f) => JSON.parse(await readFile(join(dir, f), "utf8")) as { id: string; startedAt: number }),
  );
  records.sort((a, b) => b.startedAt - a.startedAt);
  return records[0]!.id;
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/cli.test.ts -t "from"`
Expected: FAIL — `--from` is not parsed; `<name>` required error or unknown flag.

- [ ] **Step 3: Extend `RunOptions` and `parseRunOptions`**

In `src/cli.ts`, extend the `RunOptions` interface:

```ts
interface RunOptions {
  input?: string;
  stdin: boolean;
  json: boolean;
  fresh: boolean;
  from?: string;
  retryFailed: boolean;
}
```

In `parseRunOptions`, initialize and parse the new flags. Update the initializer:

```ts
  const options: RunOptions = { stdin: false, json: false, fresh: false, retryFailed: false };
```

Add cases in the flag loop (next to the `--fresh` case):

```ts
    } else if (arg === "--from") {
      options.from = argv[++i];
    } else if (arg === "--retry-failed") {
      options.retryFailed = true;
```

- [ ] **Step 4: Branch `runWorkflowCommand` on `--from`**

In `runWorkflowCommand` (`src/cli.ts`), after `const options = parseRunOptions(...)` and before the input/name resolution, resolve the record when `--from` is given. Replace the current name + input resolution block so that, when `options.from` is set, name and input come from the record (with `--input` override), and a `RerunPlan` decides the seed.

Add near the top of the function (after parsing options), the rerun resolution:

```ts
  const cwd = io.cwd ?? process.cwd();
  const historyStore = createWorkflowHistoryStore(join(cwd, WORKFLOW_HISTORY_DIR));

  let name = rest[0]; // existing positional name (may be undefined with --from)
  let input = options.input;
  let seed: Map<string, StepResult> | undefined;
  let forceFresh = options.fresh;

  if (options.from) {
    const record = await historyStore.get(options.from);
    if (!record) {
      err(`unknown run '${options.from}'\n`);
      return 1;
    }
    name = record.workflow;
    input = options.input ?? record.input;
    const spec = orchestrator.listWorkflows()[name];
    const mode: RerunMode = options.retryFailed ? "retry-failed" : "rerun";
    const plan = planRerun(record, mode, spec);
    if (isRerunError(plan)) {
      err(`${plan.error}\n`);
      return 1;
    }
    if (plan.downgraded) {
      err(`note: workflow changed since this run; doing a full re-run\n`);
    }
    seed = plan.seedCache;
    forceFresh = mode === "rerun";
  }
```

Note: the existing code computes `name`/`input`/`cwd`/`historyStore` further down — fold those existing declarations into the ones above (remove the now-duplicate `const cwd`, `const historyStore`, `const name`, and the `--input`/`--stdin` input resolution must still run for the non-`--from` path). Concretely, guard the existing input-required + name-lookup logic with `if (!options.from) { ... existing ... }`, and keep a single shared `const spec = orchestrator.listWorkflows()[name]` lookup + dispatch check that runs for both paths.

Then, where the cache is currently built:

```ts
  const store = createWorkflowCacheStore(join(cwd, WORKFLOW_CACHE_DIR));
  const key = workflowCacheKey(name, input.trim(), cwd, spec);
  const cache = new Map<string, StepResult>();
  if (forceFresh) {
    await store.clear(key);
  } else {
    const loaded = await store.load(key);
    for (const [stepId, result] of loaded) cache.set(stepId, result);
  }
  if (seed) {
    for (const [stepId, result] of seed) cache.set(stepId, result);
    await store.save(key, cache); // make the seed the resume baseline
  }
```

And construct the recorder with the current spec hash:

```ts
  const recorder = new RunRecordBuilder({
    id: randomUUID(),
    workflow: name,
    input: input.trim(),
    cwd,
    specHash: hashWorkflowSpec(spec),
  });
```

Add the imports at the top of `src/cli.ts` (in the existing `./workflow` import group): `planRerun`, `isRerunError`, `type RerunMode`, and `hashWorkflowSpec` if not already imported.

- [ ] **Step 5: Update usage/help text**

Update the usage string in `runWorkflowCommand` and `helpText()`:

```
  steamtrain workflow run <name> --input <text> [--json] [--fresh]
  steamtrain workflow run --from <runId> [--retry-failed] [--json]
```

- [ ] **Step 6: Run tests + typecheck**

Run: `npx vitest run tests/cli.test.ts`
Expected: PASS (including the two new cases).
Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/cli.ts tests/cli.test.ts
git commit -m "CLI: re-run / retry-failed past runs with --from"
```

---

### Task 5: Web — seedable runs + re-run/retry routes

**Files:**
- Modify: `src/web/runs.ts` (`start` accepts a seed; `drive` seeds + records specHash)
- Modify: `src/web/server.ts` (two POST routes; route doc comment)
- Test: `tests/web-server.test.ts`

**Interfaces:**
- Consumes: `planRerun`, `isRerunError` (from `../workflow`), `hashWorkflowSpec`.
- Produces:
  - `WorkflowRunManager.start(workflow, input, opts?: { fresh?: boolean; seed?: Map<string, StepResult> }): StartRunResult`
  - `POST /api/history/:id/rerun` → `{ runId }` (full re-run)
  - `POST /api/history/:id/retry` → `{ runId, downgraded? }` (retry-failed)
  - Both 404 when the record is unknown, 400 when the workflow no longer exists.

- [ ] **Step 1: Write the failing tests**

Add to `tests/web-server.test.ts` (mirror the existing run/start test setup, which builds a `WorkflowRunManager` + handler with a fake host + temp cwd):

```ts
it("re-runs a past run via POST /api/history/:id/rerun", async () => {
  // 1. Start + finish a run so a history record is written; read its id.
  // 2. POST /api/history/<id>/rerun -> 200 { runId }.
  // 3. Assert a new run exists (runs.get(runId)) with the same workflow.
});

it("retry-failed seeds the cache and flags drift downgrade", async () => {
  // 1. Save a record whose specHash !== current spec hash.
  // 2. POST /api/history/<id>/retry -> 200 { runId, downgraded: "spec-changed" }.
});

it("returns 404 for rerun of an unknown run id", async () => {
  // POST /api/history/does-not-exist/rerun -> 404.
});
```

Use the existing helpers in the file for constructing the request (look for how other POST routes like `/api/runs` are exercised) and for awaiting a run to settle.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/web-server.test.ts -t "rerun|retry|unknown run"` with `dangerouslyDisableSandbox: true` if the server binds a socket.
Expected: FAIL — routes return 404 (not yet defined) / shapes missing.

- [ ] **Step 3: Make `start` + `drive` seed-aware and record specHash**

In `src/web/runs.ts`, change `start`:

```ts
  start(
    workflow: string,
    input: string,
    opts?: { fresh?: boolean; seed?: Map<string, StepResult> },
  ): StartRunResult {
```

and pass the seed into `drive`:

```ts
    void this.drive(run, spec, opts?.fresh ?? false, opts?.seed);
```

Change `drive`'s signature and cache assembly:

```ts
  private async drive(
    run: Run,
    spec: WorkflowSpec,
    fresh: boolean,
    seed?: Map<string, StepResult>,
  ): Promise<void> {
    const key = workflowCacheKey(run.workflow, run.input, this.cwd, spec);
    const recorder = new RunRecordBuilder(
      { id: run.id, workflow: run.workflow, input: run.input, cwd: this.cwd, specHash: hashWorkflowSpec(spec) },
      run.startedAt,
    );
    let ok: boolean | undefined;
    try {
      let cache: Map<string, StepResult>;
      if (fresh) {
        await this.cacheStore.clear(key);
        cache = new Map();
      } else {
        cache = await this.cacheStore.load(key);
      }
      if (seed) {
        for (const [stepId, result] of seed) cache.set(stepId, result);
        await this.cacheStore.save(key, cache); // seed becomes the resume baseline
      }
```

Add `hashWorkflowSpec` to the `../workflow` (or `./cache-store`) import in `runs.ts`.

- [ ] **Step 4: Add a public record→run helper on the manager**

So the server route stays thin and the planning lives in one place, add to `WorkflowRunManager` (in `src/web/runs.ts`):

```ts
  /** Launch a re-run / retry-failed of a saved record; resolves the plan internally. */
  rerunFromRecord(record: RunRecord, mode: RerunMode): StartRunResult & { downgraded?: RerunPlan["downgraded"] } {
    const spec = this.host.listWorkflows()[record.workflow];
    const plan = planRerun(record, mode, spec);
    if (isRerunError(plan)) return { ok: false, error: plan.error };
    const started = this.start(plan.workflow, plan.input, {
      fresh: mode === "rerun",
      seed: plan.seedCache,
    });
    return started.ok ? { ...started, downgraded: plan.downgraded } : started;
  }
```

Import `planRerun`, `isRerunError`, `type RerunMode`, `type RerunPlan`, and `type RunRecord` in `runs.ts`.

- [ ] **Step 5: Add the routes**

In `src/web/server.ts`, near the existing `/api/history/:id` handling, add (the path matchers should mirror how `cancelMatch`/`streamMatch` are built):

```ts
  const rerunMatch = path.match(/^\/api\/history\/([^/]+)\/(rerun|retry)$/);
  if (method === "POST" && rerunMatch) {
    const id = rerunMatch[1]!;
    const mode = rerunMatch[2] === "retry" ? "retry-failed" : "rerun";
    const record = await deps.history.get(id);
    if (!record) return json(res, 404, { error: `unknown run '${id}'` });
    const result = deps.runs.rerunFromRecord(record, mode);
    if (!result.ok) return json(res, 400, { error: result.error });
    return json(res, 200, { runId: result.runId, downgraded: result.downgraded });
  }
```

Use whatever the file's existing JSON-response helper is (e.g. `json(res, status, body)` or the inline pattern already used by the other routes — match the surrounding code). Confirm `deps.history` is the history store available to the handler (it backs `GET /api/history/:id`); if the handler reaches the store differently, use that same accessor.

Update the route doc comment block at the top with:

```
 *   POST   /api/history/:id/rerun   re-run a past run -> { runId }
 *   POST   /api/history/:id/retry   retry failed steps -> { runId, downgraded? }
```

- [ ] **Step 6: Run tests + typecheck**

Run: `npx vitest run tests/web-server.test.ts` (add `dangerouslyDisableSandbox: true` if needed).
Expected: PASS.
Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/web/runs.ts src/web/server.ts tests/web-server.test.ts
git commit -m "Web: seedable runs + re-run/retry-failed history routes"
```

---

### Task 6: Web UI — re-run / retry buttons in history detail

**Files:**
- Modify: `src/web/html.ts` (history detail renders buttons + a downgrade banner; client posts to the new routes and navigates to the run)
- Test: covered by Task 5's route tests (no separate DOM test harness in this repo); manual verification steps below.

**Interfaces:**
- Consumes: `POST /api/history/:id/rerun`, `POST /api/history/:id/retry` (Task 5).
- Produces: two buttons in the history detail view; on click they POST, then switch to the live run view for the returned `runId`. "Retry failed" is omitted when the record has no failures.

- [ ] **Step 1: Locate the history detail renderer + run-navigation helper**

Run: `grep -n "renderHistoryDetail\|history detail\|function showRun\|openRun\|/api/runs\|/api/history/" src/web/html.ts`
Identify (a) the function that renders a single record's detail, and (b) the existing client function that opens/streams a run by id (the one `POST /api/runs` calls on success). You will reuse (b) to navigate after a re-run.

- [ ] **Step 2: Add the buttons to the detail markup**

In the history-detail render function, add two buttons near the record header. Use the record's totals to decide whether to show "Retry failed":

```js
var canRetry = rec.totals && rec.totals.failed > 0;
var actions =
  '<div class="run-actions">' +
  '<button onclick="rerunHistory(\'' + rec.id + '\', \'rerun\')">Re-run</button>' +
  (canRetry
    ? '<button onclick="rerunHistory(\'' + rec.id + '\', \'retry\')">Retry failed</button>'
    : '') +
  '</div>';
```

Insert `actions` into the returned detail HTML (next to the existing title/meta).

- [ ] **Step 3: Add the client handler**

In the page's inline `<script>` (where other `fetch` helpers live), add:

```js
function rerunHistory(id, mode) {
  fetch('/api/history/' + id + '/' + mode, { method: 'POST' })
    .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, b: b }; }); })
    .then(function (res) {
      if (!res.ok) { alert(res.b && res.b.error ? res.b.error : 'rerun failed'); return; }
      if (res.b.downgraded) {
        alert('Workflow changed since this run — doing a full re-run.');
      }
      openRun(res.b.runId); // reuse the existing run-view navigation function
    })
    .catch(function () { alert('rerun failed'); });
}
```

Replace `openRun(res.b.runId)` with the actual run-navigation function name found in Step 1.

- [ ] **Step 4: Minimal styling (optional, match existing)**

If the page has a stylesheet block, add a small rule so the buttons match the existing button styling (reuse an existing button class instead of new CSS if one exists). Skip if buttons already inherit suitable styles.

- [ ] **Step 5: Build + manual verification**

Run: `npm run build`
Expected: build succeeds.

Manual check (document, do not script):
1. Start the web UI on a project with at least one finished run that had a failure.
2. Open History → a record → confirm "Re-run" always shows and "Retry failed" shows only when there were failures.
3. Click "Re-run" → a new run starts and the view switches to it.
4. Click "Retry failed" → only the failed steps re-execute; replayed steps show as cached.

- [ ] **Step 6: Commit**

```bash
git add src/web/html.ts
git commit -m "Web UI: re-run / retry-failed buttons in history detail"
```

---

### Task 7: TUI — re-run / retry keybindings in history detail

**Files:**
- Modify: `src/tui/App.tsx` (history detail key handling; a `rerunFromRecord` helper; extend `runWorkflow` to accept a seed)
- Modify: `src/tui/WorkflowHistory.tsx` (detail footer hint text)
- Test: `tests/workflow-history.test.ts` or a focused App-level test if the file has one; otherwise assert the helper logic via the shared core (already covered) and verify wiring by typecheck + build + manual steps.

**Interfaces:**
- Consumes: `planRerun`, `isRerunError`, `type RerunMode` (from `../workflow`).
- Produces:
  - `runWorkflow(name, input, opts?: { reuseMemoryCache?: boolean; fresh?: boolean; seed?: Map<string, StepResult> })`
  - In history detail: `r` triggers a re-run, `f` triggers retry-failed; both close the overlay and start the run.

- [ ] **Step 1: Extend the TUI `runWorkflow` to accept a seed**

In `src/tui/App.tsx`, change the `runWorkflow` callback's options type:

```ts
      opts?: { reuseMemoryCache?: boolean; fresh?: boolean; seed?: Map<string, StepResult> },
```

In its async body, after the existing cache resolution (`fresh` / `reuseMemoryCache` / `store.load`), apply the seed:

```ts
          const cache = workflowCacheRef.current;
          if (opts?.seed) {
            for (const [stepId, result] of opts.seed) cache.set(stepId, result);
            await store.save(key, cache); // seed becomes the resume baseline
          }
```

(Insert this immediately after `const cache = workflowCacheRef.current;` and before the `for await` run loop.)

Also record the spec hash in the recorder (so re-runs of this run later work). Change the recorder construction:

```ts
          const recorder = new RunRecordBuilder({
            id: randomUUID(),
            workflow: name,
            input,
            cwd,
            specHash: hashWorkflowSpec(spec),
          });
```

Add `hashWorkflowSpec` to the existing `./workflow`-group imports in `App.tsx` if not present (it already imports `workflowCacheKey` from there).

- [ ] **Step 2: Add a `rerunFromRecord` helper**

In `src/tui/App.tsx`, add a `useCallback` near `openHistoryRecord`:

```ts
  const rerunFromRecord = useCallback(
    (record: RunRecord, mode: RerunMode) => {
      const spec = resolveWorkflowSpec(record.workflow);
      const plan = planRerun(record, mode, spec);
      if (isRerunError(plan)) {
        setWfNotice(plan.error);
        return;
      }
      setHistory(null); // close the history overlay
      if (plan.downgraded) {
        setWfNotice("workflow changed since this run; doing a full re-run");
      }
      runWorkflow(plan.workflow, plan.input, {
        fresh: mode === "rerun",
        seed: plan.seedCache,
      });
    },
    [resolveWorkflowSpec, runWorkflow],
  );
```

Add `planRerun`, `isRerunError`, `type RerunMode`, and `type RunRecord` to the imports.

- [ ] **Step 3: Wire the keybindings in history detail**

In the `useInput` handler's detail-view branch (the block after `// Detail view: navigate steps...`), add `r` / `f` handling before the arrow-key navigation:

```ts
      if (input === "r" && history.record) {
        rerunFromRecord(history.record, "rerun");
        return;
      }
      if (input === "f" && history.record && (history.record.totals?.failed ?? 0) > 0) {
        rerunFromRecord(history.record, "retry-failed");
        return;
      }
```

- [ ] **Step 4: Update the detail footer hint**

In `src/tui/WorkflowHistory.tsx`, find the detail-view footer/hint line and append the new keys. For example, change the hint to include:

```
↑/↓ step · → details · r re-run · f retry failed · Esc back
```

(Match the exact existing hint string; only add `· r re-run · f retry failed`.)

- [ ] **Step 5: Typecheck + build**

Run: `npx tsc --noEmit`
Expected: no errors.
Run: `npm run build`
Expected: build succeeds.

Manual check (document, do not script):
1. `/history` → open a finished run with failures → press `r` → it re-runs fresh.
2. Open the same run → press `f` → only failed steps re-run (others show cached).
3. On a fully-successful run, `f` does nothing (no failures).

- [ ] **Step 6: Commit**

```bash
git add src/tui/App.tsx src/tui/WorkflowHistory.tsx
git commit -m "TUI: re-run (r) / retry-failed (f) from history detail"
```

---

### Task 8: Docs + full verification

**Files:**
- Modify: `docs/web-ui.md` (note the new history actions)
- Modify: `TUI-WEBUI-DIFFERENCES.md` (update the run-history row / capability matrix)
- Modify: `README.md` (CLI `--from` / `--retry-failed` usage, if it documents `workflow run`)

- [ ] **Step 1: Update docs**

- In `docs/web-ui.md`, under the history section, document the Re-run / Retry-failed buttons and the drift-downgrade banner.
- In `TUI-WEBUI-DIFFERENCES.md`, update the "Run history" row to note both UIs (and the CLI) can now re-run / retry-failed; if a finer capability row fits, add "Re-run / retry past run | ✅ | ✅ | CLI `--from`".
- In `README.md`, add the new CLI forms next to the existing `workflow run` docs:
  ```
  steamtrain workflow run --from <runId> [--retry-failed]
  ```

- [ ] **Step 2: Full test + lint + typecheck + build**

Run: `npx vitest run`
Expected: all tests pass (run `tests/web-server.test.ts` with `dangerouslyDisableSandbox: true` if a socket bind fails).
Run: `npx tsc --noEmit`
Expected: no errors.
Run: `npx biome check`
Expected: clean (run `npx biome check --write` to auto-fix formatting, then re-check).
Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add docs/web-ui.md TUI-WEBUI-DIFFERENCES.md README.md
git commit -m "Docs: re-run / retry-failed across CLI, TUI, web"
```

- [ ] **Step 4: Open the PR**

```bash
git push -u origin feat/run-history-rerun
gh pr create --title "Act on run history: re-run / retry-failed" --body "$(cat <<'EOF'
## Summary
Make run history actionable across all three surfaces (CLI, TUI, web):
- **Re-run** a past run (same workflow + input) fresh.
- **Retry failed** — replay succeeded steps, re-execute only failed/not-run ones, seeded from the record so it works even when the on-disk cache is gone.

## How it works
- A shared, pure core (`src/workflow/rerun.ts`) turns a `RunRecord` + mode into a launch plan (workflow, input, seed cache, drift flag). All three surfaces feed the seed into their existing run pipeline (the engine already resumes from a `cache: Map`).
- Records now carry an optional `specHash` (additive; existing records keep working). Retry-failed only seeds when the recorded spec hash matches the current workflow; otherwise it downgrades to a full re-run.

## Surfaces
- CLI: `workflow run --from <runId> [--retry-failed]`
- TUI: `r` (re-run) / `f` (retry failed) in the history detail view
- Web: Re-run / Retry-failed buttons in history detail

## Testing
- `tests/rerun.test.ts` (pure core), `tests/rerun-engine.test.ts` (seeded-cache resume), CLI + web-server route tests.
- Full suite, tsc, biome, and build all green.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review notes

- **Spec coverage:** Record `specHash` (Task 1), shared core + guard (Task 2), engine resume proof (Task 3), CLI `--from`/`--retry-failed` (Task 4), web routes + seedable runs (Task 5), web UI buttons (Task 6), TUI keys (Task 7), docs (Task 8). All spec sections mapped.
- **Type consistency:** `RerunPlan` / `RerunError` / `RerunMode` / `seedCacheFromRecord` / `planRerun` / `isRerunError` are used with identical names and shapes in Tasks 2/4/5/7. `start(..., { fresh?, seed? })` matches between Task 5 definition and its callers. `runWorkflow(..., { ..., seed? })` matches between Task 7's definition and its `rerunFromRecord` caller.
- **Drift handling:** only retry-failed consults `specHash`; re-run is always a fresh run with the current spec.
- **No data loss:** record change is additive (`version` stays 1).
