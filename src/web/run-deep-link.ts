const RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Word chars plus `:`, `.`, and `-` so namespaced / dotted step ids parse cleanly. */
const STEP_ID_PATTERN = /^[\w:.-]+$/;

export interface DeepLink {
  runId: string;
  stepId?: string;
}

export function parseDeepLink(hash: string): DeepLink | null {
  const trimmed = hash.trim();
  const match = /^#run-([^/]+)(?:\/step\/(.+))?$/i.exec(trimmed);
  if (!match || !RUN_ID_PATTERN.test(match[1]!)) return null;
  const runId = match[1]!.toLowerCase();
  const rawStep = match[2];
  // A malformed step id degrades to the run-only link rather than failing the
  // whole parse: the run is still openable and that is the more useful outcome
  // for a truncated or hand-edited URL. The trade-off is that a caller cannot
  // tell "no step in the URL" from "step present but rejected" — nothing needs
  // to today, and both cases want the same behaviour (open the run, no drawer).
  if (rawStep && !STEP_ID_PATTERN.test(rawStep)) return { runId };
  return { runId, stepId: rawStep || undefined };
}

export function parseRunDeepLink(hash: string): string | null {
  const result = parseDeepLink(hash);
  return result ? result.runId : null;
}

export function runDeepLink(runId: string): string {
  return `#run-${runId.toLowerCase()}`;
}

export function approvalDeepLink(runId: string, stepId: string): string {
  return `#run-${runId.toLowerCase()}/step/${stepId}`;
}

/**
 * Settings sections that have a real config API behind them, in nav order. The
 * design draws seven; the five without an API (model bindings, permissions,
 * access & sharing, notifications, cache & worktrees) are deliberately absent
 * rather than rendered as dead tabs. See the design spec §6.
 */
export const SETTINGS_SECTIONS = ["runners", "limits"] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export type Route =
  | { kind: "run"; runId: string; stepId?: string }
  | { kind: "runs"; runId?: string }
  | { kind: "settings"; section: SettingsSection };

/** Parse any recognised hash route. Returns null when the hash is not one. */
export function parseRoute(hash: string): Route | null {
  const trimmed = hash.trim();
  const run = parseDeepLink(trimmed);
  if (run) return { kind: "run", runId: run.runId, stepId: run.stepId };
  // `#runs` (the run browser) cannot collide with `#run-<uuid>` (attach/open a
  // single run): the latter requires the hyphen, so neither prefix-matches the
  // other. They stay separate routes because they do different things — one
  // browses, one resolves a specific run into the cockpit or the receipt.
  const runs = /^#runs(?:\/([^/]*))?$/i.exec(trimmed);
  if (runs) {
    const raw = runs[1] ?? "";
    // An unparseable id degrades to the plain list rather than a dead page.
    return RUN_ID_PATTERN.test(raw) ? { kind: "runs", runId: raw.toLowerCase() } : { kind: "runs" };
  }
  const match = /^#settings(?:\/([\w-]+))?$/i.exec(trimmed);
  if (!match) return null;
  const raw = (match[1] ?? "").toLowerCase();
  const section = (SETTINGS_SECTIONS as readonly string[]).includes(raw)
    ? (raw as SettingsSection)
    : SETTINGS_SECTIONS[0];
  return { kind: "settings", section };
}

export function settingsDeepLink(section: SettingsSection = SETTINGS_SECTIONS[0]): string {
  return `#settings/${section}`;
}

/** The run browser, optionally with one run selected into its receipt rail. */
export function runsDeepLink(runId?: string): string {
  return runId ? `#runs/${runId.toLowerCase()}` : "#runs";
}
