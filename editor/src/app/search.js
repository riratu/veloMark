import { S } from "./state.js";
import { newNote } from "./actions.js";
import { $, $$, call, focused, label, list, palette, phone, q, results, tokenize } from "./dom.js";
import { applyFolds } from "./folders.js";
import { markTo, unmark } from "./marks.js";
import { focusNote, leaveFocus } from "./pane.js";
import { cache, showPeek } from "./peek.js";
import { vaultMenu } from "./vaults.js";

// ---- live search ----
// On the list page the results swap in place. Everywhere else they open in
// a dropdown under the box, so a search does not throw away the page.
let timer, ctrl;

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
            // Rebuilt after a change, the list stays where it was scrolled.
            const scrolled = S.keepPlace ? $(".hits", results)?.scrollTop || 0 : 0;
            results.innerHTML = html;
            if (scrolled) $(".hits", results).scrollTop = scrolled;
            history.replaceState(null, "", url);
            document.title = val ? val + " · " + label : label;
            // The tags offered are those of what the list shows now.
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
        S.marked = new Set();
        S.anchor = -1;
        // A new search starts at the top; a rebuilt list keeps the
        // selected note in sight.
        select(S.queued, S.keepPlace);
        S.keepPlace = false;
        S.queued = 0;
        S.pending = false;
        if (submitWhenDone) { submitWhenDone = false; q.closest("form").requestSubmit(); }
    } catch (e) {
        if (e.name !== "AbortError") console.error(e);
    }
}

const closePalette = () => { if (palette) { palette.hidden = true; S.sel = -1; } };

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
// Enter opens the selected note, or, when nothing matched, starts a new
// one titled with what was typed.
let submitWhenDone = false;

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

// A box that arrives focused with a query in it has its caret at the end,
// ready to type on.
// Autofocus can land after this script has run, so do it on first focus.
const caretToEnd = () => {
    if (q.selectionStart === 0 && q.selectionEnd === 0) q.setSelectionRange(q.value.length, q.value.length);
};
// The row picked, shown in the preview.
function select(i, scroll = true) {
    const hits = $$(".hit", list() || document);
    if (!hits.length) { showPeek(null); return; }
    S.sel = Math.max(0, Math.min(hits.length - 1, i));
    hits.forEach((h, j) => h.classList.toggle("sel", j === S.sel));
    if (scroll) hits[S.sel].scrollIntoView({ block: "nearest" });
    S.peekReady = showPeek(hits[S.sel]);
}
const hitsShown = () => (results && !focused()) || (palette && !palette.hidden);
// Re-reads the sidebar and the results after a change on disk, keeping
// the selection where it was.
async function refreshPage(main = false) {
    cache.clear();
    S.peekFor = "";
    const doc = new DOMParser().parseFromString(await (await call(location.pathname + location.search)).text(), "text/html");
    $(".side-body").innerHTML = $(".side-body", doc).innerHTML;
    applyFolds();
    if (vaultMenu) vaultMenu.innerHTML = $("#vaultmenu", doc).innerHTML;
    if (main) $(".main").innerHTML = $(".main", doc).innerHTML;
    if (results || (palette && !palette.hidden)) {
        S.queued = Math.max(S.sel, 0);
        S.keepPlace = true;
        await runSearch();
    }
}

export function init() {
    q?.addEventListener("input", () => {
        leaveFocus();
        S.pending = true;
        S.queued = 0;
        clearTimeout(timer);
        timer = setTimeout(runSearch, 60);
    });
    q?.addEventListener("focus", () => { if (palette && q.value) runSearch(); });
    // Shift+Enter in the box edits the selected note instead of opening it.
    q?.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" || !e.shiftKey) return;
        const hit = hitsShown() && S.sel >= 0 && $$(".hit", list())[S.sel];
        if (!hit) return;
        e.preventDefault();
        grow(editHref(hit));
    });
    q?.closest("form").addEventListener("submit", (e) => {
        e.preventDefault();
        if (S.pending) { submitWhenDone = true; return; }
        const hits = $$(".hit", list());
        if (hits.length) open(hits[Math.max(S.sel, 0)] || hits[0]);
        else if (q.value.trim()) newNote(q.value);
    });
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
        if (i >= 0 && i !== S.sel) select(i, false);
    });
    document.addEventListener("pointerdown", (e) => {
        if (palette && !palette.hidden && !e.target.closest(".search")) closePalette();
    });
    if (q && document.activeElement === q) caretToEnd();
    else q?.addEventListener("focus", caretToEnd, { once: true });
}

export { timer, ctrl, runSearch, closePalette, syncSidebar, submitWhenDone, open, editHref, grow, caretToEnd, select, hitsShown, refreshPage };
