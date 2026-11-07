// Search as you type, keyboard navigation and the editor. No framework: the
// server renders everything, this only swaps the results list in place.
(() => {
    const $ = (s, el = document) => el.querySelector(s);
    // Installable as an app (Android, Chrome, Edge, Safari): see sw.js.
    try { navigator.serviceWorker?.register("/sw.js"); } catch (e) {}
    const $$ = (s, el = document) => [...el.querySelectorAll(s)];
    const q = $("#q");
    // Every request names the vault this page shows, so switching vaults in
    // another tab cannot make this one search, move or save in the other.
    const vault = document.body.dataset.vault || "";
    const label = document.body.dataset.label || "notes";
    const call = (url, opts = {}) => fetch(url, { ...opts, headers: { ...opts.headers, "X-Vault": vault } });
    const typing = (el) => el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));

    // ---- options, bottom left: kept in this browser ----
    const optBtn = $("#options");
    const optMenu = $("#optmenu");
    const showTheme = () => {
        const cur = document.documentElement.dataset.theme || "";
        $$("#opt-theme button").forEach((b) => b.classList.toggle("on", b.dataset.theme === cur));
    };
    const showList = () => {
        const cur = document.documentElement.dataset.list || "";
        $$("#opt-list button").forEach((b) => b.classList.toggle("on", b.dataset.list === cur));
    };
    const showImg = () => {
        const cur = document.documentElement.dataset.img || "";
        $$("#opt-img button").forEach((b) => b.classList.toggle("on", b.dataset.img === cur));
    };
    function toggleOptions(open = optMenu.hidden) {
        optMenu.hidden = !open;
        optBtn.setAttribute("aria-expanded", String(open));
        if (open) {
            showTheme();
            showList();
            showImg();
            $("#opt-vim").checked = setting("vim") === "on";
        }
    }
    optBtn?.addEventListener("click", () => toggleOptions());
    document.addEventListener("pointerdown", (e) => { if (optMenu && !optMenu.hidden && !e.target.closest(".side-foot")) toggleOptions(false); });
    $$("#opt-theme button").forEach((b) => b.addEventListener("click", () => {
        const next = b.dataset.theme;
        if (next) document.documentElement.dataset.theme = next;
        else delete document.documentElement.dataset.theme;
        setSetting("theme", next);
        showTheme();
    }));
    // The list above the note, or beside it; the page set it before it showed.
    $$("#opt-list button").forEach((b) => b.addEventListener("click", () => {
        const layout = b.dataset.list;
        if (layout) document.documentElement.dataset.list = layout;
        else delete document.documentElement.dataset.list;
        setSetting("list", layout);
        showList();
        splitter?.setAttribute("aria-orientation", beside() ? "vertical" : "horizontal");
        $$(".hit", results)[sel]?.scrollIntoView({ block: "nearest" });
    }));
    // Whether folders take in their subfolders, in their counts and when
    // picked. The server reads it, so it is a cookie; the page follows at once.
    $("#opt-sub")?.addEventListener("change", async (e) => {
        document.cookie = "subfolders=" + (e.target.checked ? "1; max-age=34560000" : "; max-age=0") + "; path=/; samesite=lax";
        await refreshPage();
        toast(e.target.checked ? "Folders include their subfolders" : "Folders show only their own notes");
    });
    // How large images in notes are drawn; the page set it before it showed.
    $$("#opt-img button").forEach((b) => b.addEventListener("click", () => {
        const size = b.dataset.img;
        if (size) document.documentElement.dataset.img = size;
        else delete document.documentElement.dataset.img;
        setSetting("img", size);
        showImg();
        for (const v of [peekView, editView]) v?.requestMeasure(); // the lines changed height
    }));
    // Where new notes go when nothing else says: kept with the vault.
    $("#opt-newdir")?.addEventListener("change", async (e) => {
        const dir = e.target.value;
        const res = await call("/newdir", { method: "POST", body: new URLSearchParams({ dir }) });
        toast(res.ok ? "New notes go to " + (dir || "the top level") : (await res.text()).trim());
    });
    // Vim keys, at once in the note open; how to get about says the message.
    $("#opt-vim")?.addEventListener("change", (e) => {
        const on = e.target.checked;
        setSetting("vim", on ? "on" : "");
        for (const v of [peekView, editView]) if (v) GoNotesEditor.setVim(v, on);
        toast(on ? "Vim mode: i to type, Esc to stop typing, Esc again to close the note" : "Vim mode off");
    });
    // In vim, Esc first stops typing, as vim does; Esc again, with nothing
    // left for vim to leave, closes the note. Before vim sees the key.
    document.addEventListener("keydown", (e) => {
        if (e.key !== "Escape" || e.ctrlKey || e.metaKey || e.altKey) return;
        const ed = e.target.closest?.(".cm-editor");
        const view = ed?.closest(".editor") ? editView : ed?.closest(".peek") ? peekView : null;
        if (!view || GoNotesEditor.vimMode(view) !== "normal") return;
        e.preventDefault();
        e.stopPropagation();
        if (view === editView) close();
        else { leaveFocus(); q?.focus(); }
    }, true);

    // A toast that has to outlive the page, e.g. after deleting the note on
    // screen, is handed to the next page.
    function toastNext(msg, undo) {
        try { sessionStorage.setItem("toast", JSON.stringify({ msg, undo })); } catch (e) {}
    }
    function toast(msg, action) {
        $(".toast")?.remove();
        const t = document.createElement("div");
        t.className = "toast";
        t.textContent = msg;
        if (action) {
            const b = document.createElement("button");
            b.textContent = action.label;
            b.addEventListener("click", () => { t.remove(); action.fn(); });
            t.append(b);
            t.style.animationDuration = "6s";
        }
        document.body.append(t);
        setTimeout(() => t.remove(), action ? 6100 : 1700);
    }

    // ---- live search ----
    // On the list page the results swap in place. Everywhere else they open in
    // a dropdown under the box, so a search does not throw away the page.
    const results = $("#results");
    const palette = $("#palette");
    const list = () => results || palette;
    // Arrows pressed while a search is still on its way are kept and applied
    // to its results, so typing and then going straight for ↓ is not lost.
    let timer, ctrl, sel = -1, pending = false, queued = 0;

    async function runSearch() {
        const val = q.value;
        const url = val ? "/?q=" + encodeURIComponent(val) : "/";
        ctrl?.abort();
        ctrl = new AbortController();
        try {
            const res = await call(url, { headers: { "X-Partial": "1" }, signal: ctrl.signal });
            const html = await res.text();
            peekFor = "";
            if (results) {
                results.innerHTML = html;
                history.replaceState(null, "", url);
                document.title = val ? val + " · " + label : label;
                syncSidebar(val);
            } else {
                palette.innerHTML = html + '<section class="peek"></section>';
                palette.hidden = false;
            }
            sel = -1;
            marked = new Set();
            anchor = -1;
            select(queued, false);
            queued = 0;
            pending = false;
            if (submitWhenDone) { submitWhenDone = false; q.closest("form").requestSubmit(); }
        } catch (e) {
            if (e.name !== "AbortError") console.error(e);
        }
    }

    const closePalette = () => { if (palette) { palette.hidden = true; sel = -1; } };

    // The sidebar links toggle filters on the current query, so after a live
    // search they need the new query rather than the one the page was built with.
    function syncSidebar(val) {
        const toks = tokenize(val);
        $$(".side a[data-tok]").forEach((a) => {
            const tok = a.dataset.tok;
            if (!tok) { a.classList.toggle("on", !val); return; }
            const has = toks.some((t) => t.toLowerCase() === tok.toLowerCase());
            const quote = (t) => /\s/.test(t) ? `"${t}"` : t;
            const folder = (t) => /^in:./i.test(t);
            // A folder picked stays picked when clicked again; a tag toggles.
            const keep = has && folder(tok);
            const rest = toks.filter((t) => keep || (t.toLowerCase() !== tok.toLowerCase() && (has || !folder(tok) || !folder(t)))).map(quote);
            if (!has) rest.push(quote(tok));
            a.href = "/?q=" + encodeURIComponent(rest.join(" "));
            a.classList.toggle("on", has);
        });
        applyFolds();
    }

    function tokenize(s) {
        const out = []; let cur = "", quoted = false;
        for (const ch of s) {
            if (ch === '"') { if (quoted && cur) { out.push(cur); cur = ""; } quoted = !quoted; }
            else if (!quoted && /\s/.test(ch)) { if (cur) out.push(cur); cur = ""; }
            else cur += ch;
        }
        if (cur) out.push(cur);
        return out;
    }

    q?.addEventListener("input", () => {
        leaveFocus();
        pending = true;
        queued = 0;
        clearTimeout(timer);
        timer = setTimeout(runSearch, 60);
    });
    q?.addEventListener("focus", () => { if (palette && q.value) runSearch(); });
    // Enter opens the selected note, or, when nothing matched, starts a new
    // one titled with what was typed.
    let submitWhenDone = false;
    // Shift+Enter in the box edits the selected note instead of opening it.
    q?.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" || !e.shiftKey) return;
        const hit = hitsShown() && sel >= 0 && $$(".hit", list())[sel];
        if (!hit) return;
        e.preventDefault();
        grow(editHref(hit));
    });
    q?.closest("form").addEventListener("submit", (e) => {
        e.preventDefault();
        if (pending) { submitWhenDone = true; return; }
        const hits = $$(".hit", list());
        if (hits.length) open(hits[Math.max(sel, 0)] || hits[0]);
        else if (q.value.trim()) newNote(q.value);
    });

    // A click picks a row and shows it below; a double click or Enter opens
    // it. A modified click still opens it in a new tab as a link would.
    // On the list page the note opens where it is: the list folds away and
    // the editor under it takes the page. Elsewhere its page is opened.
    const open = (hit) => { if (hit) results ? focusNote(hit) : grow(hit.href); };
    const editHref = (hit) => "/edit/" + hit.getAttribute("href").slice(3);

    // Opening or editing a note grows the pane it is shown in to fill the
    // page first, fast, and only then loads the page, which takes its place
    // without a flash since the browser holds the old one until it paints.
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
            { left: to.left + "px", top: Math.min(to.top, from.top) + "px", width: to.width + "px", height: bottom - Math.min(to.top, from.top) + "px" },
        ], { duration: 160, easing: "cubic-bezier(0.2, 0, 0.13, 1)", fill: "forwards" });
        $("#results")?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 120, fill: "forwards" });
        anim.finished.then(() => (location.href = url));
    }
    // Coming back to the page from history must not show it mid-grow.
    addEventListener("pageshow", (e) => {
        if (!e.persisted) return;
        $$(".growing").forEach((el) => { el.classList.remove("growing"); el.getAnimations().forEach((a) => a.cancel()); });
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
        // On a phone there is only the list: a tap opens the note.
        if (!e.shiftKey && results && phone()) open(hit);
    });
    document.addEventListener("dblclick", (e) => open(e.target.closest(".hit")));
    // A row that gets the focus, by Tab or a click, is the selection.
    document.addEventListener("focusin", (e) => {
        const hit = e.target.closest?.(".hit");
        const i = hit ? $$(".hit", list() || document).indexOf(hit) : -1;
        if (i >= 0 && i !== sel) select(i, false);
    });

    // ---- preview ----
    const cache = new Map();
    let peekFor = "", peekCtrl;
    const peekBox = () => (results ? $("#peek") : palette && $(".peek", palette));

    async function showPeek(hit) {
        const box = peekBox();
        if (!box) return;
        if (!hit) { box.innerHTML = ""; peekFor = ""; return; }
        const href = hit.getAttribute("href");
        if (href === peekFor) return;
        peekFor = href;
        let html = cache.get(href);
        if (html === undefined) {
            peekCtrl?.abort();
            peekCtrl = new AbortController();
            try {
                const res = await call(href, { headers: { "X-Partial": "1" }, signal: peekCtrl.signal });
                html = await res.text();
                cache.set(href, html);
            } catch (e) { return; }
            if (peekFor !== href) return;
        }
        if (await peekSave?.discard()) refreshPage();
        await peekSave?.flush();
        box.innerHTML = html;
        box.scrollTop = 0;
        mountPeek(box, href);
        showRenderMode(); // its buttons came with it
    }

    // The note made last in this tab, until something is written in it.
    const freshNote = () => { try { return sessionStorage.getItem("fresh") || ""; } catch (e) { return ""; } };
    const forgetFresh = () => { try { sessionStorage.removeItem("fresh"); } catch (e) {} };

    // The words searched for, to mark in the note under the results.
    const searchTerms = () => tokenize(q?.value || "").filter((t) => !/^(#|in:|sort:|-)/i.test(t));

    // ---- settings ----
    const setting = (k) => { try { return localStorage.getItem(k) || ""; } catch (e) { return ""; } };
    const setSetting = (k, v) => { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch (e) {} };

    // ---- files dropped or pasted into a note ----
    // They go into the note's folder; the editor puts in the link it gets
    // back: an image shown, anything else linked.
    async function upload(file, note) {
        if (!note) { toast("Name the note first, then drop files into it"); return ""; }
        let name = file.name;
        // A pasted screenshot is called image.png; give it a name to tell apart.
        if (!name || /^image\.\w+$/.test(name)) {
            const ext = (file.type.split("/")[1] || "png").replace("jpeg", "jpg");
            name = "pasted-" + new Date().toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-") + "." + ext;
        }
        const fd = new FormData();
        fd.append("note", note);
        fd.append("file", file, name);
        const res = await call("/upload", { method: "POST", body: fd });
        if (!res.ok) { toast((await res.text()).trim()); return ""; }
        const saved = (await res.json()).name;
        const alt = name.replace(/\.[^.]+$/, "");
        return file.type.startsWith("image/") ? `![${alt}](${saved})` : `[${name}](${saved})`;
    }
    // Files dropped on a note's pane but not on its text, e.g. below a short
    // note, go to its editor all the same.
    document.addEventListener("drop", (e) => {
        if (e.defaultPrevented || !e.dataTransfer?.files.length) return;
        const view = e.target.closest?.(".editor") ? editView : e.target.closest?.(".peek") ? peekView : null;
        if (!view) return;
        e.preventDefault();
        if (!GoNotesEditor.dropFiles(view, [...e.dataTransfer.files], e.clientX, e.clientY)) toast("Files cannot go into this note");
    });
    // A file dropped beside an editor would make the browser leave the page
    // to show it.
    for (const ev of ["dragover", "drop"]) {
        document.addEventListener(ev, (e) => {
            if (e.dataTransfer?.types.includes("Files") && !e.defaultPrevented) e.preventDefault();
        });
    }

    // A note's title as the server finds it: front matter title:, else the
    // file name; never a heading. Kept in step while writing.
    const frontMatter = (text) => /^---\n[\s\S]*?\n---/.exec(text)?.[0] || "";
    function titleOf(text, path) {
        const t = /^title:\s*["']?(.+?)["']?\s*$/m.exec(frontMatter(text));
        return t ? t[1] : path.split("/").pop().replace(/\.[^.]+$/, "");
    }

    // retitle gives the text with its front matter title: changed, when it
    // has one; otherwise the text stays and only the file name changes.
    function retitle(text, title) {
        const fm = frontMatter(text);
        if (!/^title:/m.test(fm)) return text;
        return fm.replace(/^title:.*$/m, "title: " + title) + text.slice(fm.length);
    }
    // A title as a file name, as the server makes them.
    const fileNameOf = (title) => title.replace(/[\/\\\x00-\x1f]/g, "-").trim().replace(/^\.+/, "") || "untitled";

    // The note under the results is written in place and saved as you type.
    // A save the file on disk has moved past is refused; the pane then shows
    // the file as it is now.
    let peekSave = null, peekView = null, peekReady = null;
    function mountPeek(box, href) {
        const live = $(".live", box);
        const src = $(".src", box);
        if (!live || !src || !window.GoNotesEditor) return;
        const path = live.dataset.path;
        let mod = live.dataset.mod, text = src.value, timer = null, inflight = null;
        const state = $(".peek-state", box);
        const titleEl = $(".peek-title", box);
        const save = () => {
            clearTimeout(timer);
            timer = null;
            const body = text;
            if (state) state.textContent = "Saving…";
            inflight = call("/save", {
                method: "POST",
                headers: { Accept: "application/json" },
                body: new URLSearchParams({ path, orig: path, mod, body }),
            }).then(async (res) => {
                if (!res.ok) {
                    toast((await res.text()).trim() || "Not saved");
                    if (state) state.textContent = "Not saved";
                    return;
                }
                mod = (await res.json()).mod;
                cache.delete(href);
                if (state) state.textContent = "Saved";
            }).catch(() => state && (state.textContent = "Not saved"))
              .finally(() => { inflight = null; if (timer === 0) save(); });
            return inflight;
        };
        peekSave = {
            // Sends what is not saved yet, e.g. before the pane shows another note.
            flush: () => (timer !== null ? (inflight ? inflight.then(save) : save()) : inflight),
            keepalive: () => {
                if (peekSave.empty()) {
                    navigator.sendBeacon?.("/discard", new URLSearchParams({ path, vault }));
                    return;
                }
                if (timer === null) return;
                clearTimeout(timer);
                navigator.sendBeacon?.("/save", new URLSearchParams({ path, orig: path, mod, body: text, vault }));
            },
            // A note just made and left with nothing in it is not kept.
            empty: () => path === freshNote() && !text.trim(),
            discard: async () => {
                if (!peekSave.empty()) return false;
                clearTimeout(timer);
                timer = null;
                await call("/discard", { method: "POST", body: new URLSearchParams({ path }) });
                forgetFresh();
                return true;
            },
        };
        // Click the title to rename the note: its file name, and a front
        // matter title: if it has one, in one save. Enter or leaving the
        // field renames, Esc not.
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
                if (!keep || !title || title === titleOf(text, path)) { input.replaceWith(titleEl); return; }
                await peekSave.flush();
                const ext = /\.[^./]+$/.exec(path)?.[0] || ".md";
                const to = (dirOf(path) ? dirOf(path) + "/" : "") + fileNameOf(title) + ext;
                const res = await call("/save", {
                    method: "POST",
                    headers: { Accept: "application/json" },
                    body: new URLSearchParams({ path: to, orig: path, mod, body: retitle(text, title) }),
                });
                if (!res.ok) {
                    toast((await res.text()).trim());
                    done = false;
                    input.focus();
                    return;
                }
                const np = (await res.json()).path;
                toast("Renamed to " + np.split("/").pop());
                if (focused()) { location.replace(withOpen(np)); return; }
                await refreshPage();
                const i = $$(".hit", results || list()).findIndex((h) => h.dataset.path === np);
                if (i >= 0) select(i, false);
            };
            input.addEventListener("keydown", (e) => {
                if (e.key === "Enter") { e.preventDefault(); finish(true); }
                if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(false); }
            });
            input.addEventListener("blur", () => finish(true));
        });

        peekView = GoNotesEditor.mount(live, {
            doc: text,
            dir: live.dataset.dir,
            terms: searchTerms(),
            vim: setting("vim") === "on",
            source: setting("render") === "source",
            onFile: (f) => upload(f, path),
            onChange: (t) => {
                text = t;
                if (titleEl) titleEl.textContent = titleOf(t, path);
                clearTimeout(timer);
                // A change while a save is on its way is saved after it.
                if (inflight) timer = 0;
                else timer = setTimeout(save, 700);
            },
            onSave: () => peekSave.flush(),
            onClose: () => { leaveFocus(); q?.focus(); },
        });
    }
    addEventListener("pagehide", () => peekSave?.keepalive());

    // ---- Live or Source, top right of the note: kept in this browser ----
    let editView = null;
    const showRenderMode = () => {
        const mode = setting("render") || "live";
        $$("[data-render]").forEach((b) => b.classList.toggle("on", b.dataset.render === mode));
    };
    document.addEventListener("click", (e) => {
        const b = e.target.closest?.("[data-render]");
        if (!b) return;
        const source = b.dataset.render === "source";
        setSetting("render", source ? "source" : "");
        for (const v of [peekView, editView]) if (v) GoNotesEditor.setSource(v, source);
        showRenderMode();
        (editView || peekView)?.focus();
    });
    showRenderMode();
    document.addEventListener("pointerdown", (e) => {
        if (palette && !palette.hidden && !e.target.closest(".search")) closePalette();
    });

    // A box that arrives focused with a query in it has its caret at the end,
    // ready to type on.
    // Autofocus can land after this script has run, so do it on first focus.
    const caretToEnd = () => {
        if (q.selectionStart === 0 && q.selectionEnd === 0) q.setSelectionRange(q.value.length, q.value.length);
    };
    if (q && document.activeElement === q) caretToEnd();
    else q?.addEventListener("focus", caretToEnd, { once: true });

    // The shortcut hint says what this machine's keyboard calls it.
    const mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
    const hint = $(".search > kbd");
    if (hint) hint.textContent = mac ? "⌘K" : "Ctrl K";
    if (mac) $$("kbd.alt").forEach((k) => (k.textContent = k.textContent.replace("Alt ", "⌥")));

    // ---- keyboard ----
    function select(i, scroll = true) {
        const hits = $$(".hit", list() || document);
        if (!hits.length) { showPeek(null); return; }
        sel = Math.max(0, Math.min(hits.length - 1, i));
        hits.forEach((h, j) => h.classList.toggle("sel", j === sel));
        if (scroll) hits[sel].scrollIntoView({ block: "nearest" });
        peekReady = showPeek(hits[sel]);
    }
    const hitsShown = () => (results && !focused()) || (palette && !palette.hidden);

    // ---- one note, the list folded away ----
    const focused = () => document.body.classList.contains("focus");
    // The list folds shut, or opens again, by animating its height.
    const fold = (el, open) => {
        el.getAnimations().forEach((x) => x.cancel());
        el.classList.remove("folded");
        const mb = getComputedStyle(el).marginBottom;
        const frames = [{ height: el.scrollHeight + "px", marginBottom: mb, opacity: 1 }, { height: "0px", marginBottom: "0px", opacity: 0 }];
        const opts = { duration: 180, easing: "cubic-bezier(0.2, 0, 0.13, 1)" };
        if (open) { el.animate(frames.reverse(), opts); return; }
        const anim = el.animate(frames, { ...opts, fill: "forwards" });
        anim.finished.then(() => { if (focused()) el.classList.add("folded"); anim.cancel(); }, () => {});
    };
    // The note open in place, if one is.
    const openNote = () => (focused() && $("#peek .live")?.dataset.path) || null;
    // The address of the list with a note open, or without one.
    const withOpen = (p) => {
        const u = new URL(location.href);
        p ? u.searchParams.set("open", p) : u.searchParams.delete("open");
        return u.pathname + u.search;
    };

    // What folds away while a note is open in place: the box and the list.
    const folding = () => [q.closest("form"), results];

    // Ctrl+K and / go to the search box, bringing it back where writing hid it:
    // a note open in place closes, the editor page shows it until it is left.
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

    const phone = () => matchMedia("(max-width: 52rem)").matches;

    // ---- the list's height ----
    // Drag the line under the list (or ↑↓ on it) to give it more or fewer
    // rows, kept in this browser; double click or Alt+Enter (Alt+L too)
    // gives it the page.
    const browse = $(".browse");
    const splitter = $(".splitter");
    const beside = () => document.documentElement.dataset.list === "side" && matchMedia("(width > 52rem)").matches;
    const rowPx = () => 1.85 * parseFloat(getComputedStyle(document.documentElement).fontSize);
    let rows = Math.max(2, Number(setting("list-rows")) || 6);
    // As many rows as leave the note some room.
    const maxRows = () => {
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
    // Whether the full list was on when a note opened, to come back to it.
    let fullBeforeNote = false;
    function fullList(on = !browse.classList.contains("listfull")) {
        if (focused()) return;
        browse.classList.toggle("listfull", on);
        $$(".hit", results)[sel]?.scrollIntoView({ block: "nearest" });
    }
    if (browse) setRows(rows, false, false); // as kept: the page may be folded now
    // Beside the note (Options → List), the line drags the list's width instead.
    let listW = Number(setting("list-width")) || 0;
    function setWidth(px, keep = true) {
        const w = browse.getBoundingClientRect().width;
        listW = Math.round(Math.max(12 * rowPx(), Math.min(px, w - 20 * rowPx())));
        browse.style.setProperty("--listw", listW + "px");
        if (keep) setSetting("list-width", String(listW));
    }
    if (browse && listW) browse.style.setProperty("--listw", listW + "px");
    splitter?.setAttribute("aria-orientation", beside() ? "vertical" : "horizontal");
    splitter?.addEventListener("pointerdown", (e) => {
        if (e.button !== 0 || e.target.closest(".fulllist")) return;
        e.preventDefault();
        splitter.setPointerCapture(e.pointerId);
        splitter.classList.add("dragging");
        const top = results.getBoundingClientRect().top + 8; // the list's own top margin
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

    async function focusNote(hit) {
        if (!focused()) fullBeforeNote = !!browse?.classList.contains("listfull");
        browse?.classList.remove("listfull");
        const hits = $$(".hit", results);
        const i = hits.indexOf(hit);
        if (i !== sel) select(i, false);
        await peekReady;
        if (!focused()) {
            document.body.classList.add("focus", "dim");
            history.pushState({ focus: true }, "", withOpen(hit.dataset.path));
            for (const el of folding()) {
                if (!matchMedia("(prefers-reduced-motion: reduce)").matches) fold(el, false);
                else el.classList.add("folded");
            }
        }
        peekView?.focus();
    }
    // back: the history entry focusNote added is left with the browser's Back.
    function leaveFocus(back = true) {
        if (!focused()) return;
        peekSave?.discard().then((gone) => gone && refreshPage());
        document.body.classList.remove("focus", "dim");
        if (fullBeforeNote) { browse.classList.add("listfull"); fullBeforeNote = false; }
        for (const el of folding()) {
            if (!matchMedia("(prefers-reduced-motion: reduce)").matches) fold(el, true);
            else el.classList.remove("folded");
        }
        if (!back) return;
        if (history.state?.focus) history.back();
        else history.replaceState(null, "", withOpen(null)); // opened by its address
    }
    // ← in the note's header: back to the list, as Esc. On a phone the
    // search box keeps out of the way, or its keyboard would pop up.
    document.addEventListener("click", (e) => {
        if (!e.target.closest?.("[data-back]")) return;
        leaveFocus();
        if (!phone()) q?.focus();
    });
    addEventListener("popstate", () => {
        const open = new URL(location.href).searchParams.get("open");
        if (focused() && !open) leaveFocus(false);
        else if (!focused() && open) location.reload(); // forward again
    });

    // ---- new notes: made at once, and opened in place ----
    // from: what was searched for, its words the title; else an Untitled
    // note in the folder in view.
    async function newNote(from = "") {
        const dir = $(".facets a.on[data-dir]")?.dataset.dir || document.body.dataset.newdir || "";
        const res = await call("/new", {
            method: "POST",
            headers: { Accept: "application/json" },
            body: new URLSearchParams(from ? { from } : { dir }),
        });
        if (!res.ok) { toast((await res.text()).trim()); return; }
        const { path: made, url } = await res.json();
        try {
            sessionStorage.setItem("caret", "end");
            sessionStorage.setItem("fresh", made); // dropped if left empty
        } catch (e) {}
        location.href = url;
    }

    document.addEventListener("keydown", (e) => {
        // Cmd+K or Ctrl+K: search from anywhere, the editor included.
        if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "k") {
            e.preventDefault();
            toSearch();
            return;
        }
        // Ctrl+Q closes the app window. The browser only lets a page close
        // itself in some windows, so say how when it does not.
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
        // Alt+↑↓ walks the folders, the list following at once; Alt+→←
        // opens or closes the folder in view. Not in a note, where Alt+↑↓
        // moves lines.
        if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && /^Arrow/.test(e.key) && results && !focused()
            && (document.activeElement === q || !typing(document.activeElement))) {
            e.preventDefault();
            folderStep(e.key);
            return;
        }
        // Alt+1…9 switches vault and Alt+V opens the menu, from anywhere;
        // by key position, since Alt with a digit types a character on a Mac.
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
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        if (e.key === "Escape" && optMenu && !optMenu.hidden) { toggleOptions(false); optBtn.focus(); return; }
        // Esc in the note under the results brings the list back and goes to
        // the search box; in vim it first leaves insert mode, and :q comes back.
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
            if (e.key === "Delete" && atEnd && hitsShown() && sel >= 0) {
                e.preventDefault();
                const hit = $$(".hit", list())[sel];
                if (several()) deleteMany(several());
                else if (hit) deleteNote(hit.dataset.path);
                return;
            }
            if (arrow) {
                e.preventDefault();
                if (pending) { queued = Math.max(0, queued + arrow); return; }
                if (palette && palette.hidden) { runSearch(); return; }
                stepTo(sel + arrow, e.shiftKey);
            } else if (e.key === "Escape") {
                e.preventDefault();
                if (palette && !palette.hidden) closePalette();
                else if (q.value && results) { q.value = ""; runSearch(); }
                else q.blur();
            }
            return;
        }
        if (typing(document.activeElement)) return;
        if (arrow && hitsShown()) {
            e.preventDefault();
            stepTo(sel + arrow, e.shiftKey);
            return;
        }
        switch (e.key) {
            case "/": e.preventDefault(); toSearch(); break;
            case "j": if (hitsShown()) stepTo(sel + 1, false); break;
            case "k": if (hitsShown()) stepTo(sel - 1, false); break;
            case "J": if (hitsShown()) stepTo(sel + 1, true); break;
            case "K": if (hitsShown()) stepTo(sel - 1, true); break;
            case "Enter": if (sel >= 0 && hitsShown()) open($$(".hit", list())[sel]); break;
            case "Delete": case "Backspace": {
                const p = (hitsShown() && sel >= 0 && $$(".hit", list())[sel]?.dataset.path) || openNote();
                if (several() && hitsShown()) { e.preventDefault(); deleteMany(several()); }
                else if (p) { e.preventDefault(); deleteNote(p); }
                break;
            }
            case "n": newNote(); break;
            case "?": location.href = "/n/gonotes-help.md"; break;
            case "e": {
                // Edit the note open in place, or the one selected in the list.
                const hit = hitsShown() && sel >= 0 && $$(".hit", list())[sel];
                if (openNote()) grow("/edit/" + noteURL(openNote()).slice(3));
                else if (hit) grow(editHref(hit));
                break;
            }
            case "Escape":
                if (focused()) { leaveFocus(); q?.focus(); }
                break;
        }
    });

    if (results && focused()) {
        // Opened by its address: the note is in place already, ready to write.
        // The help note has no editor; its path is in the pane's header.
        const p = openNote() || $("#peek .peek-path")?.textContent || "";
        peekFor = "/n/" + p.split("/").map(encodeURIComponent).join("/");
        sel = $$(".hit", results).findIndex((h) => h.dataset.path === p);
        $$(".hit", results)[sel]?.classList.add("sel");
        let end = false;
        try { end = sessionStorage.getItem("caret") === "end"; sessionStorage.removeItem("caret"); } catch (e) {}
        mountPeek($("#peek"), peekFor);
        peekView?.focus();
        if (end) peekView?.dispatch({ selection: { anchor: peekView.state.doc.length } });
    } else if (results) {
        const first = $(".hit", results);
        if (first) {
            sel = 0;
            first.classList.add("sel");
            peekFor = first.getAttribute("href");
            mountPeek($("#peek"), peekFor);
        }
    }

    // ---- drag a note or a folder onto a folder to move it ----
    const MIME = "application/x-gonotes-path";
    const DIR_MIME = "application/x-gonotes-dir";
    const MANY_MIME = "application/x-gonotes-paths";
    // The folder being dragged, since a drop target cannot read it before the drop.
    let dragDir = null;
    const inside = (d, folder) => d === folder || d.startsWith(folder + "/");
    function dropTarget(e) {
        const types = e.dataTransfer?.types || [];
        const t = e.target.closest?.(".facets a[data-tok]");
        if (!t) return null;
        if (types.includes(MIME)) return t;
        if (!types.includes(DIR_MIME) || dragDir === null) return null;
        const to = t.dataset.tok.replace(/^in:/, "");
        // Not into itself, nor where it already is.
        return inside(to, dragDir) || to === dirOf(dragDir) ? null : t;
    }
    const clearDrop = (keep) => $$(".drop").forEach((el) => el !== keep && el.classList.remove("drop"));

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
            // A marked row takes the other marked ones with it.
            if (several() && marked.has(src.dataset.path)) e.dataTransfer.setData(MANY_MIME, JSON.stringify(several()));
        }
        e.dataTransfer.effectAllowed = "move";
        document.body.classList.add("dragging");
    });
    document.addEventListener("dragend", () => {
        document.body.classList.remove("dragging");
        dragDir = null;
        clearDrop();
    });
    document.addEventListener("dragover", (e) => {
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
        const to = t.dataset.tok.replace(/^in:/, "");
        const folder = e.dataTransfer.getData(DIR_MIME);
        const many = e.dataTransfer.getData(MANY_MIME);
        if (folder) moveFolder(folder, to, true);
        else if (many) moveMany(JSON.parse(many), to);
        else moveNote(e.dataTransfer.getData(MIME), to, true);
    });

    const dirOf = (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
    const noteURL = (p) => "/n/" + p.split("/").map(encodeURIComponent).join("/");

    // ---- several notes at once ----
    // Shift with a click, ↑↓ or J K marks the rows from where it started;
    // a plain click or arrow is one note again. Marked notes are deleted
    // and dragged together.
    let marked = new Set(), anchor = -1;
    const several = () => (marked.size > 1 ? [...marked] : null);
    function showMarks() {
        $$(".hit", list() || document).forEach((h) => h.classList.toggle("marked", marked.has(h.dataset.path)));
    }
    function markTo(i) {
        const hits = $$(".hit", list() || document);
        if (anchor < 0) anchor = sel >= 0 ? sel : i;
        const [a, b] = anchor < i ? [anchor, i] : [i, anchor];
        marked = new Set(hits.slice(a, b + 1).map((h) => h.dataset.path));
        showMarks();
    }
    function unmark() {
        anchor = -1;
        if (!marked.size) return;
        marked = new Set();
        showMarks();
    }
    function stepTo(i, extend) {
        if (extend && anchor < 0) anchor = Math.max(sel, 0);
        select(i);
        extend ? markTo(sel) : unmark();
    }
    async function deleteMany(paths) {
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
        for (const path of paths) {
            if (dirOf(path) === dir) continue;
            const res = await call("/move", { method: "POST", body: new URLSearchParams({ path, dir }) });
            if (res.ok) done.push({ from: path, to: (await res.json()).path });
            else toast((await res.text()).trim());
        }
        unmark();
        await refreshPage();
        if (undo || !done.length) return;
        toast(`Moved ${done.length} notes to ` + (dir || "the top level"), { label: "Undo", fn: async () => {
            for (const d of done) await call("/move", { method: "POST", body: new URLSearchParams({ path: d.to, dir: dirOf(d.from) }) });
            await refreshPage();
        } });
    }

    async function moveNote(from, dir, undoable) {
        if (dirOf(from) === dir) return;
        const res = await call("/move", { method: "POST", body: new URLSearchParams({ path: from, dir }) });
        if (!res.ok) { toast((await res.text()).trim()); return; }
        const { path } = await res.json();
        await afterMove(from, path);
        toast("Moved to " + (dir || "the top level"),
            undoable && { label: "Undo", fn: () => moveNote(path, dirOf(from), false) });
    }

    async function moveFolder(from, dir, undoable) {
        const res = await call("/movedir", { method: "POST", body: new URLSearchParams({ path: from, dir }) });
        if (!res.ok) { toast((await res.text()).trim()); return; }
        const { path } = await res.json();
        if (path === from) return;
        await afterMove(from, path, true);
        toast("Moved " + from.split("/").pop() + " to " + (dir || "the top level"),
            undoable && { label: "Undo", fn: () => moveFolder(path, dirOf(from), false) });
    }

    // Brings the page in line with a move without losing the place in it:
    // the note on screen or in the editor, and for a folder, the notes in it
    // and a search narrowed to it.
    async function afterMove(from, to, folder = false) {
        const moved = (p) => (p === from ? to : folder && p.startsWith(from + "/") ? to + p.slice(from.length) : null);
        // The note open in place is reopened where it went.
        const open = openNote();
        if (open && moved(open) !== null) {
            await peekSave?.flush();
            location.replace("/?open=" + encodeURIComponent(moved(open)));
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

    // ---- right click: show a note or folder in the file manager ----
    const fileManager = mac ? "Finder" : /Win/.test(navigator.platform || navigator.userAgent) ? "Explorer" : "Files";
    function contextMenu(x, y, items) {
        $(".ctxmenu")?.remove();
        const menu = document.createElement("ul");
        menu.className = "ctxmenu";
        menu.setAttribute("role", "menu");
        for (const [label, fn] of items) {
            const li = document.createElement("li");
            const b = document.createElement("button");
            b.type = "button";
            b.setAttribute("role", "menuitem");
            b.textContent = label;
            b.addEventListener("click", () => { menu.remove(); fn(); });
            li.append(b);
            menu.append(li);
        }
        document.body.append(menu);
        // Kept inside the window.
        const r = menu.getBoundingClientRect();
        menu.style.left = Math.min(x, innerWidth - r.width - 8) + "px";
        menu.style.top = Math.min(y, innerHeight - r.height - 8) + "px";
        menu.querySelector("button")?.focus();
    }
    const closeMenu = () => $(".ctxmenu")?.remove();
    document.addEventListener("pointerdown", (e) => { if (!e.target.closest?.(".ctxmenu")) closeMenu(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && $(".ctxmenu")) { e.preventDefault(); e.stopPropagation(); closeMenu(); } }, true);
    addEventListener("blur", closeMenu);
    async function revealIn(path) {
        const res = await call("/reveal", { method: "POST", body: new URLSearchParams({ path }) });
        if (!res.ok) toast((await res.text()).trim());
    }
    document.addEventListener("contextmenu", (e) => {
        const hit = e.target.closest?.(".hit");
        const folder = e.target.closest?.(".facets a[data-dir]");
        const path = hit?.dataset.path || folder?.dataset.dir;
        if (!path || path === "gonotes-help.md") return;
        e.preventDefault();
        if (hit) select($$(".hit", list() || document).indexOf(hit), false);
        const items = [["Show in " + fileManager, () => revealIn(path)]];
        const many = hit && marked.has(path) && several();
        if (many) items.push([`Delete ${many.length} notes`, () => deleteMany(many)]);
        else if (hit) items.push(["Delete", () => deleteNote(path)]);
        if (folder) {
            items.push(["Rename…", () => renameFolder(folder)]);
            const li = folder.closest("li");
            // A folder inside one left out is out with it; only that one can let it in.
            const own = li.classList.contains("excluded") && !$$(".facets li.excluded[data-dir]").some((o) => o !== li && under(path, o.dataset.dir));
            if (!li.classList.contains("excluded")) items.push(["Exclude from search", () => excludeDir(path, true)]);
            else if (own) items.push(["Include in search", () => excludeDir(path, false)]);
            items.push(["Delete…", () => deleteFolder(path)]);
        }
        contextMenu(e.clientX, e.clientY, items);
    });

    // ---- leave a folder out of searches, or take it back in ----
    async function excludeDir(dir, on) {
        const res = await call("/exclude", { method: "POST", body: new URLSearchParams(on ? { dir, on: "1" } : { dir }) });
        if (!res.ok) { toast((await res.text()).trim()); return; }
        await refreshPage();
        toast(on ? dir.split("/").pop() + " is left out of searches" : dir.split("/").pop() + " is searched again",
            { label: "Undo", fn: () => excludeDir(dir, !on) });
    }

    // ---- rename a folder, in place in the list ----
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
            if (!keep || !name || name === from.split("/").pop()) { input.remove(); link.hidden = false; return; }
            if (await renameDir(from, name, true)) return;
            done = false;
            input.focus();
        };
        input.addEventListener("keydown", (e) => {
            if (e.key === "Enter") { e.preventDefault(); finish(true); }
            if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(false); }
        });
        input.addEventListener("blur", () => finish(true));
    }
    async function renameDir(from, name, undoable) {
        const res = await call("/renamedir", { method: "POST", body: new URLSearchParams({ path: from, name }) });
        if (!res.ok) { toast((await res.text()).trim()); return false; }
        const { path } = await res.json();
        // Folds kept under the old name follow it.
        const closed = closedFolds();
        for (const c of [...closed]) {
            if (c === from || under(c, from)) { closed.delete(c); closed.add(path + c.slice(from.length)); }
        }
        setSetting(foldKey(), closed.size ? JSON.stringify([...closed]) : "");
        await afterMove(from, path, true);
        toast("Renamed to " + name, undoable && { label: "Undo", fn: () => renameDir(path, from.split("/").pop(), false) });
        return true;
    }

    // ---- on a phone, the folders and the tags behind buttons, above the list ----
    // One at a time: opening one closes the other.
    $$(".foldersbtn").forEach((b) => b.addEventListener("click", () => {
        const panel = b.dataset.panel;
        const open = document.body.dataset.panel !== panel;
        if (open) document.body.dataset.panel = panel;
        else delete document.body.dataset.panel;
        $$(".foldersbtn").forEach((o) => o.setAttribute("aria-expanded", String(open && o === b)));
    }));

    // ---- the whole sidebar folded away, or back: ◀ / ▶ or Alt+B ----
    function foldSidebar(on = document.documentElement.dataset.side !== "folded") {
        if (on) document.documentElement.dataset.side = "folded";
        else delete document.documentElement.dataset.side;
        setSetting("sidebar", on ? "folded" : "");
        for (const v of [peekView, editView]) v?.requestMeasure(); // wider now
    }
    $("#sidefold")?.addEventListener("click", () => foldSidebar(true));
    $("#sideopen")?.addEventListener("click", () => foldSidebar(false));

    // ---- folders open and closed ----
    // A folder with folders in it has an arrow to open and close it; the
    // button by Folders opens or closes them all. Which are closed is kept in
    // this browser, per vault. The folder in view is never hidden away.
    const foldKey = () => "folds:" + vault;
    const closedFolds = () => { try { return new Set(JSON.parse(setting(foldKey()) || "[]")); } catch (e) { return new Set(); } };
    const under = (d, parent) => d.startsWith(parent + "/");
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
            arrow.title = parents.has(d) ? (closed.has(d) ? "Open" : "Close") : "";
            li.hidden = [...closed].some((c) => under(d, c));
        }
        const all = $("#foldall");
        if (all) {
            const anyOpen = [...parents].some((d) => !closed.has(d));
            all.hidden = !parents.size;
            all.dataset.close = String(anyOpen);
            all.title = anyOpen ? "Close all folders" : "Open all folders";
            all.textContent = anyOpen ? "⊟" : "⊞";
        }
    }
    function setFolds(closed) {
        setSetting(foldKey(), closed.size ? JSON.stringify([...closed]) : "");
        applyFolds();
    }
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
        setFolds(all.dataset.close === "true" ? new Set(parents) : new Set());
    });
    applyFolds();
    // Picking a folder opens it too, to show the folders in it.
    function openFold(d) {
        const closed = closedFolds();
        if (d && closed.delete(d)) setFolds(closed);
    }
    document.addEventListener("click", (e) => {
        const a = e.target.closest?.(".facets a[data-dir]");
        if (a && e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) openFold(a.dataset.dir);
    });

    // ---- new folder ----
    // + by Folders, or n on a folder from the keyboard: a box in the list for
    // the name, inside the folder in view. Enter makes it, Esc lets it be.
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
            if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); done = true; li.remove(); return; }
            if (e.key !== "Enter") return;
            e.preventDefault();
            const dir = input.value.trim().replace(/^\/+|\/+$/g, "");
            if (!dir) { done = true; li.remove(); return; }
            const res = await call("/mkdir", { method: "POST", body: new URLSearchParams({ dir }) });
            if (!res.ok) { toast((await res.text()).trim()); return; }
            done = true;
            await refreshPage();
            toast("Created " + (await res.json()).dir);
        });
        input.addEventListener("blur", () => setTimeout(() => { if (!done) li.remove(); }, 150));
    }
    document.addEventListener("click", (e) => { if (e.target.closest("#addfolder")) newFolder(); });

    // Re-reads the sidebar and the results after a change on disk, keeping
    // the selection where it was.
    async function refreshPage(main = false) {
        cache.clear();
        peekFor = "";
        const doc = new DOMParser().parseFromString(await (await call(location.pathname + location.search)).text(), "text/html");
        $(".side-body").innerHTML = $(".side-body", doc).innerHTML;
        applyFolds();
        if (vaultMenu) vaultMenu.innerHTML = $("#vaultmenu", doc).innerHTML;
        if (main) $(".main").innerHTML = $(".main", doc).innerHTML;
        if (results || (palette && !palette.hidden)) {
            queued = Math.max(sel, 0);
            await runSearch();
        }
    }

    // ---- the folder list from the keyboard ----
    // ← from the results (or on a note) walks into the folders: ↑↓ pick one,
    // Enter opens it, m moves the selected note there, → or Esc come back.
    let fsel = -1;
    const folders = () => $$(".facets a[data-tok]").filter((a) => !a.closest("li").hidden);
    const inFolders = () => fsel >= 0;
    // The note m would move: the selected row, else the note on screen.
    const currentNote = () => openNote() || (sel >= 0 && $$(".hit", list() || document)[sel]?.dataset.path);

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
        // Start on the folder in view, else the selected note's own folder.
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
            case "ArrowDown": case "j": pickFolder(fsel + 1); break;
            case "ArrowUp": case "k": pickFolder(fsel - 1); break;
            case "Home": pickFolder(0); break;
            case "End": pickFolder(folders().length - 1); break;
            case "Enter": openFold(a.dataset.dir); leaveFolders(); location.href = a.dataset.tok ? "/?q=" + encodeURIComponent(quoteTok(a.dataset.tok)) : "/"; break;
            case "m": {
                const p = currentNote();
                leaveFolders();
                if (p) moveNote(p, a.dataset.tok.replace(/^in:/, ""), true);
                else toast("No note selected to move");
                break;
            }
            case "n": leaveFolders(); newFolder(a.dataset.dir || ""); break;
            // → opens a closed folder, ← closes an open one; → on any other
            // goes back to the list, as Esc does.
            case "ArrowRight": case "ArrowLeft": {
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
            case "Escape": leaveFolders(); break;
            default: return false;
        }
        e.preventDefault();
        return true;
    }
    // Alt with the arrows, on the list page: the next or previous folder is
    // picked as a click would, without leaving the page.
    function folderStep(key) {
        leaveFolders();
        const all = folders();
        const cur = all.findIndex((a) => a.classList.contains("on"));
        if (key === "ArrowUp" || key === "ArrowDown") {
            const a = all[Math.max(0, Math.min(all.length - 1, cur + (key === "ArrowDown" ? 1 : -1)))];
            if (!a || a === all[cur]) return;
            q.value = new URL(a.href).searchParams.get("q") || "";
            runSearch();
            a.scrollIntoView({ block: "nearest" });
            return;
        }
        const d = all[cur]?.dataset.dir;
        if (!d) return;
        const closed = closedFolds();
        if (key === "ArrowRight" ? closed.delete(d) : !closed.has(d) && closed.add(d)) setFolds(closed);
    }
    const quoteTok = (t) => (/\s/.test(t) ? `"${t}"` : t);
    document.addEventListener("pointerdown", (e) => { if (inFolders() && !e.target.closest(".facets")) leaveFolders(); });

    // ---- switch vaults ----
    // v opens the menu: 1–9 or ↑↓ and Enter pick a vault, Esc closes it.
    const vaultBtn = $("#vault");
    const vaultMenu = $("#vaultmenu");
    let vsel = -1;
    const vaultLinks = () => $$("a[data-vault]", vaultMenu);
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
    vaultBtn?.addEventListener("click", () => (vaultMenu.hidden ? openVaults() : closeVaults()));
    document.addEventListener("pointerdown", (e) => { if (!e.target.closest(".vaults")) closeVaults(); });

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
            case "ArrowDown": case "j": pickVault(vsel + 1); break;
            case "ArrowUp": case "k": pickVault(vsel - 1); break;
            case "Enter": location.href = all[vsel].href; break;
            case "Escape": case "v": closeVaults(); vaultBtn.focus(); break;
            case "Tab": closeVaults(); return false;
            default: return false;
        }
        e.preventDefault();
        return true;
    }

    // ---- the Vaults page: a folder picker for each vault ----
    // Browse… opens the folders where the field points (or home): click one
    // to go in, ↑ to go up, Use this folder to take it.
    async function browseTo(field, dir) {
        const picker = $(".picker", field);
        const res = await call("/browse?dir=" + encodeURIComponent(dir));
        if (!res.ok) {
            if (dir !== "~") return browseTo(field, "~"); // a folder not made yet
            toast((await res.text()).trim());
            return;
        }
        const { dir: here, parent, dirs, places = [] } = await res.json();
        picker.replaceChildren();
        // Home and the drives, to jump to.
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
        up.textContent = "↑";
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
    // Browse… opens the desktop's own folder dialog, drives and all; where
    // there is none, the folder list here.
    document.addEventListener("click", async (e) => {
        const b = e.target.closest?.("[data-browse]");
        if (!b) return;
        const field = b.closest(".folderfield");
        const picker = $(".picker", field);
        if (!picker.hidden) { picker.hidden = true; return; }
        const label = b.textContent;
        b.disabled = true;
        b.textContent = "Waiting for the dialog…";
        try {
            const res = await call("/pickdir", { method: "POST" });
            if (res.status === 200) { $("input", field).value = (await res.json()).dir; return; }
            if (res.status === 204) return; // cancelled
            browseTo(field, $("input", field).value.trim() || "~");
        } finally {
            b.disabled = false;
            b.textContent = label;
        }
    });
    document.addEventListener("keydown", (e) => {
        const picker = e.key === "Escape" && e.target.closest?.(".folderfield")?.querySelector(".picker:not([hidden])");
        if (picker) { e.preventDefault(); picker.hidden = true; }
    });

    // ---- the Vaults page: gradients follow their sliders ----
    // The page takes on a vault's colours while they are picked, when it is
    // the vault it shows.
    function showGradient(row) {
        const [a, b] = $$("input[type=range]", row).map((r) => r.value);
        row.style.setProperty("--g1", a);
        row.style.setProperty("--g2", b);
        if (row.dataset.orig && row.dataset.orig === vault) {
            document.documentElement.style.setProperty("--hue-accent", a);
            document.documentElement.style.setProperty("--hue-accent2", b);
        }
    }
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

    // ---- delete the selected note ----
    async function deleteNote(p) {
        const res = await call("/delete", {
            method: "POST",
            headers: { Accept: "application/json" },
            body: new URLSearchParams({ path: p }),
        });
        if (!res.ok) { toast((await res.text()).trim()); return; }
        const { trash } = await res.json();
        tourStep("delete", "done");
        const name = p.split("/").pop();
        if (openNote() === p) {
            // The note open in place is gone: go to its folder, the toast with it.
            toastNext("Deleted " + name, { trash, path: p });
            const d = dirOf(p);
            location.href = d ? "/?q=" + encodeURIComponent(quoteTok("in:" + d)) : "/";
            return;
        }
        await refreshPage();
        toast("Deleted " + name, { label: "Undo", fn: () => restoreNote(trash, p) });
    }
    // A folder goes to .trash with all in it, after asking, since that can be
    // a lot; Undo brings it all back.
    async function deleteFolder(d) {
        const name = d.split("/").pop();
        // With subfolders counted in, the folder's own number has them all;
        // else they add up.
        const count = (li) => Number($("a > span", li)?.textContent) || 0;
        const lis = $$(".facets li[data-dir]").filter((li) => li.dataset.dir === d || under(li.dataset.dir, d));
        const notes = $("#opt-sub")?.checked ? count(lis.find((li) => li.dataset.dir === d)) : lis.reduce((n, li) => n + count(li), 0);
        const what = `${notes} note${notes === 1 ? "" : "s"}`;
        if (!confirm(`Delete the folder “${name}” and ${what} in it? It goes to .trash; Undo brings it back.`)) return;
        const res = await call("/delete", {
            method: "POST",
            headers: { Accept: "application/json" },
            body: new URLSearchParams({ path: d }),
        });
        if (!res.ok) { toast((await res.text()).trim()); return; }
        const { trash } = await res.json();
        // Looking at it, or at a note in it: go to the folder it was in.
        const on = $(".facets a.on[data-dir]")?.dataset.dir;
        const open = openNote();
        if ((on && (on === d || under(on, d))) || (open && under(open, d))) {
            toastNext("Deleted " + name, { trash, path: d });
            location.href = dirOf(d) ? "/?q=" + encodeURIComponent(quoteTok("in:" + dirOf(d))) : "/";
            return;
        }
        await refreshPage();
        toast("Deleted " + name, { label: "Undo", fn: () => restoreNote(trash, d) });
    }
    async function restoreNote(trash, p) {
        const res = await call("/restore", { method: "POST", body: new URLSearchParams({ trash, path: p }) });
        if (!res.ok) { toast((await res.text()).trim()); return; }
        await refreshPage();
        toast("Restored " + p.split("/").pop());
    }
    try {
        const t = JSON.parse(sessionStorage.getItem("toast") || "null");
        sessionStorage.removeItem("toast");
        if (t) toast(t.msg, t.undo && { label: "Undo", fn: () => restoreNote(t.undo.trash, t.undo.path) });
    } catch (e) {}

    // ---- the tour, after the first vault is picked ----
    // A card in the corner says what to do next, and moves on as it is done:
    // a note made and open, then a note deleted. Skip ends it; Options can
    // show it again.
    const TOUR = {
        note: "<b>2.</b> Type a name for your first note in the search box and press <kbd>Enter</kbd>. It opens, ready to write in.",
        delete: "<b>3.</b> Write something: it saves by itself. Press <kbd>Esc</kbd> to get back to the list, then <kbd>Delete</kbd> to delete the selected note. A message at the bottom lets you undo it.",
        done: "That's all. <kbd>?</kbd> shows every key, <kbd>Ctrl K</kbd> searches from anywhere.",
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
        skip.addEventListener("click", () => { setSetting("tour", ""); card.remove(); });
        card.append(skip);
        document.body.append(card);
        if (step === "done") { setSetting("tour", ""); setTimeout(() => card.remove(), 8000); }
    }
    const tourStep = (from, to) => { if (setting("tour") === from) { setSetting("tour", to); showTour(); } };
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

    // ---- editor ----
    const form = $("#editor");
    if (!form) return;
    // The text lives in the live editor; the hidden #body carries it in the
    // form, for saving the old way.
    const body = $("#body", form);
    const live = $("#live", form);
    let dirty = false;
    document.body.classList.add("dim");
    editView = GoNotesEditor.mount(live, {
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
        onClose: () => close(),
    });

    // ---- autosave ----
    // Changes are saved a moment after typing stops, and on leaving. A new
    // path is only taken once its field is left, so typing a name does not
    // rename the file at every key. A save the server refuses (the file
    // changed on disk, the name is taken) is sent as the form instead, so the
    // page says why and offers to overwrite.
    const pathIn = $("input[name=path]", form);
    const origIn = $("input[name=orig]", form);
    const modIn = $("input[name=mod]", form);
    const closeLink = $(".editor-head a.btn", form);
    const status = $("#savestate", form);
    let stimer, saving = null, again = false, stopped = false;
    const setStatus = (t) => { if (status) status.textContent = t; };

    // The path to save under: the old one while a new one is being typed,
    // nothing while a new note has no name yet.
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
        if (saving) { again = true; return saving; }
        const p = target();
        if (stopped || !dirty || !p) return;
        dirty = false;
        setStatus("Saving…");
        saving = (async () => {
            try {
                const res = await call("/save", { method: "POST", headers: { Accept: "application/json" }, body: saveBody(p) });
                if (!res.ok) { stopped = true; form.requestSubmit(); return; }
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
                if (again) { again = false; saveNow(); }
            }
        })();
        return saving;
    }
    pathIn.addEventListener("input", () => (dirty = true));
    pathIn.addEventListener("change", () => { if (pathIn.value.trim() !== origIn.value) saveNow(); });

    document.addEventListener("keydown", (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === "s") {
            e.preventDefault();
            form.requestSubmit();
        }
        // In vim Esc is vim's; :q closes.
        if (e.key === "Escape" && !e.defaultPrevented && !(setting("vim") === "on" && e.target.closest?.(".cm-editor"))) {
            e.preventDefault();
            close();
        }
    });
    async function close() {
        await saveNow();
        if (!dirty || confirm("Your changes are not saved. Leave anyway?")) { dirty = false; location.href = closeLink.href; }
    }
    closeLink.addEventListener("click", (e) => {
        if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        close();
    });
    // Save and open the note: after the save under way, so a new note is
    // not written twice.
    form.addEventListener("submit", (e) => {
        if (saving) { e.preventDefault(); saving.then(() => form.requestSubmit()); return; }
        clearTimeout(stimer);
        dirty = false;
    });
    // Leaving any other way still saves; only what cannot be saved asks.
    window.addEventListener("beforeunload", (e) => { if (dirty && (stopped || !target())) e.preventDefault(); });
    window.addEventListener("pagehide", () => {
        const p = target();
        if (!dirty || stopped || !p) return;
        dirty = false;
        call("/save", { method: "POST", keepalive: true, headers: { Accept: "application/json" }, body: saveBody(p) });
    });

})();
