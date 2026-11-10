import { $, focused, results, setSetting, setting } from "./dom.js";
import { toggleOptions } from "./options.js";

// ---- the tour, after the first vault is picked ----
// A card in the corner says what to do next, and moves on as it is done:
// a note made and open, then a note deleted. Skip ends it; Options can
// show it again.
const TOUR = {
    note: "<b>2.</b> Type a name for your first note in the search box and press <kbd>Enter</kbd>. It opens, ready to write in.",
    delete: "<b>3.</b> Write something: it saves by itself. Press <kbd>Esc</kbd> to get back to the list, then <kbd>Delete</kbd> to delete the selected note. A message at the bottom lets you undo it.",
    done: "That's all. <kbd>?</kbd> shows every key, <kbd>Ctrl K</kbd> searches from anywhere.",
};
function showTour() {
    $(".tour")?.remove();
    const step = setting("tour");
    if (!TOUR[step] || !(results || $("#editor"))) return;
    const card = document.createElement("aside");
    card.className = "tour";
    card.innerHTML = TOUR[step];
    const skip = document.createElement("button");
    skip.type = "button";
    skip.className = "btn ghost";
    skip.textContent = step === "done" ? "Close" : "Skip the tour";
    skip.addEventListener("click", () => { setSetting("tour", ""); card.remove(); });
    card.append(skip);
    document.body.append(card);
    if (step === "done") { setSetting("tour", ""); setTimeout(() => card.remove(), 8000); }
}
const tourStep = (from, to) => { if (setting("tour") === from) { setSetting("tour", to); showTour(); } };

export function init() {
    if (new URL(location.href).searchParams.has("tour")) {
        setSetting("tour", "note");
        const u = new URL(location.href);
        u.searchParams.delete("tour");
        history.replaceState(history.state, "", u.pathname + u.search);
    }
    if (focused()) tourStep("note", "delete");
    showTour();
    document.addEventListener("click", (e) => {
        if (!e.target.closest?.("[data-tour]")) return;
        e.preventDefault();
        toggleOptions(false);
        setSetting("tour", "note");
        showTour();
    });
}

export { TOUR, showTour, tourStep };
