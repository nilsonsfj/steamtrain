/**
 * Inspector surface: the Console's right rail before the run (Turn 2).
 *
 * Two modes, one selection model:
 *
 *   idle (no run attached)   — the rail is the *step inspector*: a form over
 *                              the selected plan step that edits the plan
 *                              draft (st-plan.js). ⌘-multi-select turns it
 *                              into a bulk runner/model/effort editor.
 *   run attached + S.detail  — the rail is the *step record*: the same click
 *                              that opens the inspector pre-run now shows a
 *                              read-only record of a running/finished step
 *                              (Live / Prompt / Config / Events). Edits are
 *                              explicitly deferred: "Edit in plan" takes the
 *                              change to the draft for the next run.
 *
 * render() returns false when neither mode applies (a run with nothing
 * drilled-in), so st-boot falls back to the instrument rail.
 */
(function (ST) {
  "use strict";
  var S = ST.state;
  var h = ST.h;
  var clear = ST.clear;

  function spec() { return ST.plan.draftIfDirty() || S.spec; }

  // ---- shared bits ------------------------------------------------------------

  function label(text) {
    return h("span", { class: "insp-label", text: text });
  }

  /** Amber "changed from X" note when the draft diverges from the saved spec. */
  function changedNote(stepId, field, current) {
    if (!S.spec || !ST.plan.isDirty()) return null;
    var saved = ST.plan.findStep(S.spec, stepId);
    if (!saved) return null;
    var before = saved.step[field];
    var after = current;
    if (JSON.stringify(before || "") === JSON.stringify(after || "")) return null;
    var fmt = function (v) { return v == null || v === "" ? "(unset)" : String(v); };
    return h("div", { class: "insp-changed", text: "changed from " + fmt(before) + " · applies on save" });
  }

  function promptHighlight(text) {
    var pre = h("div", { class: "insp-prompt" });
    var re = /(\{\{[^}]+\}\})/g, last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) pre.appendChild(document.createTextNode(text.slice(last, m.index)));
      pre.appendChild(h("span", { class: "tpl", text: m[1] }));
      last = m.index + m[1].length;
    }
    if (last < text.length) pre.appendChild(document.createTextNode(text.slice(last)));
    return pre;
  }

  // ---- header (shared by both modes) -------------------------------------------

  function headRow(stepId, statusNode) {
    return h("div", { class: "insp-head" },
      h("span", { class: "insp-kicker", text: "Step" }),
      h("span", { class: "insp-sid", text: stepId }),
      statusNode || null,
      h("span", { class: "insp-headnav" },
        h("button", { class: "insp-nav", type: "button", title: "previous step", text: "↑", onClick: function () { stepSibling(-1); } }),
        h("button", { class: "insp-nav", type: "button", title: "next step", text: "↓", onClick: function () { stepSibling(1); } }),
        h("button", { class: "insp-nav", type: "button", title: "deselect (Esc)", text: "✕", onClick: function () {
          if (S.runId) ST.run.closeDetail(); else ST.plan.clearSelection();
        } })
      )
    );
  }

  function stepSibling(dir) {
    if (S.runId) {
      var phases = (S.runState && S.runState.phases) || [];
      var flat = [];
      phases.forEach(function (p) { (p.steps || []).forEach(function (s) { flat.push({ p: p, s: s }); }); });
      if (!flat.length || !S.detail) return;
      var idx = -1;
      for (var i = 0; i < flat.length; i++) {
        if (flat[i].s.stepId === S.detail.stepId) { idx = i; break; }
      }
      var next = flat[Math.max(0, Math.min(flat.length - 1, (idx === -1 ? 0 : idx + dir)))];
      if (next) ST.run.openDetail(next.p, next.s, null);
      return;
    }
    ST.plan.moveSelection(dir);
  }

  // ---- idle: the step form -------------------------------------------------------

  var AGENT_KINDS = { worker: true, processor: true, distributor: true, consolidator: true };

  function renderForm(rail) {
    var ro = ST.isReadOnly();
    var d = spec();
    var sel = S.planSelection;

    if (sel.length > 1) { renderBulk(rail, d, sel, ro); return true; }

    if (!sel.length) {
      rail.appendChild(h("div", { class: "insp-empty" },
        h("div", { class: "insp-kicker", text: "Step inspector" }),
        h("p", { class: "insp-hint", text: "Click a step in the plan to inspect and edit it. ⌘-click selects several for a bulk runner/model change; double-click an id to rename it." }),
        h("p", { class: "insp-hint dim", text: "Nothing writes to disk until Save — the plan footer shows the pending diff." })
      ));
      return true;
    }

    var found = ST.plan.findStep(d, sel[0]);
    if (!found) { S.planSelection = []; return true; }
    var step = found.step;

    rail.appendChild(headRow(step.id));

    var body = h("div", { class: "insp-body" });

    // Name ------------------------------------------------------------------
    var nameField = h("div", { class: "insp-field" }, label("Name"));
    if (ro) {
      nameField.appendChild(h("div", { class: "insp-ro", text: step.id }));
    } else {
      var nameInput = h("input", {
        class: "txt", type: "text", value: step.id, "data-focus-key": "insp-name"
      });
      nameInput.addEventListener("change", function () { ST.plan.renameStep(step.id, nameInput.value); });
      nameField.appendChild(nameInput);
    }
    body.appendChild(nameField);

    // Kind ------------------------------------------------------------------
    var kindField = h("div", { class: "insp-field" }, label("Kind"));
    var seg = h("div", { class: "insp-seg" });
    [["worker", "Worker"], ["consolidator", "Consolidator"], ["gate", "Gate"]].forEach(function (pair) {
      var btn = h("button", {
        class: "insp-seg-btn" + (step.kind === pair[0] ? " on" : ""),
        type: "button", text: pair[1], disabled: ro
      });
      btn.addEventListener("click", function () {
        if (step.kind === pair[0]) return;
        ST.plan.mutate(function (dd) {
          var f = ST.plan.findStep(dd, step.id);
          if (!f) return;
          switchKind(f.step, pair[0]);
        });
      });
      seg.appendChild(btn);
    });
    if (!AGENT_KINDS[step.kind] && step.kind !== "gate") {
      seg.appendChild(h("span", { class: "insp-seg-note", text: "· " + step.kind }));
    }
    kindField.appendChild(seg);
    body.appendChild(kindField);

    // Runner / model / effort -------------------------------------------------
    if (AGENT_KINDS[step.kind] || step.kind === "llm") {
      body.appendChild(runnerFields(step, ro));
    } else if (step.kind === "command") {
      var cmdField = h("div", { class: "insp-field" }, label("Command"));
      var cmdInput = h("textarea", { class: "txt insp-cmd", rows: "2", "data-focus-key": "insp-cmd" });
      cmdInput.value = step.cmd || "";
      cmdInput.addEventListener("change", function () {
        ST.plan.mutate(function (dd) {
          var f = ST.plan.findStep(dd, step.id);
          if (f) f.step.cmd = cmdInput.value;
        });
      });
      if (ro) cmdInput.setAttribute("readonly", "true");
      cmdField.appendChild(cmdInput);
      body.appendChild(cmdField);
    } else if (step.kind === "gate") {
      body.appendChild(gateFields(step, ro));
    } else if (step.kind === "workflow") {
      body.appendChild(h("div", { class: "insp-field" }, label("Sub-workflow"),
        h("div", { class: "insp-ro", text: "→ " + step.workflow })));
    }

    // Prompt ------------------------------------------------------------------
    if (step.prompt != null && step.kind !== "gate") {
      var pHead = h("div", { class: "insp-field-head" }, label("Prompt"),
        h("span", { class: "insp-dim", text: (step.prompt || "").length + " chars" }));
      var promptField = h("div", { class: "insp-field grow" }, pHead);
      if (ro) {
        promptField.appendChild(promptHighlight(step.prompt || ""));
      } else {
        var ta = h("textarea", {
          class: "insp-promptedit", "data-focus-key": "insp-prompt", spellcheck: "false"
        });
        ta.value = step.prompt || "";
        ta.addEventListener("change", function () {
          ST.plan.mutate(function (dd) {
            var f = ST.plan.findStep(dd, step.id);
            if (f) f.step.prompt = ta.value;
          });
        });
        promptField.appendChild(ta);
      }
      body.appendChild(promptField);
    }

    body.appendChild(depsBlock(d, found, ro));
    body.appendChild(executionBlock(step, ro));

    rail.appendChild(body);

    // Footer actions ------------------------------------------------------------
    if (!ro) {
      var foot = h("div", { class: "insp-foot" },
        h("button", { class: "btn small", type: "button", text: "Duplicate", onClick: function () { ST.plan.duplicateStep(step.id); } }),
        h("button", { class: "btn small", type: "button",
          text: ST.plan.isDisabledWhen(step.when) ? "Enable" : "Disable",
          title: "A disabled step is recorded as skipped by the run",
          onClick: function () { ST.plan.toggleDisabled(step.id); } }),
        h("button", { class: "btn small insp-runonly", type: "button", text: "Run this step only",
          onClick: function () { ST.modals.openLaunchSheet({ only: step.id }); } })
      );
      rail.appendChild(foot);
    }
    return true;
  }

  /** Re-shape a step when its kind changes; drop fields the new kind rejects. */
  function switchKind(step, kind) {
    var keep = { id: step.id, dependsOn: step.dependsOn, when: step.when };
    if (kind === "gate") {
      step = Object.assign(keep, {
        kind: "gate",
        condition: { step: (keep.dependsOn && keep.dependsOn[0]) || undefined, ok: true },
        onFalse: "fail"
      });
      if (!step.condition.step) delete step.condition.step;
    } else {
      step = Object.assign(keep, { kind: kind, prompt: "" });
      if (kind === "consolidator") step.join = "all";
    }
    // Object.assign mutated `keep`, not `step`'s identity in the draft — the
    // caller passed the draft step, so copy back field-by-field.
    Object.keys(arguments[0]).forEach(function (k) { delete arguments[0][k]; });
    Object.assign(arguments[0], step);
  }

  function runnerFields(step, ro) {
    var wrap = h("div", { class: "insp-field" });
    var row = h("div", { class: "insp-row2" });
    var agentField = h("div", { class: "insp-sub" }, label("Runner"));
    var modelField = h("div", { class: "insp-sub" }, label("Model"));
    if (ro) {
      agentField.appendChild(h("div", { class: "insp-ro", text: step.agent ? ST.agentUiLabel(step.agent) : "auto" }));
      modelField.appendChild(h("div", { class: "insp-ro", text: step.model || step.modelClass || "—" }));
    } else {
      var agentSel = ST.modals.selectEl(
        [{ value: "", label: "auto (pick at run time)" }].concat(ST.modals.agentOptions()),
        step.agent || "",
        function () {
          ST.plan.mutate(function (dd) {
            var f = ST.plan.findStep(dd, step.id);
            if (!f) return;
            if (agentSel.value) f.step.agent = agentSel.value; else delete f.step.agent;
            // An explicit agent can't coexist with class-based resolution.
            if (agentSel.value) delete f.step.modelClass;
            var models = ST.modelsFor(agentSel.value);
            if (f.step.model && models.length && !models.some(function (m) { return m.id === f.step.model; })) {
              delete f.step.model;
            }
          });
        });
      agentSel.setAttribute("data-focus-key", "insp-agent");
      var modelSel = ST.modals.selectEl(
        [{ value: "", label: step.agent ? "agent default" : "auto" }].concat(ST.modals.modelOptionsWith(step.agent || "", step.model || "")),
        step.model || "",
        function () {
          ST.plan.mutate(function (dd) {
            var f = ST.plan.findStep(dd, step.id);
            if (!f) return;
            if (modelSel.value) f.step.model = modelSel.value; else delete f.step.model;
          });
        });
      modelSel.setAttribute("data-focus-key", "insp-model");
      agentField.appendChild(agentSel);
      modelField.appendChild(modelSel);
    }
    row.appendChild(agentField);
    row.appendChild(modelField);
    wrap.appendChild(row);

    var efforts = step.agent ? ST.effortsFor(step.agent, step.model || "") : [];
    if (efforts.length && !ro) {
      var effField = h("div", { class: "insp-sub" }, label("Effort"));
      var effSel = ST.modals.selectEl(ST.modals.effortOptions(step.agent, step.model || "", step.effort || ""), step.effort || "",
        function () {
          ST.plan.mutate(function (dd) {
            var f = ST.plan.findStep(dd, step.id);
            if (!f) return;
            if (effSel.value) f.step.effort = effSel.value; else delete f.step.effort;
          });
        });
      effSel.setAttribute("data-focus-key", "insp-effort");
      effField.appendChild(effSel);
      wrap.appendChild(effField);
    } else if (step.effort) {
      wrap.appendChild(h("div", { class: "insp-dim", text: "effort · " + step.effort }));
    }

    if (step.modelClass) {
      wrap.appendChild(h("div", { class: "insp-dim", text: "resolves via model class · " + step.modelClass }));
    }
    var note = changedNote(step.id, "agent", step.agent) || changedNote(step.id, "model", step.model);
    if (note) wrap.appendChild(note);
    return wrap;
  }

  function gateFields(step, ro) {
    var wrap = h("div", { class: "insp-field" });
    var c = step.condition || {};
    var summary = c.human ? "waits for a human decision"
      : c.step ? c.step + (c.path ? "." + c.path : "") +
        (c.ok !== undefined ? " · ok=" + c.ok : "") +
        (c.contains ? " · contains “" + c.contains + "”" : "") +
        (c.equals !== undefined ? " · equals “" + c.equals + "”" : "") +
        (c.matches ? " · /" + c.matches + "/" : "")
      : c.value ? "“" + c.value + "”" : "always";
    wrap.appendChild(h("div", null, label("Condition"), h("div", { class: "insp-ro", text: summary })));
    if (ro) return wrap;
    var onFalseSel = ST.modals.selectEl([
      { value: "continue", label: "continue" },
      { value: "fail", label: "fail — stops the run" },
      { value: "stop", label: "stop — halt, keep what ran" }
    ], step.onFalse || "continue", function () {
      ST.plan.mutate(function (dd) {
        var f = ST.plan.findStep(dd, step.id);
        if (!f) return;
        if (onFalseSel.value === "continue") delete f.step.onFalse; else f.step.onFalse = onFalseSel.value;
      });
    });
    onFalseSel.setAttribute("data-focus-key", "insp-onfalse");
    wrap.appendChild(h("div", null, label("When false"), onFalseSel));
    return wrap;
  }

  function depsBlock(d, found, ro) {
    var step = found.step;
    var wrap = h("div", { class: "insp-field" });
    var deps = step.dependsOn || [];
    wrap.appendChild(h("div", { class: "insp-field-head" }, label("Depends on"),
      ro ? null : (function () {
        // Eligible: steps in strictly earlier phases not already depended on.
        var eligible = [];
        (d.phases || []).forEach(function (p, i) {
          if (i >= found.phaseIdx) return;
          (p.steps || []).forEach(function (s) {
            if (s.id !== step.id && deps.indexOf(s.id) === -1) eligible.push(s.id);
          });
        });
        if (!eligible.length) return null;
        var add = ST.modals.selectEl([{ value: "", label: "+ add" }].concat(eligible.map(function (id) {
          return { value: id, label: id };
        })), "", function () {
          if (!add.value) return;
          ST.plan.mutate(function (dd) {
            var f = ST.plan.findStep(dd, step.id);
            if (!f) return;
            f.step.dependsOn = (f.step.dependsOn || []).concat([add.value]);
          });
        });
        add.setAttribute("data-focus-key", "insp-adddep");
        return add;
      })()
    ));
    if (!deps.length) {
      wrap.appendChild(h("div", { class: "insp-dim", text: "nothing — starts with the run" }));
    } else {
      var chips = h("div", { class: "insp-chips" });
      deps.forEach(function (dep) {
        var chip = h("span", { class: "insp-chip", text: dep });
        if (!ro) {
          chip.appendChild(h("button", { class: "insp-chip-x", type: "button", text: "✕",
            title: "remove dependency", onClick: function () {
              ST.plan.mutate(function (dd) {
                var f = ST.plan.findStep(dd, step.id);
                if (!f) return;
                f.step.dependsOn = (f.step.dependsOn || []).filter(function (x) { return x !== dep; });
                if (!f.step.dependsOn.length) delete f.step.dependsOn;
              });
            } }));
        }
        chips.appendChild(chip);
      });
      wrap.appendChild(chips);
    }
    // Feeds: the steps that consume this one.
    var feeds = [];
    ST.plan.flatSteps(d).forEach(function (f) {
      if ((f.step.dependsOn || []).indexOf(step.id) !== -1) feeds.push(f.step.id);
    });
    if (feeds.length) {
      wrap.appendChild(h("div", { class: "insp-field-head", style: "margin-top:9px" }, label("Feeds")));
      var feedChips = h("div", { class: "insp-chips" });
      feeds.forEach(function (id) {
        feedChips.appendChild(h("button", { class: "insp-chip lnk", type: "button", text: id,
          onClick: function () { ST.plan.selectStep(id, false); } }));
      });
      wrap.appendChild(feedChips);
    }
    return wrap;
  }

  function execRow(labelText, value, cls) {
    return h("div", { class: "insp-exrow" },
      h("span", { class: "k", text: labelText }),
      h("span", { class: "v" + (cls ? " " + cls : ""), text: value }));
  }

  function executionBlock(step, ro) {
    var wrap = h("div", { class: "insp-field insp-exec" }, label("Execution"));
    wrap.appendChild(execRow("workspace", step.cwd || "isolated worktree (default)"));
    var perms = step.permissions || (S.spec && S.spec.permissions);
    wrap.appendChild(execRow("write access", perms ? (typeof perms === "string" ? perms : (perms.profile || "custom")) : "default (full)", perms === "read-only" ? "warn" : ""));
    var retries = step.retry || (S.spec && S.spec.retry);
    wrap.appendChild(execRow("retries", retries && typeof retries.retries === "number"
      ? String(retries.retries) + (retries.backoffSec ? " · backoff " + retries.backoffSec + "s" : "")
      : "none"));
    var timeout = step.stepTimeoutSec || (S.spec && S.spec.stepTimeoutSec);
    wrap.appendChild(execRow("timeout", timeout ? timeout + "s" : "project default"));
    if (!ro) {
      wrap.appendChild(execRow("cache", "engine default · on for agent steps"));
    }
    if (step.when && !ST.plan.isDisabledWhen(step.when)) {
      wrap.appendChild(execRow("when", "runs only when its condition passes", "warn"));
    }
    if (ST.plan.isDisabledWhen(step.when)) {
      wrap.appendChild(execRow("disabled", "this step is skipped by the run", "warn"));
    }
    return wrap;
  }

  // ---- idle: bulk editor (⌘ multi-select) ---------------------------------------

  function renderBulk(rail, d, sel, ro) {
    var steps = sel.map(function (id) { return ST.plan.findStep(d, id); }).filter(Boolean)
      .map(function (f) { return f.step; });
    var agentSteps = steps.filter(function (s) { return AGENT_KINDS[s.kind]; });
    rail.appendChild(h("div", { class: "insp-head" },
      h("span", { class: "insp-kicker", text: "Steps" }),
      h("span", { class: "insp-sid", text: sel.length + " selected" }),
      h("span", { class: "insp-headnav" },
        h("button", { class: "insp-nav", type: "button", title: "deselect (Esc)", text: "✕", onClick: function () { ST.plan.clearSelection(); } })
      )
    ));
    var body = h("div", { class: "insp-body" });
    var list = h("div", { class: "insp-chips" });
    steps.forEach(function (s) { list.appendChild(h("span", { class: "insp-chip", text: s.id })); });
    body.appendChild(list);
    if (ro) {
      body.appendChild(h("p", { class: "insp-hint dim", text: "Read-only session — bulk editing is disabled." }));
    } else if (!agentSteps.length) {
      body.appendChild(h("p", { class: "insp-hint dim", text: "None of the selected steps are agent-backed; only gates, commands and the like are selected." }));
    } else {
      body.appendChild(h("p", { class: "insp-hint", text: "Set runner and model on " + agentSteps.length + " agent-backed step" + (agentSteps.length === 1 ? "" : "s") + " at once." }));
      var agentSel = ST.modals.selectEl([{ value: "", label: "keep each step's runner" }].concat(ST.modals.agentOptions()), "", function () {});
      agentSel.setAttribute("data-focus-key", "bulk-agent");
      var modelSel = ST.modals.selectEl([{ value: "", label: "keep each step's model" }], "", function () {});
      modelSel.setAttribute("data-focus-key", "bulk-model");
      agentSel.addEventListener("change", function () {
        var opts = [{ value: "", label: "keep each step's model" }]
          .concat(ST.modals.modelOptionsWith(agentSel.value, ""));
        while (modelSel.firstChild) modelSel.removeChild(modelSel.firstChild);
        opts.forEach(function (o) { modelSel.appendChild(h("option", { value: o.value }, o.label)); });
      });
      body.appendChild(h("div", { class: "insp-field" }, label("Runner"), agentSel));
      body.appendChild(h("div", { class: "insp-field" }, label("Model"), modelSel));
      body.appendChild(h("button", { class: "btn small primary", type: "button", text: "Apply to selected", onClick: function () {
        if (!agentSel.value && !modelSel.value) return;
        ST.plan.mutate(function (dd) {
          agentSteps.forEach(function (s) {
            var f = ST.plan.findStep(dd, s.id);
            if (!f) return;
            if (agentSel.value) { f.step.agent = agentSel.value; delete f.step.modelClass; }
            if (modelSel.value) f.step.model = modelSel.value;
          });
        });
      } }));
    }
    rail.appendChild(body);
    if (!ro) {
      rail.appendChild(h("div", { class: "insp-foot" },
        h("button", { class: "btn small", type: "button", text: "Delete selected", onClick: function () {
          if (window.confirm("Delete " + sel.length + " selected step" + (sel.length === 1 ? "" : "s") + "?")) ST.plan.deleteSelection();
        } })
      ));
    }
  }

  // ---- run attached: the step record (02.4) --------------------------------------

  function findRecordStep() {
    if (!S.detail || !S.runState) return null;
    var phases = S.runState.phases || [];
    for (var i = 0; i < phases.length; i++) {
      var p = phases[i];
      if (p.phaseId !== S.detail.phaseId || (p.iteration || 1) !== S.detail.iteration) continue;
      var steps = p.steps || [];
      for (var j = 0; j < steps.length; j++) {
        if (steps[j].stepId === S.detail.stepId) return { phase: p, step: steps[j] };
      }
    }
    return null;
  }

  function statusPill(s) {
    var running = s.status === "running";
    var cls = running ? "running" : s.status === "done" ? "done" : s.status === "error" ? "err" : "pending";
    var text = s.status;
    var suffix = "";
    // No timer here: the Elapsed metric directly below is this step's clock,
    // and two of them ticking off different sources read as a bug when they
    // disagree by a second.
    // A kill is requested before the step unwinds; say so rather than letting
    // the pill read "running" while nothing is going to come of it.
    if (running && s.killed) suffix += " · killing";
    if (s.result && s.result.killed) suffix += " · killed";
    if (s.cached) suffix += " · cached";
    if (s.result && s.result.skipped) suffix += " · skipped";
    var pill = h("span", { class: "insp-status " + cls },
      running ? h("i", { class: "pulse" }) : null, text, suffix);
    return pill;
  }

  function recordTab(id, labelText, suffix) {
    return h("button", {
      class: "plan-tab" + (S.recordTab === id ? " active" : ""),
      type: "button",
      onClick: function () { S.recordTab = id; ST.render(); }
    }, labelText, suffix || null);
  }

  /** A metric, or null when the step's kind can't produce one (never "—"). */
  /**
   * One metric, or null when there is nothing to report — the row lays out
   * only the cells that came back. `title` annotates a value that is still
   * moving (spend/tokens on a running step); the label itself stays short so
   * three cells keep fitting the rail's width.
   */
  function metricCell(k, v, since, title) {
    if (v === null || v === undefined || v === "") return null;
    var value = since
      ? h("div", { class: "v", "data-since": String(since), "data-since-prefix": "", text: v })
      : h("div", { class: "v", text: v });
    return h("div", { class: "insp-metric", title: title || null }, h("div", { class: "k", text: k }), value);
  }

  /**
   * Lay the metric block out on however many of its cells have a value — the
   * row is a flex of equal shares, so dropping Spend and Tokens on a command
   * step leaves Elapsed alone rather than parked in a three-column grid.
   */
  function metricRow(cells) {
    var live = cells.filter(Boolean);
    if (!live.length) return null;
    var row = h("div", { class: "insp-metrics" });
    live.forEach(function (c) { row.appendChild(c); });
    return row;
  }

  /**
   * The step's full address — 6a's orientation device: `land › pass 3 ›
   * rebase[#9] › babysit-pr › checks`. Because the address exists the spine is
   * free to fold aggressively; nothing gets lost, it gets named. Rendered only
   * when there is more to say than the phase the header already implies.
   */
  function renderAddress(p, s) {
    if (!ST.tree || !S.runState) return null;
    var bands = ST.run && ST.run.bands ? ST.run.bands() : null;
    var parts = ST.tree.addressOf(S.runState, p, s, bands);
    if (parts.length < 2) return null;
    var box = h("div", { class: "insp-address" });
    parts.forEach(function (part, i) {
      if (i) box.appendChild(h("span", { class: "sep", "aria-hidden": "true", text: "\u203a" }));
      box.appendChild(h("span", { class: "p " + part.kind, text: part.text }));
    });
    return box;
  }

  /**
   * The SUB-RUN block: when the selected step is running inside a `workflow`
   * call, how far through the child run it is. One segment per child step, so
   * "4 / 8" is also a picture of which of the eight are behind it.
   */
  function renderSubRun(p, s) {
    if (!ST.tree || !S.runState) return null;
    var sub = ST.tree.subRunOf(S.runState, s, p);
    if (!sub) return null;
    var declared = ST.run && ST.run.subRunStepCount ? ST.run.subRunStepCount(sub.callStepId) : 0;
    var total = Math.max(declared || 0, sub.total);
    var wrap = h("div", { class: "insp-subrun" });
    wrap.appendChild(h("div", { class: "insp-subrun-head" },
      h("span", { class: "insp-kicker", text: "Sub-run" }),
      h("span", { class: "name", text: sub.workflow || "sub-run" }),
      h("span", { class: "count", text: sub.done + " / " + total })
    ));
    var bar = h("div", { class: "insp-subrun-bar" });
    for (var i = 0; i < total; i++) {
      var step = sub.steps[i];
      var cls = !step ? "" : step.status === "error" ? "failed"
        : step.status === "done" ? "done"
        : step.status === "running" ? "live" : "";
      bar.appendChild(h("span", { class: cls }));
    }
    wrap.appendChild(bar);
    var overrides = subRunOverrides(sub.callStepId);
    if (overrides) wrap.appendChild(h("div", { class: "insp-subrun-note", text: overrides }));
    return wrap;
  }

  function subRunOverrides(callStepId) {
    if (!ST.run || !ST.run.subWorkflowView || !S.spec) return "";
    var found = ST.plan.findStep(S.spec, String(callStepId).replace(/\[\d+\]$/, ""));
    if (!found || found.step.kind !== "workflow") return "";
    var view = ST.run.subWorkflowView(found.step);
    if (!view || !view.resolved || !view.overrideCount) return "";
    return view.overrideCount + " override" + (view.overrideCount === 1 ? "" : "s") + " from the calling step";
  }

  function renderRecord(rail) {
    var found = findRecordStep();
    if (!found) return false;
    var p = found.phase, s = found.step;
    var specStep = S.spec ? ST.plan.findStep(S.spec, s.stepId) : null;

    // The address below carries the namespace, so the head names the step by
    // its own id. Guarded: st-tree.js is a separate asset.
    rail.appendChild(headRow(ST.tree ? ST.tree.leafId(s) : s.stepId, statusPill(s)));
    var address = renderAddress(p, s);
    if (address) rail.appendChild(address);

    var inputsCount = (s.dependsOn || []).length;
    var tabs = h("div", { class: "plan-tabs insp-rectabs" },
      recordTab("live", "Live"),
      recordTab("prompt", "Prompt"),
      recordTab("config", "Config"),
      recordTab("events", "Events")
    );
    rail.appendChild(tabs);

    var body = h("div", { class: "insp-body record" });
    if (S.recordTab === "prompt") {
      var prompt = s.prompt || (specStep && specStep.step.prompt) || "";
      body.appendChild(prompt
        ? promptHighlight(prompt)
        : h("div", { class: "insp-dim", text: "no prompt on this step" }));
    } else if (S.recordTab === "config") {
      body.appendChild(recordConfig(s, specStep));
    } else if (S.recordTab === "events") {
      body.appendChild(recordEvents(s));
    } else {
      body.appendChild(recordLive(p, s));
    }
    rail.appendChild(body);

    // The note sits on its own line above the buttons: at rail width it used
    // to wrap into two lines and shoulder them off the edge.
    var actions = h("div", { class: "insp-foot-actions" },
      h("button", { class: "btn small", type: "button", text: "Edit in plan", onClick: function () {
        var stepId = s.stepId;
        ST.selectWorkflow(S.selected, function () {
          ST.plan.selectStep(stepId, false);
        });
      } })
    );
    var kill = killButton(s);
    if (kill) actions.appendChild(kill);
    rail.appendChild(h("div", { class: "insp-foot stacked" },
      h("span", { class: "insp-foot-note", text: "edits apply to the next run" }),
      actions
    ));
    return true;
  }

  /**
   * "Kill step" (design 02.4), or null when there is nothing to kill. Offered
   * only for a step that is running right now, in a run this session owns and
   * can still steer: a detached or externally-owned run's steps belong to the
   * process running them, and a viewer may not stop anything at all.
   */
  function killButton(s) {
    if (s.status !== "running" || s.killed) return null;
    if (ST.isReadOnly() || !S.runId || S.runExternal || S.runDetached) return null;
    var btn = h("button", { class: "btn small danger-ghost", type: "button", text: "Kill step",
      title: "Fail this step now; the rest of the run keeps going" });
    btn.addEventListener("click", function () {
      btn.disabled = true;
      ST.apiAuth("POST", "/api/runs/" + encodeURIComponent(S.runId) + "/kill-step", { stepId: s.stepId })
        .then(function (r) {
          if (r.status === 200) {
            // The engine's own step_killed arrives on the stream and marks the
            // step; nothing to repaint from here.
            ST.announce("Killed step " + s.stepId + ".");
            return;
          }
          btn.disabled = false;
          ST.run.setBanner((r.body && r.body.error) || "could not kill step", "err");
        })
        .catch(function () {
          btn.disabled = false;
          ST.run.setBanner("could not kill step — network error", "err");
        });
    });
    return btn;
  }

  function recordLive(p, s) {
    var wrap = h("div");
    var finished = s.result && typeof s.result.durationMs === "number";
    var running = !finished && s.status === "running" && s.startedAt;
    var elapsed = finished
      ? ST.fmtElapsed(s.result.durationMs)
      : s.startedAt ? ST.fmtElapsed(Date.now() - s.startedAt) : "";
    // Spend/tokens track the step while it runs (the agent's own mid-flight
    // reports), then settle onto the result's billed totals — see ST.stepUsage.
    var use = ST.stepUsage(s);
    var soFar = use.live ? "so far — this step is still running" : null;
    var metrics = metricRow([
      metricCell("Elapsed", elapsed, running ? s.startedAt : null),
      metricCell("Spend", use.costUsd ? "$" + use.costUsd.toFixed(4) : "", null, soFar),
      metricCell("Tokens", use.tokens ? ST.fmtTokens(use.tokens) : "", null, soFar)
    ]);
    if (metrics) wrap.appendChild(metrics);

    var rows = h("div", { class: "insp-exec" });
    var runnerId = s.agent ? ST.agentUiLabel(s.agent) : s.api;
    if (runnerId) rows.appendChild(execRow("runner", runnerId + (s.model ? " · " + s.model : "") + (s.effort ? " · " + s.effort : "")));
    if (s.worktree) rows.appendChild(execRow("worktree", "⎇ " + s.worktree.branch));
    if (s.dependsOn && s.dependsOn.length) rows.appendChild(execRow("inputs", s.dependsOn.join(", ")));
    var attempts = s.attempts || (s.result && s.result.attempts);
    if (attempts) rows.appendChild(execRow("attempt", (s.result ? "" : "") + attempts + (s.result ? "" : " (in flight)")));
    if (s.status === "error" && s.result && s.result.error) rows.appendChild(execRow("error", s.result.error, "warn"));
    wrap.appendChild(rows);

    var subRun = renderSubRun(p, s);
    if (subRun) wrap.appendChild(subRun);

    // The stream itself belongs to the band pane, which has three times this
    // rail's width to render it in; painting the same text here as well gave
    // the reader two copies of one thing and neither of them authoritative.
    // What the rail keeps is the newest couple of lines, as a "what is it
    // doing right now" glance, plus a pointer to where the full stream lives.
    // Workflow-call containers bubble nested leaf streams so this is not stuck
    // empty while a child agent (e.g. babysit[4]::prepare) emits text_delta.
    // Guard SteamtrainReducer: unit tests paint this IIFE without the bundle.
    var Reducer = typeof SteamtrainReducer !== "undefined" ? SteamtrainReducer : null;
    var view = (S.runState && Reducer && Reducer.resolveLiveOutputStep)
      ? (Reducer.resolveLiveOutputStep(S.runState, s) || s)
      : s;
    var body = Reducer && Reducer.liveOutputBody
      ? Reducer.liveOutputBody(view)
      : (((view.result && view.result.output) || view.text || "").trim() || (view.activity || ""));
    var activity = h("div", { class: "insp-activity" });
    var head = h("div", { class: "insp-activity-head" },
      h("span", { class: "insp-kicker", text: "Activity" }));
    // Name the source only when it is not the step the rail is already titled.
    if (view.stepId !== s.stepId) {
      head.appendChild(h("span", { class: "insp-activity-src", text: view.stepId }));
    }
    activity.appendChild(head);
    var recent = body ? body.slice(-320).replace(/\s+/g, " ").trim() : "";
    activity.appendChild(h("div", {
      class: "insp-activity-body",
      text: recent ? (body.length > 320 ? "…" + recent : recent) : "no output yet"
    }));
    activity.appendChild(h("div", { class: "insp-activity-note", text: "Full stream is in the band, left ←" }));
    wrap.appendChild(activity);

    wrap.appendChild(recordEventLog());
    return wrap;
  }

  /**
   * The run's recent events, filling the rail below Activity. Unlike the
   * Events tab — which narrows to this step — this is the run's own tail, the
   * "what just happened anywhere" readout the console had nowhere else to put.
   */
  function recordEventLog() {
    var wrap = h("div", { class: "insp-eventlog" });
    wrap.appendChild(h("div", { class: "insp-kicker", text: "Event log" }));
    var log = h("div", { class: "insp-events" });
    var entries = (S.eventLog || []).slice(0, 8);
    if (!entries.length) {
      log.appendChild(h("div", { class: "insp-dim", text: "no events yet" }));
    } else {
      entries.forEach(function (entry) {
        log.appendChild(h("div", { class: "insp-event" },
          h("span", { class: "t", text: new Date(entry.atMs).toLocaleTimeString() }),
          h("span", { class: "m", text: entry.text })));
      });
    }
    wrap.appendChild(log);
    return wrap;
  }

  function recordConfig(s, specStep) {
    var wrap = h("div", { class: "insp-exec" });
    var step = specStep ? specStep.step : s;
    rows:
    {
      var runnerId = step.agent ? ST.agentUiLabel(step.agent) : step.api;
      wrap.appendChild(execRow("runner", runnerId
        ? runnerId + (step.model ? " · " + step.model : "") + (step.effort ? " · " + step.effort : "")
        : step.modelClass ? "auto · class:" + step.modelClass : step.model ? "auto · " + step.model : "auto"));
      var perms = step.permissions || (S.spec && S.spec.permissions);
      wrap.appendChild(execRow("write access", perms ? (typeof perms === "string" ? perms : (perms.profile || "custom")) : "default (full)"));
      var retries = step.retry || (S.spec && S.spec.retry);
      wrap.appendChild(execRow("retries", retries && typeof retries.retries === "number" ? String(retries.retries) : "none"));
      var timeout = step.stepTimeoutSec || (S.spec && S.spec.stepTimeoutSec);
      wrap.appendChild(execRow("timeout", timeout ? timeout + "s" : "project default"));
      if (step.dependsOn && step.dependsOn.length) wrap.appendChild(execRow("depends on", step.dependsOn.join(", ")));
      if (step.cwd) wrap.appendChild(execRow("cwd", step.cwd));
    }
    return wrap;
  }

  function recordEvents(s) {
    var wrap = h("div", { class: "insp-events" });
    var mine = (S.eventLog || []).filter(function (entry) {
      return entry.text && entry.text.indexOf(s.stepId) !== -1;
    });
    if (!mine.length) {
      wrap.appendChild(h("div", { class: "insp-dim", text: "no events for this step yet" }));
      return wrap;
    }
    mine.slice(0, 50).forEach(function (entry) {
      wrap.appendChild(h("div", { class: "insp-event" },
        h("span", { class: "t", text: new Date(entry.atMs).toLocaleTimeString() }),
        h("span", { class: "m", text: entry.text })));
    });
    return wrap;
  }

  // ---- entry point ------------------------------------------------------------

  /**
   * Render into #rail-right. Returns true when the inspector owns the rail
   * (idle plan selection, or a drilled-in step during a run); false hands the
   * rail back to the instrument cluster.
   */
  function render(rail) {
    clear(rail);
    if (S.runId && S.detail) return renderRecord(rail);
    if (!S.runId && S.spec && !S.page) return renderForm(rail);
    return false;
  }

  ST.inspector = {
    render: render,
  };
})(window.Steamtrain);
