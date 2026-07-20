const RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseRunDeepLink(hash: string): string | null {
  const match = /^#run-(.+)$/i.exec(hash.trim());
  if (!match || !RUN_ID_PATTERN.test(match[1]!)) return null;
  return match[1]!.toLowerCase();
}

export function runDeepLink(runId: string): string {
  return `#run-${runId.toLowerCase()}`;
}
