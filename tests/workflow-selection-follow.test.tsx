import { Text } from "ink";
import { render } from "ink-testing-library";
import { useEffect, useRef } from "react";
import { describe, expect, it } from "vitest";
import type { Orchestrator } from "../src/orchestrator";
import { useKeyboardInput } from "../src/tui/useKeyboardInput";
import { useWorkflowRunner } from "../src/tui/useWorkflowRunner";
import type { WorkflowSpec } from "../src/workflow";

const ESC = "\u001B";
const UP = "\u001B[A";

const SPEC: WorkflowSpec = {
  name: "selection-follow",
  phases: [
    {
      id: "phase",
      title: "Phase",
      steps: ["step-0", "step-1", "step-2"].map((id) => ({
        id,
        kind: "worker" as const,
        agent: "opencode",
        model: "opencode/qwen3.6-plus-free",
        prompt: id,
      })),
    },
  ],
};

type Runner = ReturnType<typeof useWorkflowRunner>;

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function SelectionFollowHarness({ onRunner }: { onRunner: (runner: Runner) => void }) {
  const mountedRef = useRef(true);
  const initializedRef = useRef(false);
  const runner = useWorkflowRunner({
    orchestrator: {} as Orchestrator,
    resolveWorkflowSpec: () => SPEC,
    mountedRef,
    cwd: "/tmp/steamtrain-selection-follow",
  });

  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;
    runner.setRunning(true);
    runner.wfDispatch({ type: "seed", spec: SPEC });
    runner.wfDispatch({
      type: "event",
      event: {
        kind: "workflow_start",
        name: SPEC.name,
        phaseCount: 1,
        stepCount: 3,
        ts: 1,
      },
    });
    return () => {
      mountedRef.current = false;
    };
  }, [runner.setRunning, runner.wfDispatch]);

  onRunner(runner);
  useKeyboardInput({
    mode: "workflow",
    modes: ["workflow"],
    prompt: {
      commandSuggestions: [],
      value: "",
      promptEditing: false,
      promptHistoryByMode: new Map(),
      historyBrowse: { browseIndex: null, draft: "" },
      promptArrowCtx: { deferToListNavigation: true, promptEditing: false },
    } as never,
    picker: {
      wfCreate: null,
      wfPreview: null,
      workflowIndex: 0,
      workflowEntries: [],
    } as never,
    runner,
    historyHook: { history: null } as never,
    workflowPickerActive: false,
    agentManagerOpen: false,
    apiManagerOpen: false,
    stepEditorOpen: false,
    runEditorOpen: false,
    answerInputOpen: false,
    inputFormPending: false,
    helpOpen: false,
    retryRetargetOpen: false,
    closeHelp: () => {},
    openAgentManager: () => {},
    openRunStepEditor: () => {},
    openAnswerInput: () => {},
    openRetryRetarget: () => {},
    focusCreateWorkflowPrompt: () => {},
    switchMode: () => {},
  });

  return (
    <Text>
      {runner.stepIndex}:{runner.wfFollowSelection ? "follow" : "manual"}
    </Text>
  );
}

describe("workflow selection auto-follow", () => {
  it("hands selection to arrow-key navigation and re-engages after reset", async () => {
    let runner: Runner | undefined;
    const view = render(
      <SelectionFollowHarness
        onRunner={(next) => {
          runner = next;
        }}
      />,
    );
    await tick();

    runner?.wfDispatch({
      type: "event",
      event: { kind: "step_start", phaseId: "phase", stepId: "step-1", iteration: 1, ts: 2 },
    });
    await tick();
    expect(view.lastFrame()).toContain("1:follow");

    view.stdin.write(UP);
    await tick();
    expect(view.lastFrame()).toContain("0:manual");

    runner?.wfDispatch({
      type: "event",
      event: {
        kind: "step_done",
        phaseId: "phase",
        stepId: "step-1",
        iteration: 1,
        cached: false,
        result: { stepId: "step-1", ok: true, output: "done", durationMs: 1 },
        ts: 3,
      },
    });
    runner?.wfDispatch({
      type: "event",
      event: { kind: "step_start", phaseId: "phase", stepId: "step-2", iteration: 1, ts: 4 },
    });
    await tick();
    expect(view.lastFrame()).toContain("0:manual");

    runner?.setRunning(false);
    await tick();
    view.stdin.write(ESC);
    await tick();
    expect(view.lastFrame()).toContain("0:follow");

    runner?.wfDispatch({ type: "seed", spec: SPEC });
    runner?.wfDispatch({
      type: "event",
      event: {
        kind: "workflow_start",
        name: SPEC.name,
        phaseCount: 1,
        stepCount: 3,
        ts: 5,
      },
    });
    runner?.setRunning(true);
    runner?.wfDispatch({
      type: "event",
      event: { kind: "step_start", phaseId: "phase", stepId: "step-2", iteration: 1, ts: 6 },
    });
    await tick();
    expect(view.lastFrame()).toContain("2:follow");

    view.unmount();
  });
});
