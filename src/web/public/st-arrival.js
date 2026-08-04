/**
 * Arrival surface: the two-column report + step ledger shown once a run
 * finishes.
 */
(function (ST) {
  "use strict";
  var S = ST.state;
  var h = ST.h;
  var KIND_LABEL = ST.KIND_LABEL;
  var announce = ST.announce;
  var friendlyStepLabel = ST.friendlyStepLabel;
  var isCredentialFreeSpec = ST.isCredentialFreeSpec;
  var isReadOnly = ST.isReadOnly;
  var pickNextWorkflow = ST.pickNextWorkflow;
  var workflowNeedsCredentials = ST.workflowNeedsCredentials;
  var fmtElapsed = ST.fmtElapsed;
  var fmtTime = ST.fmtTime;
  var fmtTokens = ST.fmtTokens;
  var stepPermissions = ST.stepPermissions;

  // ---- Arrival: the two-column report + step ledger ----------------------
  // Replaces the centre pane once a run finishes (S.runState.done). Left
  // column is the scrolling report; right column is the scrolling step
  // ledger -- the two scroll independently so totals never scroll away from
  // the results that explain them (the problem this surface exists to fix).

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
    var enter = S.arrivalEnter;
    if (enter) S.arrivalEnter = false;

    var wrap = h("div", { class: "arrival" });

    // ---- left column: report -----------------------------------------------
    var main = h("div", { class: "arrival-main" });
    var head = h("div", { class: "arrival-head" });
    head.appendChild(h("div", { class: "arrival-kicker" },
      h("span", {
        class: "state" + (report.receipt.ok ? "" : " failed"),
        text: report.receipt.ok ? "Complete" : "Failed"
      }),
      h("span", { class: "when", text: fmtTime(S.endedAt || Date.now()) })
    ));
    head.appendChild(h("div", { class: "arrival-headline", text: headline }));

    var stats = h("div", { class: "arrival-stats" });
    function statCell(k, v) {
      return h("div", null, h("div", { class: "k", text: k }), h("div", { class: "v", text: v }));
    }
    stats.appendChild(statCell("Elapsed", fmtElapsed(report.receipt.durationMs) || "0.0s"));
    stats.appendChild(h("div", { class: "rule" }));
    stats.appendChild(statCell("Cost", report.receipt.agentless || !(report.receipt.costUsd > 0)
      ? "$0"
      : "$" + report.receipt.costUsd.toFixed(4)));
    stats.appendChild(h("div", { class: "rule" }));
    stats.appendChild(statCell("Tokens", report.receipt.tokens > 0 ? fmtTokens(report.receipt.tokens) + " tok" : "0"));
    stats.appendChild(h("div", { class: "rule" }));
    stats.appendChild(statCell("Steps", report.receipt.okCount + " ok" +
      (report.receipt.failCount ? " · " + report.receipt.failCount + " failed" : "")));
    var actions = h("div", { class: "actions" });
    var runAgainBtn = null;
    if (!isReadOnly()) {
      runAgainBtn = h("button", {
        class: "btn primary",
        text: "Run again",
        onClick: function () { ST.run.startRun(); }
      });
      actions.appendChild(runAgainBtn);
    }
    actions.appendChild(h("button", {
      class: "btn",
      text: "Export",
      onClick: function () { exportArrivalReport(report, headline); }
    }));
    stats.appendChild(actions);
    head.appendChild(stats);
    main.appendChild(head);

    var reportBody = h("div", { class: "arrival-report" });
    reportBody.appendChild(h("div", { class: "arrival-report-head" },
      h("div", { class: "rule" }),
      h("div", { class: "src", text: S.runState.name || S.selected || "" })
    ));
    // Severity-labelled notices (design 02) when the run has something to
    // report, the receipt cards when it does not. The labels rank RUN
    // OUTCOMES, not findings from an agent's report — see ArrivalNotice in
    // src/workflow/arrival-report.ts for why that distinction is load-bearing.
    var notices = report.notices || [];
    var cards = notices.length || !SteamtrainReducer.arrivalReceiptCards
      ? []
      : SteamtrainReducer.arrivalReceiptCards(report.receipt);
    if (notices.length) {
      notices.slice(0, 6).forEach(function (n) {
        var row = h("div", { class: "finding" },
          h("div", { class: "sev " + n.severity, text: n.severity }),
          h("div", { class: "what", text: n.what })
        );
        if (n.where) row.appendChild(h("div", { class: "where", text: n.where }));
        reportBody.appendChild(row);
      });
      if (notices.length > 6) {
        reportBody.appendChild(h("div", { class: "finding" },
          h("div", { class: "sev" }),
          h("div", { class: "where", text: (notices.length - 6) + " more in the step ledger" })
        ));
      }
    } else if (cards.length) {
      // The clean-run fallback: cards (what ran / what it cost / what it
      // produced) are facts, not problems, so they carry no severity of their
      // own -- the narrow column holds the card's short label instead and every
      // row keeps the default .sev colour. Do not map these onto
      // critical/high/medium: a run with nothing wrong has no severities, and
      // inventing them is exactly the lie the notice list above avoids.
      cards.forEach(function (c) {
        reportBody.appendChild(h("div", { class: "finding" },
          h("div", { class: "sev", text: (c.id || "").toUpperCase() }),
          h("div", { class: "what", text: c.value })
        ));
      });
    } else {
      reportBody.appendChild(h("div", { class: "finding" },
        h("div", { class: "sev" }),
        h("div", { class: "what", text: SteamtrainReducer.formatArrivalReceipt(report.receipt) })
      ));
    }
    main.appendChild(reportBody);
    wrap.appendChild(main);

    // ---- right column: step ledger ------------------------------------------
    var leaves = collectArrivalLeafSteps();
    var ledger = h("div", { class: "ledger" });
    ledger.appendChild(h("div", { class: "ledger-head" },
      h("span", { text: "Steps" }),
      h("span", { class: "count", text: leaves.length + " step" + (leaves.length === 1 ? "" : "s") })
    ));
    ledger.appendChild(h("div", { class: "ledger-cols" },
      h("span", { text: "" }),
      h("span", { text: "step" }),
      h("span", { text: "time" }),
      h("span", { text: "cost" })
    ));
    var rows = h("div", { class: "ledger-rows" });
    leaves.forEach(function (s) {
      var failed = s.status === "error";
      var kindLabel = KIND_LABEL[s.blockKind] || s.blockKind || "step";
      var sub = h("span", { class: "sub", text: kindLabel + (s.model ? " · " + s.model : "") });
      if (s.cached) sub.appendChild(h("span", { class: "cached", text: " · cached" }));
      if (s.gate) sub.appendChild(document.createTextNode(s.gate.passed ? " · passed" : " · failed"));
      var r = s.result || {};
      rows.appendChild(h("div", { class: "ledger-row" + (failed ? " failed" : "") },
        h("span", { class: "dot" }),
        h("div", null, h("div", { class: "id", text: friendlyStepLabel(s.stepId) }), sub),
        h("span", { class: "num", text: typeof r.durationMs === "number" ? (r.durationMs / 1000).toFixed(1) + "s" : "" }),
        h("span", { class: "num", text: r.costUsd ? "$" + r.costUsd.toFixed(4) : "" })
      ));
    });
    ledger.appendChild(rows);

    var foot = h("div", { class: "ledger-foot" });
    function footRow(label, value) {
      return h("div", { class: "row" }, h("span", { text: label }), h("span", { class: "v", text: value }));
    }
    var sandbox = computeSandboxStats(leaves);
    foot.appendChild(footRow("sandbox", sandbox.readOnly + " read-only · " + sandbox.violations + " violations"));
    var worktrees = computeWorktreeStats(leaves);
    foot.appendChild(footRow("worktrees", worktrees.merged + " merged back · " + worktrees.left + " left"));
    var retries = computeRetryStats(leaves);
    foot.appendChild(footRow("retries", retries.count + (retries.ids.length === 1 ? " (" + retries.ids[0] + ")" : "")));
    ledger.appendChild(foot);

    wrap.appendChild(ledger);
    canvas.appendChild(wrap);

    if (enter) {
      announce(headline);
      if (runAgainBtn && !S.arrivalCtaFocused) {
        S.arrivalCtaFocused = true;
        requestAnimationFrame(function () {
          try { runAgainBtn.focus({ preventScroll: true }); } catch (e) { runAgainBtn.focus(); }
        });
      }
    }
    return true;
  }


  ST.arrival = {
    render: renderArrival,
    renderArrival: renderArrival,
  };
})(window.Steamtrain);
