import { S } from "./state.js";
import { $, call, noteURL, setting } from "./dom.js";
import { upload } from "./upload.js";

// close leaves the edit page, saving first; elsewhere there is nothing to close.
export let close = async () => {};

// ---- editor ----
export function initEditor() {
    const form = $("#editor");
    if (!form) return;
    // The text lives in the live editor; the hidden #body carries it in the
    // form, for saving the old way.
    const body = $("#body", form);
    const live = $("#live", form);
    let dirty = false;
    document.body.classList.add("dim");
    S.editView = GoNotesEditor.mount(live, {
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
    close = async () => {
        await saveNow();
        if (!dirty || confirm("Your changes are not saved. Leave anyway?")) { dirty = false; location.href = closeLink.href; }
    };
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
}
