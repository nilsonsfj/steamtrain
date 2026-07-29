/**
 * Modal surfaces: the modal scaffolding and form primitives, workflow
 * create/configure/clone, and the run history browser.
 */
(function (ST) {
  "use strict";
  var S = ST.state;
  var h = ST.h;
  var activateWithKeyboard = ST.activateWithKeyboard;
  var agentById = ST.agentById;
  var aggregateByModel = ST.aggregateByModel;
  var api = ST.api;
  var apiAuth = ST.apiAuth;
  var attachRun = ST.attachRun;
  var clear = ST.clear;
  var clearRunDeepLink = ST.clearRunDeepLink;
  var effortsFor = ST.effortsFor;
  var fmtTime = ST.fmtTime;
  var fmtTokenSummary = ST.fmtTokenSummary;
  var fmtTotals = ST.fmtTotals;
  var isReadOnly = ST.isReadOnly;
  var modelsFor = ST.modelsFor;
  var relTime = ST.relTime;
  var selectWorkflow = ST.selectWorkflow;
  var setRunDeepLink = ST.setRunDeepLink;
  var showReauthOverlay = ST.showReauthOverlay;
  var truncate = ST.truncate;

  // Re-run / retry-failed a recorded run: launch via the history route, then
  // switch to the live run view for the returned run id.
  // `body` is an optional JSON payload for retry retarget ({ retargetAgent, retargetModel, steps }).
  function rerunHistory(id, workflow, mode, body) {
    apiAuth("POST", "/api/history/" + encodeURIComponent(id) + "/" + mode, body).then(function (r) {
      if (r.status !== 201) {
        ST.run.setBanner((r.body && r.body.error) || "could not start re-run", "err");
        return;
      }
      var runId = r.body.runId;
      var downgraded = r.body.downgraded;
      closeModal();
      selectWorkflow(workflow, function () {
        if (downgraded) ST.run.setBanner("Workflow changed since this run \u2014 doing a full re-run.", "info");
        S.runId = runId;
        setRunDeepLink(runId);
        ST.run.setRunning(true);
        S.startedAt = Date.now();
        ST.run.startTimer();
        ST.run.openStream(runId);
        ST.render();
      });
    });
  }

  /** Modal to retry failed steps with a different agent/model (and optional step filter). */
  function openRetryRetargetModal(record) {
    var holder = Hist.holder;
    var failed = [];
    (record.phases || []).forEach(function (p) {
      (p.steps || []).forEach(function (s) {
        if (s.status && s.status !== "done") failed.push(s);
      });
    });
    // Ready when doctor has no row yet (unknown) or status is ok — same rule as
    // the TUI RetryRetargetOverlay.
    var readyAgents = (S.agents || []).filter(function (a) {
      var health = (S.doctor || []).find(function (d) { return d.agent === a.id; });
      return !health || health.status === "ok";
    });
    var agentOpts = readyAgents.map(function (a) {
      return { value: a.id, label: a.id };
    });
    if (!agentOpts.length) {
      ST.run.setBanner("No ready agents available to retarget onto", "err");
      return;
    }
    var agentSel = selectEl(agentOpts, agentOpts[0].value);
    var modelField = h("div", { class: "field" });
    function renderModels() {
      clear(modelField);
      modelField.appendChild(h("label", { text: "Model (optional)" }));
      var meta = null;
      for (var i = 0; i < (S.agents || []).length; i++) {
        if (S.agents[i].id === agentSel.value) { meta = S.agents[i]; break; }
      }
      var opts = [{ value: "", label: "(same family / agent default)" }];
      ((meta && meta.models) || []).forEach(function (m) {
        opts.push({ value: m.id, label: m.name || m.id });
      });
      var sel = selectEl(opts, "");
      modelField.appendChild(sel);
      modelField._sel = sel;
    }
    agentSel.addEventListener("change", renderModels);
    renderModels();

    var stepBox = h("div", { class: "field" });
    stepBox.appendChild(h("label", { text: "Steps to re-run (optional)" }));
    stepBox.appendChild(h("div", { class: "hint", text: "Leave unchecked to retry every failed / not-run step." }));
    var checks = [];
    failed.forEach(function (s) {
      var id = "retarget-step-" + s.stepId;
      var label = s.stepId + (s.agent ? " · " + s.agent : "") + (s.model ? "/" + s.model : "");
      var row = h("label", { class: "check-row", style: "display:flex;gap:0.5rem;align-items:center;margin:0.25rem 0;" },
        h("input", { type: "checkbox", id: id, value: s.stepId }),
        h("span", { text: label })
      );
      checks.push(row.querySelector("input"));
      stepBox.appendChild(row);
    });

    var err = h("div", { class: "mbanner err", style: "display:none;" });
    var body = h("div", null,
      field("Agent", agentSel, "Failed agent steps are forced onto this agent for the retry."),
      modelField,
      stepBox,
      err
    );
    var foot = h("div", { class: "mfoot" },
      h("button", { class: "btn", text: "Back", onClick: function () {
        if (holder) renderHistoryDetail(holder, record);
      }}),
      h("button", { class: "btn primary", text: "Retry with agent", onClick: function () {
        var steps = [];
        checks.forEach(function (c) { if (c.checked) steps.push(c.value); });
        var payload = { retargetAgent: agentSel.value };
        var model = modelField._sel && modelField._sel.value;
        if (model) payload.retargetModel = model;
        if (steps.length) payload.steps = steps;
        stopHistoryPoll();
        rerunHistory(record.id, record.workflow, "retry", payload);
      }})
    );
    openModal(modalShell("Retry with agent", record.workflow + " · " + failed.length + " failed/not-run", body, foot));
  }

  // ---- authoring: modal scaffolding ---------------------------------------
  function modalFocusables() {
    var modal = document.getElementById("modal");
    return Array.prototype.slice.call(modal.querySelectorAll(
      "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])"
    )).filter(function (el) { return el.offsetParent !== null; });
  }
  function focusModal() {
    var modal = document.getElementById("modal");
    var initial = modal.querySelector(".mbody input:not([disabled]), .mbody textarea:not([disabled]), .mbody select:not([disabled])") || modalFocusables()[0] || modal;
    initial.focus();
  }
  function trapModalFocus(event) {
    var focusables = modalFocusables();
    var modal = document.getElementById("modal");
    if (!focusables.length) {
      event.preventDefault();
      modal.focus();
      return;
    }
    var first = focusables[0], last = focusables[focusables.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
  function openModal(node) {
    S.modalInvoker = document.activeElement;
    var modal = document.getElementById("modal");
    clear(modal);
    modal.appendChild(node);
    document.getElementById("overlay").classList.add("show");
    setTimeout(focusModal, 0);
  }
  function closeModal() {
    if (S.draftAbort) { try { S.draftAbort.abort(); } catch (e) {} S.draftAbort = null; }
    stopHistoryPoll();
    // Closing the history browser should drop a stale #run- hash so a refresh
    // does not immediately reopen the modal.
    if (Hist && Hist.holder) clearRunDeepLink();
    Hist.holder = null;
    Hist.view = "list";
    document.getElementById("overlay").classList.remove("show");
    clear(document.getElementById("modal"));
    var invoker = S.modalInvoker;
    S.modalInvoker = null;
    if (invoker && document.contains(invoker)) {
      setTimeout(function () { invoker.focus(); }, 0);
    }
  }
  function modalShell(title, sub, bodyNode, footNode, wide) {
    var titleId = "modalTitle";
    var x = h("button", { class: "x", title: "Close dialog (Esc)", "aria-label": "Close dialog", onClick: closeModal }, "\u00d7");
    var head = h("div", { class: "mhead" },
      h("div", null, h("div", { class: "mtitle", id: titleId, text: title }), sub ? h("div", { class: "msub", text: sub }) : null),
      x
    );
    var shell = h("div", { class: "modal" + (wide ? " wide" : ""), role: "dialog", "aria-modal": "true", "aria-labelledby": titleId, tabindex: "-1" }, head, h("div", { class: "mbody" }, bodyNode), footNode);
    return shell;
  }
  function field(label, control, hint, className, withValidation) {
    var wrapper = h("div", { class: "field" + (className ? " " + className : "") },
      h("label", { text: label }), control,
      hint ? h("div", { class: "hint", text: hint }) : null);
    if (withValidation) {
      var errEl = h("div", { class: "field-error" });
      wrapper.appendChild(errEl);
      control._fieldError = errEl;
    }
    return wrapper;
  }
  function buildModelSelect(agentConfig) {
    var agentId = agentConfig.id;
    var provider = agentConfig.provider || "claude";
    var current = agentConfig.defaultModel || "";
    var meta = agentById(agentId);
    // Fallback: if agent not found by ID or provider mismatches, use any agent
    // with the same provider (model lists are provider-scoped, not agent-scoped).
    if (!meta || meta.provider !== provider) {
      for (var i = 0; i < S.agents.length; i++) {
        if (S.agents[i].provider === provider) { meta = S.agents[i]; break; }
      }
    }
    var models = meta ? meta.models : [];
    var opts = [{ value: "", label: "(use provider default)" }];
    models.forEach(function (m) {
      opts.push({ value: m.id, label: m.name || m.id });
    });
    if (current && !opts.some(function (o) { return o.value === current; })) {
      opts.push({ value: current, label: current + " (current)" });
    }
    return selectEl(opts, current);
  }
  function addBlurValidation(el, checkFn) {
    var errEl = el._fieldError;
    el.addEventListener("blur", function () {
      var msg = checkFn();
      if (msg) {
        el.classList.add("invalid");
        if (errEl) { errEl.textContent = msg; errEl.classList.add("show"); }
      } else {
        el.classList.remove("invalid");
        if (errEl) { errEl.textContent = ""; errEl.classList.remove("show"); }
      }
    });
    function clearInvalid() {
      if (el.classList.contains("invalid")) {
        el.classList.remove("invalid");
        if (errEl) { errEl.textContent = ""; errEl.classList.remove("show"); }
      }
    }
    el.addEventListener("input", clearInvalid);
    el.addEventListener("change", clearInvalid);
  }
  function selectEl(opts, selected, onChange) {
    var sel = h("select", { class: "sel" });
    fillOptions(sel, opts, selected);
    if (onChange) sel.addEventListener("change", onChange);
    return sel;
  }
  function fillOptions(sel, opts, selected) {
    clear(sel);
    opts.forEach(function (o) { sel.appendChild(h("option", { value: o.value }, o.label)); });
    if (selected != null) sel.value = selected;
    if (!sel.value && opts.length) sel.value = opts[0].value;
  }
  function agentOptions() {
    return S.agents.filter(function (a) { return a.enabled !== false; }).map(function (a) {
      var label = a.label && a.label !== a.id ? a.label + " (" + a.id + ")" : a.id;
      return { value: a.id, label: label + (a.healthy ? "" : " (unavailable)") };
    });
  }
  function agentOptionsWith(current) {
    var opts = agentOptions();
    if (current && !opts.some(function (o) { return o.value === current; })) {
      opts = [{ value: current, label: current + " (current unavailable)" }].concat(opts);
    }
    return opts;
  }
  function scopeOptions() {
    return [
      { value: "user", label: "Personal (~/.steamtrain/workflows.json)" },
      { value: "project", label: "Project (./steamtrain.json)" }
    ];
  }
  function modelOptions(agentId) {
    return modelsFor(agentId).map(function (m) { return { value: m.id, label: m.name }; });
  }
  // Keep the step's current model selectable even if it's not in the live
  // catalog (e.g. a paid or removed model), so configuring never silently
  // rewrites it.
  function modelOptionsWith(agentId, current) {
    var opts = modelOptions(agentId);
    if (current && !opts.some(function (o) { return o.value === current; })) {
      opts = [{ value: current, label: current + " (current)" }].concat(opts);
    }
    return opts;
  }
  function effortOptions(agentId, modelId, current) {
    var list = effortsFor(agentId, modelId);
    var opts = [{ value: "", label: "default" }].concat(list.map(function (e) { return { value: e, label: e }; }));
    if (current && !opts.some(function (o) { return o.value === current; })) {
      opts.push({ value: current, label: current });
    }
    return opts;
  }
  function preferredAgent() {
    var enabled = S.agents.filter(function (a) { return a.enabled !== false; });
    for (var i = 0; i < enabled.length; i++) if (enabled[i].healthy) return enabled[i];
    return enabled[0] || null;
  }
  function mbanner(node, text, kind) {
    if (!text) { node.className = "mbanner"; node.textContent = ""; return; }
    node.className = "mbanner show " + (kind === "err" ? "err" : "info");
    node.textContent = text;
  }

  // ---- create (LLM-drafted) -----------------------------------------------
  function openCreate() {
    if (isReadOnly()) { ST.run.setBanner("This session is read-only — viewing only.", "info"); return; }
    if (!S.agents.length) { ST.run.setBanner("agent catalog still loading; try again in a moment", "info"); return; }
    var a0 = preferredAgent();
    var agentSel = selectEl(agentOptions(), a0.id, function () { onCreateAgent(); });
    var modelSel = selectEl(modelOptions(a0.id), a0.defaultModel);
    var effortWrap = h("div", { class: "field", id: "cEffortField" });
    var nameInput = h("input", { class: "txt", placeholder: "auto from description", maxlength: "48" });
    var scopeSel = selectEl(scopeOptions(), "user");
    var descTa = h("textarea", { class: "ta", placeholder: "Describe what the workflow should do, in plain language..." });
    descTa.style.minHeight = "92px";
    var banner = h("div", { class: "mbanner" });
    var draft = h("div", { class: "draft" });

    function onCreateAgent() {
      var ag = agentSel.value;
      var a = agentById(ag);
      fillOptions(modelSel, modelOptions(ag), a ? a.defaultModel : null);
      renderEffort();
    }
    function renderEffort() {
      clear(effortWrap);
      var opts = effortOptions(agentSel.value, modelSel.value);
      if (opts.length <= 1) return;
      effortWrap.appendChild(h("label", { text: "Effort" }));
      effortWrap.appendChild(selectEl(opts, ""));
    }
    modelSel.addEventListener("change", renderEffort);
    renderEffort();

    var body = h("div", null,
      banner,
      field("Description", descTa),
      h("div", { class: "row2" },
        field("Draft with", agentSel),
        field("Model", modelSel),
        effortWrap
      ),
      h("div", { class: "row2" },
        field("Name (optional)", nameInput, "Lowercase, kebab-case. Left blank, it's derived from the description."),
        field("Save to", scopeSel, "Project = ./steamtrain.json (committable, shared).")
      ),
      draft
    );

    var createBtn = h("button", { class: "btn primary", text: "Create \u2728" });
    var foot = h("div", { class: "mfoot" },
      h("button", { class: "btn", text: "Cancel", onClick: closeModal }),
      h("div", { class: "spacer" }),
      createBtn
    );

    createBtn.addEventListener("click", function () {
      var desc = descTa.value.trim();
      if (!desc) { mbanner(banner, "enter a description first", "info"); return; }
      var effortSel = effortWrap.querySelector("select");
      mbanner(banner, "", "");
      draft.className = "draft show"; draft.textContent = "";
      createBtn.disabled = true; createBtn.textContent = "Drafting\u2026";
      // Omit `name` entirely when left blank ("auto from description"): the
      // server's isValidWorkflowName() rejects an empty string, so sending
      // name: "" turned the documented default path (leave Name blank) into
      // a guaranteed 400 on every submission.
      var nameVal = nameInput.value.trim();
      var payload = {
        description: desc, agent: agentSel.value, model: modelSel.value,
        effort: effortSel ? effortSel.value : "",
        scope: scopeSel.value
      };
      if (nameVal) payload.name = nameVal;
      var ac = new AbortController();
      S.draftAbort = ac;
      streamGenerate(payload, ac.signal, function (frame) {
        if (frame.type === "delta") { draft.textContent += frame.text; draft.scrollTop = draft.scrollHeight; }
        else if (frame.type === "attempt") { if (frame.attempt > 1) draft.textContent = ""; }
        else if (frame.type === "done") {
          S.draftAbort = null;
          createBtn.disabled = false; createBtn.textContent = "Create \u2728";
          if (frame.ok && frame.spec) {
            closeModal();
            refreshAfterWrite(frame.name || frame.spec.name, frame.replaced ? "updated" : "created");
          } else {
            // Show the full final raw output behind the error (parity with the
            // TUI), not just whatever streamed during the last attempt.
            if (frame.raw) draft.textContent = frame.raw;
            mbanner(banner, frame.error || "generation failed", "err");
          }
        }
      });
    });

    openModal(modalShell("Create workflow", "An agent drafts a runnable pipeline from your description.", body, foot));
    setTimeout(function () { descTa.focus(); }, 0);
  }

  // Stream the SSE response of POST /api/workflows/generate (EventSource is
  // GET-only, so read the body directly).
  function streamGenerate(payload, signal, onFrame) {
    fetch("/api/workflows/generate", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(payload), signal: signal
    }).then(function (res) {
      if (res.status === 401) { showReauthOverlay(); return; }
      // Any other non-2xx (400 bad request, 503 too many concurrent
      // generations, ...) is a plain JSON error, not an SSE stream. Reading
      // it as one left the modal stuck on "Drafting..." forever with no
      // feedback — surface it as a normal done/error frame instead.
      if (!res.ok) {
        return res.json().then(function (body) {
          onFrame({ type: "done", ok: false, error: (body && body.error) || ("request failed (" + res.status + ")") });
        }, function () {
          onFrame({ type: "done", ok: false, error: "request failed (" + res.status + ")" });
        });
      }
      var reader = res.body.getReader();
      var dec = new TextDecoder();
      var buf = "";
      function pump() {
        return reader.read().then(function (r) {
          if (r.done) return;
          buf += dec.decode(r.value, { stream: true });
          var idx;
          while ((idx = buf.indexOf("\n\n")) >= 0) {
            var chunk = buf.slice(0, idx); buf = buf.slice(idx + 2);
            var line = chunk.split("\n").find(function (l) { return l.indexOf("data: ") === 0; });
            if (!line) continue;
            var frame; try { frame = JSON.parse(line.slice(6)); } catch (e) { continue; }
            onFrame(frame);
          }
          return pump();
        });
      }
      return pump();
    }).catch(function (e) {
      if (signal && signal.aborted) return;
      onFrame({ type: "done", ok: false, error: String(e) });
    });
  }

  // ---- configure / clone ---------------------------------------------------
  function isAgentStep(st) {
    if (st.kind === "llm" || st.kind === "gate" || st.kind === "approval" ||
        st.kind === "human" || st.kind === "command" || st.kind === "workflow") {
      return false;
    }
    if (st.agent || st.model || st.modelClass) return true;
    var k = st.kind || "worker";
    return k === "worker" || k === "processor";
  }
  function modelClassOptions(current) {
    var opts = [{ value: "", label: "(none — use model)" }].concat(
      (S.modelClasses || []).map(function (c) {
        return { value: c.id, label: c.name + " — " + (c.description || c.id) };
      })
    );
    if (current && !opts.some(function (o) { return o.value === current; })) {
      opts.push({ value: current, label: current });
    }
    return opts;
  }
  function familyModelOptions(current) {
    // Cross-agent model picker: family aliases + native ids for auto binding.
    var seen = {};
    var opts = [];
    function add(value, label) {
      if (!value || seen[value]) return;
      seen[value] = true;
      opts.push({ value: value, label: label || value });
    }
    (S.modelFamilies || []).forEach(function (f) {
      add(f.id, f.name + " (" + f.id + ")");
      (f.aliases || []).slice(0, 3).forEach(function (a) { add(a, f.name + " · " + a); });
    });
    S.agents.forEach(function (a) {
      (a.models || []).forEach(function (m) { add(m.id, m.name + " · " + a.id); });
    });
    if (current && !seen[current]) opts.unshift({ value: current, label: current + " (current)" });
    return opts;
  }
  function agentOptionsWithAuto(current) {
    var opts = [{ value: "", label: "Auto (pick ready agent for model)" }].concat(agentOptions());
    if (current && current !== "" && !opts.some(function (o) { return o.value === current; })) {
      opts.splice(1, 0, { value: current, label: current + " (current unavailable)" });
    }
    return opts;
  }
  function countAgentSteps(spec) {
    var n = 0;
    (spec.phases || []).forEach(function (p) {
      (p.steps || []).forEach(function (st) {
        if (isAgentStep(st)) n++;
        else if (st.kind === "workflow") {
          var v = ST.run.subWorkflowView(st);
          if (v && v.resolved) v.steps.forEach(function (cs) { if (cs.agentBacked) n++; });
        }
      });
    });
    return n;
  }

  /**
   * Compact agent/model/effort editor for a step INSIDE a sub-workflow. Stages
   * onto a `::`-namespaced ref key (`<callStepId>::<childPath>`) so bulk
   * retarget, "Try without saving", and Save all cascade into the child run
   * without touching the shared child spec. `base` records the child's own
   * default so Save only persists a genuine override.
   */
  function nestedStepEditor(fullId, cs, refs, nestedList, parentId, childPath) {
    var agent = cs.agent || "";
    var agentSel = selectEl(agentOptionsWithAuto(agent), agent);
    var modelSel = selectEl(agent ? modelOptionsWith(agent, cs.model) : familyModelOptions(cs.model), cs.model || "");
    var effortField = h("div", { class: "field" });
    var cbase = cs.base || {};
    var ref = {
      agentSel: agentSel, modelSel: modelSel, classSel: null, effortSel: null,
      card: null, nested: true,
      // Diff against the child's OWN default (not the effective value) so a
      // previously-staged override re-persists on Save instead of being dropped.
      base: { agent: cbase.agent || "", model: cbase.model || "", effort: cbase.effort || "" }
    };
    function renderEffort() {
      clear(effortField);
      if (!agentSel.value || !modelSel.value) { ref.effortSel = null; return; }
      var opts = effortOptions(agentSel.value, modelSel.value, cs.effort);
      if (opts.length <= 1) { ref.effortSel = null; return; }
      effortField.appendChild(h("label", { text: "Effort" }));
      var es = selectEl(opts, (ref.effortSel && ref.effortSel.value) || cs.effort || "");
      effortField.appendChild(es);
      ref.effortSel = es;
    }
    ref.renderEffort = renderEffort;
    agentSel.addEventListener("change", function () {
      if (agentSel.value) {
        var a = agentById(agentSel.value);
        fillOptions(modelSel, modelOptionsWith(agentSel.value, modelSel.value), a ? (modelSel.value || a.defaultModel) : modelSel.value);
      } else {
        fillOptions(modelSel, familyModelOptions(modelSel.value), modelSel.value);
      }
      renderEffort();
    });
    modelSel.addEventListener("change", renderEffort);

    var useAllBtn = h("button", { class: "btn small use-for-all", text: "Use for all →", type: "button", title: "Apply this to every agent-backed step" });
    var card = h("div", { class: "estep " + cs.kind + " nested" },
      h("div", { class: "eh" },
        h("span", { class: "esid", text: childPath }),
        h("span", { class: "ek", text: cs.kind }),
        cs.overridden ? h("span", { class: "ro", text: "★ overridden" }) : null,
        h("span", { class: "eh-spacer" }),
        useAllBtn
      ),
      h("div", { class: "row2" }, field("Agent", agentSel), field("Model", modelSel), effortField)
    );
    ref.card = card;
    useAllBtn.addEventListener("click", function (e) {
      e.preventDefault(); e.stopPropagation();
      if (refs._onUseForAll) refs._onUseForAll(agentSel.value, modelSel.value, ref.effortSel ? ref.effortSel.value : "");
    });
    refs[fullId] = ref;
    nestedList.push({ fullId: fullId, parentId: parentId, childPath: childPath, ref: ref });
    renderEffort();
    return card;
  }

  /** Render nested editors for every agent-backed step inside a workflow call step. */
  function nestedStepEditors(callStep, refs, nestedList) {
    var view = ST.run.subWorkflowView(callStep);
    if (!view || !view.resolved) return null;
    var agentSteps = view.steps.filter(function (cs) { return cs.agentBacked; });
    if (agentSteps.length === 0) return null;
    var wrap = h("div", { class: "nested-steps" },
      h("div", { class: "nested-head", text: "↳ inside " + callStep.workflow + " — retarget these to cascade into the sub-workflow" })
    );
    agentSteps.forEach(function (cs) {
      var fullId = callStep.id + "::" + cs.path;
      wrap.appendChild(nestedStepEditor(fullId, cs, refs, nestedList, callStep.id, cs.path));
    });
    return wrap;
  }
  function openEditor(clone) {
    if (!S.spec) return;
    if (!S.agents.length) { ST.run.setBanner("agent catalog still loading; try again in a moment", "info"); return; }
    var spec = JSON.parse(JSON.stringify(ST.run.effectiveSpec() || S.spec));
    var creating = !!clone;
    var isWritable = S.source === "user" || S.source === "project";
    var nameInput = h("input", { class: "txt", maxlength: "48", value: creating ? spec.name + "-copy" : spec.name });
    if (!creating && !isWritable) nameInput.setAttribute("disabled", "true");
    var descInput = h("input", { class: "txt", value: spec.description || "", placeholder: "one-line description" });
    var wfStepMin = spec.stepTimeoutSec ? Math.round(spec.stepTimeoutSec / 60) : "";
    var wfRunMin = spec.workflowTimeoutSec ? Math.round(spec.workflowTimeoutSec / 60) : "";
    var wfStepInput = h("input", { class: "txt", type: "number", min: "1", placeholder: "project default", value: wfStepMin });
    var wfRunInput = h("input", { class: "txt", type: "number", min: "1", placeholder: "auto", value: wfRunMin });
    var scopeSel = selectEl(scopeOptions(), "user");
    var banner = h("div", { class: "mbanner" });
    var refs = {};
    var nestedList = [];
    var agentStepCount = countAgentSteps(spec);

    // ── Retarget-all bar: one agent/model/effort → every agent-backed step ──
    var bulkFlash = h("div", { class: "bulk-flash" });
    var bulkAgent = preferredAgent();
    var bulkAgentSel = selectEl(agentOptionsWith(bulkAgent ? bulkAgent.id : ""), bulkAgent ? bulkAgent.id : "");
    var bulkModelSel = selectEl(
      modelOptionsWith(bulkAgentSel.value, bulkAgent ? bulkAgent.defaultModel : ""),
      bulkAgent ? bulkAgent.defaultModel : ""
    );
    var bulkEffortField = h("div", { class: "field bulk-effort" });
    var bulkApplyBtn = h("button", {
      class: "btn primary bulk-apply",
      text: agentStepCount > 0 ? "Apply to all " + agentStepCount + " steps" : "No agent steps",
      type: "button"
    });
    if (agentStepCount === 0) bulkApplyBtn.disabled = true;

    function renderBulkEffort() {
      clear(bulkEffortField);
      var opts = effortOptions(bulkAgentSel.value, bulkModelSel.value);
      bulkEffortField.appendChild(h("label", { text: "Effort" }));
      if (opts.length <= 1) {
        bulkEffortField.appendChild(h("div", { class: "ro", text: "default only" }));
        bulkEffortField._sel = null;
        return;
      }
      var es = selectEl(opts, "");
      bulkEffortField.appendChild(es);
      bulkEffortField._sel = es;
    }
    bulkAgentSel.addEventListener("change", function () {
      var a = agentById(bulkAgentSel.value);
      fillOptions(bulkModelSel, modelOptions(bulkAgentSel.value), a ? a.defaultModel : null);
      renderBulkEffort();
    });
    bulkModelSel.addEventListener("change", renderBulkEffort);
    renderBulkEffort();

    function applyBulkRetarget() {
      var agent = bulkAgentSel.value;
      var model = bulkModelSel.value;
      var effort = bulkEffortField._sel ? bulkEffortField._sel.value : "";
      if (!agent || !model) { mbanner(banner, "pick an agent and model first", "info"); return; }
      var changed = 0;
      Object.keys(refs).forEach(function (id) {
        var r = refs[id];
        if (!r || !r.agentSel) return;
        var agentChanged = r.agentSel.value !== agent;
        if (agentChanged) {
          r.agentSel.value = agent;
          fillOptions(r.modelSel, modelOptionsWith(agent, model), model);
          if (r.renderEffort) r.renderEffort();
        } else {
          r.modelSel.value = model;
          if (r.renderEffort) r.renderEffort();
        }
        if (r.effortSel) {
          // Empty bulk effort = model default. Unlike TUI buildBulkRetargetPatches
          // (which revalidates via effortForModelChange), the Web path clears the
          // select when the chosen effort is not in this step's options.
          var has = Array.prototype.some.call(r.effortSel.options, function (o) { return o.value === effort; });
          r.effortSel.value = has ? effort : "";
        }
        if (r.card) {
          r.card.classList.remove("estep-flash");
          // Force reflow so the animation can re-trigger on repeated applies.
          void r.card.offsetWidth;
          r.card.classList.add("estep-flash");
        }
        changed++;
      });
      bulkFlash.className = "bulk-flash show";
      bulkFlash.textContent = changed
        ? "Retargeted " + changed + " step" + (changed === 1 ? "" : "s") + " \u2192 " + agent + " \u00b7 " + model + (effort ? " \u00b7 " + effort : "")
        : "No agent steps to retarget";
      mbanner(banner, "", "");
      try { bulkBar.scrollIntoView({ behavior: "smooth", block: "nearest" }); } catch (e) { /* ignore */ }
    }
    bulkApplyBtn.addEventListener("click", applyBulkRetarget);

    var bulkBar = h("div", { class: "bulk-retarget" },
      h("div", { class: "bulk-retarget-head" },
        h("div", { class: "bulk-retarget-title", text: "Retarget all agent steps" }),
        h("div", { class: "bulk-retarget-sub", text: "Set every worker / processor / agent-backed step to one agent and model in a single click." })
      ),
      h("div", { class: "bulk-retarget-row" },
        field("Agent", bulkAgentSel),
        field("Model", bulkModelSel),
        bulkEffortField,
        h("div", { class: "bulk-retarget-action" }, bulkApplyBtn)
      ),
      bulkFlash
    );

    // Shared "Use for all" handler — used by both top-level and nested editors.
    function useForAll(agent, model, effort) {
      bulkAgentSel.value = agent;
      var a = agentById(agent);
      fillOptions(bulkModelSel, modelOptionsWith(agent, model), model || (a && a.defaultModel));
      renderBulkEffort();
      if (bulkEffortField._sel && effort != null) {
        var has = Array.prototype.some.call(bulkEffortField._sel.options, function (o) { return o.value === (effort || ""); });
        if (has) bulkEffortField._sel.value = effort || "";
      }
      applyBulkRetarget();
    }
    refs._onUseForAll = useForAll;

    var phasesWrap = h("div", { class: "ephases" });
    spec.phases.forEach(function (p) {
      var pe = h("div", { class: "ephase" }, h("div", { class: "et", text: (p.title || p.id) }));
      p.steps.forEach(function (st) {
        pe.appendChild(stepEditor(st, refs, { onUseForAll: useForAll }));
        if (st.kind === "workflow") {
          var nested = nestedStepEditors(st, refs, nestedList);
          if (nested) pe.appendChild(nested);
        }
      });
      phasesWrap.appendChild(pe);
    });

    var body = h("div", null,
      banner,
      h("div", { class: "row2" },
        field(creating ? "New name" : "Name", nameInput, creating ? "Saved as a new workflow." : (isWritable ? "Changing the name will save as a new workflow and remove the old one." : "Editing creates a user copy that overrides the " + S.source + " one.")),
        field("Description", descInput)
      ),
      h("div", { class: "row2" },
        field("Default step timeout (min)", wfStepInput, "Override per-agent limit for all steps in this workflow."),
        field("Workflow timeout (min)", wfRunInput, "Whole-run limit. Empty = steps × step timeout.")
      ),
      creating ? field("Save to", scopeSel, "Project = ./steamtrain.json (committable, shared).") : null,
      agentStepCount > 0 ? bulkBar : null,
      phasesWrap
    );

    var saveBtn = h("button", { class: "btn primary", text: creating ? "Save copy" : "Save" });
    var tryBtn = creating ? null : h("button", { class: "btn", text: "Try without saving" });
    var foot = h("div", { class: "mfoot" },
      h("button", { class: "btn", text: "Cancel", onClick: closeModal }),
      h("div", { class: "spacer" }),
      tryBtn,
      saveBtn
    );

    saveBtn.addEventListener("click", function () {
      var targetName = (creating || isWritable) ? nameInput.value.trim() : spec.name;
      if (!targetName) { mbanner(banner, "a name is required", "info"); return; }
      if (!creating && isWritable && targetName !== spec.name) {
        var msg = "Are you sure you want to rename this workflow? Changing the name to '" + targetName + "' will save it under the new name and delete the old workflow '" + spec.name + "'.";
        if (!window.confirm(msg)) {
          return;
        }
      }
      spec.name = targetName;
      spec.description = descInput.value.trim() || undefined;
      var wfStepSec = Number(wfStepInput.value) * 60;
      if (wfStepInput.value.trim() && wfStepSec > 0) spec.stepTimeoutSec = wfStepSec; else delete spec.stepTimeoutSec;
      var wfRunSec = Number(wfRunInput.value) * 60;
      if (wfRunInput.value.trim() && wfRunSec > 0) spec.workflowTimeoutSec = wfRunSec; else delete spec.workflowTimeoutSec;
      spec.phases.forEach(function (p) {
        p.steps.forEach(function (st) {
          // Persist nested sub-workflow retargets onto this call step's own
          // `overrides` — only the ones that differ from the child's default, so
          // the saved spec stays minimal and the shared child spec is untouched.
          // This runs BEFORE the `refs[st.id]` guard below: a `workflow` step is
          // not agent-backed, so it has no `refs` entry of its own, but it still
          // carries nested overrides to persist.
          if (st.kind === "workflow") {
            var ov = {};
            nestedList.forEach(function (n) {
              if (n.parentId !== st.id) return;
              var nr = n.ref;
              var agent = nr.agentSel ? nr.agentSel.value : "";
              var model = nr.modelSel ? nr.modelSel.value : "";
              var effort = nr.effortSel ? nr.effortSel.value : "";
              if (agent === nr.base.agent && model === nr.base.model && effort === nr.base.effort) return;
              var patch = {};
              if (agent) patch.agent = agent; if (model) patch.model = model; if (effort) patch.effort = effort;
              if (Object.keys(patch).length) ov[n.childPath] = patch;
            });
            if (Object.keys(ov).length) st.overrides = ov; else delete st.overrides;
          }
          var r = refs[st.id];
          if (!r) return;
          if (r.agentSel) {
            if (r.agentSel.value) st.agent = r.agentSel.value; else delete st.agent;
            if (r.modelSel && r.modelSel.value) st.model = r.modelSel.value; else delete st.model;
            if (r.classSel && r.classSel.value) st.modelClass = r.classSel.value; else delete st.modelClass;
            var ef = r.effortSel ? r.effortSel.value : "";
            if (ef) st.effort = ef; else delete st.effort;
          }
          if (r.promptTa) st.prompt = r.promptTa.value;
          if (r.permsSel) {
            if (r.permsSel.value) st.permissions = r.permsSel.value; else delete st.permissions;
          }
          if (r.stepTimeoutInput && r.stepTimeoutInput.value.trim()) {
            var stepSec = Number(r.stepTimeoutInput.value) * 60;
            if (stepSec > 0) st.stepTimeoutSec = stepSec; else delete st.stepTimeoutSec;
          } else if (r.stepTimeoutInput) delete st.stepTimeoutSec;
        });
      });
      saveBtn.disabled = true; saveBtn.textContent = "Saving…";
      var payload = { spec: spec, scope: creating ? scopeSel.value : (S.source === "project" ? "project" : "user") };
      if (!creating && isWritable) payload.previousName = S.selected;
      function doSave(confirmRisk) {
        if (confirmRisk) payload.confirmRisk = true;
        return apiAuth("PUT", "/api/workflows/" + encodeURIComponent(targetName), payload).then(function (r) {
          saveBtn.disabled = false; saveBtn.textContent = creating ? "Save copy" : "Save";
          if (r.status === 409 && r.body && r.body.requiresConfirmation) {
            var findings = (r.body.review && r.body.review.findings) || [];
            var critical = findings.filter(function (f) { return f.severity === "critical" || f.severity === "high"; });
            var preview = critical.slice(0, 5).map(function (f) { return "• " + f.message; }).join("\n");
            var msg =
              "This workflow has security findings that require confirmation before saving:\n\n" +
              (preview || (r.body.error || "critical/high findings")) +
              (critical.length > 5 ? "\n• …and " + (critical.length - 5) + " more" : "") +
              "\n\nSave anyway?";
            if (window.confirm(msg)) {
              saveBtn.disabled = true; saveBtn.textContent = "Saving…";
              return doSave(true);
            }
            return;
          }
          if (r.status === 200 && r.body.ok) {
            closeModal();
            var savedName = r.body.name || targetName;
            delete S.stagedOverrides[S.selected || savedName];
            if (savedName !== S.selected) delete S.stagedOverrides[savedName];
            var warns = r.body.warnings;
            refreshAfterWrite(savedName, "saved");
            if (warns && warns.length) {
              var suffix = warns.length > 1 ? " (and " + (warns.length - 1) + " more)" : "";
              ST.run.setBanner("⚠ " + warns.length + " template warning" + (warns.length > 1 ? "s" : "") + ": " + warns[0] + suffix, "info");
            }
          } else {
            mbanner(banner, (r.body && r.body.error) || "save failed", "err");
          }
        });
      }
      doSave(false);
    });

    if (tryBtn) {
      tryBtn.addEventListener("click", function () {
        var overrides = { steps: {} };
        spec.phases.forEach(function (p) {
          p.steps.forEach(function (st) {
            var r = refs[st.id];
            if (!r) return;
            var patch = {};
            if (r.agentSel) {
              patch.agent = r.agentSel.value || null;
              patch.model = (r.modelSel && r.modelSel.value) || null;
              patch.modelClass = (r.classSel && r.classSel.value) || null;
              var ef = r.effortSel ? r.effortSel.value : "";
              patch.effort = ef || null;
            }
            if (r.promptTa) patch.prompt = r.promptTa.value;
            if (r.permsSel) patch.permissions = r.permsSel.value || null;
            if (r.stepTimeoutInput && r.stepTimeoutInput.value.trim()) {
              var stepSec = Number(r.stepTimeoutInput.value) * 60;
              patch.stepTimeoutSec = stepSec > 0 ? stepSec : null;
            } else if (r.stepTimeoutInput) patch.stepTimeoutSec = null;
            if (Object.keys(patch).length > 0) overrides.steps[st.id] = patch;
          });
        });
        // Nested sub-workflow steps: stage under their `::`-namespaced id, but
        // only when the target actually changed from the child's default — an
        // untouched nested step must not pin an override that shadows the shared
        // child spec.
        nestedList.forEach(function (n) {
          var r = n.ref;
          var agent = r.agentSel ? r.agentSel.value : "";
          var model = r.modelSel ? r.modelSel.value : "";
          var effort = r.effortSel ? r.effortSel.value : "";
          if (agent === r.base.agent && model === r.base.model && effort === r.base.effort) return;
          var patch = { agent: agent || null, model: model || null, effort: effort || null };
          overrides.steps[n.fullId] = patch;
        });
        var wfStepSec = Number(wfStepInput.value) * 60;
        overrides.stepTimeoutSec = wfStepInput.value.trim() && wfStepSec > 0 ? wfStepSec : null;
        var wfRunSec = Number(wfRunInput.value) * 60;
        overrides.workflowTimeoutSec = wfRunInput.value.trim() && wfRunSec > 0 ? wfRunSec : null;
        if (!ST.run.sessionOverridesEmpty(overrides)) {
          S.stagedOverrides[S.selected] = overrides;
        } else {
          delete S.stagedOverrides[S.selected];
        }
        closeModal();
        ST.run.renderStagedIndicator();
        ST.shell.renderSidebar();
        ST.run.setBanner(!ST.run.sessionOverridesEmpty(overrides) ? "Overrides staged for next run (not saved to disk)." : "No changes to stage.", "info");
      });
    }

    openModal(modalShell(creating ? "Clone workflow" : "Configure " + spec.name,
      agentStepCount > 0
        ? "Retarget every agent step at once, or tune agent / model / model class / effort / prompt per step. Leave Agent on Auto to bind by model."
        : "Set the agent, model, model class, effort, and prompt for each step.",
      body, foot, true));
  }

  function stepEditor(st, refs, opts) {
    opts = opts || {};
    var kind = st.kind || "worker";
    var header = h("div", { class: "eh" },
      h("span", { class: "esid", text: st.id }),
      h("span", { class: "ek", text: kind }),
      st.dependsOn && st.dependsOn.length ? h("span", { class: "ro", text: "\u2190 " + st.dependsOn.join(", ") }) : null
    );
    var card = h("div", { class: "estep " + kind }, header);
    if (st.workspace || (st.artifacts && st.artifacts.length)) {
      var wsBits = [];
      if (st.workspace) wsBits.push("workspace: " + st.workspace);
      if (st.artifacts && st.artifacts.length) wsBits.push("artifacts: " + st.artifacts.join(", "));
      card.appendChild(h("div", { class: "ro", text: wsBits.join(" \u00b7 ") }));
    }
    // llm steps: editable prompt (model stays API-bound / read-only note).
    if (kind === "llm") {
      var llmNote = "api: " + ((st.provider || (st.model && st.model.indexOf("claude") === 0 ? "anthropic" : "openai")) + "/" + (st.model || ""));
      card.appendChild(h("div", { class: "ro", text: llmNote }));
      var llmPrompt = h("textarea", { class: "ta", text: st.prompt || "" });
      refs[st.id] = { promptTa: llmPrompt, card: card };
      card.appendChild(field("Prompt", llmPrompt));
      return card;
    }
    if (!isAgentStep(st)) {
      var note = kind === "gate"
        ? "gate: " + describeGate(st)
        : kind === "command"
          ? "$ " + (st.cmd || "")
          : kind === "workflow"
            ? "invokes workflow: " + (st.workflow || "") + (st.outputStep ? " · outputStep: " + st.outputStep : "") + (st.forEach ? " · forEach: " + st.forEach : "") + (st.worktreeStep ? " · worktreeStep: " + st.worktreeStep : "")
            : kind === "human"
              ? "asks a human: " + truncate(st.prompt || "", 120) + (st.choices && st.choices.length ? " · " + st.choices.length + " choice(s)" : "")
              : (st.items ? "distributes " + st.items.length + " item(s)" : "passthrough merge (no agent)");
      card.appendChild(h("div", { class: "ro", text: note }));
      return card;
    }
    var agent = st.agent || "";
    var agentSel = selectEl(agentOptionsWithAuto(agent), agent);
    var classSel = selectEl(modelClassOptions(st.modelClass || ""), st.modelClass || "");
    var modelSel = selectEl(
      agent ? modelOptionsWith(agent, st.model) : familyModelOptions(st.model),
      st.model || ""
    );
    var effortField = h("div", { class: "field" });
    var stepTimeoutInput = h("input", {
      class: "txt", type: "number", min: "1", placeholder: "workflow default",
      value: st.stepTimeoutSec ? String(Math.round(st.stepTimeoutSec / 60)) : ""
    });
    var promptTa = h("textarea", { class: "ta", text: st.prompt || "" });
    // Sandbox profile: the one control that decides whether this step can touch
    // the repository at all. A plain select, because the whole value of the
    // feature is that it is one obvious choice per step.
    var permsSel = selectEl(
      [
        { value: "", label: "(inherit / unrestricted)" },
        { value: "read-only", label: "🔒 read-only — no writes, shell, or network" },
        { value: "edit", label: "✎ edit — write in its own workspace" },
        { value: "full", label: "⚡ full — everything the CLI offers" }
      ],
      typeof st.permissions === "string" ? st.permissions : (st.permissions && st.permissions.profile) || ""
    );
    var bindHint = h("div", { class: "ro", text: "" });

    function refreshBindHint() {
      var bits = [];
      if (!agentSel.value && (modelSel.value || classSel.value)) {
        bits.push("Auto-binds at run time to the best ready agent for " +
          (classSel.value ? "class '" + classSel.value + "'" : "'" + modelSel.value + "'") +
          " (reference agent preferred).");
      }
      if (classSel.value && modelSel.value) {
        bits.push("modelClass wins when both are set only if model is cleared — prefer one.");
      }
      bindHint.textContent = bits.join(" ");
      bindHint.style.display = bits.length ? "" : "none";
    }

    function renderEffort() {
      clear(effortField);
      if (!agentSel.value || !modelSel.value) { refs[st.id].effortSel = null; return; }
      var opts = effortOptions(agentSel.value, modelSel.value, st.effort);
      if (opts.length <= 1) { refs[st.id].effortSel = null; return; }
      effortField.appendChild(h("label", { text: "Effort" }));
      var es = selectEl(opts, (refs[st.id].effortSel && refs[st.id].effortSel.value) || st.effort || "");
      effortField.appendChild(es);
      refs[st.id].effortSel = es;
    }
    agentSel.addEventListener("change", function () {
      if (agentSel.value) {
        var a = agentById(agentSel.value);
        fillOptions(modelSel, modelOptionsWith(agentSel.value, modelSel.value), a ? (modelSel.value || a.defaultModel) : modelSel.value);
      } else {
        fillOptions(modelSel, familyModelOptions(modelSel.value), modelSel.value);
      }
      renderEffort();
      refreshBindHint();
    });
    modelSel.addEventListener("change", function () { renderEffort(); refreshBindHint(); });
    classSel.addEventListener("change", refreshBindHint);

    var useAllBtn = h("button", {
      class: "btn small use-for-all",
      text: "Use for all \u2192",
      type: "button",
      title: "Apply this step's agent, model, and effort to every agent-backed step"
    });
    useAllBtn.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (typeof opts.onUseForAll === "function") {
        opts.onUseForAll(agentSel.value, modelSel.value, refs[st.id].effortSel ? refs[st.id].effortSel.value : "");
      }
    });
    header.appendChild(h("span", { class: "eh-spacer" }));
    header.appendChild(useAllBtn);

    refs[st.id] = {
      agentSel: agentSel,
      modelSel: modelSel,
      classSel: classSel,
      effortSel: null,
      promptTa: promptTa,
      stepTimeoutInput: stepTimeoutInput,
      permsSel: kind === "merge" ? null : permsSel,
      renderEffort: renderEffort,
      card: card
    };
    card.appendChild(h("div", { class: "row2" },
      field("Agent", agentSel), field("Model", modelSel), effortField));
    card.appendChild(field("Model class", classSel, "Optional role class (thinker / ultrathinker / implementer / reviewer / deep-reviewer / simple / balanced). Leave empty to pin a concrete model."));
    card.appendChild(bindHint);
    card.appendChild(field("Step timeout (min)", stepTimeoutInput, "Per-agent subprocess limit for this step."));
    // Merge steps are excluded: their conflict resolver has to edit the
    // conflicted files, so a read-only choice there would be rejected on save.
    if (kind !== "merge") {
      card.appendChild(field("Permissions", permsSel,
        "Tool sandbox for this step. read-only is enforced by the agent CLI where it can be, and verified against the step's workspace afterwards."));
    }
    card.appendChild(field("Prompt", promptTa));
    renderEffort();
    refreshBindHint();
    return card;
  }

  function describeGate(st) {
    var c = st.condition || {};
    var parts = [];
    if (c.step) parts.push("step " + c.step);
    if (c.value != null) parts.push("value " + c.value);
    if (c.ok != null) parts.push(c.ok ? "ok" : "not ok");
    if (c.contains) parts.push('contains "' + c.contains + '"');
    if (c.matches) parts.push("matches /" + c.matches + "/");
    if (st.onFalse) parts.push("else " + st.onFalse);
    return parts.join(", ") || "condition";
  }

  function doDelete() {
    if (isReadOnly()) return;
    if (!S.selected || (S.source !== "user" && S.source !== "project")) return;
    var fileLabel = S.source === "project" ? "the project steamtrain.json" : "your user workflows file";
    if (!window.confirm("Delete workflow \"" + S.selected + "\"? This removes it from " + fileLabel + ".")) return;
    var name = S.selected;
    apiAuth("DELETE", "/api/workflows/" + encodeURIComponent(name)).then(function (r) {
      if (r.status === 200 && r.body.ok) {
        delete S.stagedOverrides[name];
        S.selected = null; S.spec = null; S.source = null;
        document.getElementById("wfActions").style.display = "none";
        document.getElementById("srcLine").style.display = "none";
        document.getElementById("runRow").style.display = "none";
        document.getElementById("wfTitle").textContent = "Select a workflow";
        document.getElementById("wfSub").textContent = "Pick a workflow on the left to view its pipeline and run it.";
        clear(document.getElementById("bands"));
        document.getElementById("bands").appendChild(h("div", { class: "empty", text: "Deleted " + name + "." }));
        reloadCatalog();
      } else {
        ST.run.setBanner((r.body && r.body.error) || "delete failed", "err");
      }
    });
  }

  function reloadCatalog() {
    return apiAuth("GET", "/api/workflows").then(function (r) {
      S.workflows = r.body.workflows || [];
      ST.shell.renderSidebar();
    });
  }
  function refreshAfterWrite(name, verb) {
    reloadCatalog().then(function () {
      selectWorkflow(name);
      ST.run.setBanner("Workflow \u201c" + name + "\u201d " + (verb || "saved") + ".", "ok");
    });
  }

  // ---- run history ---------------------------------------------------------
  // History browser state (lives for the life of the open modal).
  var Hist = {
    holder: null,
    runs: [],
    liveRuns: [],
    query: "",
    status: "all",
    selected: 0,
    pollTimer: null,
    request: 0,
    view: "list" // "list" | "detail"
  };

  // Graphical diff panels of the "Worktree changes" block: per-step patches
  // fetched lazily (cached per run so re-expanding never refetches) and the
  // expanded step rows per run (survives the section's re-renders).
  var HistDiff = {
    cache: new Map(), // runId -> Map(stepId -> worktree-detail body)
    expanded: new Map(), // runId -> Set(stepId)
    inflight: new Set() // "runId:stepId" currently being fetched
  };

  /** Only a non-empty string is a deep-link run id - never a DOM Event.
   *  Mirrors normalizeHistoryRunId / helpers in history-browser.ts - this page
   *  script is not bundled, so the TS source of truth is copied, not imported. */
  function normalizeHistoryRunId(runId) {
    return typeof runId === "string" && runId.length > 0 ? runId : undefined;
  }

  function historyStatusLabel(status) {
    if (status === "error") return "failed";
    if (status === "budget-exceeded") return "budget";
    return status ? String(status) : "";
  }

  function matchesHistoryQuery(query, fields) {
    var q = (query || "").trim().toLowerCase();
    if (!q) return true;
    var hay = [fields.workflow, fields.input, fields.id, fields.status]
      .filter(Boolean).join("\n").toLowerCase();
    return hay.indexOf(q) !== -1;
  }

  function buildHistoryEntries() {
    var out = [];
    var q = Hist.query;
    var status = Hist.status;
    if (status === "all" || status === "live") {
      (Hist.liveRuns || []).forEach(function (run) {
        if (!matchesHistoryQuery(q, {
          workflow: run.workflow, input: run.input, id: run.id, status: run.status
        })) return;
        out.push({ kind: "live", id: run.id, run: run });
      });
    }
    if (status !== "live") {
      (Hist.runs || []).forEach(function (run) {
        if (status !== "all" && run.status !== status) return;
        if (!matchesHistoryQuery(q, {
          workflow: run.workflow, input: run.input, id: run.id, status: run.status
        })) return;
        out.push({ kind: "record", id: run.id, run: run });
      });
    }
    return out;
  }

  function stopHistoryPoll() {
    if (!Hist || !Hist.pollTimer) return;
    clearInterval(Hist.pollTimer);
    Hist.pollTimer = null;
  }

  function openHistory(runId) {
    var id = normalizeHistoryRunId(runId);
    // History view does not consume step deep links (those only resolve via the
    // live event stream). Clear any pending focus so a later live attach cannot
    // open a step from a previous deep link.
    S.pendingStepDeepLink = null;
    stopHistoryPoll();
    Hist = {
      holder: null,
      runs: [],
      liveRuns: S.liveRuns ? S.liveRuns.slice() : [],
      query: "",
      status: "all",
      selected: 0,
      pollTimer: null,
      request: 0,
      fingerprint: "",
      view: id ? "detail" : "list"
    };
    var holder = h("div", { class: "hist-root" }, h("div", { class: "ro hist-loading", text: "Loading run history\u2026" }));
    Hist.holder = holder;
    var footChildren = [
      h("button", { class: "btn danger small", text: "Clear all", onClick: clearHistory, style: isReadOnly() ? "display:none" : "" }),
      h("div", { class: "spacer" }),
      h("button", { class: "btn", text: "Close", onClick: function () { stopHistoryPoll(); closeModal(); } })
    ];
    if (isReadOnly()) footChildren.shift();
    var foot = h("div", { class: "mfoot" });
    footChildren.forEach(function (c) { foot.appendChild(c); });
    var shell = modalShell("Runs", "Live rides and recorded arrivals - inspect, re-run, harvest.", holder, foot, true);

    shell.classList.add("history-modal");
    openModal(shell);
    if (id) openHistoryRun(holder, id);
    else reopenHistoryList(holder);
    Hist.pollTimer = setInterval(function () {
      if (Hist.view !== "list" || !Hist.holder) return;
      refreshHistoryData(Hist.holder, { silent: true });
    }, 2500);
  }

  function refreshHistoryData(holder, opts) {
    opts = opts || {};
    var req = ++Hist.request;
    return Promise.all([
      apiAuth("GET", "/api/history"),
      api("GET", "/api/runs").catch(function () { return { status: 0, body: {} }; })
    ]).then(function (results) {
      if (req !== Hist.request || Hist.holder !== holder) return;
      var histRes = results[0];
      var liveRes = results[1];
      if (histRes.status === 401) { showReauthOverlay(); return; }
      var nextRuns = (histRes.body && histRes.body.runs) || [];
      var nextLive = [];
      if (liveRes && liveRes.status === 200) {
        nextLive = (liveRes.body.runs || []).filter(function (run) {
          return run.status === "running" || run.status === "queued";
        });
        S.liveRuns = nextLive.slice();
        ST.shell.renderLiveRuns();
      }
      var fingerprint = historyListFingerprint(nextRuns, nextLive);
      var changed = fingerprint !== Hist.fingerprint;
      Hist.runs = nextRuns;
      Hist.liveRuns = nextLive;
      Hist.fingerprint = fingerprint;
      if (!opts.silent || (Hist.view === "list" && changed)) renderHistoryList(holder);
    }).catch(function () {
      if (req !== Hist.request || Hist.holder !== holder) return;
      if (!opts.silent) {
        clear(holder);
        holder.appendChild(h("div", { class: "mbanner show err", text: "Could not load run history - check the connection and try again." }));
        holder.appendChild(h("button", { class: "btn", text: "Retry", onClick: function () { reopenHistoryList(holder); } }));
      }
    });
  }

  function historyListFingerprint(runs, liveRuns) {
    var live = (liveRuns || []).map(function (r) {
      return [r.id, r.status, (r.pendingApprovals || []).length, (r.pendingInputs || []).length].join(":");
    }).join("|");
    var past = (runs || []).map(function (r) { return r.id + ":" + r.status; }).join("|");
    return live + "#" + past;
  }

  function reopenHistoryList(holder) {
    Hist.view = "list";
    Hist.holder = holder;
    clearRunDeepLink();
    clear(holder);
    holder.appendChild(h("div", { class: "ro hist-loading", text: "Loading\u2026" }));
    refreshHistoryData(holder);
  }

  function renderHistoryToolbar(holder) {
    var toolbar = h("div", { class: "hist-toolbar" });
    var search = h("input", {
      class: "txt hist-search",
      type: "search",
      placeholder: "Search workflow, input, or run id\u2026",
      value: Hist.query,
      "aria-label": "Filter runs"
    });
    search.addEventListener("input", function () {
      Hist.query = search.value || "";
      Hist.selected = 0;
      renderHistoryList(holder);
    });
    toolbar.appendChild(search);

    var chips = h("div", { class: "hist-chips", role: "tablist", "aria-label": "Filter by status" });
    var counts = { done: 0, error: 0, canceled: 0, "budget-exceeded": 0 };
    (Hist.runs || []).forEach(function (r) { if (counts[r.status] != null) counts[r.status]++; });
    var chipDefs = [
      { id: "all", label: "All", count: (Hist.liveRuns || []).length + (Hist.runs || []).length },
      { id: "live", label: "Live", count: (Hist.liveRuns || []).length },
      { id: "done", label: "Done", count: counts.done },
      { id: "error", label: "Failed", count: counts.error },
      { id: "canceled", label: "Canceled", count: counts.canceled },
      { id: "budget-exceeded", label: "Budget", count: counts["budget-exceeded"] }
    ];
    chipDefs.forEach(function (chip) {
      if (chip.id !== "all" && chip.id !== "live" && chip.count === 0 && Hist.status !== chip.id) return;
      var btn = h("button", {
        class: "hist-chip" + (Hist.status === chip.id ? " active" : ""),
        type: "button",
        role: "tab",
        "aria-selected": Hist.status === chip.id ? "true" : "false",
        text: chip.label + (chip.count ? " " + chip.count : "")
      });
      btn.addEventListener("click", function () {
        Hist.status = chip.id;
        Hist.selected = 0;
        renderHistoryList(holder);
      });
      chips.appendChild(btn);
    });
    toolbar.appendChild(chips);
    return toolbar;
  }

  function renderHistoryList(holder) {
    Hist.view = "list";
    var prevSearch = holder.querySelector(".hist-search");
    var keepSearchFocus = Boolean(
      prevSearch && document.activeElement === prevSearch
    );
    var caret = keepSearchFocus ? (prevSearch.selectionStart || Hist.query.length) : 0;
    clear(holder);
    holder.appendChild(renderHistoryToolbar(holder));

    var entries = buildHistoryEntries();
    if (Hist.selected >= entries.length) Hist.selected = Math.max(0, entries.length - 1);

    if (!Hist.runs.length && !Hist.liveRuns.length) {
      holder.appendChild(h("div", { class: "hist-empty" },
        h("div", { class: "hist-empty-title", text: "No runs yet" }),
        h("div", { class: "hist-empty-body", text: "Launch a workflow and it will appear here - live while it rides, then as a recorded arrival you can inspect, re-run, or harvest." })
      ));
      restoreHistorySearchFocus(holder, keepSearchFocus, caret);
      return;
    }
    if (!entries.length) {
      holder.appendChild(h("div", { class: "hist-empty" },
        h("div", { class: "hist-empty-title", text: "No runs match" }),
        h("div", { class: "hist-empty-body", text: "Try a different search or status chip." }),
        h("button", { class: "btn small", text: "Clear filters", onClick: function () {
          Hist.query = ""; Hist.status = "all"; Hist.selected = 0; renderHistoryList(holder);
        } })
      ));
      restoreHistorySearchFocus(holder, keepSearchFocus, caret);
      return;
    }

    var list = h("div", { class: "hruns", role: "listbox", "aria-label": "Workflow runs" });
    var seenLive = false;
    var seenRecord = false;
    var liveCount = entries.filter(function (e) { return e.kind === "live"; }).length;
    var recordCount = entries.length - liveCount;

    entries.forEach(function (entry, idx) {
      if (entry.kind === "live" && !seenLive) {
        list.appendChild(h("div", { class: "hist-section", text: "On the rails · " + liveCount }));
        seenLive = true;
      }
      if (entry.kind === "record" && !seenRecord) {
        list.appendChild(h("div", { class: "hist-section", text: "Arrived · " + recordCount }));
        seenRecord = true;
      }
      list.appendChild(entry.kind === "live"
        ? renderLiveHistoryRow(holder, entry.run, idx)
        : renderRecordHistoryRow(holder, entry.run, idx));
    });
    holder.appendChild(list);

    var hint = h("div", { class: "hist-hint", text: "\u2191\u2193 select · Enter open · / focus search · Esc close" });
    holder.appendChild(hint);
    restoreHistorySearchFocus(holder, keepSearchFocus, caret);
  }

  function restoreHistorySearchFocus(holder, keep, caret) {
    if (!keep) return;
    var searchEl = holder.querySelector(".hist-search");
    if (!searchEl) return;
    searchEl.focus();
    try { searchEl.setSelectionRange(caret, caret); } catch (e) {}
  }

  function renderLiveHistoryRow(holder, run, idx) {
    var badges = [];
    badges.push(h("span", { class: "hr-status live", text: run.status }));
    if (run.detached) badges.push(h("span", { class: "hr-pill", text: "detached" }));
    if (run.pendingApprovals && run.pendingApprovals.length) badges.push(h("span", { class: "hr-pill warn", text: "approval" }));
    if (run.pendingInputs && run.pendingInputs.length) badges.push(h("span", { class: "hr-pill warn", text: "input" }));
    var badgeWrap = h("span", { class: "hr-badges" });
    badges.forEach(function (b) { badgeWrap.appendChild(b); });
    var selected = idx === Hist.selected;
    var row = h("div", {
      class: "hrun live" + (selected ? " sel" : ""),
      role: "option",
      tabindex: "0",
      "aria-selected": selected ? "true" : "false",
      "aria-label": "Attach to live " + run.workflow + " run",
      "data-hist-idx": String(idx),
      onClick: function () { attachFromHistory(run); },
      onKeydown: function (event) {
        activateWithKeyboard(event, function () { attachFromHistory(run); });
      }
    },
      h("div", { class: "hr-top" },
        h("span", { class: "hr-glyph live", text: run.status === "queued" ? "\u29D7" : "\u25B6" }),
        h("span", { class: "hr-name", text: run.workflow }),
        badgeWrap,
        h("span", { class: "hr-meta", text: relTime(run.startedAt || run.createdAt) + " \u00b7 Enter attaches" })
      ),
      h("div", { class: "hr-input", text: truncate(((run.input || "").replace(/\s+/g, " ").trim()) || "(no input)", 160) })
    );
    return row;
  }

  function renderRecordHistoryRow(holder, run, idx) {
    var meta = fmtTotals(run.totals, { durationMs: run.durationMs || 0, tokens: true });
    var selected = idx === Hist.selected;
    var row = h("div", {
      class: "hrun " + run.status + (selected ? " sel" : ""),
      role: "option",
      tabindex: "0",
      "aria-selected": selected ? "true" : "false",
      "aria-label": "Open recorded " + run.workflow + " run",
      "data-hist-idx": String(idx),
      onClick: function () { openHistoryRun(holder, run.id); },
      onKeydown: function (event) {
        activateWithKeyboard(event, function () { openHistoryRun(holder, run.id); });
      }
    },
      h("div", { class: "hr-top" },
        h("span", { class: "hr-glyph", text: run.status === "done" ? "\u2713" : run.status === "error" ? "\u2717" : run.status === "canceled" ? "\u2298" : "$" }),
        h("span", { class: "hr-name", text: run.workflow }),
        h("span", { class: "hr-status", text: historyStatusLabel(run.status) }),
        h("span", { class: "hr-meta", text: relTime(run.startedAt) + " \u00b7 " + meta })
      ),
      h("div", { class: "hr-input", text: truncate(((run.input || "").replace(/\s+/g, " ").trim()) || "(no input)", 160) })
    );
    return row;
  }

  function attachFromHistory(run) {
    stopHistoryPoll();
    closeModal();
    attachRun(run);
  }

  function openHistoryRun(holder, id) {
    if (!normalizeHistoryRunId(id)) {
      reopenHistoryList(holder);
      return;
    }
    Hist.view = "detail";
    setRunDeepLink(id);
    clear(holder);
    holder.appendChild(h("div", { class: "ro hist-loading", text: "Loading run\u2026" }));
    var req = ++Hist.request;
    apiAuth("GET", "/api/history/" + encodeURIComponent(id)).then(function (r) {
      if (req !== Hist.request || Hist.holder !== holder) return;
      if (r.status !== 200 || !r.body.record) {
        holder.insertBefore(h("div", { class: "mbanner show err", text: "Could not load that run." }), holder.firstChild);
        // Recover: still show the real list instead of an empty wipe.
        refreshHistoryData(holder);
        return;
      }
      renderHistoryDetail(holder, r.body.record);
    }).catch(function () {
      if (req !== Hist.request || Hist.holder !== holder) return;
      clear(holder);
      holder.appendChild(h("div", { class: "mbanner show err", text: "Could not load that run - network error." }));
      holder.appendChild(h("button", { class: "btn", text: "Back to runs", onClick: function () { reopenHistoryList(holder); } }));
    });
  }

  function renderHistoryDetail(holder, record) {
    Hist.view = "detail";
    clear(holder);

    var back = h("button", { class: "hback", type: "button", text: "\u2190 back to runs", onClick: function () { reopenHistoryList(holder); } });
    holder.appendChild(back);

    var statusCls = "hist-hero " + record.status;
    var hero = h("div", { class: statusCls },
      h("div", { class: "hist-hero-top" },
        h("span", { class: "hist-hero-glyph", text: record.status === "done" ? "\u2713" : record.status === "error" ? "\u2717" : record.status === "canceled" ? "\u2298" : "$" }),
        h("div", { class: "hist-hero-titles" },
          h("div", { class: "hist-hero-name", text: record.workflow }),
          h("div", { class: "hist-hero-sub", text: historyStatusLabel(record.status) + " \u00b7 " + fmtTime(record.startedAt) + " \u00b7 "
            + ((record.durationMs || 0) / 1000).toFixed(1) + "s \u00b7 " + fmtTotals(record.totals, { cached: true, tokens: true }) })
        ),
        h("button", {
          class: "btn small hist-copy",
          type: "button",
          text: "Copy id",
          title: record.id,
          onClick: function () {
            var text = record.id;
            if (navigator.clipboard && navigator.clipboard.writeText) {
              navigator.clipboard.writeText(text).then(function () {
                ST.run.setBanner("Copied run id " + text.slice(0, 8) + "\u2026", "ok");
              }).catch(function () {});
            }
          }
        })
      )
    );
    holder.appendChild(hero);

    if (record.input) {
      holder.appendChild(h("div", { class: "hist-input-block" },
        h("div", { class: "hist-input-label", text: "Input" }),
        h("div", { class: "hist-input-body", text: record.input })
      ));
    }
    if (record.budget) {
      var bScope = record.budget.scope === "step" && record.budget.stepId ? "step '" + record.budget.stepId + "'" : "workflow";
      holder.appendChild(h("div", { class: "mbanner show err", text: bScope + " cost budget $" + record.budget.limitUsd.toFixed(4) + " reached (spent $" + record.budget.spentUsd.toFixed(4) + ") \u2014 resumable after raising the cap" }));
    }
    if (record.error) holder.appendChild(h("div", { class: "mbanner show err", text: record.error }));

    // Per-model breakdown from the recorded tree.
    var histSteps = [];
    (record.phases || []).forEach(function (p) { (p.steps || []).forEach(function (s) { histSteps.push(s); }); });
    var histByModel = aggregateByModel(histSteps);
    if (histByModel.length) {
      var hmt = h("table", { class: "hist-model-table" });
      hmt.appendChild(h("tr", null, h("th", { text: "model" }), h("th", { text: "steps" }), h("th", { text: "cost" }), h("th", { text: "tokens" })));
      histByModel.forEach(function (m) {
        hmt.appendChild(h("tr", null,
          h("td", { text: m.model }), h("td", { text: String(m.steps) }),
          h("td", { text: m.costUsd ? "$" + m.costUsd.toFixed(4) : "" }),
          h("td", { text: fmtTokenSummary(m.tokens) })
        ));
      });
      holder.appendChild(hmt);
    }

    var canRetry = false;
    (record.phases || []).forEach(function (p) {
      (p.steps || []).forEach(function (s) {
        if (s.status && s.status !== "done") canRetry = true;
      });
    });
    var actions = h("div", { class: "run-actions hist-actions" });
    if (!isReadOnly()) {
      actions.appendChild(h("button", { class: "btn primary", text: "Re-run",
        onClick: function () { stopHistoryPoll(); rerunHistory(record.id, record.workflow, "rerun"); } }));
      if (canRetry) {
        actions.appendChild(h("button", { class: "btn", text: "Retry failed",
          onClick: function () { stopHistoryPoll(); rerunHistory(record.id, record.workflow, "retry"); } }));
        actions.appendChild(h("button", { class: "btn", text: "Retry with agent\u2026",
          onClick: function () { openRetryRetargetModal(record); } }));
      }
      actions.appendChild(h("button", { class: "btn danger small", text: "Delete",
        onClick: function () { deleteHistoryRun(holder, record); } }));
    }
    if (actions.childNodes.length) holder.appendChild(actions);

    // Worktree lifecycle: what each retained step worktree changed, plus the
    // Apply / Branch / Prune closure actions (same machinery as the CLI's
    // `workflow history apply/prune`).
    var wtSection = h("div", { class: "hist-worktrees" });
    holder.appendChild(wtSection);
    renderWorktreeSection(wtSection, record);

    (record.phases || []).forEach(function (p, idx) {
      if (idx > 0) holder.appendChild(h("div", { class: "connector" }));
      var pstat = p.done ? (p.ok ? "done" : "failed") : "";
      var phaseEl = h("div", { class: "phase" + (p.done ? " done" : "") },
        h("div", { class: "phead" },
          h("div", { class: "pidx", text: String(idx + 1) }),
          h("div", { class: "ptitle", text: p.title }),
          pstat ? h("div", { class: "pstat", text: "\u00b7 " + pstat }) : null
        )
      );
      var cards = h("div", { class: "cards" });
      (p.steps || []).forEach(function (st) { cards.appendChild(ST.run.renderCard(historyStepView(st))); });
      phaseEl.appendChild(cards);
      holder.appendChild(phaseEl);
    });
  }

  function deleteHistoryRun(holder, record) {
    if (!window.confirm("Delete recorded run " + record.id.slice(0, 8) + "\u2026 of \u201c" + record.workflow + "\u201d? This cannot be undone.")) return;
    apiAuth("DELETE", "/api/history/" + encodeURIComponent(record.id)).then(function (r) {
      if (r.status === 200 || r.status === 204) {
        ST.run.setBanner("Deleted run " + record.id.slice(0, 8) + "\u2026", "ok");
        reopenHistoryList(holder);
      } else {
        ST.run.setBanner((r.body && r.body.error) || "delete failed", "err");
      }
    });
  }

  function histDiffExpanded(runId) {
    var set = HistDiff.expanded.get(runId);
    if (!set) { set = new Set(); HistDiff.expanded.set(runId, set); }
    return set;
  }

  /**
   * One expandable step row of the "Worktree changes" block: the summary line
   * (branch, file count, +/- stats) and, when expanded, the lazily fetched
   * graphical diff panel below it.
   */
  function renderWorktreeDiffRow(holder, record, s) {
    var isOpen = histDiffExpanded(record.id).has(s.stepId);
    var wrap = h("div", null);
    var row = h("div", {
      class: "hist-wt-line expandable" + (isOpen ? "" : " collapsed"),
      title: s.branch,
      role: "button",
      tabindex: "0",
      onClick: function () { toggleWorktreeDiff(holder, record, s.stepId); },
      onKeydown: function (e) { activateWithKeyboard(e, function () { toggleWorktreeDiff(holder, record, s.stepId); }); }
    },
      h("span", { class: "diff-chevron", "aria-hidden": "true", text: "▾" }),
      "⎇ " + s.stepId + " — " + s.files.length + " file(s) ",
      h("span", { class: "diff-add", text: "+" + s.additions }),
      " ",
      h("span", { class: "diff-del", text: "−" + s.deletions })
    );
    wrap.appendChild(row);
    if (!isOpen) return wrap;

    var cached = HistDiff.cache.get(record.id);
    var body = cached && cached.get(s.stepId);
    if (!body) {
      wrap.appendChild(h("div", { class: "hist-wt-loading", text: "Loading diff…" }));
      fetchWorktreeDiff(holder, record, s.stepId);
      return wrap;
    }
    wrap.appendChild(renderWorktreeDiffPanel(record, s, body));
    return wrap;
  }

  function toggleWorktreeDiff(holder, record, stepId) {
    var expSet = histDiffExpanded(record.id);
    if (expSet.has(stepId)) expSet.delete(stepId); else expSet.add(stepId);
    renderWorktreeSection(holder, record);
  }

  /** Lazy per-step patch fetch; responses cache per run id + step id. */
  function fetchWorktreeDiff(holder, record, stepId) {
    var key = record.id + ":" + stepId;
    if (HistDiff.inflight.has(key)) return;
    var cached = HistDiff.cache.get(record.id);
    if (cached && cached.has(stepId)) return;
    HistDiff.inflight.add(key);
    apiAuth("GET", "/api/history/" + encodeURIComponent(record.id) + "/worktrees?step=" + encodeURIComponent(stepId)).then(function (r) {
      HistDiff.inflight.delete(key);
      if (r.status === 200 && r.body) {
        var runCache = HistDiff.cache.get(record.id);
        if (!runCache) { runCache = new Map(); HistDiff.cache.set(record.id, runCache); }
        runCache.set(stepId, r.body);
      }
      renderWorktreeSection(holder, record);
    }).catch(function () { HistDiff.inflight.delete(key); });
  }

  /**
   * The expanded body of a worktree step row: the graphical diff when the
   * diff-view bundle is loaded and a patch came back, a muted per-file list
   * for metadata-only changes (and as the no-bundle fallback), or a
   * "worktree gone" note when the step's worktree was cleaned up since the
   * list was fetched.
   */
  function renderWorktreeDiffPanel(record, s, body) {
    var panel = h("div", { class: "hist-wt-diff" });
    if (body.exists === false) {
      panel.appendChild(h("div", { class: "hist-wt-diff-empty", text: "worktree no longer exists — diff unavailable" }));
      return panel;
    }
    if (typeof window.SteamtrainDiff !== "undefined" && body.patch) {
      if (body.patchTruncated) {
        panel.appendChild(h("div", { class: "hist-wt-diff-truncated",
          text: "Diff truncated at 200 KB — view the full diff with: steamtrain workflow history show " + record.id + " --diff --step " + s.stepId }));
      }
      panel.appendChild(window.SteamtrainDiff.renderPatch(body.patch));
      return panel;
    }
    if (body.files && body.files.length) {
      var fileList = body.files.slice(0, 8).map(function (f) { return f.status + " " + f.path; }).join(" · ");
      if (body.files.length > 8) fileList += " …";
      panel.appendChild(h("div", { class: "hist-wt-files", text: fileList }));
    } else {
      panel.appendChild(h("div", { class: "hist-wt-diff-empty", text: "no textual changes" }));
    }
    return panel;
  }

  /** Drop cached patches for a run after a harvest/prune changed its worktrees. */
  function invalidateWorktreeDiffs(runId) {
    HistDiff.cache.delete(runId);
  }

  /**
   * The "Worktree changes" block of a run's history detail: per-step diffstat
   * of the retained worktrees, the recorded harvest status, and the lifecycle
   * actions — apply to the checkout, merge to a branch, or prune (discard).
   * A source-vs-source merge conflict (409) surfaces retry buttons with a
   * deterministic winner instead of a dead end.
   */
  function renderWorktreeSection(holder, record, notice) {
    apiAuth("GET", "/api/history/" + encodeURIComponent(record.id) + "/worktrees").then(function (r) {
      if (r.status !== 200 || !r.body.sources || !r.body.sources.length) return;
      var sources = r.body.sources;
      var harvest = r.body.harvest;
      clear(holder);
      holder.appendChild(h("div", { class: "hist-wt-title", text: "Worktree changes" }));
      var bits = [];
      if (harvest && harvest.appliedSteps && harvest.appliedSteps.length) bits.push("harvested: " + harvest.appliedSteps.join(", "));
      if (harvest && harvest.branch) bits.push("on branch " + harvest.branch);
      if (harvest && harvest.prunedAt) bits.push("worktrees pruned " + fmtTime(harvest.prunedAt));
      var status = h("div", { class: "hist-wt-status" });
      if (bits.length) status.textContent = bits.join(" · ");
      if (harvest && harvest.prUrl) {
        status.appendChild(h("span", { text: (bits.length ? " · " : "") + "PR: " }));
        status.appendChild(h("a", { href: harvest.prUrl, target: "_blank", text: harvest.prUrl }));
      }
      if (status.textContent || status.childNodes.length) holder.appendChild(status);

      var anyExists = false, anyChanges = false;
      sources.forEach(function (s) {
        if (!s.exists || !s.files.length) {
          var plain = !s.exists
            ? "⎇ " + s.stepId + " — worktree gone (pruned or cleaned up)"
            : "⎇ " + s.stepId + " — no changes";
          if (s.exists) anyExists = true;
          holder.appendChild(h("div", { class: "hist-wt-line", text: plain, title: s.branch }));
          return;
        }
        anyExists = true; anyChanges = true;
        holder.appendChild(renderWorktreeDiffRow(holder, record, s));
      });

      var banner = h("div", { class: "mbanner", style: "margin-top:6px" });
      if (notice) { banner.className = "mbanner show " + notice.cls; banner.textContent = notice.text; }
      holder.appendChild(banner);
      if (isReadOnly()) return;
      var buttons = h("div", { class: "hist-wt-actions" });
      function harvestBtn(label, body, cls) {
        return h("button", { class: "btn" + (cls ? " " + cls : ""), text: label, onClick: function () {
          banner.className = "mbanner show info"; banner.textContent = "merging…";
          apiAuth("POST", "/api/history/" + encodeURIComponent(record.id) + "/harvest", body).then(function (rr) {
            if (rr.status === 200) {
              invalidateWorktreeDiffs(record.id);
              var res = rr.body.result;
              var text = res.noChanges ? "no changes to merge"
                : (res.mode === "apply"
                  ? "applied " + res.mergedSources.join(", ") + " to the checkout (uncommitted): " + res.files.length + " file(s) +" + res.additions + " -" + res.deletions
                  : "merged " + res.mergedSources.join(", ") + " — " + (res.prUrl ? "PR " + res.prUrl : "branch " + res.branch));
              renderWorktreeSection(holder, record, { cls: "info", text: text });
            } else if (rr.status === 409) {
              banner.className = "mbanner show err";
              banner.textContent = rr.body.error + " — retry with a deterministic winner:";
              buttons.appendChild(harvestBtn("Retry: first wins", Object.assign({}, body, { onConflict: "ours" })));
              buttons.appendChild(harvestBtn("Retry: last wins", Object.assign({}, body, { onConflict: "theirs" })));
            } else {
              banner.className = "mbanner show err";
              banner.textContent = rr.body.error || "harvest failed";
            }
          });
        } });
      }
      if (anyChanges) {
        buttons.appendChild(harvestBtn("Apply to checkout", { mode: "apply" }, "primary"));
        buttons.appendChild(harvestBtn("Merge to branch", { mode: "branch" }));
      }
      if (anyExists && !(harvest && harvest.prunedAt)) {
        buttons.appendChild(h("button", { class: "btn", text: "Prune worktrees", onClick: function () {
          if (!window.confirm("Discard this run's worktrees and branches? Unapplied changes are lost.")) return;
          apiAuth("POST", "/api/history/" + encodeURIComponent(record.id) + "/prune").then(function (rr) {
            if (rr.status === 200) invalidateWorktreeDiffs(record.id);
            renderWorktreeSection(holder, record, {
              cls: rr.status === 200 ? "info" : "err",
              text: rr.status === 200 ? "pruned " + rr.body.pruned + "/" + rr.body.total + " worktree(s)" : (rr.body.error || "prune failed")
            });
          });
        } }));
      }
      if (buttons.childNodes.length) holder.appendChild(buttons);
    }).catch(function () {});
  }

  // Map a recorded step onto the shape renderCard expects (live step view).
  function historyStepView(st) {
    return {
      stepId: st.stepId, blockKind: st.blockKind || "worker", agent: st.agent, model: st.model,
      dependsOn: st.dependsOn, forEach: null, item: st.item, status: st.status,
      text: st.text || (st.result && st.result.output) || "", activity: null,
      result: st.result, cached: st.cached, attempts: st.attempts,
      gate: st.gate ? { passed: st.gate.passed, target: st.gate.target } : null,
      approval: st.approval || null,
      // Replayed records are terminal, so a recorded ask is never pending.
      humanInput: st.humanInput ? Object.assign({ pending: false }, st.humanInput) : null,
      loopTo: st.loopTo, maxIterations: st.maxIterations
    };
  }

  function clearHistory() {
    if (!window.confirm("Clear all recorded runs? This deletes the on-disk history.")) return;
    apiAuth("DELETE", "/api/history").then(function () {
      stopHistoryPoll();
      closeModal();
      ST.run.setBanner("Cleared run history.", "ok");
    });
  }

  /** Keyboard navigation inside the history modal list. */
  function handleHistoryListKey(e) {
    if (!Hist.holder || Hist.view !== "list") return false;
    if (e.target && e.target.classList && e.target.classList.contains("hist-search")) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter") {
        // Let arrows move selection even from the search box.
      } else {
        return false;
      }
    }
    var entries = buildHistoryEntries();
    if (!entries.length) return false;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      Hist.selected = Math.min(entries.length - 1, Hist.selected + 1);
      renderHistoryList(Hist.holder);
      focusHistoryRow();
      return true;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      Hist.selected = Math.max(0, Hist.selected - 1);
      renderHistoryList(Hist.holder);
      focusHistoryRow();
      return true;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      var entry = entries[Hist.selected];
      if (!entry) return true;
      if (entry.kind === "live") attachFromHistory(entry.run);
      else openHistoryRun(Hist.holder, entry.id);
      return true;
    }
    if (e.key === "/" && !(e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA"))) {
      e.preventDefault();
      var search = Hist.holder.querySelector(".hist-search");
      if (search) search.focus();
      return true;
    }
    return false;
  }

  function focusHistoryRow() {
    if (!Hist.holder) return;
    var row = Hist.holder.querySelector('.hrun[data-hist-idx="' + Hist.selected + '"]');
    if (row) row.focus();
  }


  ST.modals = {
    addBlurValidation: addBlurValidation,
    agentOptions: agentOptions,
    buildModelSelect: buildModelSelect,
    closeModal: closeModal,
    doDelete: doDelete,
    effortOptions: effortOptions,
    familyModelOptions: familyModelOptions,
    field: field,
    handleHistoryListKey: handleHistoryListKey,
    mbanner: mbanner,
    modalShell: modalShell,
    modelOptionsWith: modelOptionsWith,
    openCreate: openCreate,
    openEditor: openEditor,
    openHistory: openHistory,
    openModal: openModal,
    preferredAgent: preferredAgent,
    reloadCatalog: reloadCatalog,
    selectEl: selectEl,
    stopHistoryPoll: stopHistoryPoll,
    trapModalFocus: trapModalFocus,
  };
})(window.Steamtrain);
