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
  phases: [{ id: "p", title: "P", steps: [{ id: "paid", kind: "command", cmd: "work" }] }],
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

  it("still caches a step that finished after the unmount", async () => {
    let finish: () => void = () => {};
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let done = false;
    const orchestrator = {
      canDispatchWorkflowSpec: () => ({ ok: true }),
      getConfig: () => ({}),
      runWorkflow(): AsyncIterable<WorkflowEvent> {
        return (async function* () {
          yield { kind: "workflow_start", name: spec.name, phaseCount: 1, stepCount: 1, ts: 0 };
          await finished;
          yield {
            kind: "step_done",
            phaseId: "p",
            stepId: "paid",
            result: { stepId: "paid", ok: true, output: "done", durationMs: 5, costUsd: 0.5 },
            cached: false,
            ts: 1,
          };
          done = true;
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

    mountedRef.current = false; // the App goes away while the step is still running
    finish();
    for (let i = 0; i < 100 && !done; i++) await delay(10);
    await delay(50);

    const cache = await runner!.cacheStoreRef.current.load(
      workflowCacheKey(spec.name, "go", root, spec),
    );
    expect(cache.get("paid")?.output).toBe("done");
    view.unmount();
  });
});
