
(function () {
  "use strict";

  


  var KIND_LABEL = { worker: "worker", processor: "process", distributor: "fan-out", consolidator: "merge", gate: "gate", merge: "merge-back" };
  var S = {
    workflows: [], selected: null, source: null, spec: null, agents: [],
    runId: null, es: null,
    startedAt: 0, timer: null,
    runState: null,
    rafQueued: false, draftAbort: null, doctor: [],
    stagedOverrides: {},
    projectConfig: null
  };

  function h(tag, attrs) {
    var e = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        if (k === "class") e.className = attrs[k];
        else if (k === "text") e.textContent = attrs[k];
        else if (k.indexOf("on") === 0) e.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
        else if (typeof attrs[k] === "boolean" && k in e) e[k] = attrs[k];
        else if (attrs[k] != null) e.setAttribute(k, attrs[k]);
      }
    }
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i];
      if (c == null) continue;
      e.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    }
    return e;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function api(method, path, body) {
    return fetch(path, {
      method: method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined
    }).then(function (r) { return r.json().then(function (j) { return { status: r.status, body: j }; }); });
  }

  // ---- workflow catalog ----------------------------------------------------
  function loadWorkflows() {
    api("GET", "/api/workflows").then(function (r) {
      S.workflows = r.body.workflows || [];
      if (r.body.configLabel) document.getElementById("config").textContent = r.body.configLabel;
      renderSidebar();
    });
    loadMeta();
    loadProjectConfig();
    pollDoctor(0);
  }

  function loadProjectConfig() {
    api("GET", "/api/config").then(function (r) {
      if (r.status === 200) S.projectConfig = r.body;
    });
  }

  function openConfigModal() {
    if (!S.projectConfig) { setBanner("project config is not available", "info"); return; }
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
    function renderAgentConfigRows() {
      clear(agentList);
      agentRows = [];
      (S.projectConfig.agents || []).forEach(function (a) {
        var enabled = h("input", { type: "checkbox", checked: a.enabled !== false });
        var id = h("input", { class: "txt", value: a.id || "" });
        var label = h("input", { class: "txt", placeholder: "optional display label", value: a.label || "" });
        var provider = selectEl([
          { value: "claude", label: "claude" },
          { value: "opencode", label: "opencode" },
          { value: "codex", label: "codex" },
          { value: "amp", label: "amp" }
        ], a.provider || "claude");
        var binary = h("input", { class: "txt", placeholder: "default binary", value: a.binary || "" });
        var env = h("textarea", { class: "ta mini", placeholder: "env JSON", rows: "2" });
        env.value = a.env ? JSON.stringify(a.env) : "";
        var extraArgs = h("textarea", { class: "ta mini", placeholder: "[]", rows: "2" });
        extraArgs.value = JSON.stringify(a.extraArgs || []);
        var defaultModel = h("input", { class: "txt", placeholder: "default model", value: a.defaultModel || "" });
        var row = { enabled: enabled, id: id, label: label, provider: provider, binary: binary, env: env, extraArgs: extraArgs, defaultModel: defaultModel };
        agentRows.push(row);
        agentList.appendChild(h("div", { class: "agentrow" },
          h("label", null, enabled, h("span", { text: " enabled" })),
          field("ID", id),
          field("Label", label),
          field("Provider", provider),
          field("Binary", binary),
          field("Env", env, "JSON object, merged into process env."),
          field("Extra args", extraArgs, "JSON array of flags appended before the prompt."),
          field("Default model", defaultModel)
        ));
      });
    }
    function addAgentRow() {
      S.projectConfig.agents = (S.projectConfig.agents || []).concat([{
        id: "claude-fork",
        provider: "claude",
        enabled: true,
        binary: "claude"
      }]);
      renderAgentConfigRows();
    }
    renderAgentConfigRows();
    var body = h("div", null,
      banner,
      field("Step timeout (minutes)", stepInput, "Per-agent subprocess limit (default 15)."),
      field("Workflow timeout (minutes)", wfInput, "Whole-run limit. Leave empty or check auto to use steps × step timeout."),
      h("label", { style: "display:flex;gap:6px;align-items:center;margin-top:8px" },
        autoChk, h("span", { text: "Auto workflow timeout (steps × step)" })),
      h("hr"),
      h("div", { class: "field" },
        h("label", { text: "Agents" }),
        h("div", { class: "help", text: "Only enabled agents appear in pickers and health outside this page." }),
        agentList,
        h("button", { class: "btn small", text: "+ Add agent", onClick: addAgentRow }))
    );
    var saveBtn = h("button", { class: "btn primary", text: "Save" });
  saveBtn.addEventListener("click", function () {
      var stepSec = Number(stepInput.value) * 60;
      if (!stepSec || stepSec <= 0) { mbanner(banner, "step timeout must be a positive number of minutes", "err"); return; }
      var agents;
      try {
        agents = collectAgentConfigRows(agentRows);
      } catch (e) {
        mbanner(banner, e.message || String(e), "err");
        return;
      }
      var payload = { stepTimeoutSec: stepSec, agents: agents };
      if (autoChk.checked) payload.clearWorkflowTimeout = true;
      else {
        var wfSec = Number(wfInput.value) * 60;
        if (!wfSec || wfSec <= 0) { mbanner(banner, "workflow timeout must be a positive number of minutes", "err"); return; }
        payload.workflowTimeoutSec = wfSec;
      }
      saveBtn.disabled = true;
      api("PUT", "/api/config", payload).then(function (r) {
        saveBtn.disabled = false;
        if (r.status === 200 && r.body.ok) {
          S.projectConfig = Object.assign({}, S.projectConfig, r.body);
          S.agents = (r.body.agents || []).filter(function (a) { return a.enabled !== false; });
          closeModal();
          pollDoctor(0);
          setBanner("project config saved", "info");
        } else {
          mbanner(banner, (r.body && r.body.error) || "save failed", "err");
        }
      });
    });
    openModal(modalShell("Project config", "Applies to ./steamtrain.json", body,
      h("div", { class: "mfoot" },
        h("button", { class: "btn", text: "Cancel", onClick: closeModal }),
        h("div", { class: "spacer" }),
        saveBtn), true));
  }

  function collectAgentConfigRows(rows) {
    var ids = {};
    return rows.map(function (row) {
      var id = row.id.value.trim();
      if (!id) throw new Error("agent id is required");
      if (ids[id]) throw new Error("duplicate agent id: " + id);
      ids[id] = true;
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
        defaultModel: row.defaultModel.value.trim() || undefined
      };
    });
  }

  // Agent/model/effort catalog for the create + configure forms.
  function loadMeta() {
    api("GET", "/api/meta").then(function (r) {
      S.agents = (r.body && r.body.agents) || [];
      applyHealth();
    });
  }
  // The server serves immediately and runs the doctor in the background, so the
  // health flag baked into /api/meta is often stale (all false) at first
  // paint. Fold the live /api/doctor results into the cached agent catalog so
  // the create/configure picker reflects real health once the doctor lands,
  // without a full page reload. Handles either fetch resolving first.
  function applyHealth() {
    if (!S.doctor.length || !S.agents.length) return;
    S.agents.forEach(function (a) {
      a.healthy = S.doctor.some(function (d) { return d.agent === a.id && d.status === "ok"; });
    });
  }
  function agentById(id) {
    for (var i = 0; i < S.agents.length; i++) if (S.agents[i].id === id) return S.agents[i];
    return null;
  }
  function modelsFor(agentId) { var a = agentById(agentId); return a ? a.models : []; }
  function effortsFor(agentId, modelId) {
    var ms = modelsFor(agentId);
    for (var i = 0; i < ms.length; i++) if (ms[i].id === modelId) return ms[i].efforts || [];
    return [];
  }

  // Health probes run in the background on the server; poll a few times until
  // they land so the chips appear without a manual reload.
  function pollDoctor(attempt) {
    api("GET", "/api/doctor").then(function (r) {
      var list = r.body.doctor || [];
      var err = r.body.doctorError;
      S.doctor = list;
      renderHealth(list, err);
      applyHealth();
      if (!list.length && !err && attempt < 12) setTimeout(function () { pollDoctor(attempt + 1); }, 1500);
    });
  }

  function renderHealth(list, err) {
    var box = document.getElementById("health");
    clear(box);
    if (err) {
      box.appendChild(h("span", { class: "chip bad" }, h("span", { class: "dot" }), "doctor: " + err));
      return;
    }
    list.forEach(function (d) {
      var cls = d.status === "ok" ? "ok" : (d.status === "warn" ? "warn" : "bad");
      box.appendChild(h("span", { class: "chip " + cls }, h("span", { class: "dot" }), d.agent));
    });
  }

  function renderSidebar() {
    var box = document.getElementById("wflist");
    clear(box);
    S.workflows.forEach(function (w) {
      var kinds = Object.keys(w.kinds || {}).map(function (k) { return (KIND_LABEL[k] || k) + ":" + w.kinds[k]; }).join(" \u00b7 ");
      var meta = w.phaseCount + " phase" + (w.phaseCount === 1 ? "" : "s") + " \u00b7 " + w.stepCount + " step" + (w.stepCount === 1 ? "" : "s");
      var isStaged = workflowHasStaged(S.stagedOverrides[w.name]);
      var card = h("div", { class: "wf" + (S.selected === w.name ? " sel" : ""), onClick: function () { selectWorkflow(w.name); } },
        h("div", { class: "name" }, w.name, h("span", { class: "src", text: w.source }), isStaged ? h("span", { class: "badge staged", text: "staged" }) : null),
        w.description ? h("div", { class: "desc", text: w.description }) : null,
        h("div", { class: "meta", text: meta + (kinds ? " \u00b7 " + kinds : "") })
      );
      box.appendChild(card);
    });
  }

  function selectWorkflow(name, after) {
    if (S.es) { S.es.close(); S.es = null; }
    stopTimer();
    S.selected = name; S.runId = null; S.runState = null;
    renderSidebar();
    document.getElementById("statusLine").style.display = "none";
    setBanner("", "");
    api("GET", "/api/workflows/" + encodeURIComponent(name)).then(function (r) {
      if (r.status !== 200) { setBanner(r.body.error || "failed to load", "err"); return; }
      S.spec = r.body.spec;
      S.source = r.body.source;
      document.getElementById("wfTitle").textContent = r.body.spec.name;
      document.getElementById("wfSub").textContent = r.body.spec.description || "";
      document.getElementById("runRow").style.display = "flex";
      renderSourceLine();
      S.runState = SteamtrainReducer.workflowStateFromSpec(effectiveSpec() || r.body.spec);
      render();
      renderStagedIndicator();
      if (after) after();
    });
  }

  // Re-run / retry-failed a recorded run: launch via the history route, then
  // switch to the live run view for the returned run id.
  function rerunHistory(id, workflow, mode) {
    api("POST", "/api/history/" + encodeURIComponent(id) + "/" + mode).then(function (r) {
      if (r.status !== 201) {
        setBanner((r.body && r.body.error) || "could not start re-run", "err");
        return;
      }
      var runId = r.body.runId;
      var downgraded = r.body.downgraded;
      closeModal();
      selectWorkflow(workflow, function () {
        if (downgraded) setBanner("Workflow changed since this run \u2014 doing a full re-run.", "info");
        S.runId = runId;
        setRunning(true);
        S.startedAt = Date.now();
        startTimer();
        document.getElementById("statusLine").style.display = "flex";
        openStream(runId);
        render();
      });
    });
  }

  function renderSourceLine() {
    var line = document.getElementById("srcLine");
    clear(line);
    line.style.display = "flex";
    line.appendChild(h("span", { class: "src", text: S.source || "unknown" }));
    var counts = S.spec ? S.spec.phases.length + " phase" + (S.spec.phases.length === 1 ? "" : "s") : "";
    if (counts) line.appendChild(h("span", { text: counts }));
    if (S.source !== "user" && S.source !== "project") line.appendChild(h("span", { text: "\u00b7 configuring saves a user copy" }));
    document.getElementById("wfActions").style.display = "flex";
    document.getElementById("deleteBtn").style.display = (S.source === "user" || S.source === "project") ? "block" : "none";
  }

  // ---- run model -----------------------------------------------------------
  function reduce(ev) {
    if (!S.runState) {
      S.runState = SteamtrainReducer.initialWorkflowState;
    }
    S.runState = SteamtrainReducer.workflowReducer(S.runState, { type: "event", event: ev });
  }

  // ---- rendering -----------------------------------------------------------
  function scheduleRender() {
    if (S.rafQueued) return;
    S.rafQueued = true;
    requestAnimationFrame(function () { S.rafQueued = false; render(); });
  }

  function render() {
    var canvas = document.getElementById("canvas");
    clear(canvas);
    if (!S.spec) { canvas.appendChild(h("div", { class: "empty", text: "No workflow selected." })); return; }

    canvas.appendChild(h("div", { class: "legend" },
      legendItem("worker", "worker"), legendItem("processor", "process"),
      legendItem("distributor", "fan-out"), legendItem("consolidator", "merge"), legendItem("gate", "gate"), legendItem("merge", "merge-back")
    ));

    var maxIter = {};
    var phases = S.runState ? S.runState.phases : [];
    phases.forEach(function (p) {
      if (p.iteration && (!maxIter[p.phaseId] || p.iteration > maxIter[p.phaseId])) maxIter[p.phaseId] = p.iteration;
    });

    phases.forEach(function (p, idx) {
      if (idx > 0) canvas.appendChild(h("div", { class: "connector" }));
      var piter = p.iteration || 1;
      var done = p.done ? { ok: p.ok } : null;
      var steps = p.steps || [];
      var running = steps.some(function (s) { return s.status === "running"; });
      var pstat = p.done ? (p.ok ? "done" : "failed") : (running ? "running" : (S.runState && S.runState.started ? "" : "pending"));
      var ptitle = p.title + (p.iteration && p.iteration > 1 ? " \u00b7 iteration " + p.iteration : "");
      var phaseEl = h("div", { class: "phase" + (p.done ? " done" : "") },
        h("div", { class: "phead" },
          h("div", { class: "pidx", text: String(idx + 1) }),
          h("div", { class: "ptitle", text: ptitle }),
          pstat ? h("div", { class: "pstat", text: "\u00b7 " + pstat }) : null
        )
      );
      var cards = h("div", { class: "cards" });
      var isLatest = !p.iteration || p.iteration === (maxIter[p.phaseId] || 1);
      steps.forEach(function (s) {
        if (isLatest) cards.appendChild(renderCard(s));
        else cards.appendChild(h("div", { class: "card superseded" },
          h("div", { class: "top" },
            h("span", { class: "sid", text: s.stepId }),
            h("span", { class: "state", text: "iteration " + piter + " \u2192 superseded by iteration " + maxIter[p.phaseId] })
          )
        ));
      });
      phaseEl.appendChild(cards);
      canvas.appendChild(phaseEl);

      var loopMarkers = S.runState ? (S.runState.loopMarkers || []) : [];
      loopMarkers.forEach(function (m) {
        if (m.gatePhaseId === p.phaseId && m.gatePhaseIteration === piter) {
          canvas.appendChild(h("div", { class: "loop-marker" },
            h("span", { class: "chip warn",
              text: "\u21ba loop \u2192 " + m.loopTo + " \u00b7 iteration " + m.iteration + "/" + (m.maxIterations || "") })
          ));
        }
      });
    });

    if (S.runState && S.runState.done) renderSummary(canvas);
    updateProgress();
  }

  function legendItem(kind, label) {
    var i = h("i"); i.className = ""; i.style.background = kindColor(kind);
    return h("span", null, i, label);
  }
  function kindColor(k) {
    return { worker: "#6fb1ff", processor: "#9d8cff", distributor: "#ffce6f", consolidator: "#5fe0c6", gate: "#f0a35e", merge: "#ff9ecb" }[k] || "#6fb1ff";
  }

  function renderCard(s) {
    var card = h("div", { class: "card " + s.status });
    var kindEl = h("span", { class: "kind " + s.blockKind });
    if (s.status === "running") kindEl.appendChild(h("span", { class: "pulse" }));
    kindEl.appendChild(document.createTextNode(KIND_LABEL[s.blockKind] || s.blockKind));
    var attempts = s.attempts || (s.result && s.result.attempts);
    var stateLabel = s.status === "pending" ? "pending" : s.status;
    if (s.result && s.result.skipped) stateLabel = "skipped";
    if (attempts && attempts > 1) stateLabel += " \u00b7 " + attempts + " tries";
    card.appendChild(h("div", { class: "top" },
      h("span", { class: "sid", text: s.stepId }),
      kindEl,
      h("span", { class: "state " + s.status, text: stateLabel })
    ));
    if (s.agent) card.appendChild(h("div", { class: "agent", text: s.agent + (s.model ? " \u00b7 " + s.model : "") }));
    if (s.dependsOn && s.dependsOn.length) card.appendChild(h("div", { class: "inputs", text: "inputs: " + s.dependsOn.join(", ") }));
    if (s.forEach) card.appendChild(h("div", { class: "inputs", text: "forEach: " + s.forEach }));
    if (s.loopTo) card.appendChild(h("div", { class: "inputs" },
      h("span", { class: "chip warn", text: "\u21ba " + s.loopTo + (s.maxIterations ? " \u00b7 max " + s.maxIterations : "") })
    ));
    if (s.item) card.appendChild(h("div", { class: "item", text: "item #" + s.item.index + ": " + truncate(s.item.value, 80) }));
    if (s.activity) card.appendChild(h("div", { class: "activity", text: s.activity }));

    var tailText = s.text ? tail(s.text, 600) : "";
    if (tailText) {
      var tailEl = h("div", { class: "tail show", text: tailText });
      card.appendChild(tailEl);
    }

    if (s.result || s.cached || s.gate) {
      var metrics = h("div", { class: "metrics" });
      if (s.result) {
        metrics.appendChild(h("span", { text: (s.result.durationMs / 1000).toFixed(1) + "s" }));
        if (s.result.costUsd) metrics.appendChild(h("span", { text: "$" + s.result.costUsd.toFixed(4) }));
        var tokenLine = fmtTokenSummary(s.result.tokens);
        if (tokenLine) metrics.appendChild(h("span", { text: tokenLine }));
      }
      if (s.cached) metrics.appendChild(h("span", { class: "badge cached", text: "cached" }));
      if (s.gate) metrics.appendChild(h("span", { class: "badge " + (s.gate.passed ? "gate-pass" : "gate-block"), text: s.gate.passed ? "gate passed" : "gate blocked" }));
      card.appendChild(metrics);
    }
    return card;
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
    var bar = document.getElementById("progressBar");
    var pct = total ? Math.round((doneN / total) * 100) : 0;
    bar.style.width = pct + "%";
    document.getElementById("progressText").textContent = doneN + " / " + total + " steps";

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

  // ---- running -------------------------------------------------------------
  function startRun() {
    var input = document.getElementById("input").value;
    if (!input.trim()) { setBanner("enter some input first", "info"); return; }
    S.runState = SteamtrainReducer.workflowStateFromSpec(effectiveSpec() || S.spec);
    setBanner("", "");
    document.getElementById("statusLine").style.display = "flex";
    var payload = { workflow: S.selected, input: input, fresh: document.getElementById("freshChk").checked };
    if (workflowHasStaged(S.stagedOverrides[S.selected])) payload.overrides = S.stagedOverrides[S.selected];
    api("POST", "/api/runs", payload)
      .then(function (r) {
        if (r.status !== 201) { setBanner(r.body.error || "could not start run", "err"); return; }
        S.runId = r.body.runId;
        setRunning(true);
        S.startedAt = Date.now();
        startTimer();
        openStream(S.runId);
        render();
      });
  }

  function openStream(runId) {
    if (S.es) S.es.close();
    var es = new EventSource("/api/runs/" + runId + "/stream");
    S.es = es;
    es.onmessage = function (m) {
      var frame;
      try { frame = JSON.parse(m.data); } catch (e) { return; }
      if (frame.type === "event") { reduce(frame.event); scheduleRender(); }
      else if (frame.type === "status") {
        es.close(); S.es = null; setRunning(false); stopTimer();
        if (frame.status === "canceled") setBanner("Run canceled.", "info");
        else if (frame.status === "budget-exceeded") setBanner("Run stopped: cost budget reached. Raise maxCostUsd and re-run to resume.", "err");
        else if (frame.status === "error" || frame.ok === false) setBanner("Run failed" + (frame.error ? ": " + frame.error : "."), "err");
        else setBanner("Run complete.", "ok");
        render();
      }
    };
    es.onerror = function () {
      if (S.runState && S.runState.done) return;
      // The browser will retry automatically; surface a hint if it persists.
    };
  }

  function cancelRun() {
    if (!S.runId) return;
    api("POST", "/api/runs/" + S.runId + "/cancel");
  }

  function setRunning(running) {
    document.getElementById("runBtn").style.display = running ? "none" : "block";
    document.getElementById("cancelBtn").style.display = running ? "block" : "none";
    document.getElementById("input").disabled = running;
  }

  function startTimer() {
    stopTimer();
    S.timer = setInterval(function () {
      document.getElementById("elapsed").textContent = ((Date.now() - S.startedAt) / 1000).toFixed(1) + "s";
    }, 200);
  }
  function stopTimer() { if (S.timer) { clearInterval(S.timer); S.timer = null; } }

  function setBanner(text, kind) {
    var b = document.getElementById("banner");
    if (!text) { b.className = "banner"; b.textContent = ""; return; }
    b.className = "banner show " + (kind === "ok" ? "ok" : kind === "err" ? "err" : "info");
    b.textContent = text;
  }

  // ---- authoring: modal scaffolding ---------------------------------------
  function openModal(node) {
    var modal = document.getElementById("modal");
    clear(modal);
    modal.appendChild(node);
    document.getElementById("overlay").classList.add("show");
  }
  function closeModal() {
    if (S.draftAbort) { try { S.draftAbort.abort(); } catch (e) {} S.draftAbort = null; }
    document.getElementById("overlay").classList.remove("show");
    clear(document.getElementById("modal"));
  }
  function modalShell(title, sub, bodyNode, footNode, wide) {
    var x = h("button", { class: "x", title: "Close", onClick: closeModal }, "\u00d7");
    var head = h("div", { class: "mhead" },
      h("div", null, h("div", { class: "mtitle", text: title }), sub ? h("div", { class: "msub", text: sub }) : null),
      x
    );
    var shell = h("div", { class: "modal" + (wide ? " wide" : "") }, head, h("div", { class: "mbody" }, bodyNode), footNode);
    return shell;
  }
  function field(label, control, hint) {
    return h("div", { class: "field" },
      h("label", { text: label }), control,
      hint ? h("div", { class: "hint", text: hint }) : null);
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
    return S.agents.map(function (a) {
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
    for (var i = 0; i < S.agents.length; i++) if (S.agents[i].healthy) return S.agents[i];
    return S.agents[0] || null;
  }
  function mbanner(node, text, kind) {
    if (!text) { node.className = "mbanner"; node.textContent = ""; return; }
    node.className = "mbanner show " + (kind === "err" ? "err" : "info");
    node.textContent = text;
  }

  // ---- create (LLM-drafted) -----------------------------------------------
  function openCreate() {
    if (!S.agents.length) { setBanner("agent catalog still loading; try again in a moment", "info"); return; }
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
      var payload = {
        description: desc, agent: agentSel.value, model: modelSel.value,
        effort: effortSel ? effortSel.value : "", name: nameInput.value.trim(),
        scope: scopeSel.value
      };
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
    if (st.agent) return true;
    var k = st.kind || "worker";
    return k === "worker" || k === "processor";
  }
  function openEditor(clone) {
    if (!S.spec) return;
    if (!S.agents.length) { setBanner("agent catalog still loading; try again in a moment", "info"); return; }
    var spec = JSON.parse(JSON.stringify(effectiveSpec() || S.spec));
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

    var phasesWrap = h("div", null);
    spec.phases.forEach(function (p) {
      var pe = h("div", { class: "ephase" }, h("div", { class: "et", text: (p.title || p.id) }));
      p.steps.forEach(function (st) {
        pe.appendChild(stepEditor(st, refs));
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
          var r = refs[st.id];
          if (!r) return;
          st.agent = r.agentSel.value;
          st.model = r.modelSel.value;
          var ef = r.effortSel ? r.effortSel.value : "";
          if (ef) st.effort = ef; else delete st.effort;
          st.prompt = r.promptTa.value;
          if (r.stepTimeoutInput && r.stepTimeoutInput.value.trim()) {
            var stepSec = Number(r.stepTimeoutInput.value) * 60;
            if (stepSec > 0) st.stepTimeoutSec = stepSec; else delete st.stepTimeoutSec;
          } else delete st.stepTimeoutSec;
        });
      });
      saveBtn.disabled = true; saveBtn.textContent = "Saving…";
      var payload = { spec: spec, scope: creating ? scopeSel.value : (S.source === "project" ? "project" : "user") };
      if (!creating && isWritable) payload.previousName = S.selected;
      api("PUT", "/api/workflows/" + encodeURIComponent(targetName), payload).then(function (r) {
        saveBtn.disabled = false; saveBtn.textContent = creating ? "Save copy" : "Save";
        if (r.status === 200 && r.body.ok) {
          closeModal();
          var savedName = r.body.name || targetName;
          delete S.stagedOverrides[S.selected || savedName];
          if (savedName !== S.selected) delete S.stagedOverrides[savedName];
          refreshAfterWrite(savedName, "saved");
        } else {
          mbanner(banner, (r.body && r.body.error) || "save failed", "err");
        }
      });
    });

    if (tryBtn) {
      tryBtn.addEventListener("click", function () {
        var overrides = { steps: {} };
        spec.phases.forEach(function (p) {
          p.steps.forEach(function (st) {
            var r = refs[st.id];
            if (!r) return;
            var patch = {};
            patch.agent = r.agentSel.value;
            patch.model = r.modelSel.value;
            var ef = r.effortSel ? r.effortSel.value : "";
            patch.effort = ef || null;
            patch.prompt = r.promptTa.value;
            if (r.stepTimeoutInput && r.stepTimeoutInput.value.trim()) {
              var stepSec = Number(r.stepTimeoutInput.value) * 60;
              patch.stepTimeoutSec = stepSec > 0 ? stepSec : null;
            } else patch.stepTimeoutSec = null;
            if (Object.keys(patch).length > 0) overrides.steps[st.id] = patch;
          });
        });
        var wfStepSec = Number(wfStepInput.value) * 60;
        overrides.stepTimeoutSec = wfStepInput.value.trim() && wfStepSec > 0 ? wfStepSec : null;
        var wfRunSec = Number(wfRunInput.value) * 60;
        overrides.workflowTimeoutSec = wfRunInput.value.trim() && wfRunSec > 0 ? wfRunSec : null;
        if (!sessionOverridesEmpty(overrides)) {
          S.stagedOverrides[S.selected] = overrides;
        } else {
          delete S.stagedOverrides[S.selected];
        }
        closeModal();
        renderStagedIndicator();
        renderSidebar();
        setBanner(!sessionOverridesEmpty(overrides) ? "Overrides staged for next run (not saved to disk)." : "No changes to stage.", "info");
      });
    }

    openModal(modalShell(creating ? "Clone workflow" : "Configure " + spec.name,
      "Set the agent, model, effort, and prompt for each step.", body, foot, true));
  }

  function stepEditor(st, refs) {
    var kind = st.kind || "worker";
    var card = h("div", { class: "estep " + kind },
      h("div", { class: "eh" },
        h("span", { class: "esid", text: st.id }),
        h("span", { class: "ek", text: kind }),
        st.dependsOn && st.dependsOn.length ? h("span", { class: "ro", text: "\u2190 " + st.dependsOn.join(", ") }) : null
      )
    );
    if (!isAgentStep(st)) {
      var note = kind === "gate"
        ? "gate: " + describeGate(st)
        : (st.items ? "distributes " + st.items.length + " item(s)" : "passthrough merge (no agent)");
      card.appendChild(h("div", { class: "ro", text: note }));
      return card;
    }
    var agent = st.agent || preferredAgent().id;
    var agentSel = selectEl(agentOptionsWith(agent), agent);
    var modelSel = selectEl(modelOptionsWith(agent, st.model), st.model);
    var effortField = h("div", { class: "field" });
    var stepTimeoutInput = h("input", {
      class: "txt", type: "number", min: "1", placeholder: "workflow default",
      value: st.stepTimeoutSec ? String(Math.round(st.stepTimeoutSec / 60)) : ""
    });
    var promptTa = h("textarea", { class: "ta", text: st.prompt || "" });

    function renderEffort() {
      clear(effortField);
      var opts = effortOptions(agentSel.value, modelSel.value, st.effort);
      if (opts.length <= 1) { refs[st.id].effortSel = null; return; }
      effortField.appendChild(h("label", { text: "Effort" }));
      var es = selectEl(opts, st.effort || "");
      effortField.appendChild(es);
      refs[st.id].effortSel = es;
    }
    agentSel.addEventListener("change", function () {
      var a = agentById(agentSel.value);
      fillOptions(modelSel, modelOptions(agentSel.value), a ? a.defaultModel : null);
      renderEffort();
    });
    modelSel.addEventListener("change", renderEffort);

    refs[st.id] = { agentSel: agentSel, modelSel: modelSel, effortSel: null, promptTa: promptTa, stepTimeoutInput: stepTimeoutInput };
    card.appendChild(h("div", { class: "row2" },
      field("Agent", agentSel), field("Model", modelSel), effortField));
    card.appendChild(field("Step timeout (min)", stepTimeoutInput, "Per-agent subprocess limit for this step."));
    card.appendChild(field("Prompt", promptTa));
    renderEffort();
    return card;
  }

  function describeGate(st) {
    var c = st.condition || {};
    var parts = [];
    if (c.step) parts.push("step " + c.step);
    if (c.ok != null) parts.push(c.ok ? "ok" : "not ok");
    if (c.contains) parts.push('contains "' + c.contains + '"');
    if (c.matches) parts.push("matches /" + c.matches + "/");
    if (st.onFalse) parts.push("else " + st.onFalse);
    return parts.join(", ") || "condition";
  }

  function doDelete() {
    if (!S.selected || (S.source !== "user" && S.source !== "project")) return;
    var fileLabel = S.source === "project" ? "the project steamtrain.json" : "your user workflows file";
    if (!window.confirm("Delete workflow \"" + S.selected + "\"? This removes it from " + fileLabel + ".")) return;
    var name = S.selected;
    api("DELETE", "/api/workflows/" + encodeURIComponent(name)).then(function (r) {
      if (r.status === 200 && r.body.ok) {
        delete S.stagedOverrides[name];
        S.selected = null; S.spec = null; S.source = null;
        document.getElementById("wfActions").style.display = "none";
        document.getElementById("srcLine").style.display = "none";
        document.getElementById("runRow").style.display = "none";
        document.getElementById("wfTitle").textContent = "Select a workflow";
        document.getElementById("wfSub").textContent = "Pick a workflow on the left to view its pipeline and run it.";
        clear(document.getElementById("canvas"));
        document.getElementById("canvas").appendChild(h("div", { class: "empty", text: "Deleted " + name + "." }));
        reloadCatalog();
      } else {
        setBanner((r.body && r.body.error) || "delete failed", "err");
      }
    });
  }

  function reloadCatalog() {
    return api("GET", "/api/workflows").then(function (r) {
      S.workflows = r.body.workflows || [];
      renderSidebar();
    });
  }
  function refreshAfterWrite(name, verb) {
    reloadCatalog().then(function () {
      selectWorkflow(name);
      setBanner("Workflow \u201c" + name + "\u201d " + (verb || "saved") + ".", "ok");
    });
  }

  // ---- run history ---------------------------------------------------------
  function openHistory() {
    var holder = h("div", null, h("div", { class: "ro", text: "Loading run history\u2026" }));
    var foot = h("div", { class: "mfoot" },
      h("button", { class: "btn danger small", text: "Clear all", onClick: clearHistory }),
      h("div", { class: "spacer" }),
      h("button", { class: "btn", text: "Close", onClick: closeModal })
    );
    openModal(modalShell("Run history", "Past workflow runs recorded on disk.", holder, foot, true));
    reopenHistoryList(holder);
  }

  function reopenHistoryList(holder) {
    clear(holder);
    holder.appendChild(h("div", { class: "ro", text: "Loading\u2026" }));
    api("GET", "/api/history").then(function (r) {
      renderHistoryList(holder, (r.body && r.body.runs) || []);
    });
  }

  function renderHistoryList(holder, runs) {
    clear(holder);
    if (!runs.length) {
      holder.appendChild(h("div", { class: "ro", text: "No recorded runs yet. Run a workflow to start building history." }));
      return;
    }
    var list = h("div", { class: "hruns" });
    runs.forEach(function (run) {
      var meta = fmtTotals(run.totals, { durationMs: run.durationMs || 0, tokens: true });
      var row = h("div", { class: "hrun " + run.status, onClick: (function (id) { return function () { openHistoryRun(holder, id); }; })(run.id) },
        h("div", { class: "hr-top" },
          h("span", { class: "hr-name", text: run.workflow }),
          h("span", { class: "hr-status", text: run.status }),
          h("span", { class: "hr-meta", text: fmtTime(run.startedAt) + " \u00b7 " + meta })
        ),
        h("div", { class: "hr-input", text: truncate(((run.input || "").replace(/\s+/g, " ").trim()) || "(no input)", 160) })
      );
      list.appendChild(row);
    });
    holder.appendChild(list);
  }

  function openHistoryRun(holder, id) {
    api("GET", "/api/history/" + encodeURIComponent(id)).then(function (r) {
      if (r.status !== 200 || !r.body.record) {
        renderHistoryList(holder, []);
        holder.insertBefore(h("div", { class: "mbanner show err", text: "Could not load that run." }), holder.firstChild);
        return;
      }
      renderHistoryDetail(holder, r.body.record);
    });
  }

  function renderHistoryDetail(holder, record) {
    clear(holder);
    holder.appendChild(h("span", { class: "hback", text: "\u2190 back to runs", onClick: function () { reopenHistoryList(holder); } }));
    holder.appendChild(h("div", { class: "title", style: "font-size:16px;font-weight:700", text: record.workflow }));
    holder.appendChild(h("div", { class: "sub", style: "color:var(--muted);font-size:12px;margin-top:2px",
      text: record.status + " \u00b7 " + fmtTime(record.startedAt) + " \u00b7 "
        + ((record.durationMs || 0) / 1000).toFixed(1) + "s \u00b7 " + fmtTotals(record.totals, { cached: true, tokens: true }) }));
    if (record.input) holder.appendChild(h("div", { class: "hr-input", style: "margin:8px 0 12px", text: "input: " + record.input }));
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
      var hmt = h("table", { style: "margin:4px 0 12px" });
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
    var canRetry = record.totals && record.totals.failed > 0;
    var actions = h("div", { class: "run-actions", style: "display:flex;gap:8px;margin:4px 0 12px" },
      h("button", { class: "btn primary", text: "Re-run",
        onClick: function () { rerunHistory(record.id, record.workflow, "rerun"); } }),
      canRetry ? h("button", { class: "btn", text: "Retry failed",
        onClick: function () { rerunHistory(record.id, record.workflow, "retry"); } }) : null
    );
    holder.appendChild(actions);
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
      (p.steps || []).forEach(function (st) { cards.appendChild(renderCard(historyStepView(st))); });
      phaseEl.appendChild(cards);
      holder.appendChild(phaseEl);
    });
  }

  // Map a recorded step onto the shape renderCard expects (live step view).
  function historyStepView(st) {
    return {
      stepId: st.stepId, blockKind: st.blockKind || "worker", agent: st.agent, model: st.model,
      dependsOn: st.dependsOn, forEach: null, item: st.item, status: st.status,
      text: st.text || (st.result && st.result.output) || "", activity: null,
      result: st.result, cached: st.cached, attempts: st.attempts,
      gate: st.gate ? { passed: st.gate.passed, target: st.gate.target } : null,
      loopTo: st.loopTo, maxIterations: st.maxIterations
    };
  }

  function clearHistory() {
    if (!window.confirm("Clear all recorded runs? This deletes the on-disk history.")) return;
    api("DELETE", "/api/history").then(function () { closeModal(); });
  }

  function fmtTime(ts) { try { return new Date(ts).toLocaleString(); } catch (e) { return ""; } }

  // Mirror of formatRunTotals() in src/workflow/history.ts: keep the CLI, TUI,
  // and web run summaries formatted identically. (The TS function can't be
  // imported here because this page script isn't bundled.)
  function fmtTotals(totals, opts) {
    var t = totals || { ok: 0, steps: 0, failed: 0, cached: 0, costUsd: 0 };
    opts = opts || {};
    var parts = [t.ok + "/" + t.steps + " ok"];
    if (t.failed > 0) parts.push(t.failed + " failed");
    if (opts.cached && t.cached > 0) parts.push(t.cached + " cached");
    if (typeof opts.durationMs === "number") parts.push((opts.durationMs / 1000).toFixed(1) + "s");
    if (t.costUsd > 0) parts.push("$" + t.costUsd.toFixed(4));
    if (opts.tokens) { var tk = totalTokens(t.tokens); if (tk > 0) parts.push(fmtTokens(tk) + " tok"); }
    return parts.join(" \u00b7 ");
  }

  // Mirror of the token helpers in src/workflow/cost.ts. TOKEN_KEYS order and
  // labels must match so every surface reports the same categories.
  var TOKEN_KEYS = ["input", "output", "cacheRead", "cacheWrite", "reasoning"];
  var TOKEN_LABELS = { input: "in", output: "out", cacheRead: "cache r", cacheWrite: "cache w", reasoning: "reason" };
  function totalTokens(t) {
    if (!t) return 0;
    return (t.input || 0) + (t.output || 0) + (t.cacheRead || 0) + (t.cacheWrite || 0);
  }
  function fmtTokens(n) {
    if (n < 1000) return String(Math.round(n));
    if (n < 1000000) return (n / 1000).toFixed(n < 10000 ? 1 : 0) + "k";
    return (n / 1000000).toFixed(n < 10000000 ? 1 : 0) + "M";
  }
  function fmtTokenSummary(t) {
    var total = totalTokens(t);
    if (total === 0 || !t) return "";
    var parts = [];
    for (var i = 0; i < TOKEN_KEYS.length; i++) {
      var k = TOKEN_KEYS[i]; var v = t[k] || 0;
      if (v > 0) parts.push(TOKEN_LABELS[k] + " " + fmtTokens(v));
    }
    return fmtTokens(total) + " tok (" + parts.join(" \u00b7 ") + ")";
  }
  // Add one token object into another (mutates + returns `a`).
  function addTokensInto(a, b) {
    if (!b) return a;
    for (var i = 0; i < TOKEN_KEYS.length; i++) { var k = TOKEN_KEYS[i]; a[k] = (a[k] || 0) + (b[k] || 0); }
    return a;
  }
  function emptyTokens() { return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }; }
  // Per-model roll-up of leaf steps, biggest spender first (mirrors cost.ts).
  function aggregateByModel(steps) {
    var map = {};
    steps.forEach(function (s) {
      if (!s.result || (s.result.childResults && s.result.childResults.length)) return;
      var key = s.model && s.agent ? s.agent + "/" + s.model : (s.model || s.agent || "unknown");
      var e = map[key] || (map[key] = { model: key, costUsd: 0, tokens: emptyTokens(), steps: 0 });
      e.costUsd += s.result.costUsd || 0;
      addTokensInto(e.tokens, s.result.tokens);
      e.steps += 1;
    });
    return Object.keys(map).map(function (k) { return map[k]; })
      .filter(function (m) { return m.costUsd > 0 || totalTokens(m.tokens) > 0; })
      .sort(function (a, b) { return b.costUsd - a.costUsd; });
  }

  // ---- utils ---------------------------------------------------------------
  function tail(text, n) { return text.length > n ? "\u2026" + text.slice(text.length - n) : text; }
  function truncate(text, n) { return text.length > n ? text.slice(0, n) + "\u2026" : text; }

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
    if (!hasAnyStaged() || flushInFlight) return;
    flushInFlight = true;
    var flushBtn = document.getElementById("flushBtn");
    if (flushBtn) { flushBtn.disabled = true; flushBtn.textContent = "Flushing\u2026"; }
    function resetFlushState() {
      flushInFlight = false;
      if (flushBtn) { flushBtn.disabled = false; flushBtn.textContent = "\u{1F4BE} Flush to disk"; }
    }
    api("POST", "/api/overrides/flush", { overrides: S.stagedOverrides }).then(function (r) {
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
      reloadCatalog().then(function () {
        selectWorkflow(S.selected, function () { setBanner(bannerMsg, "ok"); });
      });
    }).catch(function () {
      resetFlushState();
      setBanner("flush failed: network error", "err");
    });
  }

  document.getElementById("runBtn").addEventListener("click", startRun);
  document.getElementById("cancelBtn").addEventListener("click", cancelRun);
  document.getElementById("flushBtn").addEventListener("click", flushStaged);
  document.getElementById("input").addEventListener("keydown", function (e) {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") startRun();
  });
  document.getElementById("newWfBtn").addEventListener("click", openCreate);
  document.getElementById("historyBtn").addEventListener("click", openHistory);
  document.getElementById("configBtn").addEventListener("click", openConfigModal);
  document.getElementById("editBtn").addEventListener("click", function () { openEditor(false); });
  document.getElementById("cloneBtn").addEventListener("click", function () { openEditor(true); });
  document.getElementById("deleteBtn").addEventListener("click", doDelete);
  document.getElementById("overlay").addEventListener("click", function (e) {
    if (e.target === document.getElementById("overlay")) closeModal();
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && document.getElementById("overlay").classList.contains("show")) closeModal();
  });

  loadWorkflows();
})();
