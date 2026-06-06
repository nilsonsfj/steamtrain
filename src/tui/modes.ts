import { TASK_TYPES, type TaskType } from "../config";

/** Selector positions: workflows first, with one-shot task modes as secondary tools. */
export type Mode = TaskType | "workflow";

export const MODES: readonly Mode[] = ["workflow", ...TASK_TYPES];

export function isTaskType(mode: Mode): mode is TaskType {
  return mode !== "workflow";
}

export function nextMode(current: Mode): Mode {
  const idx = MODES.indexOf(current);
  return MODES[(idx + 1) % MODES.length] ?? current;
}
