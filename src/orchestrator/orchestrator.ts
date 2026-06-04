import { type AgentAdapter, createAdapter } from "../agents";
import type { SteamtrainConfig, TaskConfig, TaskType } from "../config";
import type { DoctorResult } from "../doctor";
import type { AgentEvent } from "../types/events";

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
}
