import { Menu, type MenuItemConstructorOptions, app } from "electron";
import type { RecentLabel } from "./recents";
import { openExternal } from "./window";

/**
 * The native application menu.
 *
 * The Edit menu is not decoration: in a `contextIsolation` window the standard
 * clipboard shortcuts are wired by menu roles, so without it Cmd+C / Cmd+V do
 * nothing at all in the UI.
 */
export interface MenuOptions {
  /** Prompt for a project directory and switch to it. */
  onOpenProject: () => void;
  /** Switch to an already-known project directory. */
  onOpenRecent: (dir: string) => void;
  /** Forget the recents list. */
  onClearRecents: () => void;
  /** Recent projects, most recent first, already labelled for display. */
  recents: readonly RecentLabel[];
  /** The project currently open, so its entry can be marked rather than repeated. */
  currentProject?: string;
}

export function buildMenu(options: MenuOptions): void {
  const isMac = process.platform === "darwin";

  // Rebuilt whenever the recents change, so the submenu is constructed from the
  // list rather than mutated in place — there is no state here to drift.
  const recentItems: MenuItemConstructorOptions[] =
    options.recents.length === 0
      ? [{ label: "No recent projects", enabled: false }]
      : [
          ...options.recents.map(
            (recent): MenuItemConstructorOptions => ({
              label: recent.label,
              // The open project stays listed — its position is information —
              // but picking it would tear down and re-fork the engine for no
              // reason, so it is checked rather than clickable.
              type: "checkbox",
              checked: recent.path === options.currentProject,
              enabled: recent.path !== options.currentProject,
              toolTip: recent.path,
              click: () => options.onOpenRecent(recent.path),
            }),
          ),
          { type: "separator" },
          { label: "Clear Menu", click: () => options.onClearRecents() },
        ];

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? ([
          {
            label: app.name,
            submenu: [
              { role: "about" },
              { type: "separator" },
              { role: "services" },
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" },
            ],
          },
        ] satisfies MenuItemConstructorOptions[])
      : []),
    {
      label: "File",
      submenu: [
        {
          label: "Open Project…",
          accelerator: "CmdOrCtrl+O",
          click: () => options.onOpenProject(),
        },
        { label: "Open Recent", submenu: recentItems },
        { type: "separator" },
        isMac ? { role: "close" } : { role: "quit" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        ...(isMac
          ? ([
              { role: "pasteAndMatchStyle" },
              { role: "delete" },
              { role: "selectAll" },
            ] satisfies MenuItemConstructorOptions[])
          : ([
              { role: "delete" },
              { type: "separator" },
              { role: "selectAll" },
            ] satisfies MenuItemConstructorOptions[])),
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Window",
      submenu: isMac
        ? [
            { role: "minimize" },
            { role: "zoom" },
            { type: "separator" },
            { role: "front" },
            { type: "separator" },
            { role: "window" },
          ]
        : [{ role: "minimize" }, { role: "zoom" }, { type: "separator" }, { role: "close" }],
    },
    {
      role: "help",
      submenu: [
        {
          label: "steamtrain on GitHub",
          // Via the shared wrapper, so every outbound link in the app goes
          // through one https-only gate rather than two divergent ones.
          click: () => openExternal("https://github.com/nilsonsfj/steamtrain"),
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
