import { Text } from "ink";
import { render } from "ink-testing-library";
import { useEffect, useRef } from "react";
import { describe, expect, it } from "vitest";
import type { Orchestrator } from "../src/orchestrator";
import { CANCEL_CONFIRM_NOTICE, QUIT_CONFIRM_NOTICE } from "../src/tui/confirm-action";
import { useWorkflowRunner } from "../src/tui/useWorkflowRunner";

type Runner = ReturnType<typeof useWorkflowRunner>;

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function ConfirmHarness({ onRunner }: { onRunner: (runner: Runner) => void }) {
  const mountedRef = useRef(true);
  const runner = useWorkflowRunner({
    orchestrator: {} as Orchestrator,
    resolveWorkflowSpec: () => undefined,
    mountedRef,
    cwd: "/tmp/steamtrain-confirm-action",
  });

  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  onRunner(runner);
  return <Text>{runner.wfNotice ?? ""}</Text>;
}

describe("workflow quit/cancel confirmation", () => {
  it("requestQuit is immediate when no owned run is active", async () => {
    let runner: Runner | undefined;
    const view = render(
      <ConfirmHarness
        onRunner={(next) => {
          runner = next;
        }}
      />,
    );
    await tick();
    expect(runner?.requestQuit()).toBe(true);
    expect(runner?.wfNotice).toBeNull();
    view.unmount();
  });

  it("requestQuit arms then confirms while an owned run is active", async () => {
    let runner: Runner | undefined;
    const view = render(
      <ConfirmHarness
        onRunner={(next) => {
          runner = next;
        }}
      />,
    );
    await tick();
    const ac = new AbortController();
    runner!.abortRef.current = ac;

    expect(runner!.requestQuit()).toBe(false);
    await tick();
    expect(runner!.wfNotice).toBe(QUIT_CONFIRM_NOTICE);
    expect(ac.signal.aborted).toBe(false);

    expect(runner!.requestQuit()).toBe(true);
    expect(ac.signal.aborted).toBe(false);
    view.unmount();
  });

  it("handleWorkflowCancel arms then aborts an owned run", async () => {
    let runner: Runner | undefined;
    const view = render(
      <ConfirmHarness
        onRunner={(next) => {
          runner = next;
        }}
      />,
    );
    await tick();
    const ac = new AbortController();
    runner!.abortRef.current = ac;

    runner!.handleWorkflowCancel();
    await tick();
    expect(runner!.wfNotice).toBe(CANCEL_CONFIRM_NOTICE);
    expect(ac.signal.aborted).toBe(false);

    runner!.handleWorkflowCancel();
    expect(ac.signal.aborted).toBe(true);
    view.unmount();
  });

  it("handleWorkflowCancel detaches an attached run immediately", async () => {
    let runner: Runner | undefined;
    const view = render(
      <ConfirmHarness
        onRunner={(next) => {
          runner = next;
        }}
      />,
    );
    await tick();
    const ac = new AbortController();
    runner!.attachAbortRef.current = ac;

    runner!.handleWorkflowCancel();
    expect(ac.signal.aborted).toBe(true);
    expect(runner!.wfNotice).toBeNull();
    view.unmount();
  });
});
