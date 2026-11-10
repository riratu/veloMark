import { S } from "./state.js";
import { moveFolder, moveMany, moveNote, moveToVault } from "./actions.js";
import { $$, dirOf } from "./dom.js";
import { several } from "./marks.js";
import { closeVaults, openVaults, vaultMenu } from "./vaults.js";

// ---- drag a note or a folder onto a folder to move it ----
// A note also goes onto another vault in the vault menu, which opens
// when the drag comes over its button.
const MIME = "application/x-gonotes-path";
const DIR_MIME = "application/x-gonotes-dir";
const MANY_MIME = "application/x-gonotes-paths";
// The folder being dragged, since a drop target cannot read it before the drop.
let dragDir = null;
const inside = (d, folder) => d === folder || d.startsWith(folder + "/");
function dropTarget(e) {
    const types = e.dataTransfer?.types || [];
    const v = e.target.closest?.(".vaultmenu a[data-vault]");
    if (v) return types.includes(MIME) && !v.classList.contains("on") ? v : null;
    const t = e.target.closest?.(".facets a[data-tok]");
    if (!t) return null;
    if (types.includes(MIME)) return t;
    if (!types.includes(DIR_MIME) || dragDir === null) return null;
    const to = t.dataset.tok.replace(/^in:/, "");
    // Not into itself, nor where it already is.
    return inside(to, dragDir) || to === dirOf(dragDir) ? null : t;
}
const clearDrop = (keep) => $$(".drop").forEach((el) => el !== keep && el.classList.remove("drop"));

export function init() {
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

export { MIME, DIR_MIME, MANY_MIME, dragDir, inside, dropTarget, clearDrop };
