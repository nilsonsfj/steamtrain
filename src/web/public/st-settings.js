/**
 * Settings surface: the real settings page (Runners, Limits & budget) that
 * replaces the old config modal + Agent & API setup panel. Lives at its own
 * route (#settings/<section>, see parseRoute/settingsDeepLink in the reducer
 * bundle); st-core.js's router shows/hides it and calls render() on every
 * navigation into it.
 */
(function (ST) {
  "use strict";
  var S = ST.state;
  var h = ST.h;
  var agentHealthMeta = ST.agentHealthMeta;
  var apiAuth = ST.apiAuth;
  var apiHealthMeta = ST.apiHealthMeta;
  var clear = ST.clear;
  var copyFix = ST.copyFix;
  var isReadOnly = ST.isReadOnly;
  var refreshWorkflowList = ST.refreshWorkflowList;

  var SECTIONS = (window.SteamtrainReducer && SteamtrainReducer.SETTINGS_SECTIONS) || ["runners", "limits"];
  // Only these two ship: the source design draws seven, but the other five
  // (model bindings, permissions, access & sharing, notifications, cache &
  // worktrees) have no config API behind them — dead tabs would be worse
  // than omitting them, so they are deliberately not in SETTINGS_SECTIONS.
  var SECTION_META = {
    runners: {
      title: "Runners",
      desc: "Coding-agent CLIs and direct-API endpoints steamtrain drives. Install, sign in, switch one off, or edit a binary, model, or scope — everything here writes to config."
    },
    limits: {
      title: "Limits & budget",
      desc: "Per-step and whole-run time limits. Applies to every workflow that doesn't set its own. (Per-workflow cost caps live in the workflow spec, not here.)"
    }
  };
  // Full product names for providers whose UI short-label differs from the id
  // (e.g. antigravity → agy). Shown only on this settings page. Keep in sync
  // with DEFAULT_AGENT_LABEL in src/agents/config.ts.
  var PROVIDER_PRODUCT_NAME = {
    antigravity: "Antigravity"
  };

  // ---- module state: rebuilt lazily, persists across section switches so a
  // Runners edit survives a trip to Limits and back. -------------------------
  var mountEl = null;
  var activeSection = SECTIONS[0];
  var draft = null;            // { agents: [...], apis: [...] } — editable working copy
  var originalSnapshot = null; // JSON.stringify(draft) at load/last save, for the dirty check
  var configLoading = false;
  var configError = null;
  var editingRow = null;       // { kind: "agent"|"api", id } — which row's inline editor is open
  var runnersBanner = null;
  var runnersNotice = null;    // { text, kind } shown once, then cleared
  var limitsDraft = null;      // { stepMin, wfMin, auto }
  var limitsOriginal = null;
  var limitsNotice = null;
  var limitsSaveBtn = null;
  var limitsDiscardBtn = null;
  var runnersSaveBtn = null;
  var runnersDiscardBtn = null;

  function open(section) {
    var hash = (window.SteamtrainReducer && SteamtrainReducer.settingsDeepLink)
      ? SteamtrainReducer.settingsDeepLink(section)
      : "#settings/" + (section || SECTIONS[0]);
    window.location.hash = hash;
  }

  function render(container, section) {
    mountEl = container;
    activeSection = SECTIONS.indexOf(section) >= 0 ? section : SECTIONS[0];
    editingRow = null;
    if (!draft && !configError && !configLoading && !isReadOnly()) loadConfig();
    // Health may still be landing on first visit (or for a read-only session,
    // which never calls loadConfig at all) — keep the page live until it does.
    if (!(S.doctor || []).length && !(S.apiDoctor || []).length) ST.pollDoctor(0, paint);
    paint();
  }

  function loadConfig() {
    configLoading = true;
    apiAuth("GET", "/api/config").then(function (r) {
      configLoading = false;
      if (r.status === 200 && r.body) {
        S.projectConfig = r.body;
        initDrafts();
      } else {
        configError = (r.body && r.body.error) || "config is not available";
      }
      paint();
    }).catch(function () {
      configLoading = false;
      configError = "network error loading config";
      paint();
    });
  }

  function cloneAgent(a) {
    return {
      id: a.id, provider: a.provider, enabled: a.enabled !== false,
      label: a.label, binary: a.binary,
      env: a.env ? Object.assign({}, a.env) : undefined,
      extraArgs: a.extraArgs ? a.extraArgs.slice() : undefined,
      defaultModel: a.defaultModel, scope: a.scope
    };
  }
  function cloneApi(a) {
    return {
      id: a.id, provider: a.provider, enabled: a.enabled !== false,
      label: a.label, baseUrl: a.baseUrl, apiKeyEnv: a.apiKeyEnv,
      defaultModel: a.defaultModel,
      pricing: a.pricing ? Object.assign({}, a.pricing) : undefined,
      scope: a.scope
    };
  }
  function initDrafts() {
    draft = {
      agents: (S.projectConfig.agents || []).map(cloneAgent),
      apis: (S.projectConfig.apis || []).map(cloneApi),
      maxConcurrency: concurrencyValue()
    };
    originalSnapshot = JSON.stringify(draft);
    limitsDraft = buildLimitsDraft();
    limitsOriginal = JSON.stringify(limitsDraft);
  }
  function buildLimitsDraft() {
    var cfg = S.projectConfig || {};
    var stepMin = Math.round((cfg.stepTimeoutSec || cfg.defaultStepTimeoutSec || 900) / 60);
    var wf = cfg.workflowTimeoutSec;
    return { stepMin: stepMin, wfMin: wf ? Math.round(wf / 60) : "", auto: !wf };
  }
  function agentsDirty() { return Boolean(draft) && JSON.stringify(draft) !== originalSnapshot; }

  // ---- concurrency ceiling ----------------------------------------------------
  // Max steps run in parallel within a phase. The server sends the resolved
  // value plus the bounds it will accept, so the control can never offer a
  // number the config schema would reject.
  function concurrencyBounds() {
    var cfg = S.projectConfig || {};
    var ceiling = Number(cfg.maxConcurrencyCeiling) || 16;
    return { min: 1, max: ceiling, fallback: Number(cfg.defaultMaxConcurrency) || 5 };
  }
  function concurrencyValue() {
    var bounds = concurrencyBounds();
    var cfg = S.projectConfig || {};
    var value = Number(cfg.maxConcurrency) || bounds.fallback;
    return Math.min(bounds.max, Math.max(bounds.min, Math.round(value)));
  }

  function findAgent(id) {
    if (!draft) return null;
    for (var i = 0; i < draft.agents.length; i++) if (draft.agents[i].id === id) return draft.agents[i];
    return null;
  }
  function findApi(id) {
    if (!draft) return null;
    for (var i = 0; i < draft.apis.length; i++) if (draft.apis[i].id === id) return draft.apis[i];
    return null;
  }

  // ---- paint -----------------------------------------------------------------
  function paint() {
    if (!mountEl) return;
    // Footer buttons are rebuilt below; drop the previous paint's nodes so a
    // stray sync can't write to a button that is no longer on the page.
    runnersSaveBtn = null;
    runnersDiscardBtn = null;
    clear(mountEl);
    mountEl.className = "settings";
    mountEl.appendChild(buildNav());
    mountEl.appendChild(buildPane());
  }

  function buildNav() {
    var nav = h("nav", { class: "settings-nav" });
    nav.appendChild(h("div", { class: "head", text: "Settings" }));
    SECTIONS.forEach(function (sec) {
      var meta = SECTION_META[sec] || { title: sec };
      var item = h("button", {
        class: "item" + (sec === activeSection ? " active" : ""),
        type: "button",
        onClick: function () { open(sec); }
      }, meta.title);
      if (sec === "runners") {
        // A section that needs attention says so from the nav, so the reason to
        // open it is visible before you do. Amber is the same "fixable" signal
        // the topbar health chip and the runner rows use.
        var tally = runnerTally();
        if (tally.auth) {
          item.appendChild(h("span", {
            class: "flag", "aria-hidden": "true",
            title: tally.auth + " runner" + (tally.auth === 1 ? "" : "s") + " need sign-in or a valid key"
          }));
        }
        var probed = (S.doctor || []).length + (S.apiDoctor || []).length;
        if (probed) item.appendChild(h("span", { class: "count", text: String(probed) }));
      }
      nav.appendChild(item);
    });
    var canGlobal = !S.projectConfig || S.projectConfig.canGlobal !== false;
    nav.appendChild(h("div", { class: "settings-scope" }, canGlobal
      ? h("span", null,
          "Edits apply to ", h("code", null, "global"), " scope by default. Switching a row to ",
          h("code", null, "project"), " scope writes it into ", h("code", null, "./steamtrain.json"), ".")
      : h("span", { text: "Running with a custom --config file — there is no separate global scope; every edit writes to the loaded config file." })
    ));
    nav.appendChild(buildNavFoot());
    return nav;
  }

  /** Rail footer: which file the edits on this page land in, and what's running. */
  function buildNavFoot() {
    var cfg = S.projectConfig || {};
    var path = cfg.userConfigPath || cfg.configPath;
    var foot = h("div", { class: "settings-navfoot" });
    foot.appendChild(h("div", { class: "path", text: path ? "config: " + path : "config: unknown" }));
    if (cfg.version) foot.appendChild(h("div", { class: "version", text: "v" + cfg.version }));
    return foot;
  }

  function buildPane() {
    var pane = h("div", { class: "settings-pane" });
    var meta = SECTION_META[activeSection] || {};
    var closeBtn = h("button", { class: "btn small", type: "button", text: "Close" });
    closeBtn.addEventListener("click", closeSettings);
    var actions = h("div", { class: "actions" });
    // The section's own verbs sit in its header, next to the title they act on;
    // Save/Discard stay in the footer, where the dirty state is reported.
    if (activeSection === "runners" && !isReadOnly() && draft) {
      var recheckBtn = h("button", { class: "btn small", type: "button", text: "Recheck all" });
      recheckBtn.addEventListener("click", function () { recheck(recheckBtn); });
      var addAgentBtn = h("button", { class: "btn small", type: "button", text: "Add agent" });
      addAgentBtn.addEventListener("click", addAgent);
      var addApiBtn = h("button", { class: "btn small primary", type: "button", text: "Add API" });
      addApiBtn.addEventListener("click", addApi);
      actions.appendChild(recheckBtn);
      actions.appendChild(addAgentBtn);
      actions.appendChild(addApiBtn);
    }
    actions.appendChild(closeBtn);
    pane.appendChild(h("div", { class: "settings-head" },
      h("div", null, h("h2", { text: meta.title || activeSection }), h("p", { text: meta.desc || "" })),
      actions
    ));
    pane.appendChild(activeSection === "limits" ? buildLimitsSection() : buildRunnersSection());
    return pane;
  }

  function closeSettings() {
    ST.closePageRoute();
  }

  // ---- Runners section --------------------------------------------------------
  function buildRunnersSection() {
    var wrap = h("div", null);
    if (isReadOnly()) {
      wrap.appendChild(h("div", { class: "settings-note", text:
        "This session is read-only — runner configuration isn't available to viewers. Showing live readiness only." }));
      wrap.appendChild(buildRunnerTable());
      return wrap;
    }
    if (configLoading && !draft) {
      wrap.appendChild(h("div", { class: "settings-empty", text: "Loading configuration…" }));
      return wrap;
    }
    if (configError) {
      var retryBtn = h("button", { class: "btn small", type: "button", text: "Retry" });
      retryBtn.addEventListener("click", function () { configError = null; loadConfig(); });
      wrap.appendChild(h("div", { class: "settings-note" },
        h("div", { text: "Could not load configuration: " + configError }),
        h("div", { style: "margin-top:8px" }, retryBtn)));
      wrap.appendChild(buildRunnerTable());
      return wrap;
    }
    if (!draft) {
      wrap.appendChild(h("div", { class: "settings-empty", text: "Configuration is not available." }));
      return wrap;
    }
    runnersBanner = h("div", { class: "mbanner" });
    if (runnersNotice) { ST.modals.mbanner(runnersBanner, runnersNotice.text, runnersNotice.kind); runnersNotice = null; }
    wrap.appendChild(runnersBanner);
    wrap.appendChild(buildTallyStrip());
    wrap.appendChild(buildRunnerTable());
    wrap.appendChild(buildRunnerDials());
    wrap.appendChild(buildRunnersFoot());
    return wrap;
  }

  /**
   * How many runners are in each state, over the same rows the table draws so
   * the two can never disagree. `auth` is the fixable bucket (signed out, bad
   * key); `absent` is the resting state of a tool this machine doesn't have.
   */
  function runnerTally() {
    var tally = { ready: 0, auth: 0, absent: 0, off: 0 };
    [["agent", agentRowsData()], ["api", apiRowsData()]].forEach(function (pair) {
      pair[1].forEach(function (row) {
        var rank = rowRank(pair[0], row);
        if (rank === 0) tally.ready++;
        else if (rank === 1) tally.auth++;
        else if (rank === 3) tally.off++;
        else tally.absent++;
      });
    });
    return tally;
  }

  /** The one-line state of the whole runner set, above the table. */
  function buildTallyStrip() {
    var tally = runnerTally();
    var strip = h("div", { class: "runner-tally" });
    function stat(count, label, cls) {
      if (!count) return;
      strip.appendChild(h("span", { class: "stat" + (cls ? " " + cls : "") },
        h("span", { class: "dot" + (cls ? " " + cls : "") }), count + " " + label));
    }
    stat(tally.ready, "ready", "ok");
    stat(tally.auth, "needs auth", "warn");
    stat(tally.absent, "absent");
    stat(tally.off, "disabled");
    if (!tally.ready && !tally.auth && !tally.absent && !tally.off) {
      strip.appendChild(h("span", { class: "stat", text: "No runners probed yet." }));
    }
    if (S.doctorReadAt) {
      strip.appendChild(h("span", { class: "when", text: "read " + ST.relTime(S.doctorReadAt) }));
    }
    return strip;
  }

  function buildCols() {
    return h("div", { class: "runner-cols" },
      h("span", null), h("span", { text: "Name" }), h("span", { text: "Kind" }),
      h("span", { text: "Binary / endpoint" }), h("span", { text: "Default model" }),
      h("span", { text: "Scope" }), h("span", null)
    );
  }

  /**
   * Ready first, then what the user can fix, then the runners they don't use:
   * ready → needs auth → absent/unprobed → disabled. The list reads top-down
   * as "what this machine can run", and the dead weight sinks to the bottom.
   */
  function rowRank(kind, row) {
    if (isDisabled(row)) return 3;
    if (!row.doctor) return 2;
    if (row.doctor.status === "ok") return 0;
    var meta = kind === "agent" ? agentHealthMeta(row.doctor.status) : apiHealthMeta(row.doctor.status);
    return meta.loud ? 1 : 2;
  }
  function sortRows(kind, rows) {
    return rows.sort(function (a, b) {
      var rank = rowRank(kind, a) - rowRank(kind, b);
      if (rank) return rank;
      return String(a.id || "").localeCompare(String(b.id || ""));
    });
  }
  function agentRowsData() {
    var seen = {};
    var rows = (S.doctor || []).map(function (d) {
      seen[d.agent] = true;
      return { id: d.agent, doctor: d, config: findAgent(d.agent) };
    });
    if (draft) {
      draft.agents.forEach(function (c) { if (!seen[c.id]) rows.push({ id: c.id, doctor: null, config: c }); });
    }
    return sortRows("agent", rows);
  }
  function apiRowsData() {
    var seen = {};
    var rows = (S.apiDoctor || []).map(function (d) {
      seen[d.api] = true;
      return { id: d.api, doctor: d, config: findApi(d.api) };
    });
    if (draft) {
      draft.apis.forEach(function (c) { if (!seen[c.id]) rows.push({ id: c.id, doctor: null, config: c }); });
    }
    return sortRows("api", rows);
  }

  function buildRunnerTable() {
    var box = h("div", null);
    box.appendChild(h("div", { class: "runner-sechead", text: "Agents" }));
    var agentRows = agentRowsData();
    if (!agentRows.length) {
      box.appendChild(h("div", { class: "settings-empty", text: "No agents probed yet." }));
    } else {
      box.appendChild(buildCols());
      agentRows.forEach(function (r) { box.appendChild(buildRow("agent", r)); });
    }

    box.appendChild(h("div", { class: "runner-sechead", text: "APIs (direct llm steps)" }));
    var apiRows = apiRowsData();
    if (!apiRows.length) {
      box.appendChild(h("div", { class: "settings-empty", text: "No API endpoints probed yet." }));
    } else {
      box.appendChild(buildCols());
      apiRows.forEach(function (r) { box.appendChild(buildRow("api", r)); });
    }

    return box;
  }

  /**
   * The two dials that govern how runners are used rather than which exist:
   * how many steps may run at once, and how often readiness is re-probed.
   * Drawn as a pair under the table (design 03.2).
   */
  function buildRunnerDials() {
    var bounds = concurrencyBounds();
    var box = h("div", { class: "runner-dials" });

    var readout = h("span", { class: "value", text: String(draft.maxConcurrency) });
    var slider = h("input", {
      class: "slider", type: "range",
      min: String(bounds.min), max: String(bounds.max), step: "1",
      value: String(draft.maxConcurrency),
      "aria-label": "Maximum steps run in parallel"
    });
    slider.addEventListener("input", function () {
      draft.maxConcurrency = Number(slider.value);
      readout.textContent = slider.value;
      syncRunnersFoot();
    });
    box.appendChild(h("div", { class: "dial" },
      h("div", { class: "dial-title", text: "Concurrency" }),
      h("div", { class: "dial-desc", text: "Steps run in parallel within a phase. Applies to every workflow that doesn't set its own." }),
      h("div", { class: "dial-slider" }, slider, readout)
    ));

    var cadence = ST.healthCadence ? ST.healthCadence() : "launch";
    var seg = h("div", { class: "seg", role: "group", "aria-label": "Health check cadence" });
    [
      { id: "manual", label: "Manual", title: "Only re-probe when Recheck all is pressed." },
      { id: "launch", label: "On launch", title: "Re-probe when the launch sheet opens, so skip predictions are current." },
      { id: "every60", label: "Every 60s", title: "Re-probe in the background once a minute." }
    ].forEach(function (opt) {
      var btn = h("button", {
        class: "seg-item" + (cadence === opt.id ? " on" : ""),
        type: "button", text: opt.label, title: opt.title,
        "aria-pressed": cadence === opt.id ? "true" : "false"
      });
      btn.addEventListener("click", function () {
        if (ST.setHealthCadence) ST.setHealthCadence(opt.id);
        paint();
      });
      seg.appendChild(btn);
    });
    box.appendChild(h("div", { class: "dial" },
      h("div", { class: "dial-title", text: "Health checks" }),
      h("div", { class: "dial-desc", text: "How often runner availability is re-probed. Applies to this browser, not to runs." }),
      seg
    ));
    return box;
  }

  function buildRow(kind, rowData) {
    var d = rowData.doctor;
    var cfg = rowData.config;
    var status = d ? d.status : "ok";
    var meta = kind === "agent" ? agentHealthMeta(status) : apiHealthMeta(status);
    // A disabled runner is never probed again, so whatever the doctor last said
    // about it is stale — the row reports "disabled" and nothing else.
    var off = isDisabled(rowData);
    var ready = !off && status === "ok";
    var loud = !off && Boolean(d && meta.loud);
    var absent = !off && Boolean(d && !ready && !loud);

    var provider = cfg ? cfg.provider : (d ? d.provider : "");
    var displayName = (cfg && cfg.label) || (d && d.label) ||
      (kind === "agent" ? ST.agentUiLabel(rowData.id) : rowData.id);
    var productName = PROVIDER_PRODUCT_NAME[provider] || provider;
    var nameText = displayName +
      (productName && productName !== displayName ? " · " + productName : "");

    var binaryText, subParts = [];
    if (kind === "agent") {
      binaryText = (d && (d.binaryPath || d.binary)) || (cfg && cfg.binary) || "(default binary)";
      if (ready && d && d.version) subParts.push(d.version);
      if (cfg && cfg.extraArgs && cfg.extraArgs.length) subParts.push(JSON.stringify(cfg.extraArgs));
    } else {
      binaryText = (cfg && cfg.baseUrl) || (d && d.baseUrl) || "(provider default endpoint)";
      if (cfg && cfg.apiKeyEnv) subParts.push(cfg.apiKeyEnv);
    }
    if (off) subParts.unshift("disabled");
    var detailEl = h("span", { class: "detail" + (loud ? " warn" : "") }, binaryText,
      subParts.length ? h("span", { class: "sub", text: "  " + subParts.join(" · ") }) : null);

    var modelText = (cfg && cfg.defaultModel) || "(provider default)";
    var scopeText = cfg ? (cfg.scope === "project" ? "project" : "global") : "global (default)";

    var row = h("div", { class: "runner-row" + (absent ? " absent" : "") + (off ? " off" : "") },
      h("span", { class: "dot" + (loud ? " err" : "") }),
      h("span", { class: "name", text: nameText }),
      h("span", null, kind),
      detailEl,
      h("span", null, modelText),
      h("span", { class: "scope", text: scopeText }),
      rowActs(kind, rowData, off)
    );

    var container;
    if (loud) {
      var group = h("div", { class: "runner-group needs-auth" }, row, buildFixStrip(d));
      container = h("div", null, group);
    } else {
      container = h("div", null, row);
    }
    if (editingRow && editingRow.kind === kind && editingRow.id === rowData.id) {
      container.appendChild(kind === "agent" ? buildAgentEditor(rowData) : buildApiEditor(rowData));
    }
    return container;
  }

  function buildFixStrip(d) {
    var strip = h("div", { class: "runner-fix" });
    strip.appendChild(h("span", { class: "why", text: d.detail || "Not ready." }));
    if (d.fixCommand) {
      var codeEl = h("code", { text: d.fixCommand });
      var copyBtn = h("button", { class: "btn small", type: "button", text: "Copy" });
      copyBtn.addEventListener("click", function () { copyFix(d.fixCommand, copyBtn, codeEl); });
      strip.appendChild(codeEl);
      strip.appendChild(copyBtn);
    }
    return strip;
  }

  function rowActs(kind, rowData, off) {
    var id = rowData.id;
    var cfg = rowData.config;
    var wrap = h("div", { class: "rowacts" });
    if (isReadOnly() || !draft) return wrap;
    var open = Boolean(editingRow && editingRow.kind === kind && editingRow.id === id);
    var toggleBtn = h("button", {
      type: "button", class: "toggle" + (off ? " off" : ""),
      title: off ? "Enable " + id + " (steps may route to it again)"
        : "Disable " + id + " (hidden from runs and from readiness checks)",
      "aria-pressed": off ? "false" : "true",
      text: off ? "off" : "on"
    });
    // Clicking flips the row: the state it moves to is "enabled" exactly when
    // the row is off right now.
    toggleBtn.addEventListener("click", function () { setRowEnabled(kind, rowData, off === true); });
    wrap.appendChild(toggleBtn);
    var editBtn = h("button", {
      type: "button", class: "act edit" + (open ? " open" : ""),
      title: open ? "Close the editor" : "Edit " + id, text: "Edit"
    });
    editBtn.addEventListener("click", function () {
      editingRow = open ? null : { kind: kind, id: id };
      paint();
    });
    wrap.appendChild(editBtn);
    // Always render remove so every row's action column lines up. Built-ins
    // with no config entry have nothing to delete — clicking explains that
    // (same rule as the TUI agent manager's `d` binding) instead of hiding
    // or greying out the control, which made the column look ragged.
    var delBtn = h("button", {
      type: "button",
      class: "act del",
      text: "×",
      title: cfg
        ? "Remove " + id + " from config"
        : id + " is a built-in default (not in config); disable it instead"
    });
    delBtn.addEventListener("click", function () {
      if (!cfg) {
        runnersNotice = {
          text: "'" + id + "' is a built-in default (not configured); disable it instead",
          kind: "err"
        };
        paint();
        return;
      }
      if (!window.confirm("Remove \"" + id + "\" from config?")) return;
      var list = kind === "agent" ? draft.agents : draft.apis;
      var i = list.findIndex(function (x) { return x.id === id; });
      if (i >= 0) list.splice(i, 1);
      if (editingRow && editingRow.kind === kind && editingRow.id === id) editingRow = null;
      paint();
    });
    wrap.appendChild(delBtn);
    return wrap;
  }

  function isDisabled(rowData) {
    return Boolean(rowData.config && rowData.config.enabled === false);
  }

  /**
   * Move a runner to `nextEnabled`. A built-in with no config entry yet gets a
   * minimal stub (id + provider + scope) so `enabled: false` has somewhere to
   * live — exactly what the TUI's agent/API manager writes. Takes effect on Save.
   */
  function setRowEnabled(kind, rowData, nextEnabled) {
    var entry = kind === "agent" ? findAgent(rowData.id) : findApi(rowData.id);
    if (!entry) {
      var d = rowData.doctor;
      entry = {
        id: rowData.id,
        provider: (d && d.provider) || (kind === "agent" ? "claude" : "anthropic"),
        scope: (S.projectConfig && S.projectConfig.canGlobal === false) ? "project" : "user"
      };
      (kind === "agent" ? draft.agents : draft.apis).push(entry);
    }
    entry.enabled = nextEnabled;
    paint();
  }

  function uniqueId(base, exists) {
    var id = base, n = 2;
    while (exists(id)) id = base + "-" + n++;
    return id;
  }
  function addAgent() {
    var fallback = ST.modals.preferredAgent ? ST.modals.preferredAgent() : null;
    var provider = fallback ? fallback.provider : "claude";
    var id = uniqueId(fallback ? provider + "-fork" : "new-agent", function (candidate) {
      return Boolean(findAgent(candidate)) || (S.doctor || []).some(function (d) { return d.agent === candidate; });
    });
    draft.agents.push({
      id: id, provider: provider, enabled: true,
      scope: (S.projectConfig && S.projectConfig.canGlobal === false) ? "project" : "user"
    });
    editingRow = { kind: "agent", id: id };
    paint();
  }
  function addApi() {
    var id = uniqueId("new-api", function (candidate) {
      return Boolean(findApi(candidate)) || (S.apiDoctor || []).some(function (d) { return d.api === candidate; });
    });
    draft.apis.push({
      id: id, provider: "anthropic", enabled: true,
      scope: (S.projectConfig && S.projectConfig.canGlobal === false) ? "project" : "user"
    });
    editingRow = { kind: "api", id: id };
    paint();
  }

  function setEditorError(errEl, text) {
    errEl.textContent = text;
    errEl.classList.add("show");
  }

  function scopeOptionsFor() {
    var canGlobal = !S.projectConfig || S.projectConfig.canGlobal !== false;
    if (!canGlobal) return [{ value: "project", label: "config file" }];
    return [
      { value: "user", label: "Global (~/.steamtrain/config.json)" },
      { value: "project", label: "Project (./steamtrain.json)" }
    ];
  }

  function buildAgentEditor(rowData) {
    var existing = findAgent(rowData.id);
    var d = rowData.doctor;
    var base = existing || {
      id: rowData.id, provider: (d && d.provider) || "claude",
      binary: (d && (d.binary || d.binaryPath)) || "",
      scope: (S.projectConfig && S.projectConfig.canGlobal === false) ? "project" : "user"
    };
    var idInput = d ? null : h("input", { class: "txt", value: base.id });
    var labelInput = h("input", { class: "txt", value: base.label || "" });
    var binaryInput = h("input", { class: "txt", placeholder: "default binary", value: base.binary || "" });
    var envTa = h("textarea", { class: "ta mini", placeholder: "env JSON", rows: "2" });
    envTa.value = base.env ? JSON.stringify(base.env) : "";
    var argsTa = h("textarea", { class: "ta mini", placeholder: "[]", rows: "2" });
    argsTa.value = base.extraArgs ? JSON.stringify(base.extraArgs) : "";
    var modelSelect = ST.modals.buildModelSelect({ id: rowData.id, provider: base.provider, defaultModel: base.defaultModel });
    var scopeSelect = ST.modals.selectEl(scopeOptionsFor(), base.scope === "project" ? "project" : "user");
    var errEl = h("div", { class: "field-error" });

    var doneBtn = h("button", { class: "btn small primary", type: "button", text: "Done" });
    var cancelBtn = h("button", { class: "btn small", type: "button", text: "Cancel" });
    cancelBtn.addEventListener("click", function () { editingRow = null; paint(); });
    doneBtn.addEventListener("click", function () {
      var newId = idInput ? idInput.value.trim() : rowData.id;
      if (!newId) { setEditorError(errEl, "ID is required"); return; }
      if (newId !== rowData.id && findAgent(newId)) { setEditorError(errEl, "duplicate agent id: " + newId); return; }
      var env, args;
      try {
        var envText = envTa.value.trim();
        env = envText ? JSON.parse(envText) : undefined;
        if (env !== undefined && (Array.isArray(env) || typeof env !== "object")) throw new Error("env must be a JSON object");
      } catch (e) { setEditorError(errEl, "env: " + (e.message || "invalid JSON")); return; }
      try {
        var argsText = argsTa.value.trim();
        args = argsText ? JSON.parse(argsText) : undefined;
        if (args !== undefined && (!Array.isArray(args) || args.some(function (x) { return typeof x !== "string"; }))) {
          throw new Error("must be a JSON string array");
        }
      } catch (e) { setEditorError(errEl, "extra args: " + (e.message || "invalid JSON")); return; }

      var entry = existing || { id: newId, provider: base.provider, enabled: true };
      entry.id = newId;
      entry.label = labelInput.value.trim() || undefined;
      entry.binary = binaryInput.value.trim() || undefined;
      entry.env = env;
      entry.extraArgs = args;
      entry.defaultModel = modelSelect.value || undefined;
      entry.scope = scopeSelect.value;
      if (!existing) draft.agents.push(entry);
      editingRow = null;
      paint();
    });

    return h("div", { class: "runner-edit" },
      idInput ? ST.modals.field("ID", idInput) : null,
      ST.modals.field("Label", labelInput),
      h("div", { class: "row2" },
        ST.modals.field("Binary", binaryInput),
        ST.modals.field("Scope", scopeSelect)),
      h("div", { class: "row2" },
        ST.modals.field("Default model", modelSelect),
        ST.modals.field("Env (JSON object)", envTa)),
      ST.modals.field("Extra args (JSON string array)", argsTa),
      errEl,
      h("div", { class: "edit-actions" }, doneBtn, cancelBtn)
    );
  }

  function buildApiEditor(rowData) {
    var existing = findApi(rowData.id);
    var d = rowData.doctor;
    var base = existing || {
      id: rowData.id, provider: (d && d.provider) || "anthropic",
      baseUrl: (d && d.baseUrl) || "",
      scope: (S.projectConfig && S.projectConfig.canGlobal === false) ? "project" : "user"
    };
    var idInput = d ? null : h("input", { class: "txt", value: base.id });
    var labelInput = h("input", { class: "txt", value: base.label || "" });
    var providerSelect = ST.modals.selectEl([
      { value: "anthropic", label: "anthropic" },
      { value: "openai", label: "openai (compatible)" }
    ], base.provider || "anthropic");
    var baseUrlInput = h("input", { class: "txt", placeholder: "provider default (openai style: include /v1)", value: base.baseUrl || "" });
    var keyEnvInput = h("input", { class: "txt", placeholder: base.provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY", value: base.apiKeyEnv || "" });
    var modelInput = h("input", { class: "txt", placeholder: "used when a step omits model", value: base.defaultModel || "" });
    var pricingTa = h("textarea", { class: "ta mini", placeholder: '{"inputPerMTok": 5, "outputPerMTok": 25}', rows: "2" });
    pricingTa.value = base.pricing ? JSON.stringify(base.pricing) : "";
    var scopeSelect = ST.modals.selectEl(scopeOptionsFor(), base.scope === "project" ? "project" : "user");
    var errEl = h("div", { class: "field-error" });

    providerSelect.addEventListener("change", function () {
      keyEnvInput.placeholder = providerSelect.value === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";
    });

    var doneBtn = h("button", { class: "btn small primary", type: "button", text: "Done" });
    var cancelBtn = h("button", { class: "btn small", type: "button", text: "Cancel" });
    cancelBtn.addEventListener("click", function () { editingRow = null; paint(); });
    doneBtn.addEventListener("click", function () {
      var newId = idInput ? idInput.value.trim() : rowData.id;
      if (!newId) { setEditorError(errEl, "ID is required"); return; }
      if (newId !== rowData.id && findApi(newId)) { setEditorError(errEl, "duplicate api id: " + newId); return; }
      var pricing;
      try {
        var pricingText = pricingTa.value.trim();
        pricing = pricingText ? JSON.parse(pricingText) : undefined;
        if (pricing !== undefined && (Array.isArray(pricing) || typeof pricing !== "object")) throw new Error("must be a JSON object");
      } catch (e) { setEditorError(errEl, "pricing: " + (e.message || "invalid JSON")); return; }

      var entry = existing || { id: newId, provider: providerSelect.value, enabled: true };
      entry.id = newId;
      entry.provider = providerSelect.value;
      entry.label = labelInput.value.trim() || undefined;
      entry.baseUrl = baseUrlInput.value.trim() || undefined;
      entry.apiKeyEnv = keyEnvInput.value.trim() || undefined;
      entry.defaultModel = modelInput.value.trim() || undefined;
      entry.pricing = pricing;
      entry.scope = scopeSelect.value;
      if (!existing) draft.apis.push(entry);
      editingRow = null;
      paint();
    });

    return h("div", { class: "runner-edit" },
      idInput ? ST.modals.field("ID", idInput) : null,
      ST.modals.field("Label", labelInput),
      h("div", { class: "row2" },
        ST.modals.field("Provider", providerSelect),
        ST.modals.field("Scope", scopeSelect)),
      ST.modals.field("Base URL", baseUrlInput),
      h("div", { class: "row2" },
        ST.modals.field("Key env var", keyEnvInput),
        ST.modals.field("Default model", modelInput)),
      ST.modals.field("Pricing (JSON, per-MTok USD)", pricingTa),
      errEl,
      h("div", { class: "edit-actions" }, doneBtn, cancelBtn)
    );
  }

  function buildRunnersFoot() {
    var foot = h("div", { class: "settings-foot" });
    var path = (S.projectConfig || {}).configPath;
    foot.appendChild(h("span", { class: "probed", text: path
      ? "Changes are written to " + path + " when you save."
      : "Changes are written to the config file when you save." }));
    var actions = h("div", { class: "actions" });
    if (!isReadOnly()) {
      runnersDiscardBtn = h("button", { class: "btn small", type: "button", text: "Discard" });
      runnersDiscardBtn.addEventListener("click", function () { draft = JSON.parse(originalSnapshot); paint(); });
      runnersSaveBtn = h("button", { class: "btn small primary", type: "button", text: "Save changes" });
      runnersSaveBtn.addEventListener("click", function () { saveRunners(runnersSaveBtn); });
      actions.appendChild(runnersDiscardBtn);
      actions.appendChild(runnersSaveBtn);
      syncRunnersFoot();
    }
    foot.appendChild(actions);
    return foot;
  }

  /** Keep Save/Discard in step with the draft without repainting the whole page
   *  — the concurrency slider fires on every drag tick. */
  function syncRunnersFoot() {
    var dirty = agentsDirty();
    if (runnersDiscardBtn) runnersDiscardBtn.disabled = !dirty;
    if (runnersSaveBtn) runnersSaveBtn.disabled = !dirty;
  }

  function recheck(btn) {
    btn.disabled = true;
    btn.textContent = "Rechecking…";
    ST.recheckHealth().then(function () { paint(); });
  }

  function saveRunners(btn) {
    btn.disabled = true;
    var payload = { agents: draft.agents, apis: draft.apis };
    // Agents and APIs default to the global file; maxConcurrency is project
    // scoped, so only send it when it actually moved — otherwise every runner
    // save would rewrite steamtrain.json with a value nobody touched.
    if (draft.maxConcurrency !== concurrencyValue()) payload.maxConcurrency = draft.maxConcurrency;
    apiAuth("PUT", "/api/config", payload).then(function (r) {
      btn.disabled = false;
      if (r.status === 200 && r.body && r.body.ok) {
        S.projectConfig = Object.assign({}, S.projectConfig, r.body);
        if (r.body.agentCatalog) S.agents = r.body.agentCatalog;
        if (r.body.apiCatalog) S.apis = r.body.apiCatalog;
        initDrafts();
        runnersNotice = { text: "Saved.", kind: "info" };
        refreshWorkflowList();
      } else {
        runnersNotice = { text: (r.body && r.body.error) || "save failed", kind: "err" };
      }
      paint();
    }).catch(function () {
      btn.disabled = false;
      runnersNotice = { text: "network error saving config", kind: "err" };
      paint();
    });
  }

  // ---- Limits & budget section -------------------------------------------------
  function buildLimitsSection() {
    var wrap = h("div", null);
    if (isReadOnly()) {
      wrap.appendChild(h("div", { class: "settings-note", text: "This session is read-only — limits aren't editable." }));
      var cfg = S.projectConfig;
      if (cfg) {
        wrap.appendChild(h("div", { class: "settings-empty", text:
          "Step timeout: " + Math.round((cfg.stepTimeoutSec || cfg.defaultStepTimeoutSec || 900) / 60) + " min. Workflow timeout: " +
          (cfg.workflowTimeoutSec ? Math.round(cfg.workflowTimeoutSec / 60) + " min" : "auto (steps × step)") }));
      }
      return wrap;
    }
    if (configLoading && !limitsDraft) {
      wrap.appendChild(h("div", { class: "settings-empty", text: "Loading configuration…" }));
      return wrap;
    }
    if (configError) {
      var retryBtn = h("button", { class: "btn small", type: "button", text: "Retry" });
      retryBtn.addEventListener("click", function () { configError = null; loadConfig(); });
      wrap.appendChild(h("div", { class: "settings-note" },
        h("div", { text: "Could not load configuration: " + configError }),
        h("div", { style: "margin-top:8px" }, retryBtn)));
      return wrap;
    }
    if (!limitsDraft) {
      wrap.appendChild(h("div", { class: "settings-empty", text: "Configuration is not available." }));
      return wrap;
    }

    var limitsBanner = h("div", { class: "mbanner" });
    if (limitsNotice) { ST.modals.mbanner(limitsBanner, limitsNotice.text, limitsNotice.kind); limitsNotice = null; }
    wrap.appendChild(limitsBanner);

    var defaultMin = Math.round((S.projectConfig.defaultStepTimeoutSec || 900) / 60);
    var stepInput = h("input", { class: "txt", type: "number", min: "1", value: String(limitsDraft.stepMin) });
    stepInput.addEventListener("input", function () { limitsDraft.stepMin = stepInput.value; syncLimitsFoot(); });
    var wfInput = h("input", {
      class: "txt", type: "number", min: "1", placeholder: "auto (steps × step)",
      value: limitsDraft.wfMin, disabled: Boolean(limitsDraft.auto)
    });
    wfInput.addEventListener("input", function () { limitsDraft.wfMin = wfInput.value; syncLimitsFoot(); });
    var autoChk = h("input", { type: "checkbox", checked: Boolean(limitsDraft.auto) });
    autoChk.addEventListener("change", function () {
      limitsDraft.auto = autoChk.checked;
      wfInput.disabled = autoChk.checked;
      syncLimitsFoot();
    });

    wrap.appendChild(ST.modals.field("Step timeout (minutes)", stepInput,
      "Per-agent subprocess limit. Default " + defaultMin + " min. Saved to ./steamtrain.json."));
    wrap.appendChild(ST.modals.field("Workflow timeout (minutes)", wfInput,
      "Whole-run limit. Auto uses steps × step timeout. Saved to ./steamtrain.json."));
    wrap.appendChild(h("label", { style: "display:flex;gap:6px;align-items:center;margin:-6px 0 4px" },
      autoChk, h("span", { text: "Auto workflow timeout (steps × step)" })));

    var foot = h("div", { class: "settings-foot" });
    foot.appendChild(h("span", { class: "probed" }));
    var actions = h("div", { class: "actions" });
    var discardBtn = h("button", { class: "btn small", type: "button", text: "Discard" });
    discardBtn.addEventListener("click", function () { limitsDraft = JSON.parse(limitsOriginal); paint(); });
    var saveBtn = h("button", { class: "btn small primary", type: "button", text: "Save changes" });
    saveBtn.addEventListener("click", function () { saveLimits(saveBtn); });
    actions.appendChild(discardBtn);
    actions.appendChild(saveBtn);
    foot.appendChild(actions);
    wrap.appendChild(foot);

    limitsDiscardBtn = discardBtn;
    limitsSaveBtn = saveBtn;
    syncLimitsFoot();
    return wrap;
  }

  function syncLimitsFoot() {
    var dirty = JSON.stringify(limitsDraft) !== limitsOriginal;
    if (limitsDiscardBtn) limitsDiscardBtn.disabled = !dirty;
    if (limitsSaveBtn) limitsSaveBtn.disabled = !dirty;
  }

  function saveLimits(btn) {
    var stepSec = Number(limitsDraft.stepMin) * 60;
    if (!stepSec || stepSec <= 0) { limitsNotice = { text: "step timeout must be a positive number of minutes", kind: "err" }; paint(); return; }
    var payload = { stepTimeoutSec: stepSec };
    if (limitsDraft.auto) {
      payload.clearWorkflowTimeout = true;
    } else {
      var wfSec = Number(limitsDraft.wfMin) * 60;
      if (!wfSec || wfSec <= 0) { limitsNotice = { text: "workflow timeout must be a positive number of minutes", kind: "err" }; paint(); return; }
      payload.workflowTimeoutSec = wfSec;
    }
    btn.disabled = true;
    apiAuth("PUT", "/api/config", payload).then(function (r) {
      btn.disabled = false;
      if (r.status === 200 && r.body && r.body.ok) {
        S.projectConfig = Object.assign({}, S.projectConfig, r.body);
        limitsDraft = buildLimitsDraft();
        limitsOriginal = JSON.stringify(limitsDraft);
        limitsNotice = { text: "Saved.", kind: "info" };
      } else {
        limitsNotice = { text: (r.body && r.body.error) || "save failed", kind: "err" };
      }
      paint();
    }).catch(function () {
      btn.disabled = false;
      limitsNotice = { text: "network error saving config", kind: "err" };
      paint();
    });
  }

  ST.settings = {
    render: render,
    open: open
  };
})(window.Steamtrain);
