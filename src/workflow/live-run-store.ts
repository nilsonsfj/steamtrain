import { randomBytes } from "node:crypto";
import { appendFile, mkdir, open, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ApprovalDecision } from "./approval";
import type { StepEditPatch, StepEditResult } from "./control";
import type { WorkflowEvent } from "./events";
import { atomicWriteFile, isEnoent, sanitizePathComponent } from "./fs-util";
import { RunRecordBuilder, type RunRecordStatus } from "./history";
import type { WorkflowHistoryStore } from "./history-store";
import type { HumanInputOrigin, HumanInputResponse } from "./human-input";
import type { WorkflowSpec } from "./types";

/**
 * The live-run store: an on-disk registry of in-flight (and just-finished)
 * workflow runs under `.steamtrain/runs/<runId>/`, shared by every driver
 * (CLI foreground, CLI `--detach`, TUI, web UI). It is what makes detached
 * runs, cross-process attach, the run queue, and cross-process cancel /
 * approval possible:
 *
 *   meta.json         — {@link LiveRunMeta}: status, owning pid, launch args
 *   events.ndjson     — one {@link WorkflowEvent} JSON line per event (append-only)
 *   cancel            — marker file; the owning process polls it and aborts
 *   approvals/*.json  — human-approval decisions written by any attached UI
 *   inputs/*.json     — human-input answers written by any attached UI
 *   control/pause.json — desired pause state (last write wins); the owner polls it
 *   control/edits/*.json — mid-run step-edit requests + the owner's results
 *   runner.log        — stdout/stderr of a detached runner (debugging)
 *
 * Only the process that owns a run writes its meta/events; every other
 * process is a reader (attach/tail) or drops marker files (cancel, approval
 * decisions). That single-writer discipline is what keeps the store safe
 * without cross-process locks.
 */

export const WORKFLOW_RUNS_DIR = ".steamtrain/runs";

/** Default cap on concurrently *executing* runs; excess runs wait in the queue. */
export const DEFAULT_MAX_PARALLEL_RUNS = 2;

/** How long a finished run's live dir is kept for late attach/replay. */
export const LIVE_RUN_TTL_MS = 15 * 60_000;

/**
 * Grace period before a non-terminal entry whose owner looks gone is declared
 * orphaned. Covers the detached-spawn window where the parent has created the
 * meta (pid -1) but the child has not yet written its own pid — generous
 * enough for a slow cold start under load.
 */
export const LIVE_RUN_ORPHAN_GRACE_MS = 30_000;

/**
 * Cap on `step_event` (streamed text/tool) lines persisted per run so a very
 * long run cannot grow events.ndjson unboundedly. Lifecycle events
 * (step_start/step_done/…) are always written; past the cap only the stream
 * chatter is dropped, so an attached view keeps full structure and totals but
 * may miss some mid-run text. Mirrors the web run manager's frame cap.
 */
export const MAX_STREAM_EVENTS_PER_RUN = 20_000;

export const LIVE_RUN_META_VERSION = 1;

/** Non-terminal live statuses + the terminal {@link RunRecordStatus} set. */
export type LiveRunStatus = "queued" | "running" | RunRecordStatus;

export type LiveRunSource = "cli" | "cli-detached" | "tui" | "web";

/** The launch arguments a detached runner needs to reproduce the run. */
export interface LiveRunLaunch {
  workflow: string;
  input: string;
  params?: Record<string, string | number | boolean>;
  fresh?: boolean;
  /** Headless approval policy for the detached runner (absent ⇒ wait for a human decision). */
  approveAll?: boolean;
  onApproval?: "fail" | "stop";
  /** Pre-supplied `--human <stepId>=<value>` answers (absent ⇒ wait for a human answer). */
  humanInputs?: Record<string, string>;
  /** `--agent <id>`: re-route blocked agent steps to this agent (re-planned by the runner). */
  rerouteAgent?: string;
  /**
   * The exact resolved spec the run was executing, when it differs from the
   * catalog workflow — set by a mid-run detach so the background process
   * continues with the same per-session overrides (reroute, per-step model /
   * prompt edits) the run was using, keeping the cache key (and therefore the
   * completed steps) aligned. Absent ⇒ the runner resolves `workflow` from the
   * catalog (the `--detach`-at-launch path, which has no session overrides).
   */
  spec?: WorkflowSpec;
}

/** One human-input request a live run is waiting on, mirrored into its meta. */
export interface LiveRunPendingInput {
  stepId: string;
  iteration: number;
  /** 1-based ask attempt; answers target a specific attempt. */
  attempt: number;
  /** Spec-declared `human` step vs. an agent's clarifying question. */
  origin?: HumanInputOrigin;
  /** First ~200 chars of the ask, so list views can show what's wanted. */
  prompt?: string;
  /** Pick-one choices, when declared. */
  choices?: string[];
}

export interface LiveRunMeta {
  version: number;
  id: string;
  workflow: string;
  input: string;
  params?: Record<string, string | number | boolean>;
  cwd: string;
  /** Process that owns (executes) the run. -1 until a detached child reports in. */
  pid: number;
  source: LiveRunSource;
  /** True when the run survives its launching terminal (a `--detach` runner). */
  detached: boolean;
  status: LiveRunStatus;
  ok?: boolean;
  error?: string;
  /** When the run entered the queue (registry arrival order → queue order). */
  createdAt: number;
  /** When the run left the queue and started executing. */
  startedAt?: number;
  endedAt?: number;
  /** Human-approval checkpoints currently awaiting a decision. */
  pendingApprovals?: { stepId: string; iteration: number }[];
  /** Human-input requests (human steps / agent questions) currently awaiting an answer. */
  pendingInputs?: LiveRunPendingInput[];
  /** True while the run's engine has acknowledged a pause (mirrored from `run_paused`/`run_resumed`). */
  paused?: boolean;
  /** Launch args for the detached runner (set only for `--detach` runs). */
  launch?: LiveRunLaunch;
}

/** The desired pause state any attached UI may write (last write wins). */
export interface LiveRunPauseState {
  paused: boolean;
  /** Who asked (e.g. `"human:cli"`). */
  by?: string;
}

/** A mid-run step-edit request dropped by an attached UI for the owner to apply. */
export interface LiveRunStepEditRequest {
  editId: string;
  stepId: string;
  patch: StepEditPatch;
  by?: string;
}

export const LIVE_RUN_TERMINAL_STATUSES: readonly LiveRunStatus[] = [
  "done",
  "error",
  "canceled",
  "budget-exceeded",
];

export function isTerminalLiveRunStatus(status: LiveRunStatus): boolean {
  return LIVE_RUN_TERMINAL_STATUSES.includes(status);
}

/** Whether a process id is currently alive (best-effort; EPERM counts as alive). */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return Boolean(err && typeof err === "object" && (err as { code?: string }).code === "EPERM");
  }
}

/**
 * Whether a run's owning process should be considered alive. The single
 * source of truth shared by the queue and the orphan sweep, so they can never
 * disagree: `pid === -1` (a detached child that has not reported in yet)
 * counts as alive within the spawn grace window, dead after it.
 */
export function isLiveRunOwnerAlive(
  meta: Pick<LiveRunMeta, "pid" | "createdAt">,
  at: number = Date.now(),
): boolean {
  if (meta.pid === -1) return at - meta.createdAt <= LIVE_RUN_ORPHAN_GRACE_MS;
  return isPidAlive(meta.pid);
}

export interface LiveRunListOptions {
  /**
   * Mark dead-pid entries orphaned and delete expired terminal entries while
   * listing. Defaults to true — every caller doubles as the sweeper, so the
   * registry self-heals without a daemon.
   */
  sweep?: boolean;
}

export interface LiveRunStore {
  rootDir: string;
  /** Register a new run (creates the run dir, meta, and an empty events file). */
  create(meta: LiveRunMeta): Promise<void>;
  /** Read one run's meta, or undefined when absent/corrupt. */
  get(id: string): Promise<LiveRunMeta | undefined>;
  /** Merge a patch into a run's meta (single-writer: owners only). */
  update(id: string, patch: Partial<LiveRunMeta>): Promise<LiveRunMeta | undefined>;
  /** All registered runs, newest first. Sweeps stale entries by default. */
  list(options?: LiveRunListOptions): Promise<LiveRunMeta[]>;
  /** Append serialized events (owners only; lines must end with `\n`). */
  appendEventLines(id: string, lines: string): Promise<void>;
  /** All events recorded so far (replay). */
  readEvents(id: string): Promise<WorkflowEvent[]>;
  /**
   * Replay recorded events, then keep tailing live appends until the run's
   * meta turns terminal (drains any bytes written before the terminal meta).
   */
  tailEvents(
    id: string,
    options?: { signal?: AbortSignal; pollMs?: number },
  ): AsyncGenerator<WorkflowEvent>;
  /** Ask the owning process to cancel the run (drops the cancel marker). */
  requestCancel(id: string): Promise<boolean>;
  /** Whether a cancel has been requested for the run. */
  cancelRequested(id: string): Promise<boolean>;
  /** Record a human-approval decision for a pending checkpoint. */
  writeApprovalDecision(
    id: string,
    stepId: string,
    iteration: number,
    decision: ApprovalDecision,
  ): Promise<void>;
  /** Read a recorded approval decision, or undefined when none yet. */
  readApprovalDecision(
    id: string,
    stepId: string,
    iteration: number,
  ): Promise<ApprovalDecision | undefined>;
  /**
   * Record a human-input answer for a pending request. Answers are attempt-
   * scoped: a re-ask (rejected answer) waits for a NEW file, so a stale bad
   * answer can't satisfy it.
   */
  writeHumanInputResponse(
    id: string,
    stepId: string,
    iteration: number,
    attempt: number,
    response: HumanInputResponse,
  ): Promise<void>;
  /** Read a recorded human-input answer, or undefined when none yet. */
  readHumanInputResponse(
    id: string,
    stepId: string,
    iteration: number,
    attempt: number,
  ): Promise<HumanInputResponse | undefined>;
  /**
   * Write the desired pause state (any attached UI; last write wins). The
   * owning process polls it via {@link readPauseState} and steers its run
   * control to match. Returns false when the run is unknown or terminal.
   */
  writePauseState(id: string, state: LiveRunPauseState): Promise<boolean>;
  /** Read the desired pause state, or undefined when never written. */
  readPauseState(id: string): Promise<LiveRunPauseState | undefined>;
  /**
   * Drop a mid-run step-edit request for the owning process to validate and
   * apply. Returns the edit id to poll {@link readStepEditResult} with, or
   * undefined when the run is unknown or terminal.
   */
  requestStepEdit(
    id: string,
    edit: { stepId: string; patch: StepEditPatch; by?: string },
  ): Promise<string | undefined>;
  /** All step-edit requests recorded so far, oldest first (owner polling). */
  listStepEditRequests(id: string): Promise<LiveRunStepEditRequest[]>;
  /** Record the owner's accept/reject outcome for an edit request. */
  writeStepEditResult(id: string, editId: string, result: StepEditResult): Promise<void>;
  /** Read an edit request's outcome, or undefined while still unprocessed. */
  readStepEditResult(id: string, editId: string): Promise<StepEditResult | undefined>;
  /** Delete a run's live dir. */
  remove(id: string): Promise<void>;
}

export interface CreateLiveRunStoreOptions {
  /**
   * When set, an orphaned run (owner process died without finishing) has its
   * recorded events folded into a RunRecord and saved here during sweep, so
   * the run still shows up in history instead of vanishing.
   */
  historyStore?: WorkflowHistoryStore;
  /** Terminal-entry retention override (ms). */
  ttlMs?: number;
  /** Time source override for tests. */
  now?: () => number;
}

export function createLiveRunStore(
  rootDir: string,
  options: CreateLiveRunStoreOptions = {},
): LiveRunStore {
  const ttlMs = options.ttlMs ?? LIVE_RUN_TTL_MS;
  const now = options.now ?? Date.now;

  const runDir = (id: string): string => join(rootDir, sanitizePathComponent(id));
  const metaPath = (id: string): string => join(runDir(id), "meta.json");
  const eventsPath = (id: string): string => join(runDir(id), "events.ndjson");
  const cancelPath = (id: string): string => join(runDir(id), "cancel");
  const approvalPath = (id: string, stepId: string, iteration: number): string =>
    join(runDir(id), "approvals", `${sanitizePathComponent(stepId)}@${iteration}.json`);
  const inputPath = (id: string, stepId: string, iteration: number, attempt: number): string =>
    join(runDir(id), "inputs", `${sanitizePathComponent(stepId)}@${iteration}-${attempt}.json`);
  const pausePath = (id: string): string => join(runDir(id), "control", "pause.json");
  const editsDir = (id: string): string => join(runDir(id), "control", "edits");
  const editPath = (id: string, editId: string): string =>
    join(editsDir(id), `${sanitizePathComponent(editId)}.json`);
  const editResultPath = (id: string, editId: string): string =>
    join(editsDir(id), `${sanitizePathComponent(editId)}.result.json`);

  async function get(id: string): Promise<LiveRunMeta | undefined> {
    return readMeta(metaPath(id));
  }

  async function update(id: string, patch: Partial<LiveRunMeta>): Promise<LiveRunMeta | undefined> {
    const meta = await get(id);
    if (!meta) return undefined;
    const next = { ...meta, ...patch };
    await atomicWriteFile(metaPath(id), `${JSON.stringify(next, null, 2)}\n`);
    return next;
  }

  /**
   * Mark a dead-owner run as orphaned and (best-effort) fold its recorded
   * events into a history record so the run doesn't silently vanish.
   */
  async function markOrphaned(meta: LiveRunMeta): Promise<LiveRunMeta> {
    // Re-read before writing: the owner may have settled the run between the
    // sweep's read and now (or the pid was reused) — never clobber a terminal
    // status with "orphaned".
    const fresh = await get(meta.id);
    if (fresh && isTerminalLiveRunStatus(fresh.status)) return fresh;
    const patched =
      (await update(meta.id, {
        status: "error",
        ok: false,
        error: "runner process exited before the run finished",
        endedAt: now(),
        pendingApprovals: [],
        pendingInputs: [],
      })) ?? meta;
    if (options.historyStore) {
      try {
        const existing = await options.historyStore.get(meta.id);
        if (!existing) {
          const builder = new RunRecordBuilder(
            {
              id: meta.id,
              workflow: meta.workflow,
              input: meta.input,
              cwd: meta.cwd,
              params: meta.params,
            },
            meta.startedAt ?? meta.createdAt,
          );
          for (const event of await readEventsFile(eventsPath(meta.id))) builder.handle(event);
          await options.historyStore.save(
            builder.build({
              status: "error",
              error: "runner process exited before the run finished",
              endedAt: patched.endedAt,
            }),
          );
        }
      } catch {
        // Best-effort: a failed history fold must not break listing.
      }
    }
    return patched;
  }

  async function list(listOptions: LiveRunListOptions = {}): Promise<LiveRunMeta[]> {
    const sweep = listOptions.sweep ?? true;
    let entries: string[];
    try {
      entries = await readdir(rootDir);
    } catch (err) {
      if (isEnoent(err)) return [];
      throw err;
    }
    const reads = await Promise.all(
      entries.map((name) => readMeta(join(rootDir, name, "meta.json"))),
    );
    const metas: LiveRunMeta[] = [];
    for (let i = 0; i < entries.length; i++) {
      const meta = reads[i];
      if (!meta) {
        // A dir with no readable meta (crash between mkdir and the meta write,
        // or stray debris) is invisible to every consumer; clear it out once
        // it is old enough to rule out an in-progress create.
        if (sweep) {
          const dir = join(rootDir, entries[i]!);
          // ENOENT ⇒ the dir vanished concurrently (nothing to do). Any other
          // stat failure ⇒ treat as expired and still attempt the delete —
          // otherwise a permissions-broken debris dir would persist forever.
          const age = await stat(dir).then(
            (info) => now() - info.mtimeMs,
            (statErr) => (isEnoent(statErr) ? 0 : Number.POSITIVE_INFINITY),
          );
          if (age > ttlMs) await rm(dir, { recursive: true, force: true }).catch(() => {});
        }
        continue;
      }
      if (sweep && isTerminalLiveRunStatus(meta.status)) {
        const endedAt = meta.endedAt ?? meta.createdAt;
        if (now() - endedAt > ttlMs) {
          const removed = await rm(join(rootDir, entries[i]!), {
            recursive: true,
            force: true,
          }).then(
            () => true,
            () => false,
          );
          // If the delete failed (permissions, open handles), keep the entry
          // visible rather than leaving an invisible orphan on disk.
          if (removed) continue;
        }
      }
      if (sweep && !isTerminalLiveRunStatus(meta.status) && !isLiveRunOwnerAlive(meta, now())) {
        metas.push(await markOrphaned(meta));
        continue;
      }
      metas.push(meta);
    }
    metas.sort((a, b) => b.createdAt - a.createdAt);
    return metas;
  }

  async function* tailEvents(
    id: string,
    tailOptions: { signal?: AbortSignal; pollMs?: number } = {},
  ): AsyncGenerator<WorkflowEvent> {
    const pollMs = tailOptions.pollMs ?? 250;
    const signal = tailOptions.signal;
    const path = eventsPath(id);
    let offset = 0;
    // Buffer raw bytes and split on newline *bytes*: a chunk boundary may fall
    // inside a multi-byte UTF-8 sequence, so lines are only decoded once whole.
    let remainder: Buffer = Buffer.alloc(0);
    for (;;) {
      if (signal?.aborted) return;
      const chunk = await readFrom(path, offset);
      if (chunk.length > 0) {
        offset += chunk.length;
        const drained = drainEventLines(remainder, chunk);
        remainder = drained.remainder;
        for (const event of drained.events) yield event;
        // New bytes may still be flowing; re-read immediately.
        continue;
      }
      const meta = await get(id);
      // Terminal meta is written only after the final event flush, so a quiet
      // file + terminal (or missing) meta means the stream is complete — but
      // drain once more in case events were flushed between the empty read and
      // the meta write.
      if (!meta || isTerminalLiveRunStatus(meta.status)) {
        const finalChunk = await readFrom(path, offset);
        if (finalChunk.length > 0) {
          offset += finalChunk.length;
          const drained = drainEventLines(remainder, finalChunk);
          remainder = drained.remainder;
          for (const event of drained.events) yield event;
        }
        return;
      }
      await liveRunSleep(pollMs, signal);
    }
  }

  return {
    rootDir,
    async create(meta) {
      await mkdir(runDir(meta.id), { recursive: true });
      await atomicWriteFile(metaPath(meta.id), `${JSON.stringify(meta, null, 2)}\n`);
      await writeFile(eventsPath(meta.id), "", { flag: "a" });
    },
    get,
    update,
    list,
    async appendEventLines(id, lines) {
      await appendFile(eventsPath(id), lines, "utf8");
    },
    readEvents: (id) => readEventsFile(eventsPath(id)),
    tailEvents,
    async requestCancel(id) {
      const meta = await get(id);
      if (!meta || isTerminalLiveRunStatus(meta.status)) return false;
      await writeFile(cancelPath(id), `${now()}\n`, "utf8");
      return true;
    },
    async cancelRequested(id) {
      try {
        await stat(cancelPath(id));
        return true;
      } catch (err) {
        if (isEnoent(err)) return false;
        throw err;
      }
    },
    async writeApprovalDecision(id, stepId, iteration, decision) {
      await mkdir(join(runDir(id), "approvals"), { recursive: true });
      await atomicWriteFile(
        approvalPath(id, stepId, iteration),
        `${JSON.stringify(decision, null, 2)}\n`,
      );
    },
    async readApprovalDecision(id, stepId, iteration) {
      let file: string;
      try {
        file = await readFile(approvalPath(id, stepId, iteration), "utf8");
      } catch (err) {
        if (!isEnoent(err)) throw err;
        // Namespacing fallback: the engine hands approval providers the LOCAL
        // step id, but events (and therefore pendingApprovals, and therefore
        // external deciders) carry the NAMESPACED id (`parent::child`) when the
        // checkpoint lives inside a sub-workflow. A decision file written under
        // the namespaced id must still be found when read by the local id, or
        // the run would hang forever on an already-decided checkpoint.
        const namespaced = await findNamespacedFile(
          join(runDir(id), "approvals"),
          `__${sanitizePathComponent(stepId)}@${iteration}.json`,
        );
        if (!namespaced) return undefined;
        try {
          file = await readFile(namespaced, "utf8");
        } catch (readErr) {
          if (isEnoent(readErr)) return undefined;
          throw readErr;
        }
      }
      try {
        const parsed = JSON.parse(file) as Partial<ApprovalDecision>;
        if (typeof parsed !== "object" || parsed === null) return undefined;
        if (typeof parsed.approved !== "boolean") return undefined;
        return {
          approved: parsed.approved,
          by: typeof parsed.by === "string" ? parsed.by : undefined,
          note: typeof parsed.note === "string" ? parsed.note : undefined,
          rejectDisposition:
            parsed.rejectDisposition === "fail" || parsed.rejectDisposition === "stop"
              ? parsed.rejectDisposition
              : undefined,
        };
      } catch {
        return undefined;
      }
    },
    async writeHumanInputResponse(id, stepId, iteration, attempt, response) {
      await mkdir(join(runDir(id), "inputs"), { recursive: true });
      await atomicWriteFile(
        inputPath(id, stepId, iteration, attempt),
        `${JSON.stringify(response, null, 2)}\n`,
      );
    },
    async readHumanInputResponse(id, stepId, iteration, attempt) {
      let file: string;
      try {
        file = await readFile(inputPath(id, stepId, iteration, attempt), "utf8");
      } catch (err) {
        if (!isEnoent(err)) throw err;
        // Same namespacing fallback as approvals: an answer written under the
        // NAMESPACED id (`parent::child`, from the event stream) must still be
        // found when the engine reads by the LOCAL id.
        const namespaced = await findNamespacedFile(
          join(runDir(id), "inputs"),
          `__${sanitizePathComponent(stepId)}@${iteration}-${attempt}.json`,
        );
        if (!namespaced) return undefined;
        try {
          file = await readFile(namespaced, "utf8");
        } catch (readErr) {
          if (isEnoent(readErr)) return undefined;
          throw readErr;
        }
      }
      try {
        const parsed = JSON.parse(file) as {
          value?: unknown;
          canceled?: unknown;
          by?: unknown;
          reason?: unknown;
        };
        if (typeof parsed !== "object" || parsed === null) return undefined;
        const by = typeof parsed.by === "string" ? parsed.by : undefined;
        if (parsed.canceled === true) {
          return {
            canceled: true,
            by,
            reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
          };
        }
        if (typeof parsed.value !== "string") return undefined;
        return { value: parsed.value, by };
      } catch {
        return undefined;
      }
    },
    async writePauseState(id, state) {
      const meta = await get(id);
      if (!meta || isTerminalLiveRunStatus(meta.status)) return false;
      await mkdir(join(runDir(id), "control"), { recursive: true });
      await atomicWriteFile(
        pausePath(id),
        `${JSON.stringify({ paused: state.paused, by: state.by, ts: now() }, null, 2)}\n`,
      );
      return true;
    },
    async readPauseState(id) {
      let file: string;
      try {
        file = await readFile(pausePath(id), "utf8");
      } catch (err) {
        if (isEnoent(err)) return undefined;
        throw err;
      }
      try {
        const parsed = JSON.parse(file) as Partial<LiveRunPauseState>;
        if (!parsed || typeof parsed !== "object") return undefined;
        if (typeof parsed.paused !== "boolean") return undefined;
        return { paused: parsed.paused, by: typeof parsed.by === "string" ? parsed.by : undefined };
      } catch {
        return undefined;
      }
    },
    async requestStepEdit(id, edit) {
      const meta = await get(id);
      if (!meta || isTerminalLiveRunStatus(meta.status)) return undefined;
      // Timestamp prefix keeps directory listing order == request order.
      const editId = `${now()}-${randomBytes(4).toString("hex")}`;
      await mkdir(editsDir(id), { recursive: true });
      await atomicWriteFile(
        editPath(id, editId),
        `${JSON.stringify({ stepId: edit.stepId, patch: edit.patch, by: edit.by }, null, 2)}\n`,
      );
      return editId;
    },
    async listStepEditRequests(id) {
      let names: string[];
      try {
        names = await readdir(editsDir(id));
      } catch (err) {
        if (isEnoent(err)) return [];
        throw err;
      }
      const requests: LiveRunStepEditRequest[] = [];
      for (const name of names.sort()) {
        if (!name.endsWith(".json") || name.endsWith(".result.json")) continue;
        const editId = name.slice(0, -".json".length);
        let file: string;
        try {
          file = await readFile(join(editsDir(id), name), "utf8");
        } catch {
          continue;
        }
        try {
          const parsed = JSON.parse(file) as {
            stepId?: unknown;
            patch?: unknown;
            by?: unknown;
          };
          if (
            typeof parsed.stepId !== "string" ||
            !parsed.patch ||
            typeof parsed.patch !== "object"
          )
            continue;
          requests.push({
            editId,
            stepId: parsed.stepId,
            patch: sanitizeStepEditPatch(parsed.patch as Record<string, unknown>),
            by: typeof parsed.by === "string" ? parsed.by : undefined,
          });
        } catch {
          // A torn/corrupt request is skipped, not fatal.
        }
      }
      return requests;
    },
    async writeStepEditResult(id, editId, result) {
      await mkdir(editsDir(id), { recursive: true });
      await atomicWriteFile(editResultPath(id, editId), `${JSON.stringify(result, null, 2)}\n`);
    },
    async readStepEditResult(id, editId) {
      let file: string;
      try {
        file = await readFile(editResultPath(id, editId), "utf8");
      } catch (err) {
        if (isEnoent(err)) return undefined;
        throw err;
      }
      try {
        const parsed = JSON.parse(file) as { ok?: unknown; error?: unknown };
        if (!parsed || typeof parsed !== "object" || typeof parsed.ok !== "boolean")
          return undefined;
        return parsed.ok
          ? { ok: true }
          : { ok: false, error: typeof parsed.error === "string" ? parsed.error : "edit rejected" };
      } catch {
        return undefined;
      }
    },
    async remove(id) {
      await rm(runDir(id), { recursive: true, force: true });
    },
  };
}

/** Keep only the string-valued editable fields of an untrusted patch payload. */
function sanitizeStepEditPatch(raw: Record<string, unknown>): StepEditPatch {
  const patch: StepEditPatch = {};
  if (typeof raw.prompt === "string") patch.prompt = raw.prompt;
  if (typeof raw.cmd === "string") patch.cmd = raw.cmd;
  if (typeof raw.model === "string") patch.model = raw.model;
  if (typeof raw.effort === "string") patch.effort = raw.effort;
  return patch;
}

/**
 * Find a response file whose (namespaced) step id ends in `::<stepId>`.
 * Namespace separators sanitize to `__`, so the match is "file name ends with
 * `__<sanitized-local-id>@<suffix>`". Shared by approvals and human inputs.
 */
async function findNamespacedFile(dir: string, suffix: string): Promise<string | undefined> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if (isEnoent(err)) return undefined;
    throw err;
  }
  const match = names.find((name) => name.endsWith(suffix));
  return match ? join(dir, match) : undefined;
}

async function readMeta(path: string): Promise<LiveRunMeta | undefined> {
  let file: string;
  try {
    file = await readFile(path, "utf8");
  } catch (err) {
    if (isEnoent(err)) return undefined;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(file);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const m = parsed as Partial<LiveRunMeta>;
  if (m.version !== LIVE_RUN_META_VERSION) return undefined;
  if (typeof m.id !== "string" || typeof m.workflow !== "string") return undefined;
  if (typeof m.status !== "string" || typeof m.createdAt !== "number") return undefined;
  const validStatuses: LiveRunStatus[] = ["queued", "running", ...LIVE_RUN_TERMINAL_STATUSES];
  if (!validStatuses.includes(m.status as LiveRunStatus)) return undefined;
  return {
    version: m.version,
    id: m.id,
    workflow: m.workflow,
    input: typeof m.input === "string" ? m.input : "",
    params: m.params && typeof m.params === "object" ? m.params : undefined,
    cwd: typeof m.cwd === "string" ? m.cwd : "",
    pid: typeof m.pid === "number" ? m.pid : -1,
    source: isLiveRunSource(m.source) ? m.source : "cli",
    detached: Boolean(m.detached),
    status: m.status as LiveRunStatus,
    ok: typeof m.ok === "boolean" ? m.ok : undefined,
    error: typeof m.error === "string" ? m.error : undefined,
    createdAt: m.createdAt,
    startedAt: typeof m.startedAt === "number" ? m.startedAt : undefined,
    endedAt: typeof m.endedAt === "number" ? m.endedAt : undefined,
    paused: typeof m.paused === "boolean" ? m.paused : undefined,
    pendingApprovals: Array.isArray(m.pendingApprovals)
      ? m.pendingApprovals.filter(
          (p): p is { stepId: string; iteration: number } =>
            Boolean(p) &&
            typeof (p as { stepId?: unknown }).stepId === "string" &&
            typeof (p as { iteration?: unknown }).iteration === "number",
        )
      : undefined,
    pendingInputs: Array.isArray(m.pendingInputs)
      ? m.pendingInputs.filter(
          (p): p is LiveRunPendingInput =>
            Boolean(p) &&
            typeof (p as { stepId?: unknown }).stepId === "string" &&
            typeof (p as { iteration?: unknown }).iteration === "number" &&
            typeof (p as { attempt?: unknown }).attempt === "number",
        )
      : undefined,
    launch: m.launch && typeof m.launch === "object" ? m.launch : undefined,
  };
}

function isLiveRunSource(value: unknown): value is LiveRunSource {
  return value === "cli" || value === "cli-detached" || value === "tui" || value === "web";
}

async function readEventsFile(path: string): Promise<WorkflowEvent[]> {
  let file: string;
  try {
    file = await readFile(path, "utf8");
  } catch (err) {
    if (isEnoent(err)) return [];
    throw err;
  }
  const events: WorkflowEvent[] = [];
  for (const line of file.split("\n")) {
    const event = parseEventLine(line);
    if (event) events.push(event);
  }
  return events;
}

/**
 * Append `chunk` onto `remainder` and split out complete newline-terminated
 * event lines. Incomplete trailing bytes stay in `remainder` for the next read.
 */
function drainEventLines(
  remainder: Buffer,
  chunk: Buffer,
): { events: WorkflowEvent[]; remainder: Buffer } {
  let buf = remainder.length > 0 ? Buffer.concat([remainder, chunk]) : chunk;
  const events: WorkflowEvent[] = [];
  let newline = buf.indexOf(0x0a);
  while (newline >= 0) {
    const line = buf.subarray(0, newline).toString("utf8");
    buf = buf.subarray(newline + 1);
    const event = parseEventLine(line);
    if (event) events.push(event);
    newline = buf.indexOf(0x0a);
  }
  return { events, remainder: buf };
}

function parseEventLine(line: string): WorkflowEvent | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as WorkflowEvent;
    if (!parsed || typeof parsed !== "object" || typeof parsed.kind !== "string") return undefined;
    return parsed;
  } catch {
    // A torn/corrupt line (crash mid-append) is skipped, not fatal.
    return undefined;
  }
}

/** Read the file's raw bytes from `offset` to EOF (empty buffer when nothing new). */
async function readFrom(path: string, offset: number): Promise<Buffer> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch (err) {
    if (isEnoent(err)) return Buffer.alloc(0);
    throw err;
  }
  if (size <= offset) return Buffer.alloc(0);
  const handle = await open(path, "r");
  try {
    const length = size - offset;
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * A control-flow sleep: gates forward progress (tail polls, queue waits,
 * approval polls), so its timer must KEEP the event loop alive — an unref'd
 * timer here would let a process whose only remaining work is this wait (a
 * headless attach, a queued foreground run, a parked detached runner)
 * silently exit mid-wait. Shared with `live-run.ts`.
 */
export function liveRunSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
