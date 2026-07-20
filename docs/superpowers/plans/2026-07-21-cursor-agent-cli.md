# Cursor Agent CLI Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add first-class steamtrain provider `cursor` for the Cursor Agent CLI (`agent`), with streaming, resume, live models, doctor, and interactive takeover parity with Claude/Codex.

**Architecture:** New `CursorAgentAdapter` under `src/agents/` following the existing `AgentAdapter` + `runAgentProcess` pattern. Cursor NDJSON (`stream-json` + `--stream-partial-output`) maps to normalized `AgentEvent`s. Provider is wired through types, config, doctor, models, takeover, and docs.

**Tech Stack:** TypeScript, Bun, Vitest, Zod, existing `src/agents/*` adapter seam.

## Global Constraints

- Provider id is `cursor`; default binary is `agent`.
- Hardcode headless `--force` and `--trust`.
- When `effort` is set and model does not already contain `effort=`, append `[effort=<value>]` to `--model`.
- Prompt is a trailing argv argument (not stdin).
- No Cursor SDK; CLI only.
- `--mode`, `--sandbox`, `--worktree`, etc. stay as `extraArgs` only.
- TDD: write failing tests before implementation for each task.
- Work on branch `feat/cursor-agent-cli` (do not push commits to `main`).

## File Structure

| Path | Responsibility |
|---|---|
| `src/types/raw-cursor.ts` | Zod schemas for Cursor NDJSON envelopes |
| `src/agents/cursor.ts` | Mapper, argv builder, `CURSOR_MODELS`, `CursorAgentAdapter` |
| `src/agents/cursor-variants.ts` | Parse/cache `agent --list-models` |
| `tests/cursor-adapter.test.ts` | Mapper + argv tests |
| `tests/cursor-variants.test.ts` | List-models parser/cache tests |
| Registration surfaces | `events.ts`, `config.ts`, `index.ts`, `models.ts`, `types.ts` (config zod), `doctor.ts`, `takeover.ts` |
| Docs | README, `docs/agent-configuration.md`, `docs/workflow-spec.md` |

---

### Task 1: Raw schemas + event mapper

**Files:**
- Create: `src/types/raw-cursor.ts`
- Create: `src/agents/cursor.ts` (mapper + stubs only; adapter class in Task 2)
- Create: `tests/cursor-adapter.test.ts`
- Modify: `src/types/events.ts` — add `"cursor"` to `AgentProviderId`

**Interfaces:**
- Consumes: `EventMapper`, `AgentEvent`, `AgentInstanceId` from `src/types/events.ts`; `stringifyContent` from `src/agents/util.ts`
- Produces: `createCursorMapper(agent?: AgentInstanceId): EventMapper`; zod schemas `cursorEnvelope`, `cursorSystemInit`, `cursorAssistant`, `cursorToolCall`, `cursorResult`

- [ ] **Step 1: Add `"cursor"` to `AgentProviderId`**

In `src/types/events.ts`, change:

```ts
export type AgentProviderId = "claude" | "opencode" | "codex" | "amp" | "kiro" | "cursor";
```

- [ ] **Step 2: Write failing mapper tests**

Create `tests/cursor-adapter.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createCursorMapper } from "../src/agents/cursor";
import type { AgentEvent } from "../src/types/events";

const SAMPLES = {
  init: '{"type":"system","subtype":"init","apiKeySource":"login","cwd":"/tmp","session_id":"sess-c1","model":"Composer 2.5","permissionMode":"default"}',
  userEcho: '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hi"}]},"session_id":"sess-c1"}',
  assistantDelta: '{"type":"assistant","timestamp_ms":1000,"message":{"role":"assistant","content":[{"type":"text","text":"Hel"}]},"session_id":"sess-c1"}',
  assistantDelta2: '{"type":"assistant","timestamp_ms":1001,"message":{"role":"assistant","content":[{"type":"text","text":"lo"}]},"session_id":"sess-c1"}',
  assistantFlushBeforeTool: '{"type":"assistant","timestamp_ms":1002,"model_call_id":"mc1","message":{"role":"assistant","content":[{"type":"text","text":"Hello"}]},"session_id":"sess-c1"}',
  assistantFinalFlush: '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Hello"}]},"session_id":"sess-c1"}',
  toolStartedRead: '{"type":"tool_call","subtype":"started","call_id":"c1","tool_call":{"readToolCall":{"args":{"path":"README.md"}}},"session_id":"sess-c1"}',
  toolCompletedRead: '{"type":"tool_call","subtype":"completed","call_id":"c1","tool_call":{"readToolCall":{"args":{"path":"README.md"},"result":{"success":{"content":"# Hi","totalLines":1}}}},"session_id":"sess-c1"}',
  toolStartedWrite: '{"type":"tool_call","subtype":"started","call_id":"c2","tool_call":{"writeToolCall":{"args":{"path":"out.txt","fileText":"x"}}},"session_id":"sess-c1"}',
  toolStartedFn: '{"type":"tool_call","subtype":"started","call_id":"c3","tool_call":{"function":{"name":"Shell","arguments":"{\\"command\\":\\"ls\\"}"}},"session_id":"sess-c1"}',
  resultSuccess: '{"type":"result","subtype":"success","duration_ms":1234,"duration_api_ms":1234,"is_error":false,"result":"Hello","session_id":"sess-c1"}',
  resultError: '{"type":"result","subtype":"error","duration_ms":100,"is_error":true,"result":"fail","session_id":"sess-c1"}',
  unknown: '{"type":"thinking","text":"nope"}',
} as const;

function map(line: string): AgentEvent[] {
  return createCursorMapper()(JSON.parse(line));
}

describe("cursor mapper", () => {
  it("maps system/init to session_start", () => {
    expect(map(SAMPLES.init)).toEqual([
      expect.objectContaining({
        kind: "session_start",
        agent: "cursor",
        sessionId: "sess-c1",
        model: "Composer 2.5",
      }),
    ]);
  });

  it("ignores user echo", () => {
    expect(map(SAMPLES.userEcho)).toEqual([]);
  });

  it("maps streaming assistant deltas and skips buffered flushes", () => {
    expect(map(SAMPLES.assistantDelta)).toEqual([
      expect.objectContaining({ kind: "text_delta", text: "Hel" }),
    ]);
    expect(map(SAMPLES.assistantDelta2)).toEqual([
      expect.objectContaining({ kind: "text_delta", text: "lo" }),
    ]);
    expect(map(SAMPLES.assistantFlushBeforeTool)).toEqual([]);
    expect(map(SAMPLES.assistantFinalFlush)).toEqual([]);
  });

  it("maps read/write/function tool_call started and completed", () => {
    expect(map(SAMPLES.toolStartedRead)).toEqual([
      expect.objectContaining({
        kind: "tool_use",
        id: "c1",
        name: "read",
        input: { path: "README.md" },
      }),
    ]);
    expect(map(SAMPLES.toolCompletedRead)).toEqual([
      expect.objectContaining({
        kind: "tool_result",
        id: "c1",
        name: "read",
      }),
    ]);
    expect(map(SAMPLES.toolStartedWrite)[0]).toMatchObject({
      kind: "tool_use",
      name: "write",
    });
    expect(map(SAMPLES.toolStartedFn)[0]).toMatchObject({
      kind: "tool_use",
      name: "Shell",
      input: { command: "ls" },
    });
  });

  it("maps result success and error", () => {
    expect(map(SAMPLES.resultSuccess)).toEqual([
      expect.objectContaining({
        kind: "result",
        isError: false,
        text: "Hello",
        durationMs: 1234,
        subtype: "success",
      }),
    ]);
    expect(map(SAMPLES.resultError)[0]).toMatchObject({ kind: "result", isError: true });
  });

  it("passes unknown types through", () => {
    expect(map(SAMPLES.unknown)).toEqual([
      expect.objectContaining({ kind: "unknown", rawType: "thinking" }),
    ]);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `bun test tests/cursor-adapter.test.ts`

Expected: FAIL (module / `createCursorMapper` missing)

- [ ] **Step 4: Implement raw schemas + mapper**

Create `src/types/raw-cursor.ts` with permissive zod schemas for:

- envelope: `{ type: string }` passthrough
- system init: `type=system`, `subtype=init`, `session_id`, optional `model`, `tools`
- assistant: `type=assistant`, optional `timestamp_ms`, `model_call_id`, `message.content[]`
- tool_call: `type=tool_call`, `subtype`, `call_id`, `tool_call` object with optional `readToolCall` / `writeToolCall` / `function`
- result: `type=result`, optional `subtype`, `is_error`, `result`, `duration_ms`, usage/cost fields if present

Create `src/agents/cursor.ts` exporting `createCursorMapper` implementing the mapping table from the design spec. Helper to extract tool name/input:

- `readToolCall` → name `"read"`, input = `args`
- `writeToolCall` → name `"write"`, input = `args`
- `function` → name = `function.name`; parse `arguments` JSON string into `input` when possible, else `{ arguments: raw }`

For assistant deltas: only emit when `"timestamp_ms" in obj && !("model_call_id" in obj)`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test tests/cursor-adapter.test.ts`

Expected: PASS for mapper describe block (argv tests may still be absent)

- [ ] **Step 6: Commit**

```bash
git add src/types/events.ts src/types/raw-cursor.ts src/agents/cursor.ts tests/cursor-adapter.test.ts
git commit -m "$(cat <<'EOF'
feat(agents): add Cursor NDJSON mapper

EOF
)"
```

---

### Task 2: Argv builder + CursorAgentAdapter

**Files:**
- Modify: `src/agents/cursor.ts`
- Modify: `tests/cursor-adapter.test.ts`

**Interfaces:**
- Consumes: `AgentAdapter`, `AgentRunOptions`, `runAgentProcess` from `./adapter`
- Produces: `resolveCursorModel(model: string, effort?: string): string`; `buildCursorRunArgs(opts: AgentRunOptions): string[]`; `class CursorAgentAdapter`; `CURSOR_MODELS`; `defaultModel = "composer-2.5"`; `supportsResume = true`

- [ ] **Step 1: Write failing argv / adapter tests**

Append to `tests/cursor-adapter.test.ts`:

```ts
import { buildCursorRunArgs, resolveCursorModel, CURSOR_MODELS } from "../src/agents/cursor";

describe("cursor argv", () => {
  it("includes print/stream-json/partial/force/trust/model and trailing prompt", () => {
    expect(
      buildCursorRunArgs({ prompt: "hello", model: "composer-2.5" }),
    ).toEqual([
      "--print",
      "--output-format",
      "stream-json",
      "--stream-partial-output",
      "--force",
      "--trust",
      "--model",
      "composer-2.5",
      "hello",
    ]);
  });

  it("adds --resume before extraArgs and prompt", () => {
    expect(
      buildCursorRunArgs({
        prompt: "more",
        model: "auto",
        resumeSessionId: "sess-9",
        extraArgs: ["--approve-mcps"],
      }),
    ).toEqual([
      "--print",
      "--output-format",
      "stream-json",
      "--stream-partial-output",
      "--force",
      "--trust",
      "--model",
      "auto",
      "--resume",
      "sess-9",
      "--approve-mcps",
      "more",
    ]);
  });

  it("appends [effort=…] unless model already has effort=", () => {
    expect(resolveCursorModel("composer-2.5", "high")).toBe("composer-2.5[effort=high]");
    expect(resolveCursorModel("claude-opus-4-8[effort=low]", "high")).toBe(
      "claude-opus-4-8[effort=low]",
    );
  });

  it("ships a static catalog including auto and composer-2.5", () => {
    const ids = CURSOR_MODELS.map((m) => m.id);
    expect(ids).toContain("auto");
    expect(ids).toContain("composer-2.5");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/cursor-adapter.test.ts`

Expected: FAIL on missing exports

- [ ] **Step 3: Implement argv + adapter**

In `src/agents/cursor.ts`:

```ts
export function resolveCursorModel(model: string, effort?: string): string {
  if (!effort) return model;
  if (/\[.*effort=/.test(model)) return model;
  return `${model}[effort=${effort}]`;
}

export function buildCursorRunArgs(opts: AgentRunOptions): string[] {
  return [
    "--print",
    "--output-format",
    "stream-json",
    "--stream-partial-output",
    "--force",
    "--trust",
    "--model",
    resolveCursorModel(opts.model, opts.effort),
    ...(opts.resumeSessionId ? ["--resume", opts.resumeSessionId] : []),
    ...(opts.extraArgs ?? []),
    opts.prompt,
  ];
}

export class CursorAgentAdapter implements AgentAdapter {
  readonly id: AgentId = "cursor";
  readonly binary: string;
  readonly defaultModel = "composer-2.5";
  readonly supportsResume = true;

  constructor(binary = "agent") {
    this.binary = binary;
  }

  run(opts: AgentRunOptions): AsyncIterable<AgentEvent> {
    return runAgentProcess({
      id: this.id,
      binary: this.binary,
      args: buildCursorRunArgs(opts),
      opts,
      map: createCursorMapper(opts.agentId ?? this.id),
      // prompt is on argv; do not pass stdin prompt
    });
  }
}
```

Static `CURSOR_MODELS` should include at least: `auto`, `composer-2.5`, `composer-2.5-fast`, `cursor-grok-4.5-high`, `claude-opus-4-8-thinking-high`, `claude-sonnet-5-high`, `gpt-5.5-high`, `gpt-5.2` (ids + display names matching `--list-models` where possible).

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/cursor-adapter.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agents/cursor.ts tests/cursor-adapter.test.ts
git commit -m "$(cat <<'EOF'
feat(agents): add CursorAgentAdapter and run argv

EOF
)"
```

---

### Task 3: Live model catalog

**Files:**
- Create: `src/agents/cursor-variants.ts`
- Create: `tests/cursor-variants.test.ts`

**Interfaces:**
- Consumes: `AgentModel` from `./agent-model`; `spawn` from `node:child_process`
- Produces: `parseCursorListModels(output: string): Map<string, { name: string }>`; `refreshCursorVariantCache(binary: string): Promise<boolean>`; `listCursorCachedAgentModels(): AgentModel[]`; `getCursorModelName(id: string): string | undefined`; `clearCursorVariantCacheForTests(): void`

- [ ] **Step 1: Write failing parser tests**

```ts
import { describe, expect, it } from "vitest";
import { parseCursorListModels } from "../src/agents/cursor-variants";

describe("parseCursorListModels", () => {
  it("parses id - name lines and skips the header", () => {
    const output = `Available models

auto - Auto (default)
composer-2.5 - Composer 2.5
cursor-grok-4.5-high - Cursor Grok 4.5
`;
    const map = parseCursorListModels(output);
    expect(map.get("auto")).toEqual({ name: "Auto (default)" });
    expect(map.get("composer-2.5")).toEqual({ name: "Composer 2.5" });
    expect(map.get("cursor-grok-4.5-high")).toEqual({ name: "Cursor Grok 4.5" });
  });

  it("returns empty map on garbage", () => {
    expect(parseCursorListModels("nope").size).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/cursor-variants.test.ts`

Expected: FAIL

- [ ] **Step 3: Implement cache module**

Mirror `codex-variants.ts` structure:

- TTL 1 hour
- `fetch` via `spawn(binary, ["--list-models"], …)` with 20s timeout, stdout capture
- `refreshCursorVariantCache` updates cache when parse yields ≥1 model
- `listCursorCachedAgentModels` returns `{ id, name }[]` from cache or `[]`

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/cursor-variants.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agents/cursor-variants.ts tests/cursor-variants.test.ts
git commit -m "$(cat <<'EOF'
feat(agents): add Cursor live model catalog parser

EOF
)"
```

---

### Task 4: Register provider across the app

**Files:**
- Modify: `src/agents/config.ts` — add `cursor` to provider list + `DEFAULT_AGENT_BINARY.cursor = "agent"`
- Modify: `src/agents/index.ts` — import/export/`createAdapter` case
- Modify: `src/agents/models.ts` — `AGENT_IDS`, `modelsForProvider`, `PROVIDER_ADAPTERS`, `effortsForModel`, `modelNameForAgent`, `refreshAgentCatalogCaches`
- Modify: `src/config/types.ts` — zod enum + binaries shape
- Modify: `src/doctor/doctor.ts` — install/auth hints
- Modify: `src/workflow/takeover.ts` — interactive resume
- Modify: `tests/doctor.test.ts`, `tests/models.test.ts`, `tests/agent-config.test.ts` as needed for new provider

**Interfaces:**
- Consumes: `CursorAgentAdapter`, `CURSOR_MODELS`, cursor-variants exports
- Produces: fully registered `cursor` provider end-to-end

Cursor efforts for UI:

```ts
case "cursor":
  return /\[.*effort=/.test(model) ? [] : ["low", "medium", "high", "xhigh"];
```

Doctor hints:

```ts
case "cursor":
  return "Install Cursor Agent CLI (curl https://cursor.com/install -fsS | bash) and ensure `agent` is on PATH.";
// auth:
  return "Run `agent login`, or set CURSOR_API_KEY.";
```

Takeover:

```ts
cursor: (sessionId) => ["--resume", sessionId],
```

`modelsForProvider("cursor")`: prefer live cache when non-empty, else `CURSOR_MODELS` (same pattern as codex).

`refreshAgentCatalogCaches`: after codex block, refresh cursor when doctor ok.

- [ ] **Step 1: Write / extend failing registration tests**

In `tests/models.test.ts` add:

```ts
describe("cursor models", () => {
  it("exposes cursor models with composer-2.5 as the default", () => {
    expect(modelIdsForAgent("cursor")).toContain("composer-2.5");
    expect(modelIdsForAgent("cursor")).toContain("auto");
    expect(defaultModelForAgent("cursor")).toBe("composer-2.5");
  });

  it("supports bracket efforts for cursor when model has no effort=", () => {
    expect(effortsForModel("cursor", "composer-2.5")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(effortsForModel("cursor", "composer-2.5[effort=high]")).toEqual([]);
  });
});
```

In `tests/doctor.test.ts` add a missing-binary case for cursor that expects install hint containing `cursor.com/install`.

In `tests/agent-config.test.ts`, extend any exhaustive provider lists to include `"cursor"`.

- [ ] **Step 2: Run targeted tests to verify failures**

Run: `bun test tests/models.test.ts tests/doctor.test.ts tests/agent-config.test.ts`

Expected: FAIL on cursor expectations / type incompleteness as you start wiring

- [ ] **Step 3: Wire all registration surfaces**

Update every exhaustive `AgentProviderId` switch/`Record` the compiler reports. Export cursor symbols from `src/agents/index.ts`. Ensure `createAdapter("cursor")` returns `new CursorAgentAdapter(binary)`.

- [ ] **Step 4: Run full verification**

Run:

```bash
bun test tests/cursor-adapter.test.ts tests/cursor-variants.test.ts tests/models.test.ts tests/doctor.test.ts tests/agent-config.test.ts
npm run typecheck
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agents src/config/types.ts src/doctor/doctor.ts src/workflow/takeover.ts tests
git commit -m "$(cat <<'EOF'
feat(agents): register cursor provider end-to-end

EOF
)"
```

---

### Task 5: Documentation

**Files:**
- Modify: `README.md` — mention `cursor` / `agent` alongside other CLIs
- Modify: `docs/agent-configuration.md` — valid providers list
- Modify: `docs/workflow-spec.md` — resume capability table (cursor supports resume like claude/opencode/codex)
- Modify: `AGENTS.md` only if it lists providers (add cursor)

- [ ] **Step 1: Update docs to include cursor**

Mirror existing bullet/table style. Resume docs should state cursor supports headless `--resume` and interactive takeover resume.

- [ ] **Step 2: Run lint/typecheck/tests**

Run:

```bash
npm run lint && npm run typecheck && npm test
```

Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add README.md docs AGENTS.md
git commit -m "$(cat <<'EOF'
docs: document cursor agent CLI provider

EOF
)"
```

---

## Spec coverage checklist

| Spec requirement | Task |
|---|---|
| Provider `cursor`, binary `agent` | 2, 4 |
| `--force` + `--trust` | 2 |
| stream-json + partial output | 2 |
| Effort → `[effort=…]` with skip-if-present | 2 |
| Prompt as trailing argv | 2 |
| Mapper table (init/delta/tools/result) | 1 |
| `supportsResume` + `--resume` | 2 |
| Interactive takeover resume | 4 |
| Static + live models | 2, 3, 4 |
| Doctor hints | 4 |
| Docs | 5 |
| Out of scope SDK / mode flags | honored (no tasks) |

## Self-review notes

- No TBD placeholders.
- `resolveCursorModel` / `buildCursorRunArgs` / `createCursorMapper` names consistent across tasks.
- Banner test fake instance named `"cursor"` remains a *instance* id with `provider: "claude"` — do not change that fixture unless it breaks; real provider `cursor` is separate.
`}