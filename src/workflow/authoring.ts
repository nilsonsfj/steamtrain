import { existsSync } from "node:fs";
import { type AgentAdapter, createAdapter } from "../agents";
import { type AgentMeta, buildAgentMeta, defaultDraftModel } from "../agents/agent-meta";
import { AGENT_IDS } from "../agents/models";
import { type SteamtrainConfig, projectConfigPath } from "../config";
import {
  deleteProjectWorkflow,
  loadProjectWorkflows,
  saveProjectWorkflow,
} from "../config/project-workflows";
import type { AgentId } from "../types/events";
import {
  type LoadedWorkflowCatalog,
  loadWorkflowCatalog,
  saveSessionWorkflowsToUser,
} from "./catalog";
import { deleteUserWorkflow, saveUserWorkflow } from "./catalog";
import type { SaveSessionWorkflowsResult, WorkflowSourceKind } from "./catalog";
import { generateWorkflow, slugifyWorkflowName } from "./generate";
import { applyWorkflowStepOverrides } from "./overrides";
import type { WorkflowStepOverrides } from "./overrides";
import { type WorkflowSpec, validateWorkflow } from "./types";

/**
 * The slice of the orchestrator the authoring layer needs: read the catalog,
 * check agent health, and swap the live catalog after a write. Declaring it as
 * an interface keeps {@link WorkflowAuthor} usable from both the web server
 * (Orchestrator implements it) and the TUI (a thin adapter over React state),
 * and unit-testable with a small fake.
 */
export interface AuthoringHost {
  listWorkflows(): Record<string, WorkflowSpec>;
  workflowSource(name: string): WorkflowSourceKind | undefined;
  isAgentHealthy(agent: AgentId): boolean;
  setCatalog(catalog: LoadedWorkflowCatalog): void;
}

export interface WorkflowAuthorOptions {
  host: AuthoringHost;
  config: SteamtrainConfig;
  /** Home dir whose `~/.steamtrain/workflows.json` is read and written. */
  home: string;
  /** Working directory for the drafting agent (it needs no repo access). */
  cwd: string;
  /** Project workflows preserved across reloads (from `steamtrain.json`). */
  projectWorkflows?: Record<string, WorkflowSpec>;
  /** Injectable adapter factory for tests; defaults to the real one. */
  createAdapter?: (id: AgentId, binary?: string) => AgentAdapter;
}

/**
 * Where an authored workflow is persisted: `user` →
 * `~/.steamtrain/workflows.json` (the default, personal layer), `project` → the
 * `workflows` section of the project's `steamtrain.json` (checked into the repo,
 * shared with the team). A `project` write becomes a `project`-source catalog
 * entry, which wins over user and bundled.
 */
export type WorkflowScope = "user" | "project";

export interface GenerateRequest {
  description: string;
  agent: AgentId;
  model: string;
  effort?: string;
  name?: string;
  /** Persistence target; defaults to `user`. */
  scope?: WorkflowScope;
}

export interface AuthorWriteResult {
  ok: boolean;
  name?: string;
  spec?: WorkflowSpec;
  source?: WorkflowSourceKind;
  /** Path of the user workflows file when something was written. */
  savedPath?: string;
  /** True when an existing workflow of the same name was replaced. */
  replaced?: boolean;
  error?: string;
  /** Raw model text, surfaced when generation parsing fails. */
  raw?: string;
}

export interface AuthorDeleteResult {
  ok: boolean;
  removed?: boolean;
  error?: string;
}

/**
 * The shared workflow authoring core used by every frontend: LLM-delegated
 * creation, manual edits, clone, deletion, staged per-step overrides, and a
 * flush of those overrides — all persisted to `~/.steamtrain/workflows.json`
 * and reflected in the live catalog (via {@link AuthoringHost.setCatalog}) so a
 * change is usable without a restart. The web server and the TUI both drive
 * this one class; each only owns rendering + input.
 */
export class WorkflowAuthor {
  private readonly host: AuthoringHost;
  private readonly config: SteamtrainConfig;
  private readonly home: string;
  private readonly cwd: string;
  private readonly projectWorkflows?: Record<string, WorkflowSpec>;
  private readonly makeAdapter: (id: AgentId, binary?: string) => AgentAdapter;

  constructor(options: WorkflowAuthorOptions) {
    this.host = options.host;
    this.config = options.config;
    this.home = options.home;
    this.cwd = options.cwd;
    this.projectWorkflows = options.projectWorkflows;
    this.makeAdapter = options.createAdapter ?? createAdapter;
  }

  /** Agents with their model catalogs, effort levels, defaults, and live health. */
  agentMeta(): AgentMeta[] {
    return buildAgentMeta((agent) => this.host.isAgentHealthy(agent));
  }

  /**
   * Draft a workflow from a description with an agent, then persist it. `onDelta`
   * streams the model's output so the UI can show live drafting. Fails fast when
   * the chosen agent is unhealthy.
   */
  async generate(
    req: GenerateRequest,
    onDelta?: (text: string) => void,
    signal?: AbortSignal,
  ): Promise<AuthorWriteResult> {
    if (!isKnownAgent(req.agent)) return { ok: false, error: `unknown agent '${req.agent}'` };
    if (!req.description.trim()) return { ok: false, error: "a description is required" };
    if (!this.host.isAgentHealthy(req.agent)) {
      return { ok: false, error: `${req.agent} is not available (check agent health)` };
    }

    const model = req.model?.trim() || defaultDraftModel(req.agent);
    const result = await generateWorkflow(
      {
        description: req.description,
        agent: req.agent,
        model,
        effort: req.effort,
        name: req.name,
        signal,
        onEvent: (event) => {
          if (event.kind === "text_delta" && !event.thinking) onDelta?.(event.text);
        },
      },
      {
        createAdapter: this.makeAdapter,
        binaries: this.config.binaries,
        timeoutMs: this.config.timeoutMs,
        cwd: this.cwd,
      },
    );

    if (!result.ok || !result.spec) {
      return { ok: false, error: result.error ?? "workflow generation failed", raw: result.raw };
    }
    return this.persist(result.spec.name, result.spec, { raw: result.raw, scope: req.scope });
  }

  /**
   * Validate and persist a hand-edited spec under `name` (slugified). When
   * `previousName` differs and named an existing user workflow, the old entry is
   * removed so a rename leaves no duplicate.
   */
  save(
    name: string,
    spec: WorkflowSpec,
    previousName?: string,
    scope: WorkflowScope = "user",
  ): AuthorWriteResult {
    const slug = slugifyWorkflowName(name || spec.name || "");
    if (!slug) return { ok: false, error: "a workflow name is required" };

    const written = this.persist(slug, spec, { scope });
    if (!written.ok) return written;

    // On a rename, drop the old entry so we don't leave a duplicate. Only an
    // entry living in the *same* writable layer is removed; renaming away from a
    // bundled name (or across layers) leaves the other entry be.
    if (previousName && previousName !== slug) {
      const previousSource = this.host.workflowSource(previousName);
      if (previousSource === "user") {
        deleteUserWorkflow(previousName, this.home);
        this.reload();
      } else if (previousSource === "project") {
        deleteProjectWorkflow(previousName, this.cwd);
        this.reload();
      }
    }
    return written;
  }

  /**
   * Save an existing workflow (bundled, user, or project) under a new name as a
   * user copy. The source is left untouched. Used by the TUI/web "clone".
   */
  clone(sourceName: string, newName: string, scope: WorkflowScope = "user"): AuthorWriteResult {
    const source = this.host.listWorkflows()[sourceName];
    if (!source) return { ok: false, error: `unknown workflow '${sourceName}'` };

    const slug = slugifyWorkflowName(newName || "");
    if (!slug) return { ok: false, error: "a new workflow name is required" };
    if (slug === sourceName) return { ok: false, error: "the clone needs a different name" };
    // Cloning is non-destructive: refuse to land on top of any existing
    // workflow (user/bundled/project) rather than silently clobbering it.
    if (this.host.listWorkflows()[slug]) {
      return { ok: false, error: `a workflow named '${slug}' already exists` };
    }

    return this.persist(slug, { ...source, name: slug }, { scope });
  }

  /**
   * Remove a workflow from its writable layer and the live catalog. User
   * workflows are deleted from `~/.steamtrain/workflows.json`, project workflows
   * from the project `steamtrain.json`; bundled workflows cannot be deleted.
   */
  remove(name: string): AuthorDeleteResult {
    const source = this.host.workflowSource(name);
    if (!source) return { ok: false, error: `unknown workflow '${name}'` };
    if (source === "bundled") {
      return { ok: false, error: `bundled workflow '${name}' cannot be deleted` };
    }
    const result =
      source === "project"
        ? deleteProjectWorkflow(name, this.cwd)
        : deleteUserWorkflow(name, this.home);
    if (!result.ok) return { ok: false, error: result.error };
    this.reload();
    return { ok: true, removed: result.removed };
  }

  /**
   * Resolve a workflow with staged (in-session, unsaved) per-step overrides
   * applied — the spec a "try without saving" run would use. Returns undefined
   * when the workflow is unknown.
   */
  previewWithOverrides(name: string, overrides?: WorkflowStepOverrides): WorkflowSpec | undefined {
    const base = this.host.listWorkflows()[name];
    if (!base) return undefined;
    return applyWorkflowStepOverrides(base, overrides);
  }

  /**
   * Flush staged session overrides to the user workflows file, reporting
   * saved / skipped / unchanged. Reloads the live catalog when anything was
   * written. This is the shared core behind the TUI's `/saveworkflows`.
   */
  flushSessionOverrides(
    sessionOverrides: Record<string, WorkflowStepOverrides>,
  ): SaveSessionWorkflowsResult {
    const result = saveSessionWorkflowsToUser({
      catalog: this.catalog(),
      sessionOverrides,
      home: this.home,
    });
    if (result.saved.length > 0) this.reload();
    return result;
  }

  private persist(
    name: string,
    spec: WorkflowSpec,
    extra?: { raw?: string; scope?: WorkflowScope },
  ): AuthorWriteResult {
    const scope: WorkflowScope = extra?.scope ?? "user";
    const full: WorkflowSpec = { ...spec, name };
    const valid = validateWorkflow(full);
    if (!valid.ok) return { ok: false, error: valid.error, raw: extra?.raw };

    const saved =
      scope === "project"
        ? saveProjectWorkflow(name, full, this.cwd)
        : saveUserWorkflow(name, full, this.home);
    if (!saved.ok) return { ok: false, error: saved.error, raw: extra?.raw };

    this.reload();
    return {
      ok: true,
      name,
      spec: full,
      source: scope,
      savedPath: saved.path,
      replaced: saved.replaced,
      raw: extra?.raw,
    };
  }

  /** The current live catalog as seen through the host. */
  private catalog(): LoadedWorkflowCatalog {
    const workflows = this.host.listWorkflows();
    const sources: Record<string, WorkflowSourceKind> = {};
    for (const name of Object.keys(workflows)) {
      sources[name] = this.host.workflowSource(name) ?? "bundled";
    }
    return { workflows, sources };
  }

  /**
   * Re-read the catalog from disk (+ project) and swap it into the host. Project
   * workflows are re-read from `<cwd>/steamtrain.json` so a project-layer write
   * is reflected live; the constructor's `projectWorkflows` is the fallback for
   * the first load and for configs loaded from a non-cwd custom path that has no
   * `steamtrain.json` in the working directory.
   */
  private reload(): void {
    // Trust the on-disk project file whenever it exists (even with zero
    // workflows, so deleting the last project workflow takes effect); fall back
    // to the constructor's snapshot only when cwd has no steamtrain.json.
    const projectWorkflows = existsSync(projectConfigPath(this.cwd))
      ? loadProjectWorkflows(this.cwd)
      : this.projectWorkflows;
    const catalog = loadWorkflowCatalog({ home: this.home, projectWorkflows });
    this.host.setCatalog(catalog);
  }
}

function isKnownAgent(agent: string): agent is AgentId {
  return (AGENT_IDS as readonly string[]).includes(agent);
}
