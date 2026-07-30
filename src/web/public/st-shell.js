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
      type: "button",
      onClick: function () { selectWorkflow(w.name); }
    });
    row.appendChild(h("span", { class: "name", text: w.name }));
    if (allReadOnly(w.permissions)) {
      row.appendChild(h("span", { class: "lock", text: "🔒", title: "every agent step read-only" }));
    }
    row.appendChild(h("span", { class: "counts", text: w.phaseCount + "·" + w.stepCount }));
    return row;
  }

  function groupHeading(source, count) {
    var label = source === "project" ? "Project" : source === "user" ? "User" : "Workflows";
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
    // groupWorkflowsBySource orders project, user, bundled (folder-panel
    // convention); the rail wants bundled first with no heading, so re-rank.
    var RAIL_ORDER = { bundled: 0, user: 1, project: 2 };
    var groups = groupWorkflowsBySource(S.workflows).slice().sort(function (a, b) {
      return RAIL_ORDER[a.source] - RAIL_ORDER[b.source];
    });
    if (count) count.textContent = String(S.workflows.length);
    // Bundled workflows sit directly under the "Workflows" rail head with no
    // extra heading; user and project workflows each get their own group.
    groups.forEach(function (group) {
      if (group.source !== "bundled") box.appendChild(groupHeading(group.source, group.entries.length));
      group.entries.forEach(function (w) { box.appendChild(workflowRow(w)); });
    });
  }

  /** Rail footer: runs that are elsewhere — detached, or blocked on approval. */
  function renderLiveRuns() {
    ensureRailSkeleton();
    var foot = document.getElementById("railFoot");
    if (!foot) return;
    clear(foot);
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
        h("b", {}, "Needs " + rr.blockedAgents.map(ST.agentUiLabel).join(", ") + " (not ready). "),
        "Run re-routes " + steps + " to " + ST.agentUiLabel(rr.agent) + " · " + (rr.modelName || rr.model) +
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

  /** Bucket agent + API doctor results into ready / needs-auth / absent. */
  function healthCounts(list, apis) {
    var ready = 0, auth = 0, absent = 0;
    (list || []).forEach(function (d) {
      var meta = agentHealthMeta(d.status);
      if (d.status === "ok") ready++;
      else if (meta.loud) auth++;
      else absent++;
    });
    (apis || []).forEach(function (d) {
      var meta = apiHealthMeta(d.status);
      if (d.status === "ok") ready++;
      else if (meta.loud) auth++;
      else absent++;
    });
    return { ready: ready, auth: auth, absent: absent };
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
    if (counts.ready) {
      box.appendChild(healthChip("ready", "ready · " + counts.ready, counts.ready + " agent(s)/API(s) ready"));
    }
    if (counts.auth) {
      box.appendChild(healthChip("auth", "needs auth · " + counts.auth,
        counts.auth + " need sign-in or a valid key"));
    }
    if (counts.absent) {
      box.appendChild(healthChip("absent", "absent · " + counts.absent,
        counts.absent + " not installed or no key set"));
    }
  }

  /** Breadcrumb: project name, then the active config label. */
  function renderCrumbs() {
    var nav = document.getElementById("crumbs");
    if (!nav) return;
    clear(nav);
    var parts = [];
    if (S.project && S.project.name) {
      parts.push({ text: S.project.name, title: S.project.cwd || S.project.displayPath || S.project.name });
    }
    if (S.configLabel) parts.push({ text: "cfg · " + S.configLabel, title: "Active configuration" });
    parts.forEach(function (part, idx) {
      if (idx > 0) nav.appendChild(h("span", { class: "sep", text: "/" }));
      nav.appendChild(h("span", {
        class: idx === parts.length - 1 ? "here" : "",
        title: part.title,
        text: part.text
      }));
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
      line.appendChild(h("span", { text: "· configuring saves a user copy" }));
    }
    document.getElementById("wfActions").style.display = isReadOnly() ? "none" : "flex";
    document.getElementById("deleteBtn").style.display =
      (!isReadOnly() && (S.source === "user" || S.source === "project")) ? "block" : "none";
  }

  ST.shell = {
    render: render,
    renderBlockedRow: renderBlockedRow,
    renderCrumbs: renderCrumbs,
    renderHealth: renderHealth,
    renderLiveRuns: renderLiveRuns,
    renderSidebar: renderSidebar,
    renderSourceLine: renderSourceLine,
  };
})(window.Steamtrain);
