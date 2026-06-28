import { DEFAULT_STEP_TIMEOUT_MS } from "../workflow/timeout";
import { DEFAULT_LOOP_MAX_ITERATIONS } from "../workflow/types";
import type { SteamtrainConfig } from "./types";

/** Sensible defaults for project-level `steamtrain.json`. Workspace presets live in `~/.steamtrain/workspace.json`. */
export const DEFAULT_CONFIG: SteamtrainConfig = {
  stepTimeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  // workflowTimeoutMs omitted — computed at run time as stepCount × stepTimeoutMs.
  // Heavy CLI subprocesses, so default modest; configurable up to MAX_CONCURRENCY.
  maxConcurrency: 3,
  loopMaxIterations: DEFAULT_LOOP_MAX_ITERATIONS,
};
