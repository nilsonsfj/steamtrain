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
/**
 * Designed locomotive mark for the tab icon (replaces the emoji glyph so the
 * brand reads as a product, not a placeholder). Kept in sync visually with the
 * `.brand-mark` CSS in `shell.css`.
 */
export const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" fill="none"><rect width="32" height="32" rx="7" fill="#0e1116"/><path d="M6.5 22.5h18.2c1 0 1.8-.7 1.8-1.7V14.2c0-1.1-.9-2-2-2h-9.1L13.2 9.5H8.4c-.9 0-1.6.7-1.6 1.6v11.4z" fill="#1c6f68"/><path d="M8.5 13.2h4.2l1.4 2.2H24c.5 0 .8.3.8.8v5.6c0 .3-.2.5-.5.5H8.5v-9.1z" fill="#34d3c4"/><rect x="9.7" y="14.5" width="2.5" height="1.9" rx=".3" fill="#0e1116" opacity=".55"/><path d="M18.2 10.6c0-1.1.5-2.1.9-2.7.1-.2.5-.1.5.2 0 .7-.1 1.3-.1 2 0 .3.2.5.5.4.8-.4 1.4-1.2 1.6-2 .1-.2.4-.2.4 0 .1 1-.5 2.2-1.4 2.9-.4.3-.9.5-1.5.5h-.9v-1.3z" fill="#8eeae0"/><circle cx="11.6" cy="23.8" r="2.4" fill="#0e1116" stroke="#34d3c4" stroke-width="1.2"/><circle cx="11.6" cy="23.8" r=".85" fill="#34d3c4"/><circle cx="20.4" cy="23.8" r="2.4" fill="#0e1116" stroke="#34d3c4" stroke-width="1.2"/><circle cx="20.4" cy="23.8" r=".85" fill="#34d3c4"/><path d="M6.5 22.5h19" stroke="#d29922" stroke-width="1" stroke-linecap="round" opacity=".75"/></svg>`;

export interface WebAsset {
  /** Filename inside `src/web/public/`, also its `/static/<file>` URL. */
  file: string;
  kind: "css" | "js";
  mime: string;
}

/**
 * Every static asset the page loads, in load order. Stylesheets are emitted as
 * `<link>` in `<head>`; scripts as `<script defer>` at the end of `<body>`,
 * which is what guarantees execution order for the client modules (they share a
 * `window.Steamtrain` namespace and have no module loader).
 *
 * `src/web/server.ts` builds its `/static/*` route table from this same list,
 * so adding a file here is the only step needed to ship it.
 */
export const WEB_ASSETS: readonly WebAsset[] = [
  { file: "tokens.css", kind: "css", mime: "text/css; charset=utf-8" },
  { file: "shell.css", kind: "css", mime: "text/css; charset=utf-8" },
  { file: "run.css", kind: "css", mime: "text/css; charset=utf-8" },
  { file: "instruments.css", kind: "css", mime: "text/css; charset=utf-8" },
  { file: "arrival.css", kind: "css", mime: "text/css; charset=utf-8" },
  { file: "settings.css", kind: "css", mime: "text/css; charset=utf-8" },
  { file: "runs.css", kind: "css", mime: "text/css; charset=utf-8" },
  { file: "modals.css", kind: "css", mime: "text/css; charset=utf-8" },
  { file: "steamtrain-reducer.bundle.js", kind: "js", mime: "text/javascript; charset=utf-8" },
  { file: "steamtrain-diff.bundle.js", kind: "js", mime: "text/javascript; charset=utf-8" },
  { file: "st-core.js", kind: "js", mime: "text/javascript; charset=utf-8" },
  { file: "st-shell.js", kind: "js", mime: "text/javascript; charset=utf-8" },
  { file: "st-run.js", kind: "js", mime: "text/javascript; charset=utf-8" },
  { file: "st-instruments.js", kind: "js", mime: "text/javascript; charset=utf-8" },
  { file: "st-arrival.js", kind: "js", mime: "text/javascript; charset=utf-8" },
  { file: "st-settings.js", kind: "js", mime: "text/javascript; charset=utf-8" },
  { file: "st-modals.js", kind: "js", mime: "text/javascript; charset=utf-8" },
  { file: "st-runs.js", kind: "js", mime: "text/javascript; charset=utf-8" },
  { file: "st-boot.js", kind: "js", mime: "text/javascript; charset=utf-8" },
];

/** Content-hash revision per asset filename, e.g. `{ "tokens.css": "a1b2…" }`. */
export type PageAssetRevisions = Record<string, string>;

/**
 * Render the steamtrain SPA HTML page. The returned document references the
 * external stylesheet(s) and script(s) listed in {@link WEB_ASSETS}, in
 * manifest order, using content-hashed URLs so intermediate caches and
 * browsers revalidate correctly across releases.
 */
export function renderIndex(revs: PageAssetRevisions): string {
  const url = (file: string) => `/static/${file}?v=${revs[file] ?? ""}`;
  const styles = WEB_ASSETS.filter((a) => a.kind === "css")
    .map((a) => `<link rel="stylesheet" href="${url(a.file)}" />`)
    .join("\n");
  const scripts = WEB_ASSETS.filter((a) => a.kind === "js")
    .map((a) => `<script src="${url(a.file)}" defer></script>`)
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="dark" />
<meta name="theme-color" content="#0c0e11" />
<title>steamtrain</title>
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(FAVICON_SVG)}" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap" />
${styles}
</head>
<body>
<div id="app">
  <header id="topbar">
    <button type="button" class="brand" id="homeBtn" title="Home" aria-label="Home"><span class="brand-mark" aria-hidden="true"></span><span class="wordmark">steamtrain</span></button>
    <nav class="crumbs" id="crumbs" aria-label="Location"></nav>
    <span class="status-pill" id="runPill" style="display:none"></span>
    <span class="mode-badge" id="modeBadge" style="display:none" title="This session can view workflows and runs but cannot launch, edit, approve, or change config.">&#128065; read-only</span>
    <div class="topbar-right">
      <div class="health" id="health" role="group" aria-label="Agent health"></div>
      <button class="tbtn" id="historyBtn" title="Browse live and past runs">Runs</button>
      <button class="tbtn" id="settingsBtn" title="Project agent and timeout settings">Settings</button>
    </div>
  </header>
  <div id="cols">
    <aside id="rail-left" aria-label="Workflows"></aside>
    <section id="center">
      <!-- section.work / .runbar / .canvas are kept as class hooks: the
           Arrival mode in arrival.css still selects on them (Station/Ride/
           Conductor were retired). -->
      <section class="work">
        <div class="runbar">
          <div class="run-head">
            <div class="run-head-copy">
              <div class="title" id="wfTitle">Select a workflow</div>
              <div class="origin srcline" id="srcLine" style="display:none"></div>
              <div class="scope sub" id="wfSub">Pick a workflow on the left to view its pipeline and run it.</div>
            </div>
            <div class="wfactions" id="wfActions" style="display:none">
              <button class="btn small" id="editBtn">&#9998; Configure</button>
              <button class="btn small" id="cloneBtn">&#10697; Clone</button>
              <button class="btn small warn" id="flushBtn" style="display:none">&#128190; Flush to disk</button>
              <button class="btn small danger" id="deleteBtn" style="display:none">&#128465; Delete</button>
            </div>
            <div class="run-metrics" id="runMetrics" style="display:none">
              <div class="run-progress" role="presentation"><span class="done" id="progressBar"></span><span class="live" id="progressLive"></span></div>
              <div class="run-clock">
                <div class="row"><span class="elapsed" id="elapsed">0.0s</span></div>
                <div class="row"><span class="steps" id="progressText"></span><span class="steps" id="costTicker"></span></div>
              </div>
              <button class="rbtn" id="pauseBtn" style="display:none" title="Finish in-flight steps, schedule nothing new; pending steps become editable">&#9208; Pause</button>
              <button class="rbtn" id="detachBtn" style="display:none" title="Hand this run to a background process — it keeps running if you close this page">&#9992; Detach</button>
              <button class="rbtn danger" id="cancelBtn" style="display:none">Cancel</button>
            </div>
          </div>
          <div class="reroute-row" id="blockedRow" style="display:none"></div>
          <div class="row composer" id="runRow" style="display:none">
            <div class="run-compose">
              <label class="run-compose-label" for="input">Describe</label>
              <textarea id="input" placeholder="What should this run do? (&#8593; recalls previous inputs)"></textarea>
              <div id="paramsPanel" class="params-panel collapsed" style="display:none" hidden>
                <button type="button" class="params-toggle" id="paramsToggle" aria-expanded="false" aria-controls="paramsForm">
                  <span class="params-toggle-chevron" aria-hidden="true"></span>
                  <span class="params-toggle-label">Variables</span>
                  <span class="params-toggle-meta" id="paramsMeta"></span>
                </button>
                <div id="paramsForm" class="params-form" role="region" aria-label="Workflow variables"></div>
              </div>
            </div>
            <div class="btnstack">
              <button class="rbtn" id="planBtn">Plan</button>
              <button class="rbtn primary" id="runBtn">Run &#9654;</button>
              <label class="fresh-toggle"><input type="checkbox" id="freshChk" /> fresh (ignore cache)</label>
            </div>
          </div>
          <div class="banner" id="banner"></div>
        </div>
        <div class="canvas bands" id="bands" tabindex="-1" aria-label="Workflow workspace">
          <div class="empty">No workflow selected.</div>
        </div>
      </section>
    </section>
    <aside id="rail-right" aria-label="Run instruments"></aside>
  </div>
</div>
<aside class="drawer" id="drawer" role="dialog" aria-label="Step details" aria-hidden="true" tabindex="-1"></aside>
<div class="modal-overlay" id="overlay"><div class="modal" id="modal"></div></div>
<div id="announcer" class="sr-only" aria-live="polite" aria-atomic="true"></div>
${scripts}
</body>
</html>`;
}

/**
 * Rendered markup with no cache-busting revisions. Convenient for tests and
 * snapshots that just need the page structure — production serving should use
 * {@link renderIndex} with computed asset hashes.
 */
export const PAGE_HTML = renderIndex(Object.fromEntries(WEB_ASSETS.map((a) => [a.file, "dev"])));
