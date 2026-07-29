/**
 * Shared state, DOM helpers, API access, and the event stream.
 *
 * Every st-*.js file attaches to the `window.Steamtrain` namespace this file
 * creates. Load order is guaranteed by `<script defer>` in WEB_ASSETS order
 * (src/web/html.ts) - this file must stay first among the st-* scripts.
 */
window.Steamtrain = (function () {
  "use strict";

  // The namespace object. Modules loaded after this file attach to it; the
  // functions below close over it, so those late attachments are visible.
  var ST = {};

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
    childSpecs: {},
    projectConfig: null,
    // Settings-page routing: whether #center is currently showing the settings
    // page, and the hash to return to when its Close button is clicked.
    inSettings: false,
    preSettingsHash: "#",
    project: null,
    configLabel: null,
    liveRuns: [], liveRunsTimer: null, queuedBanner: false,
    deepLinkRequest: 0,
    pendingStepDeepLink: null,
    // Step drill-in drawer: which step it shows ({phaseId, iteration, stepId}).
    detail: null,
    // Run pane: the step the reader picked. Its phase band is the expanded one
    // and its output fills that band's live output pane. null -> the running
    // phase expands instead.
    selectedStepId: null,
    // Live output pane: false wraps long lines, true scrolls horizontally.
    outputNoWrap: false,
    // Per-card tail scroll state keyed by stepKey(): { follow: bool, top: px }.
    // "follow" sticks the pane to the newest output as it streams; scrolling up
    // pauses it, scrolling back to the bottom re-engages it.
    tailScroll: {},
    // Same follow/position model for the drawer's full-output pane.
    drawerScroll: { follow: true, top: 0 },
    // Session capability from GET /api/session (or login). "read" hides every
    // mutate control; the server also 403s those routes as a hard backstop.
    capability: "full",
    // Live narration (UI-only projection of WorkflowEvents).
    narration: [],
    narrationOn: localStorage.getItem("steamtrain.narration") !== "off",
    // Focus the Arrival primary CTA once per completed run.
    arrivalCtaFocused: false,
    // Narration line id that already played the one-shot "fresh" entrance.
    narrationFreshPlayed: null,
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
    planRequest: 0,
    reauthVisible: false,
    sessionHeartbeatTimer: null,
    sessionTtlMs: null,
    // Instrument rail (Task 7): the live throughput meter for the current run
    // (null until the first workflow_start) and the capped, newest-first
    // event log it renders alongside Spend/Runners/Worktrees.
    throughput: null,
    eventLog: []
  };

  var SELECTION_KEY = "steamtrain.lastWorkflow";
  var FOLDER_COLLAPSE_KEY = "steamtrain.workflowFolders";
  var WORKFLOW_FOLDER_ORDER = ["project", "user", "bundled"];
  var TOUR_NAME = (SteamtrainReducer.TOUR_WORKFLOW_NAME) || "tour";

  function loadFolderCollapse() {
    try {
      var raw = JSON.parse(localStorage.getItem(FOLDER_COLLAPSE_KEY) || "{}");
      return {
        project: !!raw.project,
        user: !!raw.user,
        bundled: !!raw.bundled
      };
    } catch (e) {
      return { project: false, user: false, bundled: false };
    }
  }

  function saveFolderCollapse(state) {
    try { localStorage.setItem(FOLDER_COLLAPSE_KEY, JSON.stringify(state)); } catch (e) {}
  }

  S.folderCollapse = loadFolderCollapse();

  function groupWorkflowsBySource(list) {
    var buckets = { project: [], user: [], bundled: [] };
    list.forEach(function (w) {
      var key = buckets[w.source] ? w.source : "bundled";
      buckets[key].push(w);
    });
    return WORKFLOW_FOLDER_ORDER.filter(function (source) {
      return buckets[source].length > 0;
    }).map(function (source) {
      return { source: source, entries: buckets[source] };
    });
  }

  function toggleWorkflowFolder(source) {
    S.folderCollapse[source] = !S.folderCollapse[source];
    saveFolderCollapse(S.folderCollapse);
    ST.shell.renderSidebar();
    // Keep the selected card on-screen after a fold/unfold.
    if (S.selected) {
      var sel = document.querySelector('#wflist .wf-row.selected');
      if (sel && typeof sel.scrollIntoView === "function") {
        sel.scrollIntoView({ block: "nearest" });
      }
    }
  }

  function isReadOnly() { return S.capability === "read"; }

  /** Hide authoring / run-control chrome when the session is read-only. */
  function applyCapabilityChrome() {
    var ro = isReadOnly();
    var badge = document.getElementById("modeBadge");
    // "none", not "" — clearing the inline style would reveal the badge (its
    // markup default is display:none) and label every full session read-only.
    if (badge) badge.style.display = ro ? "inline-flex" : "none";
    var hideIds = ["settingsBtn", "newWfBtn", "editBtn", "cloneBtn", "flushBtn", "deleteBtn", "planBtn", "runBtn"];
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
    var bands = document.getElementById("bands");
    if (!bands) return false;
    bands.focus();
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
      if (r.status === 401) {
        if (S.runId || S.selected) { showReauthOverlay(); }
        else { showLoginForm(); }
        throw new Error("auth required");
      }
      if (r.status === 403 && r.body && r.body.error === "read-only session") {
        S.capability = "read";
        applyCapabilityChrome();
        ST.run.setBanner("This session is read-only — viewing only.", "info");
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
        if (r.body.project) applyProjectChrome(r.body.project);
        applyCapabilityChrome();
        if (r.body.authRequired) startSessionHeartbeat();
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

  function applyProjectChrome(project) {
    if (!project || !project.name) return;
    S.project = project;
    try {
      document.title = "steamtrain · " + project.name;
    } catch (e) {}
    ST.shell.renderCrumbs();
  }

  function loadWorkflows() {
    api("GET", "/api/workflows").then(function (r) {
      // Match apiAuth(): keep page state behind the reauth overlay when a run
      // or workflow is already open; otherwise fall back to the full login form.
      if (r.status === 401) {
        if (S.runId || S.selected) showReauthOverlay();
        else showLoginForm();
        return;
      }
      S.workflows = r.body.workflows || [];
      if (r.body.configLabel) {
        S.configLabel = r.body.configLabel;
        ST.shell.renderCrumbs();
      }
      if (r.body.project) applyProjectChrome(r.body.project);
      ST.shell.renderSidebar();
      var deepLinkId = SteamtrainReducer.parseDeepLink
        ? SteamtrainReducer.parseDeepLink(window.location.hash)
        : SteamtrainReducer.parseRunDeepLink
          ? { runId: SteamtrainReducer.parseRunDeepLink(window.location.hash), stepId: undefined }
          : null;
      if (deepLinkId && deepLinkId.runId) openRunDeepLink(deepLinkId.runId, deepLinkId.stepId);
      else bootstrapDefaultWorkflow();
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
      ST.shell.renderSidebar();
      ST.shell.renderBlockedRow();
    }).catch(function () {});
  }

  /** First impression: auto-select a workflow when nothing is selected yet —
   *  the remembered previous selection if one exists, else the tour. */
  function bootstrapDefaultWorkflow() {
    if (S.selected) return;
    var remembered = null;
    try { remembered = localStorage.getItem(SELECTION_KEY); } catch (e) {}
    if (remembered && S.workflows.some(function (w) { return w.name === remembered; })) {
      selectWorkflow(remembered);
      return;
    }
    // Soft default: still open the tour when present so the empty state dies.
    if (S.workflows.some(function (w) { return w.name === TOUR_NAME; })) {
      selectWorkflow(TOUR_NAME, function () {
        var input = document.getElementById("input");
        if (input && !input.value) input.value = "all aboard";
      });
    }
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
  /** True when the current view is an Active runs attachment (owns `.sel`). */
  function isLiveAttached() {
    return Boolean(S.runId && S.liveRuns.some(function (r) { return r.id === S.runId; }));
  }

  function pollLiveRuns() {
    api("GET", "/api/runs").then(function (r) {
      if (r.status === 401) {
        // Session expired: stop polling. A successful reauth (doReauth) restarts
        // the timer; a full login form reload also brings it back via loadWorkflows.
        if (S.liveRunsTimer) { clearInterval(S.liveRunsTimer); S.liveRunsTimer = null; }
        if (S.sessionHeartbeatTimer) { clearInterval(S.sessionHeartbeatTimer); S.sessionHeartbeatTimer = null; }
        return;
      }
      if (r.status !== 200) return; // transient; the next poll retries
      var wasAttached = isLiveAttached();
      S.liveRuns = (r.body.runs || []).filter(function (run) {
        return run.status === "running" || run.status === "queued";
      });
      ST.shell.renderLiveRuns();
      // When the attached run leaves (or re-enters) the Active runs list, the
      // workflow catalog's selection highlight must flip with it.
      if (wasAttached !== isLiveAttached()) ST.shell.renderSidebar();
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
    if (SteamtrainReducer.parseDeepLink) {
      var parsed = SteamtrainReducer.parseDeepLink(window.location.hash);
      return parsed ? parsed.runId : null;
    }
    return SteamtrainReducer.parseRunDeepLink
      ? SteamtrainReducer.parseRunDeepLink(window.location.hash)
      : null;
  }

  function openRunDeepLink(runId, stepId) {
    var request = ++S.deepLinkRequest;
    api("GET", "/api/runs").then(function (r) {
      if (request !== S.deepLinkRequest || currentRunDeepLink() !== runId) return;
      if (r.status === 401) { showReauthOverlay(); return; }
      if (r.status !== 200) {
        ST.run.setBanner("Could not open run " + runId.slice(0, 8) + "… — try refreshing.", "err");
        return;
      }
      var run = (r.body.runs || []).find(function (candidate) { return candidate.id === runId; });
      if (run && (run.status === "running" || run.status === "queued")) {
        attachRun(run);
        if (stepId) S.pendingStepDeepLink = stepId;
        return;
      }
      ST.modals.openHistory(runId);
    }).catch(function () {
      if (request === S.deepLinkRequest && currentRunDeepLink() === runId) {
        ST.run.setBanner("Could not open run " + runId.slice(0, 8) + "… — network error.", "err");
      }
    });
  }

  // ---- routing (cockpit vs. settings page) ----------------------------------
  /**
   * Hide the cockpit (`.work` inside #center) and both rails, show the
   * settings page in their place. Toggled with `display`, never detached —
   * background pollers (live runs, doctor) keep calling render()/renderSidebar()
   * against #bands etc. while settings is open, and those must stay real,
   * attached nodes or a stray getElementById would come back null.
   */
  function showSettingsRoute(section) {
    var center = document.getElementById("center");
    if (!center) return;
    var work = center.querySelector("section.work");
    if (work) work.style.display = "none";
    var railLeft = document.getElementById("rail-left");
    var railRight = document.getElementById("rail-right");
    if (railLeft) railLeft.style.display = "none";
    if (railRight) railRight.style.display = "none";
    var pane = document.getElementById("settingsRoot");
    if (!pane) {
      pane = document.createElement("div");
      pane.id = "settingsRoot";
      center.appendChild(pane);
    }
    // Undo the `display: none` a previous showCockpitRoute() left behind —
    // the .settings class supplies `display: flex` (set by settings.render()),
    // but an inline style always wins over it.
    pane.style.display = "";
    ST.settings.render(pane, section);
  }

  /** Restore the cockpit: reveal `.work` + both rails, hide the settings pane. */
  function showCockpitRoute() {
    var center = document.getElementById("center");
    if (!center) return;
    var pane = document.getElementById("settingsRoot");
    if (pane) pane.style.display = "none";
    var work = center.querySelector("section.work");
    if (work) work.style.display = "";
    var railLeft = document.getElementById("rail-left");
    var railRight = document.getElementById("rail-right");
    if (railLeft) railLeft.style.display = "";
    if (railRight) railRight.style.display = "";
  }

  /**
   * Dispatch on the current hash via SteamtrainReducer.parseRoute: a `settings`
   * route shows the settings page (section-only changes just re-render it), a
   * `run` route restores the cockpit and resolves the run/step deep link, and
   * `null` leaves the current view alone — except when we were showing settings,
   * where there is nothing sensible left to show but the cockpit (this covers
   * the Close button's own hash update, the browser back button, and a manual
   * hash edit). `oldHash` — the hash before this change — comes from the
   * hashchange event's `oldURL`, or is `null` for the one-time boot call.
   */
  function handleRoute(oldHash) {
    var route = SteamtrainReducer.parseRoute ? SteamtrainReducer.parseRoute(window.location.hash) : null;
    if (route && route.kind === "settings") {
      if (!S.inSettings) {
        S.preSettingsHash = (typeof oldHash === "string" && oldHash) ? oldHash : "#";
        S.inSettings = true;
      }
      showSettingsRoute(route.section);
      return;
    }
    if (route && route.kind === "run") {
      if (S.inSettings) { S.inSettings = false; showCockpitRoute(); }
      openRunDeepLink(route.runId, route.stepId);
      return;
    }
    if (S.inSettings) { S.inSettings = false; showCockpitRoute(); }
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
      // Only a web-owned, in-process run can be handed off from here; a run
      // owned by another process (CLI/TUI, or already detached) is independent.
      S.runExternal = Boolean(run.external);
      S.runDetached = Boolean(run.detached);
      setRunDeepLink(run.id);
      ST.run.setRunning(true);
      S.startedAt = run.startedAt || Date.now();
      ST.run.startTimer();
      // setRunning(true) above already revealed the run header's metrics strip.
      // Replay rebuilds the tree from the event stream (workflow_start keeps
      // seeded phases). Seeding from the catalog spec (when known) makes
      // not-yet-started steps visible — and editable while the run is paused.
      S.runState = known && S.spec
        ? SteamtrainReducer.workflowStateFromSpec(ST.run.effectiveSpec() || S.spec)
        : SteamtrainReducer.initialWorkflowState;
      S.detail = null; S.selectedStepId = null;
      S.tailScroll = {}; S.drawerScroll = { follow: true, top: 0 };
      ST.run.setBanner(
        "Attached to " + (run.detached ? "detached " : "") + "run " + run.id.slice(0, 8) + "…" +
          (isReadOnly() ? " (read-only view)." : " — cancel stops the run itself."),
        "info"
      );
      ST.run.openStream(run.id);
      ST.render();
      // Re-render after S.runId is set so the workflow catalog does not keep
      // the shared `.sel` highlight that belongs to the Active runs row.
      ST.shell.renderSidebar();
      ST.shell.renderLiveRuns();
    };
    if (known) {
      selectWorkflow(run.workflow, begin, { preserveRunDeepLink: true });
    } else {
      // Run of a workflow that is no longer in the catalog: attach with the
      // event stream alone (the reducer rebuilds phases from events).
      if (S.es) { S.es.close(); S.es = null; }
      ST.run.stopTimer();
      S.selected = null; S.source = null;
      S.spec = { name: run.workflow, phases: [] };
      document.getElementById("wfTitle").textContent = run.workflow;
      document.getElementById("wfSub").textContent = "attached run (workflow not in catalog)";
      document.getElementById("runRow").style.display = "none";
      ST.shell.renderSidebar();
      begin();
    }
  }

  function showLoginForm() {
    if (S.sessionHeartbeatTimer) clearInterval(S.sessionHeartbeatTimer);
    // #cols is the row below #topbar (rail-left/center/rail-right) — the
    // Console-layout equivalent of the old <main>, which this used to clear.
    var main = document.getElementById("cols");
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
        if (r.body.sessionTtlMs) S.sessionTtlMs = r.body.sessionTtlMs;
        window.location.reload();
      } else {
        if (errEl) errEl.textContent = (r.body && r.body.error) || "Login failed.";
      }
    }).catch(function () {
      if (errEl) errEl.textContent = "Network error.";
    });
  }

  function showReauthOverlay() {
    if (S.reauthVisible) return;
    S.reauthVisible = true;
    // Session is expired: stop heartbeat pings until a successful reauth.
    if (S.sessionHeartbeatTimer) {
      clearInterval(S.sessionHeartbeatTimer);
      S.sessionHeartbeatTimer = null;
    }
    var backdrop = h("div", { class: "reauth-backdrop", id: "reauthOverlay" },
      h("div", { class: "reauth-card", role: "dialog", "aria-modal": "true", "aria-labelledby": "reauthTitle" },
        h("div", { class: "reauth-icon", "aria-hidden": "true", text: "\uD83D\uDD12" }),
        h("h2", { class: "reauth-title", id: "reauthTitle", text: "Session expired" }),
        h("p", { class: "reauth-desc", text: "Your session has timed out. Enter your token to continue where you left off." }),
        h("div", { class: "reauth-form" },
          h("input", { type: "password", id: "reauthToken", class: "txt", placeholder: "Enter auth or read token", autocomplete: "off" }),
          h("button", { class: "btn primary", id: "reauthBtn", text: "Re-authenticate" })
        ),
        h("p", { class: "reauth-error", id: "reauthError" })
      )
    );
    document.body.appendChild(backdrop);
    var tokenInput = document.getElementById("reauthToken");
    var submitBtn = document.getElementById("reauthBtn");
    function doReauth() {
      var errEl = document.getElementById("reauthError");
      if (errEl) errEl.textContent = "";
      var token = tokenInput ? tokenInput.value : "";
      if (!token) { if (errEl) errEl.textContent = "Token is required."; return; }
      submitBtn.disabled = true;
      api("POST", "/api/auth", { token: token }).then(function (r) {
        if (r.status === 200 && r.body.ok) {
          try {
            dismissReauthOverlay();
            if (r.body.capability) S.capability = r.body.capability;
            if (r.body.sessionTtlMs) S.sessionTtlMs = r.body.sessionTtlMs;
            applyCapabilityChrome();
            startSessionHeartbeat();
            // pollLiveRuns clears its timer on 401; resume Active runs updates.
            if (!S.liveRunsTimer) S.liveRunsTimer = setInterval(pollLiveRuns, 5000);
            pollLiveRuns();
            if (S.runId && !S.es) ST.run.openStream(S.runId);
          } catch (ex) {
            console.error("doReauth success-path error:", ex);
            submitBtn.disabled = false;
          }
        } else {
          submitBtn.disabled = false;
          if (errEl) errEl.textContent = (r.body && r.body.error) || "Login failed.";
        }
      }).catch(function () {
        submitBtn.disabled = false;
        var errEl = document.getElementById("reauthError");
        if (errEl) errEl.textContent = "Network error.";
      });
    }
    submitBtn.addEventListener("click", doReauth);
    tokenInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter") doReauth();
    });
    backdrop.addEventListener("keydown", function (e) {
      // Intentionally non-dismissive: Escape refocuses the token input instead of
      // closing the overlay. The reauth overlay must not be dismissed without a
      // successful authentication, because the session is expired and any action
      // would fail with 401. Do not add dismissReauthOverlay() here.
      if (e.key === "Escape") { e.preventDefault(); tokenInput.focus(); return; }
      if (e.key === "Tab") {
        var focusable = backdrop.querySelectorAll("input, button");
        var first = focusable[0];
        var last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault(); last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault(); first.focus();
        }
      }
    });
    backdrop.addEventListener("click", function (e) {
      if (e.target === backdrop) tokenInput.focus();
    });
    tokenInput.focus();
  }

  function dismissReauthOverlay() {
    S.reauthVisible = false;
    var el = document.getElementById("reauthOverlay");
    if (el) el.remove();
  }

  function startSessionHeartbeat() {
    if (S.sessionHeartbeatTimer) clearInterval(S.sessionHeartbeatTimer);
    // Adaptive interval: for the default 7-day TTL (604800000ms) this evaluates to
    // 60000ms (the cap). For shorter custom TTLs (e.g. 2-hour session = 7200000ms),
    // the formula yields 60000ms still capped. Below ~2 hours (e.g. 10-minute TTL =
    // 600000ms) it produces 5000ms, ensuring we detect expiry well before it hits.
    // The divisor of 120 means we check ~60 times per TTL window.
    var interval = S.sessionTtlMs ? Math.min(60000, Math.floor(S.sessionTtlMs / 120)) : 60000;
    S.sessionHeartbeatTimer = setInterval(function () {
      api("GET", "/api/session").then(function (r) {
        if (r.status === 401) showReauthOverlay();
      }).catch(function () {});
    }, interval);
  }

  function loadProjectConfig() {
    apiAuth("GET", "/api/config").then(function (r) {
      if (r.status === 200) S.projectConfig = r.body;
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
      ST.shell.renderHealth(list, apis, err);
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

  /** A health chip that opens the Runners settings page. */
  function healthChip(cls, label, title) {
    return h("button", {
      class: "chip chip-btn " + cls,
      type: "button",
      title: title + " · click for setup",
      onClick: function () { ST.settings.open("runners"); }
    }, h("span", { class: "dot" }), label);
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

  /** Minimal CSS.escape shim for our ids (ascii ids: agent names, "api:<id>"). */
  function cssEscape(value) {
    if (window.CSS && window.CSS.escape) return window.CSS.escape(value);
    return String(value).replace(/[^a-zA-Z0-9_-]/g, function (c) { return "\\" + c; });
  }

  /**
   * Catalog badge for a workflow's sandbox posture. Only shown when it says
   * something: every agent step sandboxed (the reassuring case), or at least one
   * step whose declared restriction cannot be enforced (the case a user must see
   * BEFORE launching, not after).
   */
  /** Closed lock only when something is actually sandboxed (mirrors the CLI/TUI). */
  function sandboxGlyph(p) {
    if (!p || p.blocking > 0 || p.unenforced > 0) return "\uD83D\uDD13";
    var declared = p.counts && (p.counts["read-only"] || p.counts.edit || p.counts.full);
    return declared ? "\uD83D\uDD12" : "\uD83D\uDD13";
  }

  function workflowSandboxBadge(w) {
    var p = w.permissions;
    if (!p || !p.agentSteps) return null;
    if (p.blocking > 0 || p.unenforced > 0) {
      return h("span", {
        class: "badge perms violated",
        text: "\uD83D\uDD13 " + (p.blocking > 0 ? "unenforceable" : "unenforced"),
        title: (w.permissionWarnings || []).join("\n") || "a declared profile is not enforced by its agent"
      });
    }
    if (p.unrestricted === 0 && p.counts && p.counts["read-only"] === p.agentSteps) {
      return h("span", {
        class: "badge perms locked",
        text: "\uD83D\uDD12 read-only",
        title: "every agent step in this workflow runs read-only: no writes, no shell, no network"
      });
    }
    return null;
  }

  function selectWorkflow(name, after, options) {
    if (!(options && options.preserveRunDeepLink) && currentRunDeepLink()) clearRunDeepLink();
    // Ignore any plan response that was initiated for the previously selected
    // workflow while its asynchronous history lookup was still running.
    S.planRequest += 1;
    if (S.es) { S.es.close(); S.es = null; }
    ST.run.stopTimer();
    if (ST.instruments) ST.instruments.reset();
    S.selected = name; S.runId = null; S.runState = null;
    S.detail = null; S.detailInvoker = null; S.detailFallback = null; S.detailFocusPending = false; S.detailFocusGeneration += 1;
    S.selectedStepId = null;
    S.tailScroll = {}; S.drawerScroll = { follow: true, top: 0 };
    S.narration = []; S.arrivalInspect = false; S.arrivalEnter = false; S.endedAt = 0;
    S.narrationFreshPlayed = null;
    S.arrivalCtaFocused = false;
    // Leaving an attached run restores Plan / Describe and clears compact chrome.
    ST.run.setRunning(false);
    try { localStorage.setItem(SELECTION_KEY, name); } catch (e) {}
    // Reveal the selected workflow if its folder was folded shut.
    var entry = S.workflows.find(function (w) { return w.name === name; });
    if (entry && entry.source && S.folderCollapse[entry.source]) {
      S.folderCollapse[entry.source] = false;
      saveFolderCollapse(S.folderCollapse);
    }
    ST.shell.renderSidebar();
    // setRunning(false) above already hid the run header's metrics strip.
    ST.run.setBanner("", "");
    apiAuth("GET", "/api/workflows/" + encodeURIComponent(name)).then(function (r) {
      if (r.status !== 200) { ST.run.setBanner(r.body.error || "failed to load", "err"); return; }
      S.spec = r.body.spec;
      S.source = r.body.source;
      S.childSpecs = r.body.children || {};
      document.getElementById("wfTitle").textContent = r.body.spec.name;
      document.getElementById("wfSub").textContent = r.body.spec.description || "";
      document.getElementById("runRow").style.display = isReadOnly() ? "none" : "grid";
      ST.shell.renderSourceLine();
      ST.shell.renderBlockedRow();
      ST.run.renderParamsForm(r.body.spec);
      S.runState = SteamtrainReducer.workflowStateFromSpec(ST.run.effectiveSpec() || r.body.spec);
      ST.shell.renderHealth(S.doctor || [], S.apiDoctor || [], null);
      ST.render();
      ST.run.renderStagedIndicator();
      if (after) after();
    });
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
    resolvePendingStepDeepLink();
  }

  function resolvePendingStepDeepLink() {
    if (!S.pendingStepDeepLink || !S.runState) return;
    var stepId = S.pendingStepDeepLink;
    var phases = S.runState.phases || [];
    for (var i = 0; i < phases.length; i++) {
      var p = phases[i];
      for (var j = 0; j < (p.steps || []).length; j++) {
        if (p.steps[j].stepId === stepId) {
          S.pendingStepDeepLink = null;
          ST.run.openDetail(p, p.steps[j], null);
          return;
        }
      }
    }
  }

  // ---- rendering -----------------------------------------------------------
  function scheduleRender() {
    if (S.rafQueued) return;
    S.rafQueued = true;
    requestAnimationFrame(function () { S.rafQueued = false; ST.render(); });
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
  // --- Tool permissions (sandbox profiles) --------------------------------
  // Mirrors src/agents/permissions.ts: the profile a step runs under, and the
  // verification outcome once it has finished.
  var PERMISSION_GLYPH = { "read-only": "🔒", edit: "✎", full: "⚡" };

  /** The profile info to show for a step: the recorded one wins over the declared one. */
  function stepPermissions(s) {
    if (s.result && s.result.permissions) {
      return {
        profile: s.result.permissions.profile,
        enforcement: s.result.permissions.enforcement,
        gaps: s.result.permissions.gaps,
        violations: s.result.permissions.violations,
        verified: s.result.permissions.verified
      };
    }
    if (s.permissions) return { profile: s.permissions.profile, verify: s.permissions.verify };
    return null;
  }

  function permissionLabel(perms) {
    return (PERMISSION_GLYPH[perms.profile] || "") + " " + perms.profile;
  }

  /** Header badge; red when a read-only step actually changed its workspace. */
  function permissionBadge(perms) {
    var violated = perms.violations && perms.violations.length > 0;
    var variant = violated
      ? "violated"
      : perms.profile === "read-only" ? "locked" : perms.profile === "edit" ? "edit" : "full";
    var title = violated
      ? "permission violation: this read-only step modified " + perms.violations.length + " path(s)"
      : perms.profile === "read-only"
        ? "read-only: no writes, no shell, no network" + (perms.verified ? " (verified against its workspace)" : "")
        : perms.profile === "edit"
          ? "edit: may write files in its own workspace, no network"
          : "full: every tool the agent CLI offers is pre-approved";
    return h("span", {
      class: "badge perms " + variant,
      title: title,
      text: permissionLabel(perms) + (violated ? " · violated" : "")
    });
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


  ST.state = S;
  ST.h = h;
  ST.AUTONOMY_META = AUTONOMY_META;
  ST.KIND_LABEL = KIND_LABEL;
  ST.TOUR_NAME = TOUR_NAME;
  ST.activateWithKeyboard = activateWithKeyboard;
  ST.addTokensInto = addTokensInto;
  ST.agentById = agentById;
  ST.agentHealthMeta = agentHealthMeta;
  ST.aggregateByModel = aggregateByModel;
  ST.announce = announce;
  ST.api = api;
  ST.apiAuth = apiAuth;
  ST.apiHealthMeta = apiHealthMeta;
  ST.apiInstanceById = apiInstanceById;
  ST.applyHealth = applyHealth;
  ST.attachRun = attachRun;
  ST.clear = clear;
  ST.clearRunDeepLink = clearRunDeepLink;
  ST.copyFix = copyFix;
  ST.cssEscape = cssEscape;
  ST.currentRunDeepLink = currentRunDeepLink;
  ST.effortsFor = effortsFor;
  ST.emptyTokens = emptyTokens;
  ST.fmtElapsed = fmtElapsed;
  ST.fmtTime = fmtTime;
  ST.fmtTokenSummary = fmtTokenSummary;
  ST.fmtTokens = fmtTokens;
  ST.fmtTotals = fmtTotals;
  ST.focusDetailFallback = focusDetailFallback;
  ST.friendlyStepLabel = friendlyStepLabel;
  ST.groupWorkflowsBySource = groupWorkflowsBySource;
  ST.handleRoute = handleRoute;
  ST.healthChip = healthChip;
  ST.isCredentialFreeSpec = isCredentialFreeSpec;
  ST.isInteractiveTarget = isInteractiveTarget;
  ST.isLiveAttached = isLiveAttached;
  ST.isReadOnly = isReadOnly;
  ST.loadSessionThenCatalog = loadSessionThenCatalog;
  ST.modelsFor = modelsFor;
  ST.openRunDeepLink = openRunDeepLink;
  ST.permissionBadge = permissionBadge;
  ST.pickNextWorkflow = pickNextWorkflow;
  ST.pollDoctor = pollDoctor;
  ST.pollLiveRuns = pollLiveRuns;
  ST.reduce = reduce;
  ST.refreshWorkflowList = refreshWorkflowList;
  ST.relTime = relTime;
  ST.restoreDetailInvoker = restoreDetailInvoker;
  ST.sandboxGlyph = sandboxGlyph;
  ST.scheduleRender = scheduleRender;
  ST.selectWorkflow = selectWorkflow;
  ST.setRunDeepLink = setRunDeepLink;
  ST.showCockpitRoute = showCockpitRoute;
  ST.showReauthOverlay = showReauthOverlay;
  ST.showSettingsRoute = showSettingsRoute;
  ST.stepKey = stepKey;
  ST.stepPermissions = stepPermissions;
  ST.tail = tail;
  ST.toggleWorkflowFolder = toggleWorkflowFolder;
  ST.totalTokens = totalTokens;
  ST.truncate = truncate;
  ST.updateLiveTimers = updateLiveTimers;
  ST.wfListItem = wfListItem;
  ST.workflowNeedsCredentials = workflowNeedsCredentials;
  ST.workflowSandboxBadge = workflowSandboxBadge;

  // Filled in by the modules that load after this one.
  ST.shell = null;
  ST.run = null;
  ST.instruments = null;
  ST.arrival = null;
  ST.settings = null;
  ST.modals = null;
  ST.render = null;
  ST.start = null;

  return ST;
})();
