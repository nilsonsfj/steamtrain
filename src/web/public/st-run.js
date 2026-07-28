/**
 * Run surface: the pipeline canvas, run controls, step drill-in, staged
 * overrides, and the plan (dry-run) view.
 */
(function (ST) {
  "use strict";
  var S = ST.state;
  var h = ST.h;
  var KIND_LABEL = ST.KIND_LABEL;
  var TOUR_NAME = ST.TOUR_NAME;
  var activateWithKeyboard = ST.activateWithKeyboard;
  var addTokensInto = ST.addTokensInto;
  var aggregateByModel = ST.aggregateByModel;
  var api = ST.api;
  var apiAuth = ST.apiAuth;
  var clear = ST.clear;
  var emptyTokens = ST.emptyTokens;
  var fmtElapsed = ST.fmtElapsed;
  var fmtTokenSummary = ST.fmtTokenSummary;
  var fmtTokens = ST.fmtTokens;
  var focusDetailFallback = ST.focusDetailFallback;
  var isInteractiveTarget = ST.isInteractiveTarget;
  var isReadOnly = ST.isReadOnly;
  var permissionBadge = ST.permissionBadge;
  var pollLiveRuns = ST.pollLiveRuns;
  var reduce = ST.reduce;
  var restoreDetailInvoker = ST.restoreDetailInvoker;
  var scheduleRender = ST.scheduleRender;
  var selectWorkflow = ST.selectWorkflow;
  var setRunDeepLink = ST.setRunDeepLink;
  var showReauthOverlay = ST.showReauthOverlay;
  var stepKey = ST.stepKey;
  var stepPermissions = ST.stepPermissions;
  var syncBodyMode = ST.syncBodyMode;
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

  function openNarrationStep(line, invoker) {
    if (!line || !line.stepId) return;
    var phases = (S.runState && S.runState.phases) || [];
    var iteration = line.iteration || 1;
    for (var i = 0; i < phases.length; i++) {
      var p = phases[i];
      if (line.phaseId && p.phaseId !== line.phaseId) continue;
      if ((p.iteration || 1) !== iteration) continue;
      for (var j = 0; j < (p.steps || []).length; j++) {
        if (p.steps[j].stepId === line.stepId) {
          openDetail(p, p.steps[j], invoker);
          return;
        }
      }
    }
  }

  function renderNarration(canvas) {
    if (!S.narrationOn || !S.narration || !S.narration.length) return;
    if (!(S.runState && S.runState.started)) return;
    if (S.runState.done && !S.arrivalInspect) return;
    var box = h("div", { class: "narration" });
    box.appendChild(h("div", { class: "narration-head" },
      h("span", { class: "conductor-mark", text: "Conductor" }),
      h("button", {
        class: "btn small",
        text: "Hide",
        onClick: function () {
          S.narrationOn = false;
          try { localStorage.setItem("steamtrain.narration", "off"); } catch (e) {}
          ST.render();
        }
      })
    ));
    S.narration.slice(-8).reverse().forEach(function (line, idx) {
      // One-shot entrance: only the newest line, and only the first paint of that id.
      // Rebuilding the canvas on every SSE tick must not restart the animation.
      var playFresh = idx === 0 && line.id && line.id !== S.narrationFreshPlayed;
      if (playFresh) S.narrationFreshPlayed = line.id;
      box.appendChild(h("div", {
        class: "narration-line" + (playFresh ? " fresh" : "") + (line.stepId ? " clickable" : ""),
        role: line.stepId ? "button" : null,
        tabindex: line.stepId ? "0" : null,
        "data-detail-invoker": line.stepId ? "narration:" + line.id : null,
        "aria-label": line.stepId ? "Open details for step " + line.stepId : null,
        onClick: line.stepId ? function (event) {
          openNarrationStep(line, event.currentTarget);
        } : undefined,
        onKeydown: line.stepId ? function (event) {
          activateWithKeyboard(event, function () {
            openNarrationStep(line, event.currentTarget);
          });
        } : undefined
      }, h("span", { class: "narration-verb", text: "\u25B8" }), " " + line.text));
    });
    canvas.appendChild(box);
  }

  function legendItem(kind, label) {
    var i = h("i"); i.className = ""; i.style.background = kindColor(kind);
    return h("span", null, i, label);
  }
  function kindColor(k) {
    return { worker: "#6fb1ff", processor: "#9d8cff", distributor: "#ffce6f", consolidator: "#5fe0c6", gate: "#f0a35e", approval: "#ffd166", human: "#f5a3ff", merge: "#ff9ecb", command: "#b8c4d0", llm: "#62d2f5", workflow: "#7ce38b", issues: "#c9e07a" }[k] || "#6fb1ff";
  }

  var ALL_LEGEND_KINDS = [
    ["worker", "worker"], ["processor", "process"], ["distributor", "fan-out"],
    ["consolidator", "merge"], ["gate", "gate"], ["approval", "approval"],
    ["human", "human"], ["merge", "merge-back"], ["command", "command"],
    ["llm", "llm"], ["workflow", "sub-workflow"], ["issues", "issues"]
  ];

  /** Kinds present in the selected workflow (spec or live phases). */
  function kindsInCurrentWorkflow() {
    var set = {};
    if (S.spec && S.spec.phases) {
      S.spec.phases.forEach(function (p) {
        (p.steps || []).forEach(function (s) {
          if (s.kind) set[s.kind] = true;
        });
      });
    }
    if (S.runState && S.runState.phases) {
      S.runState.phases.forEach(function (p) {
        (p.steps || []).forEach(function (s) {
          if (s.blockKind) set[s.blockKind] = true;
        });
      });
    }
    return set;
  }

  function renderLegendOrTrack(canvas) {
    var running = S.runState && S.runState.started && !S.runState.done;
    if (running) {
      canvas.appendChild(renderTrackStrip());
      return;
    }
    var present = kindsInCurrentWorkflow();
    var keys = Object.keys(present);
    var wrap = h("div", { class: "legend" });
    ALL_LEGEND_KINDS.forEach(function (pair) {
      if (keys.length === 0 || present[pair[0]]) {
        wrap.appendChild(legendItem(pair[0], pair[1]));
      }
    });
    var help = h("button", {
      class: "btn small legend-help",
      text: "?",
      title: "Show all step kinds",
      onClick: function (e) {
        e.stopPropagation();
        S.legendExpanded = !S.legendExpanded;
        ST.render();
      }
    });
    wrap.appendChild(help);
    if (S.legendExpanded && keys.length > 0) {
      var full = h("div", { class: "legend-full" });
      ALL_LEGEND_KINDS.forEach(function (pair) {
        if (!present[pair[0]]) full.appendChild(legendItem(pair[0], pair[1]));
      });
      if (full.childNodes.length) wrap.appendChild(full);
    }
    canvas.appendChild(wrap);
  }

  /** Horizontal track: one segment per leaf step in the live run. */
  function renderTrackStrip() {
    var segments = [];
    var maxIter = {};
    var phases = (S.runState && S.runState.phases) || [];
    phases.forEach(function (p) {
      if (p.iteration && (!maxIter[p.phaseId] || p.iteration > maxIter[p.phaseId])) {
        maxIter[p.phaseId] = p.iteration;
      }
    });
    phases.forEach(function (p) {
      var isLatest = !p.iteration || p.iteration === (maxIter[p.phaseId] || 1);
      if (!isLatest) return;
      (p.steps || []).forEach(function (s) {
        segments.push(s);
      });
    });
    var track = h("div", {
      class: "track",
      role: "list",
      title: "Live pipeline track",
      "aria-label": "Live pipeline track"
    });
    segments.forEach(function (s, idx) {
      var status = s.status || "pending";
      if (s.result && s.result.skipped) status = "skipped";
      var kind = s.blockKind || "step";
      var seg = h("div", {
        class: "track-seg " + status,
        role: "listitem",
        title: s.stepId + " · " + status,
        "aria-label": s.stepId + ": " + status + " (" + (KIND_LABEL[kind] || kind) + ")",
        style: status === "pending"
          ? "background:transparent;border-color:var(--border)"
          : "background:" + kindColor(kind) + ";border-color:" + kindColor(kind)
      });
      if (idx < segments.length - 1) {
        track.appendChild(seg);
        track.appendChild(h("div", { class: "track-join", "aria-hidden": "true" }));
      } else {
        track.appendChild(seg);
      }
    });
    return track;
  }

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
    var runnerId = s.agent || s.api;
    if (runnerId) card.appendChild(h("div", { class: "agent", text: runnerId + (s.model ? " \u00b7 " + s.model : "") }));
    else if (s.modelClass) card.appendChild(h("div", { class: "agent", text: "auto \u00b7 class:" + s.modelClass + (s.model ? " \u00b7 " + s.model : "") }));
    else if (s.model) card.appendChild(h("div", { class: "agent", text: "auto \u00b7 " + s.model }));
    if (s.blockKind === "workflow") { var subEl = subWorkflowCardBlock(s.stepId); if (subEl) card.appendChild(subEl); }
    if (s.worktree) card.appendChild(h("div", { class: "worktree", title: s.worktree.cwd, text: "\u2387 " + s.worktree.branch }));
    if (s.dependsOn && s.dependsOn.length) card.appendChild(h("div", { class: "inputs", text: "inputs: " + s.dependsOn.join(", ") }));
    if (s.forEach) card.appendChild(h("div", { class: "inputs", text: "forEach: " + s.forEach }));
    if (s.loopTo) card.appendChild(h("div", { class: "inputs" },
      h("span", { class: "chip warn", text: "\u21ba " + s.loopTo + (s.maxIterations ? " \u00b7 max " + s.maxIterations : "") })
    ));
    if (s.item) card.appendChild(h("div", { class: "item", text: "item #" + s.item.index + ": " + truncate(s.item.value, 80) }));
    if (s.activity) card.appendChild(h("div", { class: "activity", text: s.activity }));

    if (s.approval) card.appendChild(renderApproval(s));
    if (s.humanInput) card.appendChild(renderHumanInput(s));

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
        ST.modals.field("Model", modelSel, "Applies when this step runs (agent stays " + agent + ")."),
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
  function openDetail(p, s, invoker) {
    S.detailFocusGeneration += 1;
    S.detail = { phaseId: p.phaseId, iteration: p.iteration || 1, stepId: s.stepId };
    S.detailInvoker = invoker && typeof invoker.getAttribute === "function"
      ? invoker.getAttribute("data-detail-invoker")
      : null;
    S.detailFallback = "details:" + stepKey(p, s);
    S.detailFocusPending = true;
    S.drawerScroll = { follow: true, top: 0 };
    scheduleRender();
  }

  function closeDetail() {
    if (!S.detail) return;
    S.detail = null;
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
    var found = findDetailStep();
    if (!found) {
      drawer.classList.remove("show");
      drawer.setAttribute("aria-hidden", "true");
      clear(drawer);
      return;
    }
    var p = found.phase, s = found.step;
    // Streaming updates rebuild this drawer. Preserve focus on an equivalent
    // replacement control instead of dropping keyboard users onto the page.
    var focusedDrawerControl = drawer.contains(document.activeElement)
      ? document.activeElement.getAttribute("data-drawer-focus")
      : null;
    clear(drawer);
    drawer.classList.add("show");
    drawer.setAttribute("aria-hidden", "false");

    var kindEl = h("span", { class: "kind " + s.blockKind, text: KIND_LABEL[s.blockKind] || s.blockKind });
    var attempts = s.attempts || (s.result && s.result.attempts);
    var stateLabel = s.status + (s.cached ? " · cached" : "") + (s.result && s.result.skipped ? " · skipped" : "") + (attempts && attempts > 1 ? " · " + attempts + " tries" : "");
    var closeButton = h("button", {
      class: "x",
      "data-drawer-focus": "close",
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
    if (S.detailFocusPending || focusedDrawerControl === "close") {
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
    var runnerId = s.agent || s.api;
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

    var body = ((s.result && s.result.output) || s.text || "").trim();
    var followNote = h("span", {
      class: "drawer-follow" + (S.drawerScroll.follow ? " on" : ""),
      text: s.status === "running" ? (S.drawerScroll.follow ? "following" : "paused — scroll to bottom to follow") : ""
    });
    var copyBtn = h("button", {
      class: "btn small",
      "data-drawer-focus": "copy",
      text: "Copy", title: "Copy the full output", onClick: function () {
      if (navigator.clipboard) navigator.clipboard.writeText(body).catch(function () {});
    } });
    drawer.appendChild(h("div", { class: "drawer-outhead" },
      h("span", { class: "drawer-outlabel", text: "output" + (body ? " · " + body.length.toLocaleString() + " chars" : "") }),
      followNote,
      copyBtn
    ));
    if (focusedDrawerControl === "copy") copyBtn.focus();
    var pre = h("pre", { class: "drawer-output" + (s.status === "error" ? " err" : "") });
    pre.textContent = body || (s.activity || "no output yet");
    pre.addEventListener("scroll", function () {
      var atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 4;
      S.drawerScroll = { follow: atBottom, top: pre.scrollTop };
      followNote.className = "drawer-follow" + (atBottom ? " on" : "");
      if (s.status === "running") followNote.textContent = atBottom ? "following" : "paused — scroll to bottom to follow";
    });
    drawer.appendChild(pre);
    // Position after layout: follow pins to the newest output.
    pre.scrollTop = S.drawerScroll.follow ? pre.scrollHeight : S.drawerScroll.top;
  }

  function renderApproval(s) {
    var a = s.approval;
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
        var diffBody = h("div", { class: "approval-diff-body", style: "display:none" });
        if (a.diff.patch.indexOf("[truncated ") >= 0) {
          diffBody.appendChild(h("div", { class: "hist-wt-diff-truncated",
            text: "Diff truncated at 20 KB — the engine caps approval patches; the visible part is shown." }));
        }
        diffBody.appendChild(window.SteamtrainDiff.renderPatch(a.diff.patch));
        var diffToggle = h("button", { class: "btn small approval-diff-toggle", text: "View diff", onClick: function () {
          var showing = diffBody.style.display !== "none";
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
        var buttons = h("div", { class: "approval-actions" },
          h("button", { class: "btn approve", text: "Approve", onClick: function () { resolveApproval(s.stepId, true); } }),
          h("button", { class: "btn reject", text: "Reject", onClick: function () { resolveApproval(s.stepId, false); } })
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
  function renderHumanInput(s) {
    var q = s.humanInput;
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
      q.choices.forEach(function (choice) {
        choiceWrap.appendChild(h("button", { class: "btn choice", text: choice, onClick: function () { submitHumanInput(s.stepId, choice); } }));
      });
      box.appendChild(choiceWrap);
      return box;
    }
    var isJson = Boolean(q.outputSchema);
    var ta = h("textarea", {
      class: "human-input-text",
      rows: isJson ? "5" : "3",
      placeholder: isJson ? "JSON matching the step's output schema…" : "Type your answer…",
      spellcheck: "false"
    });
    var hintText = isJson ? "This step expects JSON (validated against its schema)." : "";
    var errEl = h("div", { class: "human-input-error", style: "display:none" });
    var send = h("button", { class: "btn approve", text: "Answer", onClick: function () {
      var value = ta.value;
      if (!value.trim()) { errEl.textContent = "answer must not be empty"; errEl.style.display = "block"; return; }
      if (isJson) {
        // Cheap local guard: malformed JSON never even reaches the engine's
        // re-ask loop. Schema validation stays server-side (single source).
        try { JSON.parse(value); } catch (e) { errEl.textContent = "not valid JSON: " + e.message; errEl.style.display = "block"; return; }
      }
      errEl.style.display = "none";
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

  function renderSummary(canvas) {
    var results = S.runState ? (S.runState.results || []) : [];
    var leaves = results.filter(function (r) { return !(r.childResults && r.childResults.length); });
    if (!leaves.length) return;
    var wrap = h("div", { class: "summary" });
    wrap.appendChild(h("h2", { text: "Run summary", style: "color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.08em" }));
    var table = h("table");
    table.appendChild(h("tr", null,
      h("th", { text: "" }), h("th", { text: "step" }), h("th", { text: "time" }),
      h("th", { text: "cost" }), h("th", { text: "tokens" }), h("th", { text: "notes" })
    ));
    var totalMs = 0, totalCost = 0, okN = 0, failN = 0, totalTok = emptyTokens();
    leaves.forEach(function (r) {
      totalMs += r.durationMs || 0; totalCost += r.costUsd || 0;
      addTokensInto(totalTok, r.tokens);
      if (r.ok) okN++; else failN++;
      var notes = [];
      if (r.item) notes.push("item " + r.item.index);
      if (r.gate) notes.push(r.gate.passed ? "gate:passed" : "gate:blocked");
      table.appendChild(h("tr", null,
        h("td", { class: r.ok ? "ok" : "fail", text: r.ok ? "\u2713" : "\u2717" }),
        h("td", { text: r.stepId }),
        h("td", { text: ((r.durationMs || 0) / 1000).toFixed(1) + "s" }),
        h("td", { text: r.costUsd ? "$" + r.costUsd.toFixed(4) : "" }),
        h("td", { text: fmtTokenSummary(r.tokens) }),
        h("td", { text: notes.join(" \u00b7 ") })
      ));
    });
    wrap.appendChild(table);
    var tokTotal = totalTokens(totalTok);
    var totals = okN + " ok" + (failN ? " \u00b7 " + failN + " failed" : "") + (totalCost ? " \u00b7 $" + totalCost.toFixed(4) : "") + (tokTotal ? " \u00b7 " + fmtTokens(tokTotal) + " tok" : "") + " \u00b7 " + (totalMs / 1000).toFixed(1) + "s total";
    wrap.appendChild(h("div", { class: "meta", style: "color:var(--muted);font-size:12px;margin-top:8px", text: totals }));

    // Per-model breakdown \u2014 "which model is eating the budget?".
    var allSteps = [];
    if (S.runState) S.runState.phases.forEach(function (p) { p.steps.forEach(function (s) { allSteps.push(s); }); });
    var byModel = aggregateByModel(allSteps);
    if (byModel.length) {
      var mtable = h("table", { style: "margin-top:12px" });
      mtable.appendChild(h("tr", null, h("th", { text: "model" }), h("th", { text: "steps" }), h("th", { text: "cost" }), h("th", { text: "tokens" })));
      byModel.forEach(function (m) {
        mtable.appendChild(h("tr", null,
          h("td", { text: m.model }),
          h("td", { text: String(m.steps) }),
          h("td", { text: m.costUsd ? "$" + m.costUsd.toFixed(4) : "" }),
          h("td", { text: fmtTokenSummary(m.tokens) })
        ));
      });
      wrap.appendChild(h("div", { class: "meta", style: "color:var(--muted);font-size:12px;margin-top:12px;text-transform:uppercase;letter-spacing:.08em", text: "By model" }));
      wrap.appendChild(mtable);
    }
    canvas.appendChild(wrap);
  }

  function updateProgress() {
    var steps = [];
    if (S.runState) {
      S.runState.phases.forEach(function (p) {
        p.steps.forEach(function (s) { steps.push(s); });
      });
    }
    var total = steps.length;
    var doneN = steps.filter(function (s) { return s.status === "done" || s.status === "error"; }).length;
    var runningN = steps.filter(function (s) { return s.status === "running"; }).length;
    var bar = document.getElementById("progressBar");
    var pct = total ? Math.round((doneN / total) * 100) : 0;
    bar.style.width = pct + "%";
    var paused = Boolean(S.runState && S.runState.paused && !S.runState.done);
    document.getElementById("progressText").textContent =
      doneN + " / " + total + " steps" + (runningN ? " · " + runningN + " running" : "") +
      (paused ? (runningN ? " · ⏸ pausing (" + runningN + " finishing)" : " · ⏸ paused") : "");
    updatePauseButton();

    // Live cost/token ticker + budget badge.
    var cost = 0, tokens = emptyTokens();
    steps.forEach(function (s) {
      if (s.result && s.result.costUsd) cost += s.result.costUsd;
      if (s.result) addTokensInto(tokens, s.result.tokens);
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
      ticker.className = "cost-ticker" + (budget ? " over-budget" : "");
    }
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
  function startRun() {
    if (isReadOnly()) { setBanner("This session is read-only — viewing only.", "info"); return; }
    var input = document.getElementById("input").value;
    if (!input.trim()) { setBanner("enter some input first", "info"); return; }
    recordPromptHistory(input);
    // Validate param fields before submission (even when the panel is collapsed).
    if (!validateParamsForm()) return;
    // A pending history-enriched plan must never replace the live run canvas.
    S.planRequest += 1;
    // A freshly launched run is web-owned and in-process, so it can be detached.
    S.runExternal = false;
    S.runDetached = false;
    S.runState = SteamtrainReducer.workflowStateFromSpec(effectiveSpec() || S.spec);
    S.tailScroll = {}; S.drawerScroll = { follow: true, top: 0 };
    S.narration = []; S.arrivalInspect = false; S.arrivalEnter = false;
    S.narrationFreshPlayed = null;
    S.conductorLinePlayed = null;
    S.arrivalCtaFocused = false;
    // Leave full-bleed Station for ride mode: thin chrome stays so banners and
    // cancel remain reachable while the POST is in flight / if it fails.
    if (S.selected === TOUR_NAME) {
      ST.arrival.beginTourDeparture();
    }
    S.endedAt = 0;
    setBanner("", "");
    document.getElementById("statusLine").style.display = "flex";
    syncBodyMode();
    ST.render();
    var payload = { workflow: S.selected, input: input, fresh: document.getElementById("freshChk").checked };
    var params = collectParams();
    if (params) payload.params = params;
    if (workflowHasStaged(S.stagedOverrides[S.selected])) payload.overrides = S.stagedOverrides[S.selected];
    // Blocked-but-re-routable workflow: run with what's ready, this ride only.
    var listItem = wfListItem(S.selected);
    var rerouted = Boolean(listItem && listItem.blocked && listItem.reroute);
    if (rerouted) payload.reroute = true;
    apiAuth("POST", "/api/runs", payload)
      .then(function (r) {
        if (r.status !== 201) {
          setBanner(r.body.error || "could not start run", "err");
          setRunning(false);
          // Escape ride chrome so the error (and sidebar) stay reachable.
          S.tourRiding = false;
          ST.arrival.endTourDeparture();
          syncBodyMode();
          ST.render();
          return;
        }
        // Announce a re-route only when the server actually applied one — the
        // catalog annotation we act on can be stale relative to staged edits.
        var rr = r.body.reroute;
        if (rr) {
          setBanner("Re-routed " + rr.steps + " step" + (rr.steps === 1 ? "" : "s") + " (" +
            rr.blockedAgents.join(", ") + ") to " + rr.agent + " · " + (rr.modelName || rr.model) +
            " for this ride.", "info");
        }
        S.runId = r.body.runId;
        setRunDeepLink(S.runId);
        setRunning(true);
        S.startedAt = Date.now();
        startTimer();
        openStream(S.runId);
        ST.render();
      })
      .catch(function () {
        setBanner("could not start run: network error", "err");
        setRunning(false);
        S.tourRiding = false;
        ST.arrival.endTourDeparture();
        syncBodyMode();
        ST.render();
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
          reduce(frame.event); scheduleRender();
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
          S.queuedBanner = false;
          S.endedAt = Date.now();
          if (frame.status === "canceled") setBanner("Run canceled.", "info");
          else if (frame.status === "budget-exceeded") setBanner("Run stopped: cost budget reached. Raise maxCostUsd and re-run to resume.", "err");
          else if (frame.status === "error" || frame.ok === false) setBanner("Run failed" + (frame.error ? ": " + frame.error : "."), "err");
          else setBanner("Run complete.", "ok");
          // Tour: hold the Conductor stage for a minimum beat before Arrival.
          if (S.selected === TOUR_NAME && S.tourRiding && frame.status !== "canceled" && frame.status !== "error" && frame.ok !== false) {
            ST.arrival.revealArrivalWhenReady();
          }           else {
            S.arrivalEnter = true;
            if (frame.status === "canceled" || frame.status === "error" || frame.ok === false) {
              S.tourRiding = false;
              ST.arrival.endTourDeparture();
            }
            ST.render();
          }
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
    btn.className = paused ? "btn primary" : "btn";
  }

  function setRunning(running) {
    var ro = isReadOnly();
    document.getElementById("runBtn").style.display = (running || ro) ? "none" : "block";
    document.getElementById("pauseBtn").style.display = (running && !ro) ? "block" : "none";
    document.getElementById("detachBtn").style.display =
      (running && !ro && !S.runExternal && !S.runDetached) ? "block" : "none";
    document.getElementById("cancelBtn").style.display = (running && !ro) ? "block" : "none";
    updateDetachButton();
    // Plan and the Describe compose box are pre-launch chrome — hide them while
    // a run is attached so the overflow canvas gets the vertical room.
    document.getElementById("planBtn").style.display = (running || ro) ? "none" : "block";
    document.getElementById("input").disabled = running || ro;
    document.body.classList.toggle("run-live", Boolean(running));
    updatePauseButton();
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
    for (var i = 0; i < spec.phases.length; i++) {
      var steps = spec.phases[i].steps || [];
      for (var j = 0; j < steps.length; j++) {
        if (steps[j].id === stepId && steps[j].kind === "workflow") return steps[j];
      }
    }
    return null;
  }

  /**
   * Expandable "what runs inside" block for a sub-workflow step's pipeline card:
   * a rollup summary line, then a nested list of the child steps with the model
   * that actually runs each one (overrides applied) and an override marker.
   */
  function subWorkflowCardBlock(stepId) {
    var step = findWorkflowStep(stepId);
    if (!step) return null;
    var view = subWorkflowView(step);
    if (!view) return null;
    var det = h("details", { class: "subwf" });
    var rollup = SteamtrainReducer.subWorkflowRollup ? SteamtrainReducer.subWorkflowRollup(view) : ("→ " + step.workflow);
    det.appendChild(h("summary", { class: "subwf-sum", text: rollup }));
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
    if (!input.trim()) { setBanner("enter some input first", "info"); return; }
    recordPromptHistory(input);
    if (!validateParamsForm()) return;
    var workflowName = S.selected;
    var requestId = ++S.planRequest;
    var payload = { input: input };
    var params = collectParams();
    if (params) payload.params = params;
    if (workflowHasStaged(S.stagedOverrides[workflowName])) payload.overrides = S.stagedOverrides[workflowName];
    setBanner("Planning\u2026", "info");
    api("POST", "/api/workflows/" + encodeURIComponent(workflowName) + "/plan", payload)
      .then(function (r) {
        // History enrichment makes plan requests asynchronous. Do not let a
        // stale response replace the canvas for another workflow (or a newer plan).
        if (requestId !== S.planRequest || workflowName !== S.selected) return;
        if (r.status !== 200) { setBanner(r.body.error || "plan failed", "err"); return; }
        renderPlanResult(r.body, workflowName);
      });
  }

  function renderPlanResult(plan, workflowName) {
    setBanner("", "");
    var canvas = document.getElementById("canvas");
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
      summary.appendChild(h("div", { class: "plan-agents", text: "agents: " + plan.agents.join(", ") }));
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
        if (s.agent) card.appendChild(h("div", { class: "agent", text: s.agent + (s.model ? " \u00b7 " + s.model : "") }));
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
    flushStaged: flushStaged,
    handlePromptHistoryKey: handlePromptHistoryKey,
    openDetail: openDetail,
    openStream: openStream,
    renderCard: renderCard,
    renderDetail: renderDetail,
    renderLegendOrTrack: renderLegendOrTrack,
    renderNarration: renderNarration,
    renderParamsForm: renderParamsForm,
    renderStagedIndicator: renderStagedIndicator,
    renderSummary: renderSummary,
    sessionOverridesEmpty: sessionOverridesEmpty,
    setBanner: setBanner,
    setParamsExpanded: setParamsExpanded,
    setRunning: setRunning,
    startPlan: startPlan,
    startRun: startRun,
    startTimer: startTimer,
    stopTimer: stopTimer,
    subWorkflowView: subWorkflowView,
    togglePauseRun: togglePauseRun,
    updateProgress: updateProgress,
    workflowHasStaged: workflowHasStaged,
    clearPromptBrowse: clearPromptBrowse,
  };
})(window.Steamtrain);
