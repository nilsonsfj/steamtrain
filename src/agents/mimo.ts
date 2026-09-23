import type { AgentEvent, AgentId, AgentInstanceId, EventMapper } from "../types/events";
import type { AgentAdapter, AgentRunOptions } from "./adapter";
import { runAgentProcess } from "./adapter";
import type { AgentModel } from "./agent-model";
import { buildOpenCodeRunArgs, createOpenCodeMapper } from "./opencode";

const AGENT: AgentId = "mimo";

/**
 * Known MiMo Code models (`mimo models`). Protocol matches OpenCode
 * (`run --format json`), but the catalog is Xiaomi's — not a renamed
 * OpenCode Zen/Go list. Live installs refresh via `mimo models --verbose`.
 *
 * Verified against @mimo-ai/cli 0.1.9 (`mimo models`):
 *   mimo/mimo-auto                  — MiMo Auto (free channel)
 *   xiaomi/mimo-v2.6-flash          — platform MiMo-V2.6-Flash
 *   xiaomi/mimo-v2.6-pro            — platform MiMo-V2.6-Pro
 *   xiaomi/mimo-v2.6-pro-ultraspeed — platform V2.6 UltraSpeed SKU
 *   xiaomi/mimo-v2.5*               — previous generation, still served
 */
export const MIMO_MODELS: readonly AgentModel[] = [
  { id: "mimo/mimo-auto", name: "MiMo Auto" },
  { id: "xiaomi/mimo-v2.6-flash", name: "MiMo-V2.6-Flash" },
  { id: "xiaomi/mimo-v2.6-pro", name: "MiMo-V2.6-Pro" },
  { id: "xiaomi/mimo-v2.6-pro-ultraspeed", name: "MiMo-V2.6-Pro-UltraSpeed" },
  { id: "xiaomi/mimo-v2.5", name: "MiMo-V2.5" },
  { id: "xiaomi/mimo-v2.5-pro", name: "MiMo-V2.5-Pro" },
  { id: "xiaomi/mimo-v2.5-pro-ultraspeed", name: "MiMo-V2.5-Pro-UltraSpeed" },
];

export function createMimoMapper(agent: AgentInstanceId = AGENT): EventMapper {
  return createOpenCodeMapper(agent);
}

/** Runs the real `mimo` CLI in JSON event mode (OpenCode-compatible protocol). */
export class MimoAdapter implements AgentAdapter {
  readonly id: AgentId = AGENT;
  readonly binary: string;
  /** Free anonymous channel; zero config on first launch. */
  readonly defaultModel = "mimo/mimo-auto";
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
