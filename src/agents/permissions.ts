import type { AgentProviderId } from "../types/events";

/**
 * Per-step tool permissions — the cross-agent sandbox vocabulary.
 *
 * Every agent CLI has its own permission dialect (`claude --permission-mode` +
 * tool allow/deny lists, `codex --sandbox`, `opencode --agent plan`, …) and
 * most of them default to *full power*. Without a declared profile, a
 * "critique the diff" step can rewrite the repository exactly like an
 * "implement it" step can — which is the reason people run workflows on a
 * scratch clone instead of their real checkout.
 *
 * A step declares INTENT (`"read-only"` | `"edit"` | `"full"`); this module
 * owns the translation to each CLI's native flags and, just as importantly,
 * owns the truth about what each CLI can actually enforce. The engine refuses
 * to launch a restricted step on an agent that cannot honor the restriction
 * (unless the author opts into `onUnsupported: "warn"`), and independently
 * verifies read-only steps against their workspace afterwards — so the profile
 * is a checked invariant rather than a comment.
 *
 * Profiles are ordered by blast radius:
 *
 *  - `read-only` — read, search, analyze; mutate nothing. Where the CLI has a
 *    real sandbox this is enforced as a read-only filesystem with networking
 *    off (codex `--sandbox read-only`); where it has tool lists instead, as
 *    read/search tools with writes, shell and network denied (claude). The
 *    profile for reviewers, critics, judges, planners and scanners.
 *  - `edit` — read plus write/edit files inside the step's own workspace, and
 *    nothing else: no network, no shell outside what the CLI's own sandbox
 *    confines to the workspace.
 *  - `full` — today's unrestricted behavior, declared explicitly. Unlike the
 *    other two this profile GRANTS rather than restricts: it pre-approves
 *    everything the CLI can do, so an implement step never stalls on a
 *    permission prompt it cannot answer headlessly.
 */
export type PermissionProfile = "read-only" | "edit" | "full";

/** Profiles in increasing-power order (used for ranking/labels). */
export const PERMISSION_PROFILES: readonly PermissionProfile[] = ["read-only", "edit", "full"];

export function isPermissionProfile(value: unknown): value is PermissionProfile {
  return typeof value === "string" && (PERMISSION_PROFILES as readonly string[]).includes(value);
}

/** What happens when the resolved agent cannot enforce a restricted profile. */
export type PermissionUnsupportedPolicy = "fail" | "warn";

/**
 * The object form of a step's `permissions` field. The string shorthand
 * (`"permissions": "read-only"`) expands to `{ profile: "read-only" }`.
 */
export interface StepPermissions {
  profile: PermissionProfile;
  /**
   * Extra tool patterns to allow on top of the profile, in the *agent's own*
   * syntax (Claude Code: `"Bash(npm test:*)"`, `"Read"`). Additive: a
   * read-only reviewer that must run one specific command declares it here
   * instead of dropping to `full`.
   */
  allow?: string[];
  /**
   * Tool patterns to deny regardless of the profile (deny always wins). Use to
   * carve dangerous tools out of `full` — `["Bash(git push:*)"]` — or to
   * tighten `edit`.
   */
  deny?: string[];
  /**
   * What to do when the step's agent has no native enforcement for the
   * profile. `"fail"` (default) refuses to launch the step: an unenforceable
   * restriction is a false promise, and failing loudly is the whole point of
   * the field. `"warn"` runs it anyway, records the gap on the step, and
   * leaves the post-run workspace verification as the only guard.
   */
  onUnsupported?: PermissionUnsupportedPolicy;
  /**
   * Verify after the run that a `read-only` step left its workspace untouched
   * (tracked edits, deletions, and new files, ignoring gitignored paths),
   * failing the step when it did not. Default `true` for `read-only`;
   * meaningless for the other profiles, which are allowed to write.
   */
  verify?: boolean;
}

/** Declared form: the string shorthand or the full object. */
export type PermissionsSpec = PermissionProfile | StepPermissions;

/** A `permissions` value with every default filled in. */
export interface ResolvedPermissions {
  profile: PermissionProfile;
  allow: string[];
  deny: string[];
  onUnsupported: PermissionUnsupportedPolicy;
  /** Post-run workspace verification is armed (only ever true for read-only). */
  verify: boolean;
}

/**
 * How much of a requested profile the agent's CLI enforces itself:
 *
 *  - `native`  — the CLI is given flags that enforce the profile.
 *  - `partial` — the profile is enforced, but some part of the request is not
 *    (e.g. codex sandboxes everything but has no per-tool allow/deny lists).
 *    Runs, with the gaps recorded and surfaced.
 *  - `none`    — the CLI offers nothing that enforces this profile. Blocked by
 *    default (`onUnsupported: "fail"`).
 */
export type PermissionEnforcement = "native" | "partial" | "none";

/** The concrete spawn-time consequences of a step's permissions. */
export interface PermissionPlan {
  profile: PermissionProfile;
  /** CLI flags to insert into the agent's args, before the author's `extraArgs`. */
  args: string[];
  /** Extra env vars the profile requires (none today; kept for CLIs that use env). */
  env?: Record<string, string>;
  enforcement: PermissionEnforcement;
  /**
   * Plain-language description of everything the CLI does NOT enforce for this
   * request. Empty when `enforcement` is `native`. Surfaced on the step, in
   * the run record, and in pre-dispatch preflight warnings.
   */
  gaps: string[];
  /** Post-run workspace verification is armed for this step. */
  verify: boolean;
}

/** Per-provider capability declaration for the restricted profiles. */
export interface ProviderPermissionSupport {
  /** Enforcement level for each profile, before allow/deny lists are considered. */
  profiles: Record<PermissionProfile, PermissionEnforcement>;
  /** True when the CLI has per-tool allow/deny lists `allow`/`deny` can map onto. */
  lists: boolean;
  /** How the CLI expresses permissions, for docs/diagnostics ("--sandbox", …). */
  mechanism: string;
}

// --- Claude Code tool sets ---------------------------------------------------
//
// Claude Code takes tool names (optionally scoped, `Bash(npm test:*)`) in
// `--allowedTools` / `--disallowedTools`, with deny winning over allow. The
// read set is deliberately generous about *understanding* the repo and
// deliberately silent about changing it.

const CLAUDE_READ_TOOLS: readonly string[] = [
  "Read",
  "Glob",
  "Grep",
  "LS",
  "NotebookRead",
  "TodoWrite",
  "Task",
];

const CLAUDE_NETWORK_TOOLS: readonly string[] = ["WebFetch", "WebSearch"];

const CLAUDE_WRITE_TOOLS: readonly string[] = ["Write", "Edit", "MultiEdit", "NotebookEdit"];

const CLAUDE_EXEC_TOOLS: readonly string[] = ["Bash", "BashOutput", "KillShell"];

const PROVIDER_SUPPORT: Record<AgentProviderId, ProviderPermissionSupport> = {
  claude: {
    profiles: { "read-only": "native", edit: "native", full: "native" },
    lists: true,
    mechanism: "--permission-mode + --allowedTools/--disallowedTools",
  },
  codex: {
    profiles: { "read-only": "native", edit: "native", full: "native" },
    lists: false,
    mechanism: "--sandbox",
  },
  opencode: {
    profiles: { "read-only": "native", edit: "none", full: "native" },
    lists: false,
    mechanism: "--agent (built-in read-only `plan` agent)",
  },
  // Same CLI surface as opencode (the adapter reuses its arg builder).
  mimo: {
    profiles: { "read-only": "native", edit: "none", full: "native" },
    lists: false,
    mechanism: "--agent (built-in read-only `plan` agent)",
  },
  cursor: {
    profiles: { "read-only": "none", edit: "none", full: "native" },
    lists: false,
    mechanism: "all-or-nothing headless mode — no flag revokes tool access",
  },
  amp: {
    profiles: { "read-only": "none", edit: "none", full: "native" },
    lists: false,
    mechanism: "all-or-nothing headless mode — no flag revokes tool access",
  },
  kimi: {
    profiles: { "read-only": "none", edit: "none", full: "native" },
    lists: false,
    mechanism: "all-or-nothing headless mode — no flag revokes tool access",
  },
  kiro: {
    profiles: { "read-only": "none", edit: "none", full: "native" },
    lists: false,
    mechanism: "headless runs use --trust-all-tools, which has no per-tool form",
  },
  antigravity: {
    profiles: { "read-only": "none", edit: "none", full: "native" },
    lists: false,
    mechanism: "headless runs use --dangerously-skip-permissions, which has no per-tool form",
  },
  grok: {
    profiles: { "read-only": "native", edit: "native", full: "native" },
    lists: true,
    mechanism: "--sandbox + --permission-mode + --allow/--deny",
  },
};

/** Capability declaration for one provider (what it can enforce, and how). */
export function providerPermissionSupport(provider: AgentProviderId): ProviderPermissionSupport {
  return PROVIDER_SUPPORT[provider];
}

/** Every provider's capability declaration, for docs, doctor, and the UIs. */
export function permissionSupportMatrix(): Record<AgentProviderId, ProviderPermissionSupport> {
  return PROVIDER_SUPPORT;
}

/**
 * Fill in the defaults of a declared `permissions` value. Returns `undefined`
 * for an absent declaration — "unset" is NOT the same as `full`: an unset step
 * keeps today's behavior exactly (no permission flags are passed at all, no
 * verification runs), while `full` explicitly pre-approves everything.
 */
export function resolvePermissions(
  spec: PermissionsSpec | undefined,
): ResolvedPermissions | undefined {
  if (spec === undefined) return undefined;
  const declared: StepPermissions = typeof spec === "string" ? { profile: spec } : spec;
  return {
    profile: declared.profile,
    allow: declared.allow ? [...declared.allow] : [],
    deny: declared.deny ? [...declared.deny] : [],
    onUnsupported: declared.onUnsupported ?? "fail",
    verify: declared.verify ?? declared.profile === "read-only",
  };
}

/**
 * The effective permissions for a step: its own declaration, else the
 * workflow's default, else the project/user config default, else unset. The
 * layers do not merge field-by-field — a step that declares `permissions`
 * owns the whole decision, so reading one step tells you exactly what it can
 * do.
 */
export function effectivePermissions(
  layers: readonly (PermissionsSpec | undefined)[],
): ResolvedPermissions | undefined {
  for (const layer of layers) {
    if (layer !== undefined) return resolvePermissions(layer);
  }
  return undefined;
}

function joinList(values: readonly string[]): string {
  return values.join(",");
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function claudePlan(perms: ResolvedPermissions): PermissionPlan {
  const args: string[] = [];
  let allow: string[];
  let deny: string[];

  switch (perms.profile) {
    case "read-only":
      // `plan` mode backs the deny list in headless `--print` runs so Claude
      // Code does not stall on tool-use prompts it cannot answer.
      args.push("--permission-mode", "plan");
      allow = dedupe([...CLAUDE_READ_TOOLS, ...perms.allow]);
      deny = dedupe([
        ...CLAUDE_WRITE_TOOLS,
        ...CLAUDE_EXEC_TOOLS,
        ...CLAUDE_NETWORK_TOOLS,
        ...perms.deny,
      ]);
      break;
    case "edit":
      // `acceptEdits` auto-approves file edits so the step never stalls on a
      // prompt it cannot answer headlessly; the deny list is what keeps `edit`
      // from being `full` (no shell, no network).
      args.push("--permission-mode", "acceptEdits");
      allow = dedupe([...CLAUDE_READ_TOOLS, ...CLAUDE_WRITE_TOOLS, ...perms.allow]);
      deny = dedupe([...CLAUDE_EXEC_TOOLS, ...CLAUDE_NETWORK_TOOLS, ...perms.deny]);
      break;
    case "full":
      args.push("--permission-mode", "bypassPermissions");
      allow = dedupe(perms.allow);
      deny = dedupe(perms.deny);
      break;
  }

  // A tool the author explicitly allowed must not also be denied by the
  // profile's blanket list — the narrower, explicit grant wins. Exact-name
  // matches only; a scoped grant (`Bash(npm test:*)`) is intentionally left
  // alongside the blanket `Bash` deny, since Claude Code resolves the more
  // specific rule itself.
  const explicitlyAllowed = new Set(perms.allow);
  const stillDenied = (tool: string): boolean =>
    !explicitlyAllowed.has(tool) || perms.deny.includes(tool);
  deny = deny.filter(stillDenied);

  if (allow.length > 0) args.push("--allowedTools", joinList(allow));
  if (deny.length > 0) args.push("--disallowedTools", joinList(deny));

  const gaps: string[] = [];
  if (perms.profile === "edit") {
    gaps.push(
      "claude has no filesystem sandbox: edits are confined by the step's isolated worktree, not by the CLI",
    );
  }
  return {
    profile: perms.profile,
    args,
    enforcement: gaps.length > 0 ? "partial" : "native",
    gaps,
    verify: perms.verify && perms.profile === "read-only",
  };
}

function codexPlan(perms: ResolvedPermissions): PermissionPlan {
  const sandbox =
    perms.profile === "read-only"
      ? "read-only"
      : perms.profile === "edit"
        ? "workspace-write"
        : "danger-full-access";
  const gaps: string[] = [];
  if (perms.allow.length > 0 || perms.deny.length > 0) {
    gaps.push(
      "codex has no per-tool allow/deny lists; the allow/deny entries are advisory and only the sandbox is enforced",
    );
  }
  return {
    profile: perms.profile,
    args: ["--sandbox", sandbox],
    enforcement: gaps.length > 0 ? "partial" : "native",
    gaps,
    verify: perms.verify && perms.profile === "read-only",
  };
}

function opencodePlan(perms: ResolvedPermissions): PermissionPlan {
  const gaps: string[] = [];
  if (perms.allow.length > 0 || perms.deny.length > 0) {
    gaps.push(
      "opencode has no per-tool allow/deny CLI flags; the allow/deny entries are advisory (configure agent permissions in opencode's own config)",
    );
  }
  if (perms.profile === "read-only") {
    // opencode's built-in `plan` agent has write/edit/patch/bash disabled.
    return {
      profile: perms.profile,
      args: ["--agent", "plan"],
      enforcement: gaps.length > 0 ? "partial" : "native",
      gaps,
      // Same guard as every other provider: verification is a read-only
      // concept, and spelling it out keeps a future refactor of this branch
      // from arming it for a profile that may write.
      verify: perms.verify && perms.profile === "read-only",
    };
  }
  if (perms.profile === "edit") {
    return {
      profile: perms.profile,
      args: [],
      enforcement: "none",
      gaps: [
        "opencode has no built-in agent that allows edits but withholds shell/network — use read-only, full, or claude/codex for edit",
        ...gaps,
      ],
      verify: false,
    };
  }
  return {
    profile: perms.profile,
    args: [],
    enforcement: gaps.length > 0 ? "partial" : "native",
    gaps,
    verify: false,
  };
}

// Grok Build tool ids. Permission *rules* use the Claude-compatible prefixes
// (`Bash`, `Edit`, `Write`, `WebFetch`); `--disallowed-tools` takes these ids.
// The shell tool is listed as `run_terminal_command` but removed by its
// `run_terminal_cmd` id (checked against grok 1.0.40).
const GROK_SHELL_TOOL = "run_terminal_cmd";
const GROK_EDIT_TOOLS = ["search_replace", "write"];

/**
 * Translate a steamtrain profile onto Grok Build's sandbox, permission mode,
 * and allow/deny rules.
 *
 * Headless Grok cannot answer an approval prompt, so every profile picks a
 * mode that will not ask: `dontAsk` (read-only), `acceptEdits` (edit), or
 * `--always-approve` (full). Deny rules still apply under always-approve.
 * An author's explicit allow drops the profile's matching deny — deny wins
 * only when the author also listed that rule in `deny`.
 *
 * Read-only uses the `workspace` sandbox, not Grok's `read-only` one: that
 * profile (and `strict`) refuses to start at all when `/var/run/docker.sock`
 * is a symlink, which is how Docker Desktop installs it on macOS. Writes stay
 * confined to the step's workspace by the OS; inside it, the removed tools,
 * the deny rules, and post-run verification keep the step read-only.
 */
function grokPlan(perms: ResolvedPermissions): PermissionPlan {
  const args: string[] = [];
  const denies: string[] = [];
  const disallowed: string[] = [];
  const addDeny = (rule: string): void => {
    if (!denies.includes(rule)) denies.push(rule);
  };
  const granted = (rule: string): boolean =>
    perms.allow.includes(rule) && !perms.deny.includes(rule);

  let disableWeb = false;

  switch (perms.profile) {
    case "read-only":
      args.push("--sandbox", "workspace", "--permission-mode", "dontAsk");
      if (!granted("Bash")) {
        addDeny("Bash");
        disallowed.push(GROK_SHELL_TOOL);
      }
      if (!granted("Edit")) addDeny("Edit");
      if (!granted("Write")) addDeny("Write");
      if (!granted("Edit") && !granted("Write")) disallowed.push(...GROK_EDIT_TOOLS);
      if (!granted("WebFetch") && !granted("WebSearch")) addDeny("WebFetch");
      if (!granted("MCPTool")) addDeny("MCPTool");
      disableWeb = !granted("WebFetch") && !granted("WebSearch");
      break;
    case "edit":
      args.push("--sandbox", "workspace", "--permission-mode", "acceptEdits");
      if (!granted("Bash")) {
        addDeny("Bash");
        disallowed.push(GROK_SHELL_TOOL);
      }
      if (!granted("WebFetch") && !granted("WebSearch")) addDeny("WebFetch");
      disableWeb = !granted("WebFetch") && !granted("WebSearch");
      break;
    case "full":
      args.push("--always-approve");
      break;
  }

  if (disableWeb) args.push("--disable-web-search");
  if (disallowed.length > 0) args.push("--disallowed-tools", disallowed.join(","));
  for (const rule of dedupe(perms.allow)) args.push("--allow", rule);
  for (const rule of perms.deny) addDeny(rule);
  for (const rule of denies) args.push("--deny", rule);

  return {
    profile: perms.profile,
    args,
    enforcement: "native",
    gaps: [],
    verify: perms.verify && perms.profile === "read-only",
  };
}

/**
 * Providers whose headless mode is all-or-nothing: they pre-approve every tool
 * (that is what makes them usable non-interactively) and expose no flag to take
 * that back. `full` is therefore already satisfied; the restricted profiles are
 * simply not available.
 */
function allOrNothingPlan(provider: AgentProviderId, perms: ResolvedPermissions): PermissionPlan {
  if (perms.profile === "full") {
    return { profile: "full", args: [], enforcement: "native", gaps: [], verify: false };
  }
  const support = PROVIDER_SUPPORT[provider];
  return {
    profile: perms.profile,
    args: [],
    enforcement: "none",
    gaps: [
      `${provider} cannot enforce the '${perms.profile}' profile headlessly (${support.mechanism})`,
    ],
    verify: perms.verify && perms.profile === "read-only",
  };
}

/**
 * Translate a step's resolved permissions into one provider's spawn-time
 * consequences. Pure: the engine decides what to do with `enforcement`, the
 * adapters only splice in `args` (ahead of the author's `extraArgs`, so a
 * hand-written flag still has the last word).
 */
export function permissionPlan(
  provider: AgentProviderId,
  perms: ResolvedPermissions,
): PermissionPlan {
  // Defense in depth for programmatic callers: the zod schema and
  // `validateWorkflow` reject an unknown profile long before this, but a
  // hand-built `PermissionsSpec` with a typo must not reach a provider mapping
  // that has no branch for it. Fail CLOSED — an unrecognized profile becomes an
  // unenforceable one, which `onUnsupported: "fail"` (the default) refuses
  // before the step spawns, rather than silently running unrestricted.
  if (!isPermissionProfile(perms.profile)) {
    return {
      profile: perms.profile,
      args: [],
      enforcement: "none",
      gaps: [
        `unknown permission profile ${JSON.stringify(perms.profile)} (expected ${PERMISSION_PROFILES.join(", ")})`,
      ],
      verify: false,
    };
  }
  switch (provider) {
    case "claude":
      return claudePlan(perms);
    case "codex":
      return codexPlan(perms);
    case "opencode":
    case "mimo":
      return opencodePlan(perms);
    case "grok":
      return grokPlan(perms);
    default:
      return allOrNothingPlan(provider, perms);
  }
}

/** `args` for a provider, or `[]` when the step declared no permissions. */
export function permissionArgs(
  provider: AgentProviderId,
  perms: ResolvedPermissions | undefined,
): string[] {
  if (!perms) return [];
  return permissionPlan(provider, perms).args;
}

/** One-line human label: `read-only` / `read-only +1 allow -2 deny`. */
export function permissionsLabel(perms: ResolvedPermissions): string {
  const bits: string[] = [perms.profile];
  if (perms.allow.length > 0) bits.push(`+${perms.allow.length} allow`);
  if (perms.deny.length > 0) bits.push(`-${perms.deny.length} deny`);
  return bits.join(" ");
}

/** Compact badge for list rows and step trees. */
export function permissionsBadge(profile: PermissionProfile): string {
  switch (profile) {
    case "read-only":
      return "🔒 read-only";
    case "edit":
      return "✎ edit";
    case "full":
      return "⚡ full";
  }
}

/** One-line explanation of what a profile allows, shown next to the badge. */
export function permissionsDescription(profile: PermissionProfile): string {
  switch (profile) {
    case "read-only":
      return "may read and analyze only — no writes, no shell, no network, verified against its workspace afterwards";
    case "edit":
      return "may read and edit files in its own workspace — no network, no unsandboxed shell";
    case "full":
      return "unrestricted: every tool the agent CLI offers is pre-approved";
  }
}
