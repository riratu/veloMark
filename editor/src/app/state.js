// What the parts of the page share and change: the selected row and the
// marked ones, a search on its way, and the note under the results with the
// editors on screen.
export const S = {
    sel: -1, // the selected row in the list or the dropdown
    // Arrows pressed while a search is still on its way are kept and applied
    // to its results, so typing and then going straight for ↓ is not lost.
    pending: false,
    queued: 0,
    keepPlace: false, // a rebuilt list keeps its scroll and selection
    marked: new Set(), // rows marked with Shift, from anchor
    anchor: -1,
    peekFor: "", // the note shown under the results
    peekReady: null, // that note, once loaded
    peekSave: null, // its saving
    peekView: null, // its editor
    editView: null, // the editor on the edit page
};
