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
}

const BUILTIN_MODEL_CLASSES: readonly ModelClassDefinition[] = [
  {
    id: "thinker",
    name: "Thinker",
    description: "Frontier reasoning for hard design, diagnosis, and deep review.",
    preferred: [
      "claude-fable-5",
      "claude-opus-4.8",
      "claude-mythos-5",
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
    id: "implementer",
    name: "Implementer",
    description: "Strong coding workhorse for building, refactoring, and fixing.",
    preferred: [
      "claude-sonnet-5",
      "composer-2.5",
      "gpt-5.5",
      "gpt-5.3-codex",
      "claude-sonnet-4.6",
      "gpt-5.4",
      "gpt-5.2-codex",
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
      "mimo-v2.5-free",
      "gpt-5.4-mini",
      "gpt-5.4-nano",
      "composer-2.5-fast",
      "gemini-3.5-flash",
      "amp-rush",
      "deepseek-v4-flash-free",
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
      "gpt-5.4",
      "composer-2.5",
      "amp-smart",
      "claude-sonnet-4.6",
      "gemini-3.1-pro",
      "mimo-v2.5-free",
      "cursor-auto",
    ],
  },
];

export interface ModelClassConfigOverride {
  /** Replace the preferred family list for a built-in class. */
  preferred?: ModelFamilyId[];
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
