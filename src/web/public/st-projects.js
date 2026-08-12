/**
 * The project switcher — the first breadcrumb segment.
 *
 * The project was already sitting in the breadcrumb as dead text, so the
 * switcher costs no new chrome: that segment becomes the button, and the menu
 * lists every known project by name and real path with the one fact that
 * decides whether you want to go there — what is running or broken right now.
 *
 * Desktop only. Switching projects means forking the engine against another
 * directory, which only the app can do; in a browser tab the breadcrumb stays
 * the plain text it has always been.
 *
 * The popup lives in #projectMenu, a static element outside #crumbs, because
 * the breadcrumb is rebuilt on every render() — a search field rendered inside
 * it would lose focus and caret whenever a background poll landed. Only this
 * module ever writes into it, and only on open / query / selection changes.
 */
(function (ST) {
  "use strict";
  var S = ST.state;
  var h = ST.h;
  var clear = ST.clear;

  /** Rows from the last listProjects() call; null until the first one answers. */
  var rows = null;
  var query = "";
  /** Index into the currently rendered item list (rows + "Open a folder…"). */
  var active = 0;
  /** Document-level dismiss listeners, bound only while the menu is open. */
  var dismiss = null;

  function bridge() {
    return window.steamtrainDesktop || null;
  }

  /** Whether this build can switch projects at all. */
  function enabled() {
    var d = bridge();
    return Boolean(d && typeof d.listProjects === "function" && typeof d.openProject === "function");
  }

  function pop() {
    return document.getElementById("projectMenu");
  }

  /**
   * The breadcrumb's first segment. In the switcher the path shortens to the
   * project name — the full path is one line down in the menu, on every row —
   * and the caret marks it as the one clickable root of the hierarchy.
   */
  function crumbButton() {
    var name = (S.project && S.project.name) || "project";
    var open = Boolean(S.projectMenuOpen);
    return h("button", {
      class: "crumb-project" + (open ? " open" : ""),
      type: "button",
      id: "projectCrumb",
      "aria-haspopup": "menu",
      "aria-expanded": open ? "true" : "false",
      title: (S.project && S.project.cwd) || name,
      onClick: function (e) {
        e.stopPropagation();
        toggle();
      }
    },
      h("span", { class: "dot", "aria-hidden": "true" }),
      h("span", { class: "name", text: name }),
      h("span", { class: "caret", "aria-hidden": "true", text: "▾" })
    );
  }

  /** Rows matching the search box, by name or by path. */
  function filtered() {
    var list = rows || [];
    var q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter(function (p) {
      return p.name.toLowerCase().indexOf(q) >= 0 || p.displayPath.toLowerCase().indexOf(q) >= 0;
    });
  }

  /**
   * What the row says on its right: the one fact worth a glance. Running wins
   * over failed — work in flight is the more urgent reason to go somewhere.
   */
  function activity(p) {
    if (p.running > 0) return { text: p.running + " running", cls: "running" };
    if (p.failed > 0) return { text: p.failed + " failed", cls: "failed" };
    return { text: "idle", cls: "idle" };
  }

  function projectRow(p, index) {
    var state = activity(p);
    var row = h("button", {
      class: "proj-row" + (p.current ? " current" : "") + (index === active ? " active" : ""),
      type: "button",
      role: "menuitem",
      "data-index": index,
      onClick: function () { choose(p); },
      onMouseEnter: function () { setActive(index, false); }
    },
      h("span", { class: "dot" + (p.current ? " on" : ""), "aria-hidden": "true" }),
      h("span", { class: "who" },
        h("span", { class: "name", text: p.name }),
        h("span", { class: "path", text: p.displayPath })
      ),
      h("span", { class: "state " + state.cls, text: state.text })
    );
    return row;
  }

  /** The trailing row: the folder picker, which is the only way to reach a project the app has never opened. */
  function openFolderRow(index) {
    return h("button", {
      class: "proj-row open-folder" + (index === active ? " active" : ""),
      type: "button",
      role: "menuitem",
      "data-index": index,
      onClick: function () {
        close();
        var d = bridge();
        if (d && d.switchProject) d.switchProject();
      },
      onMouseEnter: function () { setActive(index, false); }
    },
      h("span", { class: "label", text: "Open a folder…" }),
      h("span", { class: "hint", text: "⌘O" })
    );
  }

  function render() {
    var box = pop();
    if (!box) return;
    clear(box);
    var list = filtered();

    var search = h("input", {
      class: "proj-search-field",
      type: "text",
      id: "projSearch",
      value: query,
      placeholder: "Search projects",
      "aria-label": "Search projects",
      autocomplete: "off",
      spellcheck: false,
      onInput: function (e) {
        query = e.target.value;
        // A new filter invalidates the cursor — start it on the first match.
        active = 0;
        render();
      }
      // Navigation keys are NOT bound here: they are handled document-wide
      // while the menu is open, so ↑/↓/Enter still work if focus has drifted
      // off the field (a row clicked, the window refocused).
    });
    box.appendChild(h("div", { class: "proj-search" },
      h("span", { class: "slash", "aria-hidden": "true", text: "/" }),
      search
    ));

    if (rows === null) {
      box.appendChild(h("div", { class: "proj-empty", text: "Loading projects…" }));
    } else if (list.length === 0) {
      box.appendChild(h("div", {
        class: "proj-empty",
        text: rows.length ? "No project matches “" + query.trim() + "”" : "No other projects opened yet"
      }));
    } else {
      list.forEach(function (p, i) { box.appendChild(projectRow(p, i)); });
    }

    box.appendChild(h("div", { class: "proj-rule" }));
    box.appendChild(openFolderRow(list.length));
    box.hidden = false;

    // Restore the caret the re-render just threw away: the field is rebuilt on
    // every keystroke, so without this typing would reverse itself.
    var field = document.getElementById("projSearch");
    if (field) {
      field.focus();
      var end = field.value.length;
      try { field.setSelectionRange(end, end); } catch (e) {}
    }
  }

  /** Move the keyboard cursor. `redraw` is false when the mouse already moved it. */
  function setActive(index, redraw) {
    var count = filtered().length + 1;
    if (count < 1) return;
    active = ((index % count) + count) % count;
    if (redraw === false) {
      var box = pop();
      if (!box) return;
      var items = box.querySelectorAll(".proj-row");
      for (var i = 0; i < items.length; i++) items[i].classList.toggle("active", i === active);
      return;
    }
    render();
  }

  /**
   * Bound on the document in the capture phase while the menu is open, so the
   * four navigation keys belong to it wherever focus happens to be — and so no
   * surface underneath ever sees them. Everything else (typing) falls through
   * to the search field untouched.
   */
  function onKey(e) {
    var taken = function () { e.preventDefault(); e.stopPropagation(); };
    if (e.key === "Escape") {
      taken();
      close();
      return;
    }
    // Tab is left to the browser, but the menu goes away with it: focus is
    // moving on to the page behind, and a popup still hanging over it — still
    // owning the arrow keys — would be the odd state.
    if (e.key === "Tab") {
      close();
      return;
    }
    if (e.key === "ArrowDown") { taken(); setActive(active + 1, true); return; }
    if (e.key === "ArrowUp") { taken(); setActive(active - 1, true); return; }
    if (e.key === "Enter") {
      taken();
      var list = filtered();
      if (active < list.length) choose(list[active]);
      else {
        close();
        var d = bridge();
        if (d && d.switchProject) d.switchProject();
      }
    }
  }

  /**
   * Switch. Picking the project already open is a no-op the main process would
   * refuse anyway — closing the menu is the honest response to it.
   */
  function choose(p) {
    close();
    if (!p || p.current) return;
    var d = bridge();
    if (d && d.openProject) d.openProject(p.path);
  }

  /** Anchor the popup under the crumb it belongs to, in viewport coordinates. */
  function position() {
    var box = pop();
    var crumb = document.getElementById("projectCrumb");
    if (!box || !crumb) return;
    var rect = crumb.getBoundingClientRect();
    box.style.left = Math.round(rect.left) + "px";
    box.style.top = Math.round(rect.bottom + 6) + "px";
  }

  function bindDismiss() {
    unbindDismiss();
    var away = function (e) {
      var box = pop();
      var crumb = document.getElementById("projectCrumb");
      if (box && box.contains(e.target)) return;
      if (crumb && crumb.contains(e.target)) return;
      close();
    };
    var keys = function (e) { onKey(e); };
    // The popup is anchored in viewport coordinates, so anything that moves
    // the crumb has to move it too rather than leave it hanging.
    var moved = function () { position(); };
    document.addEventListener("mousedown", away, true);
    document.addEventListener("keydown", keys, true);
    window.addEventListener("resize", moved);
    dismiss = { away: away, keys: keys, moved: moved };
  }

  function unbindDismiss() {
    if (!dismiss) return;
    document.removeEventListener("mousedown", dismiss.away, true);
    document.removeEventListener("keydown", dismiss.keys, true);
    window.removeEventListener("resize", dismiss.moved);
    dismiss = null;
  }

  function open() {
    if (!enabled() || S.projectMenuOpen) return;
    S.projectMenuOpen = true;
    query = "";
    active = 0;
    // Drawn empty first so the menu appears on the click rather than after a
    // filesystem walk; the rows land a moment later. Nothing is cached between
    // opens on purpose — "2 running" from a minute ago is worse than waiting.
    render();
    position();
    bindDismiss();
    ST.shell.renderCrumbs();
    bridge().listProjects().then(function (list) {
      if (!S.projectMenuOpen) return;
      rows = Array.isArray(list) ? list : [];
      render();
      position();
    }).catch(function () {
      if (!S.projectMenuOpen) return;
      rows = [];
      render();
    });
  }

  function close() {
    unbindDismiss();
    var box = pop();
    if (box) {
      clear(box);
      box.hidden = true;
    }
    if (!S.projectMenuOpen) return;
    S.projectMenuOpen = false;
    rows = null;
    query = "";
    ST.shell.renderCrumbs();
  }

  function toggle() {
    if (S.projectMenuOpen) close();
    else open();
  }

  ST.projects = {
    enabled: enabled,
    crumbButton: crumbButton,
    open: open,
    close: close,
    toggle: toggle
  };
})(window.Steamtrain);
