import { S } from "./state.js";
import { $, $$, focused, openNote, results } from "./dom.js";
import { mountPeek } from "./peek.js";

// The list page as it arrives: the note opened by its address, else the
// first row, under the list and ready to write in.
export function initList() {
    if (results && focused()) {
        // Opened by its address: the note is in place already, ready to write.
        // The help note has no editor; its path is in the pane's header.
        const p = openNote() || $("#peek .peek-path")?.textContent || "";
        S.peekFor = "/n/" + p.split("/").map(encodeURIComponent).join("/");
        S.sel = $$(".hit", results).findIndex((h) => h.dataset.path === p);
        $$(".hit", results)[S.sel]?.classList.add("sel");
        let end = false;
        try { end = sessionStorage.getItem("caret") === "end"; sessionStorage.removeItem("caret"); } catch (e) {}
        mountPeek($("#peek"), S.peekFor);
        S.peekView?.focus();
        if (end) S.peekView?.dispatch({ selection: { anchor: S.peekView.state.doc.length } });
    } else if (results) {
        const first = $(".hit", results);
        if (first) {
            S.sel = 0;
            first.classList.add("sel");
            S.peekFor = first.getAttribute("href");
            mountPeek($("#peek"), S.peekFor);
        }
    }
}
