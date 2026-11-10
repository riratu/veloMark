import { S } from "./state.js";
import { $, $$, focused, palette, phone, q, results, setSetting, setting, withOpen } from "./dom.js";
import { open, refreshPage, select } from "./search.js";

// ---- one note, the list folded away ----
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
    $$(".hit", results)[S.sel]?.scrollIntoView({ block: "nearest" });
}
// Beside the note (Options → List), the line drags the list's width instead.
let listW = Number(setting("list-width")) || 0;
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
// back: the history entry focusNote added is left with the browser's Back.
function leaveFocus(back = true) {
    if (!focused()) return;
    S.peekSave?.discard().then((gone) => gone && refreshPage());
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

export function init() {
    if (browse) setRows(rows, false, false); // as kept: the page may be folded now
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
}

export { fold, folding, toSearch, browse, splitter, beside, rowPx, rows, maxRows, setRows, fullBeforeNote, fullList, listW, setWidth, focusNote, leaveFocus };
