/**
 * Arrival surface: the finished-run page (design 5a).
 *
 * A reader arrives here with one question — what broke, and what can I do
 * about it — so the page is ordered as the answer to it: root cause, then the
 * numbers, then the output that proves it, with the step ledger alongside.
 *
 * Three rules this surface exists to keep:
 *
 *   1. RUN ACTIONS ARE NOT WORKFLOW ACTIONS. The header belongs to the run
 *      (retry, re-run, export); everything that edits or deletes the workflow
 *      hides behind the one `Workflow` menu, and each of its items repeats the
 *      noun it acts on. The cockpit's own workflow buttons are hidden while
 *      this page is up (`body.arrival-mode`), because a `Delete` sitting above
 *      a failed run reads as "delete this run" and is not.
 *   2. FAILED IS NOT SKIPPED. One step broke; the ones after it never started.
 *      The counts, the ledger grouping and the banner all say so — see
 *      `arrivalRootCause`/`isCascadeVictim` in src/workflow/arrival-report.ts,
 *      which is where that distinction is computed from the engine's markers.
 *   3. THE PAGE ENDS IN AN ACTION. The primary button restarts from the
 *      failing step, not from the top, and zeroed tiles say why they are zero
 *      instead of printing `$0`.
 */
(function (ST) {
  "use strict";
  var S = ST.state;
  var h = ST.h;
  var KIND_LABEL = ST.KIND_LABEL;
  var activateWithKeyboard = ST.activateWithKeyboard;
  var announce = ST.announce;
  var copyFix = ST.copyFix;
  var isCredentialFreeSpec = ST.isCredentialFreeSpec;
  var isReadOnly = ST.isReadOnly;
  var pickNextWorkflow = ST.pickNextWorkflow;
  var fmtElapsed = ST.fmtElapsed;
  var fmtTime = ST.fmtTime;
  var fmtTokens = ST.fmtTokens;
  var stepPermissions = ST.stepPermissions;

  /**
   * Leaf results only (fan-out parents are represented by their children), in
   * the order they ran. A loop appends its later passes after the phases that
   * follow it, so phase order would list pass 2 after the run's last step.
   */
  function collectArrivalLeafSteps() {
    var out = [];
    (S.runState.phases || []).forEach(function (p) {
      (p.steps || []).forEach(function (s) {
        if (s.result && !(s.result.childResults && s.result.childResults.length)) out.push(s);
      });
    });
    return out
      .map(function (s, i) { return { s: s, i: i }; })
      .sort(function (a, b) {
        var ta = typeof a.s.startedAt === "number" ? a.s.startedAt : Infinity;
        var tb = typeof b.s.startedAt === "number" ? b.s.startedAt : Infinity;
        return ta === tb ? a.i - b.i : ta - tb;
      })
      .map(function (e) { return e.s; });
  }

  /**
   * A step that stopped only because the run was canceled around it. It did
   * not fail, and blaming it would send the reader to fix a step that is fine.
   * The engine marks these `interrupted`; records from before that marker only
   * carry its "cancelled" label, so that is still matched on a canceled run.
   */
  function isInterrupted(s) {
    var r = s && s.result;
    if (!r || r.ok) return false;
    if (r.interrupted) return true;
    return S.runStatus === "canceled" && /cancel/i.test(r.error || "");
  }

  /**
   * What a leaf cost this run: a cached replay billed nothing (the receipt
   * agrees); its original cost belongs to the run that produced it.
   */
  function runCostUsd(s) {
    return s.cached ? 0 : (s.result && s.result.costUsd) || 0;
  }

  /** True for a step that never started because a dependency broke first. */
  function isBlocked(s) {
    return Boolean(SteamtrainReducer.isCascadeVictim && SteamtrainReducer.isCascadeVictim(s.result));
  }

  /** True for a step that actually executed (as opposed to being skipped or blocked). */
  function didRun(s) {
    return Boolean(s.result) && !s.result.skipped && !isBlocked(s);
  }

  /** N steps that ran read-only, and how many workspace-permission violations were recorded. */
  function computeSandboxStats(leaves) {
    var readOnly = 0, violations = 0;
    leaves.forEach(function (s) {
      var perms = stepPermissions ? stepPermissions(s) : null;
      if (!perms) return;
      if (perms.profile === "read-only") readOnly += 1;
      if (perms.violations && perms.violations.length) violations += perms.violations.length;
    });
    return { readOnly: readOnly, violations: violations };
  }

  /**
   * What became of this run's worktrees, from the server's own look at them —
   * the client cannot tell by itself: a step that finished ok merged nothing,
   * and a run that changed nothing has its worktrees reclaimed as it ends.
   * Fetched once per run, after its terminal status frame: the record is
   * written around then (by another process, for a detached run), so a miss
   * is retried for a while before giving up.
   */
  function loadArrivalWorktrees(runId, force) {
    if (!runId) return;
    if (!S.runStatus && !force) {
      // Should the status frame never come, look anyway after a while rather
      // than sit at "checking…" for good. The marker is cleared whatever the
      // timer finds, so returning to this run later re-arms it.
      if (S.arrivalWorktreesWait !== runId) {
        S.arrivalWorktreesWait = runId;
        setTimeout(function () {
          if (S.arrivalWorktreesWait === runId) S.arrivalWorktreesWait = null;
          var have = S.arrivalWorktrees && S.arrivalWorktrees.runId === runId;
          if (S.runId === runId && !have) loadArrivalWorktrees(runId, true);
        }, 8000);
      }
      return;
    }
    if (S.arrivalWorktrees && S.arrivalWorktrees.runId === runId) return;
    var entry = { runId: runId, pending: true };
    S.arrivalWorktrees = entry;
    var giveUp = function () {
      if (S.arrivalWorktrees !== entry) return;
      S.arrivalWorktrees = { runId: runId, failed: true };
      ST.render();
    };
    // A 404 (record not written yet), a 5xx or a dropped request are all
    // worth another try; anything else (auth, a bad id) will not change.
    var attempt = function (left) {
      var again = function () {
        if (S.arrivalWorktrees !== entry) return;
        if (left > 0) setTimeout(function () { attempt(left - 1); }, 1000);
        else giveUp();
      };
      ST.apiAuth("GET", "/api/history/" + encodeURIComponent(runId) + "/worktrees").then(function (r) {
        if (S.arrivalWorktrees !== entry) return;
        if (r.status === 404 || r.status >= 500) { again(); return; }
        if (r.status !== 200) { giveUp(); return; }
        S.arrivalWorktrees = { runId: runId, sources: r.body.sources || [], harvest: r.body.harvest || null };
        ST.render();
      }).catch(function (err) {
        // apiAuth has already asked the viewer to sign in again; retrying
        // would only raise that prompt ten more times.
        if (err && err.message === "auth required") giveUp();
        else again();
      });
    };
    attempt(10);
  }

  /** Step ids an in-run `merge` step landed (its `from` sources, when it succeeded). */
  function mergedInRun() {
    var spec = (ST.run && ST.run.effectiveSpec && ST.run.effectiveSpec()) || S.spec;
    var from = {};
    ((spec && spec.phases) || []).forEach(function (p) {
      (p.steps || []).forEach(function (st) {
        if (st.kind === "merge" && Array.isArray(st.from)) from[st.id] = st.from;
      });
    });
    var merged = {};
    (S.runState.phases || []).forEach(function (p) {
      (p.steps || []).forEach(function (s) {
        if (from[s.stepId] && s.result && s.result.ok) from[s.stepId].forEach(function (id) { merged[id] = true; });
      });
    });
    return merged;
  }

  /**
   * Distinct worktrees this run left, by what is in them now: work nobody
   * merged yet, work that was merged back, clean ones, and ones already
   * cleaned up. Null until the server has answered.
   */
  function computeWorktreeStats() {
    var wt = S.arrivalWorktrees;
    if (!wt || wt.runId !== S.runId || !wt.sources) return null;
    var merged = mergedInRun();
    ((wt.harvest && wt.harvest.appliedSteps) || []).forEach(function (id) { merged[id] = true; });
    var byRoot = {};
    wt.sources.forEach(function (src) {
      var key = src.root || src.branch || src.stepId;
      var prev = byRoot[key];
      byRoot[key] = {
        merged: Boolean((prev && prev.merged) || merged[src.stepId]),
        exists: src.exists,
        changed: src.exists && src.files && src.files.length > 0
      };
    });
    var stats = { changed: 0, merged: 0, clean: 0, gone: 0 };
    Object.keys(byRoot).forEach(function (k) {
      var t = byRoot[k];
      if (t.merged) stats.merged += 1;
      else if (!t.exists) stats.gone += 1;
      else if (t.changed) stats.changed += 1;
      else stats.clean += 1;
    });
    return stats;
  }

  function plural(n, word) {
    return n + " " + word + (n === 1 ? "" : "s");
  }

  /** The ledger footer's line: every bucket that is not empty. */
  function worktreeFootText(stats) {
    if (!stats) {
      var wt = S.arrivalWorktrees;
      return wt && wt.failed ? "unknown" : "checking…";
    }
    var bits = [];
    if (stats.changed) bits.push(stats.changed + " with changes");
    if (stats.merged) bits.push(stats.merged + " merged back");
    if (stats.clean) bits.push(stats.clean + " clean");
    if (stats.gone) bits.push(stats.gone + " cleaned up");
    return bits.length ? bits.join(" · ") : "none";
  }

  /** Total retry attempts across the run, plus which step ids were retried. */
  function computeRetryStats(leaves) {
    var count = 0, ids = [];
    leaves.forEach(function (s) {
      if (s.attempts && s.attempts > 1) {
        count += s.attempts - 1;
        ids.push(s.stepId);
      }
    });
    return { count: count, ids: ids };
  }

  function arrivalExportFilename() {
    var name = (S.runState && S.runState.name) || S.selected || "run";
    var safe = String(name).replace(/[^a-z0-9_-]+/gi, "-");
    return "steamtrain-" + safe + "-" + Date.now() + ".txt";
  }

  /** Plain-text receipt + per-step ledger, downloaded as a .txt file. */
  function exportArrivalReport(report, headline) {
    var lines = [headline, "", SteamtrainReducer.formatArrivalReceipt(report.receipt), ""];
    collectArrivalLeafSteps().forEach(function (s) {
      var r = s.result || {};
      var bits = [s.stepId, s.status];
      if (typeof r.durationMs === "number") bits.push((r.durationMs / 1000).toFixed(1) + "s");
      if (s.cached) bits.push("cached");
      else if (r.costUsd) bits.push("$" + r.costUsd.toFixed(4));
      lines.push(bits.join(" · "));
    });
    var blob = new Blob([lines.join("\n")], { type: "text/plain" });
    var url = URL.createObjectURL(blob);
    var a = h("a", { href: url, download: arrivalExportFilename() });
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  /**
   * Copy that puts the button's own label back, not a generic "Copy". Goes
   * through the shared copyFix so it keeps the execCommand/select fallback —
   * navigator.clipboard does not exist on a non-secure origin, which is every
   * LAN address this UI is served on that is not localhost.
   */
  function copyButton(label, textOf, cls) {
    var btn = h("button", { class: cls || "btn small", text: label, onClick: function () {
      var text = textOf();
      if (!text) return;
      copyFix(text, btn, null, label);
    } });
    return btn;
  }

  // ---- step lookup -----------------------------------------------------------

  /**
   * `leaves` is always the list renderArrival already walked — every lookup on
   * this page takes it rather than re-collecting, so one render walks the run's
   * steps once instead of once per lookup.
   */
  function findLeaf(leaves, stepId) {
    for (var i = 0; i < leaves.length; i++) {
      if (leaves[i].stepId === stepId) return leaves[i];
    }
    return null;
  }

  /** The step whose output the Output pane is showing. */
  function outputStep(leaves, root, report) {
    var wanted = S.arrivalOutputStep && findLeaf(leaves, S.arrivalOutputStep);
    if (wanted) return wanted;
    if (root) return findLeaf(leaves, root.stepId);
    return (report.heroStepId && findLeaf(leaves, report.heroStepId)) || null;
  }

  function stepBody(s) {
    if (!s) return "";
    var out = s.result && typeof s.result.output === "string" ? s.result.output : "";
    return (out || s.text || "").replace(/\s+$/, "");
  }

  /** The failing command itself, when the spec still declares one for this step. */
  function specCommand(stepId) {
    var spec = (ST.run && ST.run.effectiveSpec && ST.run.effectiveSpec()) || S.spec;
    if (!spec || !spec.phases) return "";
    var baseId = String(stepId).replace(/\[\d+\]$/, "");
    for (var i = 0; i < spec.phases.length; i++) {
      var steps = spec.phases[i].steps || [];
      for (var j = 0; j < steps.length; j++) {
        if (steps[j].id === baseId) return typeof steps[j].cmd === "string" ? steps[j].cmd : "";
      }
    }
    return "";
  }

  // ---- header ----------------------------------------------------------------

  /**
   * The run's own actions. `Retry from <step>` re-runs the failing step and
   * everything downstream of it, seeding the steps that already succeeded from
   * the run record — restarting from the break rather than from the top, which
   * is the whole reason a reader is on this page.
   */
  function renderRunActions(report, root, headline) {
    var actions = h("div", { class: "arrival-actions" });
    var primary = null;
    if (!isReadOnly() && root && S.runId) {
      var resume = root.interrupted || isInterrupted(findLeaf(collectArrivalLeafSteps(), root.stepId));
      primary = h("button", {
        class: "btn primary",
        text: (resume ? "Resume from " : "Retry from ") + root.stepId,
        title: "Re-run " + root.stepId + " and everything after it; steps that already succeeded are reused.",
        onClick: function () { ST.modals.rerunHistory(S.runId, S.selected, "retry"); }
      });
      actions.appendChild(primary);
    }
    if (!isReadOnly()) {
      var again = h("button", {
        class: root ? "btn" : "btn primary",
        text: "Run again",
        onClick: function () { ST.run.startRun(); }
      });
      if (!primary) primary = again;
      actions.appendChild(again);
    }
    actions.appendChild(h("button", {
      class: "btn",
      text: "Export",
      onClick: function () { exportArrivalReport(report, headline); }
    }));
    if (!isReadOnly() && S.selected) {
      actions.appendChild(h("span", { class: "arrival-actions-rule" }));
      actions.appendChild(renderWorkflowMenu());
    }
    return { node: actions, primary: primary };
  }

  /**
   * Everything that acts on the WORKFLOW, behind one button that says so. Each
   * item repeats the noun, and the destructive one states its real blast
   * radius — which is the config file, not the run history: deleting a
   * workflow leaves its recorded runs on disk.
   */
  /**
   * Whether the Workflow menu is open lives on `S`, not in the DOM: #bands is
   * cleared and rebuilt on every render (see the contract note in st-boot.js),
   * so a menu that remembered its own state simply vanished on the next
   * background poll. The dismiss listeners are document-level and are rebound
   * to the current popup on each render, with the previous pair removed first
   * so a rebuilt page cannot leave one behind.
   */
  var menuDismiss = null;

  function bindMenuDismiss(wrap) {
    unbindMenuDismiss();
    var away = function (e) { if (!wrap.contains(e.target)) setMenuOpen(false); };
    var esc = function (e) { if (e.key === "Escape") setMenuOpen(false); };
    document.addEventListener("mousedown", away, true);
    document.addEventListener("keydown", esc, true);
    menuDismiss = { away: away, esc: esc };
  }

  function unbindMenuDismiss() {
    if (!menuDismiss) return;
    document.removeEventListener("mousedown", menuDismiss.away, true);
    document.removeEventListener("keydown", menuDismiss.esc, true);
    menuDismiss = null;
  }

  function setMenuOpen(open) {
    if (!open) unbindMenuDismiss();
    if (S.arrivalMenuOpen === open) return;
    S.arrivalMenuOpen = open;
    ST.render();
  }

  function renderWorkflowMenu() {
    var open = Boolean(S.arrivalMenuOpen);
    var wrap = h("div", { class: "arrival-menu" });
    var btn = h("button", {
      class: "btn", type: "button", "aria-haspopup": "true",
      "aria-expanded": open ? "true" : "false",
      "data-focus-key": "arrival-workflow-menu",
      onClick: function () { setMenuOpen(!S.arrivalMenuOpen); }
    }, "Workflow", h("span", { class: "caret", "aria-hidden": "true", text: "▾" }));
    var menu = h("div", { class: "arrival-menu-pop", role: "menu" });
    menu.hidden = !open;
    var fileLabel = S.source === "project" ? "the project steamtrain.json" : "your user workflows file";
    if (open) bindMenuDismiss(wrap);

    function item(label, onPick, cls) {
      return h("button", {
        class: "arrival-menu-item" + (cls ? " " + cls : ""), type: "button", role: "menuitem",
        text: label,
        onClick: function () { setMenuOpen(false); onPick(); }
      });
    }
    menu.appendChild(h("div", { class: "arrival-menu-head", text: "Workflow " + S.selected }));
    menu.appendChild(item("Configure workflow", function () { ST.modals.openEditor(false); }));
    menu.appendChild(item("Clone workflow", function () { ST.modals.openEditor(true); }));
    menu.appendChild(item("Open workflow source", function () { openPlan("source", null); }));
    if (S.source === "user" || S.source === "project") {
      menu.appendChild(h("div", { class: "arrival-menu-rule" }));
      menu.appendChild(item("Delete workflow from " + fileLabel + "…", function () {
        ST.modals.doDelete();
      }, "danger"));
    }
    wrap.appendChild(btn);
    wrap.appendChild(menu);
    return wrap;
  }

  /**
   * Leave the finished run for the plan editor, optionally on a given tab with
   * a step selected. Re-selecting the workflow is what detaches the run, so the
   * plan can own the centre pane again.
   */
  function openPlan(tab, stepId) {
    var name = S.selected;
    if (!name) return;
    ST.selectWorkflow(name, function () {
      S.planTab = tab || "plan";
      if (stepId && ST.plan && ST.plan.selectStep) ST.plan.selectStep(String(stepId).replace(/\[\d+\]$/, ""));
      ST.render();
    });
  }

  /**
   * The run's own verdict. The steps alone cannot say it: a canceled run's
   * interrupted step reads as a failure, and a budget stop has no failed step.
   */
  function arrivalState(report) {
    if (S.runStatus === "canceled") return { text: "canceled", cls: " stopped" };
    if (S.runStatus === "timed-out") return { text: "timed out", cls: " failed" };
    if (S.runStatus === "budget-exceeded") return { text: "budget reached", cls: " failed" };
    if (S.runStatus === "error") return { text: "failed", cls: " failed" };
    // The final status frame lands just after the last event: until then a
    // run whose only casualties were interrupted is "stopped", not failed.
    if (!S.runStatus && !report.receipt.ok && !report.receipt.failCount && report.receipt.interruptedCount) {
      return { text: "stopped", cls: " stopped" };
    }
    return report.receipt.ok ? { text: "complete", cls: "" } : { text: "failed", cls: " failed" };
  }

  function renderHead(report, root, headline) {
    var state = arrivalState(report);
    var head = h("div", { class: "arrival-head" });
    var top = h("div", { class: "arrival-idline" });
    // Same 5-char stem the breadcrumb and the runs rail use: the full uuid is
    // 36 characters and would push the run's own actions off the strip.
    top.appendChild(h("span", {
      class: "run-id",
      title: S.runId || "",
      text: S.runId ? "Run " + S.runId.slice(0, 5) : (S.runState.name || S.selected || "Run")
    }));
    top.appendChild(h("span", { class: "arrival-state" + state.cls, text: state.text }));
    var actions = renderRunActions(report, root, headline);
    top.appendChild(actions.node);
    head.appendChild(top);

    var meta = h("div", { class: "arrival-meta" });
    if (S.startedAt) meta.appendChild(h("span", { text: fmtTime(S.startedAt) }));
    var ran = fmtElapsed(report.receipt.durationMs);
    if (ran) meta.appendChild(h("span", { text: "ran " + ran }));
    if (S.selected) {
      meta.appendChild(h("span", null,
        "workflow ",
        h("button", {
          class: "linkish", type: "button", text: S.selected,
          title: "Open this workflow's plan",
          onClick: function () { openPlan("plan", null); }
        })
      ));
    }
    head.appendChild(meta);
    return { node: head, primary: actions.primary };
  }

  // ---- root cause ------------------------------------------------------------

  function renderRootCause(root, leaves) {
    var interrupted = root.interrupted || isInterrupted(findLeaf(leaves, root.stepId));
    var box = h("div", { class: "rootcause" + (interrupted ? " interrupted" : "") });
    var what = interrupted
      ? h("span", { class: "what" },
        "Run canceled while ",
        h("code", { text: root.stepId }),
        root.blockKind === "approval" || root.blockKind === "human" ? " waited for a decision" : " was running")
      : h("span", { class: "what" },
        "Step ",
        h("code", { text: root.stepId }),
        " " + (root.killed ? "was killed" : "failed") + ": " + root.error);
    var title = h("div", { class: "rootcause-head" },
      h("span", { class: "kicker", text: root.killed || interrupted ? "Stopped here" : "Root cause" }),
      what
    );
    var where = ["phase " + root.phaseNumber, KIND_LABEL[root.blockKind] || root.blockKind];
    if (typeof root.durationMs === "number") where.push("after " + fmtElapsed(root.durationMs));
    title.appendChild(h("span", { class: "where", text: where.join(" · ") }));
    box.appendChild(title);

    var cmd = specCommand(root.stepId);
    var step = findLeaf(leaves, root.stepId);
    var evidence = [];
    if (cmd) evidence.push("$ " + cmd);
    // The last few lines of the step's own output are what actually explains
    // the exit code; the whole thing lives in the Output pane below.
    var tail = stepBody(step).split("\n").slice(-4).join("\n").trim();
    if (tail) evidence.push(tail);
    if (evidence.length) box.appendChild(h("pre", { class: "rootcause-evidence", text: evidence.join("\n") }));

    var foot = h("div", { class: "rootcause-foot" });
    if (root.blocked.length) {
      var line = h("span", { class: "blocked", text: "Everything after it was skipped, not run: " });
      root.blocked.forEach(function (id, i) {
        if (i > 0) line.appendChild(document.createTextNode(", "));
        line.appendChild(h("code", { text: id }));
      });
      line.appendChild(document.createTextNode("."));
      foot.appendChild(line);
    }
    var btns = h("span", { class: "rootcause-btns" });
    btns.appendChild(copyButton("Copy error", function () {
      return [root.stepId + ": " + root.error].concat(evidence).join("\n");
    }));
    if (!isReadOnly()) {
      btns.appendChild(h("button", {
        class: "btn small", text: "Edit this step",
        title: "Open this step in the plan editor",
        onClick: function () { openPlan("plan", root.stepId); }
      }));
    }
    foot.appendChild(btns);
    box.appendChild(foot);
    return box;
  }

  // ---- tiles -----------------------------------------------------------------

  /** Four facts, and a sentence wherever the number would be a bare zero. */
  function renderTiles(report, leaves, worktrees) {
    var r = report.receipt;
    var tiles = h("div", { class: "arrival-tiles" });
    function tile(label, value) {
      var el = h("div", { class: "tile" }, h("div", { class: "k", text: label }));
      el.appendChild(value);
      return el;
    }
    tiles.appendChild(tile("Elapsed", h("div", { class: "v", text: fmtElapsed(r.durationMs) || "0.0s" })));

    var steps = h("div", { class: "v" }, h("span", { class: "ok", text: r.okCount + " ok" }));
    // The report already keeps marked interruptions out of failCount; a record
    // from before the marker is caught by isInterrupted's text fallback.
    var legacy = leaves.filter(function (s) { return isInterrupted(s) && !s.result.interrupted; }).length;
    var interrupted = (r.interruptedCount || 0) + legacy;
    var failed = Math.max(0, r.failCount - legacy);
    if (failed) {
      steps.appendChild(h("span", { class: "sep", text: " · " }));
      steps.appendChild(h("span", { class: "bad", text: failed + " failed" }));
    }
    if (interrupted) {
      steps.appendChild(h("span", { class: "sep", text: " · " }));
      steps.appendChild(h("span", { class: "faint", text: interrupted + " interrupted" }));
    }
    var notRun = (r.skipCount || 0) + (r.blockedCount || 0);
    if (notRun) {
      steps.appendChild(h("span", { class: "sep", text: " · " }));
      steps.appendChild(h("span", { class: "faint", text: notRun + " skipped" }));
    }
    tiles.appendChild(tile("Steps", steps));

    tiles.appendChild(tile("Model spend", spendValue(r, leaves)));

    var left = h("div", { class: "v" });
    if (!worktrees) {
      left.className = "v note";
      left.textContent = worktreeFootText(null);
    } else if (worktrees.changed > 0) {
      left.appendChild(document.createTextNode(plural(worktrees.changed, "worktree") + " with changes "));
      left.appendChild(h("button", {
        class: "linkish", type: "button", text: "review",
        title: "Open this run's receipt, where its worktrees can be applied or pruned",
        onClick: function () { ST.runs.open(S.runId); }
      }));
    } else {
      left.className = "v note";
      left.textContent = worktrees.merged > 0
        ? "nothing — " + worktrees.merged + " merged back"
        : "nothing";
    }
    tiles.appendChild(tile("Left behind", left));
    return tiles;
  }

  /**
   * Spend, or the reason it is zero. A bare `$0` on a run that never reached an
   * agent reads as "this was free", and a Claude run that has tokens but no
   * price yet is not free either — it is unpriced (that CLI only bills at the
   * end), so say which. An agent that reports no cost (Cursor, Amp) or no
   * usage at all (Antigravity, Kiro) is "not reported", as on the receipt.
   */
  function spendValue(r, leaves) {
    if (r.costUsd > 0) {
      var v = h("div", { class: "v", text: "$" + r.costUsd.toFixed(4) });
      if (r.tokens > 0) v.appendChild(h("span", { class: "sub", text: " · " + fmtTokens(r.tokens) + " tok" }));
      return v;
    }
    if (r.tokens > 0) {
      return h("div", { class: "v" },
        h("span", { text: fmtTokens(r.tokens) + " tok" }),
        h("span", { class: "sub", text: r.costReported === false ? " · cost not reported" : " · not priced yet" })
      );
    }
    var reachedAgent = leaves.some(function (s) { return didRun(s) && (s.agent || s.api); });
    if (!reachedAgent) return h("div", { class: "v note", text: "none — no agent step ran" });
    if (r.costReported === false) {
      return h("div", { class: "v note", text: r.tokensReported === false ? "not reported" : "cost not reported" });
    }
    return h("div", { class: "v note", text: "$0 — nothing billed" });
  }

  // ---- output ----------------------------------------------------------------

  /**
   * The output of one step, filling the space a finished run used to leave
   * empty. Defaults to the failing step; any ledger row swaps it.
   */
  function renderOutput(step) {
    var body = stepBody(step);
    var lines = body ? body.split("\n").length : 0;
    var wrap = h("div", { class: "arrival-output" });
    var head = h("div", { class: "arrival-output-head" },
      h("span", { class: "k", text: "Output" }),
      h("span", { class: "who", text: step ? step.stepId : "—" }),
      h("span", { class: "meta", text: body ? "stdout + stderr · " + lines + " line" + (lines === 1 ? "" : "s") : "nothing captured" })
    );
    var btns = h("span", { class: "arrival-output-btns" });
    btns.appendChild(h("button", {
      class: "btn small" + (S.outputNoWrap ? " active" : ""),
      text: S.outputNoWrap ? "Wrap" : "No wrap",
      onClick: function () { S.outputNoWrap = !S.outputNoWrap; ST.render(); }
    }));
    btns.appendChild(copyButton("Copy", function () { return body; }));
    head.appendChild(btns);
    wrap.appendChild(head);
    wrap.appendChild(h("pre", {
      class: "arrival-output-body" + (S.outputNoWrap ? " nowrap" : ""),
      "data-key": "arrival-output",
      text: body || "This step produced no output."
    }));
    return wrap;
  }

  // ---- ledger ----------------------------------------------------------------

  function selectOutput(stepId) {
    S.arrivalOutputStep = stepId;
    ST.render();
  }

  function ledgerRow(s, opts) {
    var selected = opts.selectedId === s.stepId;
    var cols = opts.showCost ? " has-cost" : (opts.showTime ? " has-time" : "");
    var row = h("div", {
      class: "ledger-row" + cols + (opts.cls ? " " + opts.cls : "") + (selected ? " selected" : ""),
      role: "button", tabindex: "0",
      "data-focus-key": "arrival-step:" + s.stepId,
      title: "Show this step's output",
      onClick: function () { selectOutput(s.stepId); },
      onKeydown: function (e) { activateWithKeyboard(e, function () { selectOutput(s.stepId); }); }
    });
    row.appendChild(h("span", { class: "dot" }));
    var mid = h("div", { class: "who" },
      h("div", { class: "id", text: s.stepId }),
      h("div", { class: "sub", text: opts.sub })
    );
    row.appendChild(mid);
    if (opts.showTime) {
      var r = s.result || {};
      row.appendChild(h("span", {
        class: "num",
        text: typeof r.durationMs === "number" ? fmtElapsed(r.durationMs) : ""
      }));
    }
    if (opts.showCost) {
      row.appendChild(h("span", {
        class: "num",
        text: runCostUsd(s) ? "$" + runCostUsd(s).toFixed(4) : ""
      }));
    }
    return row;
  }

  /**
   * Steps that ran, then — under their own header — the ones that never
   * started and why. A blocked step has no duration and no cost to show, so it
   * lays out without those columns rather than dashing them out.
   */
  function renderLedger(leaves, selectedId, showCost) {
    var ran = leaves.filter(didRun);
    var ledger = h("div", { class: "ledger" });
    ledger.appendChild(h("div", { class: "ledger-head" },
      h("span", { text: "Steps" }),
      h("span", { class: "count", text: ran.length + " of " + leaves.length + " ran" })
    ));
    var rows = h("div", { class: "ledger-rows" });
    ran.forEach(function (s) {
      var kind = KIND_LABEL[s.blockKind] || s.blockKind || "step";
      var r = s.result || {};
      var cut = isInterrupted(s);
      var bad = !r.ok && !cut;
      var outcome = r.ok
        ? (s.cached ? "reused a cached result" : "succeeded")
        : cut
          ? "interrupted — run canceled"
          : ((r.error || "failed").split("\n", 1)[0] || "failed");
      rows.appendChild(ledgerRow(s, {
        cls: bad ? "failed" : "",
        sub: kind + " · " + outcome,
        selectedId: selectedId,
        showTime: true,
        showCost: showCost
      }));
    });
    var stalled = leaves.filter(function (s) { return !didRun(s); });
    if (stalled.length) {
      rows.appendChild(h("div", { class: "ledger-group", text: "Never started — " + stalled.length + " step" + (stalled.length === 1 ? "" : "s") }));
      stalled.forEach(function (s) {
        var kind = KIND_LABEL[s.blockKind] || s.blockKind || "step";
        var why = isBlocked(s)
          ? "blocked by " + ((s.result && s.result.dependencyFailed) || "an earlier step")
          : "its condition was false";
        rows.appendChild(ledgerRow(s, {
          cls: "stalled",
          sub: kind + " · " + why,
          selectedId: selectedId,
          showTime: false,
          showCost: false
        }));
      });
    }
    ledger.appendChild(rows);
    return ledger;
  }

  // ---- page ------------------------------------------------------------------

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
    var root = SteamtrainReducer.arrivalRootCause
      ? SteamtrainReducer.arrivalRootCause(S.runState)
      : null;
    var enter = S.arrivalEnter;
    if (enter) S.arrivalEnter = false;

    var leaves = collectArrivalLeafSteps();
    var wrap = h("div", { class: "arrival" });

    // ---- left column: the diagnosis ----------------------------------------
    var main = h("div", { class: "arrival-main" });
    var head = renderHead(report, root, headline);
    main.appendChild(head.node);

    var body = h("div", { class: "arrival-body" });
    if (root) body.appendChild(renderRootCause(root, leaves));
    loadArrivalWorktrees(S.runId);
    var worktrees = computeWorktreeStats();
    body.appendChild(renderTiles(report, leaves, worktrees));

    // Whatever the banner and the ledger have not already said: retries, gates
    // that did not pass, condition-skips — and, on a clean run, the receipt.
    body.appendChild(renderNotes(report, root));

    var shown = outputStep(leaves, root, report);
    body.appendChild(renderOutput(shown));
    main.appendChild(body);
    wrap.appendChild(main);

    // ---- right column: step ledger ------------------------------------------
    var showCost = leaves.some(function (s) { return runCostUsd(s) > 0; });
    var ledger = renderLedger(leaves, shown ? shown.stepId : null, showCost);

    var foot = h("div", { class: "ledger-foot" });
    function footRow(label, value) {
      return h("div", { class: "row" }, h("span", { text: label }), h("span", { class: "v", text: value }));
    }
    var sandbox = computeSandboxStats(leaves);
    foot.appendChild(footRow("sandbox", sandbox.readOnly + " read-only · " + sandbox.violations + " violations"));
    foot.appendChild(footRow("worktrees", worktreeFootText(worktrees)));
    var retries = computeRetryStats(leaves);
    foot.appendChild(footRow("retries", retries.count + (retries.ids.length === 1 ? " (" + retries.ids[0] + ")" : "")));
    ledger.appendChild(foot);

    wrap.appendChild(ledger);
    canvas.appendChild(wrap);

    if (enter) {
      announce(headline);
      if (head.primary && !S.arrivalCtaFocused) {
        S.arrivalCtaFocused = true;
        requestAnimationFrame(function () {
          try { head.primary.focus({ preventScroll: true }); } catch (e) { head.primary.focus(); }
        });
      }
    }
    return true;
  }

  /**
   * The notices the page has not already shown. The root failure and its
   * cascade victims are dropped: the banner names the first and the ledger
   * groups the rest, and repeating them here is what used to make one broken
   * step look like four. A clean run has no notices at all, so it gets the
   * receipt cards instead.
   */
  function renderNotes(report, root) {
    var box = h("div", { class: "arrival-report" });
    var interrupted = {};
    collectArrivalLeafSteps().forEach(function (s) { if (isInterrupted(s)) interrupted[s.stepId] = true; });
    var notices = (report.notices || []).filter(function (n) {
      if (root && n.stepId === root.stepId) return false;
      if (interrupted[n.stepId]) return false;
      return !(root && root.blocked.indexOf(n.stepId) !== -1);
    });
    if (notices.length) {
      box.appendChild(h("div", { class: "arrival-report-head" },
        h("div", { class: "src", text: root ? "Also worth knowing" : "What happened" }),
        h("div", { class: "rule" })
      ));
      notices.slice(0, 6).forEach(function (n) {
        var row = h("div", { class: "finding" },
          h("div", { class: "sev " + n.severity, text: n.severity }),
          h("div", { class: "what", text: n.what })
        );
        if (n.where) row.appendChild(h("div", { class: "where", text: n.where }));
        box.appendChild(row);
      });
      if (notices.length > 6) {
        box.appendChild(h("div", { class: "finding" },
          h("div", { class: "sev" }),
          h("div", { class: "where", text: (notices.length - 6) + " more in the step ledger" })
        ));
      }
      return box;
    }
    if (root) return box;
    // Clean run: cards (what ran / what it cost / what it produced) are facts,
    // not problems, so they carry no severity of their own -- the narrow column
    // holds the card's short label instead. Do not map these onto
    // critical/high/medium: a run with nothing wrong has no severities, and
    // inventing them is exactly the lie the notice list above avoids.
    var cards = SteamtrainReducer.arrivalReceiptCards
      ? SteamtrainReducer.arrivalReceiptCards(report.receipt)
      : [];
    if (!cards.length) return box;
    box.appendChild(h("div", { class: "arrival-report-head" },
      h("div", { class: "src", text: "What happened" }),
      h("div", { class: "rule" })
    ));
    cards.forEach(function (c) {
      box.appendChild(h("div", { class: "finding" },
        h("div", { class: "sev", text: (c.id || "").toUpperCase() }),
        h("div", { class: "what", text: c.value })
      ));
    });
    return box;
  }

  /** The page is no longer up: drop its popup and the listeners it installed. */
  function leaveArrival() {
    unbindMenuDismiss();
    S.arrivalMenuOpen = false;
  }

  ST.arrival = {
    renderArrival: renderArrival,
    leave: leaveArrival,
  };
})(window.Steamtrain);
