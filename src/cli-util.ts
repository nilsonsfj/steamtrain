import type { Readable } from "node:stream";

/** Shared CLI plumbing used by both `cli.ts` (dispatch) and `run-cli.ts` (run driver). */

export function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function truncateLine(text: string, max: number): string {
  const oneLine = text.replace(/\n/g, " ");
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

const MAX_READ_BYTES = 10 * 1024 * 1024;

export function readAll(stream: Readable): Promise<string> {
  return new Promise((resolve, reject) => {
    // A stream that already ended (or was destroyed) will never emit
    // 'end'/'error' again — resolve immediately instead of hanging forever on
    // listeners that can't fire.
    if (stream.readableEnded || stream.destroyed) {
      resolve("");
      return;
    }
    let text = "";
    let bytes = 0;
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      bytes += Buffer.byteLength(chunk, "utf8");
      if (bytes > MAX_READ_BYTES) {
        stream.destroy(new Error(`input exceeds ${MAX_READ_BYTES} byte limit`));
        return;
      }
      text += String(chunk);
    });
    stream.on("end", () => resolve(text));
    stream.on("error", reject);
  });
}
