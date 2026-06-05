import { TASK_TYPES, type TaskType } from "../config";

/** Selector positions: the three task types plus the workflow launcher. */
export type Mode = TaskType | "workflow";

export const MODES: readonly Mode[] = [...TASK_TYPES, "workflow"];

export function isTaskType(mode: Mode): mode is TaskType {
  return mode !== "workflow";
}

export function nextMode(current: Mode): Mode {
  const idx = MODES.indexOf(current);
  return MODES[(idx + 1) % MODES.length] ?? current;
}
