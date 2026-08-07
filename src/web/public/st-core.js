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
  // key), so the header gives them no chip at all instead of a wall of red —
  // the settings table is where absent runners are listed.
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
  /**
   * Compact UI label for an agent instance id. Built-in `antigravity` is shown
   * as `agy` (the CLI binary) to save space; settings still surface the full
   * provider id. Prefer a catalog `label` when one is present.
   *
   * Keep the hardcoded fallback in sync with DEFAULT_AGENT_LABEL in
   * src/agents/config.ts (and PROVIDER_PRODUCT_NAME in st-settings.js).
   */
  function agentUiLabel(id) {
    if (!id) return "";
    for (var i = 0; i < (S.agents || []).length; i++) {
      var a = S.agents[i];
      if (a.id === id && a.label) return a.label;
    }
    if (id === "antigravity") return "agy";
    return id;
  }
  var S = {
    workflows: [], selected: null, source: null, spec: null, agents: [], apis: [],
    modelClasses: [], modelFamilies: [],
    runId: null, es: null,
    // Ownership of the current run, set when it is started or attached to.
    // `runExternal`: owned by another process (CLI/TUI or an already-detached
    // run) rather than this web server; `runDetached`: handed off to a
    // background process. Both gate the Detach button (updateDetachButton).
    runExternal: false,
    runDetached: false,
    startedAt: 0, timer: null,
    runState: null,
    rafQueued: false, draftAbort: null, doctor: [], apiDoctor: [], doctorReadAt: 0,
    // Reported by /api/doctor: the PATH the server searched, and where it came
    // from. Explains "absent" runners; see buildPathDetail in st-settings.js.
    doctorPath: null,
    // Signature of the last agent/API doctor result (pollDoctor). The catalog's
    // blocked/re-route annotations are server-computed from health, so a change
    // here — and only a change — re-fetches the workflow list.
    healthSig: null,
    stagedOverrides: {},
    childSpecs: {},
    projectConfig: null,
    // Postmortem results cached per run id so re-opening Diagnose is instant.
    diagnoseCache: {},
    // Full-page routing: which page #center is currently showing in place of
    // the cockpit ("settings", "runs", or null for the cockpit itself), and the
    // cockpit hash to restore when that page's Close button is clicked (never
    // another page — page→page hops keep the original cockpit return target).
    page: null,
    preRouteHash: "#",
    // Set just before navigating to a page when the hash we are leaving would
    // route straight back into it (openRunDeepLink's recorded-run redirect).
    // Consumed by the next handleRoute, which uses it instead of that hash.
    pageReturnOverride: null,
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
    // Scroll state for the expanded phase's internal step list, keyed by the
    // phase instance. A live render replaces that node, so keep the reader's
    // position (and whether they were at the bottom) outside the DOM.
    stepListScroll: {},
    // Same follow/position model for the drawer's full-output pane.
    drawerScroll: { follow: true, top: 0 },
    // Session capability from GET /api/session (or login). "read" hides every
    // mutate control; the server also 403s those routes as a hard backstop.
    capability: "full",
    // Focus the Arrival primary CTA once per completed run.
    arrivalCtaFocused: false,
    // Last aria-live announcement (avoid re-speaking the same text).
    announceText: "",
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
    // Generation stamp for the workflow-spec fetch in selectWorkflow(), so a
    // slow response for a workflow the user has already left cannot land.
    selectRequest: 0,
    reauthVisible: false,
    sessionHeartbeatTimer: null,
    sessionTtlMs: null,
    // Instrument rail (Task 7): the live throughput meter for the current run
    // (null until the first workflow_start) and the capped, newest-first
    // event log it renders alongside Spend/Runners/Worktrees.
    throughput: null,
    eventLog: [],
    // Approval checkpoint diff toggle, keyed by the approval step's id. The
    // 2s throughput tick (st-instruments.js) schedules a full re-render for
    // the life of the run, which would otherwise snap an opened diff shut
    // every tick since renderApproval rebuilds fresh DOM each pass.
    approvalDiffOpen: {},
    // In-progress human-input answer text, keyed by step id, mirrored from
    // the textarea's oninput. Same 2s-tick problem as approvalDiffOpen: a
    // fresh <textarea> is built on every re-render, which would otherwise
    // silently erase whatever the reader was mid-typing into a human-input
    // or agent-clarifying-question box during a live run.
    humanInputDraft: {},
    // Sub-workflow "what runs inside" expander, keyed by stepKey. Same 2s-tick
    // problem as approvalDiffOpen: the <details> is rebuilt on every render, so
    // without this an opened rollup snaps shut two seconds later. Keyed by
    // stepKey (phase:iteration:stepId) so a loop-back's iteration 2 does not
    // inherit iteration 1's open state for the same step id.
    subWorkflowOpen: {},
    // ---- plan editor (idle state) -------------------------------------------
    // Unsaved plan drafts, keyed by workflow name. A draft is a deep copy of
    // the saved spec that every plan/inspector edit mutates; it is the pending
    // diff against the workflow file until Save (PUT) or Discard. Runs and
    // dry-run plans execute the draft as-is (the launch sheet says so).
    planDrafts: {},
    // Which center tab is active: "plan" | "source" | "inputs".
    planTab: "plan",
    // Selected step ids in the plan (⌘-click multi-selects; the inspector
    // edits one or bulk-edits several).
    planSelection: [],
    // Source tab text state: the JSON the editor shows, plus whether it has
    // diverged from the draft's own serialization (user typed something that
    // doesn't parse, so the draft can't absorb it).
    sourceText: null,
    sourceDiverged: false,
    // Step id the source view should scroll to / highlight (plan → source sync).
    sourceReveal: null,
    // Server-judged dispatch warnings for the source view's gutter, as
    // { name, issues } so a late response for a workflow the reader has since
    // left is discarded rather than marking the wrong file.
    sourceLint: null,
    sourceLintTimer: null,
    // Recent completed runs of the selected workflow (rail footer and header
    // context). Fetched on selection.
    recentRuns: [],
    recentRunsFor: null,
    // Launch-sheet options, remembered across opens.
    launchOptions: { reuseCache: true, freshWorktrees: false, detach: false, budget: "", maxParallel: 0 },
    // Dry-run (plan) result shown inside the plan tab until dismissed.
    dryRunPlan: null,
    // Live-run step record rail: active tab ("live" | "prompt" | "config" | "events").
    recordTab: "live"
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
    var hideIds = ["settingsBtn", "newWfBtn", "editBtn", "cloneBtn", "flushBtn", "deleteBtn"];
    hideIds.forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.style.display = ro ? "none" : "";
    });
    // Authoring actions are for launching; viewers still pick workflows from
    // the sidebar to inspect the pipeline, so only the actions go away.
    if (ro) {
      var actions = document.getElementById("wfActions");
      if (actions) actions.style.display = "none";
    }
  }

  /** Identity of one step instance across re-renders (loop iterations included). */
  function stepKey(phase, step) {
    return phase.phaseId + ":" + (phase.iteration || 1) + ":" + step.stepId;
  }

  /**
   * Focus survival across a destructive rebuild (see the contract note on
   * render() in st-boot.js). Any control that a reader can be *inside* when the
   * canvas is rebuilt carries a stable `data-focus-key`; captureFocus() records
   * that key (plus the caret, for text controls) before the rebuild and
   * restoreFocus() puts the reader back into the equivalent replacement node.
   *
   * Opt-in by attribute on purpose: an element without a data-focus-key yields
   * no token, so nothing that lives outside the rebuilt region (the composer,
   * the header controls) is ever touched.
   */
  function captureFocus() {
    var el = document.activeElement;
    if (!el || el === document.body || !el.getAttribute) return null;
    var key = el.getAttribute("data-focus-key");
    if (!key) return null;
    var token = { key: key, start: null, end: null };
    // selectionStart throws on input types that don't support selection
    // (number, email, …) in some browsers; a caret-less restore is still fine.
    try {
      if (typeof el.selectionStart === "number") {
        token.start = el.selectionStart;
        token.end = el.selectionEnd;
      }
    } catch (e) {}
    return token;
  }

  function restoreFocus(token) {
    if (!token) return false;
    // Attribute scan rather than a querySelector, for the same reason
    // restoreDetailInvoker() does it: the keys embed arbitrary step ids.
    var candidates = document.querySelectorAll("[data-focus-key]");
    for (var i = 0; i < candidates.length; i++) {
      if (candidates[i].getAttribute("data-focus-key") !== token.key) continue;
      var el = candidates[i];
      el.focus();
      if (token.start !== null && typeof el.setSelectionRange === "function") {
        try { el.setSelectionRange(token.start, token.end); } catch (e) {}
      }
      return true;
    }
    return false;
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

  /**
   * A span of two elapsed times rendered as one range rather than two
   * timings: "3.8–3.9s", "1m 11–15s". Equal ends collapse to a single value,
   * and ends that share a unit (plus any leading "1m ") state it once. Ends
   * that do not — "58.0s" against "1m 02s" — stay spelled out in full.
   *
   * Callers pass durations, so the shared-unit regex is only ever offered a
   * fmtElapsed() reading: non-negative, and always <number><unit>-shaped.
   */
  function fmtElapsedRange(lo, hi) {
    var a = fmtElapsed(lo), b = fmtElapsed(hi);
    if (!a || !b) return a || b || "";
    if (a === b) return a;
    var pa = /^(.*?)([\d.]+)([a-z]+)$/.exec(a), pb = /^(.*?)([\d.]+)([a-z]+)$/.exec(b);
    if (pa && pb && pa[1] === pb[1] && pa[3] === pb[3]) return pa[1] + pa[2] + "–" + pb[2] + pb[3];
    return a + "–" + b;
  }

  /** Refresh every live ticking timer ("[data-since]") in one cheap pass. */
  function updateLiveTimers() {
    var nodes = document.querySelectorAll("[data-since]");
    var now = Date.now();
    for (var i = 0; i < nodes.length; i++) {
      var since = Number(nodes[i].getAttribute("data-since"));
      if (since > 0) {
        // Most live timers are standalone readouts and get the clock glyph.
        // Compound controls can provide their own stable label, such as the
        // inspector's "running " status prefix, without losing sibling nodes.
        var prefix = nodes[i].getAttribute("data-since-prefix");
        nodes[i].textContent = (prefix === null ? "⏱ " : prefix) + fmtElapsed(now - since);
      }
    }
  }

  function h(tag, attrs) {
    var e = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        if (k === "class") e.className = attrs[k];
        else if (k === "text") e.textContent = attrs[k];
        // Require a function, not just an "on" prefix — otherwise a plain
        // attribute that happens to start with "on" (onlinestatus, and the like)
        // would be swallowed as a listener and never reach the element.
        else if (k.indexOf("on") === 0 && typeof attrs[k] === "function") e.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
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
    }).then(function (r) {
      // Never let a non-JSON response reject: a 204, an empty 5xx, or an HTML
      // error page from a reverse proxy would otherwise throw here, and most
      // callers only branch on r.status — the rejection would surface as an
      // unhandled promise and the caller would simply never run, leaving the
      // UI stuck on whatever it was showing. Hand back a null body instead so
      // every caller's own status handling still gets to run.
      return r.text().then(function (raw) {
        var parsed = null;
        if (raw) { try { parsed = JSON.parse(raw); } catch (e) { parsed = null; } }
        return { status: r.status, body: parsed === null ? {} : parsed };
      });
    });
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
      // Say "the server failed" rather than rendering an empty rail, which
      // reads as "this project has no workflows" — a data problem the reader
      // would go looking for in their config instead of in the server log.
      if (r.status !== 200) {
        ST.run.setBanner((r.body && r.body.error) || ("could not load workflows (HTTP " + r.status + ")"), "err");
        return;
      }
      S.workflows = r.body.workflows || [];
      if (r.body.configLabel) {
        S.configLabel = r.body.configLabel;
        ST.shell.renderCrumbs();
      }
      if (r.body.project) applyProjectChrome(r.body.project);
      ST.shell.renderSidebar();
      // This is the only dispatcher for run/step deep links — the boot-time
      // handleRoute() deliberately handles settings routes only, because the
      // catalog isn't loaded yet at that point (see st-boot.js).
      var deepLinkId = SteamtrainReducer.parseDeepLink(window.location.hash);
      if (deepLinkId && deepLinkId.runId) openRunDeepLink(deepLinkId.runId, deepLinkId.stepId);
      else bootstrapDefaultWorkflow();
    });
    loadMeta();
    if (!isReadOnly()) loadProjectConfig();
    pollDoctor(0);
    applyHealthCadence();
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
    // Prefer a credential-free next workflow when one exists; otherwise keep order.
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
      // Not live (or gone): it is a recorded run, so hand it to the run
      // browser, which opens with that run selected into its receipt rail.
      // The `#run-` hash we came in on resolves right back here, so it must
      // not become the page's return target — Close would bounce off it
      // forever. The cockpit is where Close belongs from a redirect.
      S.pageReturnOverride = "#";
      ST.runs.open(runId);
    }).catch(function () {
      if (request === S.deepLinkRequest && currentRunDeepLink() === runId) {
        ST.run.setBanner("Could not open run " + runId.slice(0, 8) + "… — network error.", "err");
      }
    });
  }

  // ---- routing (cockpit vs. full-page surfaces) -----------------------------
  /**
   * The pages that take over #center in place of the cockpit. Each owns a mount
   * node (created on first visit, thereafter only shown/hidden) and the module
   * that paints into it. Both pages bring their own rails, so the cockpit's are
   * hidden while either is up.
   */
  var PAGE_MOUNTS = {
    settings: { id: "settingsRoot", render: function (pane, arg) { ST.settings.render(pane, arg); } },
    runs: { id: "runsRoot", render: function (pane, arg) { ST.runs.render(pane, arg); } }
  };

  /**
   * Hide the cockpit (`.work` inside #center) and both rails, show `page` in
   * their place. Toggled with `display`, never detached — background pollers
   * (live runs, doctor) keep calling render()/renderSidebar() against #bands
   * etc. while a page is open, and those must stay real, attached nodes or a
   * stray getElementById would come back null.
   */
  function showPageRoute(page, arg) {
    var mount = PAGE_MOUNTS[page];
    var center = document.getElementById("center");
    if (!mount || !center) return;
    // The step drill-in drawer is `position: fixed` and lives OUTSIDE #center,
    // so hiding the cockpit below does not hide it. Clear its state (rather
    // than hide the node) so the background render loop stops re-opening it —
    // an open drawer would otherwise sit pinned over the page, covering its
    // footer actions.
    S.detail = null;
    S.detailInvoker = null;
    S.detailFallback = null;
    S.detailFocusPending = false;
    S.detailFocusGeneration += 1;
    if (ST.run && ST.run.renderDetail) ST.run.renderDetail();
    var work = center.querySelector("section.work");
    if (work) work.style.display = "none";
    var railLeft = document.getElementById("rail-left");
    var railRight = document.getElementById("rail-right");
    if (railLeft) railLeft.style.display = "none";
    if (railRight) railRight.style.display = "none";
    // Only one page is ever up: hide the other's mount before showing this one.
    Object.keys(PAGE_MOUNTS).forEach(function (other) {
      if (other === page) return;
      var el = document.getElementById(PAGE_MOUNTS[other].id);
      if (el) el.style.display = "none";
    });
    var pane = document.getElementById(mount.id);
    if (!pane) {
      pane = document.createElement("div");
      pane.id = mount.id;
      center.appendChild(pane);
    }
    // Undo the `display: none` a previous hide left behind — the page's own
    // class supplies `display: flex`, but an inline style always wins over it.
    pane.style.display = "";
    mount.render(pane, arg);
    // The page swaps the breadcrumb's location segment and the nav's active
    // button; idle, no cockpit render tick may fire to notice on its own.
    ST.shell.renderCrumbs();
    if (ST.run && ST.run.updateRunPill) ST.run.updateRunPill();
  }

  /** Restore the cockpit: reveal `.work` + both rails, hide every page mount. */
  function showCockpitRoute() {
    var center = document.getElementById("center");
    if (!center) return;
    Object.keys(PAGE_MOUNTS).forEach(function (page) {
      var pane = document.getElementById(PAGE_MOUNTS[page].id);
      if (pane) pane.style.display = "none";
    });
    if (ST.runs && ST.runs.onLeave) ST.runs.onLeave();
    var work = center.querySelector("section.work");
    if (work) work.style.display = "";
    var railLeft = document.getElementById("rail-left");
    var railRight = document.getElementById("rail-right");
    if (railLeft) railLeft.style.display = "";
    if (railRight) railRight.style.display = "";
    ST.shell.renderCrumbs();
    if (ST.run && ST.run.updateRunPill) ST.run.updateRunPill();
  }

  /** True when `hash` is Runs/Settings — not a cockpit return target. */
  function isPageHash(hash) {
    if (SteamtrainReducer.isPageRoute) return SteamtrainReducer.isPageRoute(hash || "");
    return /^#(runs|settings)(\/|$)/i.test(hash || "");
  }

  /**
   * Leave whichever page is up and return to the cockpit. The remembered
   * `preRouteHash` is restored when it is a cockpit target (empty/`#`, or a
   * live `#run-…` deep link). Another page hash is never a return target —
   * Settings → Runs → Close must land on home, not bounce back to Settings.
   */
  function closePageRoute() {
    var target = S.preRouteHash || "#";
    if (isPageHash(target)) target = "#";
    S.page = null;
    showCockpitRoute();
    if (window.location.hash !== target) window.location.hash = target;
    else if (window.location.hash) history.replaceState(null, "", window.location.pathname + window.location.search);
  }

  /**
   * Always return to the initial cockpit home: hide any page, clear the hash,
   * and drop any page-return memory. Bound to the topbar brand so home is one
   * click away from Runs, Settings, or a run deep link.
   */
  function goHome() {
    S.page = null;
    S.preRouteHash = "#";
    S.pageReturnOverride = null;
    showCockpitRoute();
    if (window.location.hash) {
      history.replaceState(null, "", window.location.pathname + window.location.search);
    }
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
   *
   * `bootPagesOnly` is true only for that one-time boot call (see
   * st-boot.js's `start()`). At boot the workflow catalog hasn't loaded yet,
   * so a `run` route can't be resolved correctly here — `attachRun` would
   * take its "workflow not in catalog" fallback even for a known workflow.
   * `loadWorkflows()` (st-core.js) re-parses the hash and dispatches run/step
   * deep links itself once the catalog is in hand, so this function must
   * leave `run` routes alone at boot to avoid a double-dispatch race: both
   * calls would set S.pendingStepDeepLink to the same step id, and whichever
   * of the two attachRun→begin() cascades finished last would win, sometimes
   * clobbering S.detail back to null after the other cascade had already
   * opened the step drawer. `settings` routes have no such second dispatcher,
   * so they're still resolved here at boot.
   */
  function handleRoute(oldHash, bootPagesOnly) {
    var route = SteamtrainReducer.parseRoute ? SteamtrainReducer.parseRoute(window.location.hash) : null;
    if (route && (route.kind === "settings" || route.kind === "runs")) {
      // Remember the return hash only when arriving from the cockpit —
      // section changes on the same page must not overwrite it, and
      // page→page hops (Settings → Runs) must keep the original cockpit
      // return target rather than the page we are leaving.
      if (S.page !== route.kind) {
        if (S.pageReturnOverride) {
          S.preRouteHash = S.pageReturnOverride;
        } else if (!S.page) {
          var candidate = (typeof oldHash === "string" && oldHash) ? oldHash : "#";
          S.preRouteHash = isPageHash(candidate) ? "#" : candidate;
        }
        S.page = route.kind;
      }
      S.pageReturnOverride = null;
      showPageRoute(route.kind, route.kind === "settings" ? route.section : route.runId);
      return;
    }
    if (route && route.kind === "run") {
      if (bootPagesOnly) return;
      if (S.page) { S.page = null; showCockpitRoute(); }
      openRunDeepLink(route.runId, route.stepId);
      return;
    }
    if (S.page) { S.page = null; showCockpitRoute(); }
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
      S.tailScroll = {}; S.stepListScroll = {}; S.drawerScroll = { follow: true, top: 0 }; S.approvalDiffOpen = {}; S.humanInputDraft = {}; S.subWorkflowOpen = {};
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
            // Reauth can land on a different capability than the session that
            // expired (the read token mints a viewer session), so the health
            // timer has to be re-decided here: a viewer must not keep firing
            // POST /api/doctor at a 403, and a session that came back with
            // full capability should get the cadence it asked for.
            applyHealthCadence();
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
    // Floor as well as cap: a nonsensical TTL (negative, or small enough to
    // divide down to ~0) would otherwise make setInterval fire continuously and
    // turn the heartbeat into a tight poll against /api/session.
    var interval = S.sessionTtlMs
      ? Math.max(5000, Math.min(60000, Math.floor(S.sessionTtlMs / 120)))
      : 60000;
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
      // The PATH the server resolved binaries against. Only read when a runner
      // turns up absent, but carried on every poll so it is never staler than
      // the results it explains.
      S.doctorPath = r.body.path || null;
      // When this client last read a probe snapshot. GET /api/doctor returns
      // the server's last snapshot rather than re-probing, so this is "how
      // fresh is what you're looking at", not "when were the probes run" —
      // Recheck (POST) is what actually re-probes.
      S.doctorReadAt = Date.now();
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

  // ---- health re-probing ------------------------------------------------------
  // GET /api/doctor reads the server's last snapshot; POST re-probes. Everything
  // that wants fresh readiness (the Recheck button, the launch sheet, the 60s
  // cadence) goes through recheckHealth so they all update the same state and
  // repaint the same surfaces.
  var HEALTH_CADENCES = ["manual", "launch", "every60"];
  // Paired with the "Every 60s" label in the settings segmented control — the
  // two have to move together.
  var HEALTH_POLL_MS = 60000;
  var HEALTH_CADENCE_KEY = "steamtrain.healthCadence";
  var healthTimer = null;
  var recheckInFlight = null;

  /**
   * How often runner availability is re-probed. A viewing preference, not a
   * workflow setting — it changes what this browser asks for, never the config
   * a run reads — so it lives in localStorage rather than in config.json.
   */
  function healthCadence() {
    try {
      var stored = localStorage.getItem(HEALTH_CADENCE_KEY);
      if (HEALTH_CADENCES.indexOf(stored) >= 0) return stored;
    } catch (e) {}
    return "launch";
  }
  function setHealthCadence(next) {
    if (HEALTH_CADENCES.indexOf(next) < 0) return;
    try { localStorage.setItem(HEALTH_CADENCE_KEY, next); } catch (e) {}
    applyHealthCadence();
  }
  /** Start or stop the periodic re-probe to match the current preference. */
  function applyHealthCadence() {
    if (healthTimer) { clearInterval(healthTimer); healthTimer = null; }
    // POST /api/doctor is a control-plane write, so viewers never get the timer.
    if (healthCadence() !== "every60" || isReadOnly()) return;
    healthTimer = setInterval(function () { recheckHealth(); }, HEALTH_POLL_MS);
  }
  /** Re-probe now, unless one is already in flight (the timer can overlap a click). */
  function recheckHealth() {
    if (recheckInFlight) return recheckInFlight;
    recheckInFlight = apiAuth("POST", "/api/doctor").then(function (r) {
      if (r.status === 200 && r.body) {
        S.doctor = r.body.doctor || [];
        S.apiDoctor = r.body.apis || [];
        S.doctorPath = r.body.path || null;
        S.doctorReadAt = Date.now();
        ST.shell.renderHealth(S.doctor, S.apiDoctor, r.body.doctorError || null);
        applyHealth();
        refreshWorkflowList();
      }
      return r;
    }).catch(function () {
      return { status: 0 };
    }).then(function (r) {
      recheckInFlight = null;
      return r;
    });
    return recheckInFlight;
  }
  /**
   * The "On launch" cadence: fresh readiness at the moment a run is set up.
   * Always returns a promise so callers can sequence on it; under "Manual" it
   * is already resolved and costs nothing.
   */
  function recheckHealthOnLaunch() {
    if (healthCadence() === "manual" || isReadOnly()) return Promise.resolve(null);
    return recheckHealth();
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

  function selectWorkflow(name, after, options) {
    if (!(options && options.preserveRunDeepLink) && currentRunDeepLink()) clearRunDeepLink();
    // Ignore any plan response that was initiated for the previously selected
    // workflow while its asynchronous history lookup was still running.
    S.planRequest += 1;
    if (S.es) { S.es.close(); S.es = null; }
    ST.run.stopTimer();
    if (ST.instruments) ST.instruments.reset();
    // Plan editor: drafts are keyed by workflow name and survive across
    // navigation when dirty. Drop a clean (view-only) draft for the workflow
    // we are leaving so the rail never shows a false dirty dot. Use isDirty()
    // (canonical compare) rather than JSON.stringify so key order cannot leave
    // a phantom dirty dot after a mutation round-trip.
    var leaving = S.selected;
    if (leaving && leaving !== name && S.planDrafts[leaving] && ST.plan && ST.plan.isDirty) {
      if (!ST.plan.isDirty(leaving)) delete S.planDrafts[leaving];
    }
    S.selected = name; S.runId = null; S.runState = null;
    S.detail = null; S.detailInvoker = null; S.detailFallback = null; S.detailFocusPending = false; S.detailFocusGeneration += 1;
    S.selectedStepId = null;
    S.tailScroll = {}; S.stepListScroll = {}; S.drawerScroll = { follow: true, top: 0 }; S.approvalDiffOpen = {}; S.humanInputDraft = {}; S.subWorkflowOpen = {};
    S.arrivalEnter = false; S.endedAt = 0;
    S.arrivalCtaFocused = false;
    S.planSelection = [];
    S.sourceText = null; S.sourceDiverged = false; S.sourceReveal = null; S.sourceLint = null;
    S.dryRunPlan = null;
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
    // Stamp this selection so a slow spec response for a workflow the user has
    // already navigated away from cannot land. Without it, clicking A then B
    // quickly lets A's response overwrite S.spec and the run header while
    // S.selected already says B — the pipeline on screen belongs to neither.
    S.selectRequest = (S.selectRequest || 0) + 1;
    var selectGeneration = S.selectRequest;
    apiAuth("GET", "/api/workflows/" + encodeURIComponent(name)).then(function (r) {
      if (selectGeneration !== S.selectRequest) return;
      if (r.status !== 200) { ST.run.setBanner(r.body.error || "failed to load", "err"); return; }
      S.spec = r.body.spec;
      S.source = r.body.source;
      S.childSpecs = r.body.children || {};
      document.getElementById("wfTitle").textContent = r.body.spec.name;
      document.getElementById("wfSub").textContent = r.body.spec.description || "";
      ST.shell.renderSourceLine();
      ST.shell.renderBlockedRow();
      ST.run.renderParamsForm(r.body.spec);
      S.runState = SteamtrainReducer.workflowStateFromSpec(ST.run.effectiveSpec() || r.body.spec);
      ST.shell.renderHealth(S.doctor || [], S.apiDoctor || [], null);
      ST.render();
      ST.run.renderStagedIndicator();
      if (ST.plan && ST.plan.loadRecentRuns) ST.plan.loadRecentRuns(name);
      if (after) after();
    });
  }

  // ---- run model -----------------------------------------------------------
  function reduce(ev) {
    if (!S.runState) {
      S.runState = SteamtrainReducer.initialWorkflowState;
    }
    S.runState = SteamtrainReducer.workflowReducer(S.runState, { type: "event", event: ev });
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

  /**
   * The spend and tokens to show for one step: its finished result when it has
   * one, otherwise the running total the reducer folds from the agent's own
   * mid-flight reports (StepState.usage). `live` marks the second case, so a
   * caller can label the number as "so far" rather than let a still-climbing
   * count read like a final bill.
   *
   * Fields fall back independently: an agent that reports tokens mid-flight but
   * prices only at the end (Claude Code) has live tokens and no live spend, and
   * the missing one must stay absent — a zero would read as free.
   *
   * A result that REPORTED a field wins outright, even reporting zero — a step
   * the provider billed nothing for reads $0.0000, not the estimate the stream
   * had accumulated before the real number arrived.
   */
  function stepUsage(s) {
    var r = (s && s.result) || null;
    var u = (s && s.usage) || null;
    var cost = r && typeof r.costUsd === "number" ? r.costUsd : (u && u.costUsd) || 0;
    var tokens = r && r.tokens ? totalTokens(r.tokens) : (u && totalTokens(u.tokens)) || 0;
    return { costUsd: cost, tokens: tokens, live: !r && (cost > 0 || tokens > 0) };
  }
  // Per-model roll-up of leaf steps, biggest spender first (mirrors cost.ts).
  function aggregateByModel(steps) {
    var map = {};
    steps.forEach(function (s) {
      if (!s.result || (s.result.childResults && s.result.childResults.length)) return;
      var key = s.model && s.agent
        ? agentUiLabel(s.agent) + "/" + s.model
        : (s.model || (s.agent ? agentUiLabel(s.agent) : "(agentless)"));
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
  ST.activateWithKeyboard = activateWithKeyboard;
  ST.addTokensInto = addTokensInto;
  ST.agentById = agentById;
  ST.agentHealthMeta = agentHealthMeta;
  ST.agentUiLabel = agentUiLabel;
  ST.aggregateByModel = aggregateByModel;
  ST.announce = announce;
  ST.api = api;
  ST.apiAuth = apiAuth;
  ST.apiHealthMeta = apiHealthMeta;
  ST.apiInstanceById = apiInstanceById;
  ST.applyHealth = applyHealth;
  ST.attachRun = attachRun;
  ST.captureFocus = captureFocus;
  ST.clear = clear;
  ST.clearRunDeepLink = clearRunDeepLink;
  ST.copyFix = copyFix;
  ST.currentRunDeepLink = currentRunDeepLink;
  ST.effortsFor = effortsFor;
  ST.emptyTokens = emptyTokens;
  ST.fmtElapsed = fmtElapsed;
  ST.fmtElapsedRange = fmtElapsedRange;
  ST.fmtTime = fmtTime;
  ST.fmtTokenSummary = fmtTokenSummary;
  ST.fmtTokens = fmtTokens;
  ST.fmtTotals = fmtTotals;
  ST.focusDetailFallback = focusDetailFallback;
  ST.friendlyStepLabel = friendlyStepLabel;
  ST.groupWorkflowsBySource = groupWorkflowsBySource;
  ST.handleRoute = handleRoute;
  ST.healthCadence = healthCadence;
  ST.setHealthCadence = setHealthCadence;
  ST.recheckHealth = recheckHealth;
  ST.recheckHealthOnLaunch = recheckHealthOnLaunch;
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
  ST.restoreFocus = restoreFocus;
  ST.scheduleRender = scheduleRender;
  ST.selectWorkflow = selectWorkflow;
  ST.setRunDeepLink = setRunDeepLink;
  ST.closePageRoute = closePageRoute;
  ST.goHome = goHome;
  ST.showCockpitRoute = showCockpitRoute;
  ST.showPageRoute = showPageRoute;
  ST.showReauthOverlay = showReauthOverlay;
  ST.stepKey = stepKey;
  ST.stepPermissions = stepPermissions;
  ST.stepUsage = stepUsage;
  ST.tail = tail;
  ST.toggleWorkflowFolder = toggleWorkflowFolder;
  ST.totalTokens = totalTokens;
  ST.truncate = truncate;
  ST.updateLiveTimers = updateLiveTimers;
  ST.wfListItem = wfListItem;
  ST.workflowNeedsCredentials = workflowNeedsCredentials;

  // Filled in by the modules that load after this one.
  ST.shell = null;
  ST.run = null;
  ST.instruments = null;
  ST.arrival = null;
  ST.settings = null;
  ST.runs = null;
  ST.modals = null;
  ST.render = null;
  ST.start = null;

  return ST;
})();
