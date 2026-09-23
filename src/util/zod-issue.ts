/**
 * One schema issue as `where: what` — a bare "Required" does not say which of
 * a config's many fields is missing.
 */
export function describeIssue(
  issue: { path: PropertyKey[]; message: string } | undefined,
  root = "config",
): string {
  if (!issue) return "schema error";
  return `${issue.path.map(String).join(".") || root}: ${issue.message}`;
}
