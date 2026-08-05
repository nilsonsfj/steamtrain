import { Menu, type MenuItemConstructorOptions, app } from "electron";
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
}

export function buildMenu(options: MenuOptions): void {
  const isMac = process.platform === "darwin";

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
