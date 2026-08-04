/**
 * Plan surface: the Console's idle state (Turn 2 of the web UI redesign).
 *
 * With no run in flight the centre pane is the *plan* — an editable projection
 * of the selected workflow's spec — and the right rail is the step inspector
 * (st-inspector.js). Editing is inline and file-backed: every change mutates
 * an in-memory draft spec (S.planDrafts[name]) that is the pending diff
 * against the workflow file until Save (PUT /api/workflows/:name) or Discard.
 * Runs and dry-run plans execute the draft as-is; the launch sheet warns.
 *
 * Interaction contract (from the design):
 *   click a step row      → select it into the inspector (no navigation)
 *   double-click an id    → rename in place (dependsOn refs follow)
 *   drag the ⣿ handle     → move a step between phases (deps are revalidated)
 *   ⌘-click               → multi-select for bulk runner/model edits
 *   ⌫                     → delete the selection
 *   ⌘S / ⌘⏎               → save to file / open the launch sheet
 *
 * RENDERING: this module's render() is destructive like every other surface
 * (see the contract note in st-boot.js). Anything the user can be *inside* —
 * inspector fields, the source textarea, an inline rename — either commits on
 * "change" (not per-keystroke), lives in S (S.sourceText), or carries a
 * data-focus-key so the shared capture/restore puts the caret back.
 */
(function (ST) {
  "use strict";
  var S = ST.state;
  var h = ST.h;
  var clear = ST.clear;

  // The `when` condition injected to mark a step disabled in the draft (or
  // deselected in the launch sheet): always false, so the engine records the
  // step as skipped rather than failed. Recognized verbatim so Disable can
  // toggle back without touching a user's own conditions.
  var DISABLED_WHEN = { value: "false", equals: "true" };

  function isDisabledWhen(when) {
    return !!when && when.value === "false" && when.equals === "true" &&
      Object.keys(when).length === 2;
  }

  // ---- draft model ----------------------------------------------------------

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  /** Deep-stable stringify (keys sorted) so dirty checks ignore key order. */
  function canonical(v) {
    if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
    if (v && typeof v === "object") {
      return "{" + Object.keys(v).sort().map(function (k) {
        return JSON.stringify(k) + ":" + canonical(v[k]);
      }).join(",") + "}";
    }
    return JSON.stringify(v === undefined ? null : v);
  }

  /**
   * The draft for the selected workflow. Creates one lazily from the saved
   * spec on first mutation — viewing alone must not leave a pending draft,
   * or every visited workflow would show a dirty rail dot.
   */
  function draft() {
    if (!S.selected || !S.spec) return null;
    if (!S.planDrafts[S.selected]) S.planDrafts[S.selected] = clone(S.spec);
    return S.planDrafts[S.selected];
  }

  /** Existing draft for `name` (no create). */
  function existingDraft(name) {
    var wf = name || S.selected;
    return (wf && S.planDrafts[wf]) || null;
  }

  /** The draft only when it actually diverges from the saved spec. */
  function draftIfDirty(name) {
    var wf = name || S.selected;
    var d = existingDraft(wf);
    if (!d) return null;
    if (wf === S.selected && S.spec) {
      return canonical(d) !== canonical(S.spec) ? d : null;
    }
    // Non-selected: drafts are only retained while dirty (see mutate/discard),
    // so presence alone means there are unsaved edits for that workflow.
    return d;
  }

  function isDirty(name) {
    return !!draftIfDirty(name);
  }

  /**
   * Repaint after a draft mutation. Deferred (setTimeout 0, not the RAF
   * scheduleRender in st-core.js) so a blur→change on an inspector field does
   * not rebuild the DOM before the click that caused the blur (Diff / Save /
   * Discard, or another workflow in the rail) lands — otherwise the click
   * target is destroyed mid-gesture and navigation feels stuck.
   */
  var renderTimer = null;
  function scheduleDeferredRender() {
    if (renderTimer != null) return;
    renderTimer = setTimeout(function () {
      renderTimer = null;
      ST.shell.renderSidebar();
      ST.render();
    }, 0);
  }

  /** Apply a mutation to the selected workflow's draft and repaint. */
  function mutate(fn) {
    var d = draft();
    if (!d) return;
    fn(d);
    if (!isDirty()) {
      // Mutation round-tripped to the saved state: drop the draft so the rail
      // dot and footer chip clear rather than claiming "1 unsaved edit".
      discard(S.selected);
    }
    scheduleDeferredRender();
  }

  function discard(name) {
    delete S.planDrafts[name || S.selected];
    S.sourceText = null; S.sourceDiverged = false;
  }

  /**
   * Human-readable summary of what the draft changes vs. the saved spec —
   * the footer chip's "2 unsaved edits · scan-logic.model, phase 01 name".
   */
  function dirtySummary() {
    if (!isDirty()) return [];
    var saved = S.spec, d = existingDraft();
    if (!saved || !d) return [];
    var out = [];
    var savedPhases = saved.phases || [], draftPhases = d.phases || [];
    var savedSteps = {}, draftSteps = {};
    savedPhases.forEach(function (p) {
      (p.steps || []).forEach(function (s) { savedSteps[s.id] = s; });
    });
    draftPhases.forEach(function (p, i) {
      var sp = savedPhases[i];
      if (!sp) { out.push("phase " + pad2(i + 1) + " added"); return; }
      if ((sp.title || "") !== (p.title || "")) out.push("phase " + pad2(i + 1) + " name");
      (p.steps || []).forEach(function (s) { draftSteps[s.id] = { step: s, phaseIdx: i }; });
    });
    if (draftPhases.length < savedPhases.length) {
      for (var i = draftPhases.length; i < savedPhases.length; i++) out.push("phase " + pad2(i + 1) + " removed");
    }
    Object.keys(draftSteps).forEach(function (id) {
      var ss = savedSteps[id];
      if (!ss) { out.push(id + " added"); return; }
      var ds = draftSteps[id].step;
      var keys = {};
      Object.keys(ss).forEach(function (k) { keys[k] = true; });
      Object.keys(ds).forEach(function (k) { keys[k] = true; });
      Object.keys(keys).forEach(function (k) {
        if (canonical(ss[k]) !== canonical(ds[k])) out.push(id + "." + k);
      });
      // A step that moved phases counts as a move, not field edits.
      var savedIdx = -1;
      savedPhases.forEach(function (p, i) {
        if ((p.steps || []).some(function (s) { return s.id === id; })) savedIdx = i;
      });
      if (savedIdx !== -1 && savedIdx !== draftSteps[id].phaseIdx) {
        out.push(id + " → phase " + pad2(draftSteps[id].phaseIdx + 1));
      }
    });
    Object.keys(savedSteps).forEach(function (id) {
      if (!draftSteps[id]) out.push(id + " removed");
    });
    if ((saved.description || "") !== (d.description || "")) out.push("description");
    return out;
  }

  /**
   * Extract the source step id from a `forEach` value (`steps.<id>.items` or
   * `<id>.items`). Keep in sync with parsePlanForEachSource in plan-edit.ts
   * and parseForEachSource in workflow/types.ts.
   */
  function parseForEachSource(source) {
    var explicit = /^steps\.(.+)\.items$/.exec(source);
    if (explicit) return explicit[1];
    var shorthand = /^(.+)\.items$/.exec(source);
    return shorthand ? shorthand[1] : undefined;
  }

  function rewriteForEachRef(forEach, oldId, newId) {
    if (parseForEachSource(forEach) !== oldId) return forEach;
    return forEach.indexOf("steps.") === 0 ? ("steps." + newId + ".items") : (newId + ".items");
  }

  /**
   * Client-side sanity checks for the footer's "plan valid" lamp. The server
   * re-validates with the real schema on save; these catch the structural
   * mistakes the plan editor itself can produce (dupes, dangling deps).
   * Keep in sync with validatePlanStructure in src/web/plan-edit.ts.
   */
  function validate(spec) {
    var errors = [];
    var seen = {}, phaseOf = {};
    (spec.phases || []).forEach(function (p, i) {
      (p.steps || []).forEach(function (s) {
        if (!s.id || !String(s.id).trim()) errors.push("a step has an empty id");
        else if (seen[s.id] !== undefined) errors.push("duplicate step id '" + s.id + "'");
        seen[s.id] = true;
        phaseOf[s.id] = i;
      });
    });
    (spec.phases || []).forEach(function (p, i) {
      (p.steps || []).forEach(function (s) {
        (s.dependsOn || []).forEach(function (dep) {
          if (!seen[dep]) errors.push(s.id + " depends on unknown step '" + dep + "'");
          else if (phaseOf[dep] >= i) errors.push(s.id + " depends on '" + dep + "', which is not in an earlier phase");
        });
        if (s.when && s.when.step) {
          if (!seen[s.when.step]) errors.push(s.id + " when condition references unknown step '" + s.when.step + "'");
          else if (phaseOf[s.when.step] >= i) {
            errors.push(s.id + " when condition references '" + s.when.step + "', which is not in an earlier phase");
          }
        }
        if (s.condition && s.condition.step) {
          if (!seen[s.condition.step]) errors.push(s.id + " condition references unknown step '" + s.condition.step + "'");
        }
        if (s.forEach) {
          var sourceStepId = parseForEachSource(s.forEach);
          if (!sourceStepId) {
            errors.push(s.id + " has invalid forEach '" + s.forEach + "' (expected steps.<id>.items)");
          } else if (!seen[sourceStepId]) {
            errors.push(s.id + " forEach references unknown step '" + sourceStepId + "'");
          } else if ((phaseOf[sourceStepId] === undefined ? -1 : phaseOf[sourceStepId]) >= i) {
            errors.push(s.id + " forEach references '" + sourceStepId + "', which is not in an earlier phase");
          }
        }
        (s.from || []).forEach(function (ref) {
          if (!seen[ref]) errors.push(s.id + " from references unknown step '" + ref + "'");
        });
      });
    });
    return { ok: errors.length === 0, errors: errors };
  }

  // ---- selection ------------------------------------------------------------

  function flatSteps(spec) {
    var out = [];
    (spec.phases || []).forEach(function (p, pi) {
      (p.steps || []).forEach(function (s, si) { out.push({ phase: p, phaseIdx: pi, step: s, stepIdx: si }); });
    });
    return out;
  }

  function findStep(spec, id) {
    var all = flatSteps(spec);
    for (var i = 0; i < all.length; i++) if (all[i].step.id === id) return all[i];
    return null;
  }

  function selectStep(id, additive) {
    if (additive) {
      var i = S.planSelection.indexOf(id);
      if (i === -1) S.planSelection.push(id); else S.planSelection.splice(i, 1);
    } else {
      S.planSelection = id ? [id] : [];
    }
    // Plan → source sync: the source view scrolls to and highlights the step.
    if (id && S.planTab === "source") S.sourceReveal = id;
    ST.render();
  }

  function clearSelection() {
    if (!S.planSelection.length) return;
    S.planSelection = [];
    ST.render();
  }

  /** Move selection one step up/down the flattened plan (arrow keys). */
  function moveSelection(dir) {
    var all = flatSteps(draftIfDirty() || S.spec);
    if (!all.length) return;
    var cur = S.planSelection[0];
    var idx = -1;
    for (var i = 0; i < all.length; i++) if (all[i].step.id === cur) { idx = i; break; }
    var next = idx === -1
      ? (dir > 0 ? 0 : all.length - 1)
      : Math.max(0, Math.min(all.length - 1, idx + dir));
    selectStep(all[next].step.id, false);
  }

  // ---- structural edits -----------------------------------------------------

  /** Rewrite every step-id reference in the draft when a step is renamed.
   * Keep in sync with rewriteStepRefs in src/web/plan-edit.ts. */
  function rewriteStepRefs(d, oldId, newId) {
    flatSteps(d).forEach(function (f) {
      if (f.step.id === oldId) f.step.id = newId;
      if (Array.isArray(f.step.dependsOn)) {
        f.step.dependsOn = f.step.dependsOn.map(function (dep) { return dep === oldId ? newId : dep; });
      }
      if (Array.isArray(f.step.from)) {
        f.step.from = f.step.from.map(function (ref) { return ref === oldId ? newId : ref; });
      }
      if (f.step.forEach) f.step.forEach = rewriteForEachRef(f.step.forEach, oldId, newId);
      // Gate/approval conditions and when-clauses reference steps by id.
      var c = f.step.condition;
      if (c && c.step === oldId) c.step = newId;
      if (f.step.when && f.step.when.step === oldId) f.step.when.step = newId;
      if (f.step.step === oldId && (f.step.kind === "approval" || f.step.kind === "merge")) f.step.step = newId;
    });
  }

  function renameStep(oldId, newId) {
    newId = (newId || "").trim();
    if (!newId || newId === oldId) return false;
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(newId)) {
      ST.run.setBanner("step ids start with a letter or digit and use only letters, digits, - and _", "info");
      return false;
    }
    var clash = findStep(draftIfDirty() || S.spec, newId);
    if (clash) { ST.run.setBanner("a step named '" + newId + "' already exists", "err"); return false; }
    mutate(function (d) { rewriteStepRefs(d, oldId, newId); });
    S.planSelection = [newId];
    return true;
  }

  function deleteSelection() {
    if (!S.planSelection.length || ST.isReadOnly()) return;
    var doomed = {};
    S.planSelection.forEach(function (id) { doomed[id] = true; });
    mutate(function (d) {
      d.phases.forEach(function (p) {
        p.steps = (p.steps || []).filter(function (s) { return !doomed[s.id]; });
        p.steps.forEach(function (s) {
          if (Array.isArray(s.dependsOn)) {
            s.dependsOn = s.dependsOn.filter(function (dep) { return !doomed[dep]; });
            if (!s.dependsOn.length) delete s.dependsOn;
          }
          if (Array.isArray(s.from)) {
            s.from = s.from.filter(function (ref) { return !doomed[ref]; });
            if (!s.from.length) delete s.from;
          }
          if (s.forEach) {
            var feSrc = parseForEachSource(s.forEach);
            if (feSrc && doomed[feSrc]) delete s.forEach;
          }
          if (s.when && s.when.step && doomed[s.when.step]) delete s.when;
          if (s.condition && s.condition.step && doomed[s.condition.step]) delete s.condition;
        });
      });
      // Drop phases the deletion emptied out, matching what the file would
      // look like had the user edited it by hand.
      d.phases = d.phases.filter(function (p) { return (p.steps || []).length > 0; });
    });
    // mutate() → scheduleDeferredRender() handles the repaint.
    S.planSelection = [];
  }

  /** Move a step into another phase (drop target index within it). */
  function moveStep(stepId, targetPhaseIdx, targetStepIdx) {
    mutate(function (d) {
      var from = findStep(d, stepId);
      if (!from) return;
      from.phase.steps.splice(from.stepIdx, 1);
      var tp = d.phases[targetPhaseIdx];
      var at = Math.max(0, Math.min(targetStepIdx == null ? tp.steps.length : targetStepIdx, tp.steps.length));
      tp.steps.splice(at, 0, from.step);
      // Dependencies must point backwards: moving a step invalidates deps on
      // steps that are no longer in an earlier phase.
      var phaseOf = {};
      d.phases.forEach(function (p, i) { (p.steps || []).forEach(function (s) { phaseOf[s.id] = i; }); });
      if (Array.isArray(from.step.dependsOn)) {
        var kept = from.step.dependsOn.filter(function (dep) { return phaseOf[dep] !== undefined && phaseOf[dep] < targetPhaseIdx; });
        if (kept.length !== from.step.dependsOn.length) {
          ST.run.setBanner(stepId + ": dropped " + (from.step.dependsOn.length - kept.length) + " dependenc" +
            (from.step.dependsOn.length - kept.length === 1 ? "y" : "ies") + " that are no longer in an earlier phase", "info");
        }
        from.step.dependsOn = kept.length ? kept : undefined;
        if (!from.step.dependsOn) delete from.step.dependsOn;
      }
      // Other steps depending on the moved step may now point forwards.
      d.phases.forEach(function (p, i) {
        (p.steps || []).forEach(function (s) {
          if (!Array.isArray(s.dependsOn)) return;
          var k = s.dependsOn.filter(function (dep) { return dep !== stepId || phaseOf[stepId] < i; });
          if (k.length !== s.dependsOn.length) {
            s.dependsOn = k;
            ST.run.setBanner(s.id + ": dropped its dependency on " + stepId + " (now in a later phase)", "info");
          }
          if (!s.dependsOn.length) delete s.dependsOn;
        });
      });
    });
  }

  function addStep(phaseIdx) {
    var d = draft();
    if (!d) return;
    var n = 1;
    var id;
    do { id = "step-" + n; n++; } while (findStep(d, id));
    mutate(function (dd) {
      dd.phases[phaseIdx].steps.push({ id: id, kind: "worker", prompt: "" });
    });
    S.planSelection = [id];
  }

  function addPhase() {
    // mutate() → scheduleDeferredRender() handles the repaint.
    mutate(function (d) {
      d.phases.push({ id: "phase-" + (d.phases.length + 1), title: "New phase", steps: [] });
    });
  }

  function duplicateStep(stepId) {
    mutate(function (d) {
      var from = findStep(d, stepId);
      if (!from) return;
      var copy = clone(from.step);
      var base = stepId + "-copy", id = base, n = 2;
      while (findStep(d, id)) { id = base + "-" + n; n++; }
      copy.id = id;
      // A copy of a gated/conditional step must not inherit loop or approval
      // wiring that references other steps by position; keep the spec minimal.
      from.phase.steps.splice(from.stepIdx + 1, 0, copy);
      S.planSelection = [id];
    });
  }

  function toggleDisabled(stepId) {
    mutate(function (d) {
      var f = findStep(d, stepId);
      if (!f) return;
      if (isDisabledWhen(f.step.when)) delete f.step.when;
      else f.step.when = clone(DISABLED_WHEN);
    });
  }

  // ---- save -----------------------------------------------------------------

  var saving = false;
  function save(confirmRisk) {
    if (saving || ST.isReadOnly()) return;
    var name = S.selected;
    var d = draftIfDirty();
    if (!name || !d) return;
    // The source tab may hold unparseable text the draft never absorbed —
    // saving the draft underneath it would silently discard that typing.
    if (S.planTab === "source" && S.sourceDiverged) {
      ST.run.setBanner("the source view has invalid JSON — fix it or Discard before saving", "err");
      return;
    }
    var check = validate(d);
    if (!check.ok) {
      ST.run.setBanner("plan is invalid: " + check.errors[0] + (check.errors.length > 1 ? " (+" + (check.errors.length - 1) + " more)" : ""), "err");
      return;
    }
    saving = true;
    var payload = { spec: d, scope: S.source === "project" ? "project" : "user" };
    if (confirmRisk) payload.confirmRisk = true;
    ST.apiAuth("PUT", "/api/workflows/" + encodeURIComponent(name), payload).then(function (r) {
      saving = false;
      if (r.status === 409 && r.body && r.body.requiresConfirmation) {
        var findings = (r.body.review && r.body.review.findings) || [];
        var critical = findings.filter(function (f) { return f.severity === "critical" || f.severity === "high"; });
        var preview = critical.slice(0, 5).map(function (f) { return "• " + f.message; }).join("\n");
        if (window.confirm(
          "This workflow has security findings that require confirmation before saving:\n\n" +
          (preview || (r.body.error || "critical/high findings")) +
          (critical.length > 5 ? "\n• …and " + (critical.length - 5) + " more" : "") +
          "\n\nSave anyway?"
        )) save(true);
        return;
      }
      if (r.status === 200 && r.body.ok) {
        var savedName = r.body.name || name;
        discard(savedName);
        var warns = r.body.warnings;
        ST.modals.reloadCatalog().then(function () {
          ST.selectWorkflow(savedName, function () {
            ST.run.setBanner("Saved " + savedName +
              (warns && warns.length ? " — ⚠ " + warns.length + " template warning" + (warns.length === 1 ? "" : "s") + ": " + warns[0] : ""), "ok");
          });
        });
        return;
      }
      ST.run.setBanner((r.body && r.body.error) || "save failed", "err");
    }).catch(function () {
      saving = false;
      ST.run.setBanner("save failed — could not reach the server", "err");
    });
  }

  // ---- run-spec building (launch sheet) -------------------------------------

  /**
   * The spec a run should execute: the draft when dirty, else the saved spec.
   * `opts.skip` (set of step ids) and `opts.fromPhase` (index) mark steps
   * skipped via the engine's own `when` semantics; `opts.budgetUsd` stamps a
   * run-only maxCostUsd. The workflow file is never touched.
   */
  function buildRunSpec(opts) {
    opts = opts || {};
    var base = draftIfDirty() || S.spec;
    if (!base) return null;
    var spec = clone(base);
    var skipAll = {};
    if (opts.skip) opts.skip.forEach(function (id) { skipAll[id] = true; });
    (spec.phases || []).forEach(function (p, i) {
      (p.steps || []).forEach(function (s) {
        if (skipAll[s.id] || (typeof opts.fromPhase === "number" && i < opts.fromPhase)) {
          s.when = clone(DISABLED_WHEN);
        }
      });
    });
    if (opts.budgetUsd && isFinite(opts.budgetUsd) && opts.budgetUsd > 0) {
      spec.maxCostUsd = opts.budgetUsd;
    }
    return spec;
  }

  // ---- recent runs ----------------------------------------------------------

  var recentRequest = 0;
  function loadRecentRuns(name) {
    var request = ++recentRequest;
    S.recentRuns = []; S.recentRunsFor = name;
    ST.apiAuth("GET", "/api/history").then(function (r) {
      if (request !== recentRequest || S.selected !== name) return;
      if (r.status !== 200) return;
      var mine = (r.body.runs || r.body.history || []).filter(function (run) {
        return run.workflow === name;
      }).slice(0, 3);
      S.recentRuns = mine;
      ST.shell.renderLiveRuns();
      ST.render();
    }).catch(function () {});
  }

  // ---- keyboard --------------------------------------------------------------

  /**
   * Plan-tab keys. Returns true when the key was consumed. Called from
   * st-boot's global keydown, after overlay/page routing and before the run
   * drawer's Escape handling.
   */
  function handleKey(e) {
    if (S.runId || !S.spec || S.page) return false;
    var typing = e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.tagName === "SELECT");
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      if (isDirty()) save(false);
      return true;
    }
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      ST.modals.openLaunchSheet();
      return true;
    }
    if (typing) return false;
    if ((e.key === "Backspace" || e.key === "Delete") && S.planSelection.length && S.planTab === "plan") {
      e.preventDefault();
      deleteSelection();
      return true;
    }
    if (e.key === "Escape" && S.planSelection.length) {
      e.preventDefault();
      clearSelection();
      return true;
    }
    if ((e.key === "ArrowUp" || e.key === "ArrowDown") && S.planTab === "plan") {
      e.preventDefault();
      moveSelection(e.key === "ArrowDown" ? 1 : -1);
      return true;
    }
    return false;
  }

  // ---- rendering: center pane ------------------------------------------------

  function pad2(n) { return String(n).padStart(2, "0"); }

  var KIND_PILL = {
    worker: ["worker", "k-worker"], processor: ["process", "k-worker"],
    distributor: ["fan-out", "k-distributor"], consolidator: ["consol.", "k-consolidator"],
    gate: ["gate", "k-gate"], approval: ["approval", "k-gate"], human: ["human", "k-gate"],
    merge: ["merge", "k-consolidator"], command: ["command", "k-command"],
    llm: ["llm", "k-llm"], workflow: ["sub-flow", "k-distributor"], issues: ["issues", "k-command"]
  };

  function kindPill(kind) {
    var meta = KIND_PILL[kind] || [kind, "k-command"];
    return h("span", { class: "pk " + meta[1] }, h("i"), meta[0]);
  }

  function runnerLabel(s) {
    if (s.agent) return ST.agentUiLabel(s.agent) + (s.model ? " · " + s.model : "");
    if (s.modelClass) return "auto · class:" + s.modelClass + (s.model ? " · " + s.model : "");
    if (s.kind === "llm") return (s.api ? s.api : "api") + (s.model ? " · " + s.model : "");
    if (s.kind === "command" || s.kind === "gate" || s.kind === "approval" || s.kind === "human" || s.kind === "merge") return "local · no model";
    if (s.kind === "workflow") return "→ " + s.workflow;
    if (s.model) return "auto · " + s.model;
    return "—";
  }

  function contextLabel(s) {
    var bits = [];
    if (s.dependsOn && s.dependsOn.length) bits.push("depends: " + s.dependsOn.join(", "));
    if (s.cwd) bits.push("cwd: " + s.cwd);
    if (bits.length) return bits.join(" · ");
    return "—";
  }

  function retryLabel(s, spec) {
    var r = s.retry || (spec && spec.retry);
    if (r && typeof r.retries === "number") return String(r.retries);
    return "—";
  }

  /** The tab strip + header actions, rendered above the active tab. */
  function renderTabs(spec) {
    var ro = ST.isReadOnly();
    var steps = flatSteps(spec).length;
    var phases = (spec.phases || []).length;
    function tab(id, label, suffix) {
      return h("button", {
        class: "plan-tab" + (S.planTab === id ? " active" : ""),
        type: "button",
        onClick: function () {
          S.planTab = id;
          S.dryRunPlan = null;
          ST.render();
          if (id === "inputs") {
            var input = document.getElementById("input");
            if (input) input.focus();
          }
        }
      }, label, suffix || null);
    }
    var inputsCount = spec.inputs ? Object.keys(spec.inputs).length : 0;
    var tabs = h("div", { class: "plan-tabs", role: "tablist" },
      tab("plan", "Plan"),
      tab("source", "Source"),
      tab("inputs", "Inputs", inputsCount ? h("span", { class: "tab-n", text: String(inputsCount) }) : null)
    );
    var meta = h("span", { class: "plan-meta", text: phases + " phase" + (phases === 1 ? "" : "s") + " · " + steps + " step" + (steps === 1 ? "" : "s") });
    var last = S.recentRuns && S.recentRuns[0];
    var est = null;
    if (last && last.totals && last.totals.costUsd > 0) {
      est = h("span", { class: "plan-meta",
        text: "last run " + (typeof last.durationMs === "number" ? ST.fmtElapsed(last.durationMs) + " · " : "") + "$" + last.totals.costUsd.toFixed(3) });
    }
    var actions = h("span", { class: "plan-actions" });
    if (!ro) {
      var dry = h("button", { class: "btn small", type: "button", text: "Dry run", onClick: function () { ST.run.startPlan(); } });
      var runBtn = h("button", { class: "btn small primary", type: "button" }, "Run",
        h("span", { class: "kbd", text: "⌘⏎" }));
      runBtn.addEventListener("click", function () { ST.modals.openLaunchSheet(); });
      applyLaunchGate([dry, runBtn]);
      actions.appendChild(dry);
      actions.appendChild(runBtn);
    }
    return h("div", { class: "plan-tabrow" }, tabs, h("span", { class: "plan-tabrow-right" }, meta, est, actions));
  }

  /**
   * Disable launch buttons while the selected workflow is blocked, naming the
   * reason in the tooltip. The blocked strip above the plan says the same
   * thing in prose; this keeps the buttons from contradicting it.
   */
  function applyLaunchGate(buttons) {
    var why = ST.shell.launchBlocked();
    if (!why) return;
    buttons.forEach(function (b) {
      b.disabled = true;
      b.title = why;
    });
  }

  /** One step row in the plan grid. */
  function stepRow(spec, phase, step, phaseIdx) {
    var ro = ST.isReadOnly();
    var selectedIdx = S.planSelection.indexOf(step.id);
    var selected = selectedIdx !== -1;
    var disabled = isDisabledWhen(step.when);
    var row = h("div", {
      class: "plan-row" + (selected ? " selected" : "") + (disabled ? " disabled" : ""),
      "data-step": step.id,
      draggable: "false"
    });
    var grip = h("span", {
      class: "grip", title: ro ? "" : "Drag to another phase",
      text: "⣿", draggable: ro ? "false" : "true"
    });
    if (!ro) {
      grip.addEventListener("dragstart", function (e) {
        e.dataTransfer.setData("text/plain", JSON.stringify({ step: step.id, phase: phaseIdx }));
        e.dataTransfer.effectAllowed = "move";
        row.classList.add("dragging");
      });
      grip.addEventListener("dragend", function () { row.classList.remove("dragging"); });
    }
    row.appendChild(grip);

    var box = h("span", {
      class: "selbox" + (selected ? " on" : ""),
      title: "⌘-click to multi-select",
      onClick: function (e) {
        e.stopPropagation();
        selectStep(step.id, true);
      }
    });
    row.appendChild(box);

    var idCell = h("span", { class: "sid", text: step.id, title: "Double-click to rename" });
    if (!ro) {
      idCell.addEventListener("dblclick", function (e) {
        e.stopPropagation();
        inlineRename(row, idCell, step);
      });
    }
    row.appendChild(idCell);
    row.appendChild(h("span", { class: "kindcell" }, kindPill(step.kind)));
    row.appendChild(h("span", { class: "runner", text: runnerLabel(step) }));
    row.appendChild(h("span", { class: "context", text: contextLabel(step), title: contextLabel(step) }));
    row.appendChild(h("span", { class: "num", text: retryLabel(step, spec) }));
    row.appendChild(h("span", { class: "chev", text: "›" }));

    row.addEventListener("click", function (e) {
      if (ST.isInteractiveTarget(e.target)) return;
      selectStep(step.id, e.metaKey || e.ctrlKey);
    });
    return row;
  }

  /** Replace the id cell with an inline rename input. */
  function inlineRename(row, idCell, step) {
    var input = h("input", { class: "txt rename", value: step.id, type: "text" });
    var done = false;
    function commit() {
      if (done) return;
      done = true;
      if (!renameStep(step.id, input.value)) ST.render();
    }
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); commit(); }
      else if (e.key === "Escape") { done = true; ST.render(); }
      e.stopPropagation();
    });
    input.addEventListener("blur", commit);
    row.replaceChild(input, idCell);
    input.focus();
    input.select();
  }

  /** A phase band: header (drag target) + step rows + add-step row. */
  function phaseBand(spec, phase, phaseIdx) {
    var ro = ST.isReadOnly();
    var band = h("div", { class: "plan-phase", "data-phase": String(phaseIdx) });
    var steps = phase.steps || [];
    // Engine defaults missing onFalse/onReject to "continue", so only an
    // explicit fail/stop policy earns the "stops the run on fail" chip.
    var hasHardGate = steps.some(function (s) {
      return (s.kind === "gate" || s.kind === "approval") &&
        (s.onFalse === "fail" || s.onFalse === "stop" || s.onReject === "fail" || s.onReject === "stop");
    });
    var head = h("div", { class: "plan-phase-head" },
      h("span", { class: "idx", text: pad2(phaseIdx + 1) }),
      h("span", { class: "title", text: phase.title || phase.id, title: ro ? "" : "Double-click to rename" }),
      steps.length > 1
        ? h("span", { class: "chip info", text: "parallel · " + steps.length })
        : h("span", { class: "dim-sm", text: steps.length + " step" }),
      hasHardGate ? h("span", { class: "chip warn", text: "stops the run on fail" }) : null
    );
    if (!ro) {
      head.querySelector(".title").addEventListener("dblclick", function (e) {
        e.stopPropagation();
        var titleEl = e.currentTarget;
        var input = h("input", { class: "txt rename", value: phase.title || "", type: "text" });
        var done = false;
        function commit() {
          if (done) return;
          done = true;
          mutate(function (d) { d.phases[phaseIdx].title = input.value.trim() || d.phases[phaseIdx].title; });
        }
        input.addEventListener("keydown", function (ev) {
          if (ev.key === "Enter") { ev.preventDefault(); commit(); }
          else if (ev.key === "Escape") { done = true; ST.render(); }
          ev.stopPropagation();
        });
        input.addEventListener("blur", commit);
        head.replaceChild(input, titleEl);
        input.focus();
        input.select();
      });
      var addBtn = h("button", {
        class: "btn tiny", type: "button", text: "+ Step",
        onClick: function (e) { e.stopPropagation(); addStep(phaseIdx); }
      });
      var delBtn = h("button", {
        class: "phase-x", type: "button", title: "Delete this phase", text: "✕",
        onClick: function (e) {
          e.stopPropagation();
          if (!window.confirm("Delete phase " + pad2(phaseIdx + 1) + " (" + steps.length + " step" + (steps.length === 1 ? "" : "s") + ")?")) return;
          mutate(function (d) { d.phases.splice(phaseIdx, 1); });
          S.planSelection = [];
          ST.render();
        }
      });
      head.appendChild(h("span", { class: "phase-acts" }, addBtn, delBtn));
      // Drag target: dropping onto the header appends to this phase.
      ["dragover", "drop"].forEach(function (type) {
        head.addEventListener(type, function (e) {
          e.preventDefault();
          if (type === "drop") {
            try {
              var data = JSON.parse(e.dataTransfer.getData("text/plain"));
              if (data && data.step) moveStep(data.step, phaseIdx, null);
            } catch (err) {}
          }
        });
      });
    }
    band.appendChild(head);
    steps.forEach(function (s, si) {
      var row = stepRow(spec, phase, s, phaseIdx);
      if (!ro) {
        ["dragover", "drop"].forEach(function (type) {
          row.addEventListener(type, function (e) {
            e.preventDefault();
            if (type === "drop") {
              e.stopPropagation();
              try {
                var data = JSON.parse(e.dataTransfer.getData("text/plain"));
                if (data && data.step) moveStep(data.step, phaseIdx, si);
              } catch (err) {}
            }
          });
        });
      }
      band.appendChild(row);
    });
    if (!ro) {
      var addRow = h("div", { class: "plan-addrow" },
        h("span", { class: "plus", text: "+" }),
        h("span", { class: "lnk", text: "add step to this phase", onClick: function () { addStep(phaseIdx); } })
      );
      band.appendChild(addRow);
    }
    return band;
  }

  /** The plan tab: phase bands + the pending-diff footer. */
  function renderPlanTab(container, spec) {
    var ro = ST.isReadOnly();
    var d = draftIfDirty() || spec;
    var head = h("div", { class: "plan-gridhead" },
      h("span"), h("span"), h("span", { text: "Step" }), h("span", { text: "Kind" }),
      h("span", { text: "Runner · model" }), h("span", {
        text: "Context",
        title: "Dependencies and working directory"
      }),
      h("span", { class: "num", text: "Retries" }), h("span")
    );
    var viewport = h("div", { class: "plan-viewport" });
    var grid = h("div", { class: "plan-grid" });
    grid.appendChild(head);
    var scroll = h("div", { class: "plan-scroll" });
    (d.phases || []).forEach(function (p, i) { scroll.appendChild(phaseBand(d, p, i)); });
    if (!ro) {
      var addPhaseRow = h("div", { class: "plan-addrow phase" },
        h("span", { class: "plus", text: "+" }),
        h("span", { class: "lnk", text: "add phase", onClick: addPhase })
      );
      scroll.appendChild(addPhaseRow);
    }
    grid.appendChild(scroll);
    viewport.appendChild(grid);
    container.appendChild(viewport);
    container.appendChild(renderFooter(d));
  }

  /**
   * Footer / rail actions that a reader often hits while still focused in an
   * inspector field. `mousedown` + preventDefault keeps the field from
   * blurring before the click, which would otherwise let a blur→change
   * rebuild steal the gesture. The click handler then blurs deliberately so
   * any pending field edit commits into the draft (sync) before the action.
   */
  function armAction(btn, action) {
    btn.addEventListener("mousedown", function (e) { e.preventDefault(); });
    btn.addEventListener("click", function () {
      var active = document.activeElement;
      if (active && active !== btn && active.blur) active.blur();
      action();
    });
    return btn;
  }

  /** The pending-diff footer: validity lamp, unsaved chip, Discard/Diff/Save. */
  function renderFooter(d) {
    var ro = ST.isReadOnly();
    var foot = h("div", { class: "plan-foot" });
    var check = validate(d);
    if (check.ok) {
      foot.appendChild(h("span", { class: "plan-lamp ok" }, h("i"), "plan valid"));
    } else {
      foot.appendChild(h("span", { class: "plan-lamp warn", title: check.errors.join("\n") }, h("i"),
        check.errors.length + " problem" + (check.errors.length === 1 ? "" : "s") + ": " + check.errors[0]));
    }
    var edits = dirtySummary();
    if (edits.length) {
      foot.appendChild(h("span", { class: "plan-lamp dirty" }, h("i"),
        edits.length + " unsaved edit" + (edits.length === 1 ? "" : "s") + " · " +
        edits.slice(0, 3).join(", ") + (edits.length > 3 ? " · +" + (edits.length - 3) + " more" : "")));
    }
    var actions = h("span", { class: "plan-foot-actions" });
    if (!ro && edits.length) {
      actions.appendChild(armAction(
        h("button", { class: "btn ghost", type: "button", text: "Discard" }),
        function () {
          discard();
          ST.run.setBanner("", "");
          ST.shell.renderSidebar();
          ST.render();
        }
      ));
      actions.appendChild(armAction(
        h("button", { class: "btn small", type: "button", text: "Diff" }),
        showDiff
      ));
      var saveBtn = h("button", { class: "btn small primary", type: "button", disabled: !check.ok }, "Save to file",
        h("span", { class: "kbd", text: "⌘S" }));
      armAction(saveBtn, function () { save(false); });
      actions.appendChild(saveBtn);
    }
    foot.appendChild(actions);
    return foot;
  }

  // ---- diff modal ------------------------------------------------------------

  /** Small LCS line diff → unified patch text (specs are a few hundred lines). */
  function unifiedDiff(oldText, newText, oldName, newName) {
    var a = oldText.split("\n"), b = newText.split("\n");
    var n = a.length, m = b.length;
    var dp = [];
    var i, j;
    for (i = 0; i <= n; i++) { dp[i] = new Array(m + 1); dp[i][m] = 0; }
    for (j = 0; j <= m; j++) dp[n][j] = 0;
    for (i = n - 1; i >= 0; i--) {
      for (j = m - 1; j >= 0; j--) {
        dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    var ops = [];
    i = 0; j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) { ops.push([" ", a[i]]); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push(["-", a[i]]); i++; }
      else { ops.push(["+", b[j]]); j++; }
    }
    while (i < n) { ops.push(["-", a[i]]); i++; }
    while (j < m) { ops.push(["+", b[j]]); j++; }
    // Emit hunks with 3 lines of context.
    var CTX = 3, out = [], k = 0;
    while (k < ops.length) {
      var start = -1;
      for (var q = k; q < ops.length; q++) {
        if (ops[q][0] !== " ") { start = Math.max(k, q - CTX); break; }
      }
      if (start === -1) break;
      var end = ops.length;
      for (var r = start; r < ops.length; r++) {
        if (ops[r][0] === " ") {
          var run = 0;
          while (r + run < ops.length && ops[r + run][0] === " ") run++;
          if (run > CTX * 2) { end = r + CTX; break; }
          r += run - 1;
        }
        end = r + 1;
      }
      var oldCount = 0, newCount = 0, oldStart = 1, newStart = 1;
      for (var t = 0; t < start; t++) { if (ops[t][0] !== "+") oldStart++; if (ops[t][0] !== "-") newStart++; }
      var body = [];
      for (var u = start; u < end; u++) {
        body.push(ops[u][0] + ops[u][1]);
        if (ops[u][0] !== "+") oldCount++;
        if (ops[u][0] !== "-") newCount++;
      }
      out.push("@@ -" + oldStart + "," + oldCount + " +" + newStart + "," + newCount + " @@");
      out = out.concat(body);
      k = end;
    }
    if (!out.length) return "";
    return "--- " + oldName + "\n+++ " + newName + "\n" + out.join("\n") + "\n";
  }

  function showDiff() {
    if (!isDirty()) return;
    var oldName = "workflows/" + S.selected + " (saved)";
    var newName = S.selected + " (draft)";
    var savedText = JSON.stringify(S.spec, null, 2);
    var draftText = JSON.stringify(draftIfDirty() || draft(), null, 2);
    var patch = unifiedDiff(savedText, draftText, oldName, newName);
    // parseUnifiedDiff accepts plain ---/+++ patches now, but keep a git
    // header so older cached bundles still render something useful.
    if (patch && patch.indexOf("diff --git ") !== 0) {
      patch = "diff --git " + JSON.stringify(oldName) + " " + JSON.stringify(newName) + "\n" + patch;
    }
    var body;
    try {
      body = SteamtrainDiff.renderPatch(patch, { document: document });
      if (!body || !body.childNodes || body.childNodes.length === 0) {
        // Match renderBody's empty-file affordance in the diff view bundle.
        body = h("div", { class: "diff-empty-file", text: "No textual changes" });
      }
    } catch (e) {
      body = h("pre", { class: "plan-diff-raw", text: patch || String(e) });
    }
    var wrap = h("div", { class: "plan-diff" }, body);
    ST.modals.openModal(ST.modals.modalShell(
      "Unsaved changes · " + S.selected,
      editsLine(),
      wrap,
      h("div", { class: "mfoot" },
        h("button", { class: "btn", text: "Close", onClick: ST.modals.closeModal }),
        h("div", { class: "spacer" }),
        h("button", { class: "btn primary", text: "Save to file", onClick: function () { ST.modals.closeModal(); save(false); } })
      ),
      true
    ));
  }

  function editsLine() {
    var edits = dirtySummary();
    return edits.length + " unsaved edit" + (edits.length === 1 ? "" : "s") + " — nothing writes to disk until Save";
  }

  // ---- source tab ------------------------------------------------------------

  function draftJson() {
    return JSON.stringify(draftIfDirty() || S.spec, null, 2);
  }

  /** Where the workflow persists, for the source header's file line. */
  function sourceFileLabel() {
    if (S.source === "project") return "steamtrain.json · workflows." + S.selected;
    if (S.source === "user") return "~/.steamtrain/workflows.json · " + S.selected;
    return "bundled with steamtrain · edits save a user copy";
  }

  // ---- source lint ------------------------------------------------------------

  // Row height of the editor, gutter and highlight layer alike. Keep in sync
  // with .src-editor / .src-gutter / .src-hl line-height in plan.css — the
  // three layers are only aligned because they share this number.
  var SRC_LINE_H = 19;

  /**
   * Line of `text` (0-based) that a JSON.parse failure points at. Engines
   * disagree on the message: V8 and JSC report a character offset ("at
   * position 412"), newer V8 adds "(line 7 column 3)", and some report
   * neither — in which case the caller has no line to mark and says so in the
   * strip instead of guessing one.
   */
  function parseErrorLine(text, message) {
    var atLine = /line (\d+)/.exec(message || "");
    if (atLine) return Math.max(0, parseInt(atLine[1], 10) - 1);
    var atPos = /position (\d+)/.exec(message || "");
    if (!atPos) return -1;
    var pos = Math.min(text.length, parseInt(atPos[1], 10));
    return text.slice(0, pos).split("\n").length - 1;
  }

  /** First line (0-based) declaring `"id": "<stepId>"`, or -1. */
  function stepIdLine(text, stepId) {
    var idx = text.indexOf("\"id\": \"" + stepId + "\"");
    if (idx === -1) idx = text.indexOf("\"id\":\"" + stepId + "\"");
    if (idx === -1) return -1;
    return text.slice(0, idx).split("\n").length - 1;
  }

  /**
   * Everything the source view knows to be wrong with the text on screen, in
   * the order a reader should deal with it: a parse failure first (nothing
   * else can be trusted while the JSON is broken), then structural errors,
   * then runner warnings from the server's readiness probe.
   *
   * Structural errors name their step in prose ("scan depends on unknown step
   * 'x'"), so the step id is recovered from the leading word to anchor the
   * mark; an unanchored diagnostic still lists, it just marks no line.
   */
  function sourceDiagnostics(text) {
    var out = [];
    var parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      out.push({
        severity: "err",
        line: parseErrorLine(text, e.message),
        message: "invalid JSON — " + e.message,
        detail: "the plan and the launch sheet still show the last valid draft"
      });
      return out;
    }
    validate(parsed).errors.forEach(function (msg) {
      var lead = /^([A-Za-z0-9_-]+) /.exec(msg);
      out.push({
        severity: "err",
        line: lead ? stepIdLine(text, lead[1]) : -1,
        message: msg,
        detail: "this workflow cannot be saved until it is fixed"
      });
    });
    (S.sourceLint && S.sourceLint.name === S.selected ? S.sourceLint.issues : []).forEach(function (issue) {
      var line = stepIdLine(text, issue.stepId);
      // A warning for a step the text no longer declares is stale: the reader
      // renamed or removed it and the next lint round will drop it anyway.
      if (line === -1) return;
      out.push({
        severity: "warn",
        line: line,
        message: issue.stepId + " · " + issue.issue,
        detail: "this step will be skipped",
        action: "open Settings → Runners"
      });
    });
    return out;
  }

  /**
   * Ask the server which steps its dispatch gate would refuse, for the spec as
   * it stands. Debounced by the caller; skipped for viewers, who may not POST.
   */
  function loadSourceLint() {
    if (ST.isReadOnly() || !S.selected) return;
    var name = S.selected;
    var spec = draftIfDirty() || S.spec;
    if (!spec) return;
    ST.apiAuth("POST", "/api/workflows/" + encodeURIComponent(name) + "/lint", { spec: spec })
      .then(function (r) {
        if (r.status !== 200 || S.selected !== name) return;
        var next = JSON.stringify(r.body.issues || []);
        if (S.sourceLint && S.sourceLint.name === name && JSON.stringify(S.sourceLint.issues) === next) return;
        S.sourceLint = { name: name, issues: r.body.issues || [] };
        // Only the source tab draws these, and only when it is on screen.
        if (S.planTab === "source") ST.render();
      })
      .catch(function () {});
  }

  function scheduleSourceLint() {
    if (S.sourceLintTimer) clearTimeout(S.sourceLintTimer);
    // Long enough that a burst of typing costs one request, short enough that
    // a warning lands while the reader is still looking at the step.
    S.sourceLintTimer = setTimeout(function () {
      S.sourceLintTimer = null;
      loadSourceLint();
    }, 600);
  }

  function renderSourceTab(container) {
    var ro = ST.isReadOnly();
    if (S.sourceText === null || (!S.sourceDiverged && S.sourceText !== draftJson())) {
      // Regenerate from the draft whenever the plan moved underneath us and
      // the user hasn't typed something unparseable.
      if (!S.sourceDiverged) S.sourceText = draftJson();
    }
    var savedText = S.spec ? JSON.stringify(S.spec, null, 2) : "";
    var dirty = isDirty();

    var diags = sourceDiagnostics(S.sourceText);

    var head = h("div", { class: "src-head" },
      h("span", { class: "src-file", text: sourceFileLabel() }),
      dirty ? h("span", { class: "chip warn", text: "modified" }) : null,
      h("span", { class: "src-head-right" },
        h("span", { class: "src-status", id: "srcStatus" }, lintTally(diags)),
        ro ? null : h("button", { class: "btn ghost", type: "button", text: "format", onClick: function () {
          try {
            S.sourceText = JSON.stringify(JSON.parse(S.sourceText), null, 2);
            S.sourceDiverged = false;
            var parsed = JSON.parse(S.sourceText);
            parsed.name = S.selected;
            if (S.spec && canonical(parsed) === canonical(S.spec)) delete S.planDrafts[S.selected];
            else S.planDrafts[S.selected] = parsed;
            ST.shell.renderSidebar();
            ST.render();
          } catch (e) { /* status line already says what's wrong */ }
        } })
      )
    );
    container.appendChild(head);

    var gutter = h("div", { class: "src-gutter" });
    // The highlight layer sits UNDER a transparent textarea, so the caret,
    // selection and native editing all stay the textarea's job and the colours
    // are purely decorative. The two only line up while their font, padding
    // and white-space match exactly — see .src-hl / .src-editor in plan.css.
    var hl = h("pre", { class: "src-hl", "aria-hidden": "true" });
    var ta = h("textarea", {
      class: "src-editor", spellcheck: "false", "data-focus-key": "plan-source",
      "aria-label": "Workflow JSON source"
    });
    ta.value = S.sourceText;
    if (ro) ta.setAttribute("readonly", "true");
    var strip = h("div", { class: "src-lint" });
    function syncScroll() {
      gutter.scrollTop = ta.scrollTop;
      hl.scrollTop = ta.scrollTop;
      hl.scrollLeft = ta.scrollLeft;
    }
    function goToLine(line) {
      ta.scrollTop = Math.max(0, (line - 4) * SRC_LINE_H);
      syncScroll();
      ta.focus();
    }
    function repaintLint() {
      var next = sourceDiagnostics(S.sourceText);
      paintHighlight(hl, S.sourceText);
      paintGutter(gutter, S.sourceText, next);
      var status = document.getElementById("srcStatus");
      if (status) { clear(status); status.className = "src-status"; status.appendChild(lintTally(next)); }
      fillLintStrip(strip, next, goToLine);
      syncScroll();
    }
    ta.addEventListener("scroll", syncScroll);
    ta.addEventListener("input", function () {
      S.sourceText = ta.value;
      try {
        var parsed = JSON.parse(S.sourceText);
        S.sourceDiverged = false;
        // Absorb valid JSON into the draft immediately — the plan tab, the
        // footer chip, and the launch sheet all read the draft.
        parsed.name = S.selected;
        if (S.spec && canonical(parsed) === canonical(S.spec)) {
          delete S.planDrafts[S.selected];
        } else {
          S.planDrafts[S.selected] = parsed;
        }
        refreshFooterOnly();
        // Runner readiness is judged against the draft, so a retargeted step
        // gets re-linted — but only once the typing settles.
        scheduleSourceLint();
      } catch (e) {
        S.sourceDiverged = true;
      }
      repaintLint();
    });
    // Source → plan sync: the nearest preceding "id": line is the step under
    // the cursor; selecting it keeps the inspector in step (pun intended).
    ta.addEventListener("keyup", syncCursorToSelection);
    ta.addEventListener("click", syncCursorToSelection);

    var editWrap = h("div", { class: "src-editwrap" }, gutter, h("div", { class: "src-code" }, hl, ta));
    container.appendChild(editWrap);
    paintHighlight(hl, S.sourceText);
    paintGutter(gutter, S.sourceText, diags);
    fillLintStrip(strip, diags, goToLine);
    container.appendChild(strip);
    renderSourceFoot(container, savedText);
    // Readiness for the spec on screen, refreshed each time the tab is opened
    // (a runner can have been fixed in Settings since the last look).
    loadSourceLint();

    // Plan → source sync: a step picked in the plan scrolls into view here.
    if (S.sourceReveal) {
      var target = S.sourceReveal;
      S.sourceReveal = null;
      revealInSource(ta, syncScroll, target);
    }
  }

  function syncCursorToSelection(e) {
    var ta = e.currentTarget;
    var pos = ta.selectionStart || 0;
    var upto = ta.value.slice(0, pos);
    var m = /"id":\s*"([^"]+)"/g, last = null, match;
    while ((match = m.exec(upto))) last = match[1];
    if (last && S.planSelection[0] !== last) {
      S.planSelection = [last];
      // Repaint the inspector without rebuilding the editor under the caret.
      var rail = document.getElementById("rail-right");
      if (rail && ST.inspector) ST.inspector.render(rail);
    }
  }

  function revealInSource(ta, syncScroll, stepId) {
    var needle = "\"id\": \"" + stepId + "\"";
    var idx = ta.value.indexOf(needle);
    if (idx === -1) return;
    var line = ta.value.slice(0, idx).split("\n").length - 1;
    ta.scrollTop = Math.max(0, (line - 4) * SRC_LINE_H);
    syncScroll();
    var end = idx + needle.length;
    try { ta.setSelectionRange(idx, end); } catch (e) {}
  }

  /**
   * JSON tokens, in one pass. Deliberately tolerant: half-typed text is the
   * normal state of this editor, so anything the scanner does not recognise
   * is emitted as plain text rather than aborting the paint.
   */
  var TOKEN_RE = /("(?:[^"\\]|\\.)*"\s*:)|("(?:[^"\\]|\\.)*")|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|(\btrue\b|\bfalse\b|\bnull\b)|([{}[\],:])/g;
  var TOKEN_CLASS = ["tok-key", "tok-str", "tok-num", "tok-lit", "tok-punct"];

  function paintHighlight(pre, text) {
    clear(pre);
    TOKEN_RE.lastIndex = 0;
    var at = 0, m;
    while ((m = TOKEN_RE.exec(text))) {
      if (m.index > at) pre.appendChild(document.createTextNode(text.slice(at, m.index)));
      var cls = "";
      for (var g = 1; g <= TOKEN_CLASS.length; g++) if (m[g] !== undefined) { cls = TOKEN_CLASS[g - 1]; break; }
      pre.appendChild(h("span", { class: cls, text: m[0] }));
      at = m.index + m[0].length;
    }
    // The trailing newline keeps the last line scrollable to the same offset
    // the textarea reaches, so the two layers cannot drift at the bottom.
    pre.appendChild(document.createTextNode(text.slice(at) + "\n"));
  }

  /** Line numbers, with a marker on every line a diagnostic points at. */
  function paintGutter(gutter, text, diags) {
    var marks = {};
    (diags || []).forEach(function (d) {
      if (d.line < 0) return;
      // An error outranks a warning on a shared line: it is what stops a save.
      if (marks[d.line] !== "err") marks[d.line] = d.severity;
    });
    clear(gutter);
    var lines = text.split("\n").length;
    for (var i = 0; i < lines; i++) {
      var row = h("div", { class: "src-ln" + (marks[i] ? " " + marks[i] : "") });
      if (marks[i]) row.appendChild(h("span", { class: "src-mark", text: marks[i] === "err" ? "✕" : "⚠" }));
      row.appendChild(h("span", { text: String(i + 1) }));
      gutter.appendChild(row);
    }
  }

  /** The header's count of what the gutter is marking. */
  function lintTally(diags) {
    var errs = 0, warns = 0;
    diags.forEach(function (d) { if (d.severity === "err") errs += 1; else warns += 1; });
    if (!errs && !warns) return h("span", { class: "lint-ok", text: "no problems" });
    var box = h("span", { class: "lint-tally" });
    if (errs) box.appendChild(h("span", { class: "lint-n err", text: errs + (errs === 1 ? " error" : " errors") }));
    if (warns) box.appendChild(h("span", { class: "lint-n warn", text: warns + (warns === 1 ? " warning" : " warnings") }));
    return box;
  }

  /**
   * The strip under the editor: what is wrong, on which line, and the one
   * thing that fixes it. Clicking a row scrolls the editor to the line, which
   * is the whole point of naming the line in the first place.
   */
  function fillLintStrip(strip, diags, goToLine) {
    clear(strip);
    strip.style.display = diags.length ? "" : "none";
    // More than a handful is a broken file, not a list to read — the count in
    // the header stays honest either way.
    diags.slice(0, 4).forEach(function (d) {
      var row = h("div", { class: "lint-row " + d.severity });
      row.appendChild(h("span", { class: "lint-icon", text: d.severity === "err" ? "✕" : "⚠" }));
      var body = h("div", { class: "lint-body" });
      body.appendChild(h("div", { class: "lint-msg",
        text: (d.line >= 0 ? "line " + (d.line + 1) + " · " : "") + d.message }));
      var sub = h("div", { class: "lint-sub" }, h("span", { text: d.detail }));
      if (d.action) {
        sub.appendChild(h("span", { text: " · " }));
        sub.appendChild(h("button", { class: "lint-action", type: "button", text: d.action,
          onClick: function (e) { e.stopPropagation(); ST.settings.open("runners"); } }));
      }
      body.appendChild(sub);
      row.appendChild(body);
      if (d.line >= 0) row.addEventListener("click", function () { goToLine(d.line); });
      strip.appendChild(row);
    });
  }

  function renderSourceFoot(container, savedText) {
    var foot = h("div", { class: "src-foot", id: "srcFoot" });
    container.appendChild(foot);
    fillSourceFoot(foot, savedText);
  }

  function fillSourceFoot(foot, savedText) {
    clear(foot);
    var ro = ST.isReadOnly();
    var drift = "";
    try {
      var savedLines = (savedText || JSON.stringify(S.spec, null, 2)).split("\n");
      var draftLines = draftJson().split("\n");
      drift = driftCounts(savedLines, draftLines);
    } catch (e) {}
    foot.appendChild(h("span", { class: "src-drift", text: S.sourceDiverged ? "not applied — fix the JSON above" : (drift || "matches the saved file") }));
    var actions = h("span", { class: "plan-foot-actions" });
    if (!ro && isDirty()) {
      actions.appendChild(armAction(
        h("button", { class: "btn ghost", type: "button", text: "Discard" }),
        function () {
          discard();
          ST.shell.renderSidebar();
          ST.render();
        }
      ));
      actions.appendChild(armAction(
        h("button", { class: "btn small primary", type: "button", text: "Save to file" }),
        function () { save(false); }
      ));
    }
    foot.appendChild(actions);
  }

  /** Cheap "+N −M" line counts between two pretty-printed specs. */
  function driftCounts(aLines, bLines) {
    var setA = {}, setB = {};
    aLines.forEach(function (l) { var t = l.trim(); if (t) setA[t] = (setA[t] || 0) + 1; });
    bLines.forEach(function (l) { var t = l.trim(); if (t) setB[t] = (setB[t] || 0) + 1; });
    var plus = 0, minus = 0;
    Object.keys(setB).forEach(function (k) {
      var d = setB[k] - (setA[k] || 0);
      if (d > 0) plus += d;
    });
    Object.keys(setA).forEach(function (k) {
      var d = setA[k] - (setB[k] || 0);
      if (d > 0) minus += d;
    });
    if (!plus && !minus) return "";
    return "+" + plus + " −" + minus + " vs. saved";
  }

  /** Repaint just the plan footer's dirty/valid lamps during source typing. */
  function refreshFooterOnly() {
    var foot = document.getElementById("srcFoot");
    if (foot && S.planTab === "source") fillSourceFoot(foot, null);
    ST.shell.renderSidebar(); // the rail's unsaved-edits dot
  }

  // ---- inputs tab -------------------------------------------------------------

  function renderInputsTab(container, spec) {
    var ro = ST.isReadOnly();
    var box = h("div", { class: "inputs-tab" });
    box.appendChild(h("div", { class: "inputs-hint",
      text: "The run input and workflow variables for the next launch. ⌘⏎ opens the launch sheet; ↑ in the input recalls previous runs' inputs." }));
    var inputWrap = h("div", { class: "inputs-field" },
      h("label", { class: "inputs-label", text: "Run input", "for": "input" })
    );
    box.appendChild(inputWrap);
    // Adopt the real #input node (it owns prompt history, ⌘⏎ wiring and the
    // startRun value). Reparenting preserves its content and listeners;
    // #composerPark in the runbar is its parking spot on the other tabs.
    var realInput = document.getElementById("input");
    if (realInput) inputWrap.appendChild(realInput);
    var params = document.getElementById("paramsPanel");
    if (params && spec && spec.inputs && Object.keys(spec.inputs).length) {
      params.style.display = "";
      params.hidden = false;
      box.appendChild(params);
    }
    if (!ro) {
      var launch = h("button", { class: "btn small primary", type: "button", text: "Run ⌘⏎", onClick: function () { ST.modals.openLaunchSheet(); } });
      var dryRun = h("button", { class: "btn small", type: "button", text: "Dry run", onClick: function () { ST.run.startPlan(); } });
      applyLaunchGate([launch, dryRun]);
      box.appendChild(h("div", { class: "inputs-actions" }, launch, dryRun));
    }
    container.appendChild(box);
  }

  /**
   * Park #input / #paramsPanel back in #composerPark when the inputs tab
   * isn't showing, so no other surface ever finds them missing.
   */
  function parkComposerNodes(force) {
    var compose = document.querySelector("#composerPark .run-compose");
    if (!compose) return;
    var realInput = document.getElementById("input");
    var params = document.getElementById("paramsPanel");
    if (!force && (S.planTab === "inputs" || S.runId || !S.spec)) return;
    if (realInput && realInput.parentElement !== compose) {
      compose.insertBefore(realInput, compose.querySelector("#paramsPanel"));
    }
    if (params && params.parentElement !== compose) compose.appendChild(params);
  }

  /**
   * Move the shared composer controls to their stable parking spot before the
   * destructive canvas render clears #bands. Without this handoff, an input
   * textarea that was adopted by the Inputs tab is removed from the document
   * before the next render can find and reparent it.
   */
  function prepareRender() {
    parkComposerNodes(true);
  }

  // ---- dry-run result (renders into the plan tab) ----------------------------

  function renderDryResult(container) {
    var bar = h("div", { class: "plan-drybar" },
      h("span", { text: "Dry run — nothing executed." }),
      h("button", { class: "btn ghost", type: "button", text: "← back to plan", onClick: function () {
        S.dryRunPlan = null;
        ST.render();
      } })
    );
    container.appendChild(bar);
    var body = h("div", { class: "plan-dryresult" });
    container.appendChild(body);
    ST.run.renderPlanResult(S.dryRunPlan.plan, S.dryRunPlan.name, body);
  }

  // ---- top-level render --------------------------------------------------------

  /**
   * The idle center pane. Called by st-boot's renderStage when no run is
   * attached. Owns everything inside #bands for the selected workflow.
   */
  function render(stage) {
    parkComposerNodes();
    var spec = draftIfDirty() || S.spec;
    var wrap = h("div", { class: "plan-root" });
    wrap.appendChild(renderTabs(spec));
    var content = h("div", { class: "plan-content" });
    wrap.appendChild(content);
    if (S.dryRunPlan && S.planTab === "plan") renderDryResult(content);
    else if (S.planTab === "source") renderSourceTab(content);
    else if (S.planTab === "inputs") renderInputsTab(content, spec);
    else renderPlanTab(content, spec);
    stage.appendChild(wrap);
  }

  ST.plan = {
    DISABLED_WHEN: DISABLED_WHEN,
    addPhase: addPhase,
    addStep: addStep,
    buildRunSpec: buildRunSpec,
    clearSelection: clearSelection,
    dirtySummary: dirtySummary,
    discard: discard,
    draft: draft,
    draftIfDirty: draftIfDirty,
    duplicateStep: duplicateStep,
    findStep: findStep,
    flatSteps: flatSteps,
    handleKey: handleKey,
    isDisabledWhen: isDisabledWhen,
    isDirty: isDirty,
    loadRecentRuns: loadRecentRuns,
    moveSelection: moveSelection,
    moveStep: moveStep,
    mutate: mutate,
    prepareRender: prepareRender,
    renameStep: renameStep,
    render: render,
    rewriteStepRefs: rewriteStepRefs,
    save: save,
    selectStep: selectStep,
    sourceDiagnostics: sourceDiagnostics,
    toggleDisabled: toggleDisabled,
    validate: validate,
  };
})(window.Steamtrain);
