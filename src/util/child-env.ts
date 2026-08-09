/**
 * `ELECTRON_RUN_AS_NODE` makes an Electron binary behave as a plain Node
 * runtime. The desktop app sets it so the engine — forked from the Electron
 * binary — runs as Node, and so `process.execPath` stays a usable interpreter
 * for the detached runner (`workflow/handoff.ts`).
 *
 * It must not reach the *leaf* processes a run spawns. Agent CLIs and `command`
 * steps are arbitrary user binaries, and several popular developer tools are
 * themselves Electron apps; inheriting this variable would silently start them
 * headless as Node instead of as themselves.
 */
const ELECTRON_RUN_AS_NODE = "ELECTRON_RUN_AS_NODE";

/**
 * Build the environment for a spawned leaf process: `process.env` plus
 * `overrides`, with {@link ELECTRON_RUN_AS_NODE} removed.
 *
 * Outside the desktop app this is exactly `{ ...process.env, ...overrides }`,
 * so it is safe to use unconditionally.
 */
export function childEnv(
  overrides?: NodeJS.ProcessEnv,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, ...overrides };
  delete env[ELECTRON_RUN_AS_NODE];
  return env;
}

/**
 * Shell prefix that re-enables Node mode for one command, for the cases where
 * we deliberately re-invoke *this* binary (see `resolveSteamtrainCliInvocation`)
 * after {@link childEnv} has stripped the variable. Empty when not running
 * under Electron, so the emitted command is unchanged for normal installs.
 *
 * Prefer wrapping with `env ELECTRON_RUN_AS_NODE=1 …` when the result will be
 * stored in `$STEAMTRAIN_CLI` and expanded by the shell — a bare `VAR=value`
 * prefix from expansion is treated as a command name, not an assignment.
 */
export function electronNodePrefix(env: NodeJS.ProcessEnv = process.env): string {
  return env[ELECTRON_RUN_AS_NODE] ? `${ELECTRON_RUN_AS_NODE}=1 ` : "";
}
