import { S } from "./state.js";
import { deleteMany, deleteNote, newNote } from "./actions.js";
import { $, $$, focused, list, noteURL, openNote, palette, q, results, setting, typing } from "./dom.js";
import { foldSidebar, folderKeys, folderStep } from "./folders.js";
import { several, stepTo } from "./marks.js";
import { optBtn, optMenu, toggleOptions } from "./options.js";
import { browse, fullList, leaveFocus, toSearch } from "./pane.js";
import { closePalette, editHref, grow, hitsShown, open, runSearch } from "./search.js";
import { history30, toast, undoLast } from "./toast.js";
import { closeVaults, openVaults, vaultKeys, vaultLinks, vaultMenu } from "./vaults.js";
// ---- keyboard ----
// Keys anywhere on the page; the folder list and the vault menu take theirs first.
export function init() {
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
        // Ctrl+Z takes back the steps, newest first: anywhere but in a note,
        // where it undoes the typing; in the search box while there are some.
        if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "z") {
            const el = document.activeElement;
            if (!typing(el) || (el === q && history30.length)) {
                e.preventDefault();
                undoLast();
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
            if (e.key === "Delete" && atEnd && hitsShown() && S.sel >= 0) {
                e.preventDefault();
                const hit = $$(".hit", list())[S.sel];
                if (several()) deleteMany(several());
                else if (hit) deleteNote(hit.dataset.path);
                return;
            }
            if (arrow) {
                e.preventDefault();
                if (S.pending) { S.queued = Math.max(0, S.queued + arrow); return; }
                if (palette && palette.hidden) { runSearch(); return; }
                stepTo(S.sel + arrow, e.shiftKey);
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
            stepTo(S.sel + arrow, e.shiftKey);
            return;
        }
        switch (e.key) {
            case "/": e.preventDefault(); toSearch(); break;
            case "j": if (hitsShown()) stepTo(S.sel + 1, false); break;
            case "k": if (hitsShown()) stepTo(S.sel - 1, false); break;
            case "J": if (hitsShown()) stepTo(S.sel + 1, true); break;
            case "K": if (hitsShown()) stepTo(S.sel - 1, true); break;
            case "Enter": if (S.sel >= 0 && hitsShown()) open($$(".hit", list())[S.sel]); break;
            case "Delete": case "Backspace": {
                const p = (hitsShown() && S.sel >= 0 && $$(".hit", list())[S.sel]?.dataset.path) || openNote();
                if (several() && hitsShown()) { e.preventDefault(); deleteMany(several()); }
                else if (p) { e.preventDefault(); deleteNote(p); }
                break;
            }
            case "n": newNote(); break;
            case "?": location.href = "/n/gonotes-help.md"; break;
            case "e": {
                // Edit the note open in place, or the one selected in the list.
                const hit = hitsShown() && S.sel >= 0 && $$(".hit", list())[S.sel];
                if (openNote()) grow("/edit/" + noteURL(openNote()).slice(3));
                else if (hit) grow(editHref(hit));
                break;
            }
            case "Escape":
                if (focused()) { leaveFocus(); q?.focus(); }
                break;
        }
    });
}
