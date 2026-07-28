/**
 * Shell surface: header health chips, the workflow sidebar, live-run rows.
 */
(function (ST) {
  "use strict";
  var S = ST.state;
  var h = ST.h;
  var AUTONOMY_META = ST.AUTONOMY_META;
  var KIND_LABEL = ST.KIND_LABEL;
  var TOUR_NAME = ST.TOUR_NAME;
  var activateWithKeyboard = ST.activateWithKeyboard;
  var agentHealthMeta = ST.agentHealthMeta;
  var apiHealthMeta = ST.apiHealthMeta;
  var attachRun = ST.attachRun;
  var clear = ST.clear;
  var groupWorkflowsBySource = ST.groupWorkflowsBySource;
  var healthChip = ST.healthChip;
  var isCredentialFreeSpec = ST.isCredentialFreeSpec;
  var isLiveAttached = ST.isLiveAttached;
  var isReadOnly = ST.isReadOnly;
  var relTime = ST.relTime;
  var sandboxGlyph = ST.sandboxGlyph;
  var selectWorkflow = ST.selectWorkflow;
  var toggleWorkflowFolder = ST.toggleWorkflowFolder;
  var truncate = ST.truncate;
  var wfListItem = ST.wfListItem;
  var workflowSandboxBadge = ST.workflowSandboxBadge;

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

  function renderSidebar() {
    var box = document.getElementById("wflist");
    clear(box);
    // Pin tour to the top of its folder on Station landing so the door is obvious.
    var list = S.workflows.slice();
    if (S.stationLanding) {
      list.sort(function (a, b) {
        if (a.name === TOUR_NAME) return -1;
        if (b.name === TOUR_NAME) return 1;
        return 0;
      });
    }
    var groups = groupWorkflowsBySource(list);
    // When an Active runs row is attached, that row owns the sidebar
    // selection highlight — not the same-named workflow card/folder.
    var liveAttached = isLiveAttached();
    groups.forEach(function (group) {
      var collapsed = !!S.folderCollapse[group.source];
      var containsSelected = !liveAttached &&
        group.entries.some(function (w) { return w.name === S.selected; });
      var folder = h("div", {
        class: "wf-folder" + (collapsed ? " collapsed" : "") +
          (containsSelected ? " has-sel" : "") + " src-" + group.source
      });
      var head = h("button", {
        class: "wf-folder-head" + (collapsed && containsSelected ? " has-sel" : ""),
        type: "button",
        "aria-expanded": collapsed ? "false" : "true",
        "aria-controls": "wf-folder-body-" + group.source,
        title: collapsed && containsSelected
          ? "Selected workflow is inside this folder — click to expand"
          : undefined,
        onClick: function () { toggleWorkflowFolder(group.source); }
      },
        h("span", { class: "wf-folder-chevron", text: collapsed ? "▸" : "▾" }),
        h("span", { class: "wf-folder-title", text: group.source }),
        h("span", {
          class: "wf-folder-count",
          text: collapsed && containsSelected && S.selected
            ? "contains " + S.selected
            : group.entries.length + " workflow" + (group.entries.length === 1 ? "" : "s")
        })
      );
      folder.appendChild(head);
      var body = h("div", {
        class: "wf-folder-body",
        id: "wf-folder-body-" + group.source,
        hidden: collapsed ? "true" : null
      });
      if (!collapsed) {
        group.entries.forEach(function (w) {
          body.appendChild(renderWorkflowCard(w));
        });
      }
      folder.appendChild(body);
      box.appendChild(folder);
    });
  }

  function renderWorkflowCard(w) {
    var kinds = Object.keys(w.kinds || {}).map(function (k) { return (KIND_LABEL[k] || k) + ":" + w.kinds[k]; }).join(" \u00b7 ");
    var meta = w.phaseCount + " phase" + (w.phaseCount === 1 ? "" : "s") + " \u00b7 " + w.stepCount + " step" + (w.stepCount === 1 ? "" : "s");
    var isStaged = ST.run.workflowHasStaged(S.stagedOverrides[w.name]);
    var autonomy = AUTONOMY_META[w.autonomy] || AUTONOMY_META.autonomous;
    var isTour = w.name === TOUR_NAME;
    // Attached live runs own the `.sel` highlight in Active runs; keep the
    // catalog card unselected so both lists are not highlighted at once.
    var isSelected = S.selected === w.name && !isLiveAttached();
    return h("div", {
      class: "wf" + (isSelected ? " sel" : "") + (isTour && S.stationLanding ? " station" : ""),
      role: "button",
      tabindex: "0",
      "aria-current": isSelected ? "true" : null,
      "aria-label": "Open workflow " + w.name,
      onClick: function () { selectWorkflow(w.name); },
      onKeydown: function (event) {
        activateWithKeyboard(event, function () { selectWorkflow(w.name); });
      }
    },
      h("div", { class: "name" }, w.name,
        isTour && S.stationLanding ? h("span", { class: "badge start-here", text: "start here" }) : null,
        h("span", { class: "badge " + autonomy.cls, text: autonomy.badge, title: autonomy.title }),
        workflowSandboxBadge(w),
        isStaged ? h("span", { class: "badge staged", text: "staged" }) : null,
        w.blocked ? h("span", {
          class: "badge " + (w.reroute ? "reroute" : "blocked"),
          text: w.reroute ? "↷ via " + w.reroute.agent : "blocked",
          title: w.blocked
        }) : null),
      w.description ? h("div", { class: "desc", text: w.description }) : null,
      h("div", { class: "meta", text: isTour && S.stationLanding
        ? "zero-cost guided ride \u00b7 no agents"
        : (meta + (kinds ? " \u00b7 " + kinds : "")) }),
      w.permissions && w.permissions.summary
        ? h("div", { class: "meta perms-meta", text: sandboxGlyph(w.permissions) + " sandbox: " + w.permissions.summary })
        : null
    );
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


  ST.shell = {
    renderBlockedRow: renderBlockedRow,
    renderHealth: renderHealth,
    renderLiveRuns: renderLiveRuns,
    renderSidebar: renderSidebar,
    renderSourceLine: renderSourceLine,
  };
})(window.Steamtrain);
