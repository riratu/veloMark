import { S } from "./state.js";
import { afterMove, moveNote } from "./actions.js";
import { $, $$, call, dirOf, list, openNote, q, quoteTok, results, setSetting, setting, typing, under, vault } from "./dom.js";
import { closePalette, open, refreshPage, runSearch } from "./search.js";
import { toast } from "./toast.js";

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

// ---- the whole sidebar folded away, or back: ◀ / ▶ or Alt+B ----
function foldSidebar(on = document.documentElement.dataset.side !== "folded") {
    if (on) document.documentElement.dataset.side = "folded";
    else delete document.documentElement.dataset.side;
    setSetting("sidebar", on ? "folded" : "");
    for (const v of [S.peekView, S.editView]) v?.requestMeasure(); // wider now
}

// ---- folders open and closed ----
// A folder with folders in it has an arrow to open and close it; the
// button by Folders opens or closes them all. Which are closed is kept in
// this browser, per vault. The folder in view is never hidden away.
const foldKey = () => "folds:" + vault;
const closedFolds = () => { try { return new Set(JSON.parse(setting(foldKey()) || "[]")); } catch (e) { return new Set(); } };
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
// Picking a folder opens it too, to show the folders in it.
function openFold(d) {
    const closed = closedFolds();
    if (d && closed.delete(d)) setFolds(closed);
}

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
// ---- the folder list from the keyboard ----
// ← from the results (or on a note) walks into the folders: ↑↓ pick one,
// Enter opens it, m moves the selected note there, → or Esc come back.
let fsel = -1;
const folders = () => $$(".facets a[data-tok]").filter((a) => !a.closest("li").hidden);
const inFolders = () => fsel >= 0;
// The note m would move: the selected row, else the note on screen.
const currentNote = () => openNote() || (S.sel >= 0 && $$(".hit", list() || document)[S.sel]?.dataset.path);

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
        const v = new URL(a.href).searchParams.get("q") || "";
        q.value = v ? v.replace(/\s*$/, " ") : ""; // typing on starts a word of its own
        runSearch();
        a.scrollIntoView({ block: "nearest" });
        return;
    }
    const d = all[cur]?.dataset.dir;
    if (!d) return;
    const closed = closedFolds();
    if (key === "ArrowRight" ? closed.delete(d) : !closed.has(d) && closed.add(d)) setFolds(closed);
}

export function init() {
    // ---- on a phone, the folders and the tags behind buttons, above the list ----
    // One at a time: opening one closes the other.
    $$(".foldersbtn").forEach((b) => b.addEventListener("click", () => {
        const panel = b.dataset.panel;
        const open = document.body.dataset.panel !== panel;
        if (open) document.body.dataset.panel = panel;
        else delete document.body.dataset.panel;
        $$(".foldersbtn").forEach((o) => o.setAttribute("aria-expanded", String(open && o === b)));
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
        setFolds(all.dataset.close === "true" ? new Set(parents) : new Set());
    });
    applyFolds();
    document.addEventListener("click", (e) => {
        const a = e.target.closest?.(".facets a[data-dir]");
        if (a && e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) openFold(a.dataset.dir);
    });
    document.addEventListener("click", (e) => { if (e.target.closest("#addfolder")) newFolder(); });
    document.addEventListener("pointerdown", (e) => { if (inFolders() && !e.target.closest(".facets")) leaveFolders(); });
}

export { renameFolder, renameDir, foldSidebar, foldKey, closedFolds, applyFolds, setFolds, openFold, newFolder, fsel, folders, inFolders, currentNote, pickFolder, leaveFolders, enterFolders, folderKeys, folderStep };
