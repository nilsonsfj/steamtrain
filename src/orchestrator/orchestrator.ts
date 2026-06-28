import { type AgentAdapter, createAdapter } from "../agents";
import type { SteamtrainConfig } from "../config";
import type { DoctorResult } from "../doctor";
import type { AgentEvent, AgentId } from "../types/events";
import {
  type LoadedWorkflowCatalog,
  type StepResult,
  type WorkflowEvent,
  type WorkflowSourceKind,
  type WorkflowSpec,
  createGitWorktreeManager,
  resolveStepTimeoutSec,
  resolveWorkflowTimeoutSec,
  timeoutMsFromSec,
  runWorkflow,
  validateWorkflow,
  workflowAgentIds,
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

export type DispatchCheck = { ok: true } | { ok: false; reason: string };

/**
 * Routes workspace dispatches to the right adapter + model, gates on doctor
 * health, and streams normalized events for a run.
 */
export class Orchestrator {
  private readonly workspaceMap: Map<WorkspaceId, WorkspaceEntry>;
  private workflowCatalog: Record<string, WorkflowSpec>;
  private workflowSources: Record<string, WorkflowSourceKind>;

  constructor(
    private readonly config: SteamtrainConfig,
    workspaces: WorkspaceConfig,
    private doctor: DoctorResult[],
    catalog: LoadedWorkflowCatalog,
  ) {
    this.workspaceMap = workspaceById(workspaces);
    this.workflowCatalog = catalog.workflows;
    this.workflowSources = catalog.sources;
  }

  setDoctor(results: DoctorResult[]): void {
    this.doctor = results;
  }

  /** The reasoning config (binaries, timeouts) this orchestrator was built with. */
  getConfig(): SteamtrainConfig {
    return this.config;
  }

  /**
   * Replace the live workflow catalog (e.g. after the web UI creates, edits, or
   * deletes a user workflow). Subsequent runs and listings see the new map
   * without restarting the server.
   */
  setCatalog(catalog: LoadedWorkflowCatalog): void {
    this.workflowCatalog = catalog.workflows;
    this.workflowSources = catalog.sources;
  }

  /** Whether an agent is currently doctor-healthy (used to gate authoring). */
  isAgentHealthy(agent: AgentId): boolean {
    return this.doctor.find((d) => d.agent === agent)?.status === "ok";
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
    const dispatchCheck = this.canDispatch(id);
    if (!dispatchCheck.ok) throw new Error(dispatchCheck.reason);
    const { adapter, entry } = this.resolve(id);
    if (!entry.model) throw new Error(`workspace '${id}' has no model configured`);
    return adapter.run({
      prompt,
      model: entry.model,
      effort: entry.effort,
      cwd: process.cwd(),
      timeoutMs: timeoutMsFromSec(resolveStepTimeoutSec(undefined, undefined, this.config)),
      signal,
    });
  }

  // --- Workflows -----------------------------------------------------------

  /** All available workflows: bundled, user, and project merged by name. */
  listWorkflows(): Record<string, WorkflowSpec> {
    return this.workflowCatalog;
  }

  workflowSource(name: string): WorkflowSourceKind | undefined {
    return this.workflowSources[name];
  }

  /**
   * Whether a workflow may be dispatched: it must exist, validate, and every
   * distinct agent it uses must be doctor-healthy.
   */
  canDispatchWorkflow(name: string): DispatchCheck {
    const spec = this.listWorkflows()[name];
    if (!spec) return { ok: false, reason: `unknown workflow '${name}'` };
    return this.canDispatchWorkflowSpec(spec);
  }

  /** Like {@link canDispatchWorkflow} but for an already-resolved spec (e.g. with session overrides). */
  canDispatchWorkflowSpec(spec: WorkflowSpec): DispatchCheck {
    // Budget loops against the same configured cap the engine will use at run
    // time (deps.loopMaxIterations), so this pre-dispatch gate agrees with the
    // engine's own validateWorkflow rather than the default-10 fallback.
    const valid = validateWorkflow(spec, this.config.loopMaxIterations);
    if (!valid.ok) return { ok: false, reason: `invalid workflow '${spec.name}': ${valid.error}` };

    for (const agent of workflowAgentIds(spec)) {
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
    specOverride?: WorkflowSpec,
  ): AsyncIterable<WorkflowEvent> {
    const spec = specOverride ?? this.listWorkflows()[name];
    if (!spec) throw new Error(`unknown workflow '${name}'`);

    return runWorkflow(
      spec,
      { input, cache },
      {
        createAdapter,
        binaries: this.config.binaries,
        stepTimeoutSec: resolveStepTimeoutSec(undefined, undefined, this.config),
        maxConcurrency: this.config.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY,
        cwd,
        agentWorkspace: createGitWorktreeManager(),
        loopMaxIterations: this.config.loopMaxIterations,
      },
      signal,
    );
  }
}
