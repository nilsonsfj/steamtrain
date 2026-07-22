import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Text } from "ink";
import { render } from "ink-testing-library";
import { useEffect, useRef } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Orchestrator } from "../src/orchestrator";
import { useWorkflowRunner } from "../src/tui/useWorkflowRunner";
import type { WorkflowEvent, WorkflowSpec } from "../src/workflow";

type Runner = ReturnType<typeof useWorkflowRunner>;
const spec: WorkflowSpec = {
  name: "detach-now",
  phases: [{ id: "p", title: "P", steps: [{ id: "slow", kind: "command", cmd: "slow" }] }],
};

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function Harness({
  cwd,
  orchestrator,
  onRunner,
}: {
  cwd: string;
  orchestrator: Orchestrator;
  onRunner: (runner: Runner) => void;
}) {
  const mountedRef = useRef(true);
  const runner = useWorkflowRunner({
    orchestrator,
    resolveWorkflowSpec: () => spec,
    mountedRef,
    cwd,
  });
  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );
  onRunner(runner);
  return <Text>{runner.wfNotice ?? ""}</Text>;
}

describe("TUI immediate mid-run detach", () => {
  let root: string;
  let savedArgv1: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "steamtrain-tui-detach-"));
    savedArgv1 = process.argv[1];
    const noop = join(root, "noop.mjs");
    writeFileSync(noop, "process.exit(0)\n");
    process.argv[1] = noop;
  });

  afterEach(() => {
    process.argv[1] = savedArgv1 as string;
    rmSync(root, { recursive: true, force: true });
  });

  it("aborts in-flight work immediately and hands off despite an abort-time error", async () => {
    let activeSignal: AbortSignal | undefined;
    const orchestrator = {
      canDispatchWorkflowSpec: () => ({ ok: true }),
      getConfig: () => ({}),
      runWorkflow(
        _name: string,
        _input: string,
        signal?: AbortSignal,
      ): AsyncIterable<WorkflowEvent> {
        activeSignal = signal;
        return (async function* () {
          yield {
            kind: "workflow_start",
            name: spec.name,
            phaseCount: 1,
            stepCount: 1,
            ts: Date.now(),
          };
          await new Promise<void>((resolve) =>
            signal?.addEventListener("abort", () => resolve(), { once: true }),
          );
          throw new Error("abort cleanup failed");
        })();
      },
    } as unknown as Orchestrator;

    let runner: Runner | undefined;
    const view = render(
      <Harness
        cwd={root}
        orchestrator={orchestrator}
        onRunner={(next) => {
          runner = next;
        }}
      />,
    );
    expect(runner?.runWorkflow(spec.name, "go")).toBe(true);
    for (let i = 0; i < 100 && !activeSignal; i++) await delay(10);
    expect(activeSignal).toBeDefined();

    const result = await runner?.detachRun();
    expect(result).toBeNull();
    expect(activeSignal?.aborted).toBe(true);

    let detached = false;
    for (let i = 0; i < 200 && !detached; i++) {
      const runs = await runner!.liveRunStoreRef.current.list();
      detached = runs.some((run) => run.source === "cli-detached" && run.detached);
      if (!detached) await delay(10);
    }
    expect(detached).toBe(true);
    view.unmount();
  });
});
