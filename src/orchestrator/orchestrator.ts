import {
  type AgentAdapter,
  type ResolvedAgentInstance,
  createAdapter,
  resolveAgentInstance,
} from "../agents";
import { DEFAULT_CONFIG, type SteamtrainConfig } from "../config";
import { type DoctorResult, collectLlmKeyRequirements } from "../doctor";
import type { AgentEvent, AgentInstanceId } from "../types/events";
import {
  type LoadedWorkflowCatalog,
  type StepResult,
  type WorkflowEvent,
  type WorkflowSourceKind,
  type WorkflowSpec,
  createGitWorktreeManager,
  resolveStepTimeoutSec,
  resolveWorkflowTimeoutSec,
  runWorkflow,
  timeoutMsFromSec,
  validateWorkflow,
  workflowAgentIds,
} from "../workflow";
import type { ApprovalProvider } from "../workflow";
import type { WorkspaceConfig, WorkspaceEntry, WorkspaceId } from "../workspace";
import { workspaceById } from "../workspace";

export interface ResolvedWorkspace {
  id: WorkspaceId;
  entry: WorkspaceEntry;
  adapter: AgentAdapter;
  instance: ResolvedAgentInstance;
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
    this.workflowCatalog = { ...catalog.workflows };
    this.workflowSources = { ...catalog.sources };
  }

  setDoctor(results: DoctorResult[]): void {
    this.doctor = [...results];
  }

  /** Current preflight results (agents + any llm-key checks set since startup). */
  getDoctor(): DoctorResult[] {
    return [...this.doctor];
  }

  /**
   * Replace only the llm-key readiness entries, preserving agent results. Used
   * by the TUI/web run-start so each run's key checks refresh without erasing
   * the cached agent binary health.
   */
  setLlmDoctor(checks: DoctorResult[]): void {
    const agentResults = this.doctor.filter((d) => d.category === "agent");
    this.doctor = [...agentResults, ...checks];
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
    this.workflowCatalog = { ...catalog.workflows };
    this.workflowSources = { ...catalog.sources };
  }

  /** Whether an agent is currently doctor-healthy (used to gate authoring). */
  isAgentHealthy(agent: AgentInstanceId): boolean {
    return this.doctor.find((d) => d.agent === agent)?.status === "ok";
  }

  private agentHealth(agent: AgentInstanceId): DoctorResult | undefined {
    return this.doctor.find((d) => d.agent === agent);
  }

  resolve(id: WorkspaceId): ResolvedWorkspace {
    const entry = this.workspaceMap.get(id);
    if (!entry) throw new Error(`unknown workspace '${id}'`);
    const instance = resolveAgentInstance(this.config, entry.agent);
    if (!instance) throw new Error(`agent '${entry.agent}' is disabled or not configured`);
    const adapter = createAdapter(instance.provider, instance.binary);
    const health = this.agentHealth(entry.agent);
    return { id, entry, adapter, instance, health };
  }

  /** Whether a workspace may be dispatched given current agent health. */
  canDispatch(id: WorkspaceId): DispatchCheck {
    const entry = this.workspaceMap.get(id);
    if (!entry) return { ok: false, reason: `unknown workspace '${id}'` };

    const instance = resolveAgentInstance(this.config, entry.agent);
    if (!instance) {
      return { ok: false, reason: `${entry.agent} is disabled or not configured` };
    }
    const health = this.agentHealth(entry.agent);
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
  run(
    id: WorkspaceId,
    prompt: string,
    signal?: AbortSignal,
    cwd?: string,
  ): AsyncIterable<AgentEvent> {
    const dispatchCheck = this.canDispatch(id);
    if (!dispatchCheck.ok) throw new Error(dispatchCheck.reason);
    const { adapter, entry, instance } = this.resolve(id);
    if (!entry.model) throw new Error(`workspace '${id}' has no model configured`);
    return adapter.run({
      prompt,
      model: entry.model,
      effort: entry.effort,
      cwd: cwd ?? process.cwd(),
      env: instance.env,
      extraArgs: instance.extraArgs,
      agentId: instance.id,
      timeoutMs: timeoutMsFromSec(resolveStepTimeoutSec(undefined, undefined, this.config)),
      signal,
    });
  }

  // --- Workflows -----------------------------------------------------------

  /** All available workflows: bundled, user, and project merged by name. */
  listWorkflows(): Record<string, WorkflowSpec> {
    return { ...this.workflowCatalog };
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
      const instance = resolveAgentInstance(this.config, agent);
      if (!instance) {
        return { ok: false, reason: `${agent} is disabled or not configured` };
      }
      const health = this.agentHealth(agent);
      if (!health) {
        return { ok: false, reason: `${agent}: health unknown (doctor has not run yet)` };
      }
      if (health.status !== "ok") {
        const detail = health.detail ?? health.message;
        return { ok: false, reason: `${agent} is ${health.status} — ${detail}` };
      }
    }

    // `llm` steps need only their provider API key (read from the env at run
    // time). Gate on it here so an llm-only workflow fails fast at preflight
    // instead of dying mid-run when the first `llm` step fires. We read
    // process.env directly (not `this.doctor`) because the doctor panel is
    // only a snapshot and env can change between startup and dispatch — the
    // same pattern the engine uses at run time.
    for (const req of collectLlmKeyRequirements(spec)) {
      if (!process.env[req.envVar]) {
        return {
          ok: false,
          reason: `llm API key missing: set ${req.envVar} to run workflows with ${req.provider} llm steps`,
        };
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
    inputs?: Record<string, string | number | boolean>,
    approval?: ApprovalProvider,
  ): AsyncIterable<WorkflowEvent> {
    const spec = specOverride ?? this.listWorkflows()[name];
    if (!spec) throw new Error(`unknown workflow '${name}'`);

    return runWorkflow(
      spec,
      { input, cache, inputs },
      {
        createAdapter,
        binaries: this.config.binaries,
        agentConfig: this.config,
        stepTimeoutSec: resolveStepTimeoutSec(undefined, undefined, this.config),
        maxConcurrency: this.config.maxConcurrency ?? DEFAULT_CONFIG.maxConcurrency!,
        cwd,
        agentWorkspace: createGitWorktreeManager(),
        loopMaxIterations: this.config.loopMaxIterations,
        resolveWorkflow: (name) => this.workflowCatalog[name],
        requestApproval: approval,
      },
      signal,
    );
  }
}
