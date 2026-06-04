import { z } from "zod";
import type { AgentId } from "../types/events";

/** The kinds of work the orchestrator can route. */
export const TASK_TYPES = ["plan", "implement", "review"] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export interface TaskConfig {
  agent: AgentId;
  /** Model string in the agent's own format (claude: `claude-…`, opencode: `provider/model`). */
  model: string;
}

export type TaskConfigMap = Record<TaskType, TaskConfig>;

export interface SteamtrainConfig {
  tasks: TaskConfigMap;
  /** Optional per-agent binary path/name overrides. */
  binaries?: Partial<Record<AgentId, string>>;
  /** Per-task wall-clock timeout in ms. */
  timeoutMs?: number;
}

const agentId = z.enum(["claude", "opencode"]);
const taskConfig = z.object({ agent: agentId, model: z.string().min(1) });

/** Schema for a (partial) steamtrain.json — every section is optional and merged onto defaults. */
export const configFileSchema = z
  .object({
    tasks: z
      .object({
        plan: taskConfig.optional(),
        implement: taskConfig.optional(),
        review: taskConfig.optional(),
      })
      .partial()
      .optional(),
    binaries: z
      .object({ claude: z.string().optional(), opencode: z.string().optional() })
      .partial()
      .optional(),
    timeoutMs: z.number().positive().optional(),
  })
  .strict();

export type ConfigFile = z.infer<typeof configFileSchema>;
