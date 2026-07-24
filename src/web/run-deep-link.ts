const RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const STEP_ID_PATTERN = /^[\w:.-]+$/;

export interface DeepLink {
  runId: string;
  stepId?: string;
}

export function parseDeepLink(hash: string): DeepLink | null {
  const trimmed = hash.trim();
  const match = /^#run-([^/]+)(?:\/step\/(.+))?$/i.exec(trimmed);
  if (!match || !RUN_ID_PATTERN.test(match[1]!)) return null;
  const runId = match[1]!.toLowerCase();
  const rawStep = match[2];
  if (rawStep && !STEP_ID_PATTERN.test(rawStep)) return { runId };
  return { runId, stepId: rawStep || undefined };
}

export function parseRunDeepLink(hash: string): string | null {
  const result = parseDeepLink(hash);
  return result ? result.runId : null;
}

export function runDeepLink(runId: string): string {
  return `#run-${runId.toLowerCase()}`;
}

export function approvalDeepLink(runId: string, stepId: string): string {
  return `#run-${runId.toLowerCase()}/step/${stepId}`;
}
