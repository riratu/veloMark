// The live markdown editor: CodeMirror with the markup hidden everywhere but
// on the lines being edited, so a note reads as rendered and edits as text.
// Built into web/static/editor.js with `npm run build`; app.js uses it
// through window.GoNotesEditor.
import { EditorState, Compartment } from "@codemirror/state";
import { EditorView, Decoration, ViewPlugin, WidgetType, keymap, drawSelection } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { syntaxHighlighting, HighlightStyle, syntaxTree, indentUnit } from "@codemirror/language";
import { markdown, markdownLanguage, markdownKeymap } from "@codemirror/lang-markdown";
import { tags as t } from "@lezer/highlight";
import { vim, Vim, getCM } from "@replit/codemirror-vim";

const style = HighlightStyle.define([
    { tag: t.heading, class: "cm-heading" },
    { tag: t.strong, class: "cm-strong" },
    { tag: t.emphasis, class: "cm-em" },
    { tag: t.strikethrough, class: "cm-strike" },
    { tag: t.link, class: "cm-link" },
    { tag: t.url, class: "cm-url" },
    { tag: t.monospace, class: "cm-mono" },
    { tag: [t.processingInstruction, t.contentSeparator, t.meta], class: "cm-markup" },
    { tag: t.quote, class: "cm-quote-text" },
]);

class Bullet extends WidgetType {
    eq() { return true; }
    toDOM() {
        const s = document.createElement("span");
        s.className = "cm-bullet";
        s.textContent = "•";
        return s;
    }
}

// A task's [ ] or [x]; clicking it ticks the task in the text.
class Check extends WidgetType {
    constructor(done) { super(); this.done = done; }
    eq(o) { return o.done === this.done; }
    toDOM(view) {
        const box = document.createElement("input");
        box.type = "checkbox";
        box.className = "cm-check";
        box.checked = this.done;
        box.addEventListener("mousedown", (e) => {
            e.preventDefault();
            const pos = view.posAtDOM(box);
            view.dispatch({ changes: { from: pos, to: pos + 3, insert: this.done ? "[ ]" : "[x]" } });
        });
        return box;
    }
    ignoreEvent() { return true; }
}

class Rule extends WidgetType {
    eq() { return true; }
    toDOM() {
        const s = document.createElement("span");
        s.className = "cm-rule";
        return s;
    }
}

// An image in a note. Until it has loaded it holds a picture's worth of
// room, so the editor does not take dozens of them as near enough to draw,
// and the browser fetches it only as it comes close to where the note is
// read: a note full of photos loads from where you are.
class Img extends WidgetType {
    constructor(src, alt) { super(); this.src = src; this.alt = alt; }
    eq(o) { return o.src === this.src && o.alt === this.alt; }
    get estimatedHeight() { return 240; }
    toDOM(view) {
        const img = document.createElement("img");
        img.className = "cm-img";
        img.setAttribute("loading", "lazy");
        img.decoding = "async";
        img.alt = this.alt;
        const done = () => { img.classList.add("loaded"); view.requestMeasure(); };
        img.addEventListener("load", done, { once: true });
        img.addEventListener("error", done, { once: true });
        img.src = this.src;
        return img;
    }
}

// Links and images are relative to the note, as on its page.
function resolver(dir) {
    const base = location.origin + "/n/" + (dir ? dir.split("/").map(encodeURIComponent).join("/") + "/" : "");
    return (url) => {
        try { return new URL(url, base).href; } catch (e) { return url; }
    };
}

// Front matter is not markdown; it is left as it is.
function frontMatterEnd(doc) {
    if (doc.lines < 2 || doc.line(1).text !== "---") return 0;
    for (let i = 2; i <= doc.lines; i++) {
        const l = doc.line(i);
        if (l.text === "---" || l.text === "...") return l.to;
    }
    return 0;
}

const TAG = /(^|[\s(])(#[\p{L}\p{N}_][\p{L}\p{N}_\/-]*)/gu;

function livePreview({ dir, terms }) {
    const resolve = resolver(dir);
    const termRe = terms.length ? new RegExp(terms.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "gi") : null;

    function build(view) {
        const { state } = view;
        const doc = state.doc;
        const deco = [];
        const active = new Set();
        if (view.hasFocus) {
            for (const r of state.selection.ranges) {
                for (let l = doc.lineAt(r.from).number; l <= doc.lineAt(r.to).number; l++) active.add(l);
            }
        }
        const editing = (from, to) => {
            for (let l = doc.lineAt(from).number; l <= doc.lineAt(to).number; l++) if (active.has(l)) return true;
            return false;
        };
        const hide = (from, to) => from < to && deco.push(Decoration.replace({}).range(from, to));
        const lineClass = (pos, cls) => deco.push(Decoration.line({ class: cls }).range(doc.lineAt(pos).from));
        const spaceAfter = (pos) => (doc.sliceString(pos, pos + 1) === " " ? pos + 1 : pos);

        const fm = frontMatterEnd(doc);
        for (let p = 0; p < fm; p = doc.lineAt(p).to + 1) lineClass(p, "cm-frontmatter");

        const tree = syntaxTree(state);
        for (const { from, to } of view.visibleRanges) {
            tree.iterate({
                from, to,
                enter: (n) => {
                    if (n.name === "Document") return;
                    if (n.to <= fm) return false;
                    const node = n.node;
                    const parent = node.parent?.name;
                    let m;
                    if ((m = /^(?:ATX|Setext)Heading(\d)$/.exec(n.name))) {
                        lineClass(n.from, "cm-h cm-h" + m[1]);
                    } else if (n.name === "HeaderMark") {
                        if (/^ATX/.test(parent) && !editing(n.from, n.to)) hide(n.from, spaceAfter(n.to));
                    } else if (n.name === "EmphasisMark" || n.name === "StrikethroughMark" || (n.name === "CodeMark" && parent === "InlineCode")) {
                        if (!editing(n.from, n.to)) hide(n.from, n.to);
                    } else if (n.name === "Link") {
                        if (editing(n.from, n.to)) return;
                        const marks = node.getChildren("LinkMark");
                        if (marks.length < 2) return;
                        hide(marks[0].from, marks[0].to);
                        hide(marks[1].from, n.to); // ](url "title")
                        return false;
                    } else if (n.name === "Image") {
                        if (editing(n.from, n.to)) return false;
                        const url = node.getChild("URL");
                        const marks = node.getChildren("LinkMark");
                        if (!url || marks.length < 2) return false;
                        const alt = doc.sliceString(marks[0].to, marks[1].from);
                        deco.push(Decoration.replace({ widget: new Img(resolve(doc.sliceString(url.from, url.to)), alt) }).range(n.from, n.to));
                        return false;
                    } else if (n.name === "ListMark") {
                        if (editing(n.from, n.to)) return;
                        const item = node.parent;
                        const task = item?.getChild("Task");
                        if (task) hide(n.from, spaceAfter(n.to));
                        else if (item?.parent?.name === "BulletList") deco.push(Decoration.replace({ widget: new Bullet() }).range(n.from, n.to));
                    } else if (n.name === "TaskMarker") {
                        const done = /x/i.test(doc.sliceString(n.from, n.to));
                        if (done) lineClass(n.from, "cm-done");
                        if (!editing(n.from, n.to)) deco.push(Decoration.replace({ widget: new Check(done) }).range(n.from, n.to));
                    } else if (n.name === "QuoteMark") {
                        lineClass(n.from, "cm-quote");
                        if (!editing(n.from, n.to)) hide(n.from, spaceAfter(n.to));
                    } else if (n.name === "HorizontalRule") {
                        if (!editing(n.from, n.to)) deco.push(Decoration.replace({ widget: new Rule() }).range(n.from, n.to));
                    } else if (n.name === "FencedCode" || n.name === "CodeBlock") {
                        for (let p = n.from; p <= n.to; p = doc.lineAt(p).to + 1) lineClass(p, "cm-codeblock");
                        return false;
                    } else if (n.name === "InlineCode") {
                        return;
                    }
                },
            });

            // #tags and the words searched for, outside code.
            const text = doc.sliceString(from, to);
            // Code, and a link's target like (#org0ba4682), hold no tags.
            const inCode = (pos) => {
                for (let nd = tree.resolveInner(pos, 1); nd; nd = nd.parent) {
                    if (/Code|URL/.test(nd.name)) return true;
                }
                return false;
            };
            for (const mt of text.matchAll(TAG)) {
                const start = from + mt.index + mt[1].length;
                // #1 and #3 are numbers, not tags.
                if (start < fm || inCode(start) || !/\p{L}/u.test(mt[2])) continue;
                deco.push(Decoration.mark({ class: "cm-tag" }).range(start, start + mt[2].length));
            }
            if (termRe) {
                for (const mt of text.matchAll(termRe)) {
                    if (mt[0]) deco.push(Decoration.mark({ class: "cm-hit" }).range(from + mt.index, from + mt.index + mt[0].length));
                }
            }
        }
        return Decoration.set(deco, true);
    }

    return ViewPlugin.fromClass(class {
        constructor(view) { this.decorations = build(view); }
        update(u) {
            if (u.docChanged || u.viewportChanged || u.selectionSet || u.focusChanged) this.decorations = build(u.view);
        }
    }, { decorations: (v) => v.decorations });
}

// Ctrl or Cmd and a click follows a link; a plain click edits it.
function followLinks(dir) {
    const resolve = resolver(dir);
    return EditorView.domEventHandlers({
        mousedown(e, view) {
            if (!(e.ctrlKey || e.metaKey) || e.button !== 0) return false;
            const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
            if (pos == null) return false;
            for (let nd = syntaxTree(view.state).resolveInner(pos, 1); nd; nd = nd.parent) {
                if (nd.name !== "Link" && nd.name !== "Autolink" && nd.name !== "URL") continue;
                const url = nd.name === "URL" ? nd : nd.getChild("URL");
                if (!url) return false;
                e.preventDefault();
                window.open(resolve(view.state.sliceDoc(url.from, url.to).replace(/^<|>$/g, "")), e.shiftKey ? "_blank" : "_self");
                return true;
            }
            return false;
        },
    });
}

// Vim's :w and :q go to the page the editor is on.
const actions = new WeakMap();
const ex = (name) => (cm) => actions.get(cm.cm6)?.[name]?.();
Vim.defineEx("write", "w", ex("save"));
Vim.defineEx("quit", "q", ex("close"));
Vim.defineEx("wq", "wq", ex("saveClose"));
Vim.defineEx("xit", "x", ex("saveClose"));

// Files dropped or pasted in go to onFile, which stores one and gives back
// the markdown for it. A placeholder holds the place meanwhile, so typing on
// while it uploads does not move where the link goes.
const fileHandlers = new WeakMap();
async function insertFiles(view, files, pos) {
    const onFile = fileHandlers.get(view);
    for (const f of files) {
        const mark = `![Uploading ${f.name || "file"}…]()`;
        view.dispatch({ changes: { from: pos, insert: mark } });
        let text = "";
        try { text = (await onFile(f)) || ""; } catch (e) {}
        const at = view.state.doc.toString().indexOf(mark);
        if (at < 0) continue;
        view.dispatch({ changes: { from: at, to: at + mark.length, insert: text }, selection: { anchor: at + text.length } });
        pos = at + text.length;
    }
}
const fileDrop = EditorView.domEventHandlers({
    drop(e, view) {
        const fs = [...(e.dataTransfer?.files || [])];
        if (!fs.length || !fileHandlers.has(view)) return false;
        e.preventDefault();
        insertFiles(view, fs, view.posAtCoords({ x: e.clientX, y: e.clientY }, false));
        return true;
    },
    paste(e, view) {
        const fs = [...(e.clipboardData?.files || [])];
        if (!fs.length || !fileHandlers.has(view)) return false;
        e.preventDefault();
        insertFiles(view, fs, view.state.selection.main.head);
        return true;
    },
});

// dropFiles takes files dropped near the editor rather than on its text,
// e.g. below a short note: they go where the drop is nearest.
function dropFiles(view, files, x, y) {
    if (!fileHandlers.has(view)) return false;
    insertFiles(view, files, view.posAtCoords({ x, y }, false) ?? view.state.doc.length);
    return true;
}

// The rendering can be switched off, to see and edit the plain text.
const rendering = new Compartment();

// Vim can be switched on and off in an open editor. Its status line under
// the note says which mode it is in, so it is plain where the keys go.
const vimKeys = new Compartment();
const vimWith = (on) => (on ? vim({ status: true }) : []);
function setVim(view, on) {
    view.dispatch({ effects: vimKeys.reconfigure(vimWith(on)) });
}
// vimMode is "insert", "visual", "normal", or "" without vim.
function vimMode(view) {
    const st = getCM(view)?.state?.vim;
    if (!st) return "";
    return st.insertMode ? "insert" : st.visualMode ? "visual" : "normal";
}
const rendered = (opts) => [syntaxHighlighting(style), livePreview(opts)];

// setSource shows the plain markdown (true) or renders it again (false).
function setSource(view, on) {
    view.dispatch({ effects: rendering.reconfigure(on ? [] : view.renderedWith) });
    view.dom.classList.toggle("cm-source", on);
}

// mount puts an editor into parent. dir is the note's folder, for relative
// links and images; terms are words to mark, as in search results;
// onChange gets the whole text after every change. With vim, :w calls onSave,
// :q onClose and :wq both. source starts it without rendering. onFile takes
// a dropped or pasted file and gives back the markdown that links it.
function mount(parent, { doc = "", dir = "", terms = [], onChange, onSave, onClose, onFile, vim: vimOn = false, focus = false, source = false } = {}) {
    const look = rendered({ dir, terms });
    const view = new EditorView({
        parent,
        state: EditorState.create({
            doc,
            extensions: [
                vimKeys.of(vimWith(vimOn)),
                history(),
                drawSelection(),
                indentUnit.of("    "),
                EditorState.tabSize.of(4),
                EditorView.lineWrapping,
                EditorView.contentAttributes.of({ spellcheck: "true", autocorrect: "on" }),
                markdown({ base: markdownLanguage }),
                keymap.of([...markdownKeymap, ...defaultKeymap, ...historyKeymap, indentWithTab]),
                rendering.of(source ? [] : look),
                followLinks(dir),
                fileDrop,
                EditorView.updateListener.of((u) => { if (u.docChanged) onChange?.(u.state.doc.toString()); }),
            ],
        }),
    });
    if (onFile) fileHandlers.set(view, onFile);
    view.renderedWith = look;
    view.dom.classList.toggle("cm-source", source);
    actions.set(view, {
        save: () => onSave?.(),
        close: () => onClose?.(),
        saveClose: async () => { await onSave?.(); onClose?.(); },
    });
    if (focus) {
        view.focus();
        view.dispatch({ selection: { anchor: view.state.doc.length } });
    }
    // Scroll to the first word searched for when it is out of sight.
    if (terms.length) {
        const lower = doc.toLowerCase();
        const at = Math.min(...terms.map((s) => lower.indexOf(s.toLowerCase())).filter((i) => i >= 0));
        if (isFinite(at) && view.state.doc.lineAt(at).number > 12) {
            view.dispatch({ effects: EditorView.scrollIntoView(at, { y: "center" }) });
        }
    }
    return view;
}

window.GoNotesEditor = { mount, setSource, dropFiles, setVim, vimMode };
