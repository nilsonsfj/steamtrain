import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, type Page, chromium, expect, test } from "@playwright/test";
import { type ServerReady, parseReadyLine } from "../electron/main/server-child";

/**
 * Browser end-to-end coverage for the web UI.
 *
 * Electron e2e proves the desktop shell wires up; unit tests string-eval the
 * client bundles or hit createWebServer over HTTP. Neither launches a real
 * Chromium session against the real engine and clicks Launch → Approve.
 * That gap is what this suite closes.
 *
 * Agentless on purpose: an approval-only workflow skips the doctor preflight,
 * so CI does not need an agent CLI. The click path is still the product path.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "dist", "index.js");
const ENTRY_SRC = join(ROOT, "src", "index.tsx");

const APPROVE_WORKFLOW = {
  name: "approve-demo",
  description: "Phase 3 browser e2e: one approval checkpoint.",
  phases: [
    {
      id: "p1",
      title: "Approve",
      steps: [{ id: "chk", kind: "approval", prompt: "Ship it?" }],
    },
  ],
} as const;

const scratch: string[] = [];

function scratchDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

interface LaunchedServer {
  url: string;
  child: ChildProcess;
  output(): string;
  stop(): Promise<void>;
}

function childEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  // Match desktop e2e: a set TERM skips the login-shell PATH probe.
  env.TERM ??= "xterm";
  return env;
}

async function startWebServer(projectDir: string): Promise<LaunchedServer> {
  const chunks: string[] = [];
  // Prefer the built CLI when present (CI builds first); fall back to Bun
  // from source for local iteration without a full build.
  const useBuilt = existsSync(CLI);
  const child = useBuilt
    ? spawn(
        process.execPath,
        [
          CLI,
          "--web-ui",
          "--host",
          "127.0.0.1",
          "--port",
          "0",
          "--project-dir",
          projectDir,
          "--desktop-ready-json",
        ],
        { cwd: projectDir, env: childEnv(), stdio: ["ignore", "pipe", "pipe"] },
      )
    : spawn(
        "bun",
        [
          ENTRY_SRC,
          "--web-ui",
          "--host",
          "127.0.0.1",
          "--port",
          "0",
          "--project-dir",
          projectDir,
          "--desktop-ready-json",
        ],
        { cwd: projectDir, env: childEnv(), stdio: ["ignore", "pipe", "pipe"] },
      );

  const append = (chunk: Buffer): void => {
    chunks.push(chunk.toString());
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);

  const ready = await new Promise<ServerReady>((resolveReady, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`web UI never reported ready.\n${chunks.join("")}`));
    }, 60_000);

    const onChunk = (chunk: Buffer): void => {
      for (const line of chunk.toString().split(/\r?\n/)) {
        const parsed = parseReadyLine(line);
        if (!parsed) continue;
        cleanup();
        resolveReady(parsed);
        return;
      }
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanup();
      reject(
        new Error(
          `web UI exited before ready (code=${code}, signal=${signal}).\n${chunks.join("")}`,
        ),
      );
    };
    const cleanup = (): void => {
      clearTimeout(timeout);
      child.stdout?.off("data", onChunk);
      child.off("exit", onExit);
    };
    child.stdout?.on("data", onChunk);
    child.on("exit", onExit);
  });

  let stopping: Promise<void> | undefined;
  return {
    url: ready.url,
    child,
    output: () => chunks.join(""),
    stop: async () => {
      if (stopping) return stopping;
      stopping = (async () => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.kill("SIGTERM");
        await Promise.race([
          new Promise<void>((r) => child.once("exit", () => r())),
          new Promise<void>((r) => setTimeout(r, 5_000)),
        ]);
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
      })();
      return stopping;
    },
  };
}

function seedProject(): string {
  const project = scratchDir("steamtrain-web-e2e-");
  writeFileSync(
    join(project, "steamtrain.json"),
    JSON.stringify({ workflows: { [APPROVE_WORKFLOW.name]: APPROVE_WORKFLOW } }, null, 2),
  );
  return project;
}

let browser: Browser | undefined;
let server: LaunchedServer | undefined;
let page: Page | undefined;

test.beforeAll(async () => {
  const project = seedProject();
  server = await startWebServer(project);
  browser = await chromium.launch();
  const context = await browser.newContext();
  page = await context.newPage();
  await page.goto(server.url);
  await page.waitForLoadState("domcontentloaded");
});

test.afterEach(async () => {
  const testInfo = test.info();
  if (testInfo.status === testInfo.expectedStatus) return;
  if (server) {
    await testInfo.attach("server-output", {
      body: server.output(),
      contentType: "text/plain",
    });
  }
});

test.afterAll(async () => {
  await page
    ?.context()
    .close()
    .catch(() => {});
  await browser?.close().catch(() => {});
  await server?.stop().catch(() => {});
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
  scratch.length = 0;
});

test("launches a workflow and resolves an approval in the browser", async () => {
  if (!page) throw new Error("page not started");

  await expect(page.locator("#topbar .wordmark")).toHaveText("steamtrain");
  await expect(page.locator("#wflist")).toBeVisible();

  // Project workflows render alongside bundled ones; pick ours by name.
  const row = page.locator("#wflist .wf-row", {
    has: page.locator(".name", { hasText: "approve-demo" }),
  });
  await expect(row).toBeVisible();
  await row.click();

  // Inputs tab owns the run prompt; the plan header's Run button refuses an
  // empty input and bounces here, so fill it first.
  await page.locator(".plan-tabs button", { hasText: "Inputs" }).click();
  await page.locator("#input").fill("phase-3 browser e2e");

  await page.locator(".plan-actions .btn.primary", { hasText: "Run" }).click();
  await expect(page.locator("#modal")).toBeVisible();
  await page.locator("#modal button.btn.primary", { hasText: "Start run" }).click();

  const approve = page.locator('button.btn.approve, [data-focus-key^="approve:"]');
  await expect(approve).toBeVisible({ timeout: 30_000 });
  await approve.click();

  // Arrival / complete pill: the run finished and the approval was accepted.
  await expect(page.locator("#runPill")).toContainText(/complete/i, { timeout: 30_000 });
  await expect(page.locator("#runPill")).toHaveClass(/complete/);
});
