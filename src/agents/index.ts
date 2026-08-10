import type { AgentProviderId } from "../types/events";
import type { AgentAdapter } from "./adapter";
import { AmpAdapter } from "./amp";
import { AntigravityAdapter } from "./antigravity";
import { ClaudeCodeAdapter } from "./claude";
import { CodexAdapter } from "./codex";
import { CursorAgentAdapter } from "./cursor";
import { KimiAdapter } from "./kimi";
import { KiroCliAdapter } from "./kiro";
import { MimoAdapter } from "./mimo";
import { OpenCodeAdapter } from "./opencode";

export type { AgentAdapter, AgentRunOptions } from "./adapter";
export { runAgentProcess } from "./adapter";
export type { AgentModel } from "./agent-model";
export { formatModelOption } from "./agent-model";
export {
  type AgentMeta,
  type AgentModelMeta,
  buildAgentMeta,
  defaultDraftModel,
} from "./agent-meta";
export { AmpAdapter, AMP_MODELS, buildAmpExecArgs, createAmpMapper } from "./amp";
export {
  ClaudeCodeAdapter,
  CLAUDE_MODELS,
  buildClaudeRunArgs,
  createClaudeMapper,
} from "./claude";
export {
  type PermissionEnforcement,
  type PermissionPlan,
  type PermissionProfile,
  type PermissionsSpec,
  type PermissionUnsupportedPolicy,
  type ProviderPermissionSupport,
  type ResolvedPermissions,
  type StepPermissions,
  PERMISSION_PROFILES,
  effectivePermissions,
  isPermissionProfile,
  permissionArgs,
  permissionPlan,
  permissionsBadge,
  permissionsDescription,
  permissionsLabel,
  permissionSupportMatrix,
  providerPermissionSupport,
  resolvePermissions,
} from "./permissions";
export { CodexAdapter, CODEX_MODELS, buildCodexExecArgs, createCodexMapper } from "./codex";
export {
  CursorAgentAdapter,
  CURSOR_MODELS,
  buildCursorRunArgs,
  createCursorMapper,
} from "./cursor";
export {
  AntigravityAdapter,
  ANTIGRAVITY_MODELS,
  antigravitySlugEffortsForModel,
  buildAntigravityRunArgs,
  extractAntigravityConversationId,
  formatAntigravityPrintTimeout,
  resolveAntigravityModel,
  runAntigravityProcess,
} from "./antigravity";
export {
  DEFAULT_AGENT_BINARY,
  DEFAULT_AGENT_LABEL,
  agentUiLabel,
  defaultAgentInstance,
  resolveAgentInstance,
  resolveAgentInstances,
  type ResolvedAgentInstance,
} from "./config";
export { KiroCliAdapter, KIRO_MODELS, buildKiroExecArgs, runKiroProcess } from "./kiro";
export { buildKimiRunArgs, createKimiMapper, KIMI_MODELS, KimiAdapter } from "./kimi";
export { MimoAdapter, MIMO_MODELS, createMimoMapper } from "./mimo";
export {
  AGENT_IDS,
  agentProviderFor,
  defaultModelForAgent,
  isAgentProviderId,
  effortForModelChange,
  effortsForModel,
  formatAgentTarget,
  formatModelDisplay,
  isAgentId,
  modelIdsForAgent,
  modelNameForAgent,
  modelsForAgent,
  refreshAgentCatalogCaches,
  refreshAntigravityVariantCache,
  refreshCodexVariantCache,
  refreshCursorVariantCache,
  refreshKimiVariantCache,
  refreshMimoVariantCache,
  refreshOpencodeVariantCache,
  supportsEffort,
} from "./models";
export {
  type ModelClassId,
  type ModelClassDefinition,
  MODEL_CLASS_IDS,
  candidateFamiliesForClass,
  isModelClassId,
  modelClassById,
  modelClasses,
} from "./model-classes";
export {
  type ModelFamily,
  type ModelFamilyId,
  type ModelOffering,
  AGENT_PREFERENCE_ORDER,
  clearModelFamilyCacheForTests,
  compactModelQuery,
  familiesForClass,
  familyForProviderModel,
  findDirectCatalogMatches,
  findModelFamily,
  modelFamilies,
  modelFamilyById,
  nativeModelForProvider,
  normalizeModelQuery,
  offeringModelMatchesQuery,
} from "./model-identity";
export {
  type ModelBindingRequest,
  type ResolveModelBindingResult,
  type ResolvedModelCandidate,
  bindingRequestFromStep,
  describeModelClass,
  listModelClasses,
  listModelFamilyMeta,
  materializeStepBinding,
  needsModelResolution,
  resolveModelBinding,
  resolveEffortForBinding,
} from "./model-resolve";
export {
  type AgentFailureKind,
  type CapacityFailureKind,
  classifyAgentFailure,
  describeFailureKind,
  isCapacityFailure,
  isDefaultFailoverTrigger,
} from "./failure-classify";
export {
  clearCodexVariantCacheForTests,
  parseCodexDebugModels,
  setCodexVariantCacheForTests,
} from "./codex-variants";
export {
  clearCursorVariantCacheForTests,
  parseCursorListModels,
  setCursorVariantCacheForTests,
} from "./cursor-variants";
export {
  clearAntigravityVariantCacheForTests,
  parseAntigravityModelsOutput,
  setAntigravityVariantCacheForTests,
} from "./antigravity-variants";
export { fallbackCodexEfforts } from "./codex-efforts-fallback";
export {
  clearOpencodeVariantCacheForTests,
  parseOpencodeModelsVerbose,
  setOpencodeVariantCacheForTests,
} from "./opencode-variants";
export { fallbackOpencodeEfforts } from "./opencode-efforts-fallback";
export {
  clearMimoVariantCacheForTests,
  setMimoVariantCacheForTests,
} from "./mimo-variants";
export { fallbackMimoEfforts } from "./mimo-efforts-fallback";
export {
  clearKimiVariantCacheForTests,
  parseKimiProviderList,
  setKimiVariantCacheForTests,
} from "./kimi-variants";
export { fallbackKimiEfforts } from "./kimi-efforts-fallback";
export {
  OpenCodeAdapter,
  OPENCODE_MODELS,
  buildOpenCodeRunArgs,
  createOpenCodeMapper,
} from "./opencode";
export {
  type AgentLayers,
  agentConfigScope,
  agentScopeLabel,
  removeAgent,
  upsertAgent,
} from "./manage";
export { LineBuffer, MAX_LINE_BUFFER_PENDING_BYTES } from "./line-buffer";
export {
  DEFAULT_AGENT_IDLE_TIMEOUT_MS,
  MAX_AGENT_STDERR_BYTES,
  resolveAgentIdleTimeoutMs,
  runProcessLines,
} from "./spawn";

/** Construct the adapter for an agent id, optionally overriding the binary. */
export function createAdapter(id: AgentProviderId, binary?: string): AgentAdapter {
  switch (id) {
    case "claude":
      return new ClaudeCodeAdapter(binary);
    case "opencode":
      return new OpenCodeAdapter(binary);
    case "codex":
      return new CodexAdapter(binary);
    case "amp":
      return new AmpAdapter(binary);
    case "kiro":
      return new KiroCliAdapter(binary);
    case "mimo":
      return new MimoAdapter(binary);
    case "kimi":
      return new KimiAdapter(binary);
    case "cursor":
      return new CursorAgentAdapter(binary);
    case "antigravity":
      return new AntigravityAdapter(binary);
  }
}
