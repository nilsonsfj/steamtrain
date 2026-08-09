import { describe, expect, it } from "vitest";
import { MIMO_MODELS } from "../src/agents/mimo";
import { OPENCODE_MODELS } from "../src/agents/opencode";
import { BUNDLED_WORKFLOWS } from "../src/workflow/bundled";
import { validateWorkflow } from "../src/workflow/types";
import type { WorkflowStep } from "../src/workflow/types";

/** Every (agent, model) pair an agent-backed step in a bundled workflow uses. */
function agentTargets(): { workflow: string; step: string; agent?: string; model: string }[] {
  const targets: { workflow: string; step: string; agent?: string; model: string }[] = [];
  for (const [workflow, spec] of Object.entries(BUNDLED_WORKFLOWS)) {
    for (const phase of spec.phases) {
      for (const step of phase.steps as WorkflowStep[]) {
        const agent = "agent" in step ? step.agent : undefined;
        const model = "model" in step ? step.model : undefined;
        if (model) targets.push({ workflow, step: step.id, agent, model });
      }
    }
  }
  return targets;
}

/**
 * `model: "{{inputs.<key>}}"` (building block 5 — templated model/effort)
 * can't be checked against the model literally; instead resolve it to the
 * workflow's own declared default for that input, which is what a keyless
 * `--param`-free run actually launches.
 */
function resolveTemplatedModel(spec: (typeof BUNDLED_WORKFLOWS)[string], model: string): string {
  const match = /^\{\{inputs\.([^}]+)\}\}$/.exec(model);
  if (!match) return model;
  const key = match[1] as string;
  const def = spec.inputs?.[key]?.default;
  return typeof def === "string" ? def : model;
}

const KNOWN_FREE_MODELS = new Set([
  ...OPENCODE_MODELS.map((m) => m.id),
  ...MIMO_MODELS.map((m) => m.id),
]);

describe("bundled workflows", () => {
  // Guards against the failure where bundled workflows referenced OpenCode free
  // models (qwen3.6-plus-free, minimax-m3-free) that OpenCode later removed,
  // so the steps died with "Model not found". A bundled opencode/mimo step must
  // name a model in our known catalogs (or template to a default that does).
  it("only reference known free-model catalog ids", () => {
    const unknown = agentTargets()
      .map((t) => ({
        ...t,
        resolved: resolveTemplatedModel(BUNDLED_WORKFLOWS[t.workflow]!, t.model),
      }))
      .filter((t) => {
        const provider =
          t.agent ??
          (t.resolved.startsWith("opencode/") || t.resolved.startsWith("opencode-go/")
            ? "opencode"
            : t.resolved.startsWith("mimo/") || t.resolved.startsWith("xiaomi/")
              ? "mimo"
              : undefined);
        return provider === "opencode" || provider === "mimo";
      })
      .filter((t) => !KNOWN_FREE_MODELS.has(t.resolved))
      .map((t) => `${t.workflow}/${t.step} → ${t.model} (resolved: ${t.resolved})`);
    expect(unknown).toEqual([]);
  });

  it("prefer OpenCode free models over DeepSeek free for babysit defaults", () => {
    for (const name of ["babysit-pr", "babysit-all-prs"]) {
      const def = BUNDLED_WORKFLOWS[name]!.inputs?.babysitterModel?.default;
      expect(def, name).toBe("opencode/mimo-v2.5-free");
      expect(BUNDLED_WORKFLOWS[name]!.inputs?.babysitterModel?.fallbackModels).not.toContain(
        "opencode/deepseek-v4-flash-free",
      );
      expect(BUNDLED_WORKFLOWS[name]!.inputs?.babysitterModel?.fallbackModels).not.toContain(
        "mimo/mimo-auto",
      );
    }
  });

  it("do not pin the first-class mimo agent as a bundled default", () => {
    for (const t of agentTargets()) {
      expect(t.agent, `${t.workflow}/${t.step}`).not.toBe("mimo");
      const resolved = resolveTemplatedModel(BUNDLED_WORKFLOWS[t.workflow]!, t.model);
      expect(resolved.startsWith("mimo/"), `${t.workflow}/${t.step} → ${resolved}`).toBe(false);
    }
  });

  it("give each parallel agent step in a phase a distinct model", () => {
    for (const [workflow, spec] of Object.entries(BUNDLED_WORKFLOWS)) {
      for (const phase of spec.phases) {
        const models = (phase.steps as WorkflowStep[])
          .filter((s): s is WorkflowStep & { model: string } => "model" in s && !!s.model)
          .map((s) => s.model);
        if (models.length < 2) continue;
        expect(new Set(models).size, `${workflow}/${phase.id} reuses a model in parallel`).toBe(
          models.length,
        );
      }
    }
  });

  // The `mainline`/`mainline-stream` `test`/`final-test` command steps embed
  // `{{inputs.testCmd}}` in `cmd` on purpose — running the user's declared
  // test command IS the step's job (mirrors `init`'s generated test-check
  // steps, which embed the same detected command as a literal; see the doc
  // comment above `mainlineStream` in bundled.ts). `babysit-pr` similarly
  // embeds PR/land inputs into `workflow pr …` command steps on purpose.
  // Every OTHER bundled workflow must validate with zero warnings.
  const EXPECTED_TESTCMD_WARNING =
    /is a command step(?: with allowShellTemplates)? whose cmd embeds template data \(\{\{inputs\.testCmd\}\}\)/;
  const EXPECTED_BABYSIT_WARNING =
    /is a command step whose cmd embeds template data \(\{\{inputs\.(pr|checksTimeoutSec|mergeStrategy)\}\}\)/;

  it("mainline and mainline-stream validate with only the declared testCmd warning", () => {
    for (const name of ["mainline", "mainline-stream"]) {
      const spec = BUNDLED_WORKFLOWS[name]!;
      const result = validateWorkflow(spec);
      expect(result.ok, `${name}: ${result.error ?? ""}`).toBe(true);
      expect(result.warnings, `${name} warnings`).toHaveLength(1);
      expect(result.warnings![0]).toMatch(EXPECTED_TESTCMD_WARNING);
    }
  });

  it("babysit-pr validates with only the declared land-command template warnings", () => {
    const spec = BUNDLED_WORKFLOWS["babysit-pr"]!;
    const result = validateWorkflow(spec);
    expect(result.ok, `babysit-pr: ${result.error ?? ""}`).toBe(true);
    // rebase + wait-or-merge + wait-only, each embedding {{inputs.pr}} & co.
    expect(result.warnings?.length, "babysit-pr warnings").toBe(3);
    for (const warning of result.warnings ?? []) {
      expect(warning).toMatch(EXPECTED_BABYSIT_WARNING);
    }
  });

  it("babysit-all-prs lists PRs with a deterministic gh command, not an agent", () => {
    const list = BUNDLED_WORKFLOWS["babysit-all-prs"]!.phases.flatMap((p) => p.steps).find(
      (s) => s.id === "list-prs",
    );
    expect(list, "list-prs step missing").toBeDefined();
    expect(list?.kind).toBe("command");
    expect(list && "cmd" in list ? list.cmd : "").toContain("gh pr list");
  });

  it("babysit-all-prs and remaining bundled workflows validate cleanly", () => {
    // tour / mainline* / babysit-pr intentionally embed templates in command
    // cmds (flagged by lintTemplateRefs). Everything else must stay clean.
    const expectedWarnings = new Set(["tour", "mainline", "mainline-stream", "babysit-pr"]);
    for (const [name, spec] of Object.entries(BUNDLED_WORKFLOWS)) {
      if (expectedWarnings.has(name)) continue;
      const result = validateWorkflow(spec);
      expect(result.ok, `${name}: ${result.error ?? ""}`).toBe(true);
      expect(result.warnings ?? [], `${name} warnings`).toEqual([]);
    }
  });

  it("declare model-typed inputs with catalog fallbackModels", () => {
    for (const name of [
      "mainline",
      "mainline-stream",
      "babysit-pr",
      "babysit-all-prs",
      "code-review",
    ]) {
      const spec = BUNDLED_WORKFLOWS[name]!;
      const modelInputs = Object.entries(spec.inputs ?? {}).filter(
        ([, inp]) => inp.type === "model",
      );
      expect(modelInputs.length, `${name} should declare model inputs`).toBeGreaterThan(0);
      for (const [key, inp] of modelInputs) {
        expect(inp.fallbackModels?.length, `${name}.${key} fallbackModels`).toBeGreaterThan(0);
        for (const fb of inp.fallbackModels ?? []) {
          expect(KNOWN_FREE_MODELS.has(fb), `${name}.${key} fallback ${fb}`).toBe(true);
        }
        if (typeof inp.default === "string") {
          expect(KNOWN_FREE_MODELS.has(inp.default), `${name}.${key} default ${inp.default}`).toBe(
            true,
          );
        }
      }
    }
  });
});
