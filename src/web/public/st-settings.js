/**
 * Settings surface: the project config modal and the setup (doctor) panel.
 */
(function (ST) {
  "use strict";
  var S = ST.state;
  var h = ST.h;
  var agentById = ST.agentById;
  var agentHealthMeta = ST.agentHealthMeta;
  var apiAuth = ST.apiAuth;
  var apiHealthMeta = ST.apiHealthMeta;
  var apiInstanceById = ST.apiInstanceById;
  var applyHealth = ST.applyHealth;
  var clear = ST.clear;
  var copyFix = ST.copyFix;
  var cssEscape = ST.cssEscape;
  var isReadOnly = ST.isReadOnly;
  var pollDoctor = ST.pollDoctor;
  var refreshWorkflowList = ST.refreshWorkflowList;

  function openConfigModal() {
    if (isReadOnly()) { ST.run.setBanner("This session is read-only — viewing only.", "info"); return; }
    if (!S.projectConfig) { ST.run.setBanner("config is not available", "info"); return; }
    var canGlobal = S.projectConfig.canGlobal !== false;
    var defaultScope = canGlobal ? "user" : "project";
    var stepMin = Math.round((S.projectConfig.stepTimeoutSec || 900) / 60);
    var wfMin = S.projectConfig.workflowTimeoutSec
      ? Math.round(S.projectConfig.workflowTimeoutSec / 60)
      : "";
    var stepInput = h("input", { class: "txt", type: "number", min: "1", value: String(stepMin) });
    var wfInput = h("input", { class: "txt", type: "number", min: "1", placeholder: "auto (steps × step)", value: wfMin });
    var autoChk = h("input", { type: "checkbox", checked: !S.projectConfig.workflowTimeoutSec });
    var banner = h("div", { class: "mbanner" });
    var agentRows = [];
    var agentList = h("div", { class: "agentcfg" });
    function instanceScopeOptions() {
      if (!canGlobal) {
        return [{ value: "project", label: "config file" }];
      }
      return [
        { value: "user", label: "Global (~/.steamtrain/config.json)" },
        { value: "project", label: "Project (./steamtrain.json)" }
      ];
    }
    function renderAgentConfigRows() {
      clear(agentList);
      agentRows = [];
      var agents = S.projectConfig.agents || [];
      if (!agents.length) {
        agentList.appendChild(h("div", { class: "empty-state" },
          h("p", { text: "No agents configured yet. Add an agent below — new entries save to global config by default." })
        ));
        return;
      }
      agents.forEach(function (a) {
        var originalId = a.id;
        var meta = agentById(a.id);
        var enabled = h("input", { type: "checkbox", checked: a.enabled !== false });
        var id = h("input", { class: "txt", value: a.id || "" });
        var label = h("input", { class: "txt", placeholder: "optional display label", value: a.label || "" });
        var provider = ST.modals.selectEl([
          { value: "claude", label: "claude" },
          { value: "opencode", label: "opencode" },
          { value: "codex", label: "codex" },
          { value: "amp", label: "amp" },
          { value: "kiro", label: "kiro" },
          { value: "mimo", label: "mimo" },
          { value: "kimi", label: "kimi" },
          { value: "cursor", label: "cursor" },
          { value: "antigravity", label: "antigravity" }
        ], a.provider || "claude");
        var binary = h("input", { class: "txt", placeholder: "default binary", value: a.binary || "" });
        var env = h("textarea", { class: "ta mini", placeholder: "env JSON", rows: "2" });
        env.value = a.env ? JSON.stringify(a.env) : "";
        var extraArgs = h("textarea", { class: "ta mini", placeholder: "[]", rows: "2" });
        extraArgs.value = JSON.stringify(a.extraArgs || []);
        var defaultModel = ST.modals.buildModelSelect(a);
        var scope = ST.modals.selectEl(instanceScopeOptions(), a.scope === "project" ? "project" : defaultScope);
        var row = { enabled: enabled, id: id, label: label, provider: provider, binary: binary, env: env, extraArgs: extraArgs, defaultModel: defaultModel, scope: scope };
        agentRows.push(row);

        // Health dot
        var healthy = meta ? meta.healthy : null;
        var healthDot = h("span", { class: "health-dot " + (healthy === true ? "ok" : healthy === false ? "err" : "unknown") });

        // Provider tag (synced with select)
        var providerTag = h("span", { class: "provider-tag", text: a.provider || "claude" });
        var scopeTag = h("span", { class: "provider-tag", text: scope.value === "project" ? "project" : "global" });

        // Delete button
        var deleteBtn = h("button", { class: "agent-delete", title: "Remove agent", text: "\u00d7" });
        deleteBtn.addEventListener("click", function () {
          var labelText = id.value.trim() || originalId;
          if (!window.confirm("Remove agent \"" + labelText + "\" from config?")) return;
          var list = S.projectConfig.agents || [];
          var i = list.findIndex(function (x) { return x.id === originalId && (x.scope || defaultScope) === (a.scope || defaultScope); });
          if (i < 0) i = list.findIndex(function (x) { return x.id === originalId; });
          if (i >= 0) list.splice(i, 1);
          renderAgentConfigRows();
        });

        // Header row: checkbox + ID label + provider tag + health dot + delete
        var idLabel = h("span", { text: id.value.trim() || "new agent" });
        var header = h("div", { class: "agentrow-header" },
          h("label", null, enabled, idLabel),
          providerTag,
          scopeTag,
          healthDot,
          deleteBtn
        );
        id.addEventListener("input", function () {
          idLabel.textContent = id.value.trim() || "new agent";
        });

        // Enabled checkbox toggles row opacity
        enabled.addEventListener("change", function () {
          rowEl.classList.toggle("disabled", !enabled.checked);
        });

        // Provider change: sync tag and rebuild model select
        provider.addEventListener("change", function () {
          providerTag.textContent = provider.value;
          var currentModel = row.defaultModel.value;
          var newDefaultModel = ST.modals.buildModelSelect({ id: id.value.trim(), provider: provider.value, defaultModel: currentModel });
          var modelField = rowEl.querySelector(".field-model");
          if (modelField) {
            var oldSelect = modelField.querySelector("select");
            if (oldSelect) modelField.replaceChild(newDefaultModel, oldSelect);
          }
          row.defaultModel = newDefaultModel;
        });
        scope.addEventListener("change", function () {
          scopeTag.textContent = scope.value === "project" ? "project" : "global";
        });

        // Build row DOM (field() with 5th arg enables inline validation error display)
        var rowEl = h("div", { class: "agentrow" + (enabled.checked ? "" : " disabled") },
          header,
          ST.modals.field("ID", id, null, null, true),
          ST.modals.field("Provider", provider),
          ST.modals.field("Scope", scope, canGlobal
            ? "Global is the default (every project). Project writes to ./steamtrain.json."
            : "Running with a custom --config file; there is no separate global layer."),
          ST.modals.field("Label", label),
          ST.modals.field("Binary", binary),
          ST.modals.field("Env", env, "JSON object, merged into process env.", null, true),
          ST.modals.field("Extra args", extraArgs, "JSON array of flags appended before the prompt.", null, true),
          ST.modals.field("Default model", defaultModel, "Model ID or leave empty for provider default.", "field-model")
        );
        agentList.appendChild(rowEl);

        // Inline validation — wired AFTER field() so _fieldError is set
        ST.modals.addBlurValidation(id, function () {
          var v = id.value.trim();
          if (!v) return "Agent ID is required";
          var scopeVal = scope.value;
          var dup = agentRows.filter(function (r) { return r !== row; }).some(function (r) {
            return r.id.value.trim() === v && r.scope.value === scopeVal;
          });
          if (dup) return "Duplicate agent ID in this scope";
          return null;
        });
        ST.modals.addBlurValidation(env, function () {
          var v = env.value.trim();
          if (!v) return null;
          try { var p = JSON.parse(v); if (!p || Array.isArray(p) || typeof p !== "object") return "Must be a JSON object"; }
          catch (e) { return "Invalid JSON"; }
          return null;
        });
        ST.modals.addBlurValidation(extraArgs, function () {
          var v = extraArgs.value.trim();
          if (!v) return null;
          try {
            var p = JSON.parse(v);
            if (!Array.isArray(p)) return "Must be a JSON array";
            if (p.some(function (x) { return typeof x !== "string"; })) return "Array must contain only strings";
          } catch (e) { return "Invalid JSON"; }
          return null;
        });
      });
    }
    function addAgentRow() {
      var fallback = ST.modals.preferredAgent();
      var provider = fallback ? fallback.provider : "claude";
      var binary = fallback ? fallback.binary : provider;
      var agentId = fallback ? provider + "-fork" : "new-agent";
      var agents = S.projectConfig.agents || [];
      var n = 2;
      while (agents.some(function (a) { return a.id === agentId; })) {
        agentId = (fallback ? provider + "-fork" : "new-agent") + "-" + n++;
      }
      S.projectConfig.agents = agents.concat([{
        id: agentId,
        provider: provider,
        enabled: true,
        binary: binary,
        scope: defaultScope
      }]);
      renderAgentConfigRows();
    }
    renderAgentConfigRows();

    // ---- APIs (direct llm steps): same row pattern as the agents above ----
    var apiRows = [];
    var apiList = h("div", { class: "agentcfg" });
    function renderApiConfigRows() {
      clear(apiList);
      apiRows = [];
      var apis = S.projectConfig.apis || [];
      if (!apis.length) {
        apiList.appendChild(h("div", { class: "empty-state" },
          h("p", { text: "No APIs configured. llm steps use the built-in anthropic/openai instances; add one to point at a proxy or another provider. New entries save to global config by default." })
        ));
        return;
      }
      apis.forEach(function (a) {
        var originalId = a.id;
        var meta = apiInstanceById(a.id);
        var enabled = h("input", { type: "checkbox", checked: a.enabled !== false });
        var id = h("input", { class: "txt", value: a.id || "" });
        var label = h("input", { class: "txt", placeholder: "optional display label", value: a.label || "" });
        var provider = ST.modals.selectEl([
          { value: "anthropic", label: "anthropic" },
          { value: "openai", label: "openai (compatible)" }
        ], a.provider || "anthropic");
        var baseUrl = h("input", { class: "txt", placeholder: "provider default (openai style: include /v1)", value: a.baseUrl || "" });
        var apiKeyEnv = h("input", { class: "txt", placeholder: a.provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY", value: a.apiKeyEnv || "" });
        var defaultModel = h("input", { class: "txt", placeholder: "used when a step omits model", value: a.defaultModel || "" });
        var pricing = h("textarea", { class: "ta mini", placeholder: '{"inputPerMTok": 5, "outputPerMTok": 25}', rows: "2" });
        pricing.value = a.pricing ? JSON.stringify(a.pricing) : "";
        var scope = ST.modals.selectEl(instanceScopeOptions(), a.scope === "project" ? "project" : defaultScope);
        var row = { enabled: enabled, id: id, label: label, provider: provider, baseUrl: baseUrl, apiKeyEnv: apiKeyEnv, defaultModel: defaultModel, pricing: pricing, scope: scope };
        apiRows.push(row);

        var healthy = meta ? meta.healthy : null;
        var healthDot = h("span", { class: "health-dot " + (healthy === true ? "ok" : healthy === false ? "err" : "unknown") });
        var providerTag = h("span", { class: "provider-tag", text: a.provider || "anthropic" });
        var scopeTag = h("span", { class: "provider-tag", text: scope.value === "project" ? "project" : "global" });

        var deleteBtn = h("button", { class: "agent-delete", title: "Remove API", text: "×" });
        deleteBtn.addEventListener("click", function () {
          var name = id.value.trim() || originalId;
          if (!window.confirm("Remove API \"" + name + "\" from config?")) return;
          var list = S.projectConfig.apis || [];
          var i = list.findIndex(function (x) { return x.id === originalId && (x.scope || defaultScope) === (a.scope || defaultScope); });
          if (i < 0) i = list.findIndex(function (x) { return x.id === originalId; });
          if (i >= 0) list.splice(i, 1);
          renderApiConfigRows();
        });

        var idLabel = h("span", { text: id.value.trim() || "new api" });
        var header = h("div", { class: "agentrow-header" },
          h("label", null, enabled, idLabel),
          providerTag,
          scopeTag,
          healthDot,
          deleteBtn
        );
        id.addEventListener("input", function () {
          idLabel.textContent = id.value.trim() || "new api";
        });
        enabled.addEventListener("change", function () {
          rowEl.classList.toggle("disabled", !enabled.checked);
        });
        provider.addEventListener("change", function () {
          providerTag.textContent = provider.value;
          apiKeyEnv.placeholder = provider.value === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";
        });
        scope.addEventListener("change", function () {
          scopeTag.textContent = scope.value === "project" ? "project" : "global";
        });

        var rowEl = h("div", { class: "agentrow" + (enabled.checked ? "" : " disabled") },
          header,
          ST.modals.field("ID", id, null, null, true),
          ST.modals.field("Provider", provider, "API dialect: Anthropic Messages, or OpenAI chat-completions (Groq, Together, Ollama, vLLM, proxies)."),
          ST.modals.field("Scope", scope, canGlobal
            ? "Global is the default (every project). Project writes to ./steamtrain.json."
            : "Running with a custom --config file; there is no separate global layer."),
          ST.modals.field("Label", label),
          ST.modals.field("Base URL", baseUrl, "Endpoint override for proxies and compatible providers."),
          ST.modals.field("Key env var", apiKeyEnv, "Environment variable the API key is read from (the key itself is never stored)."),
          ST.modals.field("Default model", defaultModel, "Steps referencing this API inherit it when they omit model."),
          ST.modals.field("Pricing", pricing, "JSON per-MTok USD rates applied to steps without their own pricing.", null, true)
        );
        apiList.appendChild(rowEl);

        ST.modals.addBlurValidation(id, function () {
          var v = id.value.trim();
          if (!v) return "API ID is required";
          var scopeVal = scope.value;
          var dup = apiRows.filter(function (r) { return r !== row; }).some(function (r) {
            return r.id.value.trim() === v && r.scope.value === scopeVal;
          });
          if (dup) return "Duplicate API ID in this scope";
          return null;
        });
        ST.modals.addBlurValidation(pricing, function () {
          var v = pricing.value.trim();
          if (!v) return null;
          try { var p = JSON.parse(v); if (!p || Array.isArray(p) || typeof p !== "object") return "Must be a JSON object"; }
          catch (e) { return "Invalid JSON"; }
          return null;
        });
      });
    }
    function addApiRow() {
      var apiId = "new-api";
      var apis = S.projectConfig.apis || [];
      var n = 2;
      while (apis.some(function (a) { return a.id === apiId; })) apiId = "new-api-" + n++;
      S.projectConfig.apis = apis.concat([{ id: apiId, provider: "anthropic", enabled: true, scope: defaultScope }]);
      renderApiConfigRows();
    }
    renderApiConfigRows();
    // Configure edits the instances (add a fork, override a binary, set env);
    // the setup panel shows live health and the fix for anything not ready. Lead
    // with the agents — the modal's main job — and cross-link to setup up top.
    var setupLink = h("button", {
      class: "btn small", type: "button", text: "Check readiness & fixes →",
      title: "See each agent/API's live status and how to fix what isn't ready",
      onClick: function () { ST.modals.closeModal(); openSetupPanel(); }
    });
    var body = h("div", null,
      banner,
      h("div", { class: "config-toplink" }, setupLink),
      h("div", { class: "field" },
        h("label", { text: "Agents" }),
        h("div", { class: "help", text: "Coding-agent CLIs steamtrain drives. Only enabled agents appear in pickers and health outside this page. New agents default to global (~/.steamtrain/config.json)." }),
        agentList,
        h("button", { class: "btn small", text: "+ Add agent", onClick: addAgentRow })),
      h("hr"),
      h("div", { class: "field" },
        h("label", { text: "APIs (direct llm steps)" }),
        h("div", { class: "help", text: "Endpoint instances llm steps call via api: <id>. New APIs default to global config, same as agents." }),
        apiList,
        h("button", { class: "btn small", text: "+ Add API", onClick: addApiRow })),
      h("hr"),
      ST.modals.field("Step timeout (minutes)", stepInput, "Per-agent subprocess limit (default 15). Saved to ./steamtrain.json."),
      ST.modals.field("Workflow timeout (minutes)", wfInput, "Whole-run limit. Leave empty or check auto to use steps × step timeout. Saved to ./steamtrain.json."),
      h("label", { style: "display:flex;gap:6px;align-items:center;margin-top:8px" },
        autoChk, h("span", { text: "Auto workflow timeout (steps × step)" }))
    );
    var saveBtn = h("button", { class: "btn primary", text: "Save" });
  saveBtn.addEventListener("click", function () {
      var stepSec = Number(stepInput.value) * 60;
      if (!stepSec || stepSec <= 0) { ST.modals.mbanner(banner, "step timeout must be a positive number of minutes", "err"); return; }
      if (agentList.querySelector(".invalid") || apiList.querySelector(".invalid")) { ST.modals.mbanner(banner, "Fix validation errors before saving", "err"); return; }
      var agents;
      var apis;
      try {
        agents = collectAgentConfigRows(agentRows);
        apis = collectApiConfigRows(apiRows);
      } catch (e) {
        ST.modals.mbanner(banner, e.message || String(e), "err");
        return;
      }
      var payload = { stepTimeoutSec: stepSec, agents: agents, apis: apis };
      if (autoChk.checked) payload.clearWorkflowTimeout = true;
      else {
        var wfSec = Number(wfInput.value) * 60;
        if (!wfSec || wfSec <= 0) { ST.modals.mbanner(banner, "workflow timeout must be a positive number of minutes", "err"); return; }
        payload.workflowTimeoutSec = wfSec;
      }
      saveBtn.disabled = true;
      apiAuth("PUT", "/api/config", payload).then(function (r) {
        saveBtn.disabled = false;
        if (r.status === 200 && r.body.ok) {
          S.projectConfig = Object.assign({}, S.projectConfig, r.body);
          // Catalog (pickers/health) stays on the full meta lists; configured
          // rows for this modal live in r.body.agents / r.body.apis.
          if (r.body.agentCatalog) S.agents = r.body.agentCatalog;
          if (r.body.apiCatalog) S.apis = r.body.apiCatalog;
          ST.modals.closeModal();
          pollDoctor(0);
          ST.run.setBanner("config saved", "info");
        } else {
          ST.modals.mbanner(banner, (r.body && r.body.error) || "save failed", "err");
        }
      });
    });
    ST.modals.openModal(ST.modals.modalShell("Config",
      canGlobal
        ? "Agents & APIs default to ~/.steamtrain/config.json · timeouts to ./steamtrain.json"
        : "Applies to the loaded config file",
      body,
      h("div", { class: "mfoot" },
        h("button", { class: "btn", text: "Cancel", onClick: ST.modals.closeModal }),
        h("div", { class: "spacer" }),
        saveBtn), true));
  }

  function collectAgentConfigRows(rows) {
    var keys = {};
    return rows.map(function (row) {
      var id = row.id.value.trim();
      if (!id) throw new Error("agent id is required");
      var scope = row.scope ? row.scope.value : "user";
      var key = scope + ":" + id;
      if (keys[key]) throw new Error("duplicate agent id in " + scope + " scope: " + id);
      keys[key] = true;
      var envText = row.env.value.trim();
      var env;
      if (envText) {
        env = JSON.parse(envText);
        if (!env || Array.isArray(env) || typeof env !== "object") throw new Error("env for " + id + " must be a JSON object");
      }
      var argsText = row.extraArgs.value.trim();
      var args;
      if (argsText) {
        args = JSON.parse(argsText);
        if (!Array.isArray(args) || args.some(function (arg) { return typeof arg !== "string"; })) {
          throw new Error("extra args for " + id + " must be a JSON string array");
        }
      }
      return {
        id: id,
        provider: row.provider.value,
        enabled: row.enabled.checked,
        label: row.label.value.trim() || undefined,
        binary: row.binary.value.trim() || undefined,
        env: env,
        extraArgs: args,
        defaultModel: row.defaultModel.value.trim() || undefined,
        scope: scope
      };
    });
  }

  function collectApiConfigRows(rows) {
    var keys = {};
    return rows.map(function (row) {
      var id = row.id.value.trim();
      if (!id) throw new Error("api id is required");
      var scope = row.scope ? row.scope.value : "user";
      var key = scope + ":" + id;
      if (keys[key]) throw new Error("duplicate api id in " + scope + " scope: " + id);
      keys[key] = true;
      var pricingText = row.pricing.value.trim();
      var pricing;
      if (pricingText) {
        pricing = JSON.parse(pricingText);
        if (!pricing || Array.isArray(pricing) || typeof pricing !== "object") throw new Error("pricing for " + id + " must be a JSON object");
      }
      return {
        id: id,
        provider: row.provider.value,
        enabled: row.enabled.checked,
        label: row.label.value.trim() || undefined,
        baseUrl: row.baseUrl.value.trim() || undefined,
        apiKeyEnv: row.apiKeyEnv.value.trim() || undefined,
        defaultModel: row.defaultModel.value.trim() || undefined,
        pricing: pricing,
        scope: scope
      };
    });
  }

  /**
   * The agent & API setup panel: the web analog of `steamtrain init`'s readiness
   * table. Every agent and API endpoint, its live status, and — for anything not
   * ready — the exact fix with a one-click copy, plus a Recheck that re-runs the
   * doctors in place. Opened by clicking any header health chip.
   */
  function openSetupPanel(focusId) {
    var body = h("div", { class: "setup" });
    // Recheck re-runs the probes server-side (POST), so a viewer session — which
    // can't POST — doesn't get a button that would only 403.
    var recheckBtn = isReadOnly()
      ? null
      : h("button", { class: "btn", type: "button", text: "Recheck" });
    var footChildren = recheckBtn ? [recheckBtn] : [];
    if (!isReadOnly()) {
      footChildren.push(h("button", {
        class: "btn", type: "button", text: "Edit config →",
        title: "Add or edit agent/API instances, binaries, and timeouts",
        onClick: function () { ST.modals.closeModal(); openConfigModal(); }
      }));
    }
    footChildren.push(h("div", { class: "spacer" }));
    footChildren.push(h("button", { class: "btn primary", type: "button", text: "Done", onClick: ST.modals.closeModal }));
    var foot = h("div", { class: "mfoot" });
    footChildren.forEach(function (c) { foot.appendChild(c); });

    function statusRow(kind, name, provider, meta, status, extra, detail, fixCommand, id) {
      var head = h("div", { class: "setup-rowhead" },
        h("span", { class: "health-dot " + (status === "ok" ? "ok" : meta.loud ? "err" : "unknown") }),
        h("span", { class: "setup-name", text: name }),
        provider && provider !== name ? h("span", { class: "provider-tag", text: provider }) : null,
        h("span", { class: "setup-status " + (status === "ok" ? "ok" : meta.loud ? "err" : "calm"), text: meta.label }),
        extra ? h("span", { class: "setup-extra", text: extra }) : null
      );
      var children = [head];
      if (status !== "ok" && detail) {
        var fix = h("div", { class: "setup-fix" }, h("span", { class: "setup-fixtext", text: detail }));
        if (fixCommand) {
          var copyBtn = h("button", { class: "btn small", type: "button", text: "Copy" });
          var codeEl = h("code", { text: fixCommand });
          copyBtn.addEventListener("click", function () { copyFix(fixCommand, copyBtn, codeEl); });
          fix.appendChild(h("div", { class: "setup-cmd" }, codeEl, copyBtn));
        }
        children.push(fix);
      }
      var row = h("div", { class: "setup-row" + (id === focusId ? " focus" : "") });
      children.forEach(function (c) { row.appendChild(c); });
      if (id) row.setAttribute("data-setup-id", id);
      return row;
    }

    function renderBody() {
      clear(body);
      var doctor = S.doctor || [];
      var apiDoctor = S.apiDoctor || [];
      if (!doctor.length && !apiDoctor.length) {
        body.appendChild(h("div", { class: "setup-checking" }, "Checking agents and API endpoints…"));
        return;
      }
      var agentsReady = doctor.filter(function (d) { return d.status === "ok"; }).length;
      var apisReady = apiDoctor.filter(function (d) { return d.status === "ok"; }).length;
      body.appendChild(h("div", { class: "setup-summary", text:
        agentsReady + " of " + doctor.length + " agents ready" +
        (apiDoctor.length ? " · " + apisReady + " of " + apiDoctor.length + " API endpoints ready" : "") }));

      body.appendChild(h("div", { class: "setup-sechead" }, "Agents"));
      body.appendChild(h("div", { class: "setup-secnote", text:
        "Coding-agent CLIs steamtrain drives. Install and sign in to the ones you want; the rest can stay unavailable." }));
      var agentWrap = h("div", { class: "setup-list" });
      doctor.slice().sort(setupSort).forEach(function (d) {
        var meta = agentHealthMeta(d.status);
        var extra = d.status === "ok" ? (d.version || "ready") : (d.binaryPath || d.binary || "");
        agentWrap.appendChild(statusRow("agent", d.agent, d.provider, meta, d.status, extra, d.detail, d.fixCommand, d.agent));
      });
      body.appendChild(agentWrap);

      body.appendChild(h("div", { class: "setup-sechead" }, "API endpoints (llm steps)"));
      body.appendChild(h("div", { class: "setup-secnote", text:
        "Direct-inference endpoints llm steps call. Keyless gateways are ready as-is; set a key to enable the others." }));
      var apiWrap = h("div", { class: "setup-list" });
      if (!apiDoctor.length) {
        apiWrap.appendChild(h("div", { class: "setup-secnote", text: "No API endpoints probed yet." }));
      }
      apiDoctor.slice().sort(setupSort).forEach(function (d) {
        var meta = apiHealthMeta(d.status);
        var extra = d.status === "ok" ? (d.message || "ready") : (d.baseUrl || "");
        apiWrap.appendChild(statusRow("api", d.api, d.provider, meta, d.status, extra, d.detail, d.fixCommand, "api:" + d.api));
      });
      body.appendChild(apiWrap);

      if (focusId) {
        var target = body.querySelector('[data-setup-id="' + cssEscape(focusId) + '"]');
        if (target && target.scrollIntoView) setTimeout(function () { target.scrollIntoView({ block: "nearest" }); }, 0);
      }
    }

    // Not-ready first, then by name, so the things needing attention lead.
    function setupSort(a, b) {
      var ak = a.status === "ok" ? 1 : 0, bk = b.status === "ok" ? 1 : 0;
      if (ak !== bk) return ak - bk;
      return String(a.agent || a.api).localeCompare(String(b.agent || b.api));
    }

    if (recheckBtn) {
      recheckBtn.addEventListener("click", function () {
        recheckBtn.disabled = true;
        recheckBtn.textContent = "Rechecking…";
        // POST actually re-runs the doctors on the server (resolves binaries,
        // re-probes endpoints) — a just-installed CLI or fresh login shows up
        // without a restart. GET would only re-read the startup snapshot.
        apiAuth("POST", "/api/doctor").then(function (r) {
          if (r.status === 200) {
            S.doctor = r.body.doctor || [];
            S.apiDoctor = r.body.apis || [];
            ST.shell.renderHealth(S.doctor, S.apiDoctor, r.body.doctorError || null);
            applyHealth();
            refreshWorkflowList();
          }
        }).catch(function () {}).then(function () {
          recheckBtn.disabled = false;
          recheckBtn.textContent = "Recheck";
          renderBody();
        });
      });
    }

    renderBody();
    ST.modals.openModal(ST.modals.modalShell("Agent & API setup",
      "Get each one ready — install, sign in, done. Health refreshes as you go.",
      body, foot, true));
    // Health may still be landing on first open; keep the panel live until it does.
    if (!(S.doctor || []).length && !(S.apiDoctor || []).length) {
      pollDoctor(0, renderBody);
    }
  }


  ST.settings = {
    openConfigModal: openConfigModal,
    openSetupPanel: openSetupPanel,
  };
})(window.Steamtrain);
