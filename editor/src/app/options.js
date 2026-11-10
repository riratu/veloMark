import { S } from "./state.js";
import { $, $$, call, mac, q, results, setSetting, setting } from "./dom.js";
import { close } from "./editor.js";
import { beside, leaveFocus, splitter } from "./pane.js";
import { open, refreshPage } from "./search.js";
import { toast } from "./toast.js";

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
// ---- Live or Source, top right of the note: kept in this browser ----
const showRenderMode = () => {
    const mode = setting("render") || "live";
    $$("[data-render]").forEach((b) => b.classList.toggle("on", b.dataset.render === mode));
};
const hint = $(".search > kbd");

export function init() {
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
        $$(".hit", results)[S.sel]?.scrollIntoView({ block: "nearest" });
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
        for (const v of [S.peekView, S.editView]) v?.requestMeasure(); // the lines changed height
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
        for (const v of [S.peekView, S.editView]) if (v) GoNotesEditor.setVim(v, on);
        toast(on ? "Vim mode: i to type, Esc to stop typing, Esc again to close the note" : "Vim mode off");
    });
    // In vim, Esc first stops typing, as vim does; Esc again, with nothing
    // left for vim to leave, closes the note. Before vim sees the key.
    document.addEventListener("keydown", (e) => {
        if (e.key !== "Escape" || e.ctrlKey || e.metaKey || e.altKey) return;
        const ed = e.target.closest?.(".cm-editor");
        const view = ed?.closest(".editor") ? S.editView : ed?.closest(".peek") ? S.peekView : null;
        if (!view || GoNotesEditor.vimMode(view) !== "normal") return;
        e.preventDefault();
        e.stopPropagation();
        if (view === S.editView) close();
        else { leaveFocus(); q?.focus(); }
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
    if (hint) hint.textContent = mac ? "⌘K" : "Ctrl K";
    if (mac) $$("kbd.alt").forEach((k) => (k.textContent = k.textContent.replace("Alt ", "⌥")));
}

export { optBtn, optMenu, showTheme, showList, showImg, toggleOptions, showRenderMode, hint };
