import { contextBridge } from "electron";

/**
 * The renderer-facing surface, kept as small as it can usefully be.
 *
 * The UI talks to the engine over HTTP, not IPC, so nothing here is required
 * for it to work — this exists so the client can *detect* that it is running in
 * the desktop app and adapt (M2 adds project switching and notifications).
 * `ipcRenderer` itself is never exposed: anything the renderer may ask for gets
 * an explicit, validated function.
 */
contextBridge.exposeInMainWorld("steamtrainDesktop", {
  platform: process.platform,
  version: process.versions.electron,
});
