import { describe, expect, it } from "vitest";
import { defaultDraftModel, modelIdsForAgent } from "../src/agents";
import type { DoctorResult } from "../src/doctor";
import {
  autoDraftTarget,
  draftModelCompletions,
  healthyAgentSet,
  parseDraftModelRequest,
  resolveDraftTarget,
} from "../src/tui/draft-model";
import type { AgentInstanceId } from "../src/types/events";

function doctor(
  statuses: Partial<Record<AgentInstanceId, DoctorResult["status"]>>,
): DoctorResult[] {
  return (Object.keys(statuses) as AgentInstanceId[]).map((agent) => ({
    agent,
    provider: (["claude", "opencode", "codex", "amp"].includes(agent)
      ? agent
      : "opencode") as DoctorResult["provider"],
    status: statuses[agent]!,
    binary: agent,
    message: "",
  }));
}

/** A real model id for an agent, so tests don't hard-code catalog specifics. */
function aModelFor(agent: AgentInstanceId): string {
  const id = modelIdsForAgent(agent)[0];
  if (!id) throw new Error(`no models for ${agent}`);
  return id;
}

describe("healthyAgentSet", () => {
  it("collects only ok agents", () => {
    const set = healthyAgentSet(doctor({ opencode: "ok", claude: "not_authenticated" }));
    expect([...set]).toEqual(["opencode"]);
  });

  it("is empty before the doctor has run", () => {
    expect(healthyAgentSet(null).size).toBe(0);
  });
});

describe("autoDraftTarget", () => {
  it("prefers opencode when healthy", () => {
    const t = autoDraftTarget(new Set<AgentInstanceId>(["opencode", "claude"]));
    expect(t).toEqual({ agent: "opencode", model: defaultDraftModel("opencode") });
  });

  it("falls back to claude, then codex, in order", () => {
    expect(autoDraftTarget(new Set<AgentInstanceId>(["claude", "codex"]))?.agent).toBe("claude");
    expect(autoDraftTarget(new Set<AgentInstanceId>(["codex"]))?.agent).toBe("codex");
  });

  it("returns undefined when nothing is healthy", () => {
    expect(autoDraftTarget(new Set())).toBeUndefined();
  });
});

describe("resolveDraftTarget", () => {
  it("uses a valid, healthy override", () => {
    const model = aModelFor("claude");
    const res = resolveDraftTarget(new Set<AgentInstanceId>(["opencode", "claude"]), {
      agent: "claude",
      model,
    });
    expect(res).toEqual({ target: { agent: "claude", model }, usingOverride: true });
  });

  it("ignores an override whose agent is unhealthy and auto-picks instead", () => {
    const res = resolveDraftTarget(new Set<AgentInstanceId>(["opencode"]), {
      agent: "claude",
      model: aModelFor("claude"),
    });
    expect(res.usingOverride).toBe(false);
    expect(res.target?.agent).toBe("opencode");
  });

  it("ignores an override whose model is no longer valid", () => {
    const res = resolveDraftTarget(new Set<AgentInstanceId>(["claude"]), {
      agent: "claude",
      model: "ghost-model-that-does-not-exist",
    });
    expect(res.usingOverride).toBe(false);
    expect(res.target?.agent).toBe("claude");
  });

  it("returns no target when nothing is healthy", () => {
    expect(resolveDraftTarget(new Set(), null)).toEqual({
      target: undefined,
      usingOverride: false,
    });
  });
});

describe("parseDraftModelRequest", () => {
  const healthy = new Set<AgentInstanceId>(["opencode", "claude"]);

  it("shows on no args", () => {
    expect(parseDraftModelRequest([], healthy)).toEqual({ kind: "show" });
  });

  it("resets on auto/reset/default", () => {
    for (const word of ["auto", "RESET", "default"]) {
      expect(parseDraftModelRequest([word], healthy)).toEqual({ kind: "reset" });
    }
  });

  it("accepts a bare agent id as its default draft model", () => {
    expect(parseDraftModelRequest(["claude"], healthy)).toEqual({
      kind: "set",
      target: { agent: "claude", model: defaultDraftModel("claude") },
    });
  });

  it("accepts an explicit agent + model pair", () => {
    const model = aModelFor("claude");
    expect(parseDraftModelRequest(["claude", model], healthy)).toEqual({
      kind: "set",
      target: { agent: "claude", model },
    });
  });

  it("infers the owning agent from a bare model id", () => {
    const model = aModelFor("claude");
    expect(parseDraftModelRequest([model], healthy)).toEqual({
      kind: "set",
      target: { agent: "claude", model },
    });
  });

  it("rejects an unhealthy agent", () => {
    const res = parseDraftModelRequest(["codex"], healthy);
    expect(res.kind).toBe("error");
    expect(res.kind === "error" && res.message).toMatch(/codex isn't healthy/);
  });

  it("rejects an unknown model for an explicit agent", () => {
    const res = parseDraftModelRequest(["claude", "nope"], healthy);
    expect(res.kind).toBe("error");
    expect(res.kind === "error" && res.message).toMatch(/unknown model 'nope' for claude/);
  });

  it("explains when a model belongs to an unhealthy agent", () => {
    // codex is not in `healthy`, so its model can't be inferred — but the error
    // should name the owning agent rather than claim the model is unknown.
    const codexModel = aModelFor("codex");
    const res = parseDraftModelRequest([codexModel], healthy);
    expect(res.kind).toBe("error");
    expect(res.kind === "error" && res.message).toMatch(/belongs to codex/);
  });

  it("rejects a model no agent owns", () => {
    const res = parseDraftModelRequest(["totally-made-up"], healthy);
    expect(res.kind).toBe("error");
    expect(res.kind === "error" && res.message).toMatch(/unknown model 'totally-made-up'/);
  });
});

describe("draftModelCompletions", () => {
  it("offers auto plus healthy agents and their models", () => {
    const out = draftModelCompletions(new Set<AgentInstanceId>(["claude"]));
    expect(out).toContain("auto");
    expect(out).toContain("claude");
    expect(out).toContain(aModelFor("claude"));
    expect(out).not.toContain("codex");
  });
});
