import { contextBridge, ipcRenderer } from "electron";
import { TITLE_BAR_INSET_PX, overlaysTitleBar } from "../shared/title-bar";

/**
 * The renderer-facing surface, kept as small as it can usefully be.
 *
 * The UI talks to the engine over HTTP, not IPC, so nothing here is required
 * for it to work — this exists so the client can *detect* that it is running in
 * the desktop app and adapt. `ipcRenderer` itself is never exposed: anything
 * the renderer may ask for gets an explicit, validated function.
 */
contextBridge.exposeInMainWorld("steamtrainDesktop", {
  platform: process.platform,
  version: process.versions.electron,
  /** Same dialog the "Open Project…" menu item and its shortcut trigger. */
  switchProject: () => ipcRenderer.invoke("steamtrain:switch-project"),
});

/**
 * Tell the page it is inside the app window.
 *
 * Written onto the document rather than handed to the client to read, because
 * it has to be true before the first paint: a topbar that reflowed once the
 * client scripts had run would show its wordmark under the window controls
 * first. In a browser neither the class nor the variable exists, and the rules
 * keyed off them do nothing.
 */
function markDocument(): void {
  const root = document.documentElement;
  root.classList.add("desktop-app");
  if (!overlaysTitleBar(process.platform)) return;
  // Both are needed: the class gates the rules, the variable sizes them.
  root.classList.add("desktop-titlebar-overlay");
  root.style.setProperty("--desktop-titlebar-inset", `${TITLE_BAR_INSET_PX}px`);
}

// A preload runs at document start, where `documentElement` may not exist yet.
// Either way this lands well before `ready-to-show`, which is when the window
// is first put on screen.
if (document.documentElement) markDocument();
else document.addEventListener("DOMContentLoaded", markDocument, { once: true });
