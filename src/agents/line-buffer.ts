/**
 * Buffers a byte/char stream and emits complete newline-delimited lines,
 * holding any trailing partial line until more data arrives.
 *
 * Stream chunks split lines at arbitrary boundaries — a single JSON object can
 * span two `data` events, and one event can contain many objects. This class is
 * the single place that reassembles them, so every adapter parses whole lines.
 */
export class LineBuffer {
  private chunks: string[] = [];
  private len = 0;

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
    const remaining = joined.slice(searchFrom);
    this.chunks = remaining.length > 0 ? [remaining] : [];
    this.len = remaining.length;
    return lines;
  }
}

function stripCarriageReturn(line: string): string {
  let end = line.length;
  while (end > 0 && line.charCodeAt(end - 1) === 13) end--;
  return end === line.length ? line : line.slice(0, end);
}
