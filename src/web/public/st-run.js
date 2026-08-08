/**
 * Run surface: the pipeline canvas, run controls, step drill-in, staged
 * overrides, and the plan (dry-run) view.
 */
(function (ST) {
  "use strict";
  var S = ST.state;
  var h = ST.h;
  var KIND_LABEL = ST.KIND_LABEL;
  var activateWithKeyboard = ST.activateWithKeyboard;
  var addTokensInto = ST.addTokensInto;
  var aggregateByModel = ST.aggregateByModel;
  var api = ST.api;
  var apiAuth = ST.apiAuth;
  var attachRun = ST.attachRun;
  var clear = ST.clear;
  var emptyTokens = ST.emptyTokens;
  var fmtElapsed = ST.fmtElapsed;
  var fmtElapsedRange = ST.fmtElapsedRange;
  var fmtTokenSummary = ST.fmtTokenSummary;
  var fmtTokens = ST.fmtTokens;
  var focusDetailFallback = ST.focusDetailFallback;
  var isInteractiveTarget = ST.isInteractiveTarget;
  var isReadOnly = ST.isReadOnly;
  var permissionBadge = ST.permissionBadge;
  var pollLiveRuns = ST.pollLiveRuns;
  var reduce = ST.reduce;
  var relTime = ST.relTime;
  var restoreDetailInvoker = ST.restoreDetailInvoker;
  var scheduleRender = ST.scheduleRender;
  var selectWorkflow = ST.selectWorkflow;
  var setRunDeepLink = ST.setRunDeepLink;
  var showReauthOverlay = ST.showReauthOverlay;
  var stepKey = ST.stepKey;
  var stepPermissions = ST.stepPermissions;
  var stepUsage = ST.stepUsage;
  var tail = ST.tail;
  var totalTokens = ST.totalTokens;
  var truncate = ST.truncate;
  var updateLiveTimers = ST.updateLiveTimers;
  var wfListItem = ST.wfListItem;

  function setParamsExpanded(expanded) {
    var panel = document.getElementById("paramsPanel");
    var toggle = document.getElementById("paramsToggle");
    if (!panel || !toggle) return;
    if (expanded) panel.classList.remove("collapsed");
    else panel.classList.add("collapsed");
    toggle.setAttribute("aria-expanded", expanded ? "true" : "false");
  }

  function updateParamsMeta(count) {
    var meta = document.getElementById("paramsMeta");
    if (!meta) return;
    if (!count) {
      meta.textContent = "";
      return;
    }
    meta.textContent = count === 1
      ? "1 variable · defaults"
      : count + " variables · defaults";
  }

  function renderParamsForm(spec) {
    var panel = document.getElementById("paramsPanel");
    var container = document.getElementById("paramsForm");
    clear(container);
    var inputs = spec && spec.inputs;
    var keys = inputs ? Object.keys(inputs) : [];
    if (!panel || !container || keys.length === 0) {
      if (panel) {
        panel.style.display = "none";
        panel.hidden = true;
        panel.classList.add("collapsed");
      }
      updateParamsMeta(0);
      return;
    }
    panel.style.display = "";
    panel.hidden = false;
    // Keep variables tucked away so the pipeline stays the star; one click opens.
    setParamsExpanded(false);
    updateParamsMeta(keys.length);
    keys.forEach(function (key) {
      var inp = inputs[key];
      var type = inp.type || "string";
      var required = inp.required === true || (inp.required !== false && inp.default === undefined);
      var defaultStr = inp.default !== undefined ? String(inp.default) : "";
      var labelText = key;
      var typeHint =
        type === "boolean" ? " (y/n)" :
        type === "number" ? " (number)" :
        type === "model" ? " (model)" :
        type === "agent" ? " (agent)" :
        type === "enum" ? " (enum)" : "";
      var hint = inp.description || "";
      if (defaultStr) hint = hint ? hint + " \u00b7 default: " + defaultStr : "default: " + defaultStr;
      if (type === "model" && inp.fallbackModels && inp.fallbackModels.length) {
        hint = (hint ? hint + " \u00b7 " : "") + "fallback: " + inp.fallbackModels.join(" \u2192 ");
      }

      var control;
      var choices = Array.isArray(inp.choices) ? inp.choices.slice() : null;
      if (type === "boolean") {
        control = ST.modals.selectEl([
          { value: "", label: "(not set)" },
          { value: "true", label: "yes" },
          { value: "false", label: "no" }
        ], defaultStr === "true" ? "true" : defaultStr === "false" ? "false" : "");
      } else if (type === "enum" || (choices && choices.length && (type === "string" || type === "agent"))) {
        var enumOpts = [{ value: "", label: required ? "(required)" : "(not set)" }].concat(
          choices.map(function (c) { return { value: c, label: c }; })
        );
        if (defaultStr && !choices.some(function (c) { return c === defaultStr; })) {
          enumOpts.push({ value: defaultStr, label: defaultStr + " (default)" });
        }
        control = ST.modals.selectEl(enumOpts, defaultStr);
      } else if (type === "agent") {
        var agentOpts = [{ value: "", label: required ? "(required)" : "(not set)" }].concat(ST.modals.agentOptions());
        if (defaultStr && !agentOpts.some(function (o) { return o.value === defaultStr; })) {
          agentOpts.splice(1, 0, { value: defaultStr, label: defaultStr + " (default)" });
        }
        control = ST.modals.selectEl(agentOpts, defaultStr);
      } else if (type === "model") {
        // Combobox: free-text with catalog datalist so aliases / native ids both work.
        var listId = "param-models-" + key.replace(/[^a-zA-Z0-9_-]/g, "_");
        control = h("input", {
          class: "txt",
          type: "text",
          list: listId,
          placeholder: defaultStr || (required ? "model id or alias" : "optional model"),
          value: defaultStr
        });
        var datalist = h("datalist", { id: listId });
        var modelOpts = choices && choices.length
          ? choices.map(function (c) { return { value: c, label: c }; })
          : ST.modals.familyModelOptions(defaultStr);
        modelOpts.forEach(function (o) {
          datalist.appendChild(h("option", { value: o.value }, o.label));
        });
        // Attach datalist after the control wrapper below.
        control._paramDatalist = datalist;
      } else {
        control = h("input", {
          class: "txt",
          type: type === "number" ? "number" : "text",
          placeholder: defaultStr || (required ? "required" : ""),
          value: defaultStr
        });
      }
      control.setAttribute("data-param-key", key);
      control.setAttribute("data-param-type", type);
      if (choices && choices.length) control._paramChoices = choices;

      var labelEl = h("label", { text: labelText });
      if (required) {
        var req = h("span", { class: "param-required", text: " *" });
        labelEl.appendChild(req);
      }
      if (typeHint) {
        labelEl.appendChild(h("span", { class: "param-type", text: typeHint }));
      }
      var errEl = h("div", { class: "field-error" });
      var wrapper = h("div", { class: "field" }, labelEl, control,
        control._paramDatalist || null,
        hint ? h("div", { class: "hint", text: hint }) : null, errEl);
      container.appendChild(wrapper);

      control._fieldError = errEl;
      if (required || type === "number" || type === "enum" || (choices && choices.length)) {
        ST.modals.addBlurValidation(control, function () {
          var val = control.value;
          if (required && (!val || (typeof val === "string" && !val.trim()))) return key + " is required";
          if (type === "number" && val && isNaN(Number(val))) return key + " must be a number";
          if (choices && choices.length && val && choices.indexOf(val) < 0) {
            return key + " must be one of: " + choices.join(", ");
          }
          return null;
        });
      }
    });
  }

  function validateParamsForm() {
    var panel = document.getElementById("paramsPanel");
    var container = document.getElementById("paramsForm");
    if (!panel || !container || panel.hidden || panel.style.display === "none") return true;
    var fields = container.querySelectorAll("[data-param-key]");
    var firstInvalid = null;
    for (var i = 0; i < fields.length; i++) {
      var el = fields[i];
      var key = el.getAttribute("data-param-key");
      var type = el.getAttribute("data-param-type") || "string";
      var required = el.closest(".field") && el.closest(".field").querySelector(".param-required");
      var val = el.value;
      var msg = null;
      if (required && (!val || (typeof val === "string" && !val.trim()))) {
        msg = key + " is required";
      } else if (type === "number" && val && isNaN(Number(val))) {
        msg = key + " must be a number";
      } else if (el._paramChoices && el._paramChoices.length && val && el._paramChoices.indexOf(val) < 0) {
        msg = key + " must be one of: " + el._paramChoices.join(", ");
      }
      var errEl = el._fieldError;
      if (msg) {
        el.classList.add("invalid");
        if (errEl) { errEl.textContent = msg; errEl.classList.add("show"); }
        if (!firstInvalid) firstInvalid = el;
      } else {
        el.classList.remove("invalid");
        if (errEl) { errEl.textContent = ""; errEl.classList.remove("show"); }
      }
    }
    if (firstInvalid) {
      setParamsExpanded(true);
      setBanner("fix parameter errors before running", "err");
      try { firstInvalid.focus(); } catch (_) {}
      return false;
    }
    return true;
  }

  function collectParams() {
    var panel = document.getElementById("paramsPanel");
    var container = document.getElementById("paramsForm");
    if (!panel || !container || panel.hidden || panel.style.display === "none") return undefined;
    var fields = container.querySelectorAll("[data-param-key]");
    if (fields.length === 0) return undefined;
    var params = {};
    for (var i = 0; i < fields.length; i++) {
      var el = fields[i];
      var key = el.getAttribute("data-param-key");
      var val = el.value;
      if (val !== "") params[key] = val;
    }
    return Object.keys(params).length > 0 ? params : undefined;
  }

  // ---- phase bands ---------------------------------------------------------

  /**
   * The tokens define six kind tones; every block kind maps onto one of them
   * (`command` is the default the base `.kind` rule already paints).
   */
  var KIND_TONE = {
    worker: "worker", processor: "worker",
    distributor: "distributor", workflow: "distributor",
    consolidator: "consolidator", merge: "consolidator",
    gate: "gate", approval: "gate", human: "gate",
    llm: "llm"
  };

  function isRunning(s) { return s.status === "running"; }

  /**
   * A phaseId with its sub-workflow namespace stripped. The engine forwards a
   * nested run's `phase_start` under `<callStepId>::<childPhaseId>` (which is
   * what keeps two children's same-named phases from colliding in the reducer)
   * but with the child's own title and index untouched. Bands group on this
   * bare id so a fan-out of N children collapses into one band instead of N
   * same-titled ones numbered 01, 01, 01.
   */
  function basePhaseId(phaseId) {
    var id = String(phaseId);
    var idx = id.lastIndexOf("::");
    return idx === -1 ? id : id.slice(idx + 2);
  }

  /**
   * Band identity: the un-namespaced phase instance, qualified by title so two
   * unrelated sub-workflows that happen to name a phase alike stay apart.
   *
   * The parent call step is deliberately NOT part of the key — merging the
   * siblings of one fan-out is the whole point. The assumption that buys is
   * that a bare phaseId plus its title identifies a phase across workflows:
   * two *different* sub-workflows that both declare, say, `review` titled
   * "Review the diff" would share a band. Titles are authored per workflow, so
   * a collision means the phases genuinely are the same step of the same
   * child — but a run that nests two unrelated workflows this way would want
   * the parent id back in this key.
   */
  function bandKey(p) {
    return basePhaseId(p.phaseId) + ":" + (p.iteration || 1) + ":" + (p.title || "");
  }

  /**
   * Fold the flat phase list into bands, merging sibling instances (see
   * bandKey). Each entry keeps its *originating* phase so stepKey, tail-scroll
   * keys and openDetail keep addressing the real phase instance — the band is
   * a presentation grouping and nothing below it knows about the merge.
   */
  function buildBands(phases) {
    var bands = [], byKey = {};
    phases.forEach(function (p, idx) {
      var key = bandKey(p);
      var band = byKey[key];
      if (!band) {
        band = byKey[key] = {
          key: key,
          title: p.title,
          index: typeof p.index === "number" ? p.index : idx,
          iteration: p.iteration || 1,
          members: [],
          entries: []
        };
        bands.push(band);
      }
      band.members.push(p);
      if (typeof p.index === "number" && p.index < band.index) band.index = p.index;
      (p.steps || []).forEach(function (s) { band.entries.push({ phase: p, step: s }); });
    });
    bands.forEach(function (band) {
      band.done = band.members.every(function (p) { return p.done; });
      band.stepCount = band.members.reduce(function (n, p) {
        return n + (typeof p.stepCount === "number" ? p.stepCount : (p.steps || []).length);
      }, 0);
    });
    return bands;
  }

  function bandSteps(band) {
    return band.entries.map(function (e) { return e.step; });
  }

  /** Running leaf work (not a `workflow` container that waits on nested steps). */
  function isLiveRunning(s) {
    return isRunning(s) && s.blockKind !== "workflow";
  }

  /**
   * Exactly one band expands: the selected step's, else a phase with running
   * leaf work, else any running phase. Preferring leaf work matters for
   * sub-workflow fan-outs (`babysit[n]`): the parent phase stays running the
   * whole time while agent text streams in a later namespaced phase.
   */
  function expandedBandKey(bands) {
    var i, j;
    if (S.selectedStepId) {
      for (i = 0; i < bands.length; i++) {
        var steps = bandSteps(bands[i]);
        for (j = 0; j < steps.length; j++) {
          if (steps[j].stepId === S.selectedStepId) return bands[i].key;
        }
      }
    }
    for (i = 0; i < bands.length; i++) {
      if (
        bands[i].key !== S.collapsedBandKey &&
        !bands[i].done &&
        bandSteps(bands[i]).some(isLiveRunning)
      ) {
        return bands[i].key;
      }
    }
    for (i = 0; i < bands.length; i++) {
      if (
        bands[i].key !== S.collapsedBandKey &&
        !bands[i].done &&
        bandSteps(bands[i]).some(isRunning)
      ) {
        return bands[i].key;
      }
    }
    return null;
  }

  function bandClass(band) {
    if (band.done) return "band done";
    if (bandSteps(band).some(isRunning)) return "band running";
    return "band queued";
  }

  /**
   * "3 command steps, parallel" — what the rows below the header are, said
   * once for the band instead of repeated as a chip on every uniform row.
   */
  function bandKindLine(band) {
    var steps = bandSteps(band);
    var n = steps.length || band.stepCount || 0;
    if (!n) return "";
    var kind = null;
    for (var i = 0; i < steps.length; i++) {
      var label = KIND_LABEL[steps[i].blockKind] || steps[i].blockKind;
      if (kind === null) kind = label;
      else if (kind !== label) { kind = ""; break; }
    }
    if (n === 1) return "1 step" + (kind ? " · " + kind : "");
    return n + (kind ? " " + kind : "") + " steps, parallel";
  }

  /**
   * The band's right-hand readout: while anything in it runs, the spread of
   * live elapsed times; once finished, the spread of durations plus cost and
   * tokens when there are any. Merged siblings make a range the honest
   * summary — three children rarely finish on the same tick.
   */
  function bandRollup(band) {
    var steps = bandSteps(band);
    var running = steps.filter(isRunning);
    var now = Date.now();
    var lo, hi, i;
    if (running.length) {
      for (i = 0; i < running.length; i++) {
        if (!running[i].startedAt) continue;
        var live = now - running[i].startedAt;
        if (lo === undefined || live < lo) lo = live;
        if (hi === undefined || live > hi) hi = live;
      }
      if (lo === undefined) return "running";
      return "running " + fmtElapsedRange(lo, hi);
    }
    // Only reachable when nothing ran above, so lo/hi are still untouched —
    // reset them anyway so the two accumulations never share a lifetime.
    lo = undefined;
    hi = undefined;
    var cost = 0, tok = emptyTokens(), any = false;
    steps.forEach(function (s) {
      if (!s.result) return;
      any = true;
      var ms = s.result.durationMs || 0;
      if (lo === undefined || ms < lo) lo = ms;
      if (hi === undefined || ms > hi) hi = ms;
      cost += s.result.costUsd || 0;
      addTokensInto(tok, s.result.tokens);
    });
    if (!any) return band.done ? "" : "queued";
    var bits = [];
    var span = fmtElapsedRange(lo, hi);
    if (span) bits.push(span);
    if (cost > 0) bits.push("$" + cost.toFixed(4));
    var tk = totalTokens(tok);
    if (tk > 0) bits.push(fmtTokens(tk) + " tok");
    return bits.join(" · ");
  }

  function kindChip(blockKind) {
    var tone = KIND_TONE[blockKind];
    return h("span", { class: "kind" + (tone ? " " + tone : "") },
      h("span", { class: "rule", "aria-hidden": "true" }),
      h("span", { class: "label", text: KIND_LABEL[blockKind] || blockKind || "step" })
    );
  }

  /** Who actually runs the step, or null when nothing runs it (a command). */
  function runnerLabel(s) {
    var id = s.agent ? ST.agentUiLabel(s.agent) : s.api;
    if (id) return id + (s.model ? " · " + s.model : "");
    if (s.modelClass) return "auto · class:" + s.modelClass;
    if (s.model) return "auto · " + s.model;
    return null;
  }

  function stepMetaBits(s) {
    var bits = [];
    if (s.worktree) bits.push(1);
    if (s.item) bits.push(1);
    if (s.cached) bits.push(1);
    var attempts = s.attempts || (s.result && s.result.attempts);
    if (attempts && attempts > 1) bits.push(1);
    return bits.length;
  }

  /**
   * Which columns this band's rows can actually fill. A band of command steps
   * has no runner, no spend and no tokens; dashing those out three times per
   * row is a wall of "—" where the id needed the width. Columns nothing in the
   * band can populate are not laid out at all.
   */
  function bandColumns(band) {
    var steps = bandSteps(band);
    var spec = { meta: false, runner: false, cost: false, tokens: false };
    steps.forEach(function (s) {
      if (stepMetaBits(s)) spec.meta = true;
      if (runnerLabel(s)) spec.runner = true;
      // Live usage counts: a running agent that is already reporting tokens
      // gets its column now, not when the step finally lands.
      var use = stepUsage(s);
      if (use.costUsd) spec.cost = true;
      if (use.tokens) spec.tokens = true;
    });
    var cols = ["14px", "minmax(0,1fr)"];
    if (spec.meta) cols.push("minmax(0,190px)");
    // Column 3 is "what runs this": the runner, falling back to the block kind
    // for steps that have none. Never empty, so it never needs a dash.
    cols.push(spec.runner ? "168px" : "92px");
    cols.push(spec.cost || spec.tokens ? "64px" : "74px");
    if (spec.cost) cols.push("68px");
    if (spec.tokens) cols.push("58px");
    cols.push("20px");
    spec.template = cols.join(" ");
    return spec;
  }

  /** Worktree branch, item label, `cached`, `N tries` — in that order. */
  function stepMetaCell(s) {
    var cell = h("div", { class: "meta" });
    var bits = [];
    if (s.worktree) bits.push(h("span", { title: s.worktree.cwd, text: "⎇ " + s.worktree.branch }));
    if (s.item) bits.push(h("span", { text: "item #" + s.item.index + ": " + truncate(s.item.value, 48) }));
    if (s.cached) bits.push(h("span", { class: "cached", text: "cached" }));
    var attempts = s.attempts || (s.result && s.result.attempts);
    if (attempts && attempts > 1) bits.push(h("span", { text: attempts + " tries" }));
    bits.forEach(function (b, i) {
      if (i > 0) cell.appendChild(document.createTextNode(" · "));
      cell.appendChild(b);
    });
    return cell;
  }

  function timeCell(s) {
    if (s.status === "running" && s.startedAt) {
      return h("div", {
        class: "num time",
        "data-since": String(s.startedAt),
        "data-since-prefix": "",
        text: fmtElapsed(Date.now() - s.startedAt)
      });
    }
    var ms = s.result && s.result.durationMs;
    var label = typeof ms === "number" ? fmtElapsed(ms) : "";
    return h("div", { class: "num time", text: label });
  }

  function stepRowClass(s) {
    if (s.status === "running") return "step-row running";
    if (s.status === "error") return "step-row failed";
    if (s.status === "done") return "step-row done";
    return "step-row";
  }

  /**
   * One step row, laid out on its band's column spec (see bandColumns): dot,
   * id, [meta], runner-or-kind, time, [cost], [tokens], chevron. The whole row
   * is the control (the chevron is its affordance); activating it selects the
   * step and opens the drill-in drawer. `open` marks the row whose live output
   * is expanded directly beneath it.
   */
  function renderStepRow(p, s, cols, open) {
    var use = stepUsage(s);
    var soFar = use.live ? "so far — this step is still running" : null;
    var runner = runnerLabel(s);
    var row = h("button", {
        class: stepRowClass(s) + (open ? " open" : ""),
        type: "button",
        "data-detail-invoker": "row:" + stepKey(p, s),
        "aria-label": "Open details for step " + s.stepId,
        title: "Open this step's output and details",
        onClick: function (event) { openDetail(p, s, event.currentTarget, open); }
      },
      h("span", { class: "dot", "aria-hidden": "true" }),
      h("div", { class: "id", text: s.stepId })
    );
    if (cols.meta) row.appendChild(stepMetaCell(s));
    row.appendChild(runner
      ? h("div", { class: "runner", text: runner })
      : kindChip(s.blockKind));
    row.appendChild(timeCell(s));
    if (cols.cost) row.appendChild(h("div", { class: "num cost" + (use.live ? " live" : ""), title: soFar, text: use.costUsd ? "$" + use.costUsd.toFixed(4) : "" }));
    if (cols.tokens) row.appendChild(h("div", { class: "num tok" + (use.live ? " live" : ""), title: soFar, text: use.tokens ? fmtTokens(use.tokens) : "" }));
    row.appendChild(h("span", { class: "chev", "aria-hidden": "true", text: open ? "⌄" : "›" }));
    return row;
  }

  /** "What runs inside" for a sub-workflow call step, hung off its row. */
  function subWorkflowRow(p, s) {
    if (s.blockKind !== "workflow") return null;
    var block = subWorkflowCardBlock(s.stepId, stepKey(p, s));
    return block ? h("div", { class: "step-sub" }, block) : null;
  }

  /**
   * Resolve a workflow-container selection to the nested leaf that actually
   * streams agent text (see SteamtrainReducer.resolveLiveOutputStep).
   */
  function liveViewStep(s) {
    var Reducer = typeof SteamtrainReducer !== "undefined" ? SteamtrainReducer : null;
    if (!s || !S.runState || !Reducer || !Reducer.resolveLiveOutputStep) return s;
    return Reducer.resolveLiveOutputStep(S.runState, s) || s;
  }

  function liveBody(s) {
    if (!s) return "";
    var Reducer = typeof SteamtrainReducer !== "undefined" ? SteamtrainReducer : null;
    if (Reducer && Reducer.liveOutputBody) return Reducer.liveOutputBody(s);
    return (((s.result && s.result.output) || s.text || "").trim()) || (s.activity || "");
  }

  /** The band entry whose output the expanded band shows, inline under its row. */
  function bandOutputEntry(band) {
    var entries = band.entries, i;
    if (S.selectedStepId) {
      for (i = 0; i < entries.length; i++) {
        if (entries[i].step.stepId === S.selectedStepId) return entries[i];
      }
    }
    // Prefer a running leaf over a running workflow container in the same band.
    for (i = 0; i < entries.length; i++) if (isLiveRunning(entries[i].step)) return entries[i];
    for (i = 0; i < entries.length; i++) if (isRunning(entries[i].step)) return entries[i];
    for (i = entries.length - 1; i >= 0; i--) {
      var s = entries[i].step;
      if (s.text || (s.result && s.result.output)) return entries[i];
    }
    return null;
  }

  /**
   * The live output pane inside the expanded band. Follows the stream until the
   * reader scrolls up; scrolling back to the bottom re-engages following. The
   * position survives re-renders through S.tailScroll (see applyTailScroll).
   * Workflow-call steps show their nested leaf's stream so the pane is not
   * stuck on "no output yet" while a child agent runs.
   */
  function renderOutputPane(p, s) {
    var view = liveViewStep(s);
    var key = stepKey(p, s);
    var body = liveBody(view);
    var scroll = S.tailScroll[key] || { follow: true, top: 0 };
    var following = h("span", {
      class: "following",
      text: (view.status === "running" || s.status === "running")
        ? (scroll.follow ? "following" : "paused") : ""
    });
    var label = view.stepId === s.stepId
      ? "Live output · " + s.stepId
      : "Live output · " + s.stepId + " · " + view.stepId;
    var pane = h("div", { class: "output" },
      h("div", { class: "output-head" },
        h("span", { class: "label", text: label }),
        following,
        h("div", { class: "actions" },
          h("button", {
            class: "obtn", type: "button",
            text: S.outputNoWrap ? "Wrap" : "No wrap",
            title: "Toggle line wrapping",
            // Keyboard users must not be dropped off this control by the
            // re-render its own click triggers (nor by the 2s tick).
            "data-focus-key": "out-wrap:" + key,
            onClick: function () { S.outputNoWrap = !S.outputNoWrap; ST.render(); }
          }),
          h("button", {
            class: "obtn", type: "button", text: "Copy", title: "Copy this step's output",
            "data-focus-key": "out-copy:" + key,
            onClick: function () {
              if (navigator.clipboard) navigator.clipboard.writeText(body).catch(function () {});
            }
          })
        )
      )
    );
    var out = h("div", { class: "output-body" + (S.outputNoWrap ? " nowrap" : ""), "data-key": key });
    out.textContent = body || "no output yet";
    out.addEventListener("scroll", function () {
      var atBottom = out.scrollTop + out.clientHeight >= out.scrollHeight - 4;
      S.tailScroll[key] = { follow: atBottom, top: out.scrollTop };
      if (view.status === "running" || s.status === "running") {
        following.textContent = atBottom ? "following" : "paused";
      }
    });
    pane.appendChild(out);
    return pane;
  }

  /**
   * Run-level pending states (approval checkpoints, human input) sit above the
   * first band: they belong to the run, not to any one band's step list.
   * Pending ones first, then the recorded decisions.
   */
  function renderPendingBlock(container) {
    var phases = (S.runState && S.runState.phases) || [];
    var pending = [], resolved = [];
    phases.forEach(function (p) {
      (p.steps || []).forEach(function (s) {
        if (s.approval) (s.approval.pending ? pending : resolved).push(renderApproval(p, s));
        if (s.humanInput) (s.humanInput.pending ? pending : resolved).push(renderHumanInput(p, s));
      });
    });
    if (!pending.length && !resolved.length) return;
    var box = h("div", { class: "pending-block" });
    pending.concat(resolved).forEach(function (el) { box.appendChild(el); });
    container.appendChild(box);
  }

  /**
   * One band per *merged* phase instance (see buildBands); exactly one is
   * expanded, and its live output hangs directly under the row it belongs to
   * rather than in a second pane at the foot of the band.
   */
  function renderBands(container) {
    var phases = (S.runState && S.runState.phases) || [];
    if (!phases.length) return;
    renderPendingBlock(container);
    var bands = buildBands(phases);
    var expanded = expandedBandKey(bands);
    bands.forEach(function (b) {
      var cls = bandClass(b);
      var isExpanded = b.key === expanded;
      var band = h("div", { class: cls + (isExpanded ? " expanded" : "") });
      var rollup = bandRollup(b);
      var kindLine = bandKindLine(b);
      band.appendChild(h("div", { class: "band-head" },
        h("span", { class: "idx", text: String(b.index + 1).padStart(2, "0") }),
        h("span", { class: "dot", "aria-hidden": "true" }),
        h("span", {
          class: "title",
          text: b.title + (b.iteration > 1 ? " · iteration " + b.iteration : "")
        }),
        // How many sibling sub-workflows this one band stands for.
        b.members.length > 1 ? h("span", { class: "xn", text: "×" + b.members.length }) : null,
        kindLine ? h("span", { class: "count", text: kindLine }) : null,
        rollup ? h("span", { class: "rollup", text: rollup }) : null
      ));
      // A queued phase collapses to its header line.
      if (cls === "band queued") { container.appendChild(band); return; }
      var cols = bandColumns(b);
      band.style.setProperty("--step-cols", cols.template);
      // The expanded band is a fixed-height console pane: its rows and the
      // inline output pane live in their own scroll area so a long step list
      // scrolls inside the band instead of overflowing it (which used to paint
      // over the bands below and squeeze the output pane to an unusable
      // sliver). Collapsed bands are sized by their rows, so they host them
      // directly.
      var listKey = b.key;
      var stepHost = isExpanded ? h("div", { class: "band-steps", "data-scroll-key": listKey }) : band;
      if (isExpanded) {
        stepHost.addEventListener("scroll", function () {
          var atBottom = stepHost.scrollTop + stepHost.clientHeight >= stepHost.scrollHeight - 4;
          if (!S.stepListScroll) S.stepListScroll = {};
          S.stepListScroll[listKey] = { follow: atBottom, top: stepHost.scrollTop };
        });
      }
      var outEntry = isExpanded ? bandOutputEntry(b) : null;
      b.entries.forEach(function (e) {
        var open = Boolean(outEntry && outEntry.step === e.step);
        stepHost.appendChild(renderStepRow(e.phase, e.step, cols, open));
        if (open) stepHost.appendChild(renderOutputPane(e.phase, e.step));
        var sub = subWorkflowRow(e.phase, e.step);
        if (sub) stepHost.appendChild(sub);
      });
      if (stepHost !== band) band.appendChild(stepHost);
      container.appendChild(band);
    });
  }

  /**
   * A pipeline step card. The live run pane renders step rows instead; this
   * survives for the recorded-run detail view in st-modals.js (single argument,
   * no live phase) and stays the shape that view expects.
   */
  function renderCard(s, p) {
    // Historical cards have no live phase instance; only live cards need a
    // phase-qualified tail-scroll key.
    var key = p ? stepKey(p, s) : s.stepId;
    var isOpen = p && S.detail && S.detail.phaseId === p.phaseId &&
      S.detail.iteration === (p.iteration || 1) && S.detail.stepId === s.stepId;
    var card = h("div", {
      class: "card clickable " + s.status + (isOpen ? " open" : ""),
      title: p ? "Click to inspect this step; use Details for keyboard access" : undefined,
      onClick: function (event) {
        if (!p || isInteractiveTarget(event.target)) return;
        openDetail(p, s, event.currentTarget);
      }
    });
    var kindEl = h("span", { class: "kind " + s.blockKind });
    if (s.status === "running") kindEl.appendChild(h("span", { class: "pulse" }));
    var perms = stepPermissions(s);
    kindEl.appendChild(document.createTextNode(KIND_LABEL[s.blockKind] || s.blockKind));
    var attempts = s.attempts || (s.result && s.result.attempts);
    var stateLabel = s.status === "pending" ? "pending" : s.status;
    if (s.result && s.result.skipped) stateLabel = "skipped";
    if (attempts && attempts > 1) stateLabel += " \u00b7 " + attempts + " tries";
    var top = h("div", { class: "top" },
      h("span", { class: "sid", text: s.stepId }),
      kindEl,
      h("span", { class: "state " + s.status, text: stateLabel })
    );
    // The sandbox badge sits in the card header, next to the block kind: what a
    // step is allowed to do belongs with what a step IS.
    if (perms) top.appendChild(permissionBadge(perms));
    if (p) {
      top.appendChild(h("button", {
        class: "card-details",
        text: "Details",
        "data-detail-invoker": "details:" + key,
        "aria-label": "Open details for step " + s.stepId,
        onClick: function (event) {
          event.stopPropagation();
          openDetail(p, s, event.currentTarget);
        }
      }));
    }
    card.appendChild(top);
    var runnerId = s.agent ? ST.agentUiLabel(s.agent) : s.api;
    if (runnerId) card.appendChild(h("div", { class: "agent", text: runnerId + (s.model ? " \u00b7 " + s.model : "") }));
    else if (s.modelClass) card.appendChild(h("div", { class: "agent", text: "auto \u00b7 class:" + s.modelClass + (s.model ? " \u00b7 " + s.model : "") }));
    else if (s.model) card.appendChild(h("div", { class: "agent", text: "auto \u00b7 " + s.model }));
    if (s.blockKind === "workflow") { var subEl = subWorkflowCardBlock(s.stepId, p ? key : null); if (subEl) card.appendChild(subEl); }
    if (s.worktree) card.appendChild(h("div", { class: "worktree", title: s.worktree.cwd, text: "\u2387 " + s.worktree.branch }));
    if (s.dependsOn && s.dependsOn.length) card.appendChild(h("div", { class: "inputs", text: "inputs: " + s.dependsOn.join(", ") }));
    if (s.forEach) card.appendChild(h("div", { class: "inputs", text: "forEach: " + s.forEach }));
    if (s.loopTo) card.appendChild(h("div", { class: "inputs" },
      h("span", { class: "chip warn", text: "\u21ba " + s.loopTo + (s.maxIterations ? " \u00b7 max " + s.maxIterations : "") })
    ));
    if (s.item) card.appendChild(h("div", { class: "item", text: "item #" + s.item.index + ": " + truncate(s.item.value, 80) }));
    if (s.activity) card.appendChild(h("div", { class: "activity", text: s.activity }));

    if (s.approval) card.appendChild(renderApproval(p, s));
    if (s.humanInput) card.appendChild(renderHumanInput(p, s));

    // Live tail: the full streamed text (display-capped) in a scrollable pane
    // that follows the stream until the reader scrolls up; scrolling back to
    // the bottom re-engages following. Position survives re-renders via
    // S.tailScroll (see applyTailScroll).
    // 10k chars per card bounds total DOM size with many parallel steps
    // streaming at once; the drawer shows the untruncated output.
    var tailText = s.text ? tail(s.text, 10000) : "";
    if (tailText) {
      var tailEl = h("div", { class: "tail show", "data-key": key, text: tailText });
      tailEl.addEventListener("scroll", function () {
        var atBottom = tailEl.scrollTop + tailEl.clientHeight >= tailEl.scrollHeight - 4;
        S.tailScroll[key] = { follow: atBottom, top: tailEl.scrollTop };
      });
      // Selecting/copying tail text must not open the drill-in — but a plain
      // click (no selection) still does.
      tailEl.addEventListener("click", function (e) {
        var sel = window.getSelection();
        if (sel && String(sel).length > 0) e.stopPropagation();
      });
      card.appendChild(tailEl);
    }

    var metrics = h("div", { class: "metrics" });
    var hasMetrics = false;
    if (s.status === "running" && s.startedAt) {
      metrics.appendChild(h("span", { class: "elapsed", "data-since": String(s.startedAt), text: "\u23f1 " + fmtElapsed(Date.now() - s.startedAt) }));
      hasMetrics = true;
    }
    if (s.result) {
      var elapsedLabel = fmtElapsed(s.result.durationMs);
      if (elapsedLabel) metrics.appendChild(h("span", { text: elapsedLabel }));
      if (s.result.costUsd) metrics.appendChild(h("span", { text: "$" + s.result.costUsd.toFixed(4) }));
      var tokenLine = fmtTokenSummary(s.result.tokens);
      if (tokenLine) metrics.appendChild(h("span", { text: tokenLine }));
      hasMetrics = true;
    }
    if (s.cached) { metrics.appendChild(h("span", { class: "badge cached", text: "cached" })); hasMetrics = true; }
    if (s.edited) { metrics.appendChild(h("span", { class: "badge edited", text: "✎ edited" })); hasMetrics = true; }
    if (s.gate) { metrics.appendChild(h("span", { class: "badge " + (s.gate.passed ? "gate-pass" : "gate-block"), text: s.gate.passed ? "gate passed" : "gate blocked" })); hasMetrics = true; }
    if (hasMetrics) card.appendChild(metrics);

    // Mid-run steering: while the run is paused, steps that have not started
    // yet can have their prompt/command rewritten before resuming.
    if (stepEditableNow(s) && !isReadOnly()) {
      card.appendChild(h("div", { class: "edit-actions" },
        h("button", { class: "btn small", text: "✎ Edit step", title: "Rewrite this step before it runs", onClick: function (e) { e.stopPropagation(); openStepEditModal(s); } })
      ));
    }
    return card;
  }

  /** Whether the card's step can take a mid-run edit right now. */
  function stepEditableNow(s) {
    if (!S.runId || !S.runState || !S.runState.paused || S.runState.done) return false;
    if (s.status !== "pending" || s.parentStepId) return false;
    if (s.blockKind === "command") return true;
    if (["worker", "processor", "llm", "consolidator", "approval"].indexOf(s.blockKind) >= 0) return true;
    if (s.blockKind === "distributor" && s.agent) return true;
    return false;
  }

  /** The selected workflow's spec step by id (for prefilling the edit modal). */
  function findSpecStep(stepId) {
    var spec = effectiveSpec() || S.spec;
    if (!spec || !spec.phases) return null;
    for (var i = 0; i < spec.phases.length; i++) {
      var steps = spec.phases[i].steps || [];
      for (var j = 0; j < steps.length; j++) {
        if (steps[j].id === stepId) return steps[j];
      }
    }
    return null;
  }

  function openStepEditModal(s) {
    var isCmd = s.blockKind === "command";
    var specStep = findSpecStep(s.stepId);
    var edits = (S.runState && S.runState.editedSteps && S.runState.editedSteps[s.stepId]) || {};
    var current = isCmd
      ? (edits.cmd != null ? edits.cmd : (specStep && specStep.cmd) || "")
      : (edits.prompt != null ? edits.prompt : (specStep && specStep.prompt) || "");
    var ta = h("textarea", { class: "edit-step-text", rows: "10", spellcheck: "false" });
    ta.value = current;

    var agentBacked = !!(specStep && specStep.agent);
    var modelSel = null;
    var midPermsSel = null;
    var effortField = h("div", { class: "field" });
    var modelRow = null;
    var permsRow = null;
    if (agentBacked && !isCmd) {
      var agent = specStep.agent;
      var curModel = edits.model != null ? edits.model : specStep.model;
      var curEffort = edits.effort != null ? edits.effort : (specStep.effort || "");
      modelSel = ST.modals.selectEl(ST.modals.modelOptionsWith(agent, curModel), curModel);
      function renderMidEffort() {
        clear(effortField);
        var opts = ST.modals.effortOptions(agent, modelSel.value, curEffort);
        if (opts.length <= 1) { effortField._sel = null; return; }
        effortField.appendChild(h("label", { text: "Effort" }));
        var es = ST.modals.selectEl(opts, curEffort || "");
        effortField.appendChild(es);
        effortField._sel = es;
      }
      modelSel.addEventListener("change", renderMidEffort);
      renderMidEffort();
      modelRow = h("div", { class: "row2" },
        ST.modals.field("Model", modelSel, "Applies when this step runs (agent stays " + ST.agentUiLabel(agent) + ")."),
        effortField
      );
      // Clamp a not-yet-started step's sandbox while the run is paused — the
      // "wait, that one shouldn't be able to write" intervention.
      var curPerms = (s.permissions && s.permissions.profile) ||
        (typeof specStep.permissions === "string"
          ? specStep.permissions
          : (specStep.permissions && specStep.permissions.profile) || "");
      midPermsSel = ST.modals.selectEl(
        [
          { value: "", label: "(unchanged)" },
          { value: "read-only", label: "🔒 read-only" },
          { value: "edit", label: "✎ edit" },
          { value: "full", label: "⚡ full" },
          { value: "none", label: "clear (inherit / unrestricted)" }
        ],
        curPerms
      );
      permsRow = ST.modals.field("Permissions", midPermsSel,
        "Sandbox this step runs under. read-only is enforced by the agent CLI where it can be, and verified against the step's workspace afterwards.");
    }

    var body = h("div", null,
      h("div", { class: "hint", text: isCmd
        ? "Shell command the step will run when the workflow resumes."
        : "Prompt the step will run with when the workflow resumes ({{...}} templates still apply)." }),
      ta,
      modelRow,
      permsRow
    );
    var applyBtn = h("button", { class: "btn primary", text: "Apply edit" });
    var foot = h("div", { class: "mfoot" },
      h("button", { class: "btn", text: "Cancel", onClick: ST.modals.closeModal }),
      h("div", { class: "spacer" }),
      applyBtn
    );
    applyBtn.addEventListener("click", function () {
      var payload = { stepId: s.stepId };
      payload[isCmd ? "cmd" : "prompt"] = ta.value;
      if (modelSel) {
        payload.model = modelSel.value;
        var ef = effortField._sel ? effortField._sel.value : "";
        if (ef) payload.effort = ef;
      }
      if (midPermsSel && midPermsSel.value) {
        payload.permissions = midPermsSel.value === "none" ? "" : midPermsSel.value;
      }
      applyBtn.disabled = true;
      apiAuth("POST", "/api/runs/" + S.runId + "/edit-step", payload).then(function (r) {
        if (r.status === 200) {
          ST.modals.closeModal();
          setBanner("Step '" + s.stepId + "' edited — it runs with the new values after you resume.", "ok");
        } else if (r.status === 202) {
          ST.modals.closeModal();
          setBanner("Edit requested for '" + s.stepId + "' — awaiting the owning process; watch the run to confirm.", "info");
        } else {
          applyBtn.disabled = false;
          setBanner((r.body && r.body.error) || "Edit rejected.", "err");
        }
      }).catch(function () { applyBtn.disabled = false; });
    });
    ST.modals.openModal(ST.modals.modalShell("Edit step · " + s.stepId, (KIND_LABEL[s.blockKind] || s.blockKind) + " — applies when the step runs", body, foot, true));
  }

  // ---- step drill-in drawer ------------------------------------------------
  function openDetail(p, s, invoker, isOpen) {
    var sameDetail = S.detail &&
      S.detail.phaseId === p.phaseId &&
      S.detail.iteration === (p.iteration || 1) &&
      S.detail.stepId === s.stepId;
    if (sameDetail || isOpen) {
      closeDetail(bandKey(p));
      return;
    }
    S.detailFocusGeneration += 1;
    S.collapsedBandKey = null;
    S.detail = { phaseId: p.phaseId, iteration: p.iteration || 1, stepId: s.stepId };
    // Drilling in also picks the step: its band expands and the band's output
    // pane switches to it, so the drawer and the pane never disagree.
    S.selectedStepId = s.stepId;
    S.detailInvoker = invoker && typeof invoker.getAttribute === "function"
      ? invoker.getAttribute("data-detail-invoker")
      : null;
    S.detailFallback = "details:" + stepKey(p, s);
    S.detailFocusPending = true;
    S.drawerScroll = { follow: true, top: 0 };
    scheduleRender();
  }

  function closeDetail(collapsedKey) {
    if (collapsedKey) S.collapsedBandKey = collapsedKey;
    if (!S.detail) {
      S.selectedStepId = null;
      scheduleRender();
      return;
    }
    S.detail = null;
    // Releasing the drill-in releases the selection: the running band takes the
    // expanded slot back unless the click explicitly collapsed this band.
    S.selectedStepId = null;
    S.detailFocusPending = false;
    var invoker = S.detailInvoker;
    var fallback = S.detailFallback;
    var focusGeneration = ++S.detailFocusGeneration;
    S.detailInvoker = null;
    S.detailFallback = null;
    scheduleRender();
    // The triggering control is replaced by every canvas render. Restore
    // focus from its stable data attribute after that replacement is present,
    // unless another drawer was opened before this frame ran.
    requestAnimationFrame(function () {
      if (focusGeneration !== S.detailFocusGeneration || S.detail) return;
      if (!restoreDetailInvoker(invoker) && !restoreDetailInvoker(fallback)) focusDetailFallback();
    });
  }

  /** Current live data for the drilled-in step, straight from the folded state. */
  function findDetailStep() {
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

  /**
   * The right-hand drill-in drawer: full metadata (runner, worktree, timing,
   * cost, tokens, data flow) and the step's FULL output in a scrollable pane
   * that follows the stream while the step runs. Re-rendered from the folded
   * state on every event; the output pane's scroll position survives via
   * S.drawerScroll.
   */
  function renderDetail() {
    var drawer = document.getElementById("drawer");
    // During a run the drilled-in step renders as the right rail's step record
    // (Turn 2 · 02.4), not the floating drawer — hide the drawer shell so the
    // two never compete. S.detail keeps its role as the selection state.
    if (S.runId && S.detail) {
      drawer.classList.remove("show");
      drawer.setAttribute("aria-hidden", "true");
      clear(drawer);
      return;
    }
    var found = findDetailStep();
    if (!found) {
      drawer.classList.remove("show");
      drawer.setAttribute("aria-hidden", "true");
      clear(drawer);
      return;
    }
    var p = found.phase, s = found.step;
    // Streaming updates rebuild this drawer, dropping keyboard users onto the
    // page. Its controls carry data-focus-key and ride the shared
    // capture/restore in render() (st-boot.js) — this used to be a bespoke
    // data-drawer-focus round-trip local to this function.
    clear(drawer);
    drawer.classList.add("show");
    drawer.setAttribute("aria-hidden", "false");

    var kindEl = h("span", { class: "kind " + s.blockKind, text: KIND_LABEL[s.blockKind] || s.blockKind });
    var attempts = s.attempts || (s.result && s.result.attempts);
    var stateLabel = s.status + (s.cached ? " · cached" : "") + (s.result && s.result.skipped ? " · skipped" : "") + (attempts && attempts > 1 ? " · " + attempts + " tries" : "");
    var closeButton = h("button", {
      class: "x",
      "data-focus-key": "drawer-close",
      title: "Close step details (Esc)",
      "aria-label": "Close step details",
      onClick: closeDetail
    }, "×");
    drawer.appendChild(h("div", { class: "drawer-head" },
      h("span", { class: "sid", text: s.stepId }),
      kindEl,
      h("span", { class: "state " + s.status, text: stateLabel }),
      closeButton
    ));
    if (S.detailFocusPending) {
      S.detailFocusPending = false;
      closeButton.focus();
    }

    var meta = h("div", { class: "drawer-meta" });
    function row(label, value, cls) {
      if (value == null || value === "") return;
      var valEl = typeof value === "string"
        ? h("span", { class: "drawer-value" + (cls ? " " + cls : ""), text: value })
        : value;
      meta.appendChild(h("div", { class: "drawer-row" }, h("span", { class: "drawer-label", text: label }), valEl));
    }
    row("phase", p.title + (p.iteration && p.iteration > 1 ? " · iteration " + p.iteration : ""));
    var runnerId = s.agent ? ST.agentUiLabel(s.agent) : s.api;
    if (runnerId) row("runner", runnerId + (s.model ? " · " + s.model : "") + (s.effort ? " · " + s.effort : ""));
    else if (s.modelClass) row("runner", "auto · class:" + s.modelClass + (s.model ? " · " + s.model : ""));
    else if (s.model) row("runner", "auto · " + s.model);
    var drawerPerms = stepPermissions(s);
    if (drawerPerms) {
      var permsValue = h("span", { class: "drawer-value" });
      permsValue.appendChild(permissionBadge(drawerPerms));
      var permsNote = drawerPerms.violations && drawerPerms.violations.length
        ? " " + drawerPerms.violations.slice(0, 6).join(", ")
        : drawerPerms.enforcement
          ? " " + drawerPerms.enforcement + (drawerPerms.verified ? " · workspace verified" : "")
          : drawerPerms.verify
            ? " · verified after the run"
            : "";
      if (permsNote) permsValue.appendChild(document.createTextNode(permsNote));
      row("permissions", permsValue);
      if (drawerPerms.gaps && drawerPerms.gaps.length) {
        row("not enforced", drawerPerms.gaps.join(" · "), "warn");
      }
    }
    if (s.worktree) {
      row("worktree", "⎇ " + s.worktree.branch);
      row("worktree dir", s.worktree.cwd, "mono");
    } else if (s.cwd) {
      row("cwd", s.cwd, "mono");
    }
    if (s.startedAt) row("started", new Date(s.startedAt).toLocaleTimeString());
    if (s.status === "running" && s.startedAt) {
      row("elapsed", h("span", { class: "drawer-value elapsed", "data-since": String(s.startedAt), text: "⏱ " + fmtElapsed(Date.now() - s.startedAt) }));
    }
    if (s.result) {
      if (typeof s.result.durationMs === "number" && isFinite(s.result.durationMs)) {
        row("duration", fmtElapsed(s.result.durationMs));
      }
      if (s.result.costUsd) row("cost", "$" + s.result.costUsd.toFixed(4));
      var tokenLine = fmtTokenSummary(s.result.tokens);
      if (tokenLine) row("tokens", tokenLine);
      if (s.result.exitCode !== undefined) row("exit code", String(s.result.exitCode));
    } else if (s.usage) {
      // Still running: whatever the agent has reported so far, labelled as such.
      if (s.usage.costUsd) row("cost so far", "$" + s.usage.costUsd.toFixed(4));
      var liveTokenLine = fmtTokenSummary(s.usage.tokens);
      if (liveTokenLine) row("tokens so far", liveTokenLine);
    }
    if (s.dependsOn && s.dependsOn.length) row("inputs", s.dependsOn.join(", "));
    if (s.item) row("item", "#" + s.item.index + " from " + s.item.sourceStepId + ": " + truncate(s.item.value, 200));
    if (s.gate) row("gate", (s.gate.passed ? "passed" : "blocked") + (s.gate.target ? " → " + s.gate.target : ""));
    if (s.result && s.result.questions && s.result.questions.length) {
      s.result.questions.forEach(function (qa) {
        row("agent asked", qa.question);
        row("answered", qa.answer + (qa.by ? " (" + qa.by + ")" : ""));
      });
    }
    if (s.result && s.result.suppliedBy) row("supplied by", s.result.suppliedBy);
    if (s.result && s.result.sessionId) row("session", s.result.sessionId, "mono");
    if (s.result && s.result.resumedSessionId) row("continued session", s.result.resumedSessionId, "mono");
    if (s.status === "running" && s.activity) row("activity", s.activity);
    if (s.status === "error" && s.result && s.result.error) row("error", s.result.error, "err");
    // Interactive takeover: once the step is finished and left a worktree +
    // recorded session, a human can drop into that session from a terminal.
    if (s.status !== "running" && s.status !== "pending" && s.agent && s.result && s.result.sessionId && S.runId) {
      var takeoverCmd = "steamtrain workflow takeover " + S.runId + " " + s.stepId;
      row("take over", h("span", { class: "drawer-value mono" },
        h("code", { text: takeoverCmd }),
        h("button", { class: "btn small", text: "Copy", title: "Copy the takeover command — it resumes this step's agent session interactively in its worktree", onClick: function () {
          if (navigator.clipboard) navigator.clipboard.writeText(takeoverCmd).catch(function () {});
        } })
      ));
    }
    drawer.appendChild(meta);

    var view = liveViewStep(s);
    var body = liveBody(view);
    var followNote = h("span", {
      class: "drawer-follow" + (S.drawerScroll.follow ? " on" : ""),
      text: (view.status === "running" || s.status === "running")
        ? (S.drawerScroll.follow ? "following" : "paused — scroll to bottom to follow") : ""
    });
    var copyBtn = h("button", {
      class: "btn small",
      "data-focus-key": "drawer-copy",
      text: "Copy", title: "Copy the full output", onClick: function () {
      if (navigator.clipboard) navigator.clipboard.writeText(body).catch(function () {});
    } });
    var outLabel = view.stepId === s.stepId
      ? ("output" + (body ? " · " + body.length.toLocaleString() + " chars" : ""))
      : ("output · " + view.stepId + (body ? " · " + body.length.toLocaleString() + " chars" : ""));
    drawer.appendChild(h("div", { class: "drawer-outhead" },
      h("span", { class: "drawer-outlabel", text: outLabel }),
      followNote,
      copyBtn
    ));
    var pre = h("pre", { class: "drawer-output" + (s.status === "error" || view.status === "error" ? " err" : "") });
    pre.textContent = body || "no output yet";
    pre.addEventListener("scroll", function () {
      var atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 4;
      S.drawerScroll = { follow: atBottom, top: pre.scrollTop };
      followNote.className = "drawer-follow" + (atBottom ? " on" : "");
      if (view.status === "running" || s.status === "running") {
        followNote.textContent = atBottom ? "following" : "paused — scroll to bottom to follow";
      }
    });
    drawer.appendChild(pre);
    // Position after layout: follow pins to the newest output.
    pre.scrollTop = S.drawerScroll.follow ? pre.scrollHeight : S.drawerScroll.top;
  }

  function renderApproval(p, s) {
    var a = s.approval;
    // Historical cards (st-modals.js's static history view) call this with no
    // live phase instance; only a live re-render needs the phase/iteration
    // qualifier to keep loop-back iterations distinct (see stepKey).
    var key = p ? stepKey(p, s) : s.stepId;
    var box = h("div", { class: "approval" + (a.pending ? " pending" : (a.approved ? " approved" : " rejected")) });
    if (a.reviewStepId) box.appendChild(h("div", { class: "approval-review", text: "reviewing: " + a.reviewStepId }));
    if (a.message) box.appendChild(h("div", { class: "approval-msg", text: a.message }));
    if (a.output) box.appendChild(h("div", { class: "approval-output", text: tail(a.output, 600) }));
    if (a.diff && a.diff.files && a.diff.files.length) {
      box.appendChild(h("div", { class: "approval-diff",
        text: a.diff.files.length + " file" + (a.diff.files.length === 1 ? "" : "s") +
          " \u00b7 +" + a.diff.additions + " -" + a.diff.deletions }));
      // The approval payload carries the reviewed step's capped unified patch
      // (see APPROVAL_DIFF_CAP); offer it as a collapsed graphical diff.
      if (a.diff && a.diff.patch && typeof window.SteamtrainDiff !== "undefined") {
        // Persisted in S.approvalDiffOpen (keyed by stepKey — phase:iteration:
        // stepId — not just a local closure flag: the run's throughput tick
        // schedules a full re-render every 2s for as long as the run is live,
        // which would otherwise rebuild this box from scratch and snap an
        // opened diff shut. Keying by stepKey rather than bare stepId keeps a
        // loop-back's iteration 2 from inheriting iteration 1's open/closed
        // state for the same step id.
        var diffOpen = !!S.approvalDiffOpen[key];
        var diffBody = h("div", { class: "approval-diff-body", style: diffOpen ? "" : "display:none" });
        if (a.diff.patch.indexOf("[truncated ") >= 0) {
          diffBody.appendChild(h("div", { class: "hist-wt-diff-truncated",
            text: "Diff truncated at 20 KB — the engine caps approval patches; the visible part is shown." }));
        }
        diffBody.appendChild(window.SteamtrainDiff.renderPatch(a.diff.patch));
        var diffToggle = h("button", { class: "btn small approval-diff-toggle", text: diffOpen ? "Hide diff" : "View diff", "data-focus-key": "approval-diff:" + key, onClick: function () {
          var showing = diffBody.style.display !== "none";
          S.approvalDiffOpen[key] = showing ? false : true;
          diffBody.style.display = showing ? "none" : "";
          diffToggle.textContent = showing ? "View diff" : "Hide diff";
        } });
        box.appendChild(diffToggle);
        box.appendChild(diffBody);
      }
    }
    if (a.pending) {
      if (isReadOnly()) {
        box.appendChild(h("div", { class: "approval-decision", text: "⏳ waiting for approval (read-only view)" }));
      } else {
        // data-focus-key: this box is rebuilt by every render (2s while the run
        // is live), which would otherwise drop a keyboard user off whichever
        // decision button they had tabbed to. See ST.captureFocus.
        var buttons = h("div", { class: "approval-actions" },
          h("button", { class: "btn approve", text: "Approve", "data-focus-key": "approve:" + key, onClick: function () { resolveApproval(s.stepId, true); } }),
          h("button", { class: "btn reject", text: "Reject", "data-focus-key": "reject:" + key, onClick: function () { resolveApproval(s.stepId, false); } })
        );
        box.appendChild(buttons);
      }
    } else {
      var who = a.by ? " (" + a.by + ")" : "";
      box.appendChild(h("div", { class: "approval-decision", text: (a.approved ? "\u2713 approved" : "\u2717 rejected") + who + (a.note ? " \u2014 " + a.note : "") }));
    }
    return box;
  }

  /**
   * A pending human-input request (a `human` step or an agent's clarifying
   * question) rendered as an answer form: pick-one buttons when the step
   * declares choices, a JSON textarea (with a local parse check) when it
   * declares an output schema, a plain textarea otherwise. A rejected answer
   * re-renders with the engine's validation error.
   */
  function renderHumanInput(p, s) {
    var q = s.humanInput;
    // Same historical-vs-live distinction as renderApproval: only a live
    // re-render needs the phase/iteration qualifier (see stepKey).
    var key = p ? stepKey(p, s) : s.stepId;
    var box = h("div", { class: "human-input" + (q.pending ? " pending" : (q.canceled ? " canceled" : " answered")) });
    var label = q.origin === "agent-question" ? "agent question" : "input needed";
    box.appendChild(h("div", { class: "human-input-origin", text: label }));
    if (q.prompt) box.appendChild(h("div", { class: "human-input-prompt", text: q.prompt }));
    if (q.retryError) box.appendChild(h("div", { class: "human-input-error", text: "previous answer rejected: " + q.retryError }));
    if (!q.pending) {
      if (q.canceled) {
        box.appendChild(h("div", { class: "human-input-decision", text: "✗ no answer" + (q.by ? " (" + q.by + ")" : "") }));
      } else {
        box.appendChild(h("div", { class: "human-input-decision", text: "✓ answered" + (q.by ? " by " + q.by : "") + (q.value ? ": " + truncate(q.value, 200) : "") }));
      }
      return box;
    }
    if (isReadOnly()) {
      box.appendChild(h("div", { class: "human-input-decision", text: "✎ waiting for input (read-only view)" }));
      return box;
    }
    // Stop card-level click-through so typing/clicking in the form never
    // opens the drill-in drawer.
    box.addEventListener("click", function (e) { e.stopPropagation(); });
    if (q.choices && q.choices.length) {
      var choiceWrap = h("div", { class: "human-input-choices" });
      q.choices.forEach(function (choice, idx) {
        choiceWrap.appendChild(h("button", {
          class: "btn choice", text: choice,
          // Index, not the label: choice text can repeat, the position can't.
          "data-focus-key": "human-choice:" + key + ":" + idx,
          onClick: function () { submitHumanInput(s.stepId, choice); }
        }));
      });
      box.appendChild(choiceWrap);
      return box;
    }
    var isJson = Boolean(q.outputSchema);
    var ta = h("textarea", {
      class: "human-input-text",
      rows: isJson ? "5" : "3",
      placeholder: isJson ? "JSON matching the step's output schema…" : "Type your answer…",
      spellcheck: "false",
      // S.humanInputDraft below preserves the TEXT across the 2s re-render;
      // this preserves the focus and caret, without which the reader's next
      // keystroke would land nowhere. See ST.captureFocus / ST.restoreFocus.
      "data-focus-key": "human-input:" + key
    });
    // Restore whatever draft survived a prior re-render (see S.humanInputDraft).
    // Keyed by stepKey rather than bare stepId so a loop-back's iteration 2
    // never pre-fills with a draft left over from iteration 1's same step id.
    ta.value = S.humanInputDraft[key] || "";
    ta.addEventListener("input", function () { S.humanInputDraft[key] = ta.value; });
    var hintText = isJson ? "This step expects JSON (validated against its schema)." : "";
    var errEl = h("div", { class: "human-input-error", style: "display:none" });
    var send = h("button", { class: "btn approve", text: "Answer", "data-focus-key": "human-send:" + key, onClick: function () {
      var value = ta.value;
      if (!value.trim()) { errEl.textContent = "answer must not be empty"; errEl.style.display = "block"; return; }
      if (isJson) {
        // Cheap local guard: malformed JSON never even reaches the engine's
        // re-ask loop. Schema validation stays server-side (single source).
        try { JSON.parse(value); } catch (e) { errEl.textContent = "not valid JSON: " + e.message; errEl.style.display = "block"; return; }
      }
      errEl.style.display = "none";
      delete S.humanInputDraft[key];
      submitHumanInput(s.stepId, value);
    } });
    // Enter submits a single-line answer; Shift+Enter makes a newline.
    ta.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey && !isJson) { e.preventDefault(); send.click(); }
    });
    box.appendChild(ta);
    if (hintText) box.appendChild(h("div", { class: "hint", text: hintText }));
    box.appendChild(errEl);
    box.appendChild(h("div", { class: "human-input-actions" }, send));
    return box;
  }

  function submitHumanInput(stepId, value) {
    if (!S.runId) return;
    var body = { stepId: stepId, value: value };
    var pending = (S.runState && S.runState.pendingInputs) || [];
    var match = pending.find(function (p) { return p.stepId === stepId; });
    if (match && typeof match.iteration === "number") body.iteration = match.iteration;
    apiAuth("POST", "/api/runs/" + S.runId + "/input", body)
      .then(function (r) {
        if (r && r.status && r.status >= 400) setBanner("Could not record the answer.", "err");
      })
      .catch(function () {});
  }

  function resolveApproval(stepId, approved) {
    if (!S.runId) return;
    var body = { stepId: stepId, approved: approved };
    // Send the iteration of the matching pending checkpoint so a loop that
    // re-runs the same approval step id resolves the intended pass. The engine
    // awaits each checkpoint's decision before the loop advances, so at most one
    // checkpoint per stepId is ever pending — find()'s first match is the right
    // one — but threading iteration keeps the request unambiguous regardless.
    var pending = (S.runState && S.runState.pendingApprovals) || [];
    var match = pending.find(function (p) {
      return p.stepId === stepId;
    });
    if (match && typeof match.iteration === "number") body.iteration = match.iteration;
    apiAuth("POST", "/api/runs/" + S.runId + "/approval", body)
      .then(function (r) {
        if (r && r.status && r.status >= 400) setBanner("Could not record approval decision.", "err");
      })
      .catch(function () {});
  }

  /**
   * The run header's readouts: a two-segment progress bar (finished / in
   * flight), the step count, and the live cost + token ticker.
   */
  function updateProgress() {
    var steps = [];
    if (S.runState) {
      S.runState.phases.forEach(function (p) {
        p.steps.forEach(function (s) { steps.push(s); });
      });
    }
    var total = steps.length;
    var doneN = 0, runningN = 0;
    steps.forEach(function (s) {
      if (s.status === "done" || s.status === "error") doneN++;
      else if (s.status === "running") runningN++;
    });
    document.getElementById("progressBar").style.width =
      (total ? (doneN / total) * 100 : 0).toFixed(2) + "%";
    document.getElementById("progressLive").style.width =
      (total ? (runningN / total) * 100 : 0).toFixed(2) + "%";
    var paused = Boolean(S.runState && S.runState.paused && !S.runState.done);
    document.getElementById("progressText").textContent =
      doneN + " / " + total + " steps" +
      (paused ? (runningN ? " · ⏸ pausing (" + runningN + " finishing)" : " · ⏸ paused") : "");
    updatePauseButton();
    updateRunPill();

    // Live cost/token ticker + budget badge.
    // Finished steps bill from their result; running ones contribute whatever
    // they have reported so far, which is the point of a *live* ticker.
    var cost = 0, tokens = emptyTokens();
    steps.forEach(function (s) {
      var source = s.result || s.usage;
      if (!source) return;
      if (source.costUsd) cost += source.costUsd;
      addTokensInto(tokens, source.tokens);
    });
    var ticker = document.getElementById("costTicker");
    if (ticker) {
      var bits = [];
      if (cost > 0) bits.push("$" + cost.toFixed(4));
      var tk = totalTokens(tokens);
      if (tk > 0) bits.push(fmtTokens(tk) + " tok");
      var budget = S.runState && S.runState.budget;
      if (budget) bits.push("⚠ budget $" + budget.limitUsd.toFixed(4) + " reached");
      ticker.textContent = bits.join(" · ");
      ticker.className = "steps cost-ticker" + (budget ? " over-budget" : "");
    }
  }

  /**
   * The header breadcrumb's run-state pill and the muted context note beside
   * it. Running/paused/complete while a run is attached; a grey "idle" pill
   * with a "last run …" annotation (from the recent-runs list the plan editor
   * already loads) when the cockpit is at rest. Hidden while a full-page
   * surface (Runs/Settings) is up — those pages state their own context.
   */
  function updateRunPill() {
    var pill = document.getElementById("runPill");
    if (!pill) return;
    var note = document.getElementById("contextNote");
    var hide = function () {
      pill.style.display = "none";
      clear(pill);
      if (note) { note.style.display = "none"; clear(note); }
    };
    if (S.page) { hide(); return; }
    if (!(S.runState && S.runState.started)) {
      if (!S.selected) { hide(); return; }
      clear(pill);
      pill.className = "status-pill idle";
      pill.style.display = "inline-flex";
      pill.appendChild(h("span", { class: "dot", "aria-hidden": "true" }));
      pill.appendChild(document.createTextNode("idle"));
      if (note) {
        clear(note);
        var last = S.recentRuns && S.recentRuns.length ? S.recentRuns[0] : null;
        if (last) {
          var ok = last.status !== "error" && last.status !== "canceled" && last.status !== "budget-exceeded";
          note.textContent = "last run " + relTime(last.startedAt) + " · " + (ok ? "ok" : last.status);
          note.style.display = "";
        } else {
          note.style.display = "none";
        }
      }
      return;
    }
    if (note) { note.style.display = "none"; clear(note); }
    var done = Boolean(S.runState.done);
    clear(pill);
    pill.className = "status-pill " + (done ? "complete" : "running");
    pill.style.display = "inline-flex";
    pill.appendChild(h("span", { class: "dot", "aria-hidden": "true" }));
    pill.appendChild(document.createTextNode(
      done ? "complete" : (S.runState.paused ? "paused" : "running")
    ));
  }

  /** Show/hide the run header's metrics strip (clock, progress, run controls). */
  function showRunMetrics(show) {
    var el = document.getElementById("runMetrics");
    if (el) el.style.display = show ? "flex" : "none";
  }

  // ---- prompt history (run-input ↑/↓ recall, mirroring the TUI) -------------
  var PROMPT_HISTORY_KEY = "steamtrain.promptHistory.v1";
  var PROMPT_HISTORY_MAX = 50;
  // Non-null while the input is showing a recalled entry: { index, draft }.
  var promptBrowse = null;

  function loadPromptHistory() {
    try {
      var parsed = JSON.parse(localStorage.getItem(PROMPT_HISTORY_KEY) || "[]");
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(function (item) { return typeof item === "string"; });
    } catch (e) { return []; }
  }

  function recordPromptHistory(input) {
    var text = String(input || "").trim();
    if (!text) return;
    try {
      var list = loadPromptHistory().filter(function (item) { return item !== text; });
      list.unshift(text);
      localStorage.setItem(PROMPT_HISTORY_KEY, JSON.stringify(list.slice(0, PROMPT_HISTORY_MAX)));
    } catch (e) { /* storage blocked or full — history is best-effort */ }
  }

  /**
   * ↑ recalls older inputs, ↓ walks back toward (and finally restores) the
   * unsent draft. ↑ only captures the key when the caret is at the start of
   * the textarea (or it's empty), so arrows still navigate multi-line text.
   * Returns true when the key was consumed.
   */
  function handlePromptHistoryKey(el, older) {
    var history = loadPromptHistory();
    if (history.length === 0) return false;
    if (promptBrowse === null) {
      if (!older) return false;
      var caretAtStart = el.selectionStart === 0 && el.selectionEnd === 0;
      if (el.value !== "" && !caretAtStart) return false;
      promptBrowse = { index: -1, draft: el.value };
    }
    var next = promptBrowse.index + (older ? 1 : -1);
    if (next >= history.length) return true; // already at the oldest entry
    if (next < 0) {
      el.value = promptBrowse.draft;
      promptBrowse = null;
      return true;
    }
    promptBrowse.index = next;
    el.value = history[next];
    el.setSelectionRange(el.value.length, el.value.length);
    return true;
  }

  // ---- running -------------------------------------------------------------
  /**
   * Run opens the launch sheet (Turn 2): never blind. The sheet confirms what
   * executes, then calls launchRun() with the configured run spec.
   */
  function startRun() {
    if (isReadOnly()) { setBanner("This session is read-only — viewing only.", "info"); return; }
    ST.modals.openLaunchSheet();
  }

  var LAUNCH_RECONCILE_WINDOW_MS = 30 * 1000;

  /**
   * A POST can commit the run and still reject in the browser if its response
   * is lost. Only reconcile a recent, still-live run with the exact launch
   * identity; never attach an older or completed run with the same prompt.
   */
  function findRecentLiveLaunch(runs, workflow, input, launchedAt) {
    var expectedInput = input;
    var matches = (runs || []).filter(function (run) {
      return run &&
        run.external !== true &&
        (run.status === "running" || run.status === "queued") &&
        run.workflow === workflow &&
        run.input === expectedInput &&
        typeof run.startedAt === "number" &&
        run.startedAt >= launchedAt - LAUNCH_RECONCILE_WINDOW_MS;
    });
    matches.sort(function (a, b) { return b.startedAt - a.startedAt; });
    return matches[0] || null;
  }

  function reconcileLaunch(workflow, input, launchedAt) {
    return api("GET", "/api/runs").then(function (r) {
      if (!r || r.status !== 200 || !r.body || !Array.isArray(r.body.runs)) return null;
      return findRecentLiveLaunch(r.body.runs, workflow, input, launchedAt);
    });
  }

  function showLaunchFailure() {
    setBanner("could not start run: network error", "err");
    setRunning(false);
    ST.render();
  }

  /**
   * The actual launch, parameterized by the launch sheet. `opts.spec` is the
   * full run spec (draft + deselections + budget cap); `opts.freshCache`
   * ignores the step cache; `opts.detach` hands the run to a background
   * process once it is live. Without opts this degrades to the pre-sheet
   * behavior (composer input, reuse cache, staged session overrides).
   */
  function launchRun(opts) {
    opts = opts || {};
    if (isReadOnly()) { setBanner("This session is read-only — viewing only.", "info"); return; }
    var input = document.getElementById("input").value.trim();
    if (!input) { setBanner("enter some input first", "info"); return; }
    recordPromptHistory(input);
    // Validate param fields before submission (even when the panel is collapsed).
    if (!validateParamsForm()) return;
    // A pending history-enriched plan must never replace the live run canvas.
    S.planRequest += 1;
    // A freshly launched run is web-owned and in-process, so it can be detached.
    S.runExternal = false;
    S.runDetached = false;
    S.runState = SteamtrainReducer.workflowStateFromSpec(opts.spec || effectiveSpec() || S.spec);
    S.tailScroll = {}; S.stepListScroll = {}; S.drawerScroll = { follow: true, top: 0 }; S.approvalDiffOpen = {}; S.humanInputDraft = {}; S.subWorkflowOpen = {};
    S.arrivalEnter = false;
    S.selectedStepId = null; S.collapsedBandKey = null;
    S.arrivalCtaFocused = false;
    S.arrivalOutputStep = null;
    S.arrivalMenuOpen = false;
    S.endedAt = 0;
    setBanner("", "");
    showRunMetrics(true);
    ST.render();
    // Default false matches the launch sheet's reuseCache:true default;
    // callers pass freshCache:true to ignore (and clear) the step cache.
    var payload = {
      workflow: S.selected,
      input: input,
      freshCache: opts.freshCache === true
    };
    // Launch-sheet options with server-side effects (02.2): fresh worktrees
    // discards the previous run's retained trees before starting; maxParallel
    // overrides the configured step concurrency for this run only.
    if (opts.freshWorktrees === true) payload.freshWorktrees = true;
    if (typeof opts.maxParallel === "number" && opts.maxParallel > 0) payload.maxParallel = opts.maxParallel;
    var params = collectParams();
    if (params) payload.params = params;
    if (opts.spec) {
      // The launch sheet's configured spec: the plan draft with deselected
      // steps marked skipped and any budget cap stamped — run as-is, unsaved.
      payload.spec = opts.spec;
    } else if (ST.plan && ST.plan.draftIfDirty && ST.plan.draftIfDirty()) {
      payload.spec = ST.plan.buildRunSpec({});
    } else if (workflowHasStaged(S.stagedOverrides[S.selected])) {
      payload.overrides = S.stagedOverrides[S.selected];
    }
    // Blocked-but-re-routable workflow: run with what's ready, this run only.
    var listItem = wfListItem(S.selected);
    var rerouted = Boolean(listItem && listItem.blocked && listItem.reroute);
    if (rerouted) payload.reroute = true;
    var launchedAt = Date.now();
    apiAuth("POST", "/api/runs", payload)
      .then(function (r) {
        if (r.status !== 201) {
          setBanner(r.body.error || "could not start run", "err");
          setRunning(false);
          ST.render();
          return;
        }
        // Announce a re-route only when the server actually applied one — the
        // catalog annotation we act on can be stale relative to staged edits.
        var rr = r.body.reroute;
        if (rr) {
          setBanner("Re-routed " + rr.steps + " step" + (rr.steps === 1 ? "" : "s") + " (" +
            rr.blockedAgents.map(ST.agentUiLabel).join(", ") + ") to " + ST.agentUiLabel(rr.agent) + " · " + (rr.modelName || rr.model) +
            " for this run.", "info");
        }
        S.runId = r.body.runId;
        setRunDeepLink(S.runId);
        setRunning(true);
        S.startedAt = Date.now();
        startTimer();
        openStream(S.runId);
        ST.render();
        if (opts.detach) detachRun();
      })
      .catch(function () {
        if (S.runId) return;
        reconcileLaunch(payload.workflow, input, launchedAt)
          .then(function (run) {
            if (run) {
              attachRun(run);
              return;
            }
            showLaunchFailure();
          })
          .catch(showLaunchFailure);
      });
  }

  function openStream(runId) {
    if (S.es) S.es.close();
    // Pre-flight auth check: EventSource can't handle 401 (it silently retries).
    api("GET", "/api/workflows").then(function (r) {
      if (r.status === 401) { showReauthOverlay(); return; }
      var es = new EventSource("/api/runs/" + runId + "/stream");
      S.es = es;
      es.onmessage = function (m) {
        var frame;
        try { frame = JSON.parse(m.data); } catch (e) { return; }
        if (frame.type === "event") {
          if (S.queuedBanner) { S.queuedBanner = false; setBanner("", ""); }
          reduce(frame.event);
          ST.instruments.onEvent(frame.event);
          scheduleRender();
        }
        else if (frame.type === "queued") {
          // Waiting for a shared run-queue slot (maxParallelRuns); not terminal.
          S.queuedBanner = true;
          setBanner("Queued — position " + frame.position + " (" + frame.running + "/" + frame.limit + " run slots busy)…", "info");
        }
        else if (frame.type === "detaching") {
          // Mid-run detach requested: in-flight steps are finishing before the
          // handoff. Not terminal — the `detached` frame follows.
          setBanner("✈ Detaching — finishing in-flight work, then handing this run to a background process…", "info");
        }
        else if (frame.type === "detached") {
          // The run is now an independent background process under the same id.
          // Reconnect to it (as an external run) so we keep tailing it live.
          es.close(); S.es = null;
          S.runExternal = true;
          S.runDetached = true;
          setRunning(true);
          setBanner("✈ Detached — this run now runs in a background process" + (frame.pid ? " (pid " + frame.pid + ")" : "") + "; it keeps going if you close this page.", "ok");
          openStream(frame.runId || S.runId);
          pollLiveRuns();
        }
        else if (frame.type === "status") {
          es.close(); S.es = null; setRunning(false); stopTimer();
          // Terminal frame: stop the rail's 2s sampler here too. A run that
          // ends without a final workflow_done reaching the client would
          // otherwise keep the render loop alive until the user navigates away.
          if (ST.instruments) ST.instruments.stopThroughput();
          S.queuedBanner = false;
          S.endedAt = Date.now();
          // Only outcomes the arrival page cannot state for itself get a
          // banner. "Run failed." / "Run complete." said nothing the page's own
          // status pill and root-cause block do not say better, and stacking
          // them put two verdicts above one run.
          if (frame.status === "canceled") setBanner("Run canceled.", "info");
          else if (frame.status === "budget-exceeded") setBanner("Run stopped: cost budget reached. Raise maxCostUsd and re-run to resume.", "err");
          else setBanner("", "");
          S.arrivalEnter = true;
          ST.render();
          pollLiveRuns();
        }
      };
      es.onerror = function () {
        if (S.runState && S.runState.done) return;
        // The browser will retry automatically; surface a hint if it persists.
      };
    });
  }

  function cancelRun() {
    if (isReadOnly() || !S.runId) return;
    apiAuth("POST", "/api/runs/" + S.runId + "/cancel");
  }

  /**
   * Hand the streamed (web-owned) run off to a background process so this page
   * can close without stopping it. The switch to the now-independent run is
   * driven by the `detached` SSE frame (see openStream); here we just request
   * it and reflect "detaching" while in-flight steps finish.
   */
  function detachRun() {
    if (isReadOnly() || !S.runId || S.runExternal || S.runDetached) return;
    var btn = document.getElementById("detachBtn");
    if (btn) btn.disabled = true;
    setBanner("✈ Detaching — finishing in-flight work, then handing this run to a background process…", "info");
    apiAuth("POST", "/api/runs/" + S.runId + "/detach")
      .then(function (r) {
        if (r.status >= 400) {
          if (btn) btn.disabled = false;
          setBanner("Could not detach the run" + (r.body && r.body.error ? ": " + r.body.error : "."), "err");
        }
      })
      .catch(function () {
        if (btn) btn.disabled = false;
        setBanner("Could not detach the run: network error.", "err");
      });
  }

  /**
   * The Detach button only applies to a web-owned, in-process run: an already
   * external/detached run is independent, and read-only sessions can't steer.
   */
  function updateDetachButton() {
    var btn = document.getElementById("detachBtn");
    if (!btn) return;
    var running = Boolean(S.runId) && !(S.runState && S.runState.done);
    var show = running && !isReadOnly() && !S.runExternal && !S.runDetached;
    btn.style.display = show ? "block" : "none";
    if (show) btn.disabled = false;
  }

  /** Toggle mid-run pause/resume for the streamed run (own or attached). */
  function togglePauseRun() {
    if (isReadOnly() || !S.runId) return;
    var paused = Boolean(S.runState && S.runState.paused);
    var verb = paused ? "resume" : "pause";
    apiAuth("POST", "/api/runs/" + S.runId + "/" + verb)
      .then(function (r) {
        if (r.status >= 400) { setBanner("Could not " + verb + " the run.", "err"); return; }
        if (!paused) setBanner("Pause requested — in-flight steps finish, nothing new starts. Pending step cards become editable.", "info");
        else setBanner("", "");
      })
      .catch(function () {});
  }

  /** Keep the pause button's label in sync with the engine-acknowledged state. */
  function updatePauseButton() {
    var btn = document.getElementById("pauseBtn");
    if (!btn) return;
    var paused = Boolean(S.runState && S.runState.paused);
    btn.textContent = paused ? "▶ Resume" : "⏸ Pause";
    btn.className = paused ? "rbtn primary" : "rbtn";
  }

  function setRunning(running) {
    var ro = isReadOnly();
    document.getElementById("pauseBtn").style.display = (running && !ro) ? "block" : "none";
    document.getElementById("detachBtn").style.display =
      (running && !ro && !S.runExternal && !S.runDetached) ? "block" : "none";
    document.getElementById("cancelBtn").style.display = (running && !ro) ? "block" : "none";
    updateDetachButton();
    document.getElementById("input").disabled = running || ro;
    var actions = document.getElementById("wfActions");
    if (actions) actions.style.display = (running || ro || !S.selected) ? "none" : "flex";
    showRunMetrics(Boolean(running));
    document.body.classList.toggle("run-live", Boolean(running));
    updatePauseButton();
    updateRunPill();
  }

  function startTimer() {
    stopTimer();
    S.timer = setInterval(function () {
      document.getElementById("elapsed").textContent = fmtElapsed(Date.now() - S.startedAt);
      // Tick every per-step live timer (cards + drawer) in the same pass.
      updateLiveTimers();
    }, 200);
  }
  function stopTimer() { if (S.timer) { clearInterval(S.timer); S.timer = null; } }

  function setBanner(text, kind) {
    var b = document.getElementById("banner");
    if (!text) { b.className = "banner"; b.textContent = ""; return; }
    b.className = "banner show " + (kind === "ok" ? "ok" : kind === "err" ? "err" : "info");
    b.textContent = text;
  }

  // ---- staged overrides ---------------------------------------------------
  function sessionOverridesEmpty(o) {
    if (!o) return true;
    var hasSteps = o.steps && Object.keys(o.steps).length > 0;
    return !(hasSteps || o.stepTimeoutSec !== undefined || o.workflowTimeoutSec !== undefined);
  }

  function workflowHasStaged(o) {
    return !sessionOverridesEmpty(o);
  }

  function hasStaged() {
    return S.selected && workflowHasStaged(S.stagedOverrides[S.selected]);
  }

  function hasAnyStaged() {
    for (var k in S.stagedOverrides) {
      if (workflowHasStaged(S.stagedOverrides[k])) return true;
    }
    return false;
  }

  function effectiveSpec() {
    if (!S.spec) return null;
    var staged = S.stagedOverrides[S.selected];
    if (sessionOverridesEmpty(staged)) return S.spec;
    // Use the shared, namespace-aware override applier so a staged patch keyed
    // `<workflowStepId>::<childStepId>` routes onto the sub-workflow call step's
    // own `overrides` (cascading to arbitrary depth) — identical to the engine.
    if (SteamtrainReducer.applyWorkflowSessionOverrides) {
      return SteamtrainReducer.applyWorkflowSessionOverrides(S.spec, staged);
    }
    var spec = JSON.parse(JSON.stringify(S.spec));
    if (staged.stepTimeoutSec !== undefined) {
      if (staged.stepTimeoutSec === null) delete spec.stepTimeoutSec;
      else spec.stepTimeoutSec = staged.stepTimeoutSec;
    }
    if (staged.workflowTimeoutSec !== undefined) {
      if (staged.workflowTimeoutSec === null) delete spec.workflowTimeoutSec;
      else spec.workflowTimeoutSec = staged.workflowTimeoutSec;
    }
    var steps = staged.steps || {};
    spec.phases.forEach(function (p) {
      p.steps.forEach(function (st) {
        var patch = steps[st.id];
        if (patch) {
          for (var k in patch) {
            if (patch[k] === null) delete st[k]; else st[k] = patch[k];
          }
        }
      });
    });
    return spec;
  }

  /** Base (catalog) spec for a sub-workflow, for describeSubWorkflow in the browser. */
  function resolveChild(name) {
    return (S.childSpecs && S.childSpecs[name]) || null;
  }

  /** Resolved sub-workflow view for a `workflow` call step (effective, overrides applied). */
  function subWorkflowView(step) {
    if (!SteamtrainReducer.describeSubWorkflow) return null;
    return SteamtrainReducer.describeSubWorkflow(step, resolveChild);
  }

  /** Find the (effective) `workflow` call step with the given id in the current spec. */
  function findWorkflowStep(stepId) {
    var spec = effectiveSpec() || S.spec;
    if (!spec) return null;
    // Fan-out children are `id[n]` at runtime; the catalog step is still `id`.
    var baseId = typeof stepId === "string" ? stepId.replace(/\[\d+\]$/, "") : stepId;
    for (var i = 0; i < spec.phases.length; i++) {
      var steps = spec.phases[i].steps || [];
      for (var j = 0; j < steps.length; j++) {
        if ((steps[j].id === stepId || steps[j].id === baseId) && steps[j].kind === "workflow") {
          return steps[j];
        }
      }
    }
    return null;
  }

  /**
   * Expandable "what runs inside" block for a sub-workflow step's pipeline card:
   * a rollup summary line, then a nested list of the child steps with the model
   * that actually runs each one (overrides applied) and an override marker.
   *
   * `key` is the live step's stepKey (null for the static history view). The
   * open/closed state has to be persisted on S, keyed by it: this <details> is
   * rebuilt by every render, and the throughput tick schedules one every 2s for
   * the life of the run, so a purely-DOM open state would snap shut two seconds
   * after the reader opened it. Same pattern as S.approvalDiffOpen.
   */
  function subWorkflowCardBlock(stepId, key) {
    var step = findWorkflowStep(stepId);
    if (!step) return null;
    var view = subWorkflowView(step);
    if (!view) return null;
    var det = h("details", { class: "subwf" });
    if (key) {
      det.open = Boolean(S.subWorkflowOpen[key]);
      det.addEventListener("toggle", function () { S.subWorkflowOpen[key] = det.open; });
    }
    var rollup = SteamtrainReducer.subWorkflowRollup ? SteamtrainReducer.subWorkflowRollup(view) : ("→ " + step.workflow);
    var summary = h("summary", { class: "subwf-sum", title: rollup });
    summary.appendChild(h("span", { class: "subwf-label", text: "inside" }));
    summary.appendChild(h("span", { class: "subwf-name", text: view.workflow }));
    if (view.resolved) {
      summary.appendChild(h("span", {
        class: "subwf-count",
        text: view.stepCount + " step" + (view.stepCount === 1 ? "" : "s")
      }));
      var targets = Array.isArray(view.targets) ? view.targets : [];
      if (targets.length) {
        var shownTargets = targets.slice(0, 2).join(", ");
        if (targets.length > 2) shownTargets += ", +" + (targets.length - 2);
        summary.appendChild(h("span", {
          class: "subwf-target",
          title: targets.join(", "),
          text: shownTargets
        }));
      }
      if (view.overrideCount > 0) {
        summary.appendChild(h("span", {
          class: "subwf-overrides",
          text: view.overrideCount + " override" + (view.overrideCount === 1 ? "" : "s")
        }));
      }
    } else {
      summary.appendChild(h("span", {
        class: "subwf-state",
        text: view.cyclic ? "cyclic" : "unresolved"
      }));
    }
    det.appendChild(summary);
    if (!view.resolved) return det;
    var body = h("div", { class: "subwf-body" });
    if (view.input) body.appendChild(h("div", { class: "subwf-meta", text: "input: " + truncate(String(view.input), 100) }));
    if (view.params && Object.keys(view.params).length) {
      body.appendChild(h("div", { class: "subwf-meta", text: "params: " + Object.keys(view.params).map(function (k) { return k + "=" + truncate(String(view.params[k]), 40); }).join(", ") }));
    }
    view.steps.forEach(function (cs) {
      var target = cs.agentBacked
        ? (SteamtrainReducer.formatSubWorkflowTarget ? (SteamtrainReducer.formatSubWorkflowTarget(cs) || "auto") : (cs.agent || "auto"))
        : cs.kind === "workflow" ? ("→ " + cs.workflow) : (KIND_LABEL[cs.kind] || cs.kind);
      var row = h("div", { class: "subwf-step" + (cs.overridden ? " overridden" : "") });
      row.style.paddingLeft = (8 + (cs.depth - 1) * 14) + "px";
      row.appendChild(h("span", { class: "subwf-kind " + cs.kind, text: KIND_LABEL[cs.kind] || cs.kind }));
      row.appendChild(h("span", { class: "subwf-id", text: cs.id }));
      row.appendChild(h("span", { class: "subwf-target", text: target }));
      if (cs.overridden) row.appendChild(h("span", { class: "subwf-mark", title: "retargeted by an override on the parent", text: "★" }));
      body.appendChild(row);
    });
    det.appendChild(body);
    return det;
  }

  function renderStagedIndicator() {
    var el = document.getElementById("wfTitle");
    if (!el || !el.parentNode) return;
    var existing = el.parentNode.querySelector(".badge.staged");
    if (existing) existing.remove();
    if (hasStaged()) {
      el.parentNode.insertBefore(
        h("span", { class: "badge staged", text: "staged" }),
        el.nextSibling
      );
    }
    var flushBtn = document.getElementById("flushBtn");
    if (flushBtn) flushBtn.style.display = hasAnyStaged() ? "block" : "none";
  }

  var flushInFlight = false;
  function flushStaged() {
    if (isReadOnly() || !hasAnyStaged() || flushInFlight) return;
    flushInFlight = true;
    var flushBtn = document.getElementById("flushBtn");
    if (flushBtn) { flushBtn.disabled = true; flushBtn.textContent = "Flushing\u2026"; }
    function resetFlushState() {
      flushInFlight = false;
      if (flushBtn) { flushBtn.disabled = false; flushBtn.textContent = "\u{1F4BE} Flush to disk"; }
    }
    apiAuth("POST", "/api/overrides/flush", { overrides: S.stagedOverrides }).then(function (r) {
      resetFlushState();
      if (r.status !== 200) { setBanner((r.body && r.body.error) || "flush failed", "err"); return; }
      var parts = [];
      if (r.body.saved && r.body.saved.length) parts.push("saved: " + r.body.saved.join(", "));
      if (r.body.unchanged && r.body.unchanged.length) parts.push("unchanged: " + r.body.unchanged.join(", "));
      if (r.body.skipped && r.body.skipped.length) {
        parts.push("skipped: " + r.body.skipped.map(function (s) { return s.name + " (" + s.reason + ")"; }).join(", "));
      }
      // Preserve skipped and unchanged entries; only clear saved ones.
      var savedNames = {};
      (r.body.saved || []).forEach(function (n) { savedNames[n] = true; });
      var remaining = {};
      for (var k in S.stagedOverrides) {
        if (!savedNames[k]) remaining[k] = S.stagedOverrides[k];
      }
      S.stagedOverrides = remaining;
      renderStagedIndicator();
      var bannerMsg = parts.length ? "Flush: " + parts.join("; ") : "No staged changes to flush.";
      ST.modals.reloadCatalog().then(function () {
        selectWorkflow(S.selected, function () { setBanner(bannerMsg, "ok"); });
      });
    }).catch(function () {
      resetFlushState();
      setBanner("flush failed: network error", "err");
    });
  }

  // ---- plan (dry-run) -------------------------------------------------------
  function startPlan() {
    if (isReadOnly()) { setBanner("This session is read-only — viewing only.", "info"); return; }
    var input = document.getElementById("input").value;
    if (!input.trim()) {
      // The input lives on the plan's Inputs tab now \u2014 take the reader there.
      if (ST.plan && !S.runId) {
        S.planTab = "inputs";
        ST.render();
        var realInput = document.getElementById("input");
        if (realInput) realInput.focus();
      }
      setBanner("describe the run first \u2014 the input is what the workflow works on", "info");
      return;
    }
    recordPromptHistory(input);
    if (!validateParamsForm()) return;
    var workflowName = S.selected;
    var requestId = ++S.planRequest;
    var payload = { input: input };
    var params = collectParams();
    if (params) payload.params = params;
    // A dirty plan draft is planned as-is; staged session overrides apply only
    // when there is no draft (the draft already absorbed the intent).
    var planDraft = ST.plan && ST.plan.draftIfDirty ? ST.plan.draftIfDirty() : null;
    if (planDraft) payload.spec = planDraft;
    else if (workflowHasStaged(S.stagedOverrides[workflowName])) payload.overrides = S.stagedOverrides[workflowName];
    setBanner("Planning\u2026", "info");
    api("POST", "/api/workflows/" + encodeURIComponent(workflowName) + "/plan", payload)
      .then(function (r) {
        // History enrichment makes plan requests asynchronous. Do not let a
        // stale response replace the canvas for another workflow (or a newer plan).
        if (requestId !== S.planRequest || workflowName !== S.selected) return;
        if (r.status !== 200) { setBanner(r.body.error || "plan failed", "err"); return; }
        // Idle: the result renders inside the plan tab with a back affordance
        // (ST.plan owns #bands then); mid-flow it keeps the whole canvas.
        if (ST.plan && !S.runId) {
          setBanner("", "");
          S.planTab = "plan";
          S.dryRunPlan = { plan: r.body, name: workflowName };
          ST.render();
          return;
        }
        renderPlanResult(r.body, workflowName);
      });
  }

  function renderPlanResult(plan, workflowName, container) {
    setBanner("", "");
    var canvas = container || document.getElementById("bands");
    clear(canvas);

    // Summary header.
    var summary = h("div", { class: "plan-summary" });
    summary.appendChild(h("div", { class: "plan-title", text: "Plan: " + workflowName }));
    summary.appendChild(h("div", { class: "plan-stats",
      text: plan.phaseCount + " phase" + (plan.phaseCount === 1 ? "" : "s") + " \u00b7 " +
            plan.staticStepCount + " step" + (plan.staticStepCount === 1 ? "" : "s") + " \u00b7 " +
            plan.agentCallCount + " agent call" + (plan.agentCallCount === 1 ? "" : "s") + " \u00b7 " +
            (plan.llmCallCount || 0) + " llm call" + (plan.llmCallCount === 1 ? "" : "s") + " \u00b7 " +
            plan.deterministicCount + " deterministic"
    }));
    if (plan.agents.length > 0) {
      summary.appendChild(h("div", { class: "plan-agents", text: "agents: " + plan.agents.map(ST.agentUiLabel).join(", ") }));
    }
    if (plan.apis && plan.apis.length > 0) {
      summary.appendChild(h("div", { class: "plan-agents", text: "apis: " + plan.apis.join(", ") }));
    }
    if (plan.maxCostUsd !== undefined) {
      summary.appendChild(h("div", { class: "plan-budget", text: "budget: $" + plan.maxCostUsd.toFixed(2) }));
    }
    if (plan.history) {
      var history = plan.history;
      var range = history.runs > 1
        ? " (range $" + history.minCostUsd.toFixed(4) + "–$" + history.maxCostUsd.toFixed(4) + ")"
        : "";
      summary.appendChild(h("div", {
        class: "plan-history",
        text: "Observed across " + history.runs + " completed run" + (history.runs === 1 ? "" : "s") +
          ": avg $" + history.avgCostUsd.toFixed(4) + range + " · avg " + fmtElapsed(history.avgDurationMs)
      }));
    }
    canvas.appendChild(summary);

    // Warnings.
    if (plan.warnings && plan.warnings.length > 0) {
      var warnBox = h("div", { class: "plan-warnings" });
      warnBox.appendChild(h("div", { class: "plan-warn-title", text: "\u26a0 " + plan.warnings.length + " template warning" + (plan.warnings.length === 1 ? "" : "s") }));
      plan.warnings.forEach(function (w) {
        warnBox.appendChild(h("div", { class: "plan-warn-item", text: w }));
      });
      canvas.appendChild(warnBox);
    }

    // Fan-out info.
    plan.forEachSteps.forEach(function (fe) {
      canvas.appendChild(h("div", { class: "plan-info", text: "\ud83d\udd00 " + fe.stepId + " \u2192 " + fe.source + " (" + fe.count + " items)" }));
    });
    plan.forEachDynamicSteps.forEach(function (fe) {
      canvas.appendChild(h("div", { class: "plan-info", text: "\ud83d\udd00 " + fe.stepId + " \u2192 " + fe.source + " (dynamic, items resolved at runtime)" }));
    });

    // Loop gates.
    plan.loopGates.forEach(function (lg) {
      canvas.appendChild(h("div", { class: "plan-info", text: "\u21ba loop: " + lg.gateId + " \u2192 " + lg.loopTo + " (max " + lg.maxIterations + " iterations)" }));
    });

    // Sub-workflows.
    plan.workflowSteps.forEach(function (ws) {
      canvas.appendChild(h("div", { class: "plan-info", text: "\u2192 sub-workflow: " + ws.stepId + " \u2192 " + ws.workflow }));
    });

    // Step cards.
    var stepsHeader = h("div", { class: "plan-steps-header", text: "Steps:" });
    canvas.appendChild(stepsHeader);

    var phases = {};
    plan.steps.forEach(function (s) {
      if (!phases[s.phaseId]) phases[s.phaseId] = { title: s.phaseTitle, index: s.phaseIndex, steps: [] };
      phases[s.phaseId].steps.push(s);
    });

    Object.keys(phases).forEach(function (pid) {
      var p = phases[pid];
      var phaseEl = h("div", { class: "phase" });
      phaseEl.appendChild(h("div", { class: "phead" },
        h("div", { class: "pidx", text: String(p.index + 1) }),
        h("div", { class: "ptitle", text: p.title })
      ));
      var cards = h("div", { class: "cards" });
      p.steps.forEach(function (s) {
        var card = h("div", { class: "card pending plan-step" });
        var kindEl = h("span", { class: "kind " + s.kind });
        kindEl.appendChild(document.createTextNode(KIND_LABEL[s.kind] || s.kind));
        card.appendChild(h("div", { class: "top" },
          h("span", { class: "sid", text: s.stepId }),
          kindEl
        ));
        if (s.agent) card.appendChild(h("div", { class: "agent", text: ST.agentUiLabel(s.agent) + (s.model ? " \u00b7 " + s.model : "") }));
        else if (s.modelClass) card.appendChild(h("div", { class: "agent", text: "auto \u00b7 class:" + s.modelClass + (s.model ? " \u00b7 " + s.model : "") }));
        else if (s.llmApi || s.model) card.appendChild(h("div", { class: "agent", text: s.llmApi ? s.llmApi + (s.model ? "/" + s.model : "") : "auto \u00b7 " + s.model }));
        if (s.dependsOn && s.dependsOn.length) card.appendChild(h("div", { class: "inputs", text: "depends: " + s.dependsOn.join(", ") }));
        if (s.forEachSource) card.appendChild(h("div", { class: "inputs", text: "forEach: " + s.forEachSource + (s.forEachCount ? " (" + s.forEachCount + " items)" : s.forEachDynamic ? " (dynamic)" : "") }));
        if (s.loopTo) card.appendChild(h("div", { class: "inputs" },
          h("span", { class: "chip warn", text: "\u21ba " + s.loopTo + (s.maxIterations ? " \u00b7 max " + s.maxIterations : "") })
        ));
        if (s.whenCondition) card.appendChild(h("div", { class: "inputs", text: "when: " + s.whenCondition }));
        if (s.gateCondition) card.appendChild(h("div", { class: "inputs", text: "condition: " + s.gateCondition + (s.gateOnFalse ? " \u00b7 onFalse: " + s.gateOnFalse : "") }));
        if (s.workflowName) card.appendChild(h("div", { class: "inputs", text: "workflow: " + s.workflowName }));
        if (s.mergeMode) card.appendChild(h("div", { class: "inputs", text: "mode: " + s.mergeMode }));
        if (s.workspaceSource) card.appendChild(h("div", { class: "inputs", text: (s.workspaceMode || "inherit") + ": " + s.workspaceSource }));
        if (s.artifacts) card.appendChild(h("div", { class: "inputs", text: "artifacts: " + s.artifacts.join(", ") }));
        if (s.renderedPrompt) {
          var lines = s.renderedPrompt.split("\n");
          var preview = lines.slice(0, 3).join("\n");
          var promptEl = h("div", { class: "plan-prompt" });
          promptEl.appendChild(h("div", { class: "plan-prompt-label", text: "prompt:" }));
          promptEl.appendChild(h("div", { class: "plan-prompt-text", text: preview + (lines.length > 3 ? " ..." : "") }));
          card.appendChild(promptEl);
        }
        cards.appendChild(card);
      });
      phaseEl.appendChild(cards);
      canvas.appendChild(phaseEl);
    });
  }


  /** Reset the ↑/↓ recall browse state (the run input's `input` handler). */
  function clearPromptBrowse() { promptBrowse = null; }

  ST.run = {
    cancelRun: cancelRun,
    closeDetail: closeDetail,
    detachRun: detachRun,
    effectiveSpec: effectiveSpec,
    findRecentLiveLaunch: findRecentLiveLaunch,
    flushStaged: flushStaged,
    handlePromptHistoryKey: handlePromptHistoryKey,
    launchRun: launchRun,
    openDetail: openDetail,
    openStream: openStream,
    renderBands: renderBands,
    renderCard: renderCard,
    renderDetail: renderDetail,
    renderParamsForm: renderParamsForm,
    renderPlanResult: renderPlanResult,
    renderStagedIndicator: renderStagedIndicator,
    sessionOverridesEmpty: sessionOverridesEmpty,
    setBanner: setBanner,
    showRunMetrics: showRunMetrics,
    setParamsExpanded: setParamsExpanded,
    setRunning: setRunning,
    startPlan: startPlan,
    startRun: startRun,
    startTimer: startTimer,
    stopTimer: stopTimer,
    subWorkflowView: subWorkflowView,
    togglePauseRun: togglePauseRun,
    updateProgress: updateProgress,
    updateRunPill: updateRunPill,
    workflowHasStaged: workflowHasStaged,
    clearPromptBrowse: clearPromptBrowse,
  };
})(window.Steamtrain);
