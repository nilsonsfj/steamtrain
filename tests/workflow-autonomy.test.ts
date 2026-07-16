import { describe, expect, it } from "vitest";
import {
  type WorkflowSpec,
  autonomyBadge,
  autonomyDescription,
  autonomyLabel,
  workflowAutonomy,
} from "../src/workflow";

const agentStep = (id: string) => ({ id, agent: "claude", model: "opus", prompt: "x" });

function spec(steps: WorkflowSpec["phases"][number]["steps"]): WorkflowSpec {
  return { name: "w", phases: [{ id: "p", title: "P", steps }] };
}

describe("workflowAutonomy", () => {
  it("classifies plain agent/command workflows as autonomous", () => {
    expect(workflowAutonomy(spec([agentStep("a")]))).toBe("autonomous");
    expect(workflowAutonomy(spec([{ id: "c", kind: "command", cmd: "npm test" }]))).toBe(
      "autonomous",
    );
  });

  it("classifies approval steps and human gates as approvals", () => {
    expect(
      workflowAutonomy({
        name: "w",
        phases: [
          { id: "p1", title: "A", steps: [agentStep("a")] },
          { id: "p2", title: "B", steps: [{ id: "ok", kind: "approval", step: "a" }] },
        ],
      }),
    ).toBe("approvals");
    expect(
      workflowAutonomy({
        name: "w",
        phases: [
          { id: "p1", title: "A", steps: [agentStep("a")] },
          {
            id: "p2",
            title: "B",
            steps: [{ id: "g", kind: "gate", condition: { human: true } }],
          },
        ],
      }),
    ).toBe("approvals");
  });

  it("classifies human steps and canAsk steps as interactive (dominating approvals)", () => {
    expect(workflowAutonomy(spec([{ id: "h", kind: "human", prompt: "?" }]))).toBe("interactive");
    expect(workflowAutonomy(spec([{ ...agentStep("a"), canAsk: true }]))).toBe("interactive");
    expect(
      workflowAutonomy({
        name: "w",
        phases: [
          { id: "p1", title: "A", steps: [{ id: "h", kind: "human", prompt: "?" }] },
          { id: "p2", title: "B", steps: [{ id: "ok", kind: "approval" }] },
        ],
      }),
    ).toBe("interactive");
  });

  it("resolves sub-workflows and guards against cycles", () => {
    const child: WorkflowSpec = spec([{ id: "ok", kind: "approval" }]);
    const parent: WorkflowSpec = spec([{ id: "call", kind: "workflow", workflow: "child" }]);
    expect(workflowAutonomy(parent, (name) => (name === "child" ? child : undefined))).toBe(
      "approvals",
    );
    // Unresolvable child contributes nothing.
    expect(workflowAutonomy(parent, () => undefined)).toBe("autonomous");
    // A cycle (A calls B calls A) terminates.
    const a: WorkflowSpec = {
      name: "a",
      phases: [{ id: "p", title: "P", steps: [{ id: "x", kind: "workflow", workflow: "b" }] }],
    };
    const b: WorkflowSpec = {
      name: "b",
      phases: [{ id: "p", title: "P", steps: [{ id: "y", kind: "workflow", workflow: "a" }] }],
    };
    expect(workflowAutonomy(a, (name) => (name === "b" ? b : a))).toBe("autonomous");
  });

  it("labels and badges are the exact strings every surface renders", () => {
    expect(autonomyLabel("autonomous")).toBe("fully autonomous");
    expect(autonomyLabel("approvals")).toBe("needs approvals");
    expect(autonomyLabel("interactive")).toBe("needs human input");
    expect(autonomyBadge("autonomous")).toBe("▸ autonomous");
    expect(autonomyBadge("approvals")).toBe("✋ approvals");
    expect(autonomyBadge("interactive")).toBe("✎ interactive");
    for (const level of ["autonomous", "approvals", "interactive"] as const) {
      expect(autonomyDescription(level).length).toBeGreaterThan(20);
    }
  });
});
