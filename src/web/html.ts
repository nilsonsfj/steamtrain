/**
 * The steamtrain web UI, served as a single self-contained page (no build step,
 * no client dependencies). The embedded script deliberately avoids backticks and
 * `${...}` so this file can hold it in a plain template literal without escaping.
 *
 * It mirrors the TUI's render model: it folds the same `WorkflowEvent` stream
 * (delivered over SSE) into a phase -> step pipeline, but lays phases out as a
 * vertical pipeline with parallel step cards, live text tails, data-flow inputs,
 * and per-step status/duration/cost.
 */
export const PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>steamtrain</title>
<style>
  :root {
    --bg: #0e1116;
    --panel: #161b22;
    --panel-2: #1c232c;
    --border: #2a3340;
    --text: #e6edf3;
    --muted: #8b98a8;
    --accent: #34d3c4;
    --accent-dim: #1c6f68;
    --running: #4aa3ff;
    --done: #3fb950;
    --error: #f85149;
    --pending: #5a6675;
    --gate: #d29922;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    background: var(--bg); color: var(--text);
    font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
    display: flex; flex-direction: column; height: 100vh; overflow: hidden;
  }
  header {
    display: flex; align-items: center; gap: 12px;
    padding: 12px 18px; border-bottom: 1px solid var(--border); background: var(--panel);
  }
  header .logo { font-size: 20px; font-weight: 700; letter-spacing: .3px; }
  header .logo .accent { color: var(--accent); }
  header .config { color: var(--muted); font-size: 12px; }
  header .health { margin-left: auto; display: flex; gap: 6px; flex-wrap: wrap; }
  .chip {
    font-size: 11px; padding: 2px 8px; border-radius: 999px;
    border: 1px solid var(--border); color: var(--muted); background: var(--panel-2);
    display: inline-flex; align-items: center; gap: 5px;
  }
  .chip .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--pending); }
  .chip.ok .dot { background: var(--done); }
  .chip.bad .dot { background: var(--error); }
  .chip.warn .dot { background: var(--gate); }
  main { display: flex; flex: 1; min-height: 0; }
  aside {
    width: 290px; flex: none; border-right: 1px solid var(--border);
    background: var(--panel); overflow-y: auto; padding: 10px;
  }
  aside h2 { font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); margin: 6px 6px 10px; }
  .wf {
    padding: 9px 11px; border: 1px solid transparent; border-radius: 9px;
    cursor: pointer; margin-bottom: 6px; transition: background .12s, border-color .12s;
  }
  .wf:hover { background: var(--panel-2); }
  .wf.sel { background: var(--panel-2); border-color: var(--accent-dim); }
  .wf .name { font-weight: 600; display: flex; align-items: center; gap: 7px; }
  .wf .src {
    font-size: 10px; text-transform: uppercase; letter-spacing: .05em;
    color: var(--muted); border: 1px solid var(--border); border-radius: 5px; padding: 0 5px;
  }
  .wf .desc { color: var(--muted); font-size: 12px; margin-top: 3px; }
  .wf .meta { color: var(--muted); font-size: 11px; margin-top: 5px; }
  section.work { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .runbar { padding: 14px 18px; border-bottom: 1px solid var(--border); background: var(--panel); }
  .runbar .title { font-size: 17px; font-weight: 700; }
  .runbar .sub { color: var(--muted); font-size: 12px; margin-top: 2px; }
  .runbar .row { display: flex; gap: 10px; margin-top: 12px; align-items: stretch; }
  textarea#input {
    flex: 1; resize: vertical; min-height: 54px; max-height: 200px;
    background: var(--bg); color: var(--text); border: 1px solid var(--border);
    border-radius: 9px; padding: 10px 12px; font: inherit;
  }
  textarea#input:focus { outline: none; border-color: var(--accent-dim); }
  .btn {
    border: 1px solid var(--border); background: var(--panel-2); color: var(--text);
    border-radius: 9px; padding: 0 18px; font: inherit; font-weight: 600; cursor: pointer;
    transition: background .12s, border-color .12s; white-space: nowrap;
  }
  .btn:hover { background: #243040; }
  .btn.primary { background: var(--accent-dim); border-color: var(--accent); color: #eafffb; }
  .btn.primary:hover { background: #25867d; }
  .btn.danger { color: var(--error); border-color: #5e2a2a; }
  .btn:disabled { opacity: .45; cursor: default; }
  .btnstack { display: flex; flex-direction: column; gap: 8px; }
  .status-line { margin-top: 10px; font-size: 12px; color: var(--muted); display: flex; gap: 14px; align-items: center; flex-wrap: wrap; }
  .progress { flex: 1; height: 6px; background: var(--bg); border-radius: 4px; overflow: hidden; min-width: 120px; border: 1px solid var(--border); }
  .progress > span { display: block; height: 100%; width: 0; background: linear-gradient(90deg, var(--accent-dim), var(--accent)); transition: width .25s; }
  .banner { margin-top: 10px; padding: 8px 12px; border-radius: 8px; font-size: 13px; display: none; }
  .banner.show { display: block; }
  .banner.ok { background: #11271a; border: 1px solid #1f6f33; color: #b9f0c4; }
  .banner.err { background: #2a1314; border: 1px solid #6f2424; color: #f7b6b3; }
  .banner.info { background: #122230; border: 1px solid #1f4a6f; color: #bcdcf5; }
  .canvas { flex: 1; overflow-y: auto; padding: 22px 18px 60px; }
  .empty { color: var(--muted); text-align: center; margin-top: 70px; }
  .phase { position: relative; margin: 0 auto 8px; max-width: 1100px; }
  .phase .phead { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
  .phase .pidx {
    width: 24px; height: 24px; border-radius: 50%; flex: none;
    background: var(--panel-2); border: 1px solid var(--border);
    display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 700; color: var(--muted);
  }
  .phase.done .pidx { background: var(--accent-dim); border-color: var(--accent); color: #eafffb; }
  .phase .ptitle { font-weight: 700; }
  .phase .pstat { font-size: 11px; color: var(--muted); }
  .connector { width: 2px; height: 18px; background: var(--border); margin: 0 auto; }
  .cards { display: flex; flex-wrap: wrap; gap: 12px; }
  .card {
    flex: 1 1 280px; max-width: 520px; min-width: 240px;
    background: var(--panel); border: 1px solid var(--border); border-left: 3px solid var(--pending);
    border-radius: 11px; padding: 12px 13px; transition: border-color .15s, box-shadow .15s;
  }
  .card.running { border-left-color: var(--running); box-shadow: 0 0 0 1px rgba(74,163,255,.18); }
  .card.running .kind .pulse { animation: pulse 1.1s ease-in-out infinite; }
  .card.done { border-left-color: var(--done); }
  .card.error { border-left-color: var(--error); }
  @keyframes pulse { 0%,100% { opacity: .35; } 50% { opacity: 1; } }
  .card .top { display: flex; align-items: center; gap: 8px; }
  .card .sid { font-weight: 700; font-size: 14px; }
  .card .kind {
    font-size: 10px; text-transform: uppercase; letter-spacing: .05em; padding: 1px 7px;
    border-radius: 6px; color: #0e1116; font-weight: 700; display: inline-flex; align-items: center; gap: 5px;
  }
  .kind .pulse { width: 6px; height: 6px; border-radius: 50%; background: #0e1116; opacity: .35; }
  .kind.worker { background: #6fb1ff; } .kind.processor { background: #9d8cff; }
  .kind.distributor { background: #ffce6f; } .kind.consolidator { background: #5fe0c6; }
  .kind.gate { background: #f0a35e; }
  .card .state { margin-left: auto; font-size: 11px; color: var(--muted); }
  .card .state.running { color: var(--running); } .card .state.done { color: var(--done); } .card .state.error { color: var(--error); }
  .card .agent { color: var(--muted); font-size: 11px; margin-top: 5px; }
  .card .inputs { font-size: 11px; color: var(--accent); margin-top: 4px; }
  .card .item { font-size: 11px; color: var(--gate); margin-top: 4px; }
  .card .activity { font-size: 11px; color: var(--muted); margin-top: 6px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .card .tail {
    margin-top: 8px; background: var(--bg); border: 1px solid var(--border); border-radius: 7px;
    padding: 7px 9px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px;
    color: #c4d0dd; white-space: pre-wrap; max-height: 132px; overflow: hidden; display: none;
  }
  .card .tail.show { display: block; }
  .card .metrics { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 8px; font-size: 11px; color: var(--muted); }
  .badge { padding: 1px 6px; border-radius: 5px; border: 1px solid var(--border); }
  .badge.cached { color: var(--gate); border-color: #5e4a1d; }
  .badge.gate-pass { color: var(--done); border-color: #1f6f33; }
  .badge.gate-block { color: var(--error); border-color: #6f2424; }
  .legend { max-width: 1100px; margin: 0 auto 16px; display: flex; gap: 14px; flex-wrap: wrap; color: var(--muted); font-size: 11px; }
  .legend span { display: inline-flex; align-items: center; gap: 5px; }
  .legend i { width: 10px; height: 10px; border-radius: 3px; display: inline-block; }
  .summary { max-width: 1100px; margin: 20px auto 0; }
  .summary table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
  .summary th, .summary td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--border); }
  .summary th { color: var(--muted); font-weight: 600; }
  .summary td.ok { color: var(--done); } .summary td.fail { color: var(--error); }
</style>
</head>
<body>
<header>
  <div class="logo">&#128642; <span class="accent">steam</span>train</div>
  <div class="config" id="config"></div>
  <div class="health" id="health"></div>
</header>
<main>
  <aside id="sidebar"><h2>Workflows</h2><div id="wflist"></div></aside>
  <section class="work">
    <div class="runbar">
      <div class="title" id="wfTitle">Select a workflow</div>
      <div class="sub" id="wfSub">Pick a workflow on the left to view its pipeline and run it.</div>
      <div class="row" id="runRow" style="display:none">
        <textarea id="input" placeholder="Describe the input for this run..."></textarea>
        <div class="btnstack">
          <button class="btn primary" id="runBtn">Run &#9654;</button>
          <button class="btn danger" id="cancelBtn" style="display:none">Cancel</button>
        </div>
      </div>
      <div class="status-line" id="statusLine" style="display:none">
        <span id="elapsed">0.0s</span>
        <div class="progress"><span id="progressBar"></span></div>
        <span id="progressText"></span>
        <label style="display:inline-flex;gap:5px;align-items:center;cursor:pointer">
          <input type="checkbox" id="freshChk" /> fresh (ignore cache)
        </label>
      </div>
      <div class="banner" id="banner"></div>
    </div>
    <div class="canvas" id="canvas">
      <div class="empty">No workflow selected.</div>
    </div>
  </section>
</main>
<script>
(function () {
  "use strict";

  var KIND_LABEL = { worker: "worker", processor: "process", distributor: "fan-out", consolidator: "merge", gate: "gate" };
  var S = {
    workflows: [], selected: null, spec: null,
    runId: null, es: null, started: false, done: false, ok: true,
    startedAt: 0, timer: null, results: [],
    phaseOrder: [], phaseDone: {}, live: {}, childOf: {}, specStepIds: {},
    rafQueued: false
  };

  function h(tag, attrs) {
    var e = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        if (k === "class") e.className = attrs[k];
        else if (k === "text") e.textContent = attrs[k];
        else if (k.indexOf("on") === 0) e.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
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
  function api(method, path, body) {
    return fetch(path, {
      method: method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined
    }).then(function (r) { return r.json().then(function (j) { return { status: r.status, body: j }; }); });
  }

  // ---- workflow catalog ----------------------------------------------------
  function loadWorkflows() {
    api("GET", "/api/workflows").then(function (r) {
      S.workflows = r.body.workflows || [];
      if (r.body.configLabel) document.getElementById("config").textContent = r.body.configLabel;
      renderSidebar();
    });
    pollDoctor(0);
  }

  // Health probes run in the background on the server; poll a few times until
  // they land so the chips appear without a manual reload.
  function pollDoctor(attempt) {
    api("GET", "/api/doctor").then(function (r) {
      var list = r.body.doctor || [];
      renderHealth(list);
      if (!list.length && attempt < 12) setTimeout(function () { pollDoctor(attempt + 1); }, 1500);
    });
  }

  function renderHealth(list) {
    var box = document.getElementById("health");
    clear(box);
    list.forEach(function (d) {
      var cls = d.status === "ok" ? "ok" : (d.status === "warn" ? "warn" : "bad");
      box.appendChild(h("span", { class: "chip " + cls }, h("span", { class: "dot" }), d.agent));
    });
  }

  function renderSidebar() {
    var box = document.getElementById("wflist");
    clear(box);
    S.workflows.forEach(function (w) {
      var kinds = Object.keys(w.kinds || {}).map(function (k) { return (KIND_LABEL[k] || k) + ":" + w.kinds[k]; }).join(" \\u00b7 ");
      var meta = w.phaseCount + " phase" + (w.phaseCount === 1 ? "" : "s") + " \\u00b7 " + w.stepCount + " step" + (w.stepCount === 1 ? "" : "s");
      var card = h("div", { class: "wf" + (S.selected === w.name ? " sel" : ""), onClick: function () { selectWorkflow(w.name); } },
        h("div", { class: "name" }, w.name, h("span", { class: "src", text: w.source })),
        w.description ? h("div", { class: "desc", text: w.description }) : null,
        h("div", { class: "meta", text: meta + (kinds ? " \\u00b7 " + kinds : "") })
      );
      box.appendChild(card);
    });
  }

  function selectWorkflow(name) {
    if (S.es) { S.es.close(); S.es = null; }
    stopTimer();
    S.selected = name; S.runId = null; S.started = false; S.done = false;
    renderSidebar();
    document.getElementById("statusLine").style.display = "none";
    setBanner("", "");
    api("GET", "/api/workflows/" + encodeURIComponent(name)).then(function (r) {
      if (r.status !== 200) { setBanner(r.body.error || "failed to load", "err"); return; }
      S.spec = r.body.spec;
      document.getElementById("wfTitle").textContent = r.body.spec.name;
      document.getElementById("wfSub").textContent = r.body.spec.description || ("source: " + r.body.source);
      document.getElementById("runRow").style.display = "flex";
      resetRunModel();
      seedFromSpec();
      render();
    });
  }

  // ---- run model -----------------------------------------------------------
  function resetRunModel() {
    S.phaseOrder = []; S.phaseDone = {}; S.live = {}; S.childOf = {};
    S.specStepIds = {}; S.results = []; S.ok = true;
  }
  function seedFromSpec() {
    if (!S.spec) return;
    S.spec.phases.forEach(function (p) {
      S.phaseOrder.push({ id: p.id, title: p.title || p.id });
      (p.steps || []).forEach(function (st) {
        S.specStepIds[st.id] = p.id;
        S.live[st.id] = {
          id: st.id, phaseId: p.id, kind: st.kind || "worker", agent: st.agent, model: st.model,
          dependsOn: st.dependsOn, forEach: st.forEach, status: "pending", text: "", activity: null,
          result: null, cached: false, gate: null, item: null, child: false
        };
      });
    });
  }
  function ensureLive(stepId, phaseId) {
    if (!S.live[stepId]) {
      S.live[stepId] = {
        id: stepId, phaseId: phaseId, kind: "worker", status: "pending", text: "",
        activity: null, result: null, cached: false, gate: null, item: null, child: true
      };
      if (!S.specStepIds[stepId]) {
        (S.childOf[phaseId] = S.childOf[phaseId] || []).push(stepId);
      }
    }
    return S.live[stepId];
  }

  function reduce(ev) {
    switch (ev.kind) {
      case "workflow_start":
        S.started = true; S.startedAt = Date.now(); break;
      case "phase_start":
        if (!S.phaseOrder.some(function (p) { return p.id === ev.phaseId; }))
          S.phaseOrder.push({ id: ev.phaseId, title: ev.title || ev.phaseId });
        break;
      case "step_start": {
        var s = ensureLive(ev.stepId, ev.phaseId);
        s.status = "running"; s.phaseId = ev.phaseId;
        if (ev.blockKind) s.kind = ev.blockKind;
        if (ev.agent) s.agent = ev.agent;
        if (ev.model) s.model = ev.model;
        if (ev.dependsOn) s.dependsOn = ev.dependsOn;
        if (ev.item) s.item = ev.item;
        if (ev.parentStepId) s.parentStepId = ev.parentStepId;
        break;
      }
      case "step_event": {
        var st = S.live[ev.stepId]; if (!st) break;
        var a = ev.event;
        if (a.kind === "text_delta") { if (!a.thinking) st.text += a.text; }
        else if (a.kind === "tool_use") st.activity = "\\u2699 " + a.name;
        else if (a.kind === "tool_result") st.activity = (a.isError ? "\\u2717 " : "\\u2713 ") + (a.name || "tool");
        break;
      }
      case "gate_evaluated": {
        var g = S.live[ev.stepId]; if (!g) break;
        g.gate = { passed: ev.passed, target: ev.target };
        g.activity = ev.passed ? ("gate passed" + (ev.target ? " \\u2192 " + ev.target : "")) : "gate blocked";
        break;
      }
      case "step_done": {
        var d = S.live[ev.stepId]; if (!d) break;
        d.status = ev.result.ok ? "done" : "error";
        d.result = ev.result; d.cached = ev.cached;
        if (!d.text) d.text = ev.result.output || "";
        break;
      }
      case "phase_done":
        S.phaseDone[ev.phaseId] = { ok: ev.ok }; break;
      case "workflow_done":
        S.done = true; S.ok = ev.ok; S.results = ev.results || []; break;
    }
  }

  // ---- rendering -----------------------------------------------------------
  function scheduleRender() {
    if (S.rafQueued) return;
    S.rafQueued = true;
    requestAnimationFrame(function () { S.rafQueued = false; render(); });
  }

  function stepsForPhase(phaseId) {
    var ids = [];
    (S.spec ? (S.spec.phases.find(function (p) { return p.id === phaseId; }) || {}).steps || [] : []).forEach(function (st) { ids.push(st.id); });
    (S.childOf[phaseId] || []).forEach(function (id) { ids.push(id); });
    return ids.map(function (id) { return S.live[id]; }).filter(Boolean);
  }

  function render() {
    var canvas = document.getElementById("canvas");
    clear(canvas);
    if (!S.spec) { canvas.appendChild(h("div", { class: "empty", text: "No workflow selected." })); return; }

    canvas.appendChild(h("div", { class: "legend" },
      legendItem("worker", "worker"), legendItem("processor", "process"),
      legendItem("distributor", "fan-out"), legendItem("consolidator", "merge"), legendItem("gate", "gate")
    ));

    S.phaseOrder.forEach(function (p, idx) {
      if (idx > 0) canvas.appendChild(h("div", { class: "connector" }));
      var done = S.phaseDone[p.id];
      var steps = stepsForPhase(p.id);
      var running = steps.some(function (s) { return s.status === "running"; });
      var pstat = done ? (done.ok ? "done" : "failed") : (running ? "running" : (S.started ? "" : "pending"));
      var phaseEl = h("div", { class: "phase" + (done ? " done" : "") },
        h("div", { class: "phead" },
          h("div", { class: "pidx", text: String(idx + 1) }),
          h("div", { class: "ptitle", text: p.title }),
          pstat ? h("div", { class: "pstat", text: "\\u00b7 " + pstat }) : null
        )
      );
      var cards = h("div", { class: "cards" });
      steps.forEach(function (s) { cards.appendChild(renderCard(s)); });
      phaseEl.appendChild(cards);
      canvas.appendChild(phaseEl);
    });

    if (S.done) renderSummary(canvas);
    updateProgress();
  }

  function legendItem(kind, label) {
    var i = h("i"); i.className = ""; i.style.background = kindColor(kind);
    return h("span", null, i, label);
  }
  function kindColor(k) {
    return { worker: "#6fb1ff", processor: "#9d8cff", distributor: "#ffce6f", consolidator: "#5fe0c6", gate: "#f0a35e" }[k] || "#6fb1ff";
  }

  function renderCard(s) {
    var card = h("div", { class: "card " + s.status });
    var kindEl = h("span", { class: "kind " + s.kind });
    if (s.status === "running") kindEl.appendChild(h("span", { class: "pulse" }));
    kindEl.appendChild(document.createTextNode(KIND_LABEL[s.kind] || s.kind));
    var stateLabel = s.status === "pending" ? "pending" : s.status;
    card.appendChild(h("div", { class: "top" },
      h("span", { class: "sid", text: s.id }),
      kindEl,
      h("span", { class: "state " + s.status, text: stateLabel })
    ));
    if (s.agent) card.appendChild(h("div", { class: "agent", text: s.agent + (s.model ? " \\u00b7 " + s.model : "") }));
    if (s.dependsOn && s.dependsOn.length) card.appendChild(h("div", { class: "inputs", text: "inputs: " + s.dependsOn.join(", ") }));
    if (s.forEach) card.appendChild(h("div", { class: "inputs", text: "forEach: " + s.forEach }));
    if (s.item) card.appendChild(h("div", { class: "item", text: "item #" + s.item.index + ": " + truncate(s.item.value, 80) }));
    if (s.activity) card.appendChild(h("div", { class: "activity", text: s.activity }));

    var tailText = s.text ? tail(s.text, 600) : "";
    if (tailText) {
      var tailEl = h("div", { class: "tail show", text: tailText });
      card.appendChild(tailEl);
    }

    if (s.result || s.cached || s.gate) {
      var metrics = h("div", { class: "metrics" });
      if (s.result) {
        metrics.appendChild(h("span", { text: (s.result.durationMs / 1000).toFixed(1) + "s" }));
        if (s.result.costUsd) metrics.appendChild(h("span", { text: "$" + s.result.costUsd.toFixed(4) }));
      }
      if (s.cached) metrics.appendChild(h("span", { class: "badge cached", text: "cached" }));
      if (s.gate) metrics.appendChild(h("span", { class: "badge " + (s.gate.passed ? "gate-pass" : "gate-block"), text: s.gate.passed ? "gate passed" : "gate blocked" }));
      card.appendChild(metrics);
    }
    return card;
  }

  function renderSummary(canvas) {
    var leaves = S.results.filter(function (r) { return !(r.childResults && r.childResults.length); });
    if (!leaves.length) return;
    var wrap = h("div", { class: "summary" });
    wrap.appendChild(h("h2", { text: "Run summary", style: "color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.08em" }));
    var table = h("table");
    table.appendChild(h("tr", null,
      h("th", { text: "" }), h("th", { text: "step" }), h("th", { text: "time" }),
      h("th", { text: "cost" }), h("th", { text: "notes" })
    ));
    var totalMs = 0, totalCost = 0, okN = 0, failN = 0;
    leaves.forEach(function (r) {
      totalMs += r.durationMs || 0; totalCost += r.costUsd || 0;
      if (r.ok) okN++; else failN++;
      var notes = [];
      if (r.item) notes.push("item " + r.item.index);
      if (r.gate) notes.push(r.gate.passed ? "gate:passed" : "gate:blocked");
      table.appendChild(h("tr", null,
        h("td", { class: r.ok ? "ok" : "fail", text: r.ok ? "\\u2713" : "\\u2717" }),
        h("td", { text: r.stepId }),
        h("td", { text: ((r.durationMs || 0) / 1000).toFixed(1) + "s" }),
        h("td", { text: r.costUsd ? "$" + r.costUsd.toFixed(4) : "" }),
        h("td", { text: notes.join(" \\u00b7 ") })
      ));
    });
    wrap.appendChild(table);
    var totals = okN + " ok" + (failN ? " \\u00b7 " + failN + " failed" : "") + (totalCost ? " \\u00b7 $" + totalCost.toFixed(4) : "") + " \\u00b7 " + (totalMs / 1000).toFixed(1) + "s total";
    wrap.appendChild(h("div", { class: "meta", style: "color:var(--muted);font-size:12px;margin-top:8px", text: totals }));
    canvas.appendChild(wrap);
  }

  function updateProgress() {
    var all = Object.keys(S.live).map(function (k) { return S.live[k]; });
    var total = all.length || (S.spec ? 0 : 0);
    var doneN = all.filter(function (s) { return s.status === "done" || s.status === "error"; }).length;
    var bar = document.getElementById("progressBar");
    var pct = total ? Math.round((doneN / total) * 100) : 0;
    bar.style.width = pct + "%";
    document.getElementById("progressText").textContent = doneN + " / " + total + " steps";
  }

  // ---- running -------------------------------------------------------------
  function startRun() {
    var input = document.getElementById("input").value;
    if (!input.trim()) { setBanner("enter some input first", "info"); return; }
    resetRunModel(); seedFromSpec();
    S.started = false; S.done = false; S.ok = true;
    setBanner("", "");
    document.getElementById("statusLine").style.display = "flex";
    api("POST", "/api/runs", { workflow: S.selected, input: input, fresh: document.getElementById("freshChk").checked })
      .then(function (r) {
        if (r.status !== 201) { setBanner(r.body.error || "could not start run", "err"); return; }
        S.runId = r.body.runId;
        setRunning(true);
        S.startedAt = Date.now();
        startTimer();
        openStream(S.runId);
        render();
      });
  }

  function openStream(runId) {
    if (S.es) S.es.close();
    var es = new EventSource("/api/runs/" + runId + "/stream");
    S.es = es;
    es.onmessage = function (m) {
      var frame;
      try { frame = JSON.parse(m.data); } catch (e) { return; }
      if (frame.type === "event") { reduce(frame.event); scheduleRender(); }
      else if (frame.type === "status") {
        es.close(); S.es = null; setRunning(false); stopTimer();
        if (frame.status === "canceled") setBanner("Run canceled.", "info");
        else if (frame.status === "error" || frame.ok === false) setBanner("Run failed" + (frame.error ? ": " + frame.error : "."), "err");
        else setBanner("Run complete.", "ok");
        render();
      }
    };
    es.onerror = function () {
      if (S.done) return;
      // The browser will retry automatically; surface a hint if it persists.
    };
  }

  function cancelRun() {
    if (!S.runId) return;
    api("POST", "/api/runs/" + S.runId + "/cancel");
  }

  function setRunning(running) {
    document.getElementById("runBtn").style.display = running ? "none" : "block";
    document.getElementById("cancelBtn").style.display = running ? "block" : "none";
    document.getElementById("input").disabled = running;
  }

  function startTimer() {
    stopTimer();
    S.timer = setInterval(function () {
      document.getElementById("elapsed").textContent = ((Date.now() - S.startedAt) / 1000).toFixed(1) + "s";
    }, 200);
  }
  function stopTimer() { if (S.timer) { clearInterval(S.timer); S.timer = null; } }

  function setBanner(text, kind) {
    var b = document.getElementById("banner");
    if (!text) { b.className = "banner"; b.textContent = ""; return; }
    b.className = "banner show " + (kind === "ok" ? "ok" : kind === "err" ? "err" : "info");
    b.textContent = text;
  }

  // ---- utils ---------------------------------------------------------------
  function tail(text, n) { return text.length > n ? "\\u2026" + text.slice(text.length - n) : text; }
  function truncate(text, n) { return text.length > n ? text.slice(0, n) + "\\u2026" : text; }

  document.getElementById("runBtn").addEventListener("click", startRun);
  document.getElementById("cancelBtn").addEventListener("click", cancelRun);
  document.getElementById("input").addEventListener("keydown", function (e) {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") startRun();
  });

  loadWorkflows();
})();
</script>
</body>
</html>`;
