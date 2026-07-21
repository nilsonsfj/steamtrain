import type { AgentProviderId } from "../types/events";
import type { AgentAdapter } from "./adapter";
import { AmpAdapter } from "./amp";
import { AntigravityAdapter } from "./antigravity";
import { ClaudeCodeAdapter } from "./claude";
import { CodexAdapter } from "./codex";
import { CursorAgentAdapter } from "./cursor";
import { KiroCliAdapter } from "./kiro";
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
export { ClaudeCodeAdapter, CLAUDE_MODELS, createClaudeMapper } from "./claude";
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
  buildAntigravityRunArgs,
  extractAntigravityConversationId,
  formatAntigravityPrintTimeout,
  resolveAntigravityModel,
  runAntigravityProcess,
} from "./antigravity";
export {
  DEFAULT_AGENT_BINARY,
  defaultAgentInstance,
  resolveAgentInstance,
  resolveAgentInstances,
  type ResolvedAgentInstance,
} from "./config";
export { KiroCliAdapter, KIRO_MODELS, buildKiroExecArgs, createKiroMapper } from "./kiro";
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
  refreshOpencodeVariantCache,
  supportsEffort,
} from "./models";
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
export { OpenCodeAdapter, OPENCODE_MODELS, createOpenCodeMapper } from "./opencode";
export {
  type AgentLayers,
  agentConfigScope,
  agentScopeLabel,
  removeAgent,
  upsertAgent,
} from "./manage";
export { LineBuffer } from "./line-buffer";
export { runProcessLines } from "./spawn";

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
    case "cursor":
      return new CursorAgentAdapter(binary);
    case "antigravity":
      return new AntigravityAdapter(binary);
  }
}
