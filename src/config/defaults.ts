import { DEFAULT_STEP_TIMEOUT_SEC } from "../workflow/timeout";
import { DEFAULT_LOOP_MAX_ITERATIONS } from "../workflow/types";
import type { SteamtrainConfig } from "./types";

/** Sensible defaults for project-level `steamtrain.json`. Workspace presets live in `~/.steamtrain/workspace.json`. */
export const DEFAULT_CONFIG: SteamtrainConfig = {
  stepTimeoutSec: DEFAULT_STEP_TIMEOUT_SEC,
  // workflowTimeoutSec omitted — computed at run time as stepCount × stepTimeoutSec.
  maxConcurrency: 3,
  loopMaxIterations: DEFAULT_LOOP_MAX_ITERATIONS,
};
