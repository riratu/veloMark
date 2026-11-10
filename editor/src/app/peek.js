import { S } from "./state.js";
import { $, $$, call, dirOf, focused, list, palette, q, results, setting, tokenize, vault, withOpen } from "./dom.js";
import { showRenderMode } from "./options.js";
import { leaveFocus } from "./pane.js";
import { refreshPage, select, timer } from "./search.js";
import { toast } from "./toast.js";
import { upload } from "./upload.js";

// ---- preview ----
const cache = new Map();
let peekCtrl;
const peekBox = () => (results ? $("#peek") : palette && $(".peek", palette));

async function showPeek(hit) {
    const box = peekBox();
    if (!box) return;
    if (!hit) { box.innerHTML = ""; S.peekFor = ""; return; }
    const href = hit.getAttribute("href");
    if (href === S.peekFor) return;
    S.peekFor = href;
    let html = cache.get(href);
    if (html === undefined) {
        peekCtrl?.abort();
        peekCtrl = new AbortController();
        try {
            const res = await call(href, { headers: { "X-Partial": "1" }, signal: peekCtrl.signal });
            html = await res.text();
            cache.set(href, html);
        } catch (e) { return; }
        if (S.peekFor !== href) return;
    }
    if (await S.peekSave?.discard()) refreshPage();
    await S.peekSave?.flush();
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
    S.peekSave = {
        // Sends what is not saved yet, e.g. before the pane shows another note.
        flush: () => (timer !== null ? (inflight ? inflight.then(save) : save()) : inflight),
        keepalive: () => {
            if (S.peekSave.empty()) {
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
            if (!S.peekSave.empty()) return false;
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
            await S.peekSave.flush();
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
            clearTimeout(timer);
            // A change while a save is on its way is saved after it.
            if (inflight) timer = 0;
            else timer = setTimeout(save, 700);
        },
        onSave: () => S.peekSave.flush(),
        onClose: () => { leaveFocus(); q?.focus(); },
    });
}

export function init() {
    addEventListener("pagehide", () => S.peekSave?.keepalive());
}

export { cache, peekCtrl, peekBox, showPeek, freshNote, forgetFresh, searchTerms, frontMatter, titleOf, retitle, fileNameOf, mountPeek };
