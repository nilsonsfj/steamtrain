/**
 * Shell surface: the topbar (breadcrumb + health chips) and the left
 * workflow rail. Owns #topbar's dynamic content and everything inside
 * #rail-left; the old work-section markup inside #center belongs to Task 6.
 */
(function (ST) {
  "use strict";
  var S = ST.state;
  var h = ST.h;
  var agentHealthMeta = ST.agentHealthMeta;
  var apiHealthMeta = ST.apiHealthMeta;
  var attachRun = ST.attachRun;
  var clear = ST.clear;
  var groupWorkflowsBySource = ST.groupWorkflowsBySource;
  var isCredentialFreeSpec = ST.isCredentialFreeSpec;
  var isLiveAttached = ST.isLiveAttached;
  var isReadOnly = ST.isReadOnly;
  var relTime = ST.relTime;
  var selectWorkflow = ST.selectWorkflow;
  var truncate = ST.truncate;
  var wfListItem = ST.wfListItem;

  /**
   * "Every agent step is read-only." PermissionSummary
   * (src/workflow/permission-preflight.ts:173) has no allReadOnly field —
   * counts["read-only"] must equal agentSteps.
   */
  function allReadOnly(p) {
    return !!p && p.agentSteps > 0 && p.counts["read-only"] === p.agentSteps;
  }

  /**
   * The rail's static scaffolding (head + list + footer containers) is built
   * once here; renderSidebar()/renderLiveRuns() only ever touch their own
   * sub-container afterwards.
   */
  function ensureRailSkeleton() {
    if (document.getElementById("wflist")) return;
    var rail = document.getElementById("rail-left");
    if (!rail) return;
    clear(rail);
    rail.appendChild(h("div", { class: "rail-head" },
      h("span", { class: "rail-label", text: "Workflows" }),
      h("span", { class: "rail-count", id: "wfCount" }),
      h("button", {
        class: "rail-add", id: "newWfBtn", type: "button",
        title: "Create a workflow", "aria-label": "Create a workflow"
      }, "+")
    ));
    rail.appendChild(h("div", { class: "wf-list", id: "wflist" }));
    rail.appendChild(h("div", { class: "rail-foot", id: "railFoot" }));
  }

  /** Renders the header + rail scaffolding into the static page skeleton. */
  function render() {
    ensureRailSkeleton();
  }

  function workflowRow(w) {
    var row = h("button", {
      class: "wf-row" + (S.selected === w.name && !isLiveAttached() ? " selected" : ""),
      type: "button"
    });
    // Keep an inspector field's blur from cancelling the rail click (the plan
    // editor commits on blur and used to rebuild the rail before mouseup).
    row.addEventListener("mousedown", function (e) { e.preventDefault(); });
    row.addEventListener("click", function () {
      var active = document.activeElement;
      if (active && active !== row && active.blur) active.blur();
      selectWorkflow(w.name);
    });
    row.appendChild(h("span", { class: "name", text: w.name }));
    // Unsaved plan edits follow the workflow across navigation (the draft is
    // keyed by name) — the amber dot is that pending diff, visible in the rail.
    if (ST.plan && ST.plan.isDirty && ST.plan.isDirty(w.name)) {
      row.appendChild(h("span", { class: "dirty-dot", title: "unsaved plan edits" }));
    }
    if (allReadOnly(w.permissions)) {
      row.appendChild(h("span", { class: "lock", text: "🔒", title: "every agent step read-only" }));
    }
    row.appendChild(h("span", { class: "counts", text: w.phaseCount + "·" + w.stepCount }));
    return row;
  }

  function groupHeading(source, count) {
    var label = source === "project" ? "Project" : source === "user" ? "User" : "Bundled";
    return h("div", { class: "wf-group" },
      h("span", { class: "rail-label", text: label }),
      h("span", { class: "rail-count", text: String(count) }));
  }

  function renderSidebar() {
    ensureRailSkeleton();
    var box = document.getElementById("wflist");
    var count = document.getElementById("wfCount");
    if (!box) return;
    clear(box);
    // Keep project-specific workflows closest to the project, followed by
    // user workflows and finally the read-only bundled catalog.
    var RAIL_ORDER = { project: 0, user: 1, bundled: 2 };
    var groups = groupWorkflowsBySource(S.workflows).slice().sort(function (a, b) {
      return RAIL_ORDER[a.source] - RAIL_ORDER[b.source];
    });
    if (count) count.textContent = String(S.workflows.length);
    groups.forEach(function (group) {
      box.appendChild(groupHeading(group.source, group.entries.length));
      group.entries.forEach(function (w) { box.appendChild(workflowRow(w)); });
    });
  }

  /**
   * The shape of the run in flight (design 6a): how far the loop has got, how
   * many sub-runs are open, how many worktrees are allocated. Each line appears
   * only when the run actually has such a thing — a run with no loop says
   * nothing about loops rather than reporting "0 / 0".
   */
  function renderRunShape(foot) {
    if (!S.runId || !S.runState || !ST.tree) return;
    var shape = ST.tree.runShape(S.runState);
    var lines = [];
    if (shape.loop) {
      lines.push(["loop passes", shape.loop.cap ? shape.loop.pass + " / " + shape.loop.cap : String(shape.loop.pass)]);
    }
    if (shape.subRuns) lines.push(["sub-runs", shape.subRuns + " active"]);
    if (shape.worktrees) lines.push(["worktrees", shape.worktrees + " open"]);
    if (!lines.length) return;
    var box = h("div", { class: "run-shape" });
    lines.forEach(function (pair) {
      box.appendChild(h("div", { class: "run-shape-row" },
        h("span", { class: "k", text: pair[0] }),
        h("span", { class: "v", text: pair[1] })));
    });
    foot.appendChild(box);
  }

  /** Rail footer: runs that are elsewhere — detached, or blocked on approval. */
  function renderLiveRuns() {
    ensureRailSkeleton();
    var foot = document.getElementById("railFoot");
    if (!foot) return;
    clear(foot);
    renderRunShape(foot);
    var elsewhere = S.liveRuns.filter(function (run) {
      return run.detached || (run.pendingApprovals && run.pendingApprovals.length);
    });
    elsewhere.forEach(function (run) {
      var awaiting = !run.detached && run.pendingApprovals && run.pendingApprovals.length;
      var row = h("button", {
        class: "elsewhere-row" + (run.detached ? " detached" : "") + (awaiting ? " awaiting" : ""),
        type: "button",
        title: truncate(run.input || "", 80),
        onClick: function () { attachRun(run); }
      });
      row.appendChild(h("span", { class: "dot" }));
      row.appendChild(h("span", {
        text: run.workflow + " · " + (run.detached ? "detached" : "awaiting approval") +
          " · " + relTime(run.startedAt)
      }));
      foot.appendChild(row);
    });
    // Recent completed runs of the selected workflow (fetched on selection by
    // st-plan.loadRecentRuns). Click-through opens the runs page's receipt.
    if (S.selected && S.recentRuns && S.recentRuns.length) {
      foot.appendChild(h("div", { class: "rail-label recent-label", text: "Recent runs · " + S.selected }));
      S.recentRuns.forEach(function (run) {
        var ok = run.status !== "error" && run.status !== "canceled" && run.status !== "budget-exceeded";
        var row = h("button", {
          class: "elsewhere-row recent " + (ok ? "ok" : "err"),
          type: "button",
          title: truncate(run.input || "", 80),
          onClick: function () { ST.runs.open(run.id); }
        });
        row.appendChild(h("span", { class: "dot" }));
        var right = !ok ? run.status
          : run.totals && run.totals.costUsd > 0 ? "$" + run.totals.costUsd.toFixed(3)
          : "ok";
        row.appendChild(h("span", { text: run.id.slice(0, 5) + " · " + relTime(run.startedAt) + " · " + right }));
        foot.appendChild(row);
      });
    }
  }

  /**
   * The blocked/re-route strip for the selected workflow. When the pinned
   * agent is not ready but another agent is, Run stays live and re-routes the
   * blocked steps for that run only — the strip says so before the click.
   */
  function renderBlockedRow() {
    var row = document.getElementById("blockedRow");
    if (!row) return;
    clear(row);
    var item = S.selected ? wfListItem(S.selected) : null;
    if (!item || !item.blocked || isReadOnly()) {
      row.style.display = "none";
      return;
    }
    row.style.display = "flex";
    if (item.reroute) {
      var rr = item.reroute;
      var steps = rr.steps === 1 ? "1 step" : rr.steps + " steps";
      row.className = "reroute-row info";
      row.appendChild(h("span", { class: "reroute-icon", text: "↷" }));
      row.appendChild(h("span", {},
        h("b", {}, "Needs " + rr.blockedAgents.map(ST.agentUiLabel).join(", ") + " (not ready). "),
        "Run re-routes " + steps + " to " + ST.agentUiLabel(rr.agent) + " · " + (rr.modelName || rr.model) +
        " for this run only — the workflow itself is unchanged."));
    } else {
      row.className = "reroute-row err";
      row.appendChild(h("span", { class: "reroute-icon", text: "⚠" }));
      row.appendChild(h("span", { text: item.blocked }));
    }
  }

  /**
   * Why launching the selected workflow is refused, or "" when it is allowed.
   * The strip above only explains the block; this is what the plan's Run
   * buttons disable on, so the two can never disagree. A re-routable block is
   * not a refusal — that run swaps runners and goes.
   */
  function launchBlocked() {
    var item = S.selected ? wfListItem(S.selected) : null;
    if (!item || !item.blocked || item.reroute) return "";
    return item.blocked;
  }

  /**
   * Bucket agent + API doctor results into ready / needs-auth, keeping agents
   * and APIs apart so the chips can name what they counted. Runners that are
   * merely absent (no CLI installed, no key set) are not counted at all: they
   * are the resting state for a tool the user doesn't use, and a chip for them
   * is noise in the topbar. Settings still lists them, greyed out.
   */
  function healthCounts(list, apis) {
    var counts = { readyAgents: 0, readyApis: 0, authAgents: 0, authApis: 0, probed: 0 };
    (list || []).forEach(function (d) {
      counts.probed++;
      if (d.status === "ok") counts.readyAgents++;
      else if (agentHealthMeta(d.status).loud) counts.authAgents++;
      // No third branch: calm not-ready states fall through uncounted on purpose.
    });
    (apis || []).forEach(function (d) {
      counts.probed++;
      if (d.status === "ok") counts.readyApis++;
      else if (apiHealthMeta(d.status).loud) counts.authApis++;
    });
    return counts;
  }

  /** "6 agents", "1 API", "6 agents + 1 API" — never a bare number. */
  function runnerLabel(agents, apis) {
    var parts = [];
    if (agents) parts.push(agents + (agents === 1 ? " agent" : " agents"));
    if (apis) parts.push(apis + (apis === 1 ? " API" : " APIs"));
    return parts.join(" + ");
  }

  /** A health chip — still a button that opens the settings page. */
  function healthChip(cls, text, title) {
    return h("button", {
      class: "chip " + cls, type: "button", title: title,
      onClick: function () { ST.settings.open("runners"); }
    }, h("span", { class: "dot" }), text);
  }

  function renderHealth(list, apis, err) {
    var box = document.getElementById("health");
    if (!box) return;
    clear(box);
    if (isCredentialFreeSpec(S.spec)) {
      box.appendChild(healthChip("ready", "ready · no agents required",
        "This workflow needs no agent CLI and no API key."));
      return;
    }
    if (err) {
      box.appendChild(healthChip("auth", "doctor error", "The agent doctor failed to run: " + err));
      return;
    }
    var counts = healthCounts(list, apis);
    var ready = runnerLabel(counts.readyAgents, counts.readyApis);
    var auth = runnerLabel(counts.authAgents, counts.authApis);
    if (ready) box.appendChild(healthChip("ready", "ready · " + ready, ready + " ready to run"));
    if (auth) {
      var one = counts.authAgents + counts.authApis === 1;
      box.appendChild(healthChip("auth", "needs auth · " + auth,
        auth + (one ? " needs" : " need") + " sign-in or a valid key"));
    }
    // Nothing ready and nothing fixable means every probed runner is absent —
    // say so once instead of leaving the chip group empty.
    if (!ready && !auth && counts.probed) {
      box.appendChild(healthChip("quiet", "no runner ready",
        "Nothing installed or signed in yet — open Settings to set a runner up."));
    }
  }

  /**
   * Breadcrumb: the project, then WHERE you are — the selected workflow (plus
   * "run <id>" while a run is attached), or the page name when Runs/Settings
   * is covering the cockpit. Also owns the nav buttons' active state, which is
   * the same "where am I" fact. Re-rendered from the central render() and on
   * every route change; the config label, when present, trails as quiet
   * context rather than posing as a location.
   */
  function renderCrumbs() {
    var nav = document.getElementById("crumbs");
    if (!nav) return;
    clear(nav);
    var parts = [];
    // In the desktop app the project segment is the switcher rather than a
    // crumb, so it is appended directly and left out of `parts` — the "here"
    // highlight below belongs to a location you are at, not to the root you
    // can change. A browser tab has no project to switch to and keeps the
    // plain path it has always shown.
    var switcher = ST.projects.enabled() && S.project && S.project.name;
    if (switcher) {
      nav.appendChild(ST.projects.crumbButton());
    } else if (S.project && S.project.name) {
      // Marked as the path crumb: it is the longest and the least load-bearing,
      // so it is the one that gives up width when the bar is short of it.
      parts.push({
        text: S.project.displayPath || S.project.name,
        title: S.project.cwd || S.project.name,
        path: true
      });
    }
    if (S.page === "runs" || S.page === "settings") {
      parts.push({ text: S.page });
    } else if (S.runId && S.runState && S.runState.started) {
      if (S.selected) parts.push({ text: S.selected });
      parts.push({ text: "run " + S.runId.slice(0, 5), title: S.runId });
    } else if (S.selected) {
      parts.push({ text: S.selected });
    }
    if (S.configLabel) {
      parts.push({ text: "cfg · " + S.configLabel, title: "Active configuration", quiet: true });
    }
    var lastLocation = -1;
    parts.forEach(function (part, idx) { if (!part.quiet) lastLocation = idx; });
    parts.forEach(function (part, idx) {
      // The switcher is already sitting where part 0 would be, so the first
      // crumb after it still needs its separator.
      if (idx > 0 || switcher) nav.appendChild(h("span", { class: "sep", text: "/" }));
      var cls = idx === lastLocation ? "here" : "";
      if (part.quiet) cls += " quiet";
      if (part.path) cls += " path";
      nav.appendChild(h("span", {
        class: cls.trim(),
        title: part.title || "",
        text: part.text
      }));
    });
    var active = { workflowsBtn: !S.page, historyBtn: S.page === "runs", settingsBtn: S.page === "settings" };
    Object.keys(active).forEach(function (id) {
      var btn = document.getElementById(id);
      if (btn) btn.classList.toggle("active", Boolean(active[id]));
    });
  }

  /**
   * The nesting a spec declares: loops, fan-outs, and the workflows it calls.
   * Read off the spec, so it is true before the run starts as well as during.
   */
  function specShape() {
    var spec = (ST.run && ST.run.effectiveSpec && ST.run.effectiveSpec()) || S.spec;
    if (!spec || !spec.phases) return [];
    var loops = 0, fanouts = 0, calls = {};
    spec.phases.forEach(function (p) {
      (p.steps || []).forEach(function (st) {
        if (st.loopTo) loops += 1;
        if (st.forEach) fanouts += 1;
        if (st.kind === "workflow" && st.workflow) calls[st.workflow] = true;
      });
    });
    var bits = [];
    if (loops) bits.push("· " + loops + " loop" + (loops === 1 ? "" : "s"));
    if (fanouts) bits.push("· " + fanouts + " fan-out" + (fanouts === 1 ? "" : "s"));
    var named = Object.keys(calls);
    if (named.length) {
      bits.push("· calls " + (named.length > 2 ? named.length + " workflows" : named.join(", ")));
    }
    return bits;
  }

  function renderSourceLine() {
    var line = document.getElementById("srcLine");
    clear(line);
    line.style.display = "flex";
    line.appendChild(h("span", { class: "src", text: S.source || "unknown" }));
    var counts = S.spec ? S.spec.phases.length + " phase" + (S.spec.phases.length === 1 ? "" : "s") : "";
    if (counts) line.appendChild(h("span", { text: counts }));
    // What kinds of nesting this workflow actually has — the header line 6a
    // reads "7 phases · 1 loop · calls babysit-pr". Each clause is omitted when
    // the spec has no such thing.
    specShape().forEach(function (bit) { line.appendChild(h("span", { text: bit })); });
    if (!isReadOnly() && S.source !== "user" && S.source !== "project") {
      line.appendChild(h("span", { text: "· configuring saves a user copy" }));
    }
    document.getElementById("wfActions").style.display = isReadOnly() ? "none" : "flex";
    document.getElementById("deleteBtn").style.display =
      (!isReadOnly() && (S.source === "user" || S.source === "project")) ? "block" : "none";
  }

  ST.shell = {
    render: render,
    renderBlockedRow: renderBlockedRow,
    launchBlocked: launchBlocked,
    renderCrumbs: renderCrumbs,
    renderHealth: renderHealth,
    renderLiveRuns: renderLiveRuns,
    renderSidebar: renderSidebar,
    renderSourceLine: renderSourceLine,
  };
})(window.Steamtrain);
