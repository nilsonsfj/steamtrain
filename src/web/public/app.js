
(function () {
  "use strict";

  


  var KIND_LABEL = { worker: "worker", processor: "process", distributor: "fan-out", consolidator: "merge", gate: "gate", approval: "approval", human: "human", merge: "merge-back", command: "command", llm: "llm", workflow: "sub-workflow", issues: "issues" };
  // Autonomy labels: what a workflow will need from a human, visible BEFORE launch.
  var AUTONOMY_META = {
    autonomous: { badge: "▸ autonomous", cls: "autonomy-auto", title: "Runs unattended end-to-end — no human involvement declared." },
    approvals: { badge: "✋ approvals", cls: "autonomy-approvals", title: "Pauses at approval checkpoints — a human must approve or reject to continue." },
    interactive: { badge: "✎ interactive", cls: "autonomy-interactive", title: "Asks a human for input mid-run — answers or choices are required to finish." }
  };
  // Doctor status → how the setup panel and health chips read it. `loud` states
  // are the user's to fix now (red/amber); `calm` states are the normal resting
  // state for a CLI the user simply doesn't use (an uninstalled agent, an unset
  // key), so the header collapses them into one quiet chip instead of a wall of
  // red — mirroring the TUI status bar.
  var AGENT_HEALTH_META = {
    ok: { label: "ready", chip: "ok", loud: false, verb: "Ready" },
    not_authenticated: { label: "needs sign-in", chip: "bad", loud: true, verb: "Sign in" },
    unknown_error: { label: "error", chip: "bad", loud: true, verb: "Error" },
    binary_missing: { label: "not installed", chip: "calm", loud: false, verb: "Install" }
  };
  var API_HEALTH_META = {
    ok: { label: "ready", chip: "ok", loud: false, verb: "Ready" },
    not_authenticated: { label: "key rejected", chip: "bad", loud: true, verb: "Fix key" },
    unreachable: { label: "unreachable", chip: "bad", loud: true, verb: "Reachability" },
    unknown_error: { label: "error", chip: "bad", loud: true, verb: "Error" },
    key_missing: { label: "no key set", chip: "calm", loud: false, verb: "Set key" }
  };
  function agentHealthMeta(status) { return AGENT_HEALTH_META[status] || AGENT_HEALTH_META.unknown_error; }
  function apiHealthMeta(status) { return API_HEALTH_META[status] || API_HEALTH_META.unknown_error; }
  var S = {
    workflows: [], selected: null, source: null, spec: null, agents: [], apis: [],
    modelClasses: [], modelFamilies: [],
    runId: null, es: null,
    startedAt: 0, timer: null,
    runState: null,
    rafQueued: false, draftAbort: null, doctor: [], apiDoctor: [],
    stagedOverrides: {},
    projectConfig: null,
    liveRuns: [], liveRunsTimer: null, queuedBanner: false,
    deepLinkRequest: 0,
    // Step drill-in drawer: which step it shows ({phaseId, iteration, stepId}).
    detail: null,
    // Per-card tail scroll state keyed by stepKey(): { follow: bool, top: px }.
    // "follow" sticks the pane to the newest output as it streams; scrolling up
    // pauses it, scrolling back to the bottom re-engages it.
    tailScroll: {},
    // Same follow/position model for the drawer's full-output pane.
    drawerScroll: { follow: true, top: 0 },
    // Session capability from GET /api/session (or login). "read" hides every
    // mutate control; the server also 403s those routes as a hard backstop.
    capability: "full",
    // Conductor narration (UI-only projection of WorkflowEvents).
    narration: [],
    narrationOn: localStorage.getItem("steamtrain.narration") !== "off",
    // Station landing: first-open hero for the tour.
    stationLanding: false,
    // Focus the Station CTA once per landing session.
    stationCtaFocused: false,
    // Focus the Arrival primary CTA once per completed ride.
    arrivalCtaFocused: false,
    // Tour ride arc: atmospheric chrome between Station leave and Arrival.
    tourRiding: false,
    // True while the tour departure beat must stay on the Conductor stage.
    departing: false,
    // Wall-clock when the tour left the Station (for a minimum ride beat).
    departAt: 0,
    // Hold Arrival until the departure beat finishes on fast tours.
    arrivalHoldTimer: null,
    // Narration line id that already played the one-shot "fresh" entrance.
    narrationFreshPlayed: null,
    // Conductor stage line id that already played its one-shot entrance.
    conductorLinePlayed: null,
    // Last aria-live announcement (avoid re-speaking the same text).
    announceText: "",
    // Expand the full step-kind legend via "?".
    legendExpanded: false,
    // Collapse the phase tree under the Arrival Report after completion.
    arrivalInspect: false,
    // Play the Arrival entrance animation once per completed run.
    arrivalEnter: false,
    // Wall-clock end of the last run (frozen for the Arrival receipt).
    endedAt: 0,
    // Focus origins make overlays feel like part of one intentional control
    // surface rather than a collection of disconnected DOM fragments.
    modalInvoker: null,
    // A stable data attribute, rather than a transient node, lets detail focus
    // return to the matching control after the live canvas is rebuilt.
    detailInvoker: null,
    detailFallback: null,
    detailFocusPending: false,
    detailFocusGeneration: 0,
    planRequest: 0
  };

  var SELECTION_KEY = "steamtrain.lastWorkflow";
  var TOUR_NAME = (SteamtrainReducer.TOUR_WORKFLOW_NAME) || "tour";

  function isReadOnly() { return S.capability === "read"; }

  /** Hide authoring / run-control chrome when the session is read-only. */
  function applyCapabilityChrome() {
    var ro = isReadOnly();
    var badge = document.getElementById("modeBadge");
    // "none", not "" — clearing the inline style would reveal the badge (its
    // markup default is display:none) and label every full session read-only.
    if (badge) badge.style.display = ro ? "inline-flex" : "none";
    var hideIds = ["configBtn", "newWfBtn", "editBtn", "cloneBtn", "flushBtn", "deleteBtn", "planBtn", "runBtn"];
    hideIds.forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.style.display = ro ? "none" : "";
    });
    var fresh = document.getElementById("freshChk");
    if (fresh && fresh.parentElement) fresh.parentElement.style.display = ro ? "none" : "";
    // Run input is for launching; viewers still pick workflows from the sidebar
    // to inspect the pipeline, so hide the whole run row in read-only.
    if (ro) {
      var runRow = document.getElementById("runRow");
      if (runRow) runRow.style.display = "none";
      var actions = document.getElementById("wfActions");
      if (actions) actions.style.display = "none";
    }
  }

  /** Identity of one step instance across re-renders (loop iterations included). */
  function stepKey(phase, step) {
    return phase.phaseId + ":" + (phase.iteration || 1) + ":" + step.stepId;
  }

  function restoreDetailInvoker(key) {
    if (!key) return false;
    var targets = document.querySelectorAll("[data-detail-invoker]");
    for (var i = 0; i < targets.length; i++) {
      if (targets[i].getAttribute("data-detail-invoker") === key) {
        targets[i].focus();
        return true;
      }
    }
    return false;
  }

  function focusDetailFallback() {
    var canvas = document.getElementById("canvas");
    if (!canvas) return false;
    canvas.focus();
    return true;
  }

  /** Mirrors src/workflow/cost.ts formatElapsed: "8.3s", "1m 23s", "1h 05m". */
  function fmtElapsed(ms) {
    if (typeof ms !== "number" || !isFinite(ms) || ms < 0) return "";
    var sec = ms / 1000;
    if (sec < 60) return sec.toFixed(1) + "s";
    var min = Math.floor(sec / 60);
    if (min < 60) return min + "m " + String(Math.floor(sec % 60)).padStart(2, "0") + "s";
    return Math.floor(min / 60) + "h " + String(min % 60).padStart(2, "0") + "m";
  }

  /** Refresh every live ticking timer ("[data-since]") in one cheap pass. */
  function updateLiveTimers() {
    var nodes = document.querySelectorAll("[data-since]");
    var now = Date.now();
    for (var i = 0; i < nodes.length; i++) {
      var since = Number(nodes[i].getAttribute("data-since"));
      if (since > 0) nodes[i].textContent = "⏱ " + fmtElapsed(now - since);
    }
  }

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
  function isInteractiveTarget(target) {
    return target instanceof Element && Boolean(target.closest("button, input, textarea, select, a"));
  }
  function activateWithKeyboard(event, action) {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    action();
  }
  function api(method, path, body) {
    return fetch(path, {
      method: method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined
    }).then(function (r) { return r.json().then(function (j) { return { status: r.status, body: j }; }); });
  }

  /** Like api() but redirects to login on 401 (session expired). */
  function apiAuth(method, path, body) {
    return api(method, path, body).then(function (r) {
      if (r.status === 401) { showLoginForm(); throw new Error("auth required"); }
      if (r.status === 403 && r.body && r.body.error === "read-only session") {
        S.capability = "read";
        applyCapabilityChrome();
        setBanner("This session is read-only — viewing only.", "info");
      }
      return r;
    });
  }

  // ---- workflow catalog ----------------------------------------------------
  function loadSessionThenCatalog() {
    api("GET", "/api/session").then(function (r) {
      if (r.status === 401) { showLoginForm(); return; }
      if (r.status === 200 && r.body) {
        S.capability = r.body.capability === "read" ? "read" : "full";
        applyCapabilityChrome();
      }
      loadWorkflows();
    }).catch(function () {
      // Fail closed: if we cannot learn the capability, assume read-only so
      // we never flash Run / authoring chrome for a viewer session.
      S.capability = "read";
      applyCapabilityChrome();
      loadWorkflows();
    });
  }

  function loadWorkflows() {
    api("GET", "/api/workflows").then(function (r) {
      if (r.status === 401) { showLoginForm(); return; }
      S.workflows = r.body.workflows || [];
      if (r.body.configLabel) document.getElementById("config").textContent = r.body.configLabel;
      renderSidebar();
      var deepLinkId = SteamtrainReducer.parseRunDeepLink
        ? SteamtrainReducer.parseRunDeepLink(window.location.hash)
        : null;
      if (deepLinkId) openRunDeepLink(deepLinkId);
      else bootstrapStationLanding();
    });
    loadMeta();
    if (!isReadOnly()) loadProjectConfig();
    pollDoctor(0);
    pollLiveRuns();
    if (!S.liveRunsTimer) S.liveRunsTimer = setInterval(pollLiveRuns, 5000);
  }

  /**
   * Refetch only the catalog list (blocked/re-route annotations depend on
   * agent health, which lands after first paint) and repaint what shows it.
   */
  function refreshWorkflowList() {
    api("GET", "/api/workflows").then(function (r) {
      if (r.status !== 200) return;
      S.workflows = r.body.workflows || [];
      renderSidebar();
      renderBlockedRow();
    }).catch(function () {});
  }

  /** First impression: auto-select tour when the user has never ridden. */
  function bootstrapStationLanding() {
    if (S.selected) return;
    var remembered = null;
    try { remembered = localStorage.getItem(SELECTION_KEY); } catch (e) {}
    api("GET", "/api/history").then(function (r) {
      var hasHistory = r.status === 200 && (r.body.runs || []).length > 0;
      var preferTour = SteamtrainReducer.shouldOfferStationLanding
        ? SteamtrainReducer.shouldOfferStationLanding({
            hasRunHistory: hasHistory,
            rememberedSelection: remembered
          })
        : (!hasHistory && !remembered);
      if (preferTour && S.workflows.some(function (w) { return w.name === TOUR_NAME; })) {
        // Read-only sessions can browse but cannot ride — skip station chrome
        // so other workflows stay visible and the canvas is not a dead end.
        if (!isReadOnly()) S.stationLanding = true;
        selectWorkflow(TOUR_NAME, function () {
          var input = document.getElementById("input");
          if (input && !input.value) input.value = "all aboard";
        });
        return;
      }
      if (remembered && S.workflows.some(function (w) { return w.name === remembered; })) {
        selectWorkflow(remembered);
        return;
      }
      // Soft default: still open the tour when present so the empty state dies.
      if (S.workflows.some(function (w) { return w.name === TOUR_NAME; })) {
        selectWorkflow(TOUR_NAME);
      }
    }).catch(function () {
      if (S.workflows.some(function (w) { return w.name === TOUR_NAME; })) selectWorkflow(TOUR_NAME);
    });
  }

  function isCredentialFreeSpec(spec) {
    if (!spec) return false;
    if (SteamtrainReducer.isCredentialFreeWorkflow) {
      return SteamtrainReducer.isCredentialFreeWorkflow(spec);
    }
    var needsCreds = false;
    (spec.phases || []).forEach(function (p) {
      (p.steps || []).forEach(function (s) {
        if (s.kind === "worker" || s.kind === "processor" || s.kind === "llm") needsCreds = true;
        if ((s.kind === "distributor" || s.kind === "consolidator") && s.agent) needsCreds = true;
      });
    });
    return !needsCreds;
  }

  var NEXT_CANDIDATES = (SteamtrainReducer.ARRIVAL_NEXT_CANDIDATES) ||
    ["multi-plan", "quick-triage", "bug-hunt", "target-sweep"];

  /** Plain-language car names for Arrival / yard chrome (tour ids first). */
  var TOUR_CAR_LABELS = {
    "car-fanout": "Fan-out",
    "car-parallel": "Parallel",
    "car-isolation": "Isolation",
    "express-service": "Express",
    "lap": "Lap counter",
    "loop-signal": "Loop gate",
    "conductor": "Arrival report"
  };

  function friendlyStepLabel(stepId) {
    if (!stepId) return "car";
    if (TOUR_CAR_LABELS[stepId]) return TOUR_CAR_LABELS[stepId];
    return String(stepId).replace(/[-_]+/g, " ");
  }

  function workflowNeedsCredentials(name) {
    var entry = S.workflows.find(function (w) { return w.name === name; });
    if (!entry) return true;
    var kinds = entry.kinds || {};
    // Agent CLIs or direct-API llm steps need credentials / binaries.
    return Boolean(kinds.worker || kinds.processor || kinds.llm);
  }

  function pickNextWorkflow() {
    var available = [];
    for (var i = 0; i < NEXT_CANDIDATES.length; i++) {
      var name = NEXT_CANDIDATES[i];
      if (name !== S.selected && S.workflows.some(function (w) { return w.name === name; })) {
        available.push(name);
      }
    }
    // Prefer a credential-free next ride when one exists; otherwise keep order.
    for (var j = 0; j < available.length; j++) {
      if (!workflowNeedsCredentials(available[j])) return available[j];
    }
    return available[0];
  }

  function announce(text) {
    if (!text || text === S.announceText) return;
    S.announceText = text;
    var el = document.getElementById("announcer");
    if (el) el.textContent = text;
  }

  // ---- in-flight runs (attach from any UI) ----------------------------------
  // The live-run registry lists every in-flight run in this project — web-owned,
  // CLI --detach, or TUI — so any of them can be attached to (replay + live tail).
  function pollLiveRuns() {
    api("GET", "/api/runs").then(function (r) {
      if (r.status === 401) {
        // Session expired: stop polling; a successful login reloads the page.
        if (S.liveRunsTimer) { clearInterval(S.liveRunsTimer); S.liveRunsTimer = null; }
        return;
      }
      if (r.status !== 200) return; // transient; the next poll retries
      S.liveRuns = (r.body.runs || []).filter(function (run) {
        return run.status === "running" || run.status === "queued";
      });
      renderLiveRuns();
    }).catch(function () {});
  }

  function setRunDeepLink(runId) {
    var hash = SteamtrainReducer.runDeepLink
      ? SteamtrainReducer.runDeepLink(runId)
      : "#run-" + runId;
    if (window.location.hash === hash) return;
    window.history.replaceState(null, "", window.location.pathname + window.location.search + hash);
  }

  function clearRunDeepLink() {
    if (!currentRunDeepLink()) return;
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
  }

  function currentRunDeepLink() {
    return SteamtrainReducer.parseRunDeepLink
      ? SteamtrainReducer.parseRunDeepLink(window.location.hash)
      : null;
  }

  function openRunDeepLink(runId) {
    var request = ++S.deepLinkRequest;
    api("GET", "/api/runs").then(function (r) {
      if (request !== S.deepLinkRequest || currentRunDeepLink() !== runId) return;
      if (r.status === 401) { showLoginForm(); return; }
      if (r.status !== 200) {
        setBanner("Could not open run " + runId.slice(0, 8) + "… — try refreshing.", "err");
        return;
      }
      var run = (r.body.runs || []).find(function (candidate) { return candidate.id === runId; });
      if (run && (run.status === "running" || run.status === "queued")) {
        attachRun(run);
        return;
      }
      openHistory(runId);
    }).catch(function () {
      if (request === S.deepLinkRequest && currentRunDeepLink() === runId) {
        setBanner("Could not open run " + runId.slice(0, 8) + "… — network error.", "err");
      }
    });
  }

  function renderLiveRuns() {
    var section = document.getElementById("liveRunsSection");
    var box = document.getElementById("liveRuns");
    if (!section || !box) return;
    if (!S.liveRuns.length) { section.style.display = "none"; clear(box); return; }
    section.style.display = "block";
    clear(box);
    S.liveRuns.forEach(function (run) {
      var badges = [];
      if (run.status === "queued") badges.push(h("span", { class: "badge staged", text: "queued" }));
      if (run.detached) badges.push(h("span", { class: "badge cached", text: "detached" }));
      if (run.paused) badges.push(h("span", { class: "badge paused", text: "⏸ paused" }));
      if (run.pendingApprovals && run.pendingApprovals.length) {
        badges.push(h("span", { class: "badge gate-block", text: "⏳ approval" }));
      }
      if (run.pendingInputs && run.pendingInputs.length) {
        badges.push(h("span", { class: "badge input-wait", text: "✎ input needed" }));
      }
      var badgeWrap = null;
      if (badges.length) {
        badgeWrap = h("span", null);
        badges.forEach(function (b) { badgeWrap.appendChild(b); });
      }
      var isAttached = S.runId === run.id;
      var row = h("div", {
        class: "wf liverun" + (isAttached ? " sel" : ""),
        role: "button",
        tabindex: "0",
        "aria-current": isAttached ? "true" : null,
        "aria-label": "Attach to " + run.workflow + " run",
        onClick: function () { attachRun(run); },
        onKeydown: function (event) {
          activateWithKeyboard(event, function () { attachRun(run); });
        }
      },
        h("div", { class: "name" }, run.workflow, h("span", { class: "src", text: run.source || "" })),
        h("div", { class: "desc", text: truncate(run.input || "", 60) }),
        h("div", { class: "meta" }, badgeWrap,
          h("span", { text: (isAttached ? "attached · " : "") + relTime(run.startedAt) }))
      );
      box.appendChild(row);
    });
  }

  function relTime(ts) {
    // Mirror formatRelativeTime() in history-browser.ts (web page isn't bundled).
    if (typeof ts !== "number" || !isFinite(ts) || ts <= 0) return "unknown";
    var sec = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (sec < 60) return sec + "s ago";
    var min = Math.round(sec / 60);
    if (min < 60) return min + "m ago";
    var hr = Math.round(min / 60);
    if (hr < 24) return hr + "h ago";
    var day = Math.round(hr / 24);
    if (day < 7) return day + "d ago";
    try { return new Date(ts).toISOString().slice(0, 10); } catch (e) { return "unknown"; }
  }

  /** Attach to an in-flight run: replay its record so far, then tail live. */
  function attachRun(run) {
    if (S.runId === run.id && S.es) {
      setRunDeepLink(run.id);
      return;
    }
    var known = S.workflows.some(function (w) { return w.name === run.workflow; });
    var begin = function () {
      S.runId = run.id;
      setRunDeepLink(run.id);
      setRunning(true);
      S.startedAt = run.startedAt || Date.now();
      startTimer();
      document.getElementById("statusLine").style.display = "flex";
      // Replay rebuilds the tree from the event stream (workflow_start keeps
      // seeded phases). Seeding from the catalog spec (when known) makes
      // not-yet-started steps visible — and editable while the run is paused.
      S.runState = known && S.spec
        ? SteamtrainReducer.workflowStateFromSpec(effectiveSpec() || S.spec)
        : SteamtrainReducer.initialWorkflowState;
      S.detail = null; S.tailScroll = {}; S.drawerScroll = { follow: true, top: 0 };
      setBanner(
        "Attached to " + (run.detached ? "detached " : "") + "run " + run.id.slice(0, 8) + "…" +
          (isReadOnly() ? " (read-only view)." : " — cancel stops the run itself."),
        "info"
      );
      openStream(run.id);
      render();
      renderLiveRuns();
    };
    if (known) {
      selectWorkflow(run.workflow, begin, { preserveRunDeepLink: true });
    } else {
      // Run of a workflow that is no longer in the catalog: attach with the
      // event stream alone (the reducer rebuilds phases from events).
      if (S.es) { S.es.close(); S.es = null; }
      stopTimer();
      S.selected = null; S.source = null;
      S.spec = { name: run.workflow, phases: [] };
      document.getElementById("wfTitle").textContent = run.workflow;
      document.getElementById("wfSub").textContent = "attached run (workflow not in catalog)";
      document.getElementById("runRow").style.display = "none";
      renderSidebar();
      begin();
    }
  }

  function showLoginForm() {
    var main = document.querySelector("main");
    clear(main);
    var msg = h("div", { class: "empty" },
      h("p", { text: "This server requires a token to access." }),
      h("p", { class: "ro", text: "Use the full auth token for control, or a read token to view runs only." }),
      h("div", { class: "login-form" },
        h("input", { type: "password", id: "loginToken", class: "txt", placeholder: "Enter auth or read token", autocomplete: "off" }),
        h("button", { class: "btn primary", id: "loginBtn", text: "Log in" })
      ),
      h("p", { class: "login-error", id: "loginError" })
    );
    main.appendChild(msg);
    document.getElementById("loginBtn").addEventListener("click", doLogin);
    document.getElementById("loginToken").addEventListener("keydown", function (e) {
      if (e.key === "Enter") doLogin();
    });
    document.getElementById("loginToken").focus();
  }

  function doLogin() {
    var input = document.getElementById("loginToken");
    var errEl = document.getElementById("loginError");
    if (errEl) errEl.textContent = "";
    var token = input ? input.value : "";
    if (!token) { if (errEl) errEl.textContent = "Token is required."; return; }
    api("POST", "/api/auth", { token: token }).then(function (r) {
      if (r.status === 200 && r.body.ok) {
        window.location.reload();
      } else {
        if (errEl) errEl.textContent = (r.body && r.body.error) || "Login failed.";
      }
    }).catch(function () {
      if (errEl) errEl.textContent = "Network error.";
    });
  }

  function loadProjectConfig() {
    apiAuth("GET", "/api/config").then(function (r) {
      if (r.status === 200) S.projectConfig = r.body;
    });
  }

  function openConfigModal() {
    if (isReadOnly()) { setBanner("This session is read-only — viewing only.", "info"); return; }
    if (!S.projectConfig) { setBanner("config is not available", "info"); return; }
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
        var provider = selectEl([
          { value: "claude", label: "claude" },
          { value: "opencode", label: "opencode" },
          { value: "codex", label: "codex" },
          { value: "amp", label: "amp" },
          { value: "kiro", label: "kiro" },
          { value: "cursor", label: "cursor" },
          { value: "antigravity", label: "antigravity" }
        ], a.provider || "claude");
        var binary = h("input", { class: "txt", placeholder: "default binary", value: a.binary || "" });
        var env = h("textarea", { class: "ta mini", placeholder: "env JSON", rows: "2" });
        env.value = a.env ? JSON.stringify(a.env) : "";
        var extraArgs = h("textarea", { class: "ta mini", placeholder: "[]", rows: "2" });
        extraArgs.value = JSON.stringify(a.extraArgs || []);
        var defaultModel = buildModelSelect(a);
        var scope = selectEl(instanceScopeOptions(), a.scope === "project" ? "project" : defaultScope);
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
          var newDefaultModel = buildModelSelect({ id: id.value.trim(), provider: provider.value, defaultModel: currentModel });
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
          field("ID", id, null, null, true),
          field("Provider", provider),
          field("Scope", scope, canGlobal
            ? "Global is the default (every project). Project writes to ./steamtrain.json."
            : "Running with a custom --config file; there is no separate global layer."),
          field("Label", label),
          field("Binary", binary),
          field("Env", env, "JSON object, merged into process env.", null, true),
          field("Extra args", extraArgs, "JSON array of flags appended before the prompt.", null, true),
          field("Default model", defaultModel, "Model ID or leave empty for provider default.", "field-model")
        );
        agentList.appendChild(rowEl);

        // Inline validation — wired AFTER field() so _fieldError is set
        addBlurValidation(id, function () {
          var v = id.value.trim();
          if (!v) return "Agent ID is required";
          var scopeVal = scope.value;
          var dup = agentRows.filter(function (r) { return r !== row; }).some(function (r) {
            return r.id.value.trim() === v && r.scope.value === scopeVal;
          });
          if (dup) return "Duplicate agent ID in this scope";
          return null;
        });
        addBlurValidation(env, function () {
          var v = env.value.trim();
          if (!v) return null;
          try { var p = JSON.parse(v); if (!p || Array.isArray(p) || typeof p !== "object") return "Must be a JSON object"; }
          catch (e) { return "Invalid JSON"; }
          return null;
        });
        addBlurValidation(extraArgs, function () {
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
      var fallback = preferredAgent();
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
        var provider = selectEl([
          { value: "anthropic", label: "anthropic" },
          { value: "openai", label: "openai (compatible)" }
        ], a.provider || "anthropic");
        var baseUrl = h("input", { class: "txt", placeholder: "provider default (openai style: include /v1)", value: a.baseUrl || "" });
        var apiKeyEnv = h("input", { class: "txt", placeholder: a.provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY", value: a.apiKeyEnv || "" });
        var defaultModel = h("input", { class: "txt", placeholder: "used when a step omits model", value: a.defaultModel || "" });
        var pricing = h("textarea", { class: "ta mini", placeholder: '{"inputPerMTok": 5, "outputPerMTok": 25}', rows: "2" });
        pricing.value = a.pricing ? JSON.stringify(a.pricing) : "";
        var scope = selectEl(instanceScopeOptions(), a.scope === "project" ? "project" : defaultScope);
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
          field("ID", id, null, null, true),
          field("Provider", provider, "API dialect: Anthropic Messages, or OpenAI chat-completions (Groq, Together, Ollama, vLLM, proxies)."),
          field("Scope", scope, canGlobal
            ? "Global is the default (every project). Project writes to ./steamtrain.json."
            : "Running with a custom --config file; there is no separate global layer."),
          field("Label", label),
          field("Base URL", baseUrl, "Endpoint override for proxies and compatible providers."),
          field("Key env var", apiKeyEnv, "Environment variable the API key is read from (the key itself is never stored)."),
          field("Default model", defaultModel, "Steps referencing this API inherit it when they omit model."),
          field("Pricing", pricing, "JSON per-MTok USD rates applied to steps without their own pricing.", null, true)
        );
        apiList.appendChild(rowEl);

        addBlurValidation(id, function () {
          var v = id.value.trim();
          if (!v) return "API ID is required";
          var scopeVal = scope.value;
          var dup = apiRows.filter(function (r) { return r !== row; }).some(function (r) {
            return r.id.value.trim() === v && r.scope.value === scopeVal;
          });
          if (dup) return "Duplicate API ID in this scope";
          return null;
        });
        addBlurValidation(pricing, function () {
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
      onClick: function () { closeModal(); openSetupPanel(); }
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
      field("Step timeout (minutes)", stepInput, "Per-agent subprocess limit (default 15). Saved to ./steamtrain.json."),
      field("Workflow timeout (minutes)", wfInput, "Whole-run limit. Leave empty or check auto to use steps × step timeout. Saved to ./steamtrain.json."),
      h("label", { style: "display:flex;gap:6px;align-items:center;margin-top:8px" },
        autoChk, h("span", { text: "Auto workflow timeout (steps × step)" }))
    );
    var saveBtn = h("button", { class: "btn primary", text: "Save" });
  saveBtn.addEventListener("click", function () {
      var stepSec = Number(stepInput.value) * 60;
      if (!stepSec || stepSec <= 0) { mbanner(banner, "step timeout must be a positive number of minutes", "err"); return; }
      if (agentList.querySelector(".invalid") || apiList.querySelector(".invalid")) { mbanner(banner, "Fix validation errors before saving", "err"); return; }
      var agents;
      var apis;
      try {
        agents = collectAgentConfigRows(agentRows);
        apis = collectApiConfigRows(apiRows);
      } catch (e) {
        mbanner(banner, e.message || String(e), "err");
        return;
      }
      var payload = { stepTimeoutSec: stepSec, agents: agents, apis: apis };
      if (autoChk.checked) payload.clearWorkflowTimeout = true;
      else {
        var wfSec = Number(wfInput.value) * 60;
        if (!wfSec || wfSec <= 0) { mbanner(banner, "workflow timeout must be a positive number of minutes", "err"); return; }
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
          closeModal();
          pollDoctor(0);
          setBanner("config saved", "info");
        } else {
          mbanner(banner, (r.body && r.body.error) || "save failed", "err");
        }
      });
    });
    openModal(modalShell("Config",
      canGlobal
        ? "Agents & APIs default to ~/.steamtrain/config.json · timeouts to ./steamtrain.json"
        : "Applies to the loaded config file",
      body,
      h("div", { class: "mfoot" },
        h("button", { class: "btn", text: "Cancel", onClick: closeModal }),
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

  // Agent/model/effort + API-instance catalogs for the create + configure forms.
  function loadMeta() {
    apiAuth("GET", "/api/meta").then(function (r) {
      S.agents = (r.body && r.body.agents) || [];
      S.apis = (r.body && r.body.apis) || [];
      S.modelClasses = (r.body && r.body.modelClasses) || [];
      S.modelFamilies = (r.body && r.body.modelFamilies) || [];
      applyHealth();
    });
  }
  // The server serves immediately and runs the doctors in the background, so
  // the health flags baked into /api/meta are often stale (all false) at first
  // paint. Fold the live /api/doctor results into the cached catalogs so the
  // create/configure pickers reflect real health once the doctors land,
  // without a full page reload. Handles either fetch resolving first.
  function applyHealth() {
    if (S.doctor.length && S.agents.length) {
      S.agents.forEach(function (a) {
        a.healthy = S.doctor.some(function (d) { return d.agent === a.id && d.status === "ok"; });
      });
    }
    if (S.apiDoctor.length && S.apis.length) {
      S.apis.forEach(function (a) {
        a.healthy = S.apiDoctor.some(function (d) { return d.api === a.id && d.status === "ok"; });
      });
    }
  }
  /** Catalog list item (with blocked/reroute annotations) for a workflow name. */
  function wfListItem(name) {
    for (var i = 0; i < S.workflows.length; i++) if (S.workflows[i].name === name) return S.workflows[i];
    return null;
  }

  /**
   * The blocked/re-route strip for the selected workflow. When the pinned
   * agent is not ready but another agent is, Run stays live and re-routes the
   * blocked steps for that ride only — the strip says so before the click.
   */
  function renderBlockedRow() {
    var row = document.getElementById("blockedRow");
    if (!row) return;
    clear(row);
    var item = S.selected ? wfListItem(S.selected) : null;
    var runBtn = document.getElementById("runBtn");
    var planBtn = document.getElementById("planBtn");
    if (!item || !item.blocked || isReadOnly()) {
      row.style.display = "none";
      if (runBtn) runBtn.disabled = false;
      if (planBtn) planBtn.disabled = false;
      return;
    }
    row.style.display = "flex";
    if (item.reroute) {
      var rr = item.reroute;
      var steps = rr.steps === 1 ? "1 step" : rr.steps + " steps";
      row.className = "reroute-row info";
      row.appendChild(h("span", { class: "reroute-icon", text: "↷" }));
      row.appendChild(h("span", {},
        h("b", {}, "Needs " + rr.blockedAgents.join(", ") + " (not ready). "),
        "Run re-routes " + steps + " to " + rr.agent + " · " + (rr.modelName || rr.model) +
        " for this ride only — the workflow itself is unchanged."));
      if (runBtn) runBtn.disabled = false;
      if (planBtn) planBtn.disabled = false;
    } else {
      row.className = "reroute-row err";
      row.appendChild(h("span", { class: "reroute-icon", text: "⚠" }));
      row.appendChild(h("span", { text: item.blocked }));
      if (runBtn) runBtn.disabled = true;
      if (planBtn) planBtn.disabled = true;
    }
  }

  function agentById(id) {
    for (var i = 0; i < S.agents.length; i++) if (S.agents[i].id === id) return S.agents[i];
    return null;
  }
  function apiInstanceById(id) {
    for (var i = 0; i < S.apis.length; i++) if (S.apis[i].id === id) return S.apis[i];
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
  function pollDoctor(attempt, onUpdate) {
    apiAuth("GET", "/api/doctor").then(function (r) {
      var list = r.body.doctor || [];
      var apis = r.body.apis || [];
      var err = r.body.doctorError;
      S.doctor = list;
      S.apiDoctor = apis;
      renderHealth(list, apis, err);
      applyHealth();
      // Repaint any open surface that depends on live health (the setup panel).
      if (onUpdate) { try { onUpdate(); } catch (e) {} }
      // The catalog's blocked/re-route annotations are computed server-side
      // from agent + API health, so re-fetch them whenever that health changes
      // — the initial arrival AND after a config save flips an agent's status
      // (a one-shot latch would leave a stale "blocked"/"via X" until reload).
      var healthSig = JSON.stringify([
        list.map(function (d) { return d.agent + ":" + d.status; }),
        apis.map(function (d) { return d.api + ":" + d.status; })
      ]);
      if ((list.length || apis.length) && healthSig !== S.healthSig) {
        S.healthSig = healthSig;
        refreshWorkflowList();
      }
      // Keep polling until BOTH probe sets have landed: the agent doctor
      // (local --version checks) usually resolves before the API doctor
      // (a network probe), and stopping early would leave the API chips blank.
      // An agent-doctor error is terminal for the agent set only — keep
      // waiting for the API probes in that case.
      var agentsPending = !list.length && !err;
      var apisPending = !apis.length;
      if ((agentsPending || apisPending) && attempt < 12) setTimeout(function () { pollDoctor(attempt + 1, onUpdate); }, 1500);
    });
  }

  /** A health chip that opens the setup panel (focused on `focusId` when given). */
  function healthChip(cls, label, title, focusId) {
    return h("button", {
      class: "chip chip-btn " + cls,
      type: "button",
      title: title + " · click for setup",
      onClick: function () { openSetupPanel(focusId); }
    }, h("span", { class: "dot" }), label);
  }

  function renderHealth(list, apis, err) {
    var box = document.getElementById("health");
    clear(box);
    if (isCredentialFreeSpec(S.spec)) {
      box.appendChild(h("span", {
        class: "chip ok",
        title: "This workflow needs no agent CLI and no API key."
      }, h("span", { class: "dot" }), "ready to ride · no agents required"));
      return;
    }
    // An agent-doctor failure replaces the agent chips with one error chip,
    // but the API probes are independent — always render their chips too.
    if (err) {
      box.appendChild(healthChip("bad", "doctor: " + err, "The agent doctor failed to run"));
    } else {
      // Loud states (needs sign-in / error) each get their own chip so they
      // stay actionable; the calm "not installed" state — normal for a CLI you
      // don't use — collapses into one quiet chip to avoid a wall of red.
      var calm = [];
      list.forEach(function (d) {
        var meta = agentHealthMeta(d.status);
        if (meta.loud || d.status === "ok") {
          var detail = d.detail ? " · " + d.detail : "";
          box.appendChild(healthChip(meta.chip, d.agent, d.agent + ": " + (d.message || meta.label) + detail, d.agent));
        } else {
          calm.push(d);
        }
      });
      if (calm.length) {
        box.appendChild(healthChip("calm", calm.length + " not installed",
          calm.map(function (d) { return d.agent; }).join(", ") + " — not on PATH (fine if you don't use them)"));
      }
    }
    var apiCalm = [];
    apis.forEach(function (d) {
      var meta = apiHealthMeta(d.status);
      if (meta.loud || d.status === "ok") {
        var detail = d.detail ? " · " + d.detail : "";
        box.appendChild(healthChip(meta.chip, d.api, d.api + ": " + (d.message || meta.label) + detail, "api:" + d.api));
      } else {
        apiCalm.push(d);
      }
    });
    if (apiCalm.length) {
      box.appendChild(healthChip("calm", "◇ " + apiCalm.length + " without keys",
        apiCalm.map(function (d) { return d.api; }).join(", ") + " — no API key set (llm steps skip them)"));
    }
  }

  /** Copy `text`, then flash the button's label so the click has a visible result. */
  function copyFix(text, btn, codeEl) {
    function flash() {
      btn.textContent = "Copied";
      btn.classList.add("copied");
      setTimeout(function () { btn.textContent = "Copy"; btn.classList.remove("copied"); }, 1400);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(flash).catch(function () { fallbackCopy(text, codeEl, flash); });
      return;
    }
    fallbackCopy(text, codeEl, flash);
  }

  /**
   * Copy without the async clipboard API (insecure context, or a browser that
   * rejects the write): try execCommand on a scratch textarea, and if even that
   * fails, select the visible command so the user can copy it by hand.
   */
  function fallbackCopy(text, codeEl, onOk) {
    try {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      var ok = document.execCommand("copy");
      document.body.removeChild(ta);
      if (ok) { onOk(); return; }
    } catch (e) {}
    if (codeEl) {
      var range = document.createRange();
      range.selectNodeContents(codeEl);
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
  }

  /**
   * The agent & API setup panel: the web analog of `steamtrain init`'s readiness
   * table. Every agent and API endpoint, its live status, and — for anything not
   * ready — the exact fix with a one-click copy, plus a Recheck that re-runs the
   * doctors in place. Opened by clicking any header health chip.
   */
  function openSetupPanel(focusId) {
    var body = h("div", { class: "setup" });
    var recheckBtn = h("button", { class: "btn", type: "button", text: "Recheck" });
    var footChildren = [recheckBtn];
    if (!isReadOnly()) {
      footChildren.push(h("button", {
        class: "btn", type: "button", text: "Edit config →",
        title: "Add or edit agent/API instances, binaries, and timeouts",
        onClick: function () { closeModal(); openConfigModal(); }
      }));
    }
    footChildren.push(h("div", { class: "spacer" }));
    footChildren.push(h("button", { class: "btn primary", type: "button", text: "Done", onClick: closeModal }));
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

    recheckBtn.addEventListener("click", function () {
      recheckBtn.disabled = true;
      recheckBtn.textContent = "Rechecking…";
      apiAuth("GET", "/api/doctor").then(function (r) {
        if (r.status === 200) {
          S.doctor = r.body.doctor || [];
          S.apiDoctor = r.body.apis || [];
          renderHealth(S.doctor, S.apiDoctor, r.body.doctorError || null);
          applyHealth();
        }
      }).catch(function () {}).then(function () {
        recheckBtn.disabled = false;
        recheckBtn.textContent = "Recheck";
        renderBody();
      });
    });

    renderBody();
    openModal(modalShell("Agent & API setup",
      "Get each one ready — install, sign in, done. Health refreshes as you go.",
      body, foot, true));
    // Health may still be landing on first open; keep the panel live until it does.
    if (!(S.doctor || []).length && !(S.apiDoctor || []).length) {
      pollDoctor(0, renderBody);
    }
  }

  /** Minimal CSS.escape shim for our ids (ascii ids: agent names, "api:<id>"). */
  function cssEscape(value) {
    if (window.CSS && window.CSS.escape) return window.CSS.escape(value);
    return String(value).replace(/[^a-zA-Z0-9_-]/g, function (c) { return "\\" + c; });
  }

  function renderSidebar() {
    var box = document.getElementById("wflist");
    clear(box);
    // Pin tour to the top on Station landing so the door is obvious.
    var list = S.workflows.slice();
    if (S.stationLanding) {
      list.sort(function (a, b) {
        if (a.name === TOUR_NAME) return -1;
        if (b.name === TOUR_NAME) return 1;
        return 0;
      });
    }
    list.forEach(function (w) {
      var kinds = Object.keys(w.kinds || {}).map(function (k) { return (KIND_LABEL[k] || k) + ":" + w.kinds[k]; }).join(" \u00b7 ");
      var meta = w.phaseCount + " phase" + (w.phaseCount === 1 ? "" : "s") + " \u00b7 " + w.stepCount + " step" + (w.stepCount === 1 ? "" : "s");
      var isStaged = workflowHasStaged(S.stagedOverrides[w.name]);
      var autonomy = AUTONOMY_META[w.autonomy] || AUTONOMY_META.autonomous;
      var isTour = w.name === TOUR_NAME;
      var card = h("div", {
        class: "wf" + (S.selected === w.name ? " sel" : "") + (isTour && S.stationLanding ? " station" : ""),
        role: "button",
        tabindex: "0",
        "aria-current": S.selected === w.name ? "true" : null,
        "aria-label": "Open workflow " + w.name,
        onClick: function () { selectWorkflow(w.name); },
        onKeydown: function (event) {
          activateWithKeyboard(event, function () { selectWorkflow(w.name); });
        }
      },
        h("div", { class: "name" }, w.name,
          isTour && S.stationLanding ? h("span", { class: "badge start-here", text: "start here" }) : null,
          h("span", { class: "src", text: w.source }),
          h("span", { class: "badge " + autonomy.cls, text: autonomy.badge, title: autonomy.title }),
          isStaged ? h("span", { class: "badge staged", text: "staged" }) : null,
          w.blocked ? h("span", {
            class: "badge " + (w.reroute ? "reroute" : "blocked"),
            text: w.reroute ? "↷ via " + w.reroute.agent : "blocked",
            title: w.blocked
          }) : null),
        w.description ? h("div", { class: "desc", text: w.description }) : null,
        h("div", { class: "meta", text: isTour && S.stationLanding
          ? "zero-cost guided ride \u00b7 no agents"
          : (meta + (kinds ? " \u00b7 " + kinds : "")) })
      );
      box.appendChild(card);
    });
  }

  function selectWorkflow(name, after, options) {
    if (!(options && options.preserveRunDeepLink) && currentRunDeepLink()) clearRunDeepLink();
    // Ignore any plan response that was initiated for the previously selected
    // workflow while its asynchronous history lookup was still running.
    S.planRequest += 1;
    if (S.es) { S.es.close(); S.es = null; }
    stopTimer();
    S.selected = name; S.runId = null; S.runState = null;
    S.detail = null; S.detailInvoker = null; S.detailFallback = null; S.detailFocusPending = false; S.detailFocusGeneration += 1;
    S.tailScroll = {}; S.drawerScroll = { follow: true, top: 0 };
    S.narration = []; S.arrivalInspect = false; S.arrivalEnter = false; S.endedAt = 0;
    S.narrationFreshPlayed = null;
    if (name !== TOUR_NAME) {
      S.stationLanding = false;
      S.tourRiding = false;
      S.stationCtaFocused = false;
      S.arrivalCtaFocused = false;
      S.conductorLinePlayed = null;
      endTourDeparture();
    }
    document.body.classList.remove("arrival-failed");
    try { localStorage.setItem(SELECTION_KEY, name); } catch (e) {}
    renderSidebar();
    document.getElementById("statusLine").style.display = "none";
    setBanner("", "");
    apiAuth("GET", "/api/workflows/" + encodeURIComponent(name)).then(function (r) {
      if (r.status !== 200) { setBanner(r.body.error || "failed to load", "err"); return; }
      S.spec = r.body.spec;
      S.source = r.body.source;
      document.getElementById("wfTitle").textContent = r.body.spec.name;
      document.getElementById("wfSub").textContent = r.body.spec.description || "";
      document.getElementById("runRow").style.display = isReadOnly() ? "none" : "flex";
      renderSourceLine();
      renderBlockedRow();
      renderParamsForm(r.body.spec);
      S.runState = SteamtrainReducer.workflowStateFromSpec(effectiveSpec() || r.body.spec);
      renderHealth(S.doctor || [], S.apiDoctor || [], null);
      render();
      renderStagedIndicator();
      if (after) after();
    });
  }

  // Re-run / retry-failed a recorded run: launch via the history route, then
  // switch to the live run view for the returned run id.
  function rerunHistory(id, workflow, mode) {
    apiAuth("POST", "/api/history/" + encodeURIComponent(id) + "/" + mode).then(function (r) {
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
        setRunDeepLink(runId);
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
    if (!isReadOnly() && S.source !== "user" && S.source !== "project") {
      line.appendChild(h("span", { text: "\u00b7 configuring saves a user copy" }));
    }
    document.getElementById("wfActions").style.display = isReadOnly() ? "none" : "flex";
    document.getElementById("deleteBtn").style.display =
      (!isReadOnly() && (S.source === "user" || S.source === "project")) ? "block" : "none";
  }

  function renderParamsForm(spec) {
    var container = document.getElementById("paramsForm");
    clear(container);
    var inputs = spec && spec.inputs;
    if (!inputs || Object.keys(inputs).length === 0) {
      container.style.display = "none";
      return;
    }
    container.style.display = "flex";
    Object.keys(inputs).forEach(function (key) {
      var inp = inputs[key];
      var type = inp.type || "string";
      var required = inp.required === true || (inp.required !== false && inp.default === undefined);
      var defaultStr = inp.default !== undefined ? String(inp.default) : "";
      var labelText = key;
      var typeHint = type === "boolean" ? " (y/n)" : type === "number" ? " (number)" : "";
      var hint = inp.description || "";
      if (defaultStr) hint = hint ? hint + " \u00b7 default: " + defaultStr : "default: " + defaultStr;

      var control;
      if (type === "boolean") {
        control = selectEl([
          { value: "", label: "(not set)" },
          { value: "true", label: "yes" },
          { value: "false", label: "no" }
        ], defaultStr === "true" ? "true" : defaultStr === "false" ? "false" : "");
      } else {
        control = h("input", {
          class: "txt",
          type: type === "number" ? "number" : "text",
          placeholder: defaultStr || (required ? "required" : ""),
          value: defaultStr
        });
      }
      control.setAttribute("data-param-key", key);

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
        hint ? h("div", { class: "hint", text: hint }) : null, errEl);
      container.appendChild(wrapper);

      if (required || type === "number") {
        control._fieldError = errEl;
        addBlurValidation(control, function () {
          var val = control.value;
          if (required && (!val || (typeof val === "string" && !val.trim()))) return key + " is required";
          if (type === "number" && val && isNaN(Number(val))) return key + " must be a number";
          return null;
        });
      }
    });
  }

  function collectParams() {
    var container = document.getElementById("paramsForm");
    if (container.style.display === "none") return undefined;
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

  // ---- run model -----------------------------------------------------------
  function reduce(ev) {
    if (!S.runState) {
      S.runState = SteamtrainReducer.initialWorkflowState;
    }
    S.runState = SteamtrainReducer.workflowReducer(S.runState, { type: "event", event: ev });
    if (SteamtrainReducer.appendNarration) {
      S.narration = SteamtrainReducer.appendNarration(S.narration || [], ev);
    }
  }

  // ---- rendering -----------------------------------------------------------
  function scheduleRender() {
    if (S.rafQueued) return;
    S.rafQueued = true;
    requestAnimationFrame(function () { S.rafQueued = false; render(); });
  }

  function renderStationAtmosphere(canvas) {
    var engine = h("div", { class: "engine", "aria-hidden": "true" });
    engine.innerHTML =
      '<svg viewBox="0 0 380 160" fill="none" xmlns="http://www.w3.org/2000/svg">' +
      '<path d="M28 118h268c14 0 26-10 26-24V72c0-16-13-29-29-29H168l-28-28H62c-12 0-22 10-22 22v81z" fill="#1c6f68"/>' +
      '<path d="M48 58h62l22 28h158c8 0 14 6 14 14v42c0 5-4 9-9 9H48V58z" fill="#34d3c4"/>' +
      '<rect x="62" y="72" width="28" height="18" rx="3" fill="#0e1116" opacity=".55"/>' +
      '<rect x="102" y="72" width="28" height="18" rx="3" fill="#0e1116" opacity=".4"/>' +
      '<path d="M214 38c0-16 8-30 14-38 2-3 8-2 8 2 0 10-2 18-2 28 0 5 3 8 8 6 12-6 22-18 26-30 1-3 6-3 6 0 2 16-8 34-22 44-6 5-14 8-22 8h-16V38z" fill="#8eeae0"/>' +
      '<circle cx="92" cy="128" r="22" fill="#0e1116" stroke="#34d3c4" stroke-width="4"/>' +
      '<circle cx="92" cy="128" r="8" fill="#34d3c4"/>' +
      '<circle cx="168" cy="128" r="22" fill="#0e1116" stroke="#34d3c4" stroke-width="4"/>' +
      '<circle cx="168" cy="128" r="8" fill="#34d3c4"/>' +
      '<circle cx="244" cy="128" r="18" fill="#0e1116" stroke="#34d3c4" stroke-width="3.5"/>' +
      '<circle cx="244" cy="128" r="6" fill="#34d3c4"/>' +
      '<path d="M28 118h290" stroke="#d29922" stroke-width="3" stroke-linecap="round" opacity=".75"/>' +
      '<rect x="300" y="78" width="42" height="28" rx="4" fill="#1c6f68"/>' +
      '<path d="M312 78v-16h18v16" stroke="#8eeae0" stroke-width="3" fill="none"/>' +
      "</svg>";
    var atmClass = "station-atmosphere";
    if (S.departing) atmClass += " departing";
    else if (document.body.dataset.mode === "ride") atmClass += " riding";
    // Steam is anchored to the stack (right side of the engine), not floating orbs.
    canvas.appendChild(h("div", { class: atmClass, "aria-hidden": "true" },
      h("div", { class: "glow-a" }),
      h("div", { class: "glow-b" }),
      h("div", { class: "rails" }),
      h("div", { class: "platform" }),
      h("div", { class: "signal" }),
      engine,
      h("div", { class: "steam stack" }),
      h("div", { class: "steam-b stack" }),
      h("div", { class: "steam-c stack" })
    ));
  }

  function renderStationHero(canvas) {
    var landing = !!S.stationLanding;
    if (landing) renderStationAtmosphere(canvas);

    var logo = h("div", { class: "station-logo" });
    logo.appendChild(h("span", { class: "brand-mark", "aria-hidden": "true" }));
    var accent = h("span", { class: "accent", text: "steam" });
    logo.appendChild(accent);
    logo.appendChild(document.createTextNode("train"));

    var hasOther = S.workflows.some(function (w) { return w.name !== TOUR_NAME; });
    var cta = null;
    if (!isReadOnly()) {
      cta = h("button", {
        class: "btn primary station-cta",
        text: landing ? "Take the tour \u2192" : "Ride the tour \u2192",
        onClick: function () {
          var input = document.getElementById("input");
          if (input && !input.value.trim()) input.value = "all aboard";
          startRun();
        }
      });
    }

    var band = h("div", { class: "station-hero" + (landing ? "" : " compact") },
      h("div", { class: "station-brand" },
        logo,
        landing
          ? h("div", { class: "station-tagline", text: "agent orchestrator on rails" })
          : null
      ),
      landing
        ? h("div", { class: "station-eyebrow", text: "Platform 1 \u00b7 free tour" })
        : null,
      h("div", {
        class: "station-premise",
        text: "Parallel agents. One receipt."
      }),
      landing
        ? h("div", {
            class: "station-sub",
            text: "Take the free tour \u00b7 no agents, no API key, about one second."
          })
        : null,
      h("div", { class: "station-actions" },
        cta,
        landing
          ? h("button", {
              class: "btn small station-secondary",
              text: hasOther ? "I have a workflow" : "See the pipeline",
              onClick: function () {
                S.stationLanding = false;
                syncBodyMode();
                renderSidebar();
                var other = S.workflows.find(function (w) { return w.name !== TOUR_NAME; });
                if (other) selectWorkflow(other.name);
                else {
                  // No other workflow yet: leave full-bleed Station but keep the
                  // tour selected so the compact strip + pipeline is visible.
                  selectWorkflow(TOUR_NAME);
                }
              }
            })
          : null
      )
    );
    canvas.appendChild(band);
    if (landing && cta && !S.stationCtaFocused) {
      S.stationCtaFocused = true;
      requestAnimationFrame(function () {
        try { cta.focus({ preventScroll: true }); } catch (e) { cta.focus(); }
      });
      announce("steamtrain Station. Take the free tour.");
    }
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

  function syncBodyMode() {
    var boarding = !S.spec && (!S.selected || S.stationLanding);
    var stationOn =
      boarding ||
      (S.stationLanding &&
        S.selected === TOUR_NAME &&
        !(S.runState && S.runState.started));
    var arrivalOn =
      !stationOn &&
      S.runState &&
      S.runState.done &&
      !S.arrivalInspect &&
      !S.departing;
    // Tour ride: keep the atmospheric yard (no sidebar / run form) while the
    // thin header + status line stay available for errors and cancel.
    var rideOn =
      !stationOn &&
      !arrivalOn &&
      S.tourRiding &&
      S.selected === TOUR_NAME &&
      (S.departing || !(S.runState && S.runState.done));
    if (stationOn) document.body.dataset.mode = "station";
    else if (rideOn) document.body.dataset.mode = "ride";
    else if (arrivalOn) document.body.dataset.mode = "arrival";
    else delete document.body.dataset.mode;
    if (rideOn && S.departing) document.body.dataset.departing = "true";
    else delete document.body.dataset.departing;
    if (arrivalOn && S.runState && S.runState.ok === false) {
      document.body.classList.add("arrival-failed");
    } else {
      document.body.classList.remove("arrival-failed");
    }
  }
  // Back-compat alias for any call sites that still use the old name.
  function syncStationMode() { syncBodyMode(); }

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
          render();
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

  /** Collect cars for the yard track: live run state, else ghost cars from the spec.
   *  Loop iterations collapse to one plaque per stepId (latest status wins). */
  function collectYardCars() {
    var cars = [];
    var byId = {};
    function upsert(car) {
      var prev = byId[car.id];
      if (!prev) {
        byId[car.id] = car;
        cars.push(car);
        return;
      }
      // Prefer running > error > done/skip > pending when collapsing loops.
      var rank = { running: 4, error: 3, done: 2, pending: 1 };
      var nextRank = rank[car.status] || 0;
      var prevRank = rank[prev.status] || 0;
      if (car.skipped) nextRank = Math.max(nextRank, 2);
      if (nextRank >= prevRank) {
        prev.status = car.status;
        prev.skipped = car.skipped;
        prev.kind = car.kind || prev.kind;
        prev.phaseTitle = car.phaseTitle || prev.phaseTitle;
      }
    }
    if (S.runState && S.runState.phases && S.runState.phases.length) {
      S.runState.phases.forEach(function (p) {
        (p.steps || []).forEach(function (s) {
          upsert({
            id: s.stepId,
            kind: s.blockKind,
            status: s.status || "pending",
            skipped: !!(s.result && s.result.skipped),
            phaseTitle: p.title || p.phaseId
          });
        });
      });
      return cars;
    }
    (S.spec && S.spec.phases || []).forEach(function (p) {
      (p.steps || []).forEach(function (s) {
        upsert({
          id: s.id,
          kind: s.kind,
          status: "pending",
          skipped: false,
          phaseTitle: p.title || p.id
        });
      });
    });
    return cars;
  }

  function renderYardTrack(parent) {
    var cars = collectYardCars();
    if (!cars.length) return;
    var yard = h("div", {
      class: "yard-track",
      role: "list",
      "aria-label": "Cars on the track"
    });
    cars.forEach(function (c, i) {
      var cls = "yard-car " + (c.status || "pending");
      if (c.skipped) cls += " skip";
      if (c.status === "running") cls += " live";
      yard.appendChild(h("div", {
        class: cls,
        role: "listitem",
        style: "animation-delay:" + (i * 55) + "ms",
        title: (c.phaseTitle ? c.phaseTitle + " · " : "") + c.id
      },
        h("span", { class: "yard-car-kind", text: KIND_LABEL[c.kind] || c.kind || "car" }),
        h("span", { class: "yard-car-name", text: friendlyStepLabel(c.id) })
      ));
    });
    parent.appendChild(yard);
  }

  /** Full-bleed Conductor presence with live yard cars under the headline. */
  function renderConductorStage(canvas) {
    renderStationAtmosphere(canvas);
    var latest = (S.narration && S.narration.length)
      ? S.narration[S.narration.length - 1]
      : { id: "depart-seed", text: "All aboard \u2014 doors closing." };
    var lineText = latest.text || "All aboard \u2014 doors closing.";
    var lineId = latest.id || lineText;
    var playFresh = lineId && lineId !== S.conductorLinePlayed;
    if (playFresh) S.conductorLinePlayed = lineId;

    var doneCount = 0;
    var totalCount = 0;
    collectYardCars().forEach(function (c) {
      totalCount += 1;
      if (c.skipped || c.status === "done" || c.status === "error") doneCount += 1;
    });
    var sub = S.runState && S.runState.done
      ? "Approaching the platform\u2026"
      : (totalCount
          ? (doneCount + " of " + totalCount + " cars clear of the yard")
          : "Watching the cars leave the yard\u2026");

    var stage = h("div", { class: "conductor-stage" },
      h("div", { class: "conductor-stage-kicker", text: "Conductor" }),
      h("div", {
        class: "conductor-stage-line" + (playFresh ? " fresh" : ""),
        text: lineText
      }),
      h("div", { class: "conductor-stage-sub", text: sub })
    );
    renderYardTrack(stage);
    // Keep a short recent log so the ride feels like a sequence, not a freeze-frame.
    if (S.narration && S.narration.length > 1) {
      var trail = h("div", { class: "conductor-trail", "aria-hidden": "true" });
      S.narration.slice(-4, -1).reverse().forEach(function (line) {
        trail.appendChild(h("div", { class: "conductor-trail-line", text: line.text }));
      });
      stage.appendChild(trail);
    }
    canvas.appendChild(stage);
    if (playFresh) announce("Conductor: " + lineText);
  }

  function tourDepartRemaining() {
    if (!S.departing || !S.departAt) return 0;
    // Long enough to feel the engine leave and the first cars move.
    return Math.max(0, 3200 - (Date.now() - S.departAt));
  }

  function beginTourDeparture() {
    S.stationLanding = false;
    S.stationCtaFocused = false;
    S.arrivalCtaFocused = false;
    S.tourRiding = true;
    S.departing = true;
    S.departAt = Date.now();
    S.conductorLinePlayed = null;
    if (S.arrivalHoldTimer) {
      clearTimeout(S.arrivalHoldTimer);
      S.arrivalHoldTimer = null;
    }
    // Seed the Conductor line immediately so the stage is never blank.
    if (!S.narration || !S.narration.length) {
      S.narration = [{
        id: "depart-seed",
        text: "All aboard \u2014 doors closing.",
        ts: Date.now()
      }];
    }
    announce("Tour departing. Conductor on the platform.");
  }

  function endTourDeparture() {
    S.departing = false;
    if (S.arrivalHoldTimer) {
      clearTimeout(S.arrivalHoldTimer);
      S.arrivalHoldTimer = null;
    }
  }

  function completeTourRide() {
    // Arrival owns the hall — drop ride flags so inspect cannot revive Conductor stage.
    S.arrivalEnter = true;
    S.tourRiding = false;
    endTourDeparture();
  }

  function revealArrivalWhenReady() {
    if (S.arrivalHoldTimer) {
      clearTimeout(S.arrivalHoldTimer);
      S.arrivalHoldTimer = null;
    }
    var wait = (S.selected === TOUR_NAME && S.tourRiding) ? tourDepartRemaining() : 0;
    if (wait > 0) {
      S.arrivalHoldTimer = setTimeout(function () {
        S.arrivalHoldTimer = null;
        // Set arrivalEnter before clearing departing so syncBodyMode never
        // sees a frame with neither ride nor arrival armed.
        completeTourRide();
        render();
      }, wait);
      // Keep ride stage painted until the hold ends.
      render();
      return;
    }
    completeTourRide();
    render();
  }

  /** Split consolidator prose into a lead + titled sections when present. */
  function parseArrivalSections(body) {
    var text = (body || "").trim();
    if (!text) return [];
    var parts = text.split(/\n(?=---\s+)/);
    if (parts.length < 2) return [];
    var sections = [];
    parts.forEach(function (chunk) {
      var m = chunk.match(/^---\s*(.+?)\s*---\s*\n?([\s\S]*)$/);
      if (m) {
        sections.push({ title: m[1].trim(), body: (m[2] || "").trim() });
      } else if (chunk.trim()) {
        sections.push({ title: "", body: chunk.trim() });
      }
    });
    return sections.length > 1 ? sections : [];
  }

  function renderArrival(canvas) {
    if (!S.runState || !S.runState.done || !SteamtrainReducer.buildArrivalReport) return false;
    var report = SteamtrainReducer.buildArrivalReport(S.runState, {
      elapsedMs: S.startedAt
        ? ((S.endedAt || Date.now()) - S.startedAt)
        : 0,
      credentialFree: isCredentialFreeSpec(S.spec),
      nextWorkflow: pickNextWorkflow()
    });
    if (!report) return false;
    var headline = SteamtrainReducer.formatArrivalHeadline
      ? SteamtrainReducer.formatArrivalHeadline(report.receipt, S.runState.name || S.selected)
      : (report.receipt.ok ? "Arrival" : "Stopped short");
    var cards = SteamtrainReducer.arrivalReceiptCards
      ? SteamtrainReducer.arrivalReceiptCards(report.receipt)
      : [];
    var enter = S.arrivalEnter;
    if (enter) S.arrivalEnter = false;
    var wrap = h("div", {
      class: "arrival" + (report.receipt.ok ? " ok" : " failed") + (enter ? " enter" : "")
    });
    wrap.appendChild(h("div", {
      class: "arrival-kicker",
      text: report.receipt.ok ? "End of the line" : "Stopped short"
    }));
    wrap.appendChild(h("div", { class: "arrival-title", text: headline }));
    if (cards.length) {
      var grid = h("div", { class: "arrival-cards" });
      cards.forEach(function (c) {
        grid.appendChild(h("div", { class: "arrival-card" },
          h("div", { class: "arrival-card-label", text: c.label }),
          h("div", { class: "arrival-card-value", text: c.value })
        ));
      });
      wrap.appendChild(grid);
    } else {
      wrap.appendChild(h("div", {
        class: "arrival-receipt",
        text: SteamtrainReducer.formatArrivalReceipt(report.receipt)
      }));
    }
    // Status grid: human-labeled cars (pass / fail / skip) at a glance.
    // Collapse loop iterations so each car appears once on the climax.
    var statusGrid = h("div", { class: "arrival-status-grid", "aria-label": "Cars that rode" });
    var arrivalCarOrder = [];
    var arrivalCarLatest = {};
    (S.runState.phases || []).forEach(function (p) {
      (p.steps || []).forEach(function (s) {
        if (!arrivalCarLatest[s.stepId]) arrivalCarOrder.push(s.stepId);
        arrivalCarLatest[s.stepId] = s;
      });
    });
    arrivalCarOrder.forEach(function (id) {
      var s = arrivalCarLatest[id];
      var cls = "arrival-car";
      if (s.result && s.result.skipped) cls += " skip";
      else if (s.status === "done") cls += " ok";
      else if (s.status === "error") cls += " fail";
      var kind = KIND_LABEL[s.blockKind] || s.blockKind || "car";
      statusGrid.appendChild(h("div", {
        class: cls,
        title: s.stepId + " · " + kind
      },
        h("span", { class: "arrival-dot", "aria-hidden": "true" }),
        h("span", { class: "arrival-car-kind", text: kind }),
        h("span", { class: "arrival-car-label", text: friendlyStepLabel(s.stepId) })
      ));
    });
    if (statusGrid.childNodes.length > 0) wrap.appendChild(statusGrid);

    // Destinations before the artifact so next actions stay in the first viewport.
    var dest = h("div", { class: "arrival-destinations" });
    var primaryBtn = null;
    report.destinations.forEach(function (d) {
      if (d.id === "again" && isReadOnly()) return;
      var label = d.label;
      var title = null;
      if (d.workflow && workflowNeedsCredentials(d.workflow)) {
        label = d.label + " \u00b7 needs an agent";
        title = "This workflow needs an agent CLI or API key.";
      }
      var btn = h("button", {
        class: "btn" + (d.id === "again" ? " primary" : ""),
        text: label,
        title: title,
        onClick: function () {
          if (d.id === "again") startRun();
          else if (d.id === "history") openHistory();
          else if (d.workflow) selectWorkflow(d.workflow);
        }
      });
      if (d.id === "again") primaryBtn = btn;
      dest.appendChild(btn);
    });
    wrap.appendChild(dest);

    // Artifact: lead line as display text; car sections when the consolidator used --- markers.
    var heroText = report.hero || "";
    var heroLines = heroText.split("\n");
    var lead = (heroLines[0] || "").trim().replace(/^\uD83D\uDE82\s*/, "");
    var rest = heroLines.slice(1).join("\n").replace(/^\n+/, "").trim();
    var sections = parseArrivalSections(rest);
    var artifact = h("div", { class: "arrival-artifact" },
      h("div", { class: "arrival-artifact-label", text: "Arrival report" }),
      lead ? h("div", { class: "arrival-artifact-lead", text: lead }) : null
    );
    if (sections.length) {
      var body = h("div", { class: "arrival-sections" });
      sections.forEach(function (sec) {
        var block = h("div", { class: "arrival-section" });
        if (sec.title) block.appendChild(h("div", { class: "arrival-section-title", text: sec.title }));
        if (sec.body) block.appendChild(h("div", { class: "arrival-section-body", text: sec.body }));
        body.appendChild(block);
      });
      artifact.appendChild(body);
    } else if (rest) {
      artifact.appendChild(h("div", { class: "arrival-hero-prose", text: rest }));
    }
    wrap.appendChild(artifact);
    wrap.appendChild(h("button", {
      class: "btn small arrival-inspect",
      text: S.arrivalInspect ? "Hide step details" : "Show step details",
      onClick: function () { S.arrivalInspect = !S.arrivalInspect; render(); }
    }));
    canvas.appendChild(wrap);
    if (enter) {
      announce(headline);
      if (primaryBtn && !S.arrivalCtaFocused && !isReadOnly()) {
        S.arrivalCtaFocused = true;
        requestAnimationFrame(function () {
          try { primaryBtn.focus({ preventScroll: true }); } catch (e) { primaryBtn.focus(); }
        });
      }
    }
    return true;
  }

  function render() {
    var canvas = document.getElementById("canvas");
    clear(canvas);
    syncBodyMode();
    if (!S.spec) {
      renderStationAtmosphere(canvas);
      canvas.appendChild(h("div", { class: "empty station-empty" },
        h("div", { class: "station-logo" },
          h("span", { class: "brand-mark", "aria-hidden": "true" }),
          h("span", { class: "accent", text: "steam" }),
          "train"
        ),
        h("div", { class: "station-premise", text: "Parallel agents. One receipt." }),
        h("div", { class: "boarding-pulse", text: "Boarding\u2026" })
      ));
      return;
    }

    // First-run station: hero only — one composition, no pipeline noise.
    if (S.stationLanding && S.selected === TOUR_NAME && !(S.runState && S.runState.started)) {
      renderStationHero(canvas);
      updateProgress();
      return;
    }

    // Tour ride stage: Conductor owns the yard until Arrival is ready.
    if (
      S.tourRiding &&
      S.selected === TOUR_NAME &&
      (S.departing || (S.runState && !S.runState.done)) &&
      !S.arrivalInspect
    ) {
      renderConductorStage(canvas);
      updateProgress();
      return;
    }

    // Returning to tour (not first-run): keep a compact boarding banner above the pipeline.
    if (S.selected === TOUR_NAME && !(S.runState && S.runState.started) && !S.departing) {
      renderStationHero(canvas);
    }

    var showingArrival = false;
    if (S.runState && S.runState.done && !S.departing) {
      if (!S.arrivalInspect) renderStationAtmosphere(canvas);
      showingArrival = renderArrival(canvas);
    }

    if (showingArrival && !S.arrivalInspect) {
      updateProgress();
      return;
    }

    renderNarration(canvas);
    renderLegendOrTrack(canvas);

    var maxIter = {};
    var phases = S.runState ? S.runState.phases : [];
    phases.forEach(function (p) {
      if (p.iteration && (!maxIter[p.phaseId] || p.iteration > maxIter[p.phaseId])) maxIter[p.phaseId] = p.iteration;
    });

    phases.forEach(function (p, idx) {
      if (idx > 0) {
        var prevPhase = phases[idx - 1];
        var prevDone = prevPhase && prevPhase.done;
        var prevOk = prevPhase && prevPhase.ok;
        var curRunning = (p.steps || []).some(function (s) { return s.status === "running"; });
        var curDone = p.done;
        var connCls = "connector";
        if (prevDone && prevOk && curRunning) connCls += " active";
        else if (prevDone && prevOk && curDone) connCls += " done";
        else if (prevDone && !prevOk && curDone && p.ok) connCls += " done";
        else if (prevDone && !prevOk) connCls += " err";
        else if (S.runState && S.runState.started && prevDone) connCls += " active";
        var connEl = h("div", { class: connCls });
        if (connCls.indexOf("active") >= 0) {
          connEl.style.animationDelay = "-" + (Date.now() % 600) + "ms";
        }
        canvas.appendChild(connEl);
      }
      var piter = p.iteration || 1;
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
        if (isLatest) cards.appendChild(renderCard(s, p));
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

    if (S.runState && S.runState.done && S.arrivalInspect) renderSummary(canvas);
    updateProgress();
    applyTailScroll(canvas);
    renderDetail();
  }

  /**
   * Re-apply each tail pane's scroll position after the canvas rebuild:
   * following panes pin to the newest line, paused ones stay where the reader
   * left them. Must run after the nodes are in the DOM (scrollHeight is 0
   * before layout).
   */
  function applyTailScroll(canvas) {
    var tails = canvas.querySelectorAll(".tail[data-key]");
    for (var i = 0; i < tails.length; i++) {
      var el = tails[i];
      var st = S.tailScroll[el.getAttribute("data-key")];
      el.scrollTop = st && !st.follow ? st.top : el.scrollHeight;
    }
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
        render();
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
    var effortField = h("div", { class: "field" });
    var modelRow = null;
    if (agentBacked && !isCmd) {
      var agent = specStep.agent;
      var curModel = edits.model != null ? edits.model : specStep.model;
      var curEffort = edits.effort != null ? edits.effort : (specStep.effort || "");
      modelSel = selectEl(modelOptionsWith(agent, curModel), curModel);
      function renderMidEffort() {
        clear(effortField);
        var opts = effortOptions(agent, modelSel.value, curEffort);
        if (opts.length <= 1) { effortField._sel = null; return; }
        effortField.appendChild(h("label", { text: "Effort" }));
        var es = selectEl(opts, curEffort || "");
        effortField.appendChild(es);
        effortField._sel = es;
      }
      modelSel.addEventListener("change", renderMidEffort);
      renderMidEffort();
      modelRow = h("div", { class: "row2" },
        field("Model", modelSel, "Applies when this step runs (agent stays " + agent + ")."),
        effortField
      );
    }

    var body = h("div", null,
      h("div", { class: "hint", text: isCmd
        ? "Shell command the step will run when the workflow resumes."
        : "Prompt the step will run with when the workflow resumes ({{...}} templates still apply)." }),
      ta,
      modelRow
    );
    var applyBtn = h("button", { class: "btn primary", text: "Apply edit" });
    var foot = h("div", { class: "mfoot" },
      h("button", { class: "btn", text: "Cancel", onClick: closeModal }),
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
      applyBtn.disabled = true;
      apiAuth("POST", "/api/runs/" + S.runId + "/edit-step", payload).then(function (r) {
        if (r.status === 200) {
          closeModal();
          setBanner("Step '" + s.stepId + "' edited — it runs with the new values after you resume.", "ok");
        } else if (r.status === 202) {
          closeModal();
          setBanner("Edit requested for '" + s.stepId + "' — awaiting the owning process; watch the run to confirm.", "info");
        } else {
          applyBtn.disabled = false;
          setBanner((r.body && r.body.error) || "Edit rejected.", "err");
        }
      }).catch(function () { applyBtn.disabled = false; });
    });
    openModal(modalShell("Edit step · " + s.stepId, (KIND_LABEL[s.blockKind] || s.blockKind) + " — applies when the step runs", body, foot, true));
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
    // Validate param fields before submission
    var container = document.getElementById("paramsForm");
    if (container.style.display !== "none") {
      var invalidFields = container.querySelectorAll(".invalid");
      if (invalidFields.length > 0) {
        setBanner("fix parameter errors before running", "err");
        invalidFields[0].focus();
        return;
      }
    }
    // A pending history-enriched plan must never replace the live run canvas.
    S.planRequest += 1;
    S.runState = SteamtrainReducer.workflowStateFromSpec(effectiveSpec() || S.spec);
    S.tailScroll = {}; S.drawerScroll = { follow: true, top: 0 };
    S.narration = []; S.arrivalInspect = false; S.arrivalEnter = false;
    S.narrationFreshPlayed = null;
    S.conductorLinePlayed = null;
    S.arrivalCtaFocused = false;
    // Leave full-bleed Station for ride mode: thin chrome stays so banners and
    // cancel remain reachable while the POST is in flight / if it fails.
    if (S.selected === TOUR_NAME) {
      beginTourDeparture();
    }
    S.endedAt = 0;
    setBanner("", "");
    document.getElementById("statusLine").style.display = "flex";
    syncBodyMode();
    render();
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
          endTourDeparture();
          syncBodyMode();
          render();
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
        render();
      })
      .catch(function () {
        setBanner("could not start run: network error", "err");
        setRunning(false);
        S.tourRiding = false;
        endTourDeparture();
        syncBodyMode();
        render();
      });
  }

  function openStream(runId) {
    if (S.es) S.es.close();
    // Pre-flight auth check: EventSource can't handle 401 (it silently retries).
    api("GET", "/api/workflows").then(function (r) {
      if (r.status === 401) { showLoginForm(); return; }
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
            revealArrivalWhenReady();
          }           else {
            S.arrivalEnter = true;
            if (frame.status === "canceled" || frame.status === "error" || frame.ok === false) {
              S.tourRiding = false;
              endTourDeparture();
            }
            render();
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
    document.getElementById("cancelBtn").style.display = (running && !ro) ? "block" : "none";
    // Plan is a pre-launch dry-run; only hide it for read-only sessions (do not
    // couple it to running — that was not the pre-existing behavior).
    document.getElementById("planBtn").style.display = ro ? "none" : "block";
    document.getElementById("input").disabled = running || ro;
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
    if (isReadOnly()) { setBanner("This session is read-only — viewing only.", "info"); return; }
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
      if (res.status === 401) { showLoginForm(); return; }
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
      (p.steps || []).forEach(function (st) { if (isAgentStep(st)) n++; });
    });
    return n;
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

    var phasesWrap = h("div", { class: "ephases" });
    spec.phases.forEach(function (p) {
      var pe = h("div", { class: "ephase" }, h("div", { class: "et", text: (p.title || p.id) }));
      p.steps.forEach(function (st) {
        pe.appendChild(stepEditor(st, refs, {
          onUseForAll: function (agent, model, effort) {
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
        }));
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
          if (r.stepTimeoutInput && r.stepTimeoutInput.value.trim()) {
            var stepSec = Number(r.stepTimeoutInput.value) * 60;
            if (stepSec > 0) st.stepTimeoutSec = stepSec; else delete st.stepTimeoutSec;
          } else if (r.stepTimeoutInput) delete st.stepTimeoutSec;
        });
      });
      saveBtn.disabled = true; saveBtn.textContent = "Saving…";
      var payload = { spec: spec, scope: creating ? scopeSel.value : (S.source === "project" ? "project" : "user") };
      if (!creating && isWritable) payload.previousName = S.selected;
      apiAuth("PUT", "/api/workflows/" + encodeURIComponent(targetName), payload).then(function (r) {
        saveBtn.disabled = false; saveBtn.textContent = creating ? "Save copy" : "Save";
        if (r.status === 200 && r.body.ok) {
          closeModal();
          var savedName = r.body.name || targetName;
          delete S.stagedOverrides[S.selected || savedName];
          if (savedName !== S.selected) delete S.stagedOverrides[savedName];
          var warns = r.body.warnings;
          refreshAfterWrite(savedName, "saved");
          if (warns && warns.length) {
            var suffix = warns.length > 1 ? " (and " + (warns.length - 1) + " more)" : "";
            setBanner("⚠ " + warns.length + " template warning" + (warns.length > 1 ? "s" : "") + ": " + warns[0] + suffix, "info");
          }
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
            if (r.agentSel) {
              patch.agent = r.agentSel.value || null;
              patch.model = (r.modelSel && r.modelSel.value) || null;
              patch.modelClass = (r.classSel && r.classSel.value) || null;
              var ef = r.effortSel ? r.effortSel.value : "";
              patch.effort = ef || null;
            }
            if (r.promptTa) patch.prompt = r.promptTa.value;
            if (r.stepTimeoutInput && r.stepTimeoutInput.value.trim()) {
              var stepSec = Number(r.stepTimeoutInput.value) * 60;
              patch.stepTimeoutSec = stepSec > 0 ? stepSec : null;
            } else if (r.stepTimeoutInput) patch.stepTimeoutSec = null;
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
      renderEffort: renderEffort,
      card: card
    };
    card.appendChild(h("div", { class: "row2" },
      field("Agent", agentSel), field("Model", modelSel), effortField));
    card.appendChild(field("Model class", classSel, "Optional role class (thinker / ultrathinker / implementer / reviewer / deep-reviewer / simple / balanced). Leave empty to pin a concrete model."));
    card.appendChild(bindHint);
    card.appendChild(field("Step timeout (min)", stepTimeoutInput, "Per-agent subprocess limit for this step."));
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
        clear(document.getElementById("canvas"));
        document.getElementById("canvas").appendChild(h("div", { class: "empty", text: "Deleted " + name + "." }));
        reloadCatalog();
      } else {
        setBanner((r.body && r.body.error) || "delete failed", "err");
      }
    });
  }

  function reloadCatalog() {
    return apiAuth("GET", "/api/workflows").then(function (r) {
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
      if (histRes.status === 401) { showLoginForm(); return; }
      var nextRuns = (histRes.body && histRes.body.runs) || [];
      var nextLive = [];
      if (liveRes && liveRes.status === 200) {
        nextLive = (liveRes.body.runs || []).filter(function (run) {
          return run.status === "running" || run.status === "queued";
        });
        S.liveRuns = nextLive.slice();
        renderLiveRuns();
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
                setBanner("Copied run id " + text.slice(0, 8) + "\u2026", "ok");
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

    var canRetry = record.totals && record.totals.failed > 0;
    var actions = h("div", { class: "run-actions hist-actions" });
    if (!isReadOnly()) {
      actions.appendChild(h("button", { class: "btn primary", text: "Re-run",
        onClick: function () { stopHistoryPoll(); rerunHistory(record.id, record.workflow, "rerun"); } }));
      if (canRetry) {
        actions.appendChild(h("button", { class: "btn", text: "Retry failed",
          onClick: function () { stopHistoryPoll(); rerunHistory(record.id, record.workflow, "retry"); } }));
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
      (p.steps || []).forEach(function (st) { cards.appendChild(renderCard(historyStepView(st))); });
      phaseEl.appendChild(cards);
      holder.appendChild(phaseEl);
    });
  }

  function deleteHistoryRun(holder, record) {
    if (!window.confirm("Delete recorded run " + record.id.slice(0, 8) + "\u2026 of \u201c" + record.workflow + "\u201d? This cannot be undone.")) return;
    apiAuth("DELETE", "/api/history/" + encodeURIComponent(record.id)).then(function (r) {
      if (r.status === 200 || r.status === 204) {
        setBanner("Deleted run " + record.id.slice(0, 8) + "\u2026", "ok");
        reopenHistoryList(holder);
      } else {
        setBanner((r.body && r.body.error) || "delete failed", "err");
      }
    });
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
        var line;
        if (!s.exists) {
          line = "⎇ " + s.stepId + " — worktree gone (pruned or cleaned up)";
        } else if (!s.files.length) {
          line = "⎇ " + s.stepId + " — no changes";
          anyExists = true;
        } else {
          line = "⎇ " + s.stepId + " — " + s.files.length + " file(s) +" + s.additions + " -" + s.deletions;
          anyExists = true; anyChanges = true;
        }
        var row = h("div", { class: "hist-wt-line", text: line, title: s.branch });
        holder.appendChild(row);
        if (s.exists && s.files.length) {
          var fileList = s.files.slice(0, 8).map(function (f) { return f.status + " " + f.path; }).join(" · ");
          if (s.files.length > 8) fileList += " …";
          holder.appendChild(h("div", { class: "hist-wt-files", text: fileList }));
        }
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
      setBanner("Cleared run history.", "ok");
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
      var key = s.model && s.agent ? s.agent + "/" + s.model : (s.model || s.agent || "(agentless)");
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
      reloadCatalog().then(function () {
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

  document.getElementById("planBtn").addEventListener("click", startPlan);
  document.getElementById("runBtn").addEventListener("click", startRun);
  document.getElementById("pauseBtn").addEventListener("click", togglePauseRun);
  document.getElementById("cancelBtn").addEventListener("click", cancelRun);
  document.getElementById("flushBtn").addEventListener("click", flushStaged);
  document.getElementById("input").addEventListener("keydown", function (e) {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { startRun(); return; }
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      if (handlePromptHistoryKey(e.target, e.key === "ArrowUp")) e.preventDefault();
    }
  });
  // Typing while browsing history turns the recalled entry into the new draft.
  document.getElementById("input").addEventListener("input", function () { promptBrowse = null; });
  document.getElementById("newWfBtn").addEventListener("click", openCreate);
  document.getElementById("historyBtn").addEventListener("click", function () { openHistory(); });
  document.getElementById("configBtn").addEventListener("click", openConfigModal);
  document.getElementById("editBtn").addEventListener("click", function () { openEditor(false); });
  document.getElementById("cloneBtn").addEventListener("click", function () { openEditor(true); });
  document.getElementById("deleteBtn").addEventListener("click", doDelete);
  document.getElementById("overlay").addEventListener("click", function (e) {
    if (e.target === document.getElementById("overlay")) closeModal();
  });
  document.addEventListener("keydown", function (e) {
    var overlayOpen = document.getElementById("overlay").classList.contains("show");
    if (overlayOpen) {
      if (e.key === "Escape") {
        e.preventDefault();
        stopHistoryPoll();
        closeModal();
      } else if (handleHistoryListKey(e)) {
        return;
      } else if (e.key === "Tab") {
        trapModalFocus(e);
      }
      return;
    }
    if (e.key === "Escape" && S.detail) {
      e.preventDefault();
      closeDetail();
    }
  });

  window.addEventListener("hashchange", function () {
    var runId = currentRunDeepLink();
    if (runId) openRunDeepLink(runId);
  });

  loadSessionThenCatalog();
})();
