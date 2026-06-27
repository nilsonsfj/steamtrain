/**
 * Buffers a byte/char stream and emits complete newline-delimited lines,
 * holding any trailing partial line until more data arrives.
 *
 * Stream chunks split lines at arbitrary boundaries — a single JSON object can
 * span two `data` events, and one event can contain many objects. This class is
 * the single place that reassembles them, so every adapter parses whole lines.
 */
export class LineBuffer {
  private buf = "";

  /** Feed a chunk; returns the complete lines it completed (may be empty). */
  push(chunk: string): string[] {
    if (chunk.length === 0) return [];
    this.buf += chunk;
    const lines: string[] = [];
    let newlineIndex = this.buf.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = stripCarriageReturn(this.buf.slice(0, newlineIndex));
      this.buf = this.buf.slice(newlineIndex + 1);
      lines.push(line);
      newlineIndex = this.buf.indexOf("\n");
    }
    return lines;
  }

  /**
   * Returns any buffered remainder (a final line without a trailing newline)
   * and clears the buffer. Call once when the stream ends.
   */
  flush(): string | undefined {
    if (this.buf.length === 0) return undefined;
    const rest = stripCarriageReturn(this.buf);
    this.buf = "";
    return rest;
  }

  /** Bytes currently held back as an incomplete line. */
  get pending(): string {
    return this.buf;
  }
}

function stripCarriageReturn(line: string): string {
  let end = line.length;
  while (end > 0 && line.charCodeAt(end - 1) === 13) end--;
  return end === line.length ? line : line.slice(0, end);
}
