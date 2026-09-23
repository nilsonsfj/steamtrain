import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childEnv } from "../util/child-env";

/** Export/import of one session is local disk work; this only bounds a wedged CLI. */
const SESSION_COPY_TIMEOUT_MS = 60_000;
/** Exports carry every tool output of the conversation. */
const SESSION_EXPORT_MAX_BYTES = 512 * 1024 * 1024;
const ID_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
/** Trailing random characters of an OpenCode id (`ses_<12 time hex><14 random>`). */
const ID_RANDOM_CHARS = 14;

interface ExportedSession {
  info: { id: string; directory?: string; [key: string]: unknown };
  messages: Array<{
    info: { id: string; [key: string]: unknown };
    parts?: Array<{ id: string; [key: string]: unknown }>;
  }>;
}

/**
 * The id of a session that `opencode run --session <id> --dir <cwd>` can
 * actually continue from `cwd`, copying `sessionId` there when it lives
 * elsewhere.
 *
 * OpenCode runs a resumed session in the directory it was created in, not in
 * `--dir` — and from any other directory `run` never prints an event or exits,
 * because it listens on `--dir`'s instance while the session reports on its
 * own (checked live, 1.18.32). A continuing step owns a different worktree
 * than the step it continues, so without the copy it hangs until the step
 * timeout, and any tool call it made would edit the source step's worktree.
 *
 * The copy is an export → import. Import files the session under the
 * importing process's cwd, and skips rows whose ids already exist, so every
 * session, message and part id is renewed first (keeping each id's time
 * prefix, which is what OpenCode sorts on). The source session is untouched.
 * Also used for MiMo, whose CLI is an OpenCode fork with the same commands.
 */
export async function sessionForDirectory(
  binary: string,
  sessionId: string,
  cwd: string,
  env?: Record<string, string>,
  signal?: AbortSignal,
): Promise<string> {
  const exported = await runCli(binary, ["export", sessionId], cwd, env, signal);
  const session = parseExport(exported, sessionId);
  if (session.info.directory && (await samePath(session.info.directory, cwd))) return sessionId;

  const copy = renewIds(session);
  copy.info.directory = cwd;
  const dir = await mkdtemp(join(tmpdir(), "steamtrain-session-"));
  try {
    const file = join(dir, "session.json");
    await writeFile(file, JSON.stringify(copy), "utf8");
    await runCli(binary, ["import", file], cwd, env, signal);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  return copy.info.id;
}

/**
 * The session object out of `export`'s stdout. The document is the last
 * top-level JSON value, so any log line printed before it (brace-bearing or
 * not) is skipped by trying each line that opens an object, first to last.
 */
function parseExport(stdout: string, sessionId: string): ExportedSession {
  const starts = [0];
  for (let i = stdout.indexOf("\n{"); i >= 0; i = stdout.indexOf("\n{", i + 1)) starts.push(i + 1);
  for (const start of starts) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout.slice(start));
    } catch {
      continue;
    }
    const session = parsed as Partial<ExportedSession> | null;
    if (session?.info && typeof session.info.id === "string" && Array.isArray(session.messages)) {
      return session as ExportedSession;
    }
  }
  throw new Error(`could not read the export of session ${sessionId}`);
}

/** A deep copy of `session` with every session, message and part id replaced. */
function renewIds(session: ExportedSession): ExportedSession {
  const renamed = new Map<string, string>();
  const rename = (id: string): void => {
    if (!renamed.has(id)) renamed.set(id, freshId(id));
  };
  rename(session.info.id);
  for (const message of session.messages) {
    rename(message.info.id);
    for (const part of message.parts ?? []) rename(part.id);
  }
  const swap = (value: unknown): unknown => {
    if (typeof value === "string") return renamed.get(value) ?? value;
    if (Array.isArray(value)) return value.map(swap);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, swap(v)]));
    }
    return value;
  };
  return swap(session) as ExportedSession;
}

function freshId(id: string): string {
  const keep = id.length > ID_RANDOM_CHARS ? id.slice(0, id.length - ID_RANDOM_CHARS) : `${id}_`;
  const bytes = randomBytes(ID_RANDOM_CHARS);
  let tail = "";
  for (const byte of bytes) tail += ID_ALPHABET[byte % ID_ALPHABET.length];
  return keep + tail;
}

async function samePath(a: string, b: string): Promise<boolean> {
  const resolve = (p: string) => realpath(p).catch(() => p);
  return (await resolve(a)) === (await resolve(b));
}

function runCli(
  binary: string,
  args: string[],
  cwd: string,
  env?: Record<string, string>,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      binary,
      args,
      {
        cwd,
        env: childEnv(env),
        timeout: SESSION_COPY_TIMEOUT_MS,
        maxBuffer: SESSION_EXPORT_MAX_BYTES,
        // A cancel or kill-step must not wait out a slow export or import.
        signal,
      },
      (err, stdout, stderr) => {
        if (err) {
          const detail = String(stderr || err.message)
            .trim()
            .split("\n")
            .slice(-3)
            .join(" ");
          reject(new Error(`${binary} ${args[0]} failed: ${detail}`));
          return;
        }
        resolve(String(stdout));
      },
    );
  });
}
