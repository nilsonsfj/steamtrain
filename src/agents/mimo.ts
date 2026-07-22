import type { AgentEvent, AgentId, AgentInstanceId, EventMapper } from "../types/events";
import type { AgentAdapter, AgentRunOptions } from "./adapter";
import { runAgentProcess } from "./adapter";
import type { AgentModel } from "./agent-model";
import { OPENCODE_MODELS, buildOpenCodeRunArgs, createOpenCodeMapper } from "./opencode";

const AGENT: AgentId = "mimo";

/**
 * Mimo is an OpenCode fork: same `run --format json` CLI and event protocol
 * under a different binary/branding, so its model catalog mirrors OpenCode's
 * verbatim with the provider prefix swapped (`opencode/x` -> `mimo/x`,
 * `opencode-go/x` -> `mimo-go/x`).
 */
export const MIMO_MODELS: readonly AgentModel[] = OPENCODE_MODELS.map((model) => ({
  id: model.id.startsWith("opencode-go/")
    ? `mimo-go/${model.id.slice("opencode-go/".length)}`
    : `mimo/${model.id.slice("opencode/".length)}`,
  name: model.name,
}));

export function createMimoMapper(agent: AgentInstanceId = AGENT): EventMapper {
  return createOpenCodeMapper(agent);
}

/** Runs the real `mimo` CLI in JSON event mode (OpenCode-compatible protocol). */
export class MimoAdapter implements AgentAdapter {
  readonly id: AgentId = AGENT;
  readonly binary: string;
  readonly defaultModel = "mimo/mimo-v2.5-free";
  readonly supportsResume = true;

  constructor(binary = "mimo") {
    this.binary = binary;
  }

  run(opts: AgentRunOptions): AsyncIterable<AgentEvent> {
    const args = buildOpenCodeRunArgs(opts);
    return runAgentProcess({
      id: this.id,
      binary: this.binary,
      args,
      opts,
      map: createMimoMapper(opts.agentId ?? this.id),
      prompt: opts.prompt,
    });
  }
}
