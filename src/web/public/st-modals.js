/**
 * Modal surfaces: the modal scaffolding and form primitives, the new-workflow
 * sheet, the configure/clone editor, and the retry-with-agent sheet. The run
 * browser used to live here too — it is now a page (st-runs.js), which is why
 * this file still owns re-run/retry (they are launched from that page).
 */
(function (ST) {
  "use strict";
  var S = ST.state;
  var h = ST.h;
  var agentById = ST.agentById;
  var api = ST.api;
  var apiAuth = ST.apiAuth;
  var clear = ST.clear;
  var effortsFor = ST.effortsFor;
  var isReadOnly = ST.isReadOnly;
  var modelsFor = ST.modelsFor;
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
      // The new run belongs in the cockpit, which the runs/settings pages are
      // currently covering — leave whichever one is up before attaching to it.
      if (S.page) ST.closePageRoute();
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

  /**
   * Modal to retry failed steps with a different agent/model (and optional step
   * filter). `onBack` restores whatever surface opened it — the runs page hands
   * in its own repaint so Back returns to the receipt the reader came from.
   */
  function openRetryRetargetModal(record, onBack) {
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
      var label = a.label && a.label !== a.id ? a.label + " (" + a.id + ")" : (a.label || ST.agentUiLabel(a.id));
      return { value: a.id, label: label };
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
      var label = s.stepId + (s.agent ? " · " + ST.agentUiLabel(s.agent) : "") + (s.model ? "/" + s.model : "");
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
        closeModal();
        if (typeof onBack === "function") onBack();
      }}),
      h("button", { class: "btn primary", text: "Retry with agent", onClick: function () {
        var steps = [];
        checks.forEach(function (c) { if (c.checked) steps.push(c.value); });
        var payload = { retargetAgent: agentSel.value };
        var model = modelField._sel && modelField._sel.value;
        if (model) payload.retargetModel = model;
        if (steps.length) payload.steps = steps;
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
  function agentAvailable(a) {
    // Until the doctor has reported, keep every enabled agent selectable so
    // create/configure forms are not empty on first paint.
    if (!S.doctor || !S.doctor.length) return true;
    return !!a.healthy;
  }
  function agentOptions() {
    return S.agents.filter(function (a) { return a.enabled !== false && agentAvailable(a); }).map(function (a) {
      var label = a.label && a.label !== a.id ? a.label + " (" + a.id + ")" : a.id;
      return { value: a.id, label: label };
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
  // Mirror src/tui/draft-model.ts DRAFT_AGENT_ORDER (OpenCode first for free
  // models). Keep in sync when adding a provider — vanilla JS cannot import
  // that TypeScript constant.
  var PREFERRED_AGENT_ORDER = [
    "opencode", "claude", "codex", "amp", "kiro", "mimo", "kimi", "cursor", "antigravity"
  ];
  function preferredAgentRank(a) {
    var provider = a.provider || a.id;
    var idx = PREFERRED_AGENT_ORDER.indexOf(provider);
    return idx === -1 ? 99 : idx;
  }
  function preferredAgent() {
    var enabled = S.agents.filter(function (a) { return a.enabled !== false; });
    var available = enabled.filter(agentAvailable).slice().sort(function (a, b) {
      return preferredAgentRank(a) - preferredAgentRank(b);
    });
    if (available.length) return available[0];
    // Doctor not ready / nothing healthy yet: still prefer OpenCode ordering.
    return enabled.slice().sort(function (a, b) {
      return preferredAgentRank(a) - preferredAgentRank(b);
    })[0] || null;
  }

  /**
   * Only ever renders `https:` links, and never without `rel="noopener
   * noreferrer"`. `h()` sets href through setAttribute, which happily accepts a
   * `javascript:` URL — so a URL that reached us from anywhere but our own code
   * gets checked here rather than at each call site. Falls back to plain text so
   * the value is still readable when it is not a link we will click.
   */
  function safeExternalLink(url, label) {
    var text = label || url;
    var ok = false;
    try { ok = new URL(url, window.location.href).protocol === "https:"; } catch (e) { ok = false; }
    if (!ok) return h("span", { text: text });
    return h("a", { href: url, target: "_blank", rel: "noopener noreferrer", text: text });
  }
  function mbanner(node, text, kind) {
    if (!text) { node.className = "mbanner"; node.textContent = ""; return; }
    node.className = "mbanner show " + (kind === "err" ? "err" : "info");
    node.textContent = text;
  }

  // ---- new workflow --------------------------------------------------------
  /**
   * Where a new workflow's phases come from. Every source ends the same way —
   * the spec is written and the workflow is selected — so the sheet is one
   * choice plus one Create, not four different flows.
   */
  var START_POINTS = [
    {
      id: "blank",
      title: "Blank",
      body: "One phase, one worker step, on your default runner. Everything else is added by configuring it."
    },
    {
      id: "duplicate",
      title: "Duplicate a workflow",
      body: "Copies phases, prompts and runner choices from a workflow you already have."
    },
    {
      id: "template",
      title: "From a template",
      body: "The bundled workflows, copied into your own so you can edit them."
    },
    {
      id: "describe",
      title: "Describe it",
      body: "An agent drafts a runnable pipeline from a plain-language description."
    }
  ];

  /** kebab-case, the convention every bundled workflow name follows. */
  function slugifyName(text) {
    return String(text || "").toLowerCase().trim()
      .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  }

  function workflowNamesBySource(source) {
    return (S.workflows || [])
      .filter(function (w) { return !source || w.source === source; })
      .map(function (w) { return w.name; });
  }

  function nameOptions(names) {
    return names.map(function (name) { return { value: name, label: name }; });
  }

  /** A free name near `base` - "x", then "x-copy", "x-copy-2", ... */
  function freeWorkflowName(base) {
    var taken = {};
    (S.workflows || []).forEach(function (w) { taken[w.name] = true; });
    if (!taken[base]) return base;
    var candidate = base + "-copy";
    for (var n = 2; taken[candidate] && n < 100; n++) candidate = base + "-copy-" + n;
    return candidate;
  }

  /**
   * The smallest spec the schema accepts: one phase, one worker step bound to
   * the reader's default runner. The prompt is a placeholder they are expected
   * to replace - a worker step without one does not validate.
   */
  function blankSpec(agent) {
    return {
      description: "",
      phases: [{
        id: "main",
        title: "Main",
        steps: [{
          id: "work",
          kind: "worker",
          agent: agent.id,
          model: agent.defaultModel,
          prompt: "Describe the task for this step.\n\nInput: {{input}}"
        }]
      }]
    };
  }

  function openCreate() {
    if (isReadOnly()) { ST.run.setBanner("This session is read-only — viewing only.", "info"); return; }
    if (!S.agents.length) { ST.run.setBanner("agent catalog still loading; try again in a moment", "info"); return; }
    var a0 = preferredAgent();
    // A non-empty catalog can still yield no usable agent: preferredAgent()
    // filters to enabled ones, so every agent being disabled lands here. Say so
    // instead of dereferencing null and taking the modal down with a TypeError.
    if (!a0) {
      ST.run.setBanner("every agent is disabled — enable one in Settings to draft a workflow", "err");
      return;
    }
    if (S.doctor && S.doctor.length && !agentAvailable(a0)) {
      ST.run.setBanner("no healthy agent available — fix Setup / doctor before creating a workflow", "err");
      return;
    }

    var duplicable = workflowNamesBySource(null);
    var templates = workflowNamesBySource("bundled");
    var start = "blank";

    var banner = h("div", { class: "mbanner" });
    var nameInput = h("input", { class: "txt", maxlength: "48", placeholder: "my-workflow" });
    var scopeSel = selectEl(scopeOptions(), "user");
    var fileLine = h("div", { class: "create-file" });
    // The name is only auto-derived until the reader types one of their own -
    // after that, switching source must not overwrite what they wrote.
    var nameTouched = false;
    nameInput.addEventListener("input", function () { nameTouched = true; syncFile(); });
    scopeSel.addEventListener("change", syncFile);

    var dupSel = selectEl(nameOptions(duplicable), duplicable[0] || "");
    var dupMeta = h("div", { class: "create-meta" });
    var tplSel = selectEl(nameOptions(templates), templates[0] || "");
    var tplMeta = h("div", { class: "create-meta" });
    var descTa = h("textarea", { class: "ta", placeholder: "Describe what the workflow should do, in plain language…" });
    descTa.style.minHeight = "84px";
    var agentSel = selectEl(agentOptions(), a0.id, function () { onDraftAgent(); });
    var modelSel = selectEl(modelOptions(a0.id), a0.defaultModel);
    var effortWrap = h("div", { class: "field" });
    var draft = h("div", { class: "draft" });

    function onDraftAgent() {
      var a = agentById(agentSel.value);
      fillOptions(modelSel, modelOptions(agentSel.value), a ? a.defaultModel : null);
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

    function wfItem(name) {
      for (var i = 0; i < (S.workflows || []).length; i++) {
        if (S.workflows[i].name === name) return S.workflows[i];
      }
      return null;
    }
    function shapeText(name) {
      var item = wfItem(name);
      if (!item) return "";
      return item.phaseCount + " phase" + (item.phaseCount === 1 ? "" : "s") + " · " +
        item.stepCount + " step" + (item.stepCount === 1 ? "" : "s");
    }

    /** The name a source implies, used until the reader types their own. */
    function derivedName() {
      if (start === "duplicate" && dupSel.value) return freeWorkflowName(dupSel.value);
      if (start === "template" && tplSel.value) return freeWorkflowName(tplSel.value);
      return "";
    }

    function syncFile() {
      var target = scopeSel.value === "project"
        ? "./steamtrain.json"
        : "~/.steamtrain/workflows.json";
      var name = slugifyName(nameInput.value);
      fileLine.textContent = name ? target + " · workflows." + name : target;
    }

    function syncSource() {
      dupMeta.textContent = shapeText(dupSel.value);
      tplMeta.textContent = shapeText(tplSel.value);
      if (!nameTouched) {
        nameInput.value = derivedName();
        nameInput.placeholder = start === "describe" ? "auto from description" : "my-workflow";
      }
      syncFile();
    }
    dupSel.addEventListener("change", syncSource);
    tplSel.addEventListener("change", syncSource);

    var cards = h("div", { class: "create-cards" });
    var cardEls = {};
    START_POINTS.forEach(function (point) {
      // A source with nothing to offer (no bundled workflows, nothing to
      // duplicate) is left out rather than shown as a card that cannot be used.
      if (point.id === "duplicate" && !duplicable.length) return;
      if (point.id === "template" && !templates.length) return;
      var card = h("button", { class: "create-card", type: "button", "aria-pressed": "false" },
        h("div", { class: "create-card-head" },
          h("span", { class: "title", text: point.title }),
          h("span", { class: "tick", "aria-hidden": "true", text: "✓" })
        ),
        h("div", { class: "create-card-body", text: point.body })
      );
      if (point.id === "duplicate") { card.appendChild(dupSel); card.appendChild(dupMeta); }
      if (point.id === "template") { card.appendChild(tplSel); card.appendChild(tplMeta); }
      card.addEventListener("click", function (e) {
        // The select inside a card is a control, not part of the card hit area.
        if (e.target !== card && ST.isInteractiveTarget(e.target)) return;
        pick(point.id);
      });
      cardEls[point.id] = card;
      cards.appendChild(card);
    });

    var describeBox = h("div", { class: "create-describe" },
      field("Description", descTa),
      h("div", { class: "row2" }, field("Draft with", agentSel), field("Model", modelSel), effortWrap),
      draft
    );

    function pick(id) {
      start = id;
      Object.keys(cardEls).forEach(function (key) {
        var on = key === id;
        cardEls[key].classList.toggle("selected", on);
        cardEls[key].setAttribute("aria-pressed", on ? "true" : "false");
      });
      describeBox.style.display = id === "describe" ? "" : "none";
      syncSource();
    }

    var body = h("div", { class: "create-sheet" },
      banner,
      h("div", { class: "row2" },
        field("Name", nameInput, "Lowercase, kebab-case."),
        field("Save to", scopeSel, "Project = ./steamtrain.json (committable, shared).")
      ),
      fileLine,
      h("div", { class: "create-label", text: "Start from" }),
      cards,
      describeBox
    );

    var createBtn = h("button", { class: "btn primary", text: "Create" });
    var foot = h("div", { class: "mfoot" },
      h("span", { class: "create-hint", text: "Opens the new workflow with its pipeline shown. Nothing runs until you hit Run." }),
      h("div", { class: "spacer" }),
      h("button", { class: "btn", text: "Cancel", onClick: closeModal }),
      createBtn
    );

    createBtn.addEventListener("click", function () { submit(); });

    function submit() {
      mbanner(banner, "", "");
      if (start === "describe") { submitDraft(); return; }
      var name = slugifyName(nameInput.value);
      if (!name) { mbanner(banner, "give the workflow a name first", "info"); return; }
      if (wfItem(name)) { mbanner(banner, "“" + name + "” already exists — pick another name", "info"); return; }
      createBtn.disabled = true; createBtn.textContent = "Creating…";
      var from = start === "blank" ? null : (start === "duplicate" ? dupSel.value : tplSel.value);
      specFor(from).then(function (spec) {
        spec.name = name;
        return apiAuth("PUT", "/api/workflows/" + encodeURIComponent(name), {
          spec: spec, scope: scopeSel.value
        });
      }).then(function (r) {
        createBtn.disabled = false; createBtn.textContent = "Create";
        if (r.status === 200 && r.body.ok) {
          closeModal();
          refreshAfterWrite(r.body.name || name, "created");
        } else {
          mbanner(banner, (r.body && r.body.error) || "could not create the workflow", "err");
        }
      }).catch(function (e) {
        createBtn.disabled = false; createBtn.textContent = "Create";
        mbanner(banner, (e && e.message) || "could not create the workflow", "err");
      });
    }

    /** The spec to write: a fresh minimal one, or a copy of `from`. */
    function specFor(from) {
      if (!from) return Promise.resolve(blankSpec(a0));
      return apiAuth("GET", "/api/workflows/" + encodeURIComponent(from)).then(function (r) {
        if (r.status !== 200 || !r.body.spec) {
          throw new Error("could not read “" + from + "” to copy it");
        }
        return JSON.parse(JSON.stringify(r.body.spec));
      });
    }

    function submitDraft() {
      var desc = descTa.value.trim();
      if (!desc) { mbanner(banner, "enter a description first", "info"); return; }
      var effortSel = effortWrap.querySelector("select");
      draft.className = "draft show"; draft.textContent = "";
      createBtn.disabled = true; createBtn.textContent = "Drafting…";
      // Omit `name` entirely when left blank ("auto from description"): the
      // server's isValidWorkflowName() rejects an empty string, so sending
      // name: "" turned the documented default path (leave Name blank) into
      // a guaranteed 400 on every submission.
      var nameVal = slugifyName(nameInput.value);
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
          createBtn.disabled = false; createBtn.textContent = "Create";
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
    }

    var shell = modalShell("New workflow", "Pick a starting point — you can change everything afterwards.", body, foot, true);
    // Enter submits from anywhere but the description box, where it is a newline.
    shell.addEventListener("keydown", function (e) {
      if (e.key !== "Enter" || e.shiftKey || e.target === descTa) return;
      if (e.target && e.target.tagName === "SELECT") return;
      e.preventDefault();
      submit();
    });
    openModal(shell);
    pick("blank");
    setTimeout(function () { nameInput.focus(); }, 0);
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
    // Only list models from available agents so defaults cannot point at an
    // agent the doctor has marked down.
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
      if (a.enabled === false || !agentAvailable(a)) return;
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
        ? "Retargeted " + changed + " step" + (changed === 1 ? "" : "s") + " \u2192 " + ST.agentUiLabel(agent) + " \u00b7 " + model + (effort ? " \u00b7 " + effort : "")
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
        }).catch(function () {
          // Without this the request rejecting (offline, server restarted
          // mid-save) leaves the button disabled reading "Saving…" forever, and
          // the only way out is to close the modal and lose the edits.
          saveBtn.disabled = false; saveBtn.textContent = creating ? "Save copy" : "Save";
          mbanner(banner, "save failed — could not reach the server", "err");
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
      if (verb === "created") {
        // 03.3: creation drops you straight into the idle plan with the step
        // inspector already open on the first step \u2014 creation and editing are
        // the same screen, so there is no separate authoring mode to land on.
        selectWorkflow(name, function () {
          S.planTab = "plan";
          var draft = ST.plan ? ST.plan.draftIfDirty() : null;
          var spec = draft || S.spec;
          var first = spec && spec.phases && spec.phases.length && spec.phases[0].steps.length
            ? spec.phases[0].steps[0]
            : null;
          if (first) S.planSelection = [first.id];
          ST.run.setBanner("Workflow \u201c" + name + "\u201d created.", "ok");
          ST.render();
        });
        return;
      }
      selectWorkflow(name);
      ST.run.setBanner("Workflow \u201c" + name + "\u201d " + (verb || "saved") + ".", "ok");
    });
  }


  // ---- launch sheet (Turn 2 · 02.2) ------------------------------------------
  // The only modal in the plan flow. Run never fires blind: the sheet states
  // exactly what will execute, lets steps be deselected (recorded as skipped
  // by the run) or the run started from a later phase, and surfaces unsaved
  // plan edits — which run as-is — before the start button. ⏎ starts, esc
  // returns to the plan.
  function openLaunchSheet(opts) {
    opts = opts || {};
    if (isReadOnly()) { ST.run.setBanner("This session is read-only — viewing only.", "info"); return; }
    if (!S.selected || !S.spec) return;
    var input = (document.getElementById("input") || {}).value || "";
    if (!input.trim()) {
      S.planTab = "inputs";
      ST.render();
      var realInput = document.getElementById("input");
      if (realInput) realInput.focus();
      ST.run.setBanner("describe the run first — the input is what the workflow works on", "info");
      return;
    }
    var base = ST.plan.draftIfDirty() || S.spec;
    var lo = S.launchOptions;

    // Which steps will execute. opts.only pins the sheet to a single step
    // (the inspector's "Run this step only"); its own dependencies still run —
    // the engine needs their outputs — so they're shown checked and locked.
    var checked = {};
    var locked = {};
    ST.plan.flatSteps(base).forEach(function (f) {
      checked[f.step.id] = opts.only ? f.step.id === opts.only : true;
      // A step disabled in the plan stays skipped, no checkbox to revive it.
      if (ST.plan.isDisabledWhen(f.step.when)) {
        checked[f.step.id] = false;
        locked[f.step.id] = true;
      }
    });
    if (opts.only) {
      // Lock the transitive dependencies of the pinned step: deselecting them
      // would leave the pinned step's templates with nothing to render.
      var need = [opts.only];
      var seen = {};
      while (need.length) {
        var id = need.pop();
        if (seen[id]) continue;
        seen[id] = true;
        var f = ST.plan.findStep(base, id);
        if (!f) continue;
        (f.step.dependsOn || []).forEach(function (dep) {
          checked[dep] = true;
          locked[dep] = true;
          need.push(dep);
        });
      }
    }
    // Restored checkbox states, stashed by the select-all / start-from-phase
    // rebuilds below (re-rendering the sheet keeps one source of truth).
    if (lo._checked) {
      Object.keys(checked).forEach(function (id) {
        if (lo._checked[id] !== undefined && !locked[id]) checked[id] = lo._checked[id];
      });
      delete lo._checked;
    }

    var countEl = h("span", { class: "ls-count" });
    function checkedIds() {
      return Object.keys(checked).filter(function (id) { return checked[id]; });
    }
    function refreshCount() {
      var total = ST.plan.flatSteps(base).length;
      countEl.textContent = checkedIds().length + " of " + total + " steps";
    }
    function rebuild() {
      lo._checked = checked;
      closeModal();
      openLaunchSheet(opts);
    }

    // -- left: the will-execute checklist, grouped by phase --------------------
    // stepNotes keeps each row's note span so launch predictions (applied when
    // the plan endpoint answers) can annotate rows after render.
    var list = h("div", { class: "ls-steps" });
    var stepNotes = {};
    (base.phases || []).forEach(function (p, pi) {
      list.appendChild(h("div", { class: "ls-phase" },
        h("span", { class: "ls-pidx", text: String(pi + 1).padStart(2, "0") }),
        h("span", { class: "ls-ptitle", text: p.title || p.id }),
        (p.steps || []).length > 1 ? h("span", { class: "ls-pmeta", text: p.steps.length + " steps · parallel" }) : null
      ));
      (p.steps || []).forEach(function (s) {
        var box = h("input", { type: "checkbox" });
        box.checked = !!checked[s.id];
        box.disabled = !!locked[s.id];
        var note = null;
        if (ST.plan.isDisabledWhen(s.when)) note = "disabled in the plan — stays skipped";
        else if (locked[s.id]) note = "required by " + opts.only;
        else if (s.kind === "gate" && (s.onFalse === "fail" || s.onFalse === "stop")) note = "halts the run on fail";
        else if (s.kind === "approval") note = "waits for approval";
        else if (s.kind === "workflow") note = "sub-workflow → " + s.workflow;
        else if (s.loopTo) note = "loop → " + s.loopTo;
        var noteEl = h("span", { class: "ls-note", text: note || "" });
        var row = h("label", { class: "ls-step" + (locked[s.id] ? " locked" : "") + (box.checked ? "" : " off") },
          box,
          h("span", { class: "ls-sid", text: s.id }),
          noteEl
        );
        stepNotes[s.id] = { row: row, noteEl: noteEl, base: note };
        box.addEventListener("change", function () {
          checked[s.id] = box.checked;
          row.classList.toggle("off", !box.checked);
          refreshCount();
        });
        list.appendChild(row);
      });
    });
    refreshCount();

    var fromPhaseSel = selectEl(
      [{ value: "", label: "start from phase…" }].concat((base.phases || []).map(function (p, i) {
        return { value: String(i), label: "start at " + String(i + 1).padStart(2, "0") + " · " + (p.title || p.id) };
      })), "", function () {
        if (fromPhaseSel.value === "") return;
        var cut = Number(fromPhaseSel.value);
        (base.phases || []).forEach(function (p, i) {
          (p.steps || []).forEach(function (s) {
            if (locked[s.id]) return;
            checked[s.id] = i >= cut;
          });
        });
        rebuild();
      });

    var leftCol = h("div", { class: "ls-left" },
      h("div", { class: "ls-colhead" }, h("span", { class: "ls-label", text: "Will execute" }), countEl),
      list,
      h("div", { class: "ls-leftfoot" },
        h("button", { class: "btn ghost", type: "button", text: "select all", onClick: function () {
          ST.plan.flatSteps(base).forEach(function (f) { if (!locked[f.step.id]) checked[f.step.id] = true; });
          rebuild();
        } }),
        fromPhaseSel
      )
    );

    // -- right: options + warnings + estimate ----------------------------------
    // toggle() returns the row plus a setHint() so launch predictions (which
    // arrive async from the plan endpoint) can rewrite a hint after render.
    function toggle(labelText, hint, on, warn, onFlip) {
      var btn = h("button", {
        class: "ls-toggle" + (on ? " on" : ""), type: "button", role: "switch",
        "aria-checked": on ? "true" : "false"
      }, h("i"));
      btn.addEventListener("click", function () {
        on = !on;
        btn.classList.toggle("on", on);
        btn.setAttribute("aria-checked", on ? "true" : "false");
        onFlip(on);
      });
      var hintEl = h("div", { class: "ls-opthint" + (warn ? " warn" : ""), text: hint });
      var el = h("div", { class: "ls-opt" },
        h("div", { class: "ls-optcopy" },
          h("div", { class: "ls-opttitle", text: labelText }),
          hintEl),
        btn);
      return { el: el, setHint: function (text, isWarn) { hintEl.textContent = text; hintEl.classList.toggle("warn", !!isWarn); } };
    }

    var budgetInput = h("input", { class: "txt ls-budget", type: "text", placeholder: "no cap",
      value: lo.budget || (base.maxCostUsd ? String(base.maxCostUsd) : "") });
    budgetInput.addEventListener("input", function () { lo.budget = budgetInput.value; });

    var freshTgl = toggle("Fresh worktrees", "checking for retained worktrees…", lo.freshWorktrees, false, function (v) { lo.freshWorktrees = v; });
    var reuseTgl = toggle("Reuse cached step results", "matching steps replay their last result instead of re-running", lo.reuseCache, false, function (v) { lo.reuseCache = v; applyPredictions(); });

    // Per-run cap on parallel steps — the engine's MAX_CONCURRENCY is 16.
    // 0 in lo.maxParallel means "unset": the run uses the config default, so
    // nothing is sent; the select still shows that default once the plan's
    // `launch.runners.limit` arrives. The `|| 5` placeholder is
    // DEFAULT_CONFIG.maxConcurrency, so the sheet never shows a value the run
    // would not actually use.
    var parallelOpts = [];
    for (var pn = 1; pn <= 16; pn++) parallelOpts.push({ value: String(pn), label: String(pn) });
    var parallelSel = selectEl(parallelOpts, String(lo.maxParallel || 5), function () {
      lo.maxParallel = Number(parallelSel.value);
    });
    var parallelHint = h("div", { class: "ls-opthint", text: "steps in a phase run at once, up to this" });
    var parallelOpt = h("div", { class: "ls-opt" },
      h("div", { class: "ls-optcopy" },
        h("div", { class: "ls-opttitle", text: "Max parallel runners" }),
        parallelHint),
      parallelSel);

    var optsBox = h("div", { class: "ls-opts" },
      h("div", { class: "ls-label", text: "Options" }),
      freshTgl.el,
      reuseTgl.el,
      parallelOpt,
      toggle("Detach after start", "the run continues in a background process if this window closes", lo.detach, false, function (v) { lo.detach = v; }).el,
      h("div", { class: "ls-opt" },
        h("div", { class: "ls-optcopy" },
          h("div", { class: "ls-opttitle", text: "Budget cap" }),
          h("div", { class: "ls-opthint", text: "stops scheduling new steps when spend reaches this (USD)" })),
        budgetInput)
    );

    // -- launch predictions (02.2) ----------------------------------------------
    // `pred` is the plan endpoint's `launch` block: cachedSteps, stepIssues
    // (steps that would block dispatch), the retained worktrees the Fresh
    // toggle would discard, and runner readiness. Applied when it lands and
    // re-applied when the reuse toggle flips (cached notes come and go).
    var pred = null;
    function applyPredictions() {
      var issues = {};
      var cached = {};
      if (pred) {
        (pred.stepIssues || []).forEach(function (i) { issues[i.stepId] = i.issue; });
        (pred.cachedSteps || []).forEach(function (id) { cached[id] = true; });
      }
      Object.keys(stepNotes).forEach(function (id) {
        var ent = stepNotes[id];
        var note = ent.base;
        ent.row.classList.remove("blocked", "cached");
        if (issues[id]) { note = issues[id]; ent.row.classList.add("blocked"); }
        else if (cached[id] && lo.reuseCache) { note = "cached — replayed, not re-run"; ent.row.classList.add("cached"); }
        ent.noteEl.textContent = note || "";
      });
      if (!pred) return;
      var wt = pred.worktrees;
      freshTgl.setHint(wt
        ? "discard the " + wt.count + " tree" + (wt.count === 1 ? "" : "s") + " from run " + String(wt.runId).slice(0, 5)
        : "no retained worktrees to discard", false);
      var n = (pred.cachedSteps || []).length;
      reuseTgl.setHint(lo.reuseCache && n
        ? n + " step" + (n === 1 ? "" : "s") + " would be reused, not re-run"
        : "matching steps replay their last result instead of re-running", lo.reuseCache && n > 0);
      if (pred.runners) {
        parallelHint.textContent = pred.runners.ready + " runner" + (pred.runners.ready === 1 ? "" : "s") + " ready";
        if (!lo.maxParallel) parallelSel.value = String(pred.runners.limit);
      }
    }

    var edits = ST.plan.dirtySummary();
    if (edits.length) {
      optsBox.appendChild(h("div", { class: "ls-unsaved" },
        h("span", { class: "ls-warnicon", text: "⚠" }),
        h("div", null,
          h("div", { class: "ls-unsaved-title", text: edits.length + " unsaved plan edit" + (edits.length === 1 ? "" : "s") + " will be used for this run." }),
          h("div", { class: "ls-unsaved-list" },
            document.createTextNode(edits.slice(0, 3).join(", ") + (edits.length > 3 ? " · +" + (edits.length - 3) + " more" : "") + " · "),
            h("button", { class: "lnkbtn", type: "button", text: "save to file first", onClick: function () {
              closeModal();
              ST.plan.save(false);
            } })
          )
        )
      ));
    }

    var estimateEl = h("div", { class: "ls-estimate", text: "estimating…" });
    var rightCol = h("div", { class: "ls-right" }, optsBox);

    // -- footer ------------------------------------------------------------------
    var startBtn = h("button", { class: "btn primary", type: "button" }, "Start run", h("span", { class: "kbd", text: "⏎" }));
    var dryBtn = h("button", { class: "btn", type: "button", text: "Dry run", onClick: function () {
      closeModal();
      ST.run.startPlan();
    } });
    var foot = h("div", { class: "mfoot ls-foot" },
      estimateEl,
      h("div", { class: "spacer" }),
      dryBtn,
      startBtn
    );

    var body = h("div", { class: "ls-cols" }, leftCol, rightCol);
    var gitNote = S.project && S.project.name ? S.project.name : "this project";
    openModal(modalShell("Run " + S.selected, gitNote + " · unsaved edits run as-is", body, foot, true));

    // Enter anywhere in the sheet starts the run (esc already closes it).
    startBtn.addEventListener("click", doStart);
    var modalEl = document.getElementById("modal");
    if (modalEl) {
      modalEl.addEventListener("keydown", function (e) {
        if (e.key === "Enter" && e.target.tagName !== "TEXTAREA" && e.target.tagName !== "INPUT") {
          e.preventDefault();
          doStart();
        }
      });
    }

    // -- estimate: the plan endpoint's history context, over the draft ---------
    // The predictions below (stepIssues, runner readiness) are computed from the
    // server's health snapshot, so under the "On launch" cadence the re-probe
    // has to finish first — otherwise the sheet would report readiness from
    // whenever the tab was opened. Under "Manual" this resolves immediately.
    var planPayload = { input: input };
    var draft = ST.plan.draftIfDirty();
    if (draft) planPayload.spec = draft;
    var probed = ST.recheckHealthOnLaunch ? ST.recheckHealthOnLaunch() : Promise.resolve();
    probed.then(function () {
      if (!document.getElementById("modal")) return null; // sheet closed while probing
      return apiAuth("POST", "/api/workflows/" + encodeURIComponent(S.selected) + "/plan", planPayload);
    }).then(function (r) {
      if (!r) return;
      if (!document.getElementById("modal")) return; // sheet already closed
      if (r.status !== 200) { estimateEl.textContent = "no estimate — " + ((r.body && r.body.error) || "plan failed"); return; }
      pred = r.body.launch || null;
      applyPredictions();
      var hist = r.body.history;
      if (hist && hist.runs) {
        estimateEl.textContent = "estimate $" + hist.minCostUsd.toFixed(3) + "–" + hist.maxCostUsd.toFixed(3) +
          " · ~" + ST.fmtElapsed(hist.avgDurationMs) + " · from " + hist.runs + " completed run" + (hist.runs === 1 ? "" : "s");
      } else {
        estimateEl.textContent = "no completed runs yet — no estimate";
      }
    }).catch(function () { estimateEl.textContent = "estimate unavailable"; });

    function doStart() {
      var skip = ST.plan.flatSteps(base).map(function (f) { return f.step.id; })
        .filter(function (id) { return !checked[id]; });
      var budget = parseFloat(lo.budget);
      var runSpec = ST.plan.buildRunSpec({ skip: skip, budgetUsd: isFinite(budget) && budget > 0 ? budget : null });
      if (!runSpec) { ST.run.setBanner("no spec to run", "err"); return; }
      closeModal();
      ST.run.launchRun({
        spec: runSpec,
        freshCache: !lo.reuseCache,
        freshWorktrees: lo.freshWorktrees,
        maxParallel: lo.maxParallel,
        detach: lo.detach
      });
    }
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
    mbanner: mbanner,
    modalShell: modalShell,
    modelOptionsWith: modelOptionsWith,
    openCreate: openCreate,
    openEditor: openEditor,
    openLaunchSheet: openLaunchSheet,
    openModal: openModal,
    openRetryRetargetModal: openRetryRetargetModal,
    preferredAgent: preferredAgent,
    reloadCatalog: reloadCatalog,
    rerunHistory: rerunHistory,
    safeExternalLink: safeExternalLink,
    selectEl: selectEl,
    trapModalFocus: trapModalFocus,
  };
})(window.Steamtrain);
