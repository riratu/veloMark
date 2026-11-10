import { S } from "./state.js";
import { $, $$, call, dirOf, list, openNote, q, quoteTok, results, tokenize, under, vault, withOpen } from "./dom.js";
import { unmark } from "./marks.js";
import { open, refreshPage, select } from "./search.js";
import { toast, toastNext } from "./toast.js";
import { tourStep } from "./tour.js";

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
// After a delete the selection goes to the note above the first one
// gone, or, gone from the top, to the one that is first now.
const rowOf = (paths) => $$(".hit", list() || document).findIndex((h) => paths.includes(h.dataset.path));
function stayNear(paths) {
    const at = rowOf(paths);
    if (at >= 0) S.sel = Math.max(at - 1, 0);
}
// After a move the selection stays on the note where the list still has
// it; where it left the list, it goes as after a delete.
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

// Into another vault, where its new notes go; Undo brings them back to
// the folders they came from.
async function moveToVault(paths, to) {
    const done = [];
    const at = rowOf(paths);
    const open = openNote() || $("#editor input[name=orig]")?.value;
    if (paths.includes(open)) await S.peekSave?.flush();
    for (const path of paths) {
        const res = await call("/movevault", { method: "POST", body: new URLSearchParams({ path, to }) });
        if (res.ok) done.push({ from: path, to: (await res.json()).path });
        else toast((await res.text()).trim());
    }
    if (!done.length) return;
    const msg = (done.length === 1 ? "Moved to " : `Moved ${done.length} notes to `) + to;
    const moves = done.map((d) => ({ path: d.to, dir: dirOf(d.from) }));
    // The note on screen went with them: back to the list, which is here,
    // and the message with it.
    if (done.some((d) => d.from === open)) {
        toastNext(msg, { vault: to, moves });
        location.replace($("#editor") ? "/" : withOpen(null));
        return;
    }
    unmark();
    await refreshPage();
    landAfterMove([], at);
    toast(msg, { label: "Undo", fn: () => moveBack(to, moves) });
}
// moveBack brings notes moved into vault from back to this one, each
// into the folder it came from.
async function moveBack(from, moves) {
    for (const m of moves) await fetch("/movevault", { method: "POST", headers: { "X-Vault": from }, body: new URLSearchParams({ path: m.path, to: vault, dir: m.dir }) });
    await refreshPage();
}

async function moveNote(from, dir, undoable) {
    if (dirOf(from) === dir) return;
    const res = await call("/move", { method: "POST", body: new URLSearchParams({ path: from, dir }) });
    if (!res.ok) { toast((await res.text()).trim()); return; }
    const { path } = await res.json();
    const at = rowOf([from]);
    await afterMove(from, path);
    landAfterMove([path], at);
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
        await S.peekSave?.flush();
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
// ---- leave a folder out of searches, or take it back in ----
async function excludeDir(dir, on) {
    const res = await call("/exclude", { method: "POST", body: new URLSearchParams(on ? { dir, on: "1" } : { dir }) });
    if (!res.ok) { toast((await res.text()).trim()); return; }
    await refreshPage();
    toast(on ? dir.split("/").pop() + " is left out of searches" : dir.split("/").pop() + " is searched again",
        { label: "Undo", fn: () => excludeDir(dir, !on) });
}
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
    stayNear([p]);
    await refreshPage();
    toast("Deleted " + name, { label: "Undo", fn: () => restoreNote(trash, p) });
}
// A folder goes to .trash with its notes, after asking, since that can be
// a lot; Undo brings it all back. One with other files in it, which the page
// never shows, is refused by the server, and the message says so.
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

export function init() {
    try {
        const t = JSON.parse(sessionStorage.getItem("toast") || "null");
        sessionStorage.removeItem("toast");
        const undo = t?.undo && (t.undo.moves ? () => moveBack(t.undo.vault, t.undo.moves) : () => restoreNote(t.undo.trash, t.undo.path));
        if (t) toast(t.msg, undo && { label: "Undo", fn: undo });
    } catch (e) {}
}

export { newNote, rowOf, stayNear, landAfterMove, deleteMany, moveMany, moveToVault, moveBack, moveNote, moveFolder, afterMove, excludeDir, deleteNote, deleteFolder, restoreNote };
