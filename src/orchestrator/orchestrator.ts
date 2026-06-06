import { type AgentAdapter, createAdapter } from "../agents";
import type { SteamtrainConfig } from "../config";
import type { DoctorResult } from "../doctor";
import type { AgentEvent, AgentId } from "../types/events";
import {
  BUNDLED_WORKFLOWS,
  type StepResult,
  type WorkflowEvent,
  type WorkflowSpec,
  isAgentBackedStep,
  runWorkflow,
  validateWorkflow,
} from "../workflow";
import type { WorkspaceConfig, WorkspaceEntry, WorkspaceId } from "../workspace";
import { workspaceById } from "../workspace";

const DEFAULT_MAX_CONCURRENCY = 3;

export interface ResolvedWorkspace {
  id: WorkspaceId;
  entry: WorkspaceEntry;
  adapter: AgentAdapter;
  health?: DoctorResult;
}

export interface DispatchCheck {
  ok: boolean;
  reason?: string;
}

/**
 * Routes workspace dispatches to the right adapter + model, gates on doctor
 * health, and streams normalized events for a run.
 */
export class Orchestrator {
  private readonly workspaceMap: Map<WorkspaceId, WorkspaceEntry>;

  constructor(
    private readonly config: SteamtrainConfig,
    workspaces: WorkspaceConfig,
    private doctor: DoctorResult[],
  ) {
    this.workspaceMap = workspaceById(workspaces);
  }

  setDoctor(results: DoctorResult[]): void {
    this.doctor = results;
  }

  resolve(id: WorkspaceId): ResolvedWorkspace {
    const entry = this.workspaceMap.get(id);
    if (!entry) throw new Error(`unknown workspace '${id}'`);
    const adapter = createAdapter(entry.agent, this.config.binaries?.[entry.agent]);
    const health = this.doctor.find((d) => d.agent === entry.agent);
    return { id, entry, adapter, health };
  }

  /** Whether a workspace may be dispatched given current agent health. */
  canDispatch(id: WorkspaceId): DispatchCheck {
    const entry = this.workspaceMap.get(id);
    if (!entry) return { ok: false, reason: `unknown workspace '${id}'` };

    const health = this.doctor.find((d) => d.agent === entry.agent);
    if (!health) {
      return { ok: false, reason: `${entry.agent}: health unknown (doctor has not run yet)` };
    }
    if (health.status !== "ok") {
      const detail = health.detail ?? health.message;
      return {
        ok: false,
        reason: `${entry.agent} is ${health.status} — ${detail}`,
      };
    }
    return { ok: true };
  }

  /** Stream normalized events for a workspace dispatch. */
  run(id: WorkspaceId, prompt: string, signal?: AbortSignal): AsyncIterable<AgentEvent> {
    const { adapter, entry } = this.resolve(id);
    return adapter.run({
      prompt,
      model: entry.model,
      cwd: process.cwd(),
      timeoutMs: this.config.timeoutMs,
      signal,
    });
  }

  // --- Workflows -----------------------------------------------------------

  /** All available workflows: the bundled ones plus any from steamtrain.json. */
  listWorkflows(): Record<string, WorkflowSpec> {
    return { ...BUNDLED_WORKFLOWS, ...this.config.workflows };
  }

  /**
   * Whether a workflow may be dispatched: it must exist, validate, and every
   * distinct agent it uses must be doctor-healthy.
   */
  canDispatchWorkflow(name: string): DispatchCheck {
    const spec = this.listWorkflows()[name];
    if (!spec) return { ok: false, reason: `unknown workflow '${name}'` };

    const valid = validateWorkflow(spec);
    if (!valid.ok) return { ok: false, reason: `invalid workflow '${name}': ${valid.error}` };

    for (const agent of workflowAgents(spec)) {
      const health = this.doctor.find((d) => d.agent === agent);
      if (!health) {
        return { ok: false, reason: `${agent}: health unknown (doctor has not run yet)` };
      }
      if (health.status !== "ok") {
        const detail = health.detail ?? health.message;
        return { ok: false, reason: `${agent} is ${health.status} — ${detail}` };
      }
    }
    return { ok: true };
  }

  /**
   * Stream workflow events for a run. Pass a shared `cache` across runs to
   * resume completed steps after a cancel (in-session resume).
   */
  runWorkflow(
    name: string,
    input: string,
    signal?: AbortSignal,
    cache?: Map<string, StepResult>,
    cwd: string = process.cwd(),
  ): AsyncIterable<WorkflowEvent> {
    const spec = this.listWorkflows()[name];
    if (!spec) throw new Error(`unknown workflow '${name}'`);

    return runWorkflow(
      spec,
      { input, cache },
      {
        createAdapter,
        binaries: this.config.binaries,
        timeoutMs: this.config.timeoutMs,
        maxConcurrency: this.config.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY,
        cwd,
      },
      signal,
    );
  }
}

/** Distinct agent ids used by a workflow's steps. */
function workflowAgents(spec: WorkflowSpec): AgentId[] {
  const set = new Set<AgentId>();
  for (const phase of spec.phases) {
    for (const step of phase.steps) {
      if (isAgentBackedStep(step)) set.add(step.agent);
    }
  }
  return [...set];
}
