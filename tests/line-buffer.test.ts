import { describe, expect, it } from "vitest";
import { LineBuffer } from "../src/agents/line-buffer";

describe("LineBuffer", () => {
  it("emits complete lines and holds the trailing partial", () => {
    const lb = new LineBuffer();
    expect(lb.push('{"a":1}\n{"b":2}')).toEqual(['{"a":1}']);
    expect(lb.pending).toBe('{"b":2}');
    expect(lb.push("\n")).toEqual(['{"b":2}']);
    expect(lb.pending).toBe("");
  });

  it("reassembles a JSON object split across chunk boundaries", () => {
    const lb = new LineBuffer();
    expect(lb.push('{"type":"text_de')).toEqual([]);
    expect(lb.push('lta","text":"hel')).toEqual([]);
    expect(lb.push('lo"}\n')).toEqual(['{"type":"text_delta","text":"hello"}']);
    expect(JSON.parse(lb.push('{"done":true}\n')[0] as string)).toEqual({ done: true });
  });

  it("splits multiple lines contained in a single chunk", () => {
    const lb = new LineBuffer();
    expect(lb.push("a\nb\nc\n")).toEqual(["a", "b", "c"]);
  });

  it("preserves blank lines between content", () => {
    const lb = new LineBuffer();
    expect(lb.push("a\n\nb\n")).toEqual(["a", "", "b"]);
  });

  it("strips a trailing carriage return (CRLF streams)", () => {
    const lb = new LineBuffer();
    expect(lb.push("a\r\nb\r\n")).toEqual(["a", "b"]);
  });

  it("returns the remainder via flush() when the stream ends without a newline", () => {
    const lb = new LineBuffer();
    expect(lb.push("partial line")).toEqual([]);
    expect(lb.flush()).toBe("partial line");
    expect(lb.flush()).toBeUndefined();
  });

  it("handles a realistic NDJSON stream chopped at arbitrary offsets", () => {
    const events = [
      '{"type":"system","subtype":"init","session_id":"ses_1"}',
      '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}}',
      '{"type":"result","is_error":false,"result":"hi"}',
    ];
    const payload = `${events.join("\n")}\n`;

    const lb = new LineBuffer();
    const collected: string[] = [];
    // Feed two characters at a time to force boundaries mid-token.
    for (let i = 0; i < payload.length; i += 2) {
      collected.push(...lb.push(payload.slice(i, i + 2)));
    }

    expect(collected).toEqual(events);
    expect(collected.map((l) => JSON.parse(l).type)).toEqual(["system", "stream_event", "result"]);
  });
});
