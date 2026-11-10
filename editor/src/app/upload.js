import { S } from "./state.js";
import { $, call } from "./dom.js";
import { toast } from "./toast.js";

// ---- files dropped or pasted into a note ----
// They go into the note's folder; the editor puts in the link it gets
// back: an image shown, anything else linked.
async function upload(file, note) {
    if (!note) { toast("Name the note first, then drop files into it"); return ""; }
    let name = file.name;
    // A pasted screenshot is called image.png; give it a name to tell apart.
    if (!name || /^image\.\w+$/.test(name)) {
        const ext = (file.type.split("/")[1] || "png").replace("jpeg", "jpg");
        name = "pasted-" + new Date().toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-") + "." + ext;
    }
    const fd = new FormData();
    fd.append("note", note);
    fd.append("file", file, name);
    const res = await call("/upload", { method: "POST", body: fd });
    if (!res.ok) { toast((await res.text()).trim()); return ""; }
    const saved = (await res.json()).name;
    const alt = name.replace(/\.[^.]+$/, "");
    return file.type.startsWith("image/") ? `![${alt}](${saved})` : `[${name}](${saved})`;
}

export function init() {
    // Files dropped on a note's pane but not on its text, e.g. below a short
    // note, go to its editor all the same.
    document.addEventListener("drop", (e) => {
        if (e.defaultPrevented || !e.dataTransfer?.files.length) return;
        const view = e.target.closest?.(".editor") ? S.editView : e.target.closest?.(".peek") ? S.peekView : null;
        if (!view) return;
        e.preventDefault();
        if (!GoNotesEditor.dropFiles(view, [...e.dataTransfer.files], e.clientX, e.clientY)) toast("Files cannot go into this note");
    });
    // A file dropped beside an editor would make the browser leave the page
    // to show it.
    for (const ev of ["dragover", "drop"]) {
        document.addEventListener(ev, (e) => {
            if (e.dataTransfer?.types.includes("Files") && !e.defaultPrevented) e.preventDefault();
        });
    }
}

export { upload };
