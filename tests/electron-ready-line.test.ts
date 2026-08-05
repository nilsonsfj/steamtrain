import { describe, expect, it } from "vitest";
import { parseReadyLine } from "../electron/main/server-child";

/**
 * The desktop app learns its engine's ephemeral port from a single JSON line on
 * stdout. The server also prints a banner, a project line and asynchronous
 * doctor progress, so the reader has to identify the handshake rather than
 * assume the first (or last) line is it.
 */
describe("parseReadyLine", () => {
  const ready = '{"steamtrain":"ready","url":"http://127.0.0.1:38249","port":38249,"pid":8692}';

  it("parses the handshake line", () => {
    expect(parseReadyLine(ready)).toEqual({
      steamtrain: "ready",
      url: "http://127.0.0.1:38249",
      port: 38249,
      pid: 8692,
    });
  });

  it("tolerates surrounding whitespace", () => {
    expect(parseReadyLine(`  ${ready}  `)?.port).toBe(38249);
  });

  it.each([
    ["the banner", "🚂 steamtrain web UI running at http://127.0.0.1:38249"],
    ["the project line", "   ◈  project  proj  ·  /home/user/proj"],
    ["the open hint", "   open it in your browser; press Ctrl+C to stop."],
    ["doctor progress", "   agent health: 1/9 ok (down: opencode, codex)"],
    ["a blank line", ""],
  ])("ignores %s", (_label, line) => {
    expect(parseReadyLine(line)).toBeUndefined();
  });

  it("ignores JSON that is not the handshake", () => {
    expect(parseReadyLine('{"steamtrain":"starting"}')).toBeUndefined();
    expect(parseReadyLine('{"hello":"world"}')).toBeUndefined();
  });

  it("ignores a handshake missing its port", () => {
    expect(parseReadyLine('{"steamtrain":"ready","url":"http://127.0.0.1:1"}')).toBeUndefined();
  });

  it("ignores malformed JSON without throwing", () => {
    expect(parseReadyLine('{"steamtrain":"ready"')).toBeUndefined();
  });
});
