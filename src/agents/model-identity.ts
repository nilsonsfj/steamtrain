import type { AgentProviderId } from "../types/events";
import { modelsForProvider } from "./models";

/**
 * Stable cross-agent identity for a model family (e.g. `claude-opus-4.8`).
 * Workflow authors can name a family by any of its aliases; steamtrain maps
 * that to a concrete agent + native model id at resolve time.
 */
export type ModelFamilyId = string;

/** Built-in role classes workflows may pin instead of a concrete model. */
export type ModelClassId =
  | "thinker"
  | "implementer"
  | "simple"
  | "balanced"
  | "ultrathinker"
  | "reviewer"
  | "deep-reviewer";

export const MODEL_CLASS_IDS: readonly ModelClassId[] = [
  "thinker",
  "implementer",
  "simple",
  "balanced",
  "ultrathinker",
  "reviewer",
  "deep-reviewer",
] as const;

export function isModelClassId(value: string): value is ModelClassId {
  return (MODEL_CLASS_IDS as readonly string[]).includes(value);
}

/** One concrete way to run a model family on a specific agent provider. */
export interface ModelOffering {
  provider: AgentProviderId;
  /** Native model id accepted by this provider's CLI. */
  modelId: string;
  /** True when this provider is the "home" / reference agent for the family. */
  reference: boolean;
}

/** Canonical model family with aliases and cross-agent offerings. */
export interface ModelFamily {
  id: ModelFamilyId;
  name: string;
  /** Human-typed aliases and alternate spellings (normalized at match time). */
  aliases: readonly string[];
  offerings: readonly ModelOffering[];
  /** Role classes this family satisfies (first is the strongest fit). */
  classes: readonly ModelClassId[];
}

/**
 * Normalize a free-form model query for matching.
 * `"Opus 4.8"`, `"claude-opus-4-8"`, `"opencode/claude-opus-4-8"` collapse
 * toward comparable tokens.
 */
export function normalizeModelQuery(raw: string): string {
  return (
    raw
      .trim()
      .toLowerCase()
      // Strip Claude context-window suffix (`claude-opus-4-8[1m]`) before the
      // general bracket scrub below, which would otherwise leave a stray `1m`.
      .replace(/\[1m\]$/i, "")
      .replace(/\([^)]*\)/g, " ")
      .replace(/thinking[-_]?high/g, " ")
      .replace(/[\[\]]/g, " ")
      .replace(/[_/·]+/g, "-")
      .replace(/\.+/g, ".")
      .replace(/\s+/g, " ")
      .replace(/\s*-\s*/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .trim()
  );
}

/** Compact form with spaces removed (`opus 4.8` → `opus4.8`). */
export function compactModelQuery(raw: string): string {
  return normalizeModelQuery(raw).replace(/[\s.-]/g, "");
}

/** Seed used to build the built-in family registry. */
interface FamilySeed {
  id: ModelFamilyId;
  name: string;
  aliases: string[];
  reference: { provider: AgentProviderId; modelId: string };
  also?: Partial<Record<AgentProviderId, readonly string[]>>;
  classes: ModelClassId[];
}

/**
 * Built-in family seeds. Reference offerings name the preferred home agent;
 * `also` lists known native ids on other agents. Catalog auto-discovery
 * (below) fills additional matches from live/static provider catalogs.
 */
const FAMILY_SEEDS: readonly FamilySeed[] = [
  // ── Claude frontier ──────────────────────────────────────────────────
  {
    id: "claude-fable-5.1",
    name: "Claude Fable 5.1",
    aliases: ["fable 5.1", "fable-5.1", "claude fable 5.1", "claude-fable-5-1"],
    reference: { provider: "claude", modelId: "claude-fable-5-1" },
    also: { opencode: ["opencode/claude-fable-5-1"] },
    classes: ["ultrathinker", "thinker", "deep-reviewer", "implementer"],
  },
  {
    id: "claude-opus-5.5",
    name: "Claude Opus 5.5",
    aliases: ["opus 5.5", "opus-5.5", "opus5.5", "claude opus 5.5", "claude-opus-5-5"],
    reference: { provider: "claude", modelId: "claude-opus-5-5" },
    also: { opencode: ["opencode/claude-opus-5-5"] },
    classes: ["deep-reviewer", "reviewer", "thinker", "implementer", "ultrathinker"],
  },
  {
    id: "claude-fable-5",
    name: "Claude Fable 5",
    aliases: ["fable", "fable 5", "claude fable 5", "claude-fable-5"],
    reference: { provider: "claude", modelId: "claude-fable-5" },
    also: {
      claude: ["fable", "fable[1m]", "claude-fable-5[1m]"],
      opencode: ["opencode/claude-fable-5"],
      cursor: ["claude-fable-5-thinking-high"],
    },
    classes: ["ultrathinker", "thinker", "deep-reviewer", "implementer"],
  },
  {
    id: "claude-opus-5",
    name: "Claude Opus 5",
    aliases: ["opus 5", "opus-5", "opus5", "claude opus 5", "claude-opus-5", "opus"],
    reference: { provider: "claude", modelId: "claude-opus-5" },
    also: {
      claude: ["opus", "opus[1m]", "claude-opus-5[1m]"],
      opencode: ["opencode/claude-opus-5"],
      kiro: ["claude-opus-5"],
      cursor: ["claude-opus-5-thinking-high"],
    },
    classes: ["deep-reviewer", "reviewer", "thinker", "implementer", "ultrathinker"],
  },
  {
    id: "claude-opus-4.8",
    name: "Claude Opus 4.8",
    aliases: [
      "opus 4.8",
      "opus-4.8",
      "opus4.8",
      "claude opus 4.8",
      "claude-opus-4-8",
      "claude-opus-4.8",
    ],
    reference: { provider: "claude", modelId: "claude-opus-4-8" },
    also: {
      claude: ["claude-opus-4-8[1m]"],
      opencode: ["opencode/claude-opus-4-8"],
      // Kiro uses dotted version ids (`claude-opus-4.8`), not Claude dashes
      // or short aliases (`opus` / `haiku`).
      kiro: ["claude-opus-4.8"],
      cursor: ["claude-opus-4-8-thinking-high"],
    },
    classes: ["deep-reviewer", "reviewer", "thinker"],
  },
  {
    id: "claude-opus-4.7",
    name: "Claude Opus 4.7",
    aliases: ["opus 4.7", "opus-4.7", "claude opus 4.7", "claude-opus-4-7", "claude-opus-4.7"],
    reference: { provider: "claude", modelId: "claude-opus-4-7" },
    also: {
      claude: ["claude-opus-4-7[1m]"],
      opencode: ["opencode/claude-opus-4-7"],
      kiro: ["claude-opus-4.7"],
    },
    classes: ["thinker"],
  },
  {
    id: "claude-opus-4.6",
    name: "Claude Opus 4.6",
    aliases: ["opus 4.6", "opus-4.6", "claude opus 4.6", "claude-opus-4-6", "claude-opus-4.6"],
    reference: { provider: "claude", modelId: "claude-opus-4-6" },
    also: {
      opencode: ["opencode/claude-opus-4-6"],
      kiro: ["claude-opus-4.6"],
      antigravity: [
        "claude-opus-4-6-thinking",
        "claude-opus-4-6",
        "Claude Opus 4.6",
        "Claude Opus 4.6 (Thinking)",
      ],
    },
    classes: ["thinker"],
  },
  {
    id: "claude-opus-4.5",
    name: "Claude Opus 4.5",
    aliases: ["opus 4.5", "opus-4.5", "claude opus 4.5", "claude-opus-4-5", "claude-opus-4.5"],
    reference: { provider: "claude", modelId: "claude-opus-4-5" },
    also: {
      opencode: ["opencode/claude-opus-4-5"],
      kiro: ["claude-opus-4.5"],
    },
    classes: ["thinker"],
  },
  {
    id: "claude-sonnet-5",
    name: "Claude Sonnet 5",
    aliases: ["sonnet 5", "sonnet-5", "claude sonnet 5", "claude-sonnet-5", "sonnet"],
    reference: { provider: "claude", modelId: "claude-sonnet-5" },
    also: {
      claude: ["sonnet", "sonnet[1m]", "claude-sonnet-5[1m]"],
      opencode: ["opencode/claude-sonnet-5"],
      kiro: ["claude-sonnet-5"],
      cursor: ["claude-sonnet-5-high"],
    },
    classes: ["implementer", "balanced"],
  },
  {
    id: "claude-sonnet-4.6",
    name: "Claude Sonnet 4.6",
    aliases: [
      "sonnet 4.6",
      "sonnet-4.6",
      "claude sonnet 4.6",
      "claude-sonnet-4-6",
      "claude-sonnet-4.6",
    ],
    reference: { provider: "claude", modelId: "claude-sonnet-4-6" },
    also: {
      claude: ["claude-sonnet-4-6[1m]"],
      opencode: ["opencode/claude-sonnet-4-6"],
      kiro: ["claude-sonnet-4.6"],
      antigravity: ["claude-sonnet-4-6", "Claude Sonnet 4.6", "Claude Sonnet 4.6 (Thinking)"],
    },
    classes: ["implementer", "balanced"],
  },
  {
    id: "claude-sonnet-4.5",
    name: "Claude Sonnet 4.5",
    aliases: [
      "sonnet 4.5",
      "sonnet-4.5",
      "claude sonnet 4.5",
      "claude-sonnet-4-5",
      "claude-sonnet-4.5",
    ],
    reference: { provider: "claude", modelId: "claude-sonnet-4-5" },
    also: {
      opencode: ["opencode/claude-sonnet-4-5"],
      kiro: ["claude-sonnet-4.5"],
    },
    classes: ["implementer", "balanced"],
  },
  {
    id: "claude-haiku-4.5",
    name: "Claude Haiku 4.5",
    aliases: [
      "haiku 4.5",
      "haiku-4.5",
      "claude haiku 4.5",
      "claude-haiku-4-5",
      "claude-haiku-4.5",
      "haiku",
    ],
    reference: { provider: "claude", modelId: "claude-haiku-4-5" },
    also: {
      claude: ["haiku", "claude-haiku-4-5-20251001"],
      opencode: ["opencode/claude-haiku-4-5"],
      kiro: ["claude-haiku-4.5"],
    },
    classes: ["simple"],
  },
  {
    id: "claude-mythos-5",
    name: "Claude Mythos 5",
    aliases: ["mythos", "mythos 5", "claude mythos 5", "claude-mythos-5"],
    reference: { provider: "claude", modelId: "claude-mythos-5" },
    classes: ["thinker"],
  },

  // ── GPT / Codex ──────────────────────────────────────────────────────
  {
    id: "gpt-6-astra",
    name: "GPT-6 Astra",
    aliases: ["gpt 6 astra", "gpt-6-astra", "gpt6astra"],
    reference: { provider: "codex", modelId: "gpt-6-astra" },
    also: { opencode: ["opencode/gpt-6-astra"] },
    classes: ["ultrathinker", "deep-reviewer", "thinker"],
  },
  {
    id: "gpt-6-sol",
    name: "GPT-6 Sol",
    aliases: ["gpt 6 sol", "gpt-6-sol", "gpt6sol", "gpt-6"],
    reference: { provider: "codex", modelId: "gpt-6-sol" },
    also: { opencode: ["opencode/gpt-6-sol"] },
    classes: ["implementer", "balanced", "reviewer", "thinker"],
  },
  {
    id: "gpt-6-luna",
    name: "GPT-6 Luna",
    aliases: ["gpt 6 luna", "gpt-6-luna", "gpt6luna"],
    reference: { provider: "codex", modelId: "gpt-6-luna" },
    also: { opencode: ["opencode/gpt-6-luna"] },
    classes: ["simple", "balanced"],
  },
  {
    id: "gpt-5.6-sol",
    name: "GPT-5.6 Sol",
    aliases: ["gpt 5.6 sol", "gpt-5.6-sol", "gpt5.6sol", "gpt-5.6"],
    reference: { provider: "codex", modelId: "gpt-5.6-sol" },
    also: {
      opencode: ["opencode/gpt-5.6-sol"],
      cursor: ["gpt-5.6-sol"],
      kiro: ["gpt-5.6-sol"],
    },
    classes: ["ultrathinker", "deep-reviewer", "thinker", "reviewer"],
  },
  {
    id: "gpt-5.6-terra",
    name: "GPT-5.6 Terra",
    aliases: ["gpt 5.6 terra", "gpt-5.6-terra", "gpt5.6terra"],
    reference: { provider: "codex", modelId: "gpt-5.6-terra" },
    also: {
      opencode: ["opencode/gpt-5.6-terra"],
      cursor: ["gpt-5.6-terra"],
      kiro: ["gpt-5.6-terra"],
    },
    classes: ["implementer", "balanced", "reviewer"],
  },
  {
    id: "gpt-5.6-luna",
    name: "GPT-5.6 Luna",
    aliases: ["gpt 5.6 luna", "gpt-5.6-luna", "gpt5.6luna"],
    reference: { provider: "codex", modelId: "gpt-5.6-luna" },
    also: {
      opencode: ["opencode/gpt-5.6-luna"],
      cursor: ["gpt-5.6-luna"],
      kiro: ["gpt-5.6-luna"],
    },
    classes: ["thinker", "balanced", "simple"],
  },
  {
    id: "gpt-5.5",
    name: "GPT-5.5",
    aliases: ["gpt 5.5", "gpt-5.5", "gpt5.5"],
    reference: { provider: "codex", modelId: "gpt-5.5" },
    also: {
      opencode: ["opencode/gpt-5.5"],
      cursor: ["gpt-5.5-high"],
    },
    classes: ["thinker", "implementer", "balanced", "deep-reviewer"],
  },
  {
    id: "gpt-5.5-pro",
    name: "GPT-5.5 Pro",
    aliases: ["gpt 5.5 pro", "gpt-5.5-pro", "gpt5.5pro"],
    reference: { provider: "opencode", modelId: "opencode/gpt-5.5-pro" },
    classes: ["thinker"],
  },
  {
    id: "gpt-5.4",
    name: "GPT-5.4",
    aliases: ["gpt 5.4", "gpt-5.4", "gpt5.4"],
    // Removed from live `codex debug models` (0.145); still on OpenCode Zen.
    reference: { provider: "opencode", modelId: "opencode/gpt-5.4" },
    also: { opencode: ["opencode/gpt-5.4"] },
    classes: ["implementer", "balanced"],
  },
  {
    id: "gpt-5.4-mini",
    name: "GPT-5.4 Mini",
    aliases: ["gpt 5.4 mini", "gpt-5.4-mini", "gpt5.4mini"],
    // Removed from live `codex debug models` (0.145); still on OpenCode Zen.
    reference: { provider: "opencode", modelId: "opencode/gpt-5.4-mini" },
    also: { opencode: ["opencode/gpt-5.4-mini"] },
    classes: ["simple", "balanced"],
  },
  {
    id: "gpt-5.4-nano",
    name: "GPT-5.4 Nano",
    aliases: ["gpt 5.4 nano", "gpt-5.4-nano", "gpt5.4nano"],
    reference: { provider: "opencode", modelId: "opencode/gpt-5.4-nano" },
    classes: ["simple"],
  },
  {
    id: "gpt-5.3-codex",
    name: "GPT-5.3 Codex",
    aliases: ["gpt 5.3 codex", "gpt-5.3-codex", "codex 5.3", "5.3-codex"],
    // Removed from live `codex debug models` (0.145); still on OpenCode Zen.
    reference: { provider: "opencode", modelId: "opencode/gpt-5.3-codex" },
    also: { opencode: ["opencode/gpt-5.3-codex"] },
    classes: ["implementer"],
  },
  {
    id: "gpt-5.3-codex-spark",
    name: "GPT-5.3 Codex Spark",
    aliases: ["gpt-5.3-codex-spark", "codex spark", "5.3-codex-spark"],
    reference: { provider: "opencode", modelId: "opencode/gpt-5.3-codex-spark" },
    also: { opencode: ["opencode/gpt-5.3-codex-spark"] },
    classes: ["implementer", "simple"],
  },
  {
    id: "gpt-5.2",
    name: "GPT-5.2",
    aliases: ["gpt 5.2", "gpt-5.2", "gpt5.2"],
    // Removed from live `codex debug models` (0.145); still on OpenCode Zen.
    reference: { provider: "opencode", modelId: "opencode/gpt-5.2" },
    also: {
      opencode: ["opencode/gpt-5.2"],
      cursor: ["gpt-5.2"],
    },
    classes: ["balanced", "implementer"],
  },
  {
    id: "gpt-5.2-codex",
    name: "GPT-5.2 Codex",
    aliases: ["gpt-5.2-codex", "codex 5.2"],
    // Removed from live `codex debug models` (0.145); still on OpenCode Zen.
    reference: { provider: "opencode", modelId: "opencode/gpt-5.2-codex" },
    also: { opencode: ["opencode/gpt-5.2-codex"] },
    classes: ["implementer"],
  },
  {
    id: "gpt-5.1",
    name: "GPT-5.1",
    aliases: ["gpt 5.1", "gpt-5.1", "gpt5.1"],
    // Removed from live `codex debug models` (0.145); still on OpenCode Zen.
    reference: { provider: "opencode", modelId: "opencode/gpt-5.1" },
    also: { opencode: ["opencode/gpt-5.1"] },
    classes: ["balanced"],
  },
  {
    id: "gpt-5.1-codex",
    name: "GPT-5.1 Codex",
    aliases: ["gpt-5.1-codex", "codex 5.1"],
    // Removed from live `codex debug models` (0.145); still on OpenCode Zen.
    reference: { provider: "opencode", modelId: "opencode/gpt-5.1-codex" },
    also: { opencode: ["opencode/gpt-5.1-codex"] },
    classes: ["implementer"],
  },
  {
    id: "gpt-5",
    name: "GPT-5",
    aliases: ["gpt 5", "gpt-5", "gpt5"],
    // Removed from live `codex debug models` (0.145); still on OpenCode Zen.
    reference: { provider: "opencode", modelId: "opencode/gpt-5" },
    also: { opencode: ["opencode/gpt-5"] },
    classes: ["balanced"],
  },
  {
    id: "gpt-5-codex",
    name: "GPT-5 Codex",
    aliases: ["gpt-5-codex", "codex 5"],
    // Removed from live `codex debug models` (0.145); still on OpenCode Zen.
    reference: { provider: "opencode", modelId: "opencode/gpt-5-codex" },
    also: { opencode: ["opencode/gpt-5-codex"] },
    classes: ["implementer"],
  },

  // ── Gemini ───────────────────────────────────────────────────────────
  {
    id: "gemini-3.8-flash",
    name: "Gemini 3.8 Flash",
    aliases: ["gemini 3.8 flash", "gemini-3.8-flash", "gemini 3.8", "gemini-3.8"],
    reference: { provider: "antigravity", modelId: "gemini-3.8-flash-high" },
    also: {
      antigravity: [
        "gemini-3.8-flash",
        "gemini-3.8-flash-medium",
        "gemini-3.8-flash-low",
        "Gemini 3.8 Flash",
        "Gemini 3.8 Flash (High)",
        "Gemini 3.8 Flash (Medium)",
        "Gemini 3.8 Flash (Low)",
      ],
      opencode: ["opencode/gemini-3.8-flash"],
    },
    classes: ["simple", "balanced", "implementer"],
  },
  {
    id: "gemini-3.7-flash",
    name: "Gemini 3.7 Flash",
    aliases: ["gemini 3.7 flash", "gemini-3.7-flash", "gemini 3.7", "gemini-3.7"],
    reference: { provider: "antigravity", modelId: "gemini-3.7-flash-high" },
    also: {
      antigravity: [
        "gemini-3.7-flash",
        "gemini-3.7-flash-medium",
        "gemini-3.7-flash-low",
        "Gemini 3.7 Flash",
        "Gemini 3.7 Flash (High)",
        "Gemini 3.7 Flash (Medium)",
        "Gemini 3.7 Flash (Low)",
      ],
      opencode: ["opencode/gemini-3.7-flash"],
    },
    classes: ["simple", "balanced", "implementer"],
  },
  {
    id: "gemini-3.6-flash",
    name: "Gemini 3.6 Flash",
    aliases: ["gemini 3.6 flash", "gemini-3.6-flash", "gemini flash", "gemini 3.6", "gemini-3.6"],
    // agy requires an effort on Gemini bases (`--effort` or a `-high|-medium|-low` slug).
    reference: { provider: "antigravity", modelId: "gemini-3.6-flash-high" },
    also: {
      antigravity: [
        "gemini-3.6-flash",
        "gemini-3.6-flash-medium",
        "gemini-3.6-flash-low",
        "Gemini 3.6 Flash",
        "Gemini 3.6 Flash (High)",
        "Gemini 3.6 Flash (Medium)",
        "Gemini 3.6 Flash (Low)",
      ],
      opencode: ["opencode/gemini-3.6-flash"],
      cursor: [
        "gemini-3.6-flash-high",
        "gemini-3.6-flash-medium",
        "gemini-3.6-flash-low",
        "gemini-3.6-flash-minimal",
      ],
    },
    classes: ["simple", "balanced", "implementer"],
  },
  {
    id: "gemini-3.5-flash",
    name: "Gemini 3.5 Flash",
    aliases: ["gemini 3.5 flash", "gemini-3.5-flash"],
    // agy 1.2 no longer lists 3.5 Flash; OpenCode Zen still serves it.
    reference: { provider: "opencode", modelId: "opencode/gemini-3.5-flash" },
    also: {
      antigravity: [
        "gemini-3.5-flash",
        "gemini-3.5-flash-medium",
        "gemini-3.5-flash-low",
        "Gemini 3.5 Flash",
        "Gemini 3.5 Flash (High)",
        "Gemini 3.5 Flash (Medium)",
        "Gemini 3.5 Flash (Low)",
      ],
      opencode: ["opencode/gemini-3.5-flash"],
      cursor: ["gemini-3.5-flash"],
    },
    classes: ["simple", "balanced"],
  },
  {
    id: "gemini-3.5-flash-lite",
    name: "Gemini 3.5 Flash-Lite",
    aliases: [
      "gemini 3.5 flash lite",
      "gemini 3.5 flash-lite",
      "gemini-3.5-flash-lite",
      "gemini flash lite",
    ],
    reference: { provider: "opencode", modelId: "opencode/gemini-3.5-flash-lite" },
    classes: ["simple"],
  },
  {
    id: "gemini-3.1-pro",
    name: "Gemini 3.1 Pro",
    aliases: ["gemini 3.1 pro", "gemini-3.1-pro", "gemini 3.1"],
    reference: { provider: "antigravity", modelId: "gemini-3.1-pro-high" },
    also: {
      antigravity: [
        "gemini-3.1-pro",
        "gemini-3.1-pro-low",
        "Gemini 3.1 Pro",
        "Gemini 3.1 Pro (High)",
        "Gemini 3.1 Pro (Low)",
      ],
      opencode: ["opencode/gemini-3.1-pro"],
      cursor: ["gemini-3.1-pro"],
    },
    classes: ["thinker", "balanced"],
  },
  {
    id: "gemini-3-flash",
    name: "Gemini 3 Flash",
    aliases: ["gemini 3 flash", "gemini-3-flash"],
    reference: { provider: "opencode", modelId: "opencode/gemini-3-flash" },
    also: { cursor: ["gemini-3-flash"] },
    classes: ["simple"],
  },

  // ── Cursor Composer / Grok ───────────────────────────────────────────
  {
    id: "composer-2.5",
    name: "Composer 2.5",
    aliases: ["composer", "composer 2.5", "composer-2.5"],
    reference: { provider: "cursor", modelId: "composer-2.5" },
    also: { cursor: ["composer-2.5-fast"] },
    classes: ["implementer", "balanced"],
  },
  {
    id: "composer-2.5-fast",
    name: "Composer 2.5 Fast",
    aliases: ["composer fast", "composer-2.5-fast"],
    reference: { provider: "cursor", modelId: "composer-2.5-fast" },
    classes: ["simple", "implementer"],
  },
  {
    id: "cursor-grok-4.5",
    name: "Cursor Grok 4.5",
    aliases: ["grok 4.5", "grok-4.5", "cursor-grok-4.5", "cursor-grok-4.5-high"],
    reference: { provider: "cursor", modelId: "cursor-grok-4.5-high" },
    also: { cursor: ["grok-4.5"] },
    classes: ["thinker", "implementer"],
  },
  {
    id: "cursor-auto",
    name: "Cursor Auto",
    aliases: ["cursor auto", "auto"],
    reference: { provider: "cursor", modelId: "auto" },
    also: { kiro: ["auto"] },
    classes: ["balanced", "simple"],
  },

  // ── Amp modes ────────────────────────────────────────────────────────
  {
    id: "amp-smart",
    name: "Amp Smart",
    aliases: ["amp smart", "smart"],
    reference: { provider: "amp", modelId: "smart" },
    classes: ["balanced", "implementer"],
  },
  {
    id: "amp-deep",
    name: "Amp Deep",
    aliases: ["amp deep", "deep"],
    reference: { provider: "amp", modelId: "deep" },
    classes: ["thinker"],
  },
  {
    id: "amp-rush",
    name: "Amp Rush",
    aliases: ["amp rush", "rush"],
    reference: { provider: "amp", modelId: "rush" },
    classes: ["simple"],
  },

  // ── Kimi / DeepSeek / Qwen ───────────────────────────────────────────
  {
    id: "kimi-k3",
    name: "Kimi K3",
    aliases: ["kimi k3", "kimi-k3", "kimik3"],
    reference: { provider: "opencode", modelId: "opencode-go/kimi-k3" },
    also: {
      opencode: ["opencode/kimi-k3"],
      kimi: ["kimi-code/k3", "kimi-code/k3-256k"],
    },
    classes: ["ultrathinker", "thinker"],
  },
  {
    id: "kimi-k2.7-code",
    name: "Kimi K2.7 Code",
    aliases: ["kimi k2.7 code", "kimi-k2.7-code", "kimi-k2.7", "kimi-for-coding"],
    reference: { provider: "opencode", modelId: "opencode/kimi-k2.7-code" },
    also: { opencode: ["opencode-go/kimi-k2.7-code"], kimi: ["kimi-code/kimi-for-coding"] },
    classes: ["implementer", "reviewer"],
  },
  {
    id: "kimi-k2.7-code-highspeed",
    name: "Kimi K2.7 Code Highspeed",
    aliases: ["kimi k2.7 highspeed", "kimi-for-coding-highspeed", "kimi highspeed"],
    reference: { provider: "kimi", modelId: "kimi-code/kimi-for-coding-highspeed" },
    classes: ["implementer", "reviewer"],
  },
  {
    id: "deepseek-v4-pro",
    name: "DeepSeek V4 Pro",
    aliases: [
      "deepseek pro",
      "deepseek v4 pro",
      "deepseek-v4-pro",
      "opencode/deepseek-v4-pro",
      "opencode-go/deepseek-v4-pro",
    ],
    reference: { provider: "opencode", modelId: "opencode/deepseek-v4-pro" },
    also: { opencode: ["opencode-go/deepseek-v4-pro"] },
    classes: ["reviewer", "implementer", "balanced"],
  },
  {
    id: "qwen-3.7-max",
    name: "Qwen 3.7 Max",
    aliases: ["qwen 3.7 max", "qwen3.7-max", "qwen-3.7-max", "opencode-go/qwen3.7-max"],
    reference: { provider: "opencode", modelId: "opencode-go/qwen3.7-max" },
    classes: ["reviewer", "implementer", "balanced"],
  },
  {
    id: "codex-auto-review",
    name: "Codex Auto Review",
    aliases: ["codex auto review", "codex-auto-review", "auto-review"],
    reference: { provider: "codex", modelId: "codex-auto-review" },
    classes: ["reviewer"],
  },

  // ── MiMo Code (Xiaomi CLI) ───────────────────────────────────────────
  {
    id: "mimo-auto",
    name: "MiMo Auto",
    aliases: ["mimo auto", "mimo-auto", "mimo/mimo-auto", "auto mimo"],
    reference: { provider: "mimo", modelId: "mimo/mimo-auto" },
    classes: ["simple", "balanced", "implementer"],
  },
  {
    id: "mimo-v2.6-flash",
    name: "MiMo-V2.6-Flash",
    aliases: ["mimo v2.6 flash", "mimo-v2.6-flash", "xiaomi/mimo-v2.6-flash"],
    reference: { provider: "mimo", modelId: "xiaomi/mimo-v2.6-flash" },
    also: { opencode: ["opencode-go/mimo-v2.6-flash"] },
    classes: ["simple", "balanced", "implementer"],
  },
  {
    id: "mimo-v2.6-pro",
    name: "MiMo-V2.6-Pro",
    aliases: ["mimo v2.6 pro", "mimo-v2.6-pro", "xiaomi/mimo-v2.6-pro"],
    reference: { provider: "mimo", modelId: "xiaomi/mimo-v2.6-pro" },
    also: { opencode: ["opencode-go/mimo-v2.6-pro"] },
    classes: ["thinker", "implementer", "reviewer", "balanced"],
  },
  {
    id: "mimo-v2.5",
    name: "MiMo-V2.5",
    aliases: ["mimo v2.5", "mimo-v2.5", "xiaomi/mimo-v2.5"],
    reference: { provider: "mimo", modelId: "xiaomi/mimo-v2.5" },
    also: { opencode: ["opencode-go/mimo-v2.5"] },
    classes: ["balanced", "implementer", "reviewer"],
  },
  {
    id: "mimo-v2.5-pro",
    name: "MiMo-V2.5-Pro",
    aliases: ["mimo v2.5 pro", "mimo-v2.5-pro", "xiaomi/mimo-v2.5-pro", "mimo/mimo-v2.5-pro"],
    reference: { provider: "mimo", modelId: "xiaomi/mimo-v2.5-pro" },
    also: { opencode: ["opencode-go/mimo-v2.5-pro"] },
    classes: ["thinker", "implementer", "reviewer", "balanced"],
  },
  {
    id: "mimo-v2.5-pro-ultraspeed",
    name: "MiMo-V2.5-Pro-UltraSpeed",
    aliases: ["mimo ultraspeed", "mimo-v2.5-pro-ultraspeed", "xiaomi/mimo-v2.5-pro-ultraspeed"],
    reference: { provider: "mimo", modelId: "xiaomi/mimo-v2.5-pro-ultraspeed" },
    classes: ["thinker", "implementer"],
  },

  // ── OpenCode free / specialty ────────────────────────────────────────
  {
    id: "mimo-v2.6-flash-free",
    name: "MiMo V2.6 Flash Free",
    // The retired mimo-v2.5-free ids resolve here so configs that still name
    // them keep running on its successor.
    aliases: [
      "mimo free",
      "mimo-v2.6-flash-free",
      "opencode/mimo-v2.6-flash-free",
      "mimo-v2.5-free",
      "opencode/mimo-v2.5-free",
    ],
    reference: { provider: "opencode", modelId: "opencode/mimo-v2.6-flash-free" },
    classes: ["simple", "balanced"],
  },
  {
    id: "nemotron-3.5-lightning-free",
    name: "Nemotron 3.5 Lightning Free",
    aliases: ["nemotron lightning", "nemotron-3.5-lightning-free"],
    reference: { provider: "opencode", modelId: "opencode/nemotron-3.5-lightning-free" },
    classes: ["simple"],
  },
  {
    id: "nemotron-3-ultra-free",
    name: "Nemotron 3 Ultra Free",
    aliases: ["nemotron free", "nemotron-3-ultra-free"],
    reference: { provider: "opencode", modelId: "opencode/nemotron-3-ultra-free" },
    classes: ["simple"],
  },
];

/**
 * Preference order when multiple non-reference offerings exist for a family.
 * Reference offerings always win first; this order breaks remaining ties.
 */
export const AGENT_PREFERENCE_ORDER: readonly AgentProviderId[] = [
  "claude",
  "codex",
  "cursor",
  "opencode",
  "mimo",
  "kimi",
  "antigravity",
  "kiro",
  "amp",
];

function offeringKey(provider: AgentProviderId, modelId: string): string {
  return `${provider}::${modelId}`;
}

function buildOfferings(seed: FamilySeed): ModelOffering[] {
  const seen = new Set<string>();
  const out: ModelOffering[] = [];

  const add = (provider: AgentProviderId, modelId: string, reference: boolean) => {
    const key = offeringKey(provider, modelId);
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ provider, modelId, reference });
  };

  add(seed.reference.provider, seed.reference.modelId, true);
  if (seed.also) {
    for (const [provider, ids] of Object.entries(seed.also) as [
      AgentProviderId,
      readonly string[],
    ][]) {
      for (const modelId of ids) {
        add(provider, modelId, provider === seed.reference.provider);
      }
    }
  }

  // Auto-discover additional catalog ids whose normalized form matches this family.
  const familyTokens = new Set<string>([
    normalizeModelQuery(seed.id),
    compactModelQuery(seed.id),
    ...seed.aliases.map(normalizeModelQuery),
    ...seed.aliases.map(compactModelQuery),
    normalizeModelQuery(seed.reference.modelId),
    compactModelQuery(seed.reference.modelId),
  ]);

  for (const provider of AGENT_PREFERENCE_ORDER) {
    for (const model of modelsForProvider(provider)) {
      const n = normalizeModelQuery(model.id);
      const c = compactModelQuery(model.id);
      const nameN = normalizeModelQuery(model.name);
      const nameC = compactModelQuery(model.name);
      if (
        familyTokens.has(n) ||
        familyTokens.has(c) ||
        familyTokens.has(nameN) ||
        familyTokens.has(nameC)
      ) {
        add(provider, model.id, provider === seed.reference.provider);
      }
    }
  }

  // Canonical reference modelId first, then other reference-provider
  // offerings, then preference order, stable by modelId. Without the
  // canonical tie-break, localeCompare among reference:true rows could
  // prefer a legacy display label ("Gemini 3.6 Flash") over the slug.
  out.sort((a, b) => {
    const aCanon =
      a.provider === seed.reference.provider && a.modelId === seed.reference.modelId ? 0 : 1;
    const bCanon =
      b.provider === seed.reference.provider && b.modelId === seed.reference.modelId ? 0 : 1;
    if (aCanon !== bCanon) return aCanon - bCanon;
    if (a.reference !== b.reference) return a.reference ? -1 : 1;
    const ap = AGENT_PREFERENCE_ORDER.indexOf(a.provider);
    const bp = AGENT_PREFERENCE_ORDER.indexOf(b.provider);
    if (ap !== bp) return (ap === -1 ? 99 : ap) - (bp === -1 ? 99 : bp);
    return a.modelId.localeCompare(b.modelId);
  });

  return out;
}

let cachedFamilies: readonly ModelFamily[] | undefined;

/** Built-in model family registry (lazy, catalog-aware). */
export function modelFamilies(): readonly ModelFamily[] {
  if (cachedFamilies) return cachedFamilies;
  cachedFamilies = FAMILY_SEEDS.map((seed) => ({
    id: seed.id,
    name: seed.name,
    aliases: seed.aliases,
    offerings: buildOfferings(seed),
    classes: seed.classes,
  }));
  return cachedFamilies;
}

/** Test helper: drop the lazy family cache after catalog mutations. */
export function clearModelFamilyCacheForTests(): void {
  cachedFamilies = undefined;
  aliasIndexCache = undefined;
}

type AliasHit = { family: ModelFamily; score: number };

let aliasIndexCache:
  | {
      byNormalized: Map<string, AliasHit[]>;
      byCompact: Map<string, AliasHit[]>;
    }
  | undefined;

function aliasIndex() {
  if (aliasIndexCache) return aliasIndexCache;
  const byNormalized = new Map<string, AliasHit[]>();
  const byCompact = new Map<string, AliasHit[]>();

  const push = (map: Map<string, AliasHit[]>, key: string, hit: AliasHit) => {
    if (!key) return;
    const list = map.get(key) ?? [];
    list.push(hit);
    map.set(key, list);
  };

  for (const family of modelFamilies()) {
    push(byNormalized, normalizeModelQuery(family.id), { family, score: 100 });
    push(byCompact, compactModelQuery(family.id), { family, score: 100 });
    push(byNormalized, normalizeModelQuery(family.name), { family, score: 95 });
    push(byCompact, compactModelQuery(family.name), { family, score: 95 });
    for (const alias of family.aliases) {
      // Short aliases like "opus" / "sonnet" / "auto" score lower so exact
      // versioned queries win when multiple families share a stem.
      const short = normalizeModelQuery(alias).split(/[\s-]/).length <= 1;
      const score = short ? 60 : 90;
      push(byNormalized, normalizeModelQuery(alias), { family, score });
      push(byCompact, compactModelQuery(alias), { family, score });
    }
    for (const offering of family.offerings) {
      push(byNormalized, normalizeModelQuery(offering.modelId), { family, score: 85 });
      push(byCompact, compactModelQuery(offering.modelId), { family, score: 85 });
    }
  }

  aliasIndexCache = { byNormalized, byCompact };
  return aliasIndexCache;
}

/**
 * Resolve a free-form model query to the best matching family, if any.
 * Prefers exact / high-score alias hits over short ambiguous stems.
 */
export function findModelFamily(query: string): ModelFamily | undefined {
  const trimmed = query.trim();
  if (!trimmed) return undefined;
  const index = aliasIndex();
  const n = normalizeModelQuery(trimmed);
  const c = compactModelQuery(trimmed);

  const hits = [...(index.byNormalized.get(n) ?? []), ...(index.byCompact.get(c) ?? [])];
  if (hits.length === 0) return undefined;

  hits.sort((a, b) => b.score - a.score);
  return hits[0]?.family;
}

/** Look up a family by its stable id. */
export function modelFamilyById(id: ModelFamilyId): ModelFamily | undefined {
  return modelFamilies().find((family) => family.id === id);
}

/**
 * Families that declare membership in a model class, ordered by how well they
 * fit (classes[0] is the strongest fit) then by registry order.
 */
export function familiesForClass(classId: ModelClassId): ModelFamily[] {
  return modelFamilies()
    .filter((family) => family.classes.includes(classId))
    .sort((a, b) => {
      const ai = a.classes.indexOf(classId);
      const bi = b.classes.indexOf(classId);
      if (ai !== bi) return ai - bi;
      return 0;
    });
}

/**
 * Find every catalog model id (across all providers) that matches a query,
 * even when it is not yet registered as a family offering. Useful for
 * custom / live-discovered models.
 */
export function findDirectCatalogMatches(
  query: string,
): Array<{ provider: AgentProviderId; modelId: string; name: string }> {
  const n = normalizeModelQuery(query);
  const c = compactModelQuery(query);
  const out: Array<{ provider: AgentProviderId; modelId: string; name: string }> = [];
  for (const provider of AGENT_PREFERENCE_ORDER) {
    for (const model of modelsForProvider(provider)) {
      if (
        normalizeModelQuery(model.id) === n ||
        compactModelQuery(model.id) === c ||
        normalizeModelQuery(model.name) === n ||
        compactModelQuery(model.name) === c
      ) {
        out.push({ provider, modelId: model.id, name: model.name });
      }
    }
  }
  return out;
}

/** Map a native model id on a provider back to its family, when known. */
export function familyForProviderModel(
  provider: AgentProviderId,
  modelId: string,
): ModelFamily | undefined {
  for (const family of modelFamilies()) {
    if (family.offerings.some((o) => o.provider === provider && o.modelId === modelId)) {
      return family;
    }
  }
  return findModelFamily(modelId);
}

/** True when an offering's native id is the same model the query named. */
export function offeringModelMatchesQuery(modelId: string, query: string): boolean {
  const n = normalizeModelQuery(query);
  const c = compactModelQuery(query);
  if (!n && !c) return false;
  return normalizeModelQuery(modelId) === n || compactModelQuery(modelId) === c;
}

/**
 * Translate a model (or family alias) onto a specific provider's native id.
 * Returns undefined when that provider has no offering for the family and no
 * direct catalog match.
 *
 * Exact offering matches win over the family's canonical reference so that
 * effort-suffixed ids like `gemini-3.6-flash-medium` are not collapsed to the
 * bare / default reference slug.
 */
export function nativeModelForProvider(
  provider: AgentProviderId,
  modelQuery: string,
): string | undefined {
  const family = findModelFamily(modelQuery);
  if (family) {
    const exact = family.offerings.find(
      (o) => o.provider === provider && offeringModelMatchesQuery(o.modelId, modelQuery),
    );
    if (exact) return exact.modelId;
    const offering = family.offerings.find((o) => o.provider === provider);
    if (offering) return offering.modelId;
  }
  const direct = findDirectCatalogMatches(modelQuery).find((m) => m.provider === provider);
  return direct?.modelId;
}
