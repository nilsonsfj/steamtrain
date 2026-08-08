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
  var isCredentialFreeSpec = ST.isCredentialFreeSpec;
  var isReadOnly = ST.isReadOnly;
  var pickNextWorkflow = ST.pickNextWorkflow;
  var fmtElapsed = ST.fmtElapsed;
  var fmtTime = ST.fmtTime;
  var fmtTokens = ST.fmtTokens;
  var stepPermissions = ST.stepPermissions;

  /** Leaf results only (fan-out parents are represented by their children). */
  function collectArrivalLeafSteps() {
    var out = [];
    (S.runState.phases || []).forEach(function (p) {
      (p.steps || []).forEach(function (s) {
        if (s.result && !(s.result.childResults && s.result.childResults.length)) out.push(s);
      });
    });
    return out;
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
   * Distinct worktrees this run touched, split into merged back (their owning
   * step finished ok) vs left behind (the step errored, so nothing merged
   * its work). The client has no direct "was this branch merged" signal, so
   * this uses the owning step's own outcome as the closest available proxy.
   */
  function computeWorktreeStats(leaves) {
    var seen = {};
    var merged = 0, left = 0;
    leaves.forEach(function (s) {
      if (!s.worktree || !s.worktree.branch || seen[s.worktree.branch]) return;
      seen[s.worktree.branch] = true;
      if (s.status === "done" && s.result && s.result.ok) merged += 1;
      else left += 1;
    });
    return { merged: merged, left: left };
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
      if (r.costUsd) bits.push("$" + r.costUsd.toFixed(4));
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

  /** Copy that puts the button's own label back, not a generic "Copy". */
  function copyButton(label, textOf, cls) {
    var btn = h("button", { class: cls || "btn small", text: label, onClick: function () {
      var text = textOf();
      if (!text) return;
      var done = function () {
        btn.textContent = "Copied";
        btn.classList.add("copied");
        setTimeout(function () { btn.textContent = label; btn.classList.remove("copied"); }, 1400);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done).catch(function () {});
      }
    } });
    return btn;
  }

  // ---- step lookup -----------------------------------------------------------

  function findLeaf(stepId) {
    var match = null;
    collectArrivalLeafSteps().forEach(function (s) {
      if (!match && s.stepId === stepId) match = s;
    });
    return match;
  }

  /** The step whose output the Output pane is showing. */
  function outputStep(root, report) {
    var wanted = S.arrivalOutputStep && findLeaf(S.arrivalOutputStep);
    if (wanted) return wanted;
    if (root) return findLeaf(root.stepId);
    return (report.heroStepId && findLeaf(report.heroStepId)) || null;
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
      primary = h("button", {
        class: "btn primary",
        text: "Retry from " + root.stepId,
        title: "Re-run " + root.stepId + " and everything it blocked; steps that already succeeded are reused.",
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

  function renderHead(report, root, headline) {
    var failed = !report.receipt.ok;
    var head = h("div", { class: "arrival-head" });
    var top = h("div", { class: "arrival-idline" });
    // Same 5-char stem the breadcrumb and the runs rail use: the full uuid is
    // 36 characters and would push the run's own actions off the strip.
    top.appendChild(h("span", {
      class: "run-id",
      title: S.runId || "",
      text: S.runId ? "Run " + S.runId.slice(0, 5) : (S.runState.name || S.selected || "Run")
    }));
    top.appendChild(h("span", {
      class: "arrival-state" + (failed ? " failed" : ""),
      text: failed ? "failed" : "complete"
    }));
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

  function renderRootCause(root) {
    var box = h("div", { class: "rootcause" });
    var title = h("div", { class: "rootcause-head" },
      h("span", { class: "kicker", text: root.killed ? "Stopped here" : "Root cause" }),
      h("span", { class: "what" },
        "Step ",
        h("code", { text: root.stepId }),
        " " + (root.killed ? "was killed" : "failed") + ": " + root.error
      )
    );
    var where = ["phase " + root.phaseNumber, KIND_LABEL[root.blockKind] || root.blockKind];
    if (typeof root.durationMs === "number") where.push("after " + fmtElapsed(root.durationMs));
    title.appendChild(h("span", { class: "where", text: where.join(" · ") }));
    box.appendChild(title);

    var cmd = specCommand(root.stepId);
    var step = findLeaf(root.stepId);
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
    if (r.failCount) {
      steps.appendChild(h("span", { class: "sep", text: " · " }));
      steps.appendChild(h("span", { class: "bad", text: r.failCount + " failed" }));
    }
    var notRun = (r.skipCount || 0) + (r.blockedCount || 0);
    if (notRun) {
      steps.appendChild(h("span", { class: "sep", text: " · " }));
      steps.appendChild(h("span", { class: "faint", text: notRun + " skipped" }));
    }
    tiles.appendChild(tile("Steps", steps));

    tiles.appendChild(tile("Model spend", spendValue(r, leaves)));

    var left = h("div", { class: "v" });
    if (worktrees.left > 0) {
      left.appendChild(document.createTextNode(worktrees.left + " worktree" + (worktrees.left === 1 ? "" : "s") + " "));
      left.appendChild(h("button", {
        class: "linkish", type: "button", text: "clean up",
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
   * end), so say which.
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
        h("span", { class: "sub", text: " · not priced yet" })
      );
    }
    var reachedAgent = leaves.some(function (s) { return didRun(s) && (s.agent || s.api); });
    return h("div", { class: "v note", text: reachedAgent ? "$0 — nothing billed" : "none — no agent step ran" });
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
        text: s.result && s.result.costUsd ? "$" + s.result.costUsd.toFixed(4) : ""
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
      var bad = !r.ok;
      var outcome = r.ok
        ? (s.cached ? "reused a cached result" : "succeeded")
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
    if (root) body.appendChild(renderRootCause(root));
    var worktrees = computeWorktreeStats(leaves);
    body.appendChild(renderTiles(report, leaves, worktrees));

    // Whatever the banner and the ledger have not already said: retries, gates
    // that did not pass, condition-skips — and, on a clean run, the receipt.
    body.appendChild(renderNotes(report, root));

    var shown = outputStep(root, report);
    body.appendChild(renderOutput(shown));
    main.appendChild(body);
    wrap.appendChild(main);

    // ---- right column: step ledger ------------------------------------------
    var showCost = leaves.some(function (s) { return s.result && s.result.costUsd; });
    var ledger = renderLedger(leaves, shown ? shown.stepId : null, showCost);

    var foot = h("div", { class: "ledger-foot" });
    function footRow(label, value) {
      return h("div", { class: "row" }, h("span", { text: label }), h("span", { class: "v", text: value }));
    }
    var sandbox = computeSandboxStats(leaves);
    foot.appendChild(footRow("sandbox", sandbox.readOnly + " read-only · " + sandbox.violations + " violations"));
    foot.appendChild(footRow("worktrees", worktrees.merged + " merged back · " + worktrees.left + " left"));
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
    var notices = (report.notices || []).filter(function (n) {
      if (root && n.stepId === root.stepId) return false;
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
    render: renderArrival,
    renderArrival: renderArrival,
    leave: leaveArrival,
  };
})(window.Steamtrain);
