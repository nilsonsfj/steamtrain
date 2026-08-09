/**
 * Shared helpers for bounding in-memory string/buffer accumulation so a chatty
 * agent or binary-heavy git diff cannot OOM the orchestrator.
 */

/** Append `chunk` to `buf`, keeping at most `maxBytes` from the tail. */
export function appendCapped(buf: string, chunk: string, maxBytes: number): string {
  if (chunk.length === 0) return buf;
  const next = buf + chunk;
  if (next.length <= maxBytes) return next;
  return next.slice(next.length - maxBytes);
}
