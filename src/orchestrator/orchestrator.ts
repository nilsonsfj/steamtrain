import { type AgentAdapter, createAdapter } from "../agents";
import type { SteamtrainConfig, TaskConfig, TaskType } from "../config";
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

const DEFAULT_MAX_CONCURRENCY = 3;

export interface ResolvedTask {
  type: TaskType;
  taskConfig: TaskConfig;
  adapter: AgentAdapter;
  health?: DoctorResult;
}

export interface DispatchCheck {
  ok: boolean;
  reason?: string;
}

/**
 * Routes a task type to the right adapter + model, gates dispatch on doctor
 * health, and streams normalized events for a run.
 */
export class Orchestrator {
  constructor(
    private readonly config: SteamtrainConfig,
    private doctor: DoctorResult[],
  ) {}

  setDoctor(results: DoctorResult[]): void {
    this.doctor = results;
  }

  resolve(type: TaskType): ResolvedTask {
    const taskConfig = this.config.tasks[type];
    const adapter = createAdapter(taskConfig.agent, this.config.binaries?.[taskConfig.agent]);
    const health = this.doctor.find((d) => d.agent === taskConfig.agent);
    return { type, taskConfig, adapter, health };
  }

  /** Whether a task may be dispatched given current agent health. */
  canDispatch(type: TaskType): DispatchCheck {
    const { taskConfig, health } = this.resolve(type);
    if (!health) {
      return { ok: false, reason: `${taskConfig.agent}: health unknown (doctor has not run yet)` };
    }
    if (health.status !== "ok") {
      const detail = health.detail ?? health.message;
      return {
        ok: false,
        reason: `${taskConfig.agent} is ${health.status} — ${detail}`,
      };
    }
    return { ok: true };
  }

  /** Stream normalized events for a task run. */
  run(type: TaskType, prompt: string, signal?: AbortSignal): AsyncIterable<AgentEvent> {
    const { adapter, taskConfig } = this.resolve(type);
    return adapter.run({
      prompt,
      model: taskConfig.model,
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
        cwd: process.cwd(),
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
