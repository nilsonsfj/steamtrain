import type { AgentId } from "../types/events";
import type { AgentAdapter } from "./adapter";
import { ClaudeCodeAdapter } from "./claude";
import { OpenCodeAdapter } from "./opencode";

export type { AgentAdapter, AgentRunOptions } from "./adapter";
export { runAgentProcess } from "./adapter";
export { ClaudeCodeAdapter, CLAUDE_MODELS, createClaudeMapper } from "./claude";
export { AGENT_IDS, defaultModelForAgent, isAgentId, modelsForAgent } from "./models";
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
  }
}
