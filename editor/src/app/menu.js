import { S } from "./state.js";
import { deleteFolder, deleteMany, deleteNote, excludeDir } from "./actions.js";
import { $, $$, call, label, list, mac, under } from "./dom.js";
import { renameFolder } from "./folders.js";
import { several } from "./marks.js";
import { select } from "./search.js";
import { toast } from "./toast.js";

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
async function revealIn(path) {
    const res = await call("/reveal", { method: "POST", body: new URLSearchParams({ path }) });
    if (!res.ok) toast((await res.text()).trim());
}

export function init() {
    document.addEventListener("pointerdown", (e) => { if (!e.target.closest?.(".ctxmenu")) closeMenu(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && $(".ctxmenu")) { e.preventDefault(); e.stopPropagation(); closeMenu(); } }, true);
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
}

export { fileManager, contextMenu, closeMenu, revealIn };
