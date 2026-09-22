import type { SteamtrainConfig } from "../config/types";
import {
  MODEL_CLASS_IDS,
  type ModelClassId,
  type ModelFamily,
  type ModelFamilyId,
  familiesForClass,
  isModelClassId,
  modelFamilyById,
} from "./model-identity";

/** Human-facing definition of a role-based model class. */
export interface ModelClassDefinition {
  id: ModelClassId;
  name: string;
  description: string;
  /**
   * Preferred family ids in preference order. Resolution walks this list and
   * picks the first family that has a ready agent offering.
   */
  preferred: readonly ModelFamilyId[];
  /**
   * Effort levels preferred for this class, tried in order against the
   * resolved agent+model's supported efforts. Applied only when the step
   * does not set `effort` explicitly.
   */
  preferredEfforts?: readonly string[];
}

const BUILTIN_MODEL_CLASSES: readonly ModelClassDefinition[] = [
  {
    id: "thinker",
    name: "Thinker",
    description: "Frontier reasoning for hard design, diagnosis, and deep review.",
    preferred: [
      "claude-fable-5",
      "claude-opus-5",
      "claude-opus-4.8",
      "claude-mythos-5",
      "gpt-5.6-sol",
      "gpt-5.5-pro",
      "gpt-5.5",
      "claude-opus-4.7",
      "gemini-3.1-pro",
      "cursor-grok-4.5",
      "amp-deep",
      "claude-opus-4.6",
    ],
  },
  {
    id: "ultrathinker",
    name: "Ultrathinker",
    description:
      "Maximum-effort frontier reasoning (Fable, GPT-5.6 Sol, Kimi K3) for the hardest problems.",
    preferred: [
      "claude-fable-5",
      "gpt-5.6-sol",
      "kimi-k3",
      "claude-opus-5",
      "claude-opus-4.8",
      "gpt-5.5-pro",
      "gpt-5.5",
      "claude-mythos-5",
      "gemini-3.1-pro",
    ],
    preferredEfforts: ["xhigh", "high"],
  },
  {
    id: "deep-reviewer",
    name: "Deep reviewer",
    description:
      "High-effort code and design review with frontier models (Opus 4.8, GPT-5.6 Sol, Fable).",
    preferred: [
      "claude-opus-5",
      "claude-opus-4.8",
      "gpt-5.6-sol",
      "claude-fable-5",
      "gpt-5.5",
      "gemini-3.1-pro",
      "claude-opus-4.7",
    ],
    preferredEfforts: ["high", "xhigh"],
  },
  {
    id: "reviewer",
    name: "Reviewer",
    description:
      "PR and code review workhorses spanning frontier and cost-efficient options (Opus, DeepSeek Pro, Qwen 3.7 Max).",
    preferred: [
      "claude-opus-5",
      "claude-opus-4.8",
      "deepseek-v4-pro",
      "qwen-3.7-max",
      "gpt-5.6-sol",
      "codex-auto-review",
      "claude-sonnet-4.6",
      "kimi-k2.7-code",
      "gpt-5.5",
    ],
    preferredEfforts: ["high", "medium"],
  },
  {
    id: "implementer",
    name: "Implementer",
    description: "Strong coding workhorse for building, refactoring, and fixing.",
    preferred: [
      "claude-sonnet-5",
      "composer-2.5",
      "gpt-5.5",
      "gpt-5.6-terra",
      "gpt-5.6-sol",
      "gemini-3.6-flash",
      "claude-sonnet-4.6",
      "claude-opus-5",
      "gpt-5.4",
      "amp-smart",
      "claude-fable-5",
    ],
  },
  {
    id: "simple",
    name: "Simple",
    description: "Fast and cheap for triage, formatting, and low-stakes tasks.",
    preferred: [
      "claude-haiku-4.5",
      "mimo-v2.6-flash-free",
      "gemini-3.5-flash-lite",
      "gpt-5.4-mini",
      "gpt-5.4-nano",
      "gpt-5.6-luna",
      "composer-2.5-fast",
      "gemini-3.6-flash",
      "gemini-3.5-flash",
      "amp-rush",
      "nemotron-3.5-lightning-free",
      "cursor-auto",
    ],
  },
  {
    id: "balanced",
    name: "Balanced",
    description: "General-purpose default when the step is not extreme either way.",
    preferred: [
      "claude-sonnet-5",
      "gpt-5.5",
      "gpt-5.6-terra",
      "gpt-5.4",
      "composer-2.5",
      "gemini-3.6-flash",
      "amp-smart",
      "claude-sonnet-4.6",
      "gemini-3.1-pro",
      "mimo-v2.6-flash-free",
      "cursor-auto",
    ],
  },
];

export interface ModelClassConfigOverride {
  /** Replace the preferred family list for a built-in class. */
  preferred?: ModelFamilyId[];
  /** Replace preferred effort ladder for a built-in class. */
  preferredEfforts?: string[];
  /** Optional display name override. */
  name?: string;
  /** Optional description override. */
  description?: string;
}

/** Config-layer overrides for built-in model classes. */
export type ModelClassesConfig = Partial<Record<ModelClassId, ModelClassConfigOverride>>;

function applyOverride(
  base: ModelClassDefinition,
  override: ModelClassConfigOverride | undefined,
): ModelClassDefinition {
  if (!override) return base;
  return {
    id: base.id,
    name: override.name ?? base.name,
    description: override.description ?? base.description,
    preferred:
      override.preferred && override.preferred.length > 0 ? override.preferred : base.preferred,
    preferredEfforts:
      override.preferredEfforts && override.preferredEfforts.length > 0
        ? override.preferredEfforts
        : base.preferredEfforts,
  };
}

/** Effective model class definitions after applying config overrides. */
export function modelClasses(config?: SteamtrainConfig): readonly ModelClassDefinition[] {
  const overrides = config?.modelClasses;
  return BUILTIN_MODEL_CLASSES.map((base) => applyOverride(base, overrides?.[base.id]));
}

export function modelClassById(
  id: string,
  config?: SteamtrainConfig,
): ModelClassDefinition | undefined {
  if (!isModelClassId(id)) return undefined;
  return modelClasses(config).find((entry) => entry.id === id);
}

/**
 * Ordered candidate families for a class: config/builtin preferred list first
 * (skipping unknown ids), then any remaining families tagged with the class.
 */
export function candidateFamiliesForClass(
  classId: ModelClassId,
  config?: SteamtrainConfig,
): ModelFamily[] {
  const def = modelClassById(classId, config);
  if (!def) return [];

  const seen = new Set<ModelFamilyId>();
  const out: ModelFamily[] = [];

  for (const id of def.preferred) {
    const family = modelFamilyById(id);
    if (!family || seen.has(family.id)) continue;
    seen.add(family.id);
    out.push(family);
  }

  for (const family of familiesForClass(classId)) {
    if (seen.has(family.id)) continue;
    seen.add(family.id);
    out.push(family);
  }

  return out;
}

export { MODEL_CLASS_IDS, isModelClassId };
export type { ModelClassId };
