import { $ } from "./dom.js";

// A toast that has to outlive the page, e.g. after deleting the note on
// screen, is handed to the next page.
function toastNext(msg, undo) {
    try { sessionStorage.setItem("toast", JSON.stringify({ msg, undo })); } catch (e) {}
}
// A message with Undo stays 15 seconds, longer while the pointer is on
// it. Every step with an Undo goes on a history too, and Ctrl+Z takes
// them back one after another, the newest first. Undoing is no step.
const history30 = [];
let undoing = false;
async function runUndo(step) {
    const i = history30.indexOf(step);
    if (i >= 0) history30.splice(i, 1);
    undoing = true;
    try { await step.fn(); } finally { undoing = false; }
}
function undoLast() {
    const step = history30[history30.length - 1];
    if (step) runUndo(step);
    else toast("Nothing more to undo");
}
function toast(msg, action) {
    $(".toast")?.remove();
    const t = document.createElement("div");
    t.className = "toast";
    t.textContent = msg;
    if (action && !undoing) {
        const step = { msg, fn: action.fn };
        history30.push(step);
        if (history30.length > 30) history30.shift();
        const b = document.createElement("button");
        b.textContent = action.label;
        b.title = (navigator.platform.includes("Mac") ? "⌘" : "Ctrl+") + "Z";
        b.addEventListener("click", () => { t.remove(); runUndo(step); });
        t.append(b);
        t.classList.add("long");
    }
    t.addEventListener("animationend", () => t.remove());
    document.body.append(t);
}

export { toastNext, history30, undoing, runUndo, undoLast, toast };
