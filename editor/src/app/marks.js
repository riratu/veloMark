import { S } from "./state.js";
import { $$, list } from "./dom.js";
import { select } from "./search.js";

// ---- several notes at once ----
// Shift with a click, ↑↓ or J K marks the rows from where it started;
// a plain click or arrow is one note again. Marked notes are deleted
// and dragged together.
const several = () => (S.marked.size > 1 ? [...marked] : null);
function showMarks() {
    $$(".hit", list() || document).forEach((h) => h.classList.toggle("marked", S.marked.has(h.dataset.path)));
}
function markTo(i) {
    const hits = $$(".hit", list() || document);
    if (S.anchor < 0) S.anchor = S.sel >= 0 ? S.sel : i;
    const [a, b] = S.anchor < i ? [S.anchor, i] : [i, S.anchor];
    S.marked = new Set(hits.slice(a, b + 1).map((h) => h.dataset.path));
    showMarks();
}
function unmark() {
    S.anchor = -1;
    if (!S.marked.size) return;
    S.marked = new Set();
    showMarks();
}
function stepTo(i, extend) {
    if (extend && S.anchor < 0) S.anchor = Math.max(S.sel, 0);
    select(i);
    extend ? markTo(S.sel) : unmark();
}

export { several, showMarks, markTo, unmark, stepTo };
