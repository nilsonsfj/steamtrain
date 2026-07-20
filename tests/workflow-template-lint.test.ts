import { describe, expect, it } from "vitest";
import { lintTemplateRefs } from "../src/workflow/template";
import { validateWorkflow } from "../src/workflow/types";
import type { WorkflowSpec, WorkflowStep } from "../src/workflow/types";

function spec(phases: WorkflowSpec["phases"], inputs?: WorkflowSpec["inputs"]): WorkflowSpec {
  return { name: "test-wf", phases, inputs };
}

function phase(
  id: string,
  steps: WorkflowSpec["phases"][number]["steps"],
): WorkflowSpec["phases"][number] {
  return { id, title: id, steps };
}

function worker(id: string, extra: Record<string, unknown> = {}): WorkflowStep {
  return {
    id,
    agent: "claude",
    model: "sonnet",
    prompt: "...",
    ...extra,
  } as unknown as WorkflowStep;
}

function distributor(id: string, extra: Record<string, unknown> = {}): WorkflowStep {
  return { id, kind: "distributor", items: ["a", "b"], ...extra } as unknown as WorkflowStep;
}

function gate(id: string, extra: Record<string, unknown> = {}): WorkflowStep {
  return {
    id,
    kind: "gate",
    condition: { step: "a", ok: true },
    ...extra,
  } as unknown as WorkflowStep;
}

function command(id: string, extra: Record<string, unknown> = {}): WorkflowStep {
  return { id, kind: "command", cmd: "echo hello", ...extra } as unknown as WorkflowStep;
}

function mergeStep(id: string, extra: Record<string, unknown> = {}): WorkflowStep {
  return { id, kind: "merge", from: ["a"], mode: "apply", ...extra } as unknown as WorkflowStep;
}

function workflowStep(id: string, extra: Record<string, unknown> = {}): WorkflowStep {
  return { id, kind: "workflow", workflow: "child-wf", ...extra } as unknown as WorkflowStep;
}

describe("lintTemplateRefs", () => {
  describe("clean specs produce no warnings", () => {
    it("returns empty for a spec with no template references", () => {
      const s = spec([phase("p1", [worker("a"), worker("b")])]);
      expect(lintTemplateRefs(s)).toEqual([]);
    });

    it("returns empty for valid step references", () => {
      const s = spec([
        phase("p1", [worker("a")]),
        phase("p2", [worker("b", { prompt: "use {{steps.a.output}}" })]),
      ]);
      expect(lintTemplateRefs(s)).toEqual([]);
    });

    it("returns empty for valid input references", () => {
      const s = spec([phase("p1", [worker("a", { prompt: "repo: {{inputs.repo}}" })])], {
        repo: { type: "string" },
      });
      expect(lintTemplateRefs(s)).toEqual([]);
    });

    it("returns empty for generic mustache placeholders", () => {
      const s = spec([phase("p1", [worker("a", { prompt: "hello {{name}} and {{value}}" })])]);
      expect(lintTemplateRefs(s)).toEqual([]);
    });
  });

  describe("unknown step id", () => {
    it("warns when referencing a nonexistent step in output", () => {
      const s = spec([phase("p1", [worker("a", { prompt: "{{steps.typo.output}}" })])]);
      const warnings = lintTemplateRefs(s);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("unknown step 'typo'");
    });

    it("warns when referencing a nonexistent step in ok/error", () => {
      const s = spec([phase("p1", [worker("a", { prompt: "{{steps.missing.ok}}" })])]);
      expect(lintTemplateRefs(s)[0]).toContain("unknown step 'missing'");
    });

    it("warns when referencing a nonexistent step in worktree", () => {
      const s = spec([phase("p1", [worker("a", { prompt: "{{steps.no.worktree.root}}" })])]);
      expect(lintTemplateRefs(s)[0]).toContain("unknown step 'no'");
    });

    it("warns when referencing a nonexistent step in json", () => {
      const s = spec([phase("p1", [worker("a", { prompt: "{{steps.no.json.verdict}}" })])]);
      expect(lintTemplateRefs(s)[0]).toContain("unknown step 'no'");
    });

    it("warns when referencing a nonexistent step in artifacts", () => {
      const s = spec([phase("p1", [worker("a", { prompt: "{{steps.no.artifacts.report}}" })])]);
      expect(lintTemplateRefs(s)[0]).toContain("unknown step 'no'");
    });
  });

  describe("invalid step field", () => {
    it("warns on a misspelled step field", () => {
      const s = spec([
        phase("p1", [worker("a")]),
        phase("p2", [worker("b", { prompt: "{{steps.a.outpt}}" })]),
      ]);
      const warnings = lintTemplateRefs(s);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("invalid template reference '{{steps.a.outpt}}'");
    });

    it("warns on a completely invalid field name", () => {
      const s = spec([
        phase("p1", [worker("a")]),
        phase("p2", [worker("b", { prompt: "{{steps.a.nonsense}}" })]),
      ]);
      expect(lintTemplateRefs(s)[0]).toContain("invalid template reference");
    });
  });

  describe("undeclared input", () => {
    it("warns when referencing an undeclared input", () => {
      const s = spec([phase("p1", [worker("a", { prompt: "{{inputs.version}}" })])]);
      const warnings = lintTemplateRefs(s);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("undeclared input 'version'");
      expect(warnings[0]).toContain("available: none");
    });

    it("lists available inputs in the warning", () => {
      const s = spec([phase("p1", [worker("a", { prompt: "{{inputs.missing}}" })])], {
        repo: { type: "string" },
        branch: { type: "string" },
      });
      const warnings = lintTemplateRefs(s);
      expect(warnings[0]).toContain("available: repo, branch");
    });

    it("does not warn for declared inputs", () => {
      const s = spec([phase("p1", [worker("a", { prompt: "{{inputs.repo}}" })])], {
        repo: { type: "string" },
      });
      expect(lintTemplateRefs(s)).toEqual([]);
    });
  });

  describe("item outside forEach", () => {
    it("warns when {{item}} is used outside a forEach step", () => {
      const s = spec([phase("p1", [worker("a", { prompt: "{{item}}" })])]);
      const warnings = lintTemplateRefs(s);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("not a forEach child");
    });

    it("warns when {{item.value}} is used outside forEach", () => {
      const s = spec([phase("p1", [worker("a", { prompt: "{{item.value}}" })])]);
      expect(lintTemplateRefs(s)[0]).toContain("not a forEach child");
    });

    it("warns when {{item.index}} is used outside forEach", () => {
      const s = spec([phase("p1", [worker("a", { prompt: "{{item.index}}" })])]);
      expect(lintTemplateRefs(s)[0]).toContain("not a forEach child");
    });

    it("does not warn for {{item}} inside a forEach step", () => {
      const s = spec([
        phase("p1", [distributor("split")]),
        phase("p2", [worker("a", { prompt: "{{item}}", forEach: "steps.split.items" })]),
      ]);
      expect(lintTemplateRefs(s)).toEqual([]);
    });
  });

  describe("iteration outside loop", () => {
    it("warns when {{iteration}} is used outside a loop region", () => {
      const s = spec([phase("p1", [worker("a", { prompt: "{{iteration}}" })])]);
      const warnings = lintTemplateRefs(s);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("not inside a loop region");
    });

    it("does not warn for {{iteration}} inside a loop gate's region", () => {
      const s = spec([
        phase("p1", [worker("a", { prompt: "{{iteration}}" })]),
        phase("p2", [gate("loop", { loopTo: "p1", condition: { contains: "done" } })]),
      ]);
      expect(lintTemplateRefs(s)).toEqual([]);
    });

    it("does not warn for {{iteration}} in intermediate phases of a loop region", () => {
      const s = spec([
        phase("p1", [worker("a", { prompt: "{{iteration}}" })]),
        phase("p2", [worker("b", { prompt: "{{iteration}}" })]),
        phase("p3", [gate("loop", { loopTo: "p1", condition: { contains: "done" } })]),
      ]);
      expect(lintTemplateRefs(s)).toEqual([]);
    });

    it("warns for forEach child using {{iteration}} with forEach-specific message", () => {
      const s = spec([
        phase("p1", [distributor("split")]),
        phase("p2", [
          worker("a", { prompt: "{{item}} {{iteration}}", forEach: "steps.split.items" }),
        ]),
      ]);
      const warnings = lintTemplateRefs(s);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("forEach children don't have loop iteration context");
    });
  });

  describe("exitCode on non-command step", () => {
    it("warns when referencing exitCode on a worker step", () => {
      const s = spec([
        phase("p1", [worker("a")]),
        phase("p2", [worker("b", { prompt: "{{steps.a.exitCode}}" })]),
      ]);
      const warnings = lintTemplateRefs(s);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("not a command step");
    });

    it("does not warn for exitCode on a command step", () => {
      const s = spec([
        phase("p1", [command("test", { cmd: "npm test" })]),
        phase("p2", [worker("b", { prompt: "code: {{steps.test.exitCode}}" })]),
      ]);
      expect(lintTemplateRefs(s)).toEqual([]);
    });
  });

  describe("worktree on step without workspace", () => {
    it("warns when referencing worktree on a distributor step", () => {
      const s = spec([
        phase("p1", [distributor("split")]),
        phase("p2", [worker("a", { prompt: "{{steps.split.worktree.root}}" })]),
      ]);
      const warnings = lintTemplateRefs(s);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("does not have workspace isolation");
    });

    it("does not warn for worktree on a worker step (has workspace)", () => {
      const s = spec([
        phase("p1", [worker("impl", { prompt: "work" })]),
        phase("p2", [worker("a", { prompt: "{{steps.impl.worktree.root}}" })]),
      ]);
      expect(lintTemplateRefs(s)).toEqual([]);
    });

    it("does not warn for worktree on a command step (has workspace)", () => {
      const s = spec([
        phase("p1", [command("build", { cmd: "make" })]),
        phase("p2", [worker("a", { prompt: "{{steps.build.worktree.cwd}}" })]),
      ]);
      expect(lintTemplateRefs(s)).toEqual([]);
    });
  });

  describe("artifacts on step without artifacts", () => {
    it("warns when referencing artifacts on a step with no declared artifacts", () => {
      const s = spec([
        phase("p1", [worker("a")]),
        phase("p2", [worker("b", { prompt: "{{steps.a.artifacts.report}}" })]),
      ]);
      const warnings = lintTemplateRefs(s);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("has no declared artifacts");
    });

    it("does not warn for artifacts on a step with declared artifacts", () => {
      const s = spec([
        phase("p1", [worker("a", { artifacts: ["report.md"] })]),
        phase("p2", [worker("b", { prompt: "{{steps.a.artifacts.report}}" })]),
      ]);
      expect(lintTemplateRefs(s)).toEqual([]);
    });
  });

  describe("scans all template-containing fields", () => {
    it("scans gate condition contains", () => {
      const s = spec([
        phase("p1", [worker("a")]),
        phase("p2", [gate("g", { condition: { step: "a", contains: "{{steps.typo.output}}" } })]),
      ]);
      expect(lintTemplateRefs(s)[0]).toContain("unknown step 'typo'");
    });

    it("scans gate condition equals", () => {
      const s = spec([
        phase("p1", [worker("a")]),
        phase("p2", [gate("g", { condition: { step: "a", equals: "{{steps.miss.ok}}" } })]),
      ]);
      expect(lintTemplateRefs(s)[0]).toContain("unknown step 'miss'");
    });

    it("scans gate condition matches", () => {
      const s = spec([
        phase("p1", [worker("a")]),
        phase("p2", [gate("g", { condition: { step: "a", matches: "{{steps.nope.output}}" } })]),
      ]);
      expect(lintTemplateRefs(s)[0]).toContain("unknown step 'nope'");
    });

    it("scans when condition contains", () => {
      const s = spec([
        phase("p1", [worker("a")]),
        phase("p2", [worker("b", { when: { step: "a", contains: "{{steps.missing.output}}" } })]),
      ]);
      expect(lintTemplateRefs(s)[0]).toContain("unknown step 'missing'");
    });

    it("scans distributor items", () => {
      const s = spec([
        phase("p1", [distributor("split", { items: ["{{steps.x.output}}", "static"] })]),
      ]);
      expect(lintTemplateRefs(s)[0]).toContain("unknown step 'x'");
    });

    it("scans merge step fields", () => {
      const s = spec([
        phase("p1", [worker("a")]),
        phase("p2", [mergeStep("m", { branch: "{{steps.typo.output}}" })]),
      ]);
      expect(lintTemplateRefs(s)[0]).toContain("unknown step 'typo'");
    });

    it("scans merge commitMessage", () => {
      const s = spec([
        phase("p1", [worker("a")]),
        phase("p2", [mergeStep("m", { commitMessage: "{{steps.no.output}}" })]),
      ]);
      expect(lintTemplateRefs(s)[0]).toContain("unknown step 'no'");
    });

    it("scans command cmd", () => {
      const s = spec([phase("p1", [command("c", { cmd: "echo {{steps.x.output}}" })])]);
      expect(lintTemplateRefs(s)[0]).toContain("unknown step 'x'");
    });

    it("scans workflow input template", () => {
      const s = spec([phase("p1", [workflowStep("w", { input: "{{steps.x.output}}" })])]);
      expect(lintTemplateRefs(s)[0]).toContain("unknown step 'x'");
    });
  });

  describe("multiple warnings", () => {
    it("collects all warnings from a single step", () => {
      const s = spec([
        phase("p1", [worker("a", { prompt: "{{steps.x.output}} {{steps.y.ok}} {{inputs.miss}}" })]),
      ]);
      const warnings = lintTemplateRefs(s);
      expect(warnings.length).toBeGreaterThanOrEqual(3);
    });

    it("collects warnings across multiple steps", () => {
      const s = spec([
        phase("p1", [
          worker("a", { prompt: "{{steps.missing.output}}" }),
          worker("b", { prompt: "{{inputs.no}}" }),
        ]),
      ]);
      const warnings = lintTemplateRefs(s);
      expect(warnings).toHaveLength(2);
    });
  });

  describe("integration with validateWorkflow", () => {
    it("includes template warnings in ValidationResult", () => {
      const s = spec([phase("p1", [worker("a", { prompt: "{{steps.typo.output}}" })])]);
      const result = validateWorkflow(s);
      expect(result.ok).toBe(true);
      expect(result.warnings).toBeDefined();
      expect(result.warnings!.length).toBe(1);
      expect(result.warnings![0]).toContain("unknown step 'typo'");
    });

    it("returns no warnings field when template refs are clean", () => {
      const s = spec([phase("p1", [worker("a", { prompt: "{{input}}" })])]);
      const result = validateWorkflow(s);
      expect(result.ok).toBe(true);
      expect(result.warnings).toBeUndefined();
    });

    it("still returns errors for invalid specs (warnings are for ok specs only)", () => {
      // Invalid: dependsOn references same phase
      const s = spec([phase("p1", [worker("a"), worker("b", { dependsOn: ["a"] })])]);
      const result = validateWorkflow(s);
      expect(result.ok).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe("edge cases", () => {
    it("ignores non-steamtrain placeholders", () => {
      const s = spec([
        phase("p1", [worker("a", { prompt: "hello {{name}} {{#block}} {{/block}}" })]),
      ]);
      expect(lintTemplateRefs(s)).toEqual([]);
    });

    it("handles nested braces gracefully", () => {
      const s = spec([
        phase("p1", [
          worker("a", { prompt: "{{steps.a.output}} and {{steps.a.json.nested.deep}}" }),
        ]),
      ]);
      expect(lintTemplateRefs(s)).toEqual([]);
    });

    it("handles empty prompt", () => {
      const s = spec([phase("p1", [worker("a", { prompt: "" })])]);
      expect(lintTemplateRefs(s)).toEqual([]);
    });

    it("handles undefined prompt gracefully", () => {
      const s = spec([
        phase("p1", [
          {
            id: "a",
            kind: "gate" as const,
            condition: { ok: true },
          } as unknown as WorkflowSpec["phases"][number]["steps"][number],
        ]),
      ]);
      expect(lintTemplateRefs(s)).toEqual([]);
    });

    it("handles steps with namespaced ids (sub-workflows)", () => {
      const s = spec([
        phase("p1", [workflowStep("w")]),
        phase("p2", [worker("a", { prompt: "{{steps.w::child.output}}" })]),
      ]);
      // "w::child" doesn't match any step id (the step is "w"), but the
      // pattern extracts "w::child" which is not in stepIds.
      const warnings = lintTemplateRefs(s);
      expect(warnings.length).toBeGreaterThanOrEqual(1);
    });

    it("handles forEach shorthand (id.items)", () => {
      // forEach shorthand: "split.items" instead of "steps.split.items"
      const s = spec([
        phase("p1", [distributor("split")]),
        phase("p2", [worker("a", { prompt: "{{item}}", forEach: "split.items" })]),
      ]);
      expect(lintTemplateRefs(s)).toEqual([]);
    });
  });

  describe("command step shell-template warnings", () => {
    it("warns when a command cmd embeds workflow input or step output", () => {
      const s = spec([
        phase("p1", [worker("a")]),
        phase("p2", [command("run", { cmd: "echo {{input}} && cat {{steps.a.output}}" })]),
      ]);
      const warnings = lintTemplateRefs(s);
      expect(warnings.some((w) => w.includes("interpolated into the shell unsanitized"))).toBe(
        true,
      );
    });

    it("warns when a command cmd embeds only {{input}}", () => {
      const s = spec([phase("p1", [command("run", { cmd: "echo {{input}}" })])]);
      const warnings = lintTemplateRefs(s);
      expect(warnings).toEqual([expect.stringContaining("{{input}}")]);
      expect(warnings[0]).toContain("interpolated into the shell unsanitized");
    });

    it("warns when a command cmd embeds {{args}} (input alias)", () => {
      const s = spec([phase("p1", [command("run", { cmd: "echo {{args}}" })])]);
      const warnings = lintTemplateRefs(s);
      expect(warnings).toEqual([expect.stringContaining("{{args}}")]);
    });

    it("does not warn for a static command", () => {
      const s = spec([phase("p1", [command("run", { cmd: "npm test" })])]);
      expect(lintTemplateRefs(s)).toEqual([]);
    });
  });
});
