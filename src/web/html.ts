/**
 * The steamtrain web UI — a single self-contained page (no build step, no
 * client dependencies). The CSS and JS now live as real, standalone files in
 * `src/web/public/` and are served at `/static/*` with long-lived, content-hashed
 * cache-busting query strings, so:
 *
 *   - The reducer bundle and the hand-written client code can be linted and
 *     statically analyzed by tooling (biome, IDEs) instead of being trapped
 *     inside a TS template literal.
 *   - Browsers cache the assets aggressively (`max-age=31536000, immutable`)
 *     and reload cheaply whenever they change.
 *
 * {@link renderIndex} is supplied the short content-hash revisions of each
 * asset by the HTTP server (`src/web/server.ts`), which loads the asset buffers
 * at startup and computes their hashes once.
 *
 * The page mirrors the TUI's render model: it folds the same `WorkflowEvent`
 * stream (delivered over SSE) into a phase -> step pipeline, but lays phases out
 * as a vertical pipeline with parallel step cards, live text tails, data-flow
 * inputs, and per-step status/duration/cost.
 */
export interface PageAssetRevisions {
  /** Hash of `src/web/public/steamtrain-reducer.bundle.js`. */
  bundle: string;
  /** Hash of `src/web/public/app.js`. */
  appJs: string;
  /** Hash of `src/web/public/app.css`. */
  appCss: string;
}

/**
 * Render the steamtrain SPA HTML page. The returned document references the
 * external stylesheet and the two external scripts (reducer bundle first, then
 * the client code) using content-hashed URLs so intermediate caches and
 * browsers revalidate correctly across releases.
 */
export function renderIndex(revs: PageAssetRevisions): string {
  const cssHref = `/static/app.css?v=${revs.appCss}`;
  const bundleSrc = `/static/steamtrain-reducer.bundle.js?v=${revs.bundle}`;
  const appSrc = `/static/app.js?v=${revs.appJs}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>steamtrain</title>
<link rel="stylesheet" href="${cssHref}" />
</head>
<body>
<header>
  <div class="logo">&#128642; <span class="accent">steam</span>train</div>
  <div class="config" id="config"></div>
  <button class="newbtn" id="configBtn" title="Project agent and timeout settings">&#9881; Config</button>
  <button class="newbtn" id="historyBtn" style="margin-left:auto" title="View past runs">&#9201; History</button>
  <div class="health" id="health"></div>
</header>
<main>
  <aside id="sidebar">
    <div id="liveRunsSection" style="display:none">
      <h2>Active runs</h2>
      <div id="liveRuns"></div>
    </div>
    <h2>Workflows <button class="newbtn" id="newWfBtn" title="Create a workflow">&#43; New</button></h2>
    <div id="wflist"></div>
  </aside>
  <section class="work">
    <div class="runbar">
      <div class="title" id="wfTitle">Select a workflow</div>
      <div class="sub" id="wfSub">Pick a workflow on the left to view its pipeline and run it.</div>
      <div class="srcline" id="srcLine" style="display:none"></div>
      <div class="wfactions" id="wfActions" style="display:none">
        <button class="btn small" id="editBtn">&#9998; Configure</button>
        <button class="btn small" id="cloneBtn">&#10697; Clone</button>
        <button class="btn small warn" id="flushBtn" style="display:none">&#128190; Flush to disk</button>
        <button class="btn small danger" id="deleteBtn" style="display:none">&#128465; Delete</button>
      </div>
      <div class="row" id="runRow" style="display:none">
        <textarea id="input" placeholder="Describe the input for this run..."></textarea>
        <div id="paramsForm" class="params-form" style="display:none"></div>
        <div class="btnstack">
          <button class="btn" id="planBtn">Plan</button>
          <button class="btn primary" id="runBtn">Run &#9654;</button>
          <button class="btn" id="pauseBtn" style="display:none" title="Finish in-flight steps, schedule nothing new; pending steps become editable">&#9208; Pause</button>
          <button class="btn danger" id="cancelBtn" style="display:none">Cancel</button>
        </div>
      </div>
      <div class="status-line" id="statusLine" style="display:none">
        <span id="elapsed">0.0s</span>
        <div class="progress"><span id="progressBar"></span></div>
        <span id="progressText"></span>
        <span id="costTicker" class="cost-ticker"></span>
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
<aside class="drawer" id="drawer" aria-label="Step details"></aside>
<div class="modal-overlay" id="overlay"><div class="modal" id="modal"></div></div>
<script src="${bundleSrc}" defer></script>
<script src="${appSrc}" defer></script>
</body>
</html>`;
}

/**
 * Rendered markup with no cache-busting revisions. Convenient for tests and
 * snapshots that just need the page structure — production serving should use
 * {@link renderIndex} with computed asset hashes.
 */
export const PAGE_HTML = renderIndex({ bundle: "dev", appJs: "dev", appCss: "dev" });
