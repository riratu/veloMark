(() => {
  // src/app/dom.js
  var $ = (s, el = document) => el.querySelector(s);
  var $$ = (s, el = document) => [...el.querySelectorAll(s)];
  var q = $("#q");
  var vault = document.body.dataset.vault || "";
  var label = document.body.dataset.label || "notes";
  var call = (url, opts = {}) => fetch(url, { ...opts, headers: { ...opts.headers, "X-Vault": vault } });
  var typing = (el) => el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
  var results = $("#results");
  var palette = $("#palette");
  var list = () => results || palette;
  function tokenize(s) {
    const out = [];
    let cur = "", quoted = false;
    for (const ch of s) {
      if (ch === '"') {
        if (quoted && cur) {
          out.push(cur);
          cur = "";
        }
        quoted = !quoted;
      } else if (!quoted && /\s/.test(ch)) {
        if (cur) out.push(cur);
        cur = "";
      } else cur += ch;
    }
    if (cur) out.push(cur);
    return out;
  }
  var setting = (k) => {
    try {
      return localStorage.getItem(k) || "";
    } catch (e) {
      return "";
    }
  };
  var setSetting = (k, v) => {
    try {
      v ? localStorage.setItem(k, v) : localStorage.removeItem(k);
    } catch (e) {
    }
  };
  var mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  var focused = () => document.body.classList.contains("focus");
  var openNote = () => focused() && $("#peek .live")?.dataset.path || null;
  var withOpen = (p) => {
    const u = new URL(location.href);
    p ? u.searchParams.set("open", p) : u.searchParams.delete("open");
    return u.pathname + u.search;
  };
  var phone = () => matchMedia("(max-width: 52rem)").matches;
  var dirOf = (p) => p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
  var noteURL = (p) => "/n/" + p.split("/").map(encodeURIComponent).join("/");
  var under = (d, parent) => d.startsWith(parent + "/");
  var quoteTok = (t) => /\s/.test(t) ? `"${t}"` : t;

  // src/app/links.js
  var outside = (href) => {
    try {
      const u = new URL(href, location.href);
      return u.origin !== location.origin && /^(https?|mailto):$/.test(u.protocol) ? u.href : "";
    } catch (e) {
      return "";
    }
  };
  function init() {
    if (matchMedia("(display-mode: standalone), (display-mode: window-controls-overlay), (display-mode: minimal-ui)").matches) {
      const openOut = async (href) => {
        const res = await call("/openlink", { method: "POST", body: new URLSearchParams({ url: href }) }).catch(() => null);
        if (!res?.ok) nativeOpen(href, "_blank");
      };
      const nativeOpen = window.open.bind(window);
      window.open = (href, ...rest) => {
        const out = outside(href);
        if (!out) return nativeOpen(href, ...rest);
        openOut(out);
        return null;
      };
      document.addEventListener("click", (e) => {
        const a = e.target.closest?.("a[href]");
        const out = a && !a.hasAttribute("download") && outside(a.href);
        if (!out || e.defaultPrevented || e.button !== 0) return;
        e.preventDefault();
        openOut(out);
      }, true);
    }
  }

  // src/app/state.js
  var S = {
    sel: -1,
    // the selected row in the list or the dropdown
    // Arrows pressed while a search is still on its way are kept and applied
    // to its results, so typing and then going straight for ↓ is not lost.
    pending: false,
    queued: 0,
    keepPlace: false,
    // a rebuilt list keeps its scroll and selection
    marked: /* @__PURE__ */ new Set(),
    // rows marked with Shift, from anchor
    anchor: -1,
    peekFor: "",
    // the note shown under the results
    peekReady: null,
    // that note, once loaded
    peekSave: null,
    // its saving
    peekView: null,
    // its editor
    editView: null
    // the editor on the edit page
  };

  // src/app/toast.js
  function toastNext(msg, undo) {
    try {
      sessionStorage.setItem("toast", JSON.stringify({ msg, undo }));
    } catch (e) {
    }
  }
  var history30 = [];
  var undoing = false;
  async function runUndo(step) {
    const i = history30.indexOf(step);
    if (i >= 0) history30.splice(i, 1);
    undoing = true;
    try {
      await step.fn();
    } finally {
      undoing = false;
    }
  }
  function undoLast() {
    const step = history30[history30.length - 1];
    if (step) runUndo(step);
    else toast("Nothing more to undo");
  }
  function toast(msg, action) {
    $(".toast")?.remove();
    const t = document.createElement("div");
    t.className = "toast";
    t.textContent = msg;
    if (action && !undoing) {
      const step = { msg, fn: action.fn };
      history30.push(step);
      if (history30.length > 30) history30.shift();
      const b = document.createElement("button");
      b.textContent = action.label;
      b.title = (navigator.platform.includes("Mac") ? "\u2318" : "Ctrl+") + "Z";
      b.addEventListener("click", () => {
        t.remove();
        runUndo(step);
      });
      t.append(b);
      t.classList.add("long");
    }
    t.addEventListener("animationend", () => t.remove());
    document.body.append(t);
  }

  // src/app/upload.js
  async function upload(file, note) {
    if (!note) {
      toast("Name the note first, then drop files into it");
      return "";
    }
    let name = file.name;
    if (!name || /^image\.\w+$/.test(name)) {
      const ext = (file.type.split("/")[1] || "png").replace("jpeg", "jpg");
      name = "pasted-" + (/* @__PURE__ */ new Date()).toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-") + "." + ext;
    }
    const fd = new FormData();
    fd.append("note", note);
    fd.append("file", file, name);
    const res = await call("/upload", { method: "POST", body: fd });
    if (!res.ok) {
      toast((await res.text()).trim());
      return "";
    }
    const saved = (await res.json()).name;
    const alt = name.replace(/\.[^.]+$/, "");
    return file.type.startsWith("image/") ? `![${alt}](${saved})` : `[${name}](${saved})`;
  }
  function init2() {
    document.addEventListener("drop", (e) => {
      if (e.defaultPrevented || !e.dataTransfer?.files.length) return;
      const view = e.target.closest?.(".editor") ? S.editView : e.target.closest?.(".peek") ? S.peekView : null;
      if (!view) return;
      e.preventDefault();
      if (!GoNotesEditor.dropFiles(view, [...e.dataTransfer.files], e.clientX, e.clientY)) toast("Files cannot go into this note");
    });
    for (const ev of ["dragover", "drop"]) {
      document.addEventListener(ev, (e) => {
        if (e.dataTransfer?.types.includes("Files") && !e.defaultPrevented) e.preventDefault();
      });
    }
  }

  // src/app/editor.js
  var close = async () => {
  };
  function initEditor() {
    const form = $("#editor");
    if (!form) return;
    const body = $("#body", form);
    const live = $("#live", form);
    let dirty = false;
    document.body.classList.add("dim");
    S.editView = GoNotesEditor.mount(live, {
      doc: body.value,
      source: setting("render") === "source",
      onFile: (f) => upload(f, target()),
      dir: live.dataset.dir,
      vim: setting("vim") === "on",
      focus: "focus" in live.dataset,
      onChange: (t) => {
        body.value = t;
        dirty = true;
        autosave();
      },
      onSave: () => saveNow(),
      onClose: () => close()
    });
    const pathIn = $("input[name=path]", form);
    const origIn = $("input[name=orig]", form);
    const modIn = $("input[name=mod]", form);
    const closeLink = $(".editor-head a.btn", form);
    const status = $("#savestate", form);
    let stimer, saving = null, again = false, stopped = false;
    const setStatus = (t) => {
      if (status) status.textContent = t;
    };
    function target() {
      const p = document.activeElement === pathIn ? origIn.value : pathIn.value.trim();
      return p && !p.endsWith("/") ? p : "";
    }
    function saveBody(p) {
      const data = new URLSearchParams(new FormData(form));
      data.set("path", p);
      return data;
    }
    function autosave() {
      clearTimeout(stimer);
      stimer = setTimeout(saveNow, 700);
    }
    async function saveNow() {
      clearTimeout(stimer);
      if (saving) {
        again = true;
        return saving;
      }
      const p = target();
      if (stopped || !dirty || !p) return;
      dirty = false;
      setStatus("Saving\u2026");
      saving = (async () => {
        try {
          const res = await call("/save", { method: "POST", headers: { Accept: "application/json" }, body: saveBody(p) });
          if (!res.ok) {
            stopped = true;
            form.requestSubmit();
            return;
          }
          const { path, mod } = await res.json();
          modIn.value = mod;
          if (document.activeElement !== pathIn) pathIn.value = path;
          if (path !== origIn.value) {
            origIn.value = path;
            history.replaceState(null, "", "/edit/" + path.split("/").map(encodeURIComponent).join("/"));
            closeLink.href = noteURL(path);
          }
          setStatus("Saved");
        } catch (e) {
          dirty = true;
          setStatus("Not saved");
        } finally {
          saving = null;
          if (again) {
            again = false;
            saveNow();
          }
        }
      })();
      return saving;
    }
    pathIn.addEventListener("input", () => dirty = true);
    pathIn.addEventListener("change", () => {
      if (pathIn.value.trim() !== origIn.value) saveNow();
    });
    document.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        form.requestSubmit();
      }
      if (e.key === "Escape" && !e.defaultPrevented && !(setting("vim") === "on" && e.target.closest?.(".cm-editor"))) {
        e.preventDefault();
        close();
      }
    });
    close = async () => {
      await saveNow();
      if (!dirty || confirm("Your changes are not saved. Leave anyway?")) {
        dirty = false;
        location.href = closeLink.href;
      }
    };
    closeLink.addEventListener("click", (e) => {
      if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      close();
    });
    form.addEventListener("submit", (e) => {
      if (saving) {
        e.preventDefault();
        saving.then(() => form.requestSubmit());
        return;
      }
      clearTimeout(stimer);
      dirty = false;
    });
    window.addEventListener("beforeunload", (e) => {
      if (dirty && (stopped || !target())) e.preventDefault();
    });
    window.addEventListener("pagehide", () => {
      const p = target();
      if (!dirty || stopped || !p) return;
      dirty = false;
      call("/save", { method: "POST", keepalive: true, headers: { Accept: "application/json" }, body: saveBody(p) });
    });
  }

  // src/app/marks.js
  var several = () => S.marked.size > 1 ? [...marked] : null;
  function showMarks() {
    $$(".hit", list() || document).forEach((h) => h.classList.toggle("marked", S.marked.has(h.dataset.path)));
  }
  function markTo(i) {
    const hits = $$(".hit", list() || document);
    if (S.anchor < 0) S.anchor = S.sel >= 0 ? S.sel : i;
    const [a, b] = S.anchor < i ? [S.anchor, i] : [i, S.anchor];
    S.marked = new Set(hits.slice(a, b + 1).map((h) => h.dataset.path));
    showMarks();
  }
  function unmark() {
    S.anchor = -1;
    if (!S.marked.size) return;
    S.marked = /* @__PURE__ */ new Set();
    showMarks();
  }
  function stepTo(i, extend) {
    if (extend && S.anchor < 0) S.anchor = Math.max(S.sel, 0);
    select(i);
    extend ? markTo(S.sel) : unmark();
  }

  // src/app/tour.js
  var TOUR = {
    note: "<b>2.</b> Type a name for your first note in the search box and press <kbd>Enter</kbd>. It opens, ready to write in.",
    delete: "<b>3.</b> Write something: it saves by itself. Press <kbd>Esc</kbd> to get back to the list, then <kbd>Delete</kbd> to delete the selected note. A message at the bottom lets you undo it.",
    done: "That's all. <kbd>?</kbd> shows every key, <kbd>Ctrl K</kbd> searches from anywhere."
  };
  function showTour() {
    $(".tour")?.remove();
    const step = setting("tour");
    if (!TOUR[step] || !(results || $("#editor"))) return;
    const card = document.createElement("aside");
    card.className = "tour";
    card.innerHTML = TOUR[step];
    const skip = document.createElement("button");
    skip.type = "button";
    skip.className = "btn ghost";
    skip.textContent = step === "done" ? "Close" : "Skip the tour";
    skip.addEventListener("click", () => {
      setSetting("tour", "");
      card.remove();
    });
    card.append(skip);
    document.body.append(card);
    if (step === "done") {
      setSetting("tour", "");
      setTimeout(() => card.remove(), 8e3);
    }
  }
  var tourStep = (from, to) => {
    if (setting("tour") === from) {
      setSetting("tour", to);
      showTour();
    }
  };
  function init3() {
    if (new URL(location.href).searchParams.has("tour")) {
      setSetting("tour", "note");
      const u = new URL(location.href);
      u.searchParams.delete("tour");
      history.replaceState(history.state, "", u.pathname + u.search);
    }
    if (focused()) tourStep("note", "delete");
    showTour();
    document.addEventListener("click", (e) => {
      if (!e.target.closest?.("[data-tour]")) return;
      e.preventDefault();
      toggleOptions(false);
      setSetting("tour", "note");
      showTour();
    });
  }

  // src/app/actions.js
  async function newNote(from = "") {
    const dir = $(".facets a.on[data-dir]")?.dataset.dir || document.body.dataset.newdir || "";
    const res = await call("/new", {
      method: "POST",
      headers: { Accept: "application/json" },
      body: new URLSearchParams(from ? { from } : { dir })
    });
    if (!res.ok) {
      toast((await res.text()).trim());
      return;
    }
    const { path: made, url } = await res.json();
    try {
      sessionStorage.setItem("caret", "end");
      sessionStorage.setItem("fresh", made);
    } catch (e) {
    }
    location.href = url;
  }
  var rowOf = (paths) => $$(".hit", list() || document).findIndex((h) => paths.includes(h.dataset.path));
  function stayNear(paths) {
    const at = rowOf(paths);
    if (at >= 0) S.sel = Math.max(at - 1, 0);
  }
  function landAfterMove(paths, at) {
    const still = rowOf(paths);
    if (still >= 0) select(still);
    else if (at >= 0) select(Math.max(at - 1, 0));
  }
  async function deleteMany(paths) {
    stayNear(paths);
    const done = [];
    for (const path of paths) {
      const res = await call("/delete", { method: "POST", headers: { Accept: "application/json" }, body: new URLSearchParams({ path }) });
      if (res.ok) done.push({ path, trash: (await res.json()).trash });
    }
    unmark();
    await refreshPage();
    toast(`Deleted ${done.length} notes`, done.length && { label: "Undo", fn: async () => {
      for (const d of done) await call("/restore", { method: "POST", body: new URLSearchParams(d) });
      await refreshPage();
      toast(`Restored ${done.length} notes`);
    } });
  }
  async function moveMany(paths, dir, undo = false) {
    const done = [];
    const at = rowOf(paths);
    for (const path of paths) {
      if (dirOf(path) === dir) continue;
      const res = await call("/move", { method: "POST", body: new URLSearchParams({ path, dir }) });
      if (res.ok) done.push({ from: path, to: (await res.json()).path });
      else toast((await res.text()).trim());
    }
    unmark();
    await refreshPage();
    landAfterMove(done.map((d) => d.to), at);
    if (undo || !done.length) return;
    toast(`Moved ${done.length} notes to ` + (dir || "the top level"), { label: "Undo", fn: async () => {
      for (const d of done) await call("/move", { method: "POST", body: new URLSearchParams({ path: d.to, dir: dirOf(d.from) }) });
      await refreshPage();
    } });
  }
  async function moveToVault(paths, to) {
    const done = [];
    const at = rowOf(paths);
    const open2 = openNote() || $("#editor input[name=orig]")?.value;
    if (paths.includes(open2)) await S.peekSave?.flush();
    for (const path of paths) {
      const res = await call("/movevault", { method: "POST", body: new URLSearchParams({ path, to }) });
      if (res.ok) done.push({ from: path, to: (await res.json()).path });
      else toast((await res.text()).trim());
    }
    if (!done.length) return;
    const msg = (done.length === 1 ? "Moved to " : `Moved ${done.length} notes to `) + to;
    const moves = done.map((d) => ({ path: d.to, dir: dirOf(d.from) }));
    if (done.some((d) => d.from === open2)) {
      toastNext(msg, { vault: to, moves });
      location.replace($("#editor") ? "/" : withOpen(null));
      return;
    }
    unmark();
    await refreshPage();
    landAfterMove([], at);
    toast(msg, { label: "Undo", fn: () => moveBack(to, moves) });
  }
  async function moveBack(from, moves) {
    for (const m of moves) await fetch("/movevault", { method: "POST", headers: { "X-Vault": from }, body: new URLSearchParams({ path: m.path, to: vault, dir: m.dir }) });
    await refreshPage();
  }
  async function moveNote(from, dir, undoable) {
    if (dirOf(from) === dir) return;
    const res = await call("/move", { method: "POST", body: new URLSearchParams({ path: from, dir }) });
    if (!res.ok) {
      toast((await res.text()).trim());
      return;
    }
    const { path } = await res.json();
    const at = rowOf([from]);
    await afterMove(from, path);
    landAfterMove([path], at);
    toast(
      "Moved to " + (dir || "the top level"),
      undoable && { label: "Undo", fn: () => moveNote(path, dirOf(from), false) }
    );
  }
  async function moveFolder(from, dir, undoable) {
    const res = await call("/movedir", { method: "POST", body: new URLSearchParams({ path: from, dir }) });
    if (!res.ok) {
      toast((await res.text()).trim());
      return;
    }
    const { path } = await res.json();
    if (path === from) return;
    await afterMove(from, path, true);
    toast(
      "Moved " + from.split("/").pop() + " to " + (dir || "the top level"),
      undoable && { label: "Undo", fn: () => moveFolder(path, dirOf(from), false) }
    );
  }
  async function afterMove(from, to, folder = false) {
    const moved = (p) => p === from ? to : folder && p.startsWith(from + "/") ? to + p.slice(from.length) : null;
    const open2 = openNote();
    if (open2 && moved(open2) !== null) {
      await S.peekSave?.flush();
      location.replace("/?open=" + encodeURIComponent(moved(open2)));
      return;
    }
    const orig = $("#editor input[name=orig]");
    if (orig && moved(orig.value) !== null) {
      const p = moved(orig.value);
      orig.value = p;
      $("#editor input[name=path]").value = p;
      history.replaceState(null, "", "/edit/" + p.split("/").map(encodeURIComponent).join("/"));
    }
    if (folder && q) {
      const toks = tokenize(q.value);
      const next = toks.map((t) => {
        const m = /^in:(.+)$/i.exec(t);
        return quoteTok(m && moved(m[1]) !== null ? "in:" + moved(m[1]) : t);
      }).join(" ");
      if (next !== toks.map(quoteTok).join(" ")) {
        q.value = next;
        if (results) history.replaceState(null, "", next ? "/?q=" + encodeURIComponent(next) : "/");
      }
    }
    await refreshPage();
  }
  async function excludeDir(dir, on) {
    const res = await call("/exclude", { method: "POST", body: new URLSearchParams(on ? { dir, on: "1" } : { dir }) });
    if (!res.ok) {
      toast((await res.text()).trim());
      return;
    }
    await refreshPage();
    toast(
      on ? dir.split("/").pop() + " is left out of searches" : dir.split("/").pop() + " is searched again",
      { label: "Undo", fn: () => excludeDir(dir, !on) }
    );
  }
  async function deleteNote(p) {
    const res = await call("/delete", {
      method: "POST",
      headers: { Accept: "application/json" },
      body: new URLSearchParams({ path: p })
    });
    if (!res.ok) {
      toast((await res.text()).trim());
      return;
    }
    const { trash } = await res.json();
    tourStep("delete", "done");
    const name = p.split("/").pop();
    if (openNote() === p) {
      toastNext("Deleted " + name, { trash, path: p });
      const d = dirOf(p);
      location.href = d ? "/?q=" + encodeURIComponent(quoteTok("in:" + d)) : "/";
      return;
    }
    stayNear([p]);
    await refreshPage();
    toast("Deleted " + name, { label: "Undo", fn: () => restoreNote(trash, p) });
  }
  async function deleteFolder(d) {
    const name = d.split("/").pop();
    const count = (li) => Number($("a > span", li)?.textContent) || 0;
    const lis = $$(".facets li[data-dir]").filter((li) => li.dataset.dir === d || under(li.dataset.dir, d));
    const notes = $("#opt-sub")?.checked ? count(lis.find((li) => li.dataset.dir === d)) : lis.reduce((n, li) => n + count(li), 0);
    const what = `${notes} note${notes === 1 ? "" : "s"}`;
    if (!confirm(`Delete the folder \u201C${name}\u201D and ${what} in it? It goes to .trash; Undo brings it back.`)) return;
    const res = await call("/delete", {
      method: "POST",
      headers: { Accept: "application/json" },
      body: new URLSearchParams({ path: d })
    });
    if (!res.ok) {
      toast((await res.text()).trim());
      return;
    }
    const { trash } = await res.json();
    const on = $(".facets a.on[data-dir]")?.dataset.dir;
    const open2 = openNote();
    if (on && (on === d || under(on, d)) || open2 && under(open2, d)) {
      toastNext("Deleted " + name, { trash, path: d });
      location.href = dirOf(d) ? "/?q=" + encodeURIComponent(quoteTok("in:" + dirOf(d))) : "/";
      return;
    }
    await refreshPage();
    toast("Deleted " + name, { label: "Undo", fn: () => restoreNote(trash, d) });
  }
  async function restoreNote(trash, p) {
    const res = await call("/restore", { method: "POST", body: new URLSearchParams({ trash, path: p }) });
    if (!res.ok) {
      toast((await res.text()).trim());
      return;
    }
    await refreshPage();
    toast("Restored " + p.split("/").pop());
  }
  function init4() {
    try {
      const t = JSON.parse(sessionStorage.getItem("toast") || "null");
      sessionStorage.removeItem("toast");
      const undo = t?.undo && (t.undo.moves ? () => moveBack(t.undo.vault, t.undo.moves) : () => restoreNote(t.undo.trash, t.undo.path));
      if (t) toast(t.msg, undo && { label: "Undo", fn: undo });
    } catch (e) {
    }
  }

  // src/app/folders.js
  function renameFolder(link) {
    const from = link.dataset.dir;
    const input = document.createElement("input");
    input.className = "renamefolder";
    input.value = from.split("/").pop();
    input.spellcheck = false;
    link.hidden = true;
    link.after(input);
    input.focus();
    input.select();
    let done = false;
    const finish = async (keep) => {
      if (done) return;
      done = true;
      const name = input.value.trim();
      if (!keep || !name || name === from.split("/").pop()) {
        input.remove();
        link.hidden = false;
        return;
      }
      if (await renameDir(from, name, true)) return;
      done = false;
      input.focus();
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        finish(true);
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        finish(false);
      }
    });
    input.addEventListener("blur", () => finish(true));
  }
  async function renameDir(from, name, undoable) {
    const res = await call("/renamedir", { method: "POST", body: new URLSearchParams({ path: from, name }) });
    if (!res.ok) {
      toast((await res.text()).trim());
      return false;
    }
    const { path } = await res.json();
    const closed = closedFolds();
    for (const c of [...closed]) {
      if (c === from || under(c, from)) {
        closed.delete(c);
        closed.add(path + c.slice(from.length));
      }
    }
    setSetting(foldKey(), closed.size ? JSON.stringify([...closed]) : "");
    await afterMove(from, path, true);
    toast("Renamed to " + name, undoable && { label: "Undo", fn: () => renameDir(path, from.split("/").pop(), false) });
    return true;
  }
  function foldSidebar(on = document.documentElement.dataset.side !== "folded") {
    if (on) document.documentElement.dataset.side = "folded";
    else delete document.documentElement.dataset.side;
    setSetting("sidebar", on ? "folded" : "");
    for (const v of [S.peekView, S.editView]) v?.requestMeasure();
  }
  var foldKey = () => "folds:" + vault;
  var closedFolds = () => {
    try {
      return new Set(JSON.parse(setting(foldKey()) || "[]"));
    } catch (e) {
      return /* @__PURE__ */ new Set();
    }
  };
  function applyFolds() {
    const lis = $$(".facets li[data-dir]");
    const names = lis.map((li) => li.dataset.dir);
    const parents = new Set(names.filter((d) => names.some((n) => under(n, d))));
    const closed = closedFolds();
    const on = $(".facets a.on[data-dir]")?.dataset.dir;
    for (const c of closed) if (on && under(on, c)) closed.delete(c);
    for (const li of lis) {
      const d = li.dataset.dir;
      let arrow = $(".fold", li);
      if (!arrow) {
        arrow = document.createElement("button");
        arrow.type = "button";
        arrow.className = "fold";
        arrow.tabIndex = -1;
        li.prepend(arrow);
      }
      arrow.disabled = !parents.has(d);
      arrow.setAttribute("aria-expanded", String(parents.has(d) && !closed.has(d)));
      arrow.title = parents.has(d) ? closed.has(d) ? "Open" : "Close" : "";
      li.hidden = [...closed].some((c) => under(d, c));
    }
    const all = $("#foldall");
    if (all) {
      const anyOpen = [...parents].some((d) => !closed.has(d));
      all.hidden = !parents.size;
      all.dataset.close = String(anyOpen);
      all.title = anyOpen ? "Close all folders" : "Open all folders";
      all.textContent = anyOpen ? "\u229F" : "\u229E";
    }
  }
  function setFolds(closed) {
    setSetting(foldKey(), closed.size ? JSON.stringify([...closed]) : "");
    applyFolds();
  }
  function openFold(d) {
    const closed = closedFolds();
    if (d && closed.delete(d)) setFolds(closed);
  }
  function newFolder(parent = $(".facets a.on[data-dir]")?.dataset.dir || "") {
    $(".facets .newfolder")?.remove();
    const li = document.createElement("li");
    li.className = "newfolder";
    const input = document.createElement("input");
    input.placeholder = "folder/name";
    input.spellcheck = false;
    input.value = parent ? parent + "/" : "";
    li.append(input);
    $(".facets li")?.after(li);
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    let done = false;
    input.addEventListener("keydown", async (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        done = true;
        li.remove();
        return;
      }
      if (e.key !== "Enter") return;
      e.preventDefault();
      const dir = input.value.trim().replace(/^\/+|\/+$/g, "");
      if (!dir) {
        done = true;
        li.remove();
        return;
      }
      const res = await call("/mkdir", { method: "POST", body: new URLSearchParams({ dir }) });
      if (!res.ok) {
        toast((await res.text()).trim());
        return;
      }
      done = true;
      await refreshPage();
      toast("Created " + (await res.json()).dir);
    });
    input.addEventListener("blur", () => setTimeout(() => {
      if (!done) li.remove();
    }, 150));
  }
  var fsel = -1;
  var folders = () => $$(".facets a[data-tok]").filter((a) => !a.closest("li").hidden);
  var inFolders = () => fsel >= 0;
  var currentNote = () => openNote() || S.sel >= 0 && $$(".hit", list() || document)[S.sel]?.dataset.path;
  function pickFolder(i) {
    const all = folders();
    fsel = Math.max(0, Math.min(all.length - 1, i));
    all.forEach((a, j) => a.classList.toggle("cur", j === fsel));
    all[fsel]?.scrollIntoView({ block: "nearest" });
    $(".side").classList.add("kbd");
  }
  function leaveFolders() {
    fsel = -1;
    folders().forEach((a) => a.classList.remove("cur"));
    $(".side")?.classList.remove("kbd");
  }
  function enterFolders() {
    if (document.documentElement.dataset.side === "folded") foldSidebar(false);
    const all = folders();
    if (!all.length) return;
    let i = all.findIndex((a) => a.classList.contains("on"));
    if (i < 0) {
      const p = currentNote();
      if (p) i = all.findIndex((a) => a.dataset.tok === "in:" + dirOf(p));
    }
    pickFolder(Math.max(i, 0));
  }
  function folderKeys(e) {
    if (typing(document.activeElement)) return false;
    if (!inFolders()) {
      if (e.key === "ArrowLeft" && results) {
        e.preventDefault();
        closePalette();
        enterFolders();
        return true;
      }
      return false;
    }
    const a = folders()[fsel];
    switch (e.key) {
      case "ArrowDown":
      case "j":
        pickFolder(fsel + 1);
        break;
      case "ArrowUp":
      case "k":
        pickFolder(fsel - 1);
        break;
      case "Home":
        pickFolder(0);
        break;
      case "End":
        pickFolder(folders().length - 1);
        break;
      case "Enter":
        openFold(a.dataset.dir);
        leaveFolders();
        location.href = a.dataset.tok ? "/?q=" + encodeURIComponent(quoteTok(a.dataset.tok)) : "/";
        break;
      case "m": {
        const p = currentNote();
        leaveFolders();
        if (p) moveNote(p, a.dataset.tok.replace(/^in:/, ""), true);
        else toast("No note selected to move");
        break;
      }
      case "n":
        leaveFolders();
        newFolder(a.dataset.dir || "");
        break;
      // → opens a closed folder, ← closes an open one; → on any other
      // goes back to the list, as Esc does.
      case "ArrowRight":
      case "ArrowLeft": {
        const d = a.dataset.dir;
        const closed = closedFolds();
        const opening = e.key === "ArrowRight";
        const hasFolders = d && folders().some((f) => f.dataset.dir && under(f.dataset.dir, d)) || closed.has(d);
        if (hasFolders && closed.has(d) === opening) {
          opening ? closed.delete(d) : closed.add(d);
          setFolds(closed);
          pickFolder(folders().indexOf(a));
        } else if (opening) leaveFolders();
        break;
      }
      case "Escape":
        leaveFolders();
        break;
      default:
        return false;
    }
    e.preventDefault();
    return true;
  }
  function folderStep(key) {
    leaveFolders();
    const all = folders();
    const cur = all.findIndex((a) => a.classList.contains("on"));
    if (key === "ArrowUp" || key === "ArrowDown") {
      const a = all[Math.max(0, Math.min(all.length - 1, cur + (key === "ArrowDown" ? 1 : -1)))];
      if (!a || a === all[cur]) return;
      const v = new URL(a.href).searchParams.get("q") || "";
      q.value = v ? v.replace(/\s*$/, " ") : "";
      runSearch();
      a.scrollIntoView({ block: "nearest" });
      return;
    }
    const d = all[cur]?.dataset.dir;
    if (!d) return;
    const closed = closedFolds();
    if (key === "ArrowRight" ? closed.delete(d) : !closed.has(d) && closed.add(d)) setFolds(closed);
  }
  function init5() {
    $$(".foldersbtn").forEach((b) => b.addEventListener("click", () => {
      const panel = b.dataset.panel;
      const open2 = document.body.dataset.panel !== panel;
      if (open2) document.body.dataset.panel = panel;
      else delete document.body.dataset.panel;
      $$(".foldersbtn").forEach((o) => o.setAttribute("aria-expanded", String(open2 && o === b)));
    }));
    $("#sidefold")?.addEventListener("click", () => foldSidebar(true));
    $("#sideopen")?.addEventListener("click", () => foldSidebar(false));
    document.addEventListener("click", (e) => {
      const arrow = e.target.closest?.(".fold");
      if (arrow) {
        e.preventDefault();
        const d = arrow.closest("li").dataset.dir;
        const closed = closedFolds();
        closed.has(d) ? closed.delete(d) : closed.add(d);
        setFolds(closed);
        return;
      }
      const all = e.target.closest?.("#foldall");
      if (!all) return;
      const names = $$(".facets li[data-dir]").map((li) => li.dataset.dir);
      const parents = names.filter((d) => names.some((n) => under(n, d)));
      setFolds(all.dataset.close === "true" ? new Set(parents) : /* @__PURE__ */ new Set());
    });
    applyFolds();
    document.addEventListener("click", (e) => {
      const a = e.target.closest?.(".facets a[data-dir]");
      if (a && e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) openFold(a.dataset.dir);
    });
    document.addEventListener("click", (e) => {
      if (e.target.closest("#addfolder")) newFolder();
    });
    document.addEventListener("pointerdown", (e) => {
      if (inFolders() && !e.target.closest(".facets")) leaveFolders();
    });
  }

  // src/app/peek.js
  var cache = /* @__PURE__ */ new Map();
  var peekCtrl;
  var peekBox = () => results ? $("#peek") : palette && $(".peek", palette);
  async function showPeek(hit) {
    const box = peekBox();
    if (!box) return;
    if (!hit) {
      box.innerHTML = "";
      S.peekFor = "";
      return;
    }
    const href = hit.getAttribute("href");
    if (href === S.peekFor) return;
    S.peekFor = href;
    let html = cache.get(href);
    if (html === void 0) {
      peekCtrl?.abort();
      peekCtrl = new AbortController();
      try {
        const res = await call(href, { headers: { "X-Partial": "1" }, signal: peekCtrl.signal });
        html = await res.text();
        cache.set(href, html);
      } catch (e) {
        return;
      }
      if (S.peekFor !== href) return;
    }
    if (await S.peekSave?.discard()) refreshPage();
    await S.peekSave?.flush();
    box.innerHTML = html;
    box.scrollTop = 0;
    mountPeek(box, href);
    showRenderMode();
  }
  var freshNote = () => {
    try {
      return sessionStorage.getItem("fresh") || "";
    } catch (e) {
      return "";
    }
  };
  var forgetFresh = () => {
    try {
      sessionStorage.removeItem("fresh");
    } catch (e) {
    }
  };
  var searchTerms = () => tokenize(q?.value || "").filter((t) => !/^(#|in:|sort:|-)/i.test(t));
  var frontMatter = (text) => /^---\n[\s\S]*?\n---/.exec(text)?.[0] || "";
  function titleOf(text, path) {
    const t = /^title:\s*["']?(.+?)["']?\s*$/m.exec(frontMatter(text));
    return t ? t[1] : path.split("/").pop().replace(/\.[^.]+$/, "");
  }
  function retitle(text, title) {
    const fm = frontMatter(text);
    if (!/^title:/m.test(fm)) return text;
    return fm.replace(/^title:.*$/m, "title: " + title) + text.slice(fm.length);
  }
  var fileNameOf = (title) => title.replace(/[\/\\\x00-\x1f]/g, "-").trim().replace(/^\.+/, "") || "untitled";
  function mountPeek(box, href) {
    const live = $(".live", box);
    const src = $(".src", box);
    if (!live || !src || !window.GoNotesEditor) return;
    const path = live.dataset.path;
    let mod = live.dataset.mod, text = src.value, timer2 = null, inflight = null;
    const state = $(".peek-state", box);
    const titleEl = $(".peek-title", box);
    const save = () => {
      clearTimeout(timer2);
      timer2 = null;
      const body = text;
      if (state) state.textContent = "Saving\u2026";
      inflight = call("/save", {
        method: "POST",
        headers: { Accept: "application/json" },
        body: new URLSearchParams({ path, orig: path, mod, body })
      }).then(async (res) => {
        if (!res.ok) {
          toast((await res.text()).trim() || "Not saved");
          if (state) state.textContent = "Not saved";
          return;
        }
        mod = (await res.json()).mod;
        cache.delete(href);
        if (state) state.textContent = "Saved";
      }).catch(() => state && (state.textContent = "Not saved")).finally(() => {
        inflight = null;
        if (timer2 === 0) save();
      });
      return inflight;
    };
    S.peekSave = {
      // Sends what is not saved yet, e.g. before the pane shows another note.
      flush: () => timer2 !== null ? inflight ? inflight.then(save) : save() : inflight,
      keepalive: () => {
        if (S.peekSave.empty()) {
          navigator.sendBeacon?.("/discard", new URLSearchParams({ path, vault }));
          return;
        }
        if (timer2 === null) return;
        clearTimeout(timer2);
        navigator.sendBeacon?.("/save", new URLSearchParams({ path, orig: path, mod, body: text, vault }));
      },
      // A note just made and left with nothing in it is not kept.
      empty: () => path === freshNote() && !text.trim(),
      discard: async () => {
        if (!S.peekSave.empty()) return false;
        clearTimeout(timer2);
        timer2 = null;
        await call("/discard", { method: "POST", body: new URLSearchParams({ path }) });
        forgetFresh();
        return true;
      }
    };
    titleEl?.classList.add("renamable");
    titleEl?.setAttribute("title", "Click to rename");
    titleEl?.addEventListener("click", () => {
      const input = document.createElement("input");
      input.className = "peek-title-input";
      input.value = titleEl.textContent;
      input.spellcheck = false;
      titleEl.replaceWith(input);
      input.focus();
      input.select();
      let done = false;
      const finish = async (keep) => {
        if (done) return;
        done = true;
        const title = input.value.trim();
        if (!keep || !title || title === titleOf(text, path)) {
          input.replaceWith(titleEl);
          return;
        }
        await S.peekSave.flush();
        const ext = /\.[^./]+$/.exec(path)?.[0] || ".md";
        const to = (dirOf(path) ? dirOf(path) + "/" : "") + fileNameOf(title) + ext;
        const res = await call("/save", {
          method: "POST",
          headers: { Accept: "application/json" },
          body: new URLSearchParams({ path: to, orig: path, mod, body: retitle(text, title) })
        });
        if (!res.ok) {
          toast((await res.text()).trim());
          done = false;
          input.focus();
          return;
        }
        const np = (await res.json()).path;
        toast("Renamed to " + np.split("/").pop());
        if (focused()) {
          location.replace(withOpen(np));
          return;
        }
        await refreshPage();
        const i = $$(".hit", results || list()).findIndex((h) => h.dataset.path === np);
        if (i >= 0) select(i, false);
      };
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          finish(true);
        }
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          finish(false);
        }
      });
      input.addEventListener("blur", () => finish(true));
    });
    S.peekView = GoNotesEditor.mount(live, {
      doc: text,
      dir: live.dataset.dir,
      terms: searchTerms(),
      vim: setting("vim") === "on",
      source: setting("render") === "source",
      onFile: (f) => upload(f, path),
      onChange: (t) => {
        text = t;
        if (titleEl) titleEl.textContent = titleOf(t, path);
        clearTimeout(timer2);
        if (inflight) timer2 = 0;
        else timer2 = setTimeout(save, 700);
      },
      onSave: () => S.peekSave.flush(),
      onClose: () => {
        leaveFocus();
        q?.focus();
      }
    });
  }
  function init6() {
    addEventListener("pagehide", () => S.peekSave?.keepalive());
  }

  // src/app/vaults.js
  var vaultBtn = $("#vault");
  var vaultMenu = $("#vaultmenu");
  var vsel = -1;
  var vaultLinks = () => $$("a[data-vault]", vaultMenu);
  function pickVault(i) {
    const all = vaultLinks();
    vsel = (i + all.length) % all.length;
    all.forEach((a, j) => a.classList.toggle("cur", j === vsel));
  }
  function openVaults() {
    closePalette();
    leaveFolders();
    vaultMenu.hidden = false;
    vaultBtn.setAttribute("aria-expanded", "true");
    pickVault(Math.max(0, vaultLinks().findIndex((a) => a.classList.contains("on"))));
  }
  function closeVaults() {
    if (!vaultMenu || vaultMenu.hidden) return;
    vaultMenu.hidden = true;
    vaultBtn.setAttribute("aria-expanded", "false");
    vsel = -1;
  }
  function vaultKeys(e) {
    if (!vaultMenu) return false;
    if (vaultMenu.hidden) {
      if (e.key !== "v" || typing(document.activeElement)) return false;
      e.preventDefault();
      openVaults();
      return true;
    }
    const all = vaultLinks();
    if (/^[1-9]$/.test(e.key) && all[e.key - 1]) location.href = all[e.key - 1].href;
    else switch (e.key) {
      case "ArrowDown":
      case "j":
        pickVault(vsel + 1);
        break;
      case "ArrowUp":
      case "k":
        pickVault(vsel - 1);
        break;
      case "Enter":
        location.href = all[vsel].href;
        break;
      case "Escape":
      case "v":
        closeVaults();
        vaultBtn.focus();
        break;
      case "Tab":
        closeVaults();
        return false;
      default:
        return false;
    }
    e.preventDefault();
    return true;
  }
  async function browseTo(field, dir) {
    const picker = $(".picker", field);
    const res = await call("/browse?dir=" + encodeURIComponent(dir));
    if (!res.ok) {
      if (dir !== "~") return browseTo(field, "~");
      toast((await res.text()).trim());
      return;
    }
    const { dir: here, parent, dirs, places = [] } = await res.json();
    picker.replaceChildren();
    const jump = document.createElement("div");
    jump.className = "picker-places";
    for (const p of places) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "chip";
      b.textContent = p.name;
      b.title = p.dir;
      b.addEventListener("click", () => browseTo(field, p.dir));
      jump.append(b);
    }
    const head = document.createElement("div");
    head.className = "picker-head";
    const up = document.createElement("button");
    up.type = "button";
    up.className = "btn ghost";
    up.textContent = "\u2191";
    up.title = "Up a folder";
    up.disabled = !parent;
    up.addEventListener("click", () => browseTo(field, parent));
    const at = document.createElement("code");
    at.textContent = here;
    const use = document.createElement("button");
    use.type = "button";
    use.className = "btn primary";
    use.textContent = "Use this folder";
    use.addEventListener("click", () => {
      $("input", field).value = here;
      picker.hidden = true;
    });
    head.append(up, at, use);
    const ul = document.createElement("ul");
    for (const d of dirs) {
      const li = document.createElement("li");
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = d;
      b.addEventListener("click", () => browseTo(field, (here === "/" ? "" : here) + "/" + d));
      li.append(b);
      ul.append(li);
    }
    if (!dirs.length) ul.innerHTML = '<li class="muted">No folders in here</li>';
    picker.append(jump, head, ul);
    picker.hidden = false;
  }
  function showGradient(row) {
    const [a, b] = $$("input[type=range]", row).map((r) => r.value);
    row.style.setProperty("--g1", a);
    row.style.setProperty("--g2", b);
    if (row.dataset.orig && row.dataset.orig === vault) {
      document.documentElement.style.setProperty("--hue-accent", a);
      document.documentElement.style.setProperty("--hue-accent2", b);
    }
  }
  function init7() {
    vaultBtn?.addEventListener("click", () => vaultMenu.hidden ? openVaults() : closeVaults());
    document.addEventListener("pointerdown", (e) => {
      if (!e.target.closest(".vaults")) closeVaults();
    });
    document.addEventListener("click", async (e) => {
      const b = e.target.closest?.("[data-browse]");
      if (!b) return;
      const field = b.closest(".folderfield");
      const picker = $(".picker", field);
      if (!picker.hidden) {
        picker.hidden = true;
        return;
      }
      const label2 = b.textContent;
      b.disabled = true;
      b.textContent = "Waiting for the dialog\u2026";
      try {
        const res = await call("/pickdir", { method: "POST" });
        if (res.status === 200) {
          $("input", field).value = (await res.json()).dir;
          return;
        }
        if (res.status === 204) return;
        browseTo(field, $("input", field).value.trim() || "~");
      } finally {
        b.disabled = false;
        b.textContent = label2;
      }
    });
    document.addEventListener("keydown", (e) => {
      const picker = e.key === "Escape" && e.target.closest?.(".folderfield")?.querySelector(".picker:not([hidden])");
      if (picker) {
        e.preventDefault();
        picker.hidden = true;
      }
    });
    document.addEventListener("input", (e) => {
      const row = e.target.closest?.(".vaultrow");
      if (row && e.target.type === "range") showGradient(row);
    });
    document.addEventListener("click", (e) => {
      const p = e.target.closest?.("[data-preset]");
      if (!p) return;
      const row = p.closest(".vaultrow");
      const [a, b] = p.dataset.preset.split(",");
      const [r1, r2] = $$("input[type=range]", row);
      r1.value = a;
      r2.value = b;
      showGradient(row);
    });
  }

  // src/app/search.js
  var timer;
  var ctrl;
  async function runSearch() {
    const val = q.value;
    const url = val ? "/?q=" + encodeURIComponent(val) : "/";
    ctrl?.abort();
    ctrl = new AbortController();
    try {
      const res = await call(url, { headers: { "X-Partial": "1" }, signal: ctrl.signal });
      const html = await res.text();
      S.peekFor = "";
      if (results) {
        const scrolled = S.keepPlace ? $(".hits", results)?.scrollTop || 0 : 0;
        results.innerHTML = html;
        if (scrolled) $(".hits", results).scrollTop = scrolled;
        history.replaceState(null, "", url);
        document.title = val ? val + " \xB7 " + label : label;
        const tags = $("template[data-tags]", results);
        const cloud = $(".side .tagcloud");
        if (tags && cloud) {
          cloud.innerHTML = tags.innerHTML;
          cloud.closest("section").hidden = !cloud.children.length;
        }
        syncSidebar(val);
      } else {
        palette.innerHTML = html + '<section class="peek"></section>';
        palette.hidden = false;
      }
      S.sel = -1;
      S.marked = /* @__PURE__ */ new Set();
      S.anchor = -1;
      select(S.queued, S.keepPlace);
      S.keepPlace = false;
      S.queued = 0;
      S.pending = false;
      if (submitWhenDone) {
        submitWhenDone = false;
        q.closest("form").requestSubmit();
      }
    } catch (e) {
      if (e.name !== "AbortError") console.error(e);
    }
  }
  var closePalette = () => {
    if (palette) {
      palette.hidden = true;
      S.sel = -1;
    }
  };
  function syncSidebar(val) {
    const toks = tokenize(val);
    $$(".side a[data-tok]").forEach((a) => {
      const tok = a.dataset.tok;
      if (!tok) {
        a.classList.toggle("on", !val);
        return;
      }
      const has = toks.some((t) => t.toLowerCase() === tok.toLowerCase());
      const quote = (t) => /\s/.test(t) ? `"${t}"` : t;
      const folder = (t) => /^in:./i.test(t);
      const keep = has && folder(tok);
      const rest = toks.filter((t) => keep || t.toLowerCase() !== tok.toLowerCase() && (has || !folder(tok) || !folder(t))).map(quote);
      if (!has) rest.push(quote(tok));
      a.href = "/?q=" + encodeURIComponent(rest.join(" "));
      a.classList.toggle("on", has);
    });
    applyFolds();
  }
  var submitWhenDone = false;
  var open = (hit) => {
    if (hit) results ? focusNote(hit) : grow(hit.href);
  };
  var editHref = (hit) => "/edit/" + hit.getAttribute("href").slice(3);
  function grow(url) {
    const box = results && $("#peek:not(:empty)");
    const main = $(".main");
    if (!box || !main || matchMedia("(prefers-reduced-motion: reduce)").matches) {
      location.href = url;
      return;
    }
    const from = box.getBoundingClientRect();
    const to = main.getBoundingClientRect();
    const bottom = innerHeight - 16;
    box.classList.add("growing");
    const anim = box.animate([
      { left: from.left + "px", top: from.top + "px", width: from.width + "px", height: from.height + "px" },
      { left: to.left + "px", top: Math.min(to.top, from.top) + "px", width: to.width + "px", height: bottom - Math.min(to.top, from.top) + "px" }
    ], { duration: 160, easing: "cubic-bezier(0.2, 0, 0.13, 1)", fill: "forwards" });
    $("#results")?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 120, fill: "forwards" });
    anim.finished.then(() => location.href = url);
  }
  var caretToEnd = () => {
    if (q.selectionStart === 0 && q.selectionEnd === 0) q.setSelectionRange(q.value.length, q.value.length);
  };
  function select(i, scroll = true) {
    const hits = $$(".hit", list() || document);
    if (!hits.length) {
      showPeek(null);
      return;
    }
    S.sel = Math.max(0, Math.min(hits.length - 1, i));
    hits.forEach((h, j) => h.classList.toggle("sel", j === S.sel));
    if (scroll) hits[S.sel].scrollIntoView({ block: "nearest" });
    S.peekReady = showPeek(hits[S.sel]);
  }
  var hitsShown = () => results && !focused() || palette && !palette.hidden;
  async function refreshPage(main = false) {
    cache.clear();
    S.peekFor = "";
    const doc = new DOMParser().parseFromString(await (await call(location.pathname + location.search)).text(), "text/html");
    $(".side-body").innerHTML = $(".side-body", doc).innerHTML;
    applyFolds();
    if (vaultMenu) vaultMenu.innerHTML = $("#vaultmenu", doc).innerHTML;
    if (main) $(".main").innerHTML = $(".main", doc).innerHTML;
    if (results || palette && !palette.hidden) {
      S.queued = Math.max(S.sel, 0);
      S.keepPlace = true;
      await runSearch();
    }
  }
  function init8() {
    q?.addEventListener("input", () => {
      leaveFocus();
      S.pending = true;
      S.queued = 0;
      clearTimeout(timer);
      timer = setTimeout(runSearch, 60);
    });
    q?.addEventListener("focus", () => {
      if (palette && q.value) runSearch();
    });
    q?.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || !e.shiftKey) return;
      const hit = hitsShown() && S.sel >= 0 && $$(".hit", list())[S.sel];
      if (!hit) return;
      e.preventDefault();
      grow(editHref(hit));
    });
    q?.closest("form").addEventListener("submit", (e) => {
      e.preventDefault();
      if (S.pending) {
        submitWhenDone = true;
        return;
      }
      const hits = $$(".hit", list());
      if (hits.length) open(hits[Math.max(S.sel, 0)] || hits[0]);
      else if (q.value.trim()) newNote(q.value);
    });
    addEventListener("pageshow", (e) => {
      if (!e.persisted) return;
      $$(".growing").forEach((el) => {
        el.classList.remove("growing");
        el.getAnimations().forEach((a) => a.cancel());
      });
      $("#results")?.getAnimations().forEach((a) => a.cancel());
    });
    document.addEventListener("click", (e) => {
      const hit = e.target.closest(".hit");
      if (!hit || e.button !== 0 || e.ctrlKey || e.metaKey || e.altKey) return;
      e.preventDefault();
      const i = $$(".hit", list()).indexOf(hit);
      if (e.shiftKey) markTo(i);
      else unmark();
      select(i, false);
      if (!e.shiftKey && results && phone()) open(hit);
    });
    document.addEventListener("dblclick", (e) => open(e.target.closest(".hit")));
    document.addEventListener("focusin", (e) => {
      const hit = e.target.closest?.(".hit");
      const i = hit ? $$(".hit", list() || document).indexOf(hit) : -1;
      if (i >= 0 && i !== S.sel) select(i, false);
    });
    document.addEventListener("pointerdown", (e) => {
      if (palette && !palette.hidden && !e.target.closest(".search")) closePalette();
    });
    if (q && document.activeElement === q) caretToEnd();
    else q?.addEventListener("focus", caretToEnd, { once: true });
  }

  // src/app/pane.js
  var fold = (el, open2) => {
    el.getAnimations().forEach((x) => x.cancel());
    el.classList.remove("folded");
    const mb = getComputedStyle(el).marginBottom;
    const frames = [{ height: el.scrollHeight + "px", marginBottom: mb, opacity: 1 }, { height: "0px", marginBottom: "0px", opacity: 0 }];
    const opts = { duration: 180, easing: "cubic-bezier(0.2, 0, 0.13, 1)" };
    if (open2) {
      el.animate(frames.reverse(), opts);
      return;
    }
    const anim = el.animate(frames, { ...opts, fill: "forwards" });
    anim.finished.then(() => {
      if (focused()) el.classList.add("folded");
      anim.cancel();
    }, () => {
    });
  };
  var folding = () => [q.closest("form"), results];
  function toSearch() {
    if (focused()) leaveFocus();
    else if (document.body.classList.contains("dim") && $("#editor")) {
      document.body.classList.remove("dim");
      q?.addEventListener("blur", () => setTimeout(() => {
        if (document.activeElement !== q && (!palette || palette.hidden)) document.body.classList.add("dim");
      }, 150), { once: true });
    }
    q?.focus();
    q?.select();
  }
  var browse = $(".browse");
  var splitter = $(".splitter");
  var beside = () => document.documentElement.dataset.list === "side" && matchMedia("(width > 52rem)").matches;
  var rowPx = () => 1.85 * parseFloat(getComputedStyle(document.documentElement).fontSize);
  var rows = Math.max(2, Number(setting("list-rows")) || 6);
  var maxRows = () => {
    const top = results.getBoundingClientRect().top;
    const bottom = browse.getBoundingClientRect().bottom;
    return Math.max(2, Math.floor((bottom - top - 8 * rowPx()) / rowPx()));
  };
  function setRows(n, keep = true, fit = true) {
    rows = Math.max(2, fit ? Math.min(n, maxRows()) : n);
    browse.style.setProperty("--rows", rows);
    splitter?.setAttribute("aria-valuenow", rows);
    if (keep) setSetting("list-rows", rows === 6 ? "" : String(rows));
  }
  var fullBeforeNote = false;
  function fullList(on = !browse.classList.contains("listfull")) {
    if (focused()) return;
    browse.classList.toggle("listfull", on);
    $$(".hit", results)[S.sel]?.scrollIntoView({ block: "nearest" });
  }
  var listW = Number(setting("list-width")) || 0;
  function setWidth(px, keep = true) {
    const w = browse.getBoundingClientRect().width;
    listW = Math.round(Math.max(12 * rowPx(), Math.min(px, w - 20 * rowPx())));
    browse.style.setProperty("--listw", listW + "px");
    if (keep) setSetting("list-width", String(listW));
  }
  async function focusNote(hit) {
    if (!focused()) fullBeforeNote = !!browse?.classList.contains("listfull");
    browse?.classList.remove("listfull");
    const hits = $$(".hit", results);
    const i = hits.indexOf(hit);
    if (i !== S.sel) select(i, false);
    await S.peekReady;
    if (!focused()) {
      document.body.classList.add("focus", "dim");
      history.pushState({ focus: true }, "", withOpen(hit.dataset.path));
      for (const el of folding()) {
        if (!matchMedia("(prefers-reduced-motion: reduce)").matches) fold(el, false);
        else el.classList.add("folded");
      }
    }
    S.peekView?.focus();
  }
  function leaveFocus(back = true) {
    if (!focused()) return;
    S.peekSave?.discard().then((gone) => gone && refreshPage());
    document.body.classList.remove("focus", "dim");
    if (fullBeforeNote) {
      browse.classList.add("listfull");
      fullBeforeNote = false;
    }
    for (const el of folding()) {
      if (!matchMedia("(prefers-reduced-motion: reduce)").matches) fold(el, true);
      else el.classList.remove("folded");
    }
    if (!back) return;
    if (history.state?.focus) history.back();
    else history.replaceState(null, "", withOpen(null));
  }
  function init9() {
    if (browse) setRows(rows, false, false);
    if (browse && listW) browse.style.setProperty("--listw", listW + "px");
    splitter?.setAttribute("aria-orientation", beside() ? "vertical" : "horizontal");
    splitter?.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || e.target.closest(".fulllist")) return;
      e.preventDefault();
      splitter.setPointerCapture(e.pointerId);
      splitter.classList.add("dragging");
      const top = results.getBoundingClientRect().top + 8;
      const left = browse.getBoundingClientRect().left;
      const move = (ev) => beside() ? setWidth(ev.clientX - left, false) : setRows(Math.round((ev.clientY - top) / rowPx()), false);
      const up = () => {
        splitter.classList.remove("dragging");
        splitter.removeEventListener("pointermove", move);
        if (!beside()) setRows(rows);
        else if (listW) setWidth(listW);
      };
      splitter.addEventListener("pointermove", move);
      splitter.addEventListener("pointerup", up, { once: true });
      splitter.addEventListener("pointercancel", up, { once: true });
    });
    splitter?.addEventListener("dblclick", () => fullList(true));
    document.addEventListener("click", (e) => {
      const b = e.target.closest?.("[data-fulllist]");
      if (b) fullList(b.dataset.fulllist === "on");
    });
    splitter?.addEventListener("keydown", (e) => {
      const side = beside();
      const step = e.key === (side ? "ArrowRight" : "ArrowDown") ? 1 : e.key === (side ? "ArrowLeft" : "ArrowUp") ? -1 : 0;
      if (!step) return;
      e.preventDefault();
      e.stopPropagation();
      side ? setWidth((listW || results.getBoundingClientRect().width) + step * 2 * rowPx()) : setRows(rows + step);
    });
    document.addEventListener("click", (e) => {
      if (!e.target.closest?.("[data-back]")) return;
      leaveFocus();
      if (!phone()) q?.focus();
    });
    addEventListener("popstate", () => {
      const open2 = new URL(location.href).searchParams.get("open");
      if (focused() && !open2) leaveFocus(false);
      else if (!focused() && open2) location.reload();
    });
  }

  // src/app/options.js
  var optBtn = $("#options");
  var optMenu = $("#optmenu");
  var showTheme = () => {
    const cur = document.documentElement.dataset.theme || "";
    $$("#opt-theme button").forEach((b) => b.classList.toggle("on", b.dataset.theme === cur));
  };
  var showList = () => {
    const cur = document.documentElement.dataset.list || "";
    $$("#opt-list button").forEach((b) => b.classList.toggle("on", b.dataset.list === cur));
  };
  var showImg = () => {
    const cur = document.documentElement.dataset.img || "";
    $$("#opt-img button").forEach((b) => b.classList.toggle("on", b.dataset.img === cur));
  };
  function toggleOptions(open2 = optMenu.hidden) {
    optMenu.hidden = !open2;
    optBtn.setAttribute("aria-expanded", String(open2));
    if (open2) {
      showTheme();
      showList();
      showImg();
      $("#opt-vim").checked = setting("vim") === "on";
    }
  }
  var showRenderMode = () => {
    const mode = setting("render") || "live";
    $$("[data-render]").forEach((b) => b.classList.toggle("on", b.dataset.render === mode));
  };
  var hint = $(".search > kbd");
  function init10() {
    optBtn?.addEventListener("click", () => toggleOptions());
    document.addEventListener("pointerdown", (e) => {
      if (optMenu && !optMenu.hidden && !e.target.closest(".side-foot")) toggleOptions(false);
    });
    $$("#opt-theme button").forEach((b) => b.addEventListener("click", () => {
      const next = b.dataset.theme;
      if (next) document.documentElement.dataset.theme = next;
      else delete document.documentElement.dataset.theme;
      setSetting("theme", next);
      showTheme();
    }));
    $$("#opt-list button").forEach((b) => b.addEventListener("click", () => {
      const layout = b.dataset.list;
      if (layout) document.documentElement.dataset.list = layout;
      else delete document.documentElement.dataset.list;
      setSetting("list", layout);
      showList();
      splitter?.setAttribute("aria-orientation", beside() ? "vertical" : "horizontal");
      $$(".hit", results)[S.sel]?.scrollIntoView({ block: "nearest" });
    }));
    $("#opt-sub")?.addEventListener("change", async (e) => {
      document.cookie = "subfolders=" + (e.target.checked ? "1; max-age=34560000" : "; max-age=0") + "; path=/; samesite=lax";
      await refreshPage();
      toast(e.target.checked ? "Folders include their subfolders" : "Folders show only their own notes");
    });
    $$("#opt-img button").forEach((b) => b.addEventListener("click", () => {
      const size = b.dataset.img;
      if (size) document.documentElement.dataset.img = size;
      else delete document.documentElement.dataset.img;
      setSetting("img", size);
      showImg();
      for (const v of [S.peekView, S.editView]) v?.requestMeasure();
    }));
    $("#opt-newdir")?.addEventListener("change", async (e) => {
      const dir = e.target.value;
      const res = await call("/newdir", { method: "POST", body: new URLSearchParams({ dir }) });
      toast(res.ok ? "New notes go to " + (dir || "the top level") : (await res.text()).trim());
    });
    $("#opt-vim")?.addEventListener("change", (e) => {
      const on = e.target.checked;
      setSetting("vim", on ? "on" : "");
      for (const v of [S.peekView, S.editView]) if (v) GoNotesEditor.setVim(v, on);
      toast(on ? "Vim mode: i to type, Esc to stop typing, Esc again to close the note" : "Vim mode off");
    });
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || e.ctrlKey || e.metaKey || e.altKey) return;
      const ed = e.target.closest?.(".cm-editor");
      const view = ed?.closest(".editor") ? S.editView : ed?.closest(".peek") ? S.peekView : null;
      if (!view || GoNotesEditor.vimMode(view) !== "normal") return;
      e.preventDefault();
      e.stopPropagation();
      if (view === S.editView) close();
      else {
        leaveFocus();
        q?.focus();
      }
    }, true);
    document.addEventListener("click", (e) => {
      const b = e.target.closest?.("[data-render]");
      if (!b) return;
      const source = b.dataset.render === "source";
      setSetting("render", source ? "source" : "");
      for (const v of [S.peekView, S.editView]) if (v) GoNotesEditor.setSource(v, source);
      showRenderMode();
      (S.editView || S.peekView)?.focus();
    });
    showRenderMode();
    if (hint) hint.textContent = mac ? "\u2318K" : "Ctrl K";
    if (mac) $$("kbd.alt").forEach((k) => k.textContent = k.textContent.replace("Alt ", "\u2325"));
  }

  // src/app/keys.js
  function init11() {
    document.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        toSearch();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "q") {
        e.preventDefault();
        window.close();
        setTimeout(() => toast("The browser keeps this window open: close it with Alt+F4"), 300);
        return;
      }
      if (e.altKey && !e.ctrlKey && !e.metaKey && e.code === "KeyB") {
        e.preventDefault();
        foldSidebar();
        return;
      }
      if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === "Enter" || e.code === "KeyL") && browse) {
        e.preventDefault();
        fullList();
        return;
      }
      if (e.key === "Escape" && browse?.classList.contains("listfull") && !(palette && !palette.hidden)) {
        e.preventDefault();
        fullList(false);
        return;
      }
      if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && /^Arrow/.test(e.key) && results && !focused() && (document.activeElement === q || !typing(document.activeElement))) {
        e.preventDefault();
        folderStep(e.key);
        return;
      }
      if (e.altKey && !e.ctrlKey && !e.metaKey && vaultMenu) {
        const n = /^Digit([1-9])$/.exec(e.code);
        const link = n && vaultLinks()[n[1] - 1];
        if (link || e.code === "KeyV") {
          e.preventDefault();
          if (link) location.href = link.href;
          else vaultMenu.hidden ? openVaults() : closeVaults();
          return;
        }
      }
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "z") {
        const el = document.activeElement;
        if (!typing(el) || el === q && history30.length) {
          e.preventDefault();
          undoLast();
          return;
        }
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "Escape" && optMenu && !optMenu.hidden) {
        toggleOptions(false);
        optBtn.focus();
        return;
      }
      if (e.key === "Escape" && !e.defaultPrevented && document.activeElement?.closest?.(".peek .cm-editor") && setting("vim") !== "on") {
        e.preventDefault();
        leaveFocus();
        q?.focus();
        return;
      }
      if (vaultKeys(e)) return;
      if (folderKeys(e)) return;
      const inQ = document.activeElement === q;
      const arrow = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
      if (inQ) {
        const atEnd = q.selectionStart === q.value.length && q.selectionEnd === q.value.length;
        if (e.key === "Delete" && atEnd && hitsShown() && S.sel >= 0) {
          e.preventDefault();
          const hit = $$(".hit", list())[S.sel];
          if (several()) deleteMany(several());
          else if (hit) deleteNote(hit.dataset.path);
          return;
        }
        if (arrow) {
          e.preventDefault();
          if (S.pending) {
            S.queued = Math.max(0, S.queued + arrow);
            return;
          }
          if (palette && palette.hidden) {
            runSearch();
            return;
          }
          stepTo(S.sel + arrow, e.shiftKey);
        } else if (e.key === "Escape") {
          e.preventDefault();
          if (palette && !palette.hidden) closePalette();
          else if (q.value && results) {
            q.value = "";
            runSearch();
          } else q.blur();
        }
        return;
      }
      if (typing(document.activeElement)) return;
      if (arrow && hitsShown()) {
        e.preventDefault();
        stepTo(S.sel + arrow, e.shiftKey);
        return;
      }
      switch (e.key) {
        case "/":
          e.preventDefault();
          toSearch();
          break;
        case "j":
          if (hitsShown()) stepTo(S.sel + 1, false);
          break;
        case "k":
          if (hitsShown()) stepTo(S.sel - 1, false);
          break;
        case "J":
          if (hitsShown()) stepTo(S.sel + 1, true);
          break;
        case "K":
          if (hitsShown()) stepTo(S.sel - 1, true);
          break;
        case "Enter":
          if (S.sel >= 0 && hitsShown()) open($$(".hit", list())[S.sel]);
          break;
        case "Delete":
        case "Backspace": {
          const p = hitsShown() && S.sel >= 0 && $$(".hit", list())[S.sel]?.dataset.path || openNote();
          if (several() && hitsShown()) {
            e.preventDefault();
            deleteMany(several());
          } else if (p) {
            e.preventDefault();
            deleteNote(p);
          }
          break;
        }
        case "n":
          newNote();
          break;
        case "?":
          location.href = "/n/gonotes-help.md";
          break;
        case "e": {
          const hit = hitsShown() && S.sel >= 0 && $$(".hit", list())[S.sel];
          if (openNote()) grow("/edit/" + noteURL(openNote()).slice(3));
          else if (hit) grow(editHref(hit));
          break;
        }
        case "Escape":
          if (focused()) {
            leaveFocus();
            q?.focus();
          }
          break;
      }
    });
  }

  // src/app/start.js
  function initList() {
    if (results && focused()) {
      const p = openNote() || $("#peek .peek-path")?.textContent || "";
      S.peekFor = "/n/" + p.split("/").map(encodeURIComponent).join("/");
      S.sel = $$(".hit", results).findIndex((h) => h.dataset.path === p);
      $$(".hit", results)[S.sel]?.classList.add("sel");
      let end = false;
      try {
        end = sessionStorage.getItem("caret") === "end";
        sessionStorage.removeItem("caret");
      } catch (e) {
      }
      mountPeek($("#peek"), S.peekFor);
      S.peekView?.focus();
      if (end) S.peekView?.dispatch({ selection: { anchor: S.peekView.state.doc.length } });
    } else if (results) {
      const first = $(".hit", results);
      if (first) {
        S.sel = 0;
        first.classList.add("sel");
        S.peekFor = first.getAttribute("href");
        mountPeek($("#peek"), S.peekFor);
      }
    }
  }

  // src/app/drag.js
  var MIME = "application/x-gonotes-path";
  var DIR_MIME = "application/x-gonotes-dir";
  var MANY_MIME = "application/x-gonotes-paths";
  var dragDir = null;
  var inside = (d, folder) => d === folder || d.startsWith(folder + "/");
  function dropTarget(e) {
    const types = e.dataTransfer?.types || [];
    const v = e.target.closest?.(".vaultmenu a[data-vault]");
    if (v) return types.includes(MIME) && !v.classList.contains("on") ? v : null;
    const t = e.target.closest?.(".facets a[data-tok]");
    if (!t) return null;
    if (types.includes(MIME)) return t;
    if (!types.includes(DIR_MIME) || dragDir === null) return null;
    const to = t.dataset.tok.replace(/^in:/, "");
    return inside(to, dragDir) || to === dirOf(dragDir) ? null : t;
  }
  var clearDrop = (keep) => $$(".drop").forEach((el) => el !== keep && el.classList.remove("drop"));
  function init12() {
    document.addEventListener("dragstart", (e) => {
      const folder = e.target.closest?.(".facets a[data-dir]");
      const src = folder || e.target.closest?.("[data-path]");
      if (!src) return;
      if (folder) {
        dragDir = folder.dataset.dir;
        e.dataTransfer.setData(DIR_MIME, dragDir);
        e.dataTransfer.setData("text/plain", dragDir + "/");
      } else {
        e.dataTransfer.setData(MIME, src.dataset.path);
        e.dataTransfer.setData("text/plain", src.dataset.path);
        if (several() && S.marked.has(src.dataset.path)) e.dataTransfer.setData(MANY_MIME, JSON.stringify(several()));
      }
      e.dataTransfer.effectAllowed = "move";
      document.body.classList.add("dragging");
    });
    document.addEventListener("dragend", () => {
      document.body.classList.remove("dragging");
      dragDir = null;
      clearDrop();
      closeVaults();
    });
    document.addEventListener("dragover", (e) => {
      if (vaultMenu?.hidden && e.target.closest?.("#vault") && e.dataTransfer?.types.includes(MIME)) openVaults();
      const t = dropTarget(e);
      clearDrop(t);
      if (!t) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      t.classList.add("drop");
    });
    document.addEventListener("drop", (e) => {
      const t = dropTarget(e);
      if (!t) return;
      e.preventDefault();
      clearDrop();
      const many = e.dataTransfer.getData(MANY_MIME);
      if (t.dataset.vault) {
        closeVaults();
        moveToVault(many ? JSON.parse(many) : [e.dataTransfer.getData(MIME)], t.dataset.vault);
        return;
      }
      const to = t.dataset.tok.replace(/^in:/, "");
      const folder = e.dataTransfer.getData(DIR_MIME);
      if (folder) moveFolder(folder, to, true);
      else if (many) moveMany(JSON.parse(many), to);
      else moveNote(e.dataTransfer.getData(MIME), to, true);
    });
  }

  // src/app/menu.js
  var fileManager = mac ? "Finder" : /Win/.test(navigator.platform || navigator.userAgent) ? "Explorer" : "Files";
  function contextMenu(x, y, items) {
    $(".ctxmenu")?.remove();
    const menu = document.createElement("ul");
    menu.className = "ctxmenu";
    menu.setAttribute("role", "menu");
    for (const [label2, fn] of items) {
      const li = document.createElement("li");
      const b = document.createElement("button");
      b.type = "button";
      b.setAttribute("role", "menuitem");
      b.textContent = label2;
      b.addEventListener("click", () => {
        menu.remove();
        fn();
      });
      li.append(b);
      menu.append(li);
    }
    document.body.append(menu);
    const r = menu.getBoundingClientRect();
    menu.style.left = Math.min(x, innerWidth - r.width - 8) + "px";
    menu.style.top = Math.min(y, innerHeight - r.height - 8) + "px";
    menu.querySelector("button")?.focus();
  }
  var closeMenu = () => $(".ctxmenu")?.remove();
  async function revealIn(path) {
    const res = await call("/reveal", { method: "POST", body: new URLSearchParams({ path }) });
    if (!res.ok) toast((await res.text()).trim());
  }
  function init13() {
    document.addEventListener("pointerdown", (e) => {
      if (!e.target.closest?.(".ctxmenu")) closeMenu();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && $(".ctxmenu")) {
        e.preventDefault();
        e.stopPropagation();
        closeMenu();
      }
    }, true);
    addEventListener("blur", closeMenu);
    document.addEventListener("contextmenu", (e) => {
      const hit = e.target.closest?.(".hit");
      const folder = e.target.closest?.(".facets a[data-dir]");
      const path = hit?.dataset.path || folder?.dataset.dir;
      if (!path || path === "gonotes-help.md") return;
      e.preventDefault();
      if (hit) select($$(".hit", list() || document).indexOf(hit), false);
      const items = [["Show in " + fileManager, () => revealIn(path)]];
      const many = hit && S.marked.has(path) && several();
      if (many) items.push([`Delete ${many.length} notes`, () => deleteMany(many)]);
      else if (hit) items.push(["Delete", () => deleteNote(path)]);
      if (folder) {
        items.push(["Rename\u2026", () => renameFolder(folder)]);
        const li = folder.closest("li");
        const own = li.classList.contains("excluded") && !$$(".facets li.excluded[data-dir]").some((o) => o !== li && under(path, o.dataset.dir));
        if (!li.classList.contains("excluded")) items.push(["Exclude from search", () => excludeDir(path, true)]);
        else if (own) items.push(["Include in search", () => excludeDir(path, false)]);
        items.push(["Delete\u2026", () => deleteFolder(path)]);
      }
      contextMenu(e.clientX, e.clientY, items);
    });
  }

  // src/app/main.js
  try {
    navigator.serviceWorker?.register("/sw.js");
  } catch (e) {
  }
  init();
  init10();
  init8();
  init6();
  init2();
  init9();
  init11();
  initList();
  init12();
  init13();
  init5();
  init7();
  init4();
  init3();
  initEditor();
})();
//# sourceMappingURL=app.js.map
