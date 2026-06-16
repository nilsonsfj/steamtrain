import { randomUUID } from "node:crypto";
import {
  type StepResult,
  type WorkflowCacheStore,
  type WorkflowEvent,
  type WorkflowSpec,
  persistWorkflowStepDone,
  workflowCacheKey,
} from "../workflow";

/**
 * The slice of the {@link Orchestrator} the web layer depends on. Declaring it
 * as an interface keeps the server testable with a lightweight fake and avoids
 * a hard dependency on the full orchestrator in unit tests.
 */
export interface WorkflowHost {
  listWorkflows(): Record<string, WorkflowSpec>;
  canDispatchWorkflowSpec(spec: WorkflowSpec): { ok: true } | { ok: false; reason: string };
  runWorkflow(
    name: string,
    input: string,
    signal?: AbortSignal,
    cache?: Map<string, StepResult>,
    cwd?: string,
    specOverride?: WorkflowSpec,
  ): AsyncIterable<WorkflowEvent>;
}

export type RunStatus = "running" | "done" | "error" | "canceled";

/** One serialized server-sent frame, retained so late subscribers can replay. */
interface RunFrame {
  payload: string;
  terminal: boolean;
}

/** A frame listener; `terminal` marks the final status frame (end of stream). */
export type RunListener = (payload: string, terminal: boolean) => void;

interface Run {
  id: string;
  workflow: string;
  input: string;
  status: RunStatus;
  ok?: boolean;
  error?: string;
  startedAt: number;
  endedAt?: number;
  frames: RunFrame[];
  terminal: boolean;
  listeners: Set<RunListener>;
  controller: AbortController;
}

export interface RunSummary {
  id: string;
  workflow: string;
  input: string;
  status: RunStatus;
  ok?: boolean;
  error?: string;
  startedAt: number;
  endedAt?: number;
}

export interface StartRunResult {
  ok: boolean;
  runId?: string;
  error?: string;
}

export interface RunManagerOptions {
  host: WorkflowHost;
  cacheStore: WorkflowCacheStore;
  cwd: string;
  /** Keep finished runs around this long (ms) so a reload can still replay. */
  retainMs?: number;
}

const DEFAULT_RETAIN_MS = 5 * 60_000;

/**
 * Drives workflow runs for the web UI: starts them against the orchestrator,
 * buffers their `WorkflowEvent` stream as SSE frames, fans frames out to live
 * subscribers, persists step results to the on-disk cache (so the web run
 * resumes exactly like the TUI/CLI), and supports cancellation.
 */
export class WorkflowRunManager {
  private readonly runs = new Map<string, Run>();
  private readonly host: WorkflowHost;
  private readonly cacheStore: WorkflowCacheStore;
  private readonly cwd: string;
  private readonly retainMs: number;

  constructor(options: RunManagerOptions) {
    this.host = options.host;
    this.cacheStore = options.cacheStore;
    this.cwd = options.cwd;
    this.retainMs = options.retainMs ?? DEFAULT_RETAIN_MS;
  }

  /** Validate and launch a run; the event loop runs detached in the background. */
  start(workflow: string, input: string, opts?: { fresh?: boolean }): StartRunResult {
    const text = input.trim();
    if (!text) return { ok: false, error: "input is required" };

    const spec = this.host.listWorkflows()[workflow];
    if (!spec) return { ok: false, error: `unknown workflow '${workflow}'` };

    const check = this.host.canDispatchWorkflowSpec(spec);
    if (!check.ok) return { ok: false, error: check.reason };

    const run: Run = {
      id: randomUUID(),
      workflow,
      input: text,
      status: "running",
      startedAt: Date.now(),
      frames: [],
      terminal: false,
      listeners: new Set(),
      controller: new AbortController(),
    };
    this.runs.set(run.id, run);
    void this.drive(run, spec, opts?.fresh ?? false);
    return { ok: true, runId: run.id };
  }

  /**
   * Replay buffered frames to a listener, then keep it subscribed for live
   * frames until the run ends. Returns an unsubscribe fn, or `null` if the run
   * is unknown. If the run already finished, all frames (including the terminal
   * one) are replayed and `null`-equivalent cleanup is returned.
   */
  subscribe(runId: string, listener: RunListener): (() => void) | null {
    const run = this.runs.get(runId);
    if (!run) return null;
    for (const frame of run.frames) listener(frame.payload, frame.terminal);
    if (run.terminal) return () => {};
    run.listeners.add(listener);
    return () => run.listeners.delete(listener);
  }

  cancel(runId: string): boolean {
    const run = this.runs.get(runId);
    if (!run || run.terminal) return false;
    run.controller.abort();
    return true;
  }

  get(runId: string): RunSummary | undefined {
    const run = this.runs.get(runId);
    return run ? toSummary(run) : undefined;
  }

  list(): RunSummary[] {
    return [...this.runs.values()].map(toSummary).sort((a, b) => b.startedAt - a.startedAt);
  }

  private emit(run: Run, payload: string, terminal: boolean): void {
    run.frames.push({ payload, terminal });
    for (const listener of run.listeners) listener(payload, terminal);
  }

  private async drive(run: Run, spec: WorkflowSpec, fresh: boolean): Promise<void> {
    const key = workflowCacheKey(run.workflow, run.input, this.cwd, spec);
    let ok: boolean | undefined;
    try {
      let cache: Map<string, StepResult>;
      if (fresh) {
        await this.cacheStore.clear(key);
        cache = new Map();
      } else {
        cache = await this.cacheStore.load(key);
      }
      for await (const event of this.host.runWorkflow(
        run.workflow,
        run.input,
        run.controller.signal,
        cache,
        this.cwd,
        spec,
      )) {
        this.emit(run, JSON.stringify({ type: "event", event }), false);
        if (event.kind === "step_done") {
          await persistWorkflowStepDone(
            this.cacheStore,
            key,
            cache,
            event.stepId,
            event.result,
            event.cached,
          );
        }
        if (event.kind === "workflow_done") ok = event.ok;
      }
      run.status = ok === false ? "error" : "done";
      run.ok = ok ?? true;
    } catch (err) {
      if (run.controller.signal.aborted) {
        run.status = "canceled";
      } else {
        run.status = "error";
        run.error = err instanceof Error ? err.message : String(err);
      }
    } finally {
      run.endedAt = Date.now();
      run.terminal = true;
      this.emit(
        run,
        JSON.stringify({
          type: "status",
          status: run.status,
          ok: run.ok,
          error: run.error,
        }),
        true,
      );
      run.listeners.clear();
      this.scheduleGc(run.id);
    }
  }

  private scheduleGc(runId: string): void {
    const timer = setTimeout(() => this.runs.delete(runId), this.retainMs);
    // Don't let a pending GC timer keep the process alive.
    if (typeof timer.unref === "function") timer.unref();
  }
}

function toSummary(run: Run): RunSummary {
  return {
    id: run.id,
    workflow: run.workflow,
    input: run.input,
    status: run.status,
    ok: run.ok,
    error: run.error,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
  };
}
