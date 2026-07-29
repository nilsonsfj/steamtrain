/**
 * Station / Arrival surface: the landing hero, conductor stage, yard track and
 * the arrival report.
 */
(function (ST) {
  "use strict";
  var S = ST.state;
  var h = ST.h;
  var KIND_LABEL = ST.KIND_LABEL;
  var TOUR_NAME = ST.TOUR_NAME;
  var announce = ST.announce;
  var friendlyStepLabel = ST.friendlyStepLabel;
  var isCredentialFreeSpec = ST.isCredentialFreeSpec;
  var isReadOnly = ST.isReadOnly;
  var pickNextWorkflow = ST.pickNextWorkflow;
  var selectWorkflow = ST.selectWorkflow;
  var syncBodyMode = ST.syncBodyMode;
  var workflowNeedsCredentials = ST.workflowNeedsCredentials;
  var fmtElapsed = ST.fmtElapsed;
  var fmtTime = ST.fmtTime;
  var fmtTokens = ST.fmtTokens;
  var stepPermissions = ST.stepPermissions;

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
          ST.run.startRun();
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
      S.project
        ? h("div", { class: "station-project", title: S.project.cwd || "" },
            h("span", { class: "station-project-mark", text: "\u25C8" }),
            h("span", { class: "station-project-name", text: S.project.name }),
            h("span", { class: "station-project-path", text: S.project.displayPath || S.project.cwd || "" })
          )
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
                ST.shell.renderSidebar();
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
        ST.render();
      }, wait);
      // Keep ride stage painted until the hold ends.
      ST.render();
      return;
    }
    completeTourRide();
    ST.render();
  }

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
    var cards = SteamtrainReducer.arrivalReceiptCards
      ? SteamtrainReducer.arrivalReceiptCards(report.receipt)
      : [];
    if (cards.length) {
      // Cards (what ran / what it cost / what it produced) carry no severity
      // of their own -- the narrow column holds the card's short label
      // instead, and every row keeps the default (unmodified) .sev colour.
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
    beginTourDeparture: beginTourDeparture,
    endTourDeparture: endTourDeparture,
    render: renderArrival,
    renderArrival: renderArrival,
    renderConductorStage: renderConductorStage,
    renderStationAtmosphere: renderStationAtmosphere,
    renderStationHero: renderStationHero,
    revealArrivalWhenReady: revealArrivalWhenReady,
  };
})(window.Steamtrain);
