import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createAdapter } from "../src/agents";
import { DEFAULT_AGENT_BINARY } from "../src/agents/config";
import { resolveBinary } from "../src/doctor/doctor";
import type { AgentEvent, AgentProviderId } from "../src/types/events";

/**
 * Live integration against a real agent CLI.
 *
 * Adapter unit tests replay captured JSON; engine tests inject fake binaries.
 * Neither notices when a provider changes stream flags or NDJSON shape. This
 * file is the missing signal: spawn the cheapest real agent, parse live
 * output, and assert a successful result.
 *
 * Gated so the default suite stays green without agent credentials:
 *   STEAMTRAIN_AGENT_SMOKE=1 bun test tests/agent-cli-smoke.test.ts
 *
 * Optional overrides:
 *   STEAMTRAIN_SMOKE_AGENT   provider id (default: claude)
 *   STEAMTRAIN_SMOKE_MODEL   model id (default: haiku for claude)
 *   STEAMTRAIN_SMOKE_TIMEOUT_MS  wall-clock budget (default: 120000)
 */

const ENABLED = process.env.STEAMTRAIN_AGENT_SMOKE === "1";
const AGENT = (process.env.STEAMTRAIN_SMOKE_AGENT ?? "claude") as AgentProviderId;
const DEFAULT_MODEL: Record<string, string> = {
  claude: "haiku",
  opencode: "opencode/north-mini-code-free",
  codex: "gpt-5-mini",
  cursor: "composer-2",
};
const MODEL = process.env.STEAMTRAIN_SMOKE_MODEL ?? DEFAULT_MODEL[AGENT] ?? "haiku";
const TIMEOUT_MS = Number(process.env.STEAMTRAIN_SMOKE_TIMEOUT_MS ?? 120_000);

const scratch: string[] = [];

afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!ENABLED)("real agent CLI smoke", () => {
  it(
    `runs ${AGENT}/${MODEL} and gets a successful result`,
    async () => {
      const binaryName = DEFAULT_AGENT_BINARY[AGENT];
      expect(binaryName, `unknown smoke agent '${AGENT}'`).toBeTruthy();
      const binary = await resolveBinary(binaryName);
      if (!binary) {
        throw new Error(
          `STEAMTRAIN_AGENT_SMOKE=1 but '${binaryName}' is not on PATH. Install the CLI or set STEAMTRAIN_SMOKE_AGENT to one that is.`,
        );
      }

      const cwd = mkdtempSync(join(tmpdir(), "steamtrain-agent-smoke-"));
      scratch.push(cwd);

      const adapter = createAdapter(AGENT, binary);
      const events: AgentEvent[] = [];
      for await (const event of adapter.run({
        prompt: "Reply with exactly: hi. Do not use tools.",
        model: MODEL,
        cwd,
        timeoutMs: TIMEOUT_MS,
        // Idle hung-agent detection is useful in the field; keep the smoke
        // short so a silent auth prompt fails fast instead of eating the
        // wall-clock budget.
        idleTimeoutMs: Math.min(60_000, TIMEOUT_MS),
      })) {
        events.push(event);
      }

      const errors = events.filter((e) => e.kind === "error");
      const results = events.filter((e) => e.kind === "result");
      expect(errors, `agent errors: ${JSON.stringify(errors)}`).toEqual([]);
      expect(results.length, "expected at least one result event").toBeGreaterThan(0);
      expect(
        results.every((e) => e.kind === "result" && !e.isError),
        `result marked isError: ${JSON.stringify(results)}`,
      ).toBe(true);
      const text = results
        .map((e) => (e.kind === "result" ? (e.text ?? "") : ""))
        .join("\n")
        .toLowerCase();
      expect(text).toContain("hi");
    },
    TIMEOUT_MS + 15_000,
  );
});
