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
          if (d.id === "again") ST.run.startRun();
          else if (d.id === "history") ST.modals.openHistory();
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
      onClick: function () { S.arrivalInspect = !S.arrivalInspect; ST.render(); }
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


  ST.arrival = {
    beginTourDeparture: beginTourDeparture,
    endTourDeparture: endTourDeparture,
    renderArrival: renderArrival,
    renderConductorStage: renderConductorStage,
    renderStationAtmosphere: renderStationAtmosphere,
    renderStationHero: renderStationHero,
    revealArrivalWhenReady: revealArrivalWhenReady,
  };
})(window.Steamtrain);
