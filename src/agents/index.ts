import type { AgentId } from "../types/events";
import type { AgentAdapter } from "./adapter";
import { ClaudeCodeAdapter } from "./claude";
import { CodexAdapter } from "./codex";
import { OpenCodeAdapter } from "./opencode";

export type { AgentAdapter, AgentRunOptions } from "./adapter";
export { runAgentProcess } from "./adapter";
export type { AgentModel } from "./agent-model";
export { formatModelOption } from "./agent-model";
export { ClaudeCodeAdapter, CLAUDE_MODELS, createClaudeMapper } from "./claude";
export { CodexAdapter, CODEX_MODELS, createCodexMapper } from "./codex";
export {
  AGENT_IDS,
  defaultModelForAgent,
  effortForModelChange,
  effortsForModel,
  formatAgentTarget,
  formatModelDisplay,
  isAgentId,
  modelIdsForAgent,
  modelNameForAgent,
  modelsForAgent,
  refreshAgentCatalogCaches,
  refreshCodexVariantCache,
  refreshOpencodeVariantCache,
  supportsEffort,
} from "./models";
export {
  clearCodexVariantCacheForTests,
  parseCodexDebugModels,
  setCodexVariantCacheForTests,
} from "./codex-variants";
export { fallbackCodexEfforts } from "./codex-efforts-fallback";
export {
  clearOpencodeVariantCacheForTests,
  parseOpencodeModelsVerbose,
  setOpencodeVariantCacheForTests,
} from "./opencode-variants";
export { fallbackOpencodeEfforts } from "./opencode-efforts-fallback";
export { OpenCodeAdapter, OPENCODE_MODELS, createOpenCodeMapper } from "./opencode";
export { LineBuffer } from "./line-buffer";
export { runProcessLines } from "./spawn";

/** Construct the adapter for an agent id, optionally overriding the binary. */
export function createAdapter(id: AgentId, binary?: string): AgentAdapter {
  switch (id) {
    case "claude":
      return new ClaudeCodeAdapter(binary);
    case "opencode":
      return new OpenCodeAdapter(binary);
    case "codex":
      return new CodexAdapter(binary);
  }
}
