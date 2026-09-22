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
    ARRIVAL_NEXT_CANDIDATES: () => ARRIVAL_NEXT_CANDIDATES,
    NARRATION_CAP: () => NARRATION_CAP,
    SETTINGS_SECTIONS: () => SETTINGS_SECTIONS,
    SUBWORKFLOW_STEP_SEPARATOR: () => SUBWORKFLOW_STEP_SEPARATOR,
    TOUR_WORKFLOW_NAME: () => TOUR_WORKFLOW_NAME,
    appendNarration: () => appendNarration,
    applyWorkflowSessionOverrides: () => applyWorkflowSessionOverrides,
    applyWorkflowStepOverrides: () => applyWorkflowStepOverrides,
    approvalDeepLink: () => approvalDeepLink,
    arrivalReceiptCards: () => arrivalReceiptCards,
    arrivalRootCause: () => arrivalRootCause,
    buildArrivalReport: () => buildArrivalReport,
    createThroughputMeter: () => createThroughputMeter,
    describeSubWorkflow: () => describeSubWorkflow,
    findArrivalStep: () => findArrivalStep,
    formatArrivalHeadline: () => formatArrivalHeadline,
    formatArrivalReceipt: () => formatArrivalReceipt,
    formatSubWorkflowTarget: () => formatSubWorkflowTarget,
    initialWorkflowIndex: () => initialWorkflowIndex,
    initialWorkflowState: () => initialWorkflowState,
    isAgentlessWorkflow: () => isAgentlessWorkflow,
    isCascadeVictim: () => isCascadeVictim,
    isCredentialFreeWorkflow: () => isCredentialFreeWorkflow,
    isLiveOutputContainer: () => isLiveOutputContainer,
    isPageRoute: () => isPageRoute,
    liveOutputBody: () => liveOutputBody,
    narrateEvent: () => narrateEvent,
    narrateFromState: () => narrateFromState,
    nestedStepsOf: () => nestedStepsOf,
    parseDeepLink: () => parseDeepLink,
    parseRoute: () => parseRoute,
    parseRunDeepLink: () => parseRunDeepLink,
    projectCost: () => projectCost,
    resolveLiveOutputStep: () => resolveLiveOutputStep,
    runDeepLink: () => runDeepLink,
    runsDeepLink: () => runsDeepLink,
    sessionOverridesEmpty: () => sessionOverridesEmpty,
    settingsDeepLink: () => settingsDeepLink,
    shouldOfferStationLanding: () => shouldOfferStationLanding,
    splitSubWorkflowKey: () => splitSubWorkflowKey,
    subWorkflowRollup: () => subWorkflowRollup,
    workflowReducer: () => workflowReducer,
    workflowStateFromSpec: () => workflowStateFromSpec
  });

  // src/agents/permissions.ts
  var PERMISSION_PROFILES = ["read-only", "edit", "full"];
  function isPermissionProfile(value) {
    return typeof value === "string" && PERMISSION_PROFILES.includes(value);
  }
  function resolvePermissions(spec) {
    if (spec === void 0) return void 0;
    const declared = typeof spec === "string" ? { profile: spec } : spec;
    return {
      profile: declared.profile,
      allow: declared.allow ? [...declared.allow] : [],
      deny: declared.deny ? [...declared.deny] : [],
      onUnsupported: declared.onUnsupported ?? "fail",
      verify: declared.verify ?? declared.profile === "read-only"
    };
  }
  function effectivePermissions(layers) {
    for (const layer of layers) {
      if (layer !== void 0) return resolvePermissions(layer);
    }
    return void 0;
  }

  // src/workflow/llm.ts
  function resolveLlmProvider(step) {
    if (step.provider) return step.provider;
    return step.model?.startsWith("claude") ? "anthropic" : "openai";
  }
  function llmStepApiId(step) {
    return step.api ?? resolveLlmProvider(step);
  }

  // src/workflow/cost.ts
  var TOKEN_KEYS = ["input", "output", "cacheRead", "cacheWrite", "reasoning"];
  function emptyTokens() {
    return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
  }
  function addTokensInto(a, b) {
    if (!b) return a;
    for (const k of TOKEN_KEYS) a[k] += b[k] ?? 0;
    return a;
  }
  function addTokens(a, b) {
    return addTokensInto(addTokensInto(emptyTokens(), a), b);
  }
  function totalTokens(t) {
    if (!t) return 0;
    return (t.input ?? 0) + (t.output ?? 0) + (t.cacheRead ?? 0) + (t.cacheWrite ?? 0);
  }
  function replayedSpend(result) {
    return {
      ...result,
      costUsd: result.costUsd === void 0 ? void 0 : 0,
      tokens: result.tokens ? {} : void 0
    };
  }

  // src/workflow/step-kind.ts
  var MAX_WORKFLOW_NESTING_DEPTH = 5;
  function workflowStepKind(step) {
    return step.kind ?? "worker";
  }
  function isAgentBackedStep(step) {
    const kind = workflowStepKind(step);
    if (kind === "gate" || kind === "approval" || kind === "human" || kind === "command" || kind === "llm" || kind === "workflow") {
      return false;
    }
    if (kind === "merge") {
      const merge = step;
      return merge.onConflict === "agent" || typeof merge.agent === "string" || typeof merge.model === "string" || typeof merge.modelClass === "string";
    }
    if (kind === "distributor" || kind === "consolidator") {
      const block = step;
      return typeof block.agent === "string" || typeof block.model === "string" || typeof block.modelClass === "string";
    }
    const worker = step;
    return typeof worker.agent === "string" || typeof worker.model === "string" || typeof worker.modelClass === "string";
  }

  // src/workflow/reducer.ts
  function editedPermissions(patched, current) {
    if (patched === void 0) return current;
    const resolved = isPermissionProfile(patched) ? resolvePermissions(patched) : void 0;
    if (!resolved) return void 0;
    return {
      profile: resolved.profile,
      ...resolved.verify ? { verify: true } : {}
    };
  }
  function specStepPermissions(step, spec) {
    if (!isAgentBackedStep(step)) return void 0;
    const declared = step.permissions;
    const perms = effectivePermissions([declared, spec.permissions]);
    if (!perms) return void 0;
    return {
      profile: perms.profile,
      ...perms.allow.length > 0 ? { allow: perms.allow.length } : {},
      ...perms.deny.length > 0 ? { deny: perms.deny.length } : {},
      ...perms.verify ? { verify: true } : {}
    };
  }
  var initialWorkflowState = {
    phases: [],
    results: [],
    started: false,
    done: false,
    ok: true,
    loopMarkers: [],
    pendingApprovals: [],
    pendingInputs: []
  };
  function flattenSteps(state) {
    const out = [];
    for (const phase of state.phases) {
      for (const step of phase.steps) out.push({ phase, step });
    }
    return out;
  }
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
          permissions: specStepPermissions(st, spec),
          workflow: st.kind === "workflow" ? st.workflow : void 0,
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
      case "usage": {
        if (!event.tokens && event.costUsd === void 0) return step;
        return {
          ...step,
          usage: {
            tokens: event.tokens ? addTokens(step.usage?.tokens, event.tokens) : step.usage?.tokens,
            costUsd: event.costUsd === void 0 ? step.usage?.costUsd : (step.usage?.costUsd ?? 0) + event.costUsd
          }
        };
      }
      case "result": {
        if (!event.tokens && event.costUsd === void 0) return step;
        return {
          ...step,
          usage: {
            tokens: event.tokens ?? step.usage?.tokens,
            costUsd: event.costUsd ?? step.usage?.costUsd
          }
        };
      }
      default:
        return step;
    }
  }
  function workflowReducer(state, action) {
    if (action.type === "reset") return initialWorkflowState;
    if (action.type === "seed") return workflowStateFromSpec(action.spec);
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
          pendingApprovals: [],
          pendingInputs: [],
          paused: false,
          pausedBy: void 0,
          editedSteps: void 0
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
              permissions: e.permissions,
              dependsOn: e.dependsOn,
              parentStepId: e.parentStepId,
              item: e.item,
              status: "running",
              startedAt: e.ts,
              text: "",
              cached: false,
              loopTo: e.loopTo,
              maxIterations: e.maxIterations,
              edited: state.editedSteps?.[e.stepId] ? true : void 0
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
        return updateStep(state, e.phaseId, e.stepId, e.iteration, (s) => {
          const nextAgent = e.failover?.toAgent ?? s.agent;
          const nextModel = e.failover?.toModel ?? s.model;
          const nextEffort = e.failover?.toEffort ?? s.effort;
          const activity = e.failover ? `\u21BB failover \u2192 ${e.failover.toAgent}/${e.failover.toModel} (${e.attempt + 1}/${e.maxAttempts})` : `\u21BB retrying ${e.attempt + 1}/${e.maxAttempts} (${Math.round(e.delayMs)}ms)`;
          return {
            ...s,
            attempts: e.attempt + 1,
            agent: nextAgent,
            model: nextModel,
            effort: nextEffort,
            activity
          };
        });
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
          text: s.text || e.result.output,
          edited: s.edited || e.result.edited || void 0
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
        return { ...state, done: true, ok: e.ok, results: e.results, paused: false };
      case "run_paused":
        return { ...state, paused: true, pausedBy: e.by };
      case "run_resumed":
        return { ...state, paused: false, pausedBy: void 0 };
      case "step_edited": {
        const editedSteps = {
          ...state.editedSteps,
          [e.stepId]: { ...state.editedSteps?.[e.stepId], ...e.patch }
        };
        return {
          ...state,
          editedSteps,
          phases: state.phases.map((p) => ({
            ...p,
            steps: p.steps.map(
              (s) => s.stepId === e.stepId && s.status === "pending" ? {
                ...s,
                edited: true,
                model: e.patch.model ?? s.model,
                effort: e.patch.effort !== void 0 ? e.patch.effort || void 0 : s.effort,
                permissions: editedPermissions(e.patch.permissions, s.permissions)
              } : s
            )
          }))
        };
      }
      case "step_killed":
        return {
          ...state,
          phases: state.phases.map((p) => ({
            ...p,
            steps: p.steps.map(
              (s) => s.stepId === e.stepId && s.status === "running" ? { ...s, killed: true } : s
            )
          }))
        };
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
      case "human_input_pending": {
        const withStep = updateStep(state, e.phaseId, e.stepId, e.iteration, (s) => ({
          ...s,
          activity: e.origin === "agent-question" ? "\u270E agent asked a question" : "\u270E awaiting human input",
          humanInput: {
            pending: true,
            prompt: e.prompt,
            choices: e.choices,
            outputSchema: e.outputSchema,
            origin: e.origin,
            attempt: e.attempt,
            retryError: e.retryError
          }
        }));
        const pending = {
          phaseId: e.phaseId,
          stepId: e.stepId,
          iteration: e.iteration ?? 1,
          attempt: e.attempt,
          prompt: e.prompt,
          choices: e.choices,
          outputSchema: e.outputSchema,
          origin: e.origin,
          retryError: e.retryError
        };
        const others = (withStep.pendingInputs ?? []).filter(
          (p) => !(p.stepId === e.stepId && p.iteration === (e.iteration ?? 1))
        );
        return { ...withStep, pendingInputs: [...others, pending] };
      }
      case "human_input_resolved": {
        const withStep = updateStep(state, e.phaseId, e.stepId, e.iteration, (s) => ({
          ...s,
          activity: e.canceled ? "input canceled" : "answered",
          humanInput: {
            ...s.humanInput ?? { pending: false },
            pending: false,
            value: e.value,
            by: e.by,
            canceled: e.canceled
          }
        }));
        return {
          ...withStep,
          pendingInputs: (withStep.pendingInputs ?? []).filter(
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

  // src/workflow/narration.ts
  var NARRATION_CAP = 40;
  function narrateEvent(ev) {
    switch (ev.kind) {
      case "workflow_start":
        return line(ev, `Started ${ev.name} \u2014 ${ev.stepCount} step${ev.stepCount === 1 ? "" : "s"}.`);
      case "phase_start":
        return line(ev, `Entered ${phaseName(ev.title)}.`, { phaseId: ev.phaseId });
      case "step_start":
        return line(ev, stepStartCopy(ev), { phaseId: ev.phaseId, stepId: ev.stepId });
      case "fan_out":
        return line(
          ev,
          `${ev.count} step${ev.count === 1 ? "" : "s"} branched from '${ev.parentStepId}'.`,
          { phaseId: ev.phaseId, stepId: ev.parentStepId }
        );
      case "gate_evaluated":
        return line(ev, gateCopy(ev), { phaseId: ev.phaseId, stepId: ev.stepId });
      case "step_done":
        return line(ev, stepDoneCopy(ev), { phaseId: ev.phaseId, stepId: ev.stepId });
      case "phase_done":
        return line(ev, ev.ok ? `Finished ${ev.phaseId}.` : `Held at ${ev.phaseId}.`, {
          phaseId: ev.phaseId
        });
      case "workflow_done":
        return line(
          ev,
          ev.ok ? "Run complete \u2014 arrival report ready." : ev.budgetExceeded ? "Stopped \u2014 cost budget reached." : "Stopped before finishing."
        );
      case "step_retry":
        return line(
          ev,
          ev.failover ? `Step '${ev.stepId}' failing over ${ev.failover.fromAgent}/${ev.failover.fromModel} \u2192 ${ev.failover.toAgent}/${ev.failover.toModel} (${ev.failover.failureKind}).` : `Step '${ev.stepId}' will try again (${ev.attempt}/${ev.maxAttempts}).`,
          {
            phaseId: ev.phaseId,
            stepId: ev.stepId
          }
        );
      default:
        return null;
    }
  }
  function appendNarration(lines, ev) {
    const next = narrateEvent(ev);
    if (!next) return lines;
    let suffix = lines.length;
    while (lines.some((line2) => line2.id === next.id)) {
      next.id = `${next.id}-${suffix++}`;
    }
    const out = lines.length >= NARRATION_CAP ? lines.slice(lines.length - NARRATION_CAP + 1) : [...lines];
    out.push(next);
    return out;
  }
  function narrateFromState(state) {
    const lines = [];
    if (state.started && state.name) {
      const stepCount = state.phases.reduce((n, p) => n + p.steps.length, 0);
      lines.push({
        id: `workflow_start-${state.name}`,
        text: `Started ${state.name} \u2014 ${stepCount} step${stepCount === 1 ? "" : "s"}.`,
        ts: 0
      });
    }
    for (const phase of state.phases) {
      lines.push({
        id: `phase_start-${phase.phaseId}-${phase.iteration ?? 1}`,
        text: `Entered ${phaseName(phase.title)}.`,
        ts: 0,
        phaseId: phase.phaseId,
        iteration: phase.iteration ?? 1
      });
      for (const step of phase.steps) {
        const done = narrateStepFromState(phase, step);
        if (done) lines.push(done);
      }
    }
    if (state.done) {
      lines.push({
        id: `workflow_done-${state.ok ? "ok" : "fail"}`,
        text: state.ok ? "Run complete \u2014 arrival report ready." : state.budget ? "Stopped \u2014 cost budget reached." : "Stopped before finishing.",
        ts: 0
      });
    }
    return lines.slice(-NARRATION_CAP);
  }
  function narrateStepFromState(phase, step) {
    if (step.status === "pending") return null;
    if (step.status === "running") {
      return {
        id: `step_start-${phase.phaseId}-${phase.iteration ?? 1}-${step.stepId}`,
        text: stepStartCopy({
          stepId: step.stepId,
          blockKind: step.blockKind,
          agent: step.agent
        }),
        ts: step.startedAt ?? 0,
        phaseId: phase.phaseId,
        stepId: step.stepId,
        iteration: phase.iteration ?? 1
      };
    }
    return {
      id: `step_done-${phase.phaseId}-${phase.iteration ?? 1}-${step.stepId}`,
      text: stepDoneCopy({
        stepId: step.stepId,
        result: step.result ?? {
          stepId: step.stepId,
          ok: step.status === "done",
          output: step.text,
          durationMs: 0
        },
        cached: step.cached
      }),
      ts: step.endedAt ?? 0,
      phaseId: phase.phaseId,
      stepId: step.stepId,
      iteration: phase.iteration ?? 1
    };
  }
  function stepStartCopy(ev) {
    const kind = ev.blockKind;
    if (kind === "gate") return `Gate '${ev.stepId}' is watching.`;
    if (kind === "distributor") return `Distributor '${ev.stepId}' is fanning out work.`;
    if (kind === "consolidator") return `Merge '${ev.stepId}' is writing the report.`;
    if (kind === "approval") return `Checkpoint '${ev.stepId}' awaits a decision.`;
    if (kind === "human") return `Step '${ev.stepId}' needs an answer.`;
    if (kind === "command") return `Step '${ev.stepId}' started.`;
    if (kind === "llm") return `Step '${ev.stepId}' called the model.`;
    if (kind === "issues") return `Reporter '${ev.stepId}' is filing findings.`;
    if (ev.agent) return `Step '${ev.stepId}' (${ev.agent}) is underway.`;
    return `Step '${ev.stepId}' is underway.`;
  }
  function stepDoneCopy(ev) {
    if (ev.result.skipped) return `Step '${ev.stepId}' was skipped.`;
    if (!ev.result.ok) return `Step '${ev.stepId}' failed.`;
    if (ev.cached) return `Step '${ev.stepId}' finished (from cache).`;
    return `Step '${ev.stepId}' finished.`;
  }
  function gateCopy(ev) {
    if (ev.passed) return `Gate '${ev.stepId}' cleared.`;
    if (ev.onFalse === "continue") return `Gate '${ev.stepId}' held for another iteration.`;
    return `Gate '${ev.stepId}' diverted the run.`;
  }
  function phaseName(title) {
    const cleaned = title.replace(/^\s*\d+\s*[.:)—-]\s*/, "").trim();
    return cleaned || title;
  }
  function line(ev, text, ids = {}) {
    const phaseId = ids.phaseId ?? ev.phaseId;
    const stepId = ids.stepId ?? ev.stepId;
    const iteration = ev.iteration ?? 1;
    return {
      id: `${ev.kind}-${phaseId ?? ""}-${iteration}-${stepId ?? ""}-${ev.ts}`,
      text,
      ts: ev.ts,
      phaseId,
      stepId,
      iteration
    };
  }

  // src/workflow/arrival-report.ts
  var DEFAULT_NEXT_CANDIDATES = ["bug-hunt", "code-review", "mainline-stream", "mainline"];
  var ARRIVAL_NEXT_CANDIDATES = DEFAULT_NEXT_CANDIDATES;
  function buildArrivalReport(state, opts = {}) {
    if (!state.done) return null;
    const flat = flattenSteps(state);
    const leaves = leafResults(state);
    let okCount = 0;
    let failCount = 0;
    let skipCount = 0;
    let blockedCount = 0;
    let costUsd = 0;
    let tokens = 0;
    let durationMs = 0;
    let costReported = false;
    let tokensReported = false;
    for (const result of leaves) {
      if (result.skipped) skipCount += 1;
      else if (result.ok) okCount += 1;
      else if (isCascadeVictim(result)) blockedCount += 1;
      else failCount += 1;
      costUsd += result.costUsd ?? 0;
      tokens += totalTokens(result.tokens);
      if (result.costUsd !== void 0) costReported = true;
      if (result.tokens !== void 0) tokensReported = true;
      durationMs += result.durationMs ?? 0;
    }
    const heroStep = findArrivalStep(flat.map((f) => f.step));
    let hero = (heroStep?.result?.output ?? heroStep?.text ?? "").trim() || fallbackHero(state);
    if (!state.ok) {
      const failures = rootFailureLines(flat.map((f) => f.step));
      if (failures.length > 0) hero = [...failures, "", hero].join("\n");
    }
    const ranBilledStep = flat.some(
      ({ step }) => Boolean(step.agent || step.api) && step.result !== void 0 && !step.result.skipped
    );
    const billedSteps = flat.map(({ step }) => step).filter((step) => Boolean(step.agent || step.api) && step.result && !step.result.skipped);
    if (billedSteps.some((step) => step.cached)) {
      const ran = billedSteps.filter((step) => !step.cached);
      if (ran.every((step) => step.result?.costUsd !== void 0)) costReported = true;
      if (ran.every((step) => step.result?.tokens !== void 0)) tokensReported = true;
    }
    const agentless = opts.credentialFree === true || !ranBilledStep && costUsd === 0 && tokens === 0 && failCount === 0 && blockedCount === 0;
    const nextCandidates = opts.nextCandidates ?? DEFAULT_NEXT_CANDIDATES;
    const current = state.name;
    const next = opts.nextWorkflow ?? nextCandidates.find(
      (name) => name !== current && (!opts.availableWorkflows || opts.availableWorkflows.has(name))
    );
    const destinations = [{ id: "again", label: "Ride again", key: "r" }];
    if (next) {
      destinations.push({
        id: "next",
        label: `Try ${next}`,
        workflow: next,
        key: "n"
      });
    }
    destinations.push({ id: "history", label: "See past runs", key: "h" });
    return {
      hero,
      heroStepId: heroStep?.stepId,
      receipt: {
        ok: Boolean(state.ok),
        durationMs: opts.elapsedMs && opts.elapsedMs > 0 ? opts.elapsedMs : durationMs,
        okCount,
        failCount,
        skipCount,
        blockedCount,
        costUsd,
        tokens,
        costReported,
        tokensReported,
        agentless
      },
      notices: arrivalNotices(flat.map((f) => f.step)),
      destinations
    };
  }
  var LEGACY_CASCADE_ERROR = /^dependency '[^']+' failed(:|$)/;
  function isCascadeVictim(result) {
    if (!result) return false;
    return Boolean(result.dependencyFailed) || LEGACY_CASCADE_ERROR.test(result.error ?? "");
  }
  function arrivalRootCause(state) {
    if (!state.done || state.ok) return null;
    const blocked = [];
    let root = null;
    for (const phase of state.phases) {
      for (const step of phase.steps) {
        const result2 = step.result;
        if (!result2 || result2.childResults?.length) continue;
        if (result2.ok || result2.skipped) continue;
        if (isCascadeVictim(result2)) {
          blocked.push(step.stepId);
          continue;
        }
        if (!root) {
          root = { step, phaseNumber: phase.index + 1, phaseTitle: phase.title };
        }
      }
    }
    if (!root) return null;
    const result = root.step.result;
    const firstLine = (result?.error ?? "").split("\n", 1)[0]?.trim();
    return {
      stepId: root.step.stepId,
      blockKind: root.step.blockKind,
      phaseNumber: root.phaseNumber,
      phaseTitle: root.phaseTitle,
      error: firstLine || "failed",
      durationMs: result?.durationMs,
      killed: Boolean(result?.killed),
      blocked
    };
  }
  var SEVERITY_RANK = {
    critical: 0,
    high: 1,
    medium: 2
  };
  function arrivalNotices(steps) {
    const notices = [];
    for (const step of steps) {
      const result = step.result;
      if (result?.childResults?.length) continue;
      if (result && !result.ok && !result.skipped) {
        const firstLine = (result.error ?? "").split("\n", 1)[0]?.trim();
        const detail = firstLine && firstLine.length > 160 ? `${firstLine.slice(0, 159)}\u2026` : firstLine;
        if (result.killed) {
          notices.push({
            severity: "high",
            stepId: step.stepId,
            what: `${step.stepId} was killed`,
            where: detail?.startsWith("killed ") ? detail.slice("killed ".length) : detail
          });
        } else if (result.dependencyFailed) {
          notices.push({
            severity: "high",
            stepId: step.stepId,
            what: `${step.stepId} never ran`,
            where: `${result.dependencyFailed} failed before it`
          });
        } else {
          notices.push({
            severity: "critical",
            stepId: step.stepId,
            what: `${step.stepId} failed`,
            where: detail
          });
        }
        continue;
      }
      if (step.gate && step.gate.passed === false && !step.loopTo) {
        notices.push({
          severity: "high",
          stepId: step.stepId,
          what: `gate ${step.stepId} did not pass`,
          where: step.gate.target ? `expected ${step.gate.target}` : void 0
        });
        continue;
      }
      const attempts = step.attempts ?? result?.attempts;
      if (typeof attempts === "number" && attempts > 1) {
        notices.push({
          severity: "medium",
          stepId: step.stepId,
          what: `${step.stepId} needed ${attempts} attempts`,
          where: "it succeeded on the last one"
        });
        continue;
      }
      if (result?.skipped) {
        notices.push({
          severity: "medium",
          stepId: step.stepId,
          what: `${step.stepId} was skipped`,
          where: "its condition was false"
        });
      }
    }
    return sortNotices(notices);
  }
  function sortNotices(notices) {
    return notices.map((notice, index) => ({ notice, index })).sort(
      (a, b) => SEVERITY_RANK[a.notice.severity] - SEVERITY_RANK[b.notice.severity] || a.index - b.index
    ).map((entry) => entry.notice);
  }
  function findArrivalStep(steps) {
    const consolidators = steps.filter(
      (s) => s.blockKind === "consolidator" && s.status === "done" && s.result?.ok !== false
    );
    if (consolidators.length > 0) return consolidators[consolidators.length - 1];
    const withOutput = [...steps].reverse().find(
      (s) => (s.status === "done" || s.status === "error") && (s.result?.output ?? s.text).trim().length > 0 && !s.result?.skipped
    );
    return withOutput;
  }
  function formatArrivalHeadline(receipt, workflowName) {
    const name = (workflowName ?? "").trim();
    const subject = name === "tour" ? "Tour" : name || "Run";
    const outcome = receipt.ok ? "complete" : "stopped";
    const parts = [`${subject} ${outcome}`];
    if (receipt.agentless) parts.push("$0");
    else if (receipt.costUsd > 0) parts.push(`$${receipt.costUsd.toFixed(4)}`);
    else if (receipt.costReported !== false) parts.push("$0");
    parts.push(`${(receipt.durationMs / 1e3).toFixed(1)}s`);
    if (receipt.failCount > 0) parts.push(`${receipt.failCount} failed`);
    return parts.join(" \xB7 ");
  }
  function arrivalReceiptCards(receipt) {
    const ranParts = [`${receipt.okCount} ok`];
    if (receipt.failCount) ranParts.push(`${receipt.failCount} failed`);
    const notRun = receipt.skipCount + (receipt.blockedCount ?? 0);
    if (notRun) ranParts.push(`${notRun} skipped`);
    const cost = receipt.agentless ? "$0 \xB7 no agents" : receipt.costUsd > 0 ? `$${receipt.costUsd.toFixed(4)}` : receipt.costReported === false ? "not reported" : "$0";
    const produced = receipt.tokens > 0 ? `${compactTokens(receipt.tokens)} tokens` : receipt.agentless ? "workflow output" : receipt.tokensReported === false ? "tokens not reported" : "no tokens billed";
    return [
      { id: "ran", label: "What ran", value: ranParts.join(" \xB7 ") },
      { id: "cost", label: "What it cost", value: cost },
      { id: "produced", label: "What it produced", value: produced }
    ];
  }
  function formatArrivalReceipt(receipt) {
    const parts = [];
    parts.push(`${(receipt.durationMs / 1e3).toFixed(1)}s`);
    parts.push(`${receipt.okCount} ok`);
    if (receipt.failCount) parts.push(`${receipt.failCount} failed`);
    const notRun = receipt.skipCount + (receipt.blockedCount ?? 0);
    if (notRun) parts.push(`${notRun} skipped`);
    if (receipt.agentless) parts.push("$0 \xB7 no agents");
    else {
      if (receipt.costUsd > 0) parts.push(`$${receipt.costUsd.toFixed(4)}`);
      if (receipt.tokens > 0) parts.push(`${compactTokens(receipt.tokens)} tok`);
    }
    return parts.join(" \xB7 ");
  }
  function leafResults(state) {
    const fromResults = (state.results ?? []).filter((r) => !r.childResults?.length);
    if (fromResults.length > 0) return fromResults;
    const out = [];
    for (const phase of state.phases) {
      for (const step of phase.steps) {
        if (step.result) out.push(step.cached ? replayedSpend(step.result) : step.result);
      }
    }
    return out.filter((r) => !r.childResults?.length);
  }
  function rootFailureLines(steps) {
    const failed = steps.filter((s) => s.result && !s.result.ok && !s.result.skipped);
    const roots = failed.filter((s) => !isCascadeVictim(s.result));
    const shown = roots.length > 0 ? roots : failed;
    return shown.map((s) => {
      const firstErrLine = (s.result?.error ?? "failed").split("\n", 1)[0]?.trim() || "failed";
      const capped = firstErrLine.length > 200 ? `${firstErrLine.slice(0, 199)}\u2026` : firstErrLine;
      return `\u2717 ${s.stepId}: ${capped}`;
    });
  }
  function fallbackHero(state) {
    if (state.ok) {
      return state.name ? `Workflow '${state.name}' finished, but no consolidator report was produced. Press i to show step details.` : "Workflow finished, but no consolidator report was produced. Press i to show step details.";
    }
    return state.name ? `Workflow '${state.name}' stopped short. Press i to show step details and find the stall.` : "Workflow stopped short. Press i to show step details and find the stall.";
  }
  function compactTokens(n) {
    if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
    return String(n);
  }

  // src/workflow/first-run.ts
  var TOUR_WORKFLOW_NAME = "tour";
  function stepNeedsAgentCli(step) {
    if (step.kind === "worker" || step.kind === "processor" || !step.kind) {
      return true;
    }
    if (step.kind === "distributor" || step.kind === "consolidator") {
      return Boolean(step.agent || step.model || step.modelClass);
    }
    if (step.kind === "merge") {
      return Boolean(step.agent || step.model || step.modelClass);
    }
    return false;
  }
  function isAgentlessWorkflow(spec) {
    for (const phase of spec.phases) {
      for (const step of phase.steps) {
        if (stepNeedsAgentCli(step)) return false;
      }
    }
    return true;
  }
  function isCredentialFreeWorkflow(spec) {
    for (const phase of spec.phases) {
      for (const step of phase.steps) {
        if (stepNeedsAgentCli(step) || step.kind === "llm") return false;
      }
    }
    return true;
  }
  function shouldOfferStationLanding(opts) {
    if (opts.hasRunHistory) return false;
    if (opts.rememberedSelection) return false;
    return true;
  }
  function tourWorkflowIndex(entries) {
    return entries.findIndex((entry) => entry.name === TOUR_WORKFLOW_NAME);
  }
  function initialWorkflowIndex(entries, opts = { preferTour: false }) {
    if (entries.length === 0) return 0;
    if (opts.rememberedName) {
      const remembered = entries.findIndex((entry) => entry.name === opts.rememberedName);
      if (remembered >= 0) return remembered;
    }
    if (opts.preferTour) {
      const tour = tourWorkflowIndex(entries);
      if (tour >= 0) return tour;
    }
    return 0;
  }

  // src/web/run-deep-link.ts
  var RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  var STEP_ID_PATTERN = /^[\w:.-]+$/;
  function parseDeepLink(hash) {
    const trimmed = hash.trim();
    const match = /^#run-([^/]+)(?:\/step\/(.+))?$/i.exec(trimmed);
    if (!match || !RUN_ID_PATTERN.test(match[1])) return null;
    const runId = match[1].toLowerCase();
    const rawStep = match[2];
    if (rawStep && !STEP_ID_PATTERN.test(rawStep)) return { runId };
    return { runId, stepId: rawStep || void 0 };
  }
  function parseRunDeepLink(hash) {
    const result = parseDeepLink(hash);
    return result ? result.runId : null;
  }
  function runDeepLink(runId) {
    return `#run-${runId.toLowerCase()}`;
  }
  function approvalDeepLink(runId, stepId) {
    return `#run-${runId.toLowerCase()}/step/${stepId}`;
  }
  var SETTINGS_SECTIONS = ["runners", "limits"];
  function parseRoute(hash) {
    const trimmed = hash.trim();
    const run = parseDeepLink(trimmed);
    if (run) return { kind: "run", runId: run.runId, stepId: run.stepId };
    const runs = /^#runs(?:\/([^/]*))?$/i.exec(trimmed);
    if (runs) {
      const raw2 = runs[1] ?? "";
      return RUN_ID_PATTERN.test(raw2) ? { kind: "runs", runId: raw2.toLowerCase() } : { kind: "runs" };
    }
    const match = /^#settings(?:\/([\w-]+))?$/i.exec(trimmed);
    if (!match) return null;
    const raw = (match[1] ?? "").toLowerCase();
    const section = SETTINGS_SECTIONS.includes(raw) ? raw : SETTINGS_SECTIONS[0];
    return { kind: "settings", section };
  }
  function isPageRoute(hash) {
    const route = parseRoute(hash);
    return route?.kind === "settings" || route?.kind === "runs";
  }
  function settingsDeepLink(section = SETTINGS_SECTIONS[0]) {
    return `#settings/${section}`;
  }
  function runsDeepLink(runId) {
    return runId ? `#runs/${runId.toLowerCase()}` : "#runs";
  }

  // src/workflow/overrides.ts
  var AGENT_FIELD_KEYS = /* @__PURE__ */ new Set([
    "agent",
    "model",
    "modelClass",
    "fallbackModels",
    "modelFailover",
    "prompt",
    "cwd",
    "env",
    "extraArgs",
    "permissions",
    "effort",
    "stepTimeoutSec",
    "stepTimeoutMs"
  ]);
  var LLM_FIELD_KEYS = /* @__PURE__ */ new Set([
    "model",
    "prompt",
    "effort",
    "stepTimeoutSec"
  ]);
  var LEGACY_WF_KEY_PREFIX = "__wf_";
  function isWorkflowTimeoutValue(value) {
    return value === null || typeof value === "number";
  }
  function isStructuredSessionOverridesPayload(record) {
    if ("stepTimeoutSec" in record && isWorkflowTimeoutValue(record.stepTimeoutSec) || "workflowTimeoutSec" in record && isWorkflowTimeoutValue(record.workflowTimeoutSec)) {
      return true;
    }
    if (!("steps" in record)) return false;
    const steps = record.steps;
    if (typeof steps !== "object" || steps === null || Array.isArray(steps)) return false;
    const stepEntries = Object.entries(steps);
    if (stepEntries.length === 0) return true;
    return stepEntries.every(
      ([, patch]) => patch !== null && typeof patch === "object" && !Array.isArray(patch)
    );
  }
  function applyAgentPatch(step, patch) {
    const next = { ...step };
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) delete next[key];
      else next[key] = value;
    }
    return next;
  }
  function sessionOverridesEmpty(overrides) {
    if (!overrides) return true;
    const hasSteps = overrides.steps && Object.keys(overrides.steps).length > 0;
    const hasWorkflowFields = overrides.stepTimeoutSec !== void 0 || overrides.workflowTimeoutSec !== void 0;
    return !hasSteps && !hasWorkflowFields;
  }
  function normalizeSessionOverrides(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) return void 0;
    for (const key of Object.keys(input)) {
      if (key.startsWith(LEGACY_WF_KEY_PREFIX)) {
        throw new Error(`legacy override key '${key}' is not supported; use structured overrides`);
      }
    }
    const record = input;
    if (isStructuredSessionOverridesPayload(record)) {
      return input;
    }
    return { steps: input };
  }
  function applyWorkflowSessionOverrides(spec, overrides) {
    const normalized = normalizeSessionOverrides(overrides);
    if (!normalized || sessionOverridesEmpty(normalized)) return spec;
    let next = applyWorkflowStepOverrides(spec, normalized.steps);
    if (normalized.stepTimeoutSec === null) {
      const { stepTimeoutSec: _removed, ...rest } = next;
      next = rest;
    } else if (normalized.stepTimeoutSec !== void 0) {
      next = { ...next, stepTimeoutSec: normalized.stepTimeoutSec };
    }
    if (normalized.workflowTimeoutSec === null) {
      const { workflowTimeoutSec: _removed, ...rest } = next;
      next = rest;
    } else if (normalized.workflowTimeoutSec !== void 0) {
      next = { ...next, workflowTimeoutSec: normalized.workflowTimeoutSec };
    }
    return next;
  }
  var SUBWORKFLOW_STEP_SEPARATOR = "::";
  function splitSubWorkflowKey(key) {
    const idx = key.indexOf(SUBWORKFLOW_STEP_SEPARATOR);
    if (idx < 0) return { head: key };
    return {
      head: key.slice(0, idx),
      rest: key.slice(idx + SUBWORKFLOW_STEP_SEPARATOR.length)
    };
  }
  function partitionOverrideKeys(overrides) {
    const own = {};
    const nested = /* @__PURE__ */ new Map();
    for (const [key, patch] of Object.entries(overrides)) {
      const { head, rest } = splitSubWorkflowKey(key);
      if (rest === void 0) {
        own[key] = patch;
        continue;
      }
      let group = nested.get(head);
      if (!group) {
        group = {};
        nested.set(head, group);
      }
      group[rest] = patch;
    }
    return { own, nested };
  }
  function applyWorkflowStepOverrides(spec, overrides) {
    if (!overrides || Object.keys(overrides).length === 0) return spec;
    const { own, nested } = partitionOverrideKeys(overrides);
    return {
      ...spec,
      phases: spec.phases.map((phase) => ({
        ...phase,
        steps: phase.steps.map((step) => {
          const kind = workflowStepKind(step);
          if (kind === "workflow" && nested.has(step.id)) {
            const merged = {
              ...step.overrides ?? {}
            };
            for (const [childKey, patch2] of Object.entries(nested.get(step.id))) {
              merged[childKey] = { ...merged[childKey] ?? {}, ...patch2 };
            }
            const withNested = { ...step, overrides: merged };
            const ownPatch = own[step.id];
            return ownPatch ? applyAgentPatch(withNested, ownPatch) : withNested;
          }
          const patch = own[step.id];
          if (!patch) return step;
          if (kind === "llm") {
            const safePatch = {};
            for (const key of LLM_FIELD_KEYS) {
              if (key in patch) {
                safePatch[key] = patch[key];
              }
            }
            return applyAgentPatch(step, safePatch);
          }
          if (!isAgentBackedStep(step)) return step;
          if (kind === "distributor" || kind === "consolidator" || kind === "merge") {
            const safePatch = {};
            for (const key of AGENT_FIELD_KEYS) {
              if (key in patch) {
                safePatch[key] = patch[key];
              }
            }
            return applyAgentPatch(step, safePatch);
          }
          return applyAgentPatch(step, patch);
        })
      }))
    };
  }

  // src/agents/config.ts
  var AGENT_PROVIDER_IDS = [
    "claude",
    "opencode",
    "codex",
    "amp",
    "kiro",
    "mimo",
    "kimi",
    "cursor",
    "antigravity"
  ];
  var DEFAULT_AGENT_LABEL = {
    claude: "claude",
    opencode: "opencode",
    codex: "codex",
    amp: "amp",
    kiro: "kiro",
    mimo: "mimo",
    kimi: "kimi",
    cursor: "cursor",
    antigravity: "agy"
  };
  function agentUiLabel(id) {
    if (!id) return "";
    if (AGENT_PROVIDER_IDS.includes(id)) {
      return DEFAULT_AGENT_LABEL[id];
    }
    return id;
  }

  // src/workflow/autonomy.ts
  var AUTONOMY_RANK = {
    autonomous: 0,
    approvals: 1,
    interactive: 2
  };
  function maxAutonomy(a, b) {
    return AUTONOMY_RANK[b] > AUTONOMY_RANK[a] ? b : a;
  }
  function stepAutonomy(step) {
    if (step.kind === "human") return "interactive";
    if ((step.kind === "worker" || step.kind === "processor" || !step.kind) && "canAsk" in step && step.canAsk === true) {
      return "interactive";
    }
    if (step.kind === "approval") return "approvals";
    if (step.kind === "gate" && step.condition?.human === true) return "approvals";
    return "autonomous";
  }
  function workflowAutonomy(spec, resolve, seen = /* @__PURE__ */ new Set()) {
    let level = "autonomous";
    for (const phase of spec.phases) {
      for (const step of phase.steps) {
        level = maxAutonomy(level, stepAutonomy(step));
        if (level === "interactive") return level;
        if (step.kind === "workflow" && resolve && !seen.has(step.workflow)) {
          seen.add(step.workflow);
          const child = resolve(step.workflow);
          if (child) level = maxAutonomy(level, workflowAutonomy(child, resolve, seen));
          if (level === "interactive") return level;
        }
      }
    }
    return level;
  }

  // src/workflow/sub-workflow-view.ts
  function formatSubWorkflowTarget(step) {
    if (step.agent && step.model) return `${agentUiLabel(step.agent)}/${step.model}`;
    if (step.agent) return agentUiLabel(step.agent);
    if (step.model) return step.model;
    if (step.modelClass) return `class:${step.modelClass}`;
    return void 0;
  }
  function stepTarget(step) {
    return {
      agent: "agent" in step ? step.agent : void 0,
      model: "model" in step ? step.model : void 0,
      modelClass: "modelClass" in step ? step.modelClass : void 0,
      effort: "effort" in step ? step.effort : void 0
    };
  }
  function targetFieldsEqual(a, b) {
    const ta = stepTarget(a);
    const tb = stepTarget(b);
    return ta.agent === tb.agent && ta.model === tb.model && ta.modelClass === tb.modelClass && ta.effort === tb.effort;
  }
  function collectSteps(base, effective, resolve, prefix, depth, seen, out) {
    base.phases.forEach((basePhase, pi) => {
      const effPhase = effective.phases[pi];
      basePhase.steps.forEach((baseStep, si) => {
        const step = effPhase?.steps[si] ?? baseStep;
        const kind = workflowStepKind(step);
        const path = `${prefix}${step.id}`;
        const agentBacked = isAgentBackedStep(step);
        out.push({
          path,
          id: step.id,
          kind,
          depth,
          agentBacked,
          agent: agentBacked ? step.agent : void 0,
          model: agentBacked ? step.model : void 0,
          modelClass: agentBacked ? step.modelClass : void 0,
          effort: agentBacked ? step.effort : void 0,
          overridden: !targetFieldsEqual(baseStep, step),
          base: agentBacked ? stepTarget(baseStep) : void 0,
          workflow: step.kind === "workflow" ? step.workflow : void 0
        });
        if (step.kind === "workflow" && resolve && depth < MAX_WORKFLOW_NESTING_DEPTH && !seen.has(step.workflow)) {
          const childBase = resolve(step.workflow);
          if (!childBase) return;
          const childEffective = step.overrides ? applyWorkflowStepOverrides(childBase, step.overrides) : childBase;
          collectSteps(
            childBase,
            childEffective,
            resolve,
            `${path}::`,
            depth + 1,
            /* @__PURE__ */ new Set([...seen, step.workflow]),
            out
          );
        }
      });
    });
  }
  function describeSubWorkflow(step, resolve, seen = /* @__PURE__ */ new Set()) {
    const shell = {
      workflow: step.workflow,
      resolved: false,
      cyclic: seen.has(step.workflow),
      phaseCount: 0,
      stepCount: 0,
      agentStepCount: 0,
      agents: [],
      targets: [],
      autonomy: "autonomous",
      overrideCount: 0,
      input: step.input,
      params: step.params,
      steps: []
    };
    if (!resolve || shell.cyclic) return shell;
    const base = resolve(step.workflow);
    if (!base) return shell;
    const effective = step.overrides ? applyWorkflowStepOverrides(base, step.overrides) : base;
    const steps = [];
    collectSteps(base, effective, resolve, "", 1, /* @__PURE__ */ new Set([...seen, step.workflow]), steps);
    const agents = /* @__PURE__ */ new Set();
    const targets = /* @__PURE__ */ new Set();
    let agentStepCount = 0;
    let overrideCount = 0;
    for (const s of steps) {
      if (s.agentBacked) {
        agentStepCount += 1;
        if (s.agent) agents.add(s.agent);
        const t = formatSubWorkflowTarget(s);
        if (t) targets.add(t);
      }
      if (s.overridden) overrideCount += 1;
    }
    return {
      workflow: step.workflow,
      resolved: true,
      cyclic: false,
      phaseCount: base.phases.length,
      stepCount: base.phases.reduce((n, p) => n + p.steps.length, 0),
      agentStepCount,
      agents: [...agents],
      targets: [...targets],
      autonomy: workflowAutonomy(effective, resolve),
      overrideCount,
      input: step.input,
      params: step.params,
      steps
    };
  }
  function subWorkflowRollup(view) {
    if (!view.resolved) {
      return view.cyclic ? `\u21BB ${view.workflow} (cyclic)` : `\u2192 ${view.workflow} (unresolved)`;
    }
    const bits = [`\u2192 ${view.workflow}`];
    bits.push(`${view.stepCount} step${view.stepCount === 1 ? "" : "s"}`);
    if (view.targets.length > 0) {
      const shown = view.targets.slice(0, 3).join(", ");
      bits.push(view.targets.length > 3 ? `${shown}, +${view.targets.length - 3}` : shown);
    }
    if (view.overrideCount > 0) {
      bits.push(`${view.overrideCount} override${view.overrideCount === 1 ? "" : "s"}`);
    }
    return bits.join(" \xB7 ");
  }

  // src/workflow/live-output.ts
  function isLiveOutputContainer(step) {
    return step.blockKind === "workflow";
  }
  function nestedStepsOf(state, parentStepId) {
    const prefix = `${parentStepId}${SUBWORKFLOW_STEP_SEPARATOR}`;
    const out = [];
    for (const { step } of flattenSteps(state)) {
      if (step.stepId.startsWith(prefix) || step.parentStepId === parentStepId) {
        out.push(step);
      }
    }
    return out;
  }
  function hasLiveBody(step) {
    const body = ((step.result?.output ?? step.text) || "").trim();
    return body.length > 0 || Boolean(step.activity);
  }
  function isActiveLeaf(step) {
    return step.status === "running" && !isLiveOutputContainer(step);
  }
  function resolveLiveOutputStep(state, step, depth = 0) {
    if (!isLiveOutputContainer(step)) return step;
    if (depth >= MAX_WORKFLOW_NESTING_DEPTH) return step;
    const nested = nestedStepsOf(state, step.stepId);
    if (nested.length === 0) return step;
    const runningWithBody = nested.find((s) => isActiveLeaf(s) && hasLiveBody(s));
    if (runningWithBody) return runningWithBody;
    const runningLeaf = nested.find(isActiveLeaf);
    if (runningLeaf) return runningLeaf;
    for (let i = nested.length - 1; i >= 0; i -= 1) {
      const s = nested[i];
      if (!isLiveOutputContainer(s) && hasLiveBody(s)) return s;
    }
    for (let i = nested.length - 1; i >= 0; i -= 1) {
      const s = nested[i];
      if (isLiveOutputContainer(s) && s.status === "running") {
        const deeper = resolveLiveOutputStep(state, s, depth + 1);
        if (deeper !== s) return deeper;
      }
    }
    return step;
  }
  function liveOutputBody(step) {
    const body = ((step.result?.output ?? step.text) || "").trim();
    if (body) return body;
    return (step.activity || "").trim();
  }

  // src/web/telemetry.ts
  var DEFAULT_WINDOW_MS = 6e4;
  function createThroughputMeter(windowMs = DEFAULT_WINDOW_MS) {
    const samples = [];
    return {
      sample(totalTokens2, nowMs) {
        samples.push({ atMs: nowMs, totalTokens: totalTokens2 });
        while (samples.length > 1 && nowMs - samples[0].atMs > windowMs) samples.shift();
      },
      bars(count) {
        if (count <= 0) return [];
        const empty = new Array(count).fill(0);
        if (samples.length < 2) return empty;
        const rates = [];
        for (let i = 1; i < samples.length; i++) {
          const prev = samples[i - 1];
          const cur = samples[i];
          const seconds = (cur.atMs - prev.atMs) / 1e3;
          const delta = cur.totalTokens - prev.totalTokens;
          rates.push(seconds > 0 && delta > 0 ? delta / seconds : 0);
        }
        const recent = rates.slice(-count);
        const peak = Math.max(...recent);
        if (peak <= 0) return empty;
        const scaled = recent.map((r) => r / peak);
        return [...new Array(count - scaled.length).fill(0), ...scaled];
      }
    };
  }
  function projectCost(input) {
    const { spentUsd, completedSteps, totalSteps } = input;
    if (completedSteps <= 0 || totalSteps <= 0) return null;
    return Math.max(spentUsd, spentUsd / completedSteps * totalSteps);
  }
  return __toCommonJS(reducer_exports);
})();
