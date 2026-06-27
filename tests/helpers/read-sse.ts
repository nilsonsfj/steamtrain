type SseFrame = { type: string; [k: string]: unknown };

async function consumeStream(
  body: ReadableStream<Uint8Array>,
  earlyExit: boolean,
): Promise<SseFrame[]> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const frames: SseFrame[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    // biome-ignore lint/suspicious/noAssignInExpressions: standard SSE frame split
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const line = chunk.split("\n").find((l) => l.startsWith("data: "));
      if (!line) continue;
      const frame = JSON.parse(line.slice(6)) as SseFrame;
      frames.push(frame);
      if (earlyExit && frame.type === "status") {
        await reader.cancel();
        return frames;
      }
    }
  }
  return frames;
}

/** Read all SSE frames from a URL (early-exits on status frame). */
export async function readSse(url: string): Promise<SseFrame[]> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`SSE fetch failed: ${res.status} ${res.statusText}`);
  return consumeStream(res.body!, true);
}

/** Read all SSE frames from an existing Response (reads until stream ends). */
export async function readSseFromResponse(res: Response): Promise<SseFrame[]> {
  return consumeStream(res.body!, false);
}
