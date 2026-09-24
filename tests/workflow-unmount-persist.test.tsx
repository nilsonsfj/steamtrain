import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Text } from "ink";
import { render } from "ink-testing-library";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Orchestrator } from "../src/orchestrator";
import { useWorkflowRunner } from "../src/tui/useWorkflowRunner";
import { type WorkflowEvent, type WorkflowSpec, workflowCacheKey } from "../src/workflow";

type Runner = ReturnType<typeof useWorkflowRunner>;
const spec: WorkflowSpec = {
  name: "unmount-persist",
  phases: [
    {
      id: "p",
      title: "P",
      steps: [
        { id: "first", kind: "command", cmd: "work" },
        { id: "second", kind: "command", cmd: "work" },
      ],
    },
  ],
};

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function Harness({
  cwd,
  orchestrator,
  mountedRef,
  onRunner,
}: {
  cwd: string;
  orchestrator: Orchestrator;
  /** The App's "still mounted" flag, which it clears as it unmounts. */
  mountedRef: { current: boolean };
  onRunner: (runner: Runner) => void;
}) {
  const runner = useWorkflowRunner({
    orchestrator,
    resolveWorkflowSpec: () => spec,
    mountedRef,
    cwd,
  });
  onRunner(runner);
  return <Text>{runner.wfNotice ?? ""}</Text>;
}

describe("a TUI run whose view unmounts", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "steamtrain-tui-unmount-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("still caches every step that finishes after the unmount", async () => {
    let finish: () => void = () => {};
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const orchestrator = {
      canDispatchWorkflowSpec: () => ({ ok: true }),
      getConfig: () => ({}),
      runWorkflow(): AsyncIterable<WorkflowEvent> {
        return (async function* () {
          const stepDone = (stepId: string, ts: number): WorkflowEvent => ({
            kind: "step_done",
            phaseId: "p",
            stepId,
            result: { stepId, ok: true, output: `${stepId} done`, durationMs: 5, costUsd: 0.5 },
            cached: false,
            ts,
          });
          yield { kind: "workflow_start", name: spec.name, phaseCount: 1, stepCount: 2, ts: 0 };
          await finished;
          yield stepDone("first", 1);
          // Another event between the two: the drain must not stop at the
          // first event it sees after the unmount.
          yield { kind: "step_start", phaseId: "p", stepId: "second", ts: 2 };
          yield stepDone("second", 3);
        })();
      },
    } as unknown as Orchestrator;

    let runner: Runner | undefined;
    const mountedRef = { current: true };
    const view = render(
      <Harness
        cwd={root}
        orchestrator={orchestrator}
        mountedRef={mountedRef}
        onRunner={(next) => {
          runner = next;
        }}
      />,
    );
    expect(runner?.runWorkflow(spec.name, "go")).toBe(true);
    for (let i = 0; i < 100 && !runner?.wf.started; i++) await delay(10);

    mountedRef.current = false; // the App goes away while the steps are still running
    finish();
    const key = workflowCacheKey(spec.name, "go", root, spec);
    let cache = await runner!.cacheStoreRef.current.load(key);
    for (let i = 0; i < 100 && !cache.has("second"); i++) {
      await delay(10);
      cache = await runner!.cacheStoreRef.current.load(key);
    }

    expect(cache.get("first")?.output).toBe("first done");
    expect(cache.get("second")?.output).toBe("second done");
    view.unmount();
  });
});
