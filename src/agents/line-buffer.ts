/**
 * Buffers a byte/char stream and emits complete newline-delimited lines,
 * holding any trailing partial line until more data arrives.
 *
 * Stream chunks split lines at arbitrary boundaries — a single JSON object can
 * span two `data` events, and one event can contain many objects. This class is
 * the single place that reassembles them, so every adapter parses whole lines.
 *
 * Pending (incomplete) data is capped: a chatty or binary-spewing agent cannot
 * grow an unbounded string in the orchestrator waiting for a newline.
 */
export class LineBuffer {
  private chunks: string[] = [];
  private len = 0;
  private readonly maxPendingBytes: number;

  /**
   * @param maxPendingBytes Cap on bytes held as an incomplete line. When
   *   exceeded, the pending data is force-emitted as a line (without waiting
   *   for a newline) so adapters see a truncated/unknown payload instead of
   *   OOMing. Default 1 MiB.
   */
  constructor(maxPendingBytes = MAX_LINE_BUFFER_PENDING_BYTES) {
    this.maxPendingBytes = Math.max(1, maxPendingBytes);
  }

  /** Feed a chunk; returns the complete lines it completed (may be empty). */
  push(chunk: string): string[] {
    if (chunk.length === 0) return [];
    this.chunks.push(chunk);
    this.len += chunk.length;
    return this.drain();
  }

  /**
   * Returns any buffered remainder (a final line without a trailing newline)
   * and clears the buffer. Call once when the stream ends.
   */
  flush(): string | undefined {
    if (this.len === 0) return undefined;
    const rest = stripCarriageReturn(this.chunks.join(""));
    this.chunks = [];
    this.len = 0;
    return rest;
  }

  /** Bytes currently held back as an incomplete line. */
  get pending(): string {
    return this.len === 0 ? "" : this.chunks.join("");
  }

  private drain(): string[] {
    const joined = this.chunks.join("");
    const lines: string[] = [];
    let searchFrom = 0;
    let newlineIndex = joined.indexOf("\n", searchFrom);
    while (newlineIndex !== -1) {
      lines.push(stripCarriageReturn(joined.slice(searchFrom, newlineIndex)));
      searchFrom = newlineIndex + 1;
      newlineIndex = joined.indexOf("\n", searchFrom);
    }
    let remaining = joined.slice(searchFrom);
    // No newline yet, but the pending fragment already exceeds the cap —
    // force-emit so a never-ending line cannot grow without bound.
    while (remaining.length > this.maxPendingBytes) {
      lines.push(stripCarriageReturn(remaining.slice(0, this.maxPendingBytes)));
      remaining = remaining.slice(this.maxPendingBytes);
    }
    this.chunks = remaining.length > 0 ? [remaining] : [];
    this.len = remaining.length;
    return lines;
  }
}

/** Default cap on an incomplete stdout line waiting for a newline. */
export const MAX_LINE_BUFFER_PENDING_BYTES = 1 * 1024 * 1024;

function stripCarriageReturn(line: string): string {
  let end = line.length;
  while (end > 0 && line.charCodeAt(end - 1) === 13) end--;
  return end === line.length ? line : line.slice(0, end);
}
