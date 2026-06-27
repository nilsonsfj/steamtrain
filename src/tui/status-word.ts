import type { RunStepStatus } from "../workflow";

export function statusWord(status: RunStepStatus): string {
  switch (status) {
    case "done":
      return "done";
    case "error":
      return "failed";
    case "running":
      return "running";
    case "pending":
      return "pending";
  }
}
