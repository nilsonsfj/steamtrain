// @generated
"use strict";
var SteamtrainReducer = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // src/web/reducer.ts
  var reducer_exports = {};
  __export(reducer_exports, {
    initialWorkflowState: () => initialWorkflowState,
    workflowReducer: () => workflowReducer,
    workflowStateFromSpec: () => workflowStateFromSpec
  });

  // src/workflow/llm.ts
  function resolveLlmProvider(step) {
    if (step.provider) return step.provider;
    return step.model?.startsWith("claude") ? "anthropic" : "openai";
  }
  function llmStepApiId(step) {
    return step.api ?? resolveLlmProvider(step);
  }

  // src/workflow/reducer.ts
  var initialWorkflowState = {
    phases: [],
    results: [],
    started: false,
    done: false,
    ok: true,
    loopMarkers: [],
    pendingApprovals: []
  };
  function workflowStateFromSpec(spec) {
    return {
      name: spec.name,
      phases: spec.phases.map((p, idx) => ({
        phaseId: p.id,
        title: p.title || p.id,
        index: idx,
        stepCount: p.steps.length,
        done: false,
        ok: true,
        iteration: 1,
        steps: p.steps.map((st) => ({
          stepId: st.id,
          blockKind: st.kind ?? "worker",
          agent: "agent" in st ? st.agent : void 0,
          api: st.kind === "llm" ? llmStepApiId(st) : void 0,
          model: "model" in st ? st.model : void 0,
          effort: "effort" in st ? st.effort : void 0,
          cwd: "cwd" in st ? st.cwd : void 0,
          dependsOn: st.dependsOn,
          status: "pending",
          text: "",
          cached: false,
          loopTo: "loopTo" in st ? st.loopTo : void 0,
          maxIterations: "maxIterations" in st ? st.maxIterations : void 0,
          forEach: "forEach" in st ? st.forEach : void 0
        }))
      })),
      results: [],
      started: false,
      done: false,
      ok: true,
      loopMarkers: []
    };
  }
  function sameInstance(p, phaseId, iteration) {
    return p.phaseId === phaseId && (p.iteration ?? 1) === (iteration ?? 1);
  }
  function phaseOfStep(state, stepId) {
    for (const p of state.phases) {
      if (p.steps.some((s) => s.stepId === stepId)) return p.phaseId;
    }
    return void 0;
  }
  function updateStep(state, phaseId, stepId, iteration, fn) {
    return {
      ...state,
      phases: state.phases.map(
        (p) => sameInstance(p, phaseId, iteration) ? { ...p, steps: p.steps.map((s) => s.stepId === stepId ? fn(s) : s) } : p
      )
    };
  }
  function applyAgentEvent(step, event) {
    switch (event.kind) {
      case "text_delta":
        return event.thinking ? step : { ...step, text: step.text + event.text };
      case "tool_use":
        return { ...step, activity: `\u2699 ${event.name}` };
      case "tool_result":
        return {
          ...step,
          activity: `${event.isError ? "\u2717" : "\u2713"} ${event.name ?? "tool"}`
        };
      default:
        return step;
    }
  }
  function workflowReducer(state, action) {
    if (action.type === "reset") return initialWorkflowState;
    const e = action.event;
    switch (e.kind) {
      case "workflow_start":
        return {
          ...state,
          name: e.name,
          startedAt: e.ts,
          // Preserve prior phases if seeded (e.g., from the spec in the web client).
          // The TUI resets state via a separate "reset" action before workflow_start,
          // so it does not contain stale phase state.
          phases: state.phases.length > 0 ? state.phases : [],
          results: [],
          started: true,
          done: false,
          ok: true,
          loopMarkers: [],
          budget: void 0,
          pendingApprovals: []
        };
      case "phase_start": {
        const iter = e.iteration ?? 1;
        const existing = state.phases.find((p) => sameInstance(p, e.phaseId, iter));
        if (existing) {
          return {
            ...state,
            phases: state.phases.map(
              (p) => sameInstance(p, e.phaseId, iter) ? { ...p, title: e.title, index: e.index, stepCount: e.stepCount } : p
            )
          };
        }
        return {
          ...state,
          phases: [
            ...state.phases,
            {
              phaseId: e.phaseId,
              title: e.title,
              index: e.index,
              stepCount: e.stepCount,
              steps: [],
              done: false,
              ok: true,
              iteration: iter
            }
          ]
        };
      }
      case "fan_out":
        return {
          ...state,
          phases: state.phases.map((p) => {
            if (!sameInstance(p, e.phaseId, e.iteration)) return p;
            const updatedSteps = [...p.steps];
            for (let fi = 0; fi < e.count; fi++) {
              const childId = `${e.parentStepId}[${fi}]`;
              if (!updatedSteps.some((s) => s.stepId === childId)) {
                updatedSteps.push({
                  stepId: childId,
                  blockKind: "worker",
                  status: "pending",
                  text: "",
                  cached: false,
                  parentStepId: e.parentStepId
                });
              }
            }
            return {
              ...p,
              steps: updatedSteps,
              stepCount: Math.max(p.stepCount, updatedSteps.length)
            };
          })
        };
      case "step_start":
        return {
          ...state,
          phases: state.phases.map((p) => {
            if (!sameInstance(p, e.phaseId, e.iteration)) return p;
            const stepExists = p.steps.some((s) => s.stepId === e.stepId);
            const newStep = {
              stepId: e.stepId,
              blockKind: e.blockKind ?? "worker",
              agent: e.agent,
              api: e.api,
              model: e.model,
              effort: e.effort,
              cwd: e.cwd,
              dependsOn: e.dependsOn,
              parentStepId: e.parentStepId,
              item: e.item,
              status: "running",
              startedAt: e.ts,
              text: "",
              cached: false,
              loopTo: e.loopTo,
              maxIterations: e.maxIterations
            };
            return {
              ...p,
              stepCount: e.parentStepId && !stepExists ? Math.max(p.stepCount, p.steps.length + 1) : p.stepCount,
              steps: stepExists ? p.steps.map((s) => {
                if (s.stepId !== e.stepId) return s;
                const updates = Object.fromEntries(
                  Object.entries(newStep).filter(([, v]) => v !== void 0)
                );
                return { ...s, ...updates };
              }) : [...p.steps, newStep]
            };
          })
        };
      case "step_event":
        return updateStep(
          state,
          e.phaseId,
          e.stepId,
          e.iteration,
          (s) => applyAgentEvent(s, e.event)
        );
      case "step_workspace":
        return updateStep(state, e.phaseId, e.stepId, e.iteration, (s) => ({
          ...s,
          cwd: e.cwd,
          worktree: e.worktree ?? s.worktree
        }));
      case "step_retry":
        return updateStep(state, e.phaseId, e.stepId, e.iteration, (s) => ({
          ...s,
          attempts: e.attempt + 1,
          activity: `\u21BB retrying ${e.attempt + 1}/${e.maxAttempts} (${Math.round(e.delayMs)}ms)`
        }));
      case "gate_evaluated":
        return updateStep(state, e.phaseId, e.stepId, e.iteration, (s) => ({
          ...s,
          gate: { passed: e.passed, target: e.target, onFalse: e.onFalse },
          activity: e.passed ? `gate passed${e.target ? ` \u2192 ${e.target}` : ""}` : "gate blocked"
        }));
      case "step_done":
        return updateStep(state, e.phaseId, e.stepId, e.iteration, (s) => ({
          ...s,
          status: e.result.ok ? "done" : "error",
          endedAt: e.ts,
          result: e.result,
          worktree: e.result.worktree ?? s.worktree,
          cached: e.cached,
          text: s.text || e.result.output
        }));
      case "phase_done":
        return {
          ...state,
          phases: state.phases.map(
            (p) => sameInstance(p, e.phaseId, e.iteration) ? { ...p, done: true, ok: e.ok } : p
          )
        };
      case "budget_exceeded":
        return {
          ...state,
          budget: {
            scope: e.scope,
            stepId: e.stepId,
            limitUsd: e.limitUsd,
            spentUsd: e.spentUsd
          }
        };
      case "workflow_done":
        return { ...state, done: true, ok: e.ok, results: e.results };
      case "loop_iteration": {
        const gatePhaseId = phaseOfStep(state, e.gateStepId);
        if (gatePhaseId) {
          const instance = state.phases.find((p) => p.phaseId === gatePhaseId && p.done);
          console.assert(
            instance,
            "loop_iteration for gate %s arrived without a completed phase instance",
            e.gateStepId
          );
        }
        let gatePhaseIteration = 0;
        if (gatePhaseId) {
          for (let i = state.phases.length - 1; i >= 0; i--) {
            const p = state.phases[i];
            if (p.phaseId === gatePhaseId && p.iteration && p.done) {
              gatePhaseIteration = p.iteration;
              break;
            }
          }
        }
        return {
          ...state,
          loopMarkers: [
            ...state.loopMarkers ?? [],
            {
              gateStepId: e.gateStepId,
              loopTo: e.loopTo,
              iteration: e.iteration,
              maxIterations: e.maxIterations,
              gatePhaseId,
              gatePhaseIteration
            }
          ]
        };
      }
      case "approval_pending": {
        const withStep = updateStep(state, e.phaseId, e.stepId, e.iteration, (s) => ({
          ...s,
          activity: "\u23F3 awaiting approval",
          approval: {
            pending: true,
            reviewStepId: e.reviewStepId,
            message: e.message,
            output: e.output,
            diff: e.diff,
            onReject: e.onReject
          }
        }));
        const pending = {
          phaseId: e.phaseId,
          stepId: e.stepId,
          iteration: e.iteration ?? 1,
          reviewStepId: e.reviewStepId,
          message: e.message,
          output: e.output,
          diff: e.diff,
          onReject: e.onReject
        };
        const others = (withStep.pendingApprovals ?? []).filter(
          (p) => !(p.stepId === e.stepId && p.iteration === (e.iteration ?? 1))
        );
        return { ...withStep, pendingApprovals: [...others, pending] };
      }
      case "approval_resolved": {
        const withStep = updateStep(state, e.phaseId, e.stepId, e.iteration, (s) => ({
          ...s,
          activity: e.approved ? "approved" : "rejected",
          approval: {
            ...s.approval ?? { pending: false },
            pending: false,
            approved: e.approved,
            by: e.by,
            note: e.note
          }
        }));
        return {
          ...withStep,
          pendingApprovals: (withStep.pendingApprovals ?? []).filter(
            (p) => !(p.stepId === e.stepId && p.iteration === (e.iteration ?? 1))
          )
        };
      }
      default: {
        const _exhaustive = e;
        void _exhaustive;
        return state;
      }
    }
  }
  return __toCommonJS(reducer_exports);
})();
