import { type AgentAdapter, createAdapter } from "../agents";
import { AGENT_IDS, defaultModelForAgent, effortsForModel, modelsForAgent } from "../agents/models";
import type { SteamtrainConfig } from "../config";
import type { AgentId } from "../types/events";
import {
  type LoadedWorkflowCatalog,
  type WorkflowSourceKind,
  type WorkflowSpec,
  deleteUserWorkflow,
  generateWorkflow,
  loadWorkflowCatalog,
  saveUserWorkflow,
  slugifyWorkflowName,
  validateWorkflow,
} from "../workflow";

/**
 * The slice of the orchestrator the authoring layer needs: read the catalog,
 * check agent health, and swap the live catalog after a write. Declaring it as
 * an interface keeps {@link WorkflowAuthor} unit-testable with a small fake.
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

export interface AgentModelMeta {
  id: string;
  name: string;
  /** Reasoning effort / variant levels this model accepts (may be empty). */
  efforts: string[];
}

export interface AgentMeta {
  id: AgentId;
  models: AgentModelMeta[];
  defaultModel: string;
  healthy: boolean;
}

export interface GenerateRequest {
  description: string;
  agent: AgentId;
  model: string;
  effort?: string;
  name?: string;
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
 * Web-side workflow authoring: LLM-delegated creation, manual edits, and
 * deletion, all persisted to `~/.steamtrain/workflows.json` and reflected in the
 * live orchestrator catalog so the change is usable without a restart. This is
 * the web analogue of the TUI's `/createworkflow` + step overrides + save flow.
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
    return AGENT_IDS.map((agent) => ({
      id: agent,
      models: modelsForAgent(agent).map((model) => ({
        id: model.id,
        name: model.name,
        efforts: [...effortsForModel(agent, model.id)],
      })),
      defaultModel: webDefaultModel(agent),
      healthy: this.host.isAgentHealthy(agent),
    }));
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

    const model = req.model?.trim() || webDefaultModel(req.agent);
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
    return this.persist(result.spec.name, result.spec, { raw: result.raw });
  }

  /**
   * Validate and persist a hand-edited spec under `name` (slugified). When
   * `previousName` differs and named an existing user workflow, the old entry is
   * removed so a rename leaves no duplicate.
   */
  save(name: string, spec: WorkflowSpec, previousName?: string): AuthorWriteResult {
    const slug = slugifyWorkflowName(name || spec.name || "");
    if (!slug) return { ok: false, error: "a workflow name is required" };

    const written = this.persist(slug, spec);
    if (!written.ok) return written;

    // On a rename, drop the old user entry so we don't leave a duplicate.
    // Renaming away from a bundled/project name leaves that read-only entry be.
    if (
      previousName &&
      previousName !== slug &&
      this.host.workflowSource(previousName) === "user"
    ) {
      deleteUserWorkflow(previousName, this.home);
      this.reload();
    }
    return written;
  }

  /** Remove a user workflow from disk and the live catalog. */
  remove(name: string): AuthorDeleteResult {
    const source = this.host.workflowSource(name);
    if (!source) return { ok: false, error: `unknown workflow '${name}'` };
    if (source !== "user") {
      return { ok: false, error: `${source} workflow '${name}' cannot be deleted from the web UI` };
    }
    const result = deleteUserWorkflow(name, this.home);
    if (!result.ok) return { ok: false, error: result.error };
    this.reload();
    return { ok: true, removed: result.removed };
  }

  private persist(name: string, spec: WorkflowSpec, extra?: { raw?: string }): AuthorWriteResult {
    const full: WorkflowSpec = { ...spec, name };
    const valid = validateWorkflow(full);
    if (!valid.ok) return { ok: false, error: valid.error, raw: extra?.raw };

    const saved = saveUserWorkflow(name, full, this.home);
    if (!saved.ok) return { ok: false, error: saved.error, raw: extra?.raw };

    this.reload();
    return {
      ok: true,
      name,
      spec: full,
      source: "user",
      savedPath: saved.path,
      replaced: saved.replaced,
      raw: extra?.raw,
    };
  }

  /** Re-read the catalog from disk (+ project) and swap it into the host. */
  private reload(): void {
    const catalog = loadWorkflowCatalog({
      home: this.home,
      projectWorkflows: this.projectWorkflows,
    });
    this.host.setCatalog(catalog);
  }
}

function isKnownAgent(agent: string): agent is AgentId {
  return (AGENT_IDS as readonly string[]).includes(agent);
}

/**
 * Default model for the web create form. Mirrors the TUI: opencode prefers the
 * free MiMo model (the catalog default is a paid model), other agents use their
 * normal default.
 */
export function webDefaultModel(agent: AgentId): string {
  if (agent === "opencode") {
    const free = "opencode/mimo-v2.5-free";
    if (modelsForAgent(agent).some((m) => m.id === free)) return free;
  }
  return defaultModelForAgent(agent);
}
