// The page and the small helpers every part uses: the search box, the list,
// requests to this vault, settings kept in this browser, note paths.
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const q = $("#q");
// Every request names the vault this page shows, so switching vaults in
// another tab cannot make this one search, move or save in the other.
const vault = document.body.dataset.vault || "";
const label = document.body.dataset.label || "notes";
const call = (url, opts = {}) => fetch(url, { ...opts, headers: { ...opts.headers, "X-Vault": vault } });
const typing = (el) => el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
const results = $("#results");
const palette = $("#palette");
const list = () => results || palette;
function tokenize(s) {
    const out = []; let cur = "", quoted = false;
    for (const ch of s) {
        if (ch === '"') { if (quoted && cur) { out.push(cur); cur = ""; } quoted = !quoted; }
        else if (!quoted && /\s/.test(ch)) { if (cur) out.push(cur); cur = ""; }
        else cur += ch;
    }
    if (cur) out.push(cur);
    return out;
}
// ---- settings ----
const setting = (k) => { try { return localStorage.getItem(k) || ""; } catch (e) { return ""; } };
const setSetting = (k, v) => { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch (e) {} };
// The shortcut hint says what this machine's keyboard calls it.
const mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const focused = () => document.body.classList.contains("focus");
// The note open in place, if one is.
const openNote = () => (focused() && $("#peek .live")?.dataset.path) || null;
// The address of the list with a note open, or without one.
const withOpen = (p) => {
    const u = new URL(location.href);
    p ? u.searchParams.set("open", p) : u.searchParams.delete("open");
    return u.pathname + u.search;
};
const phone = () => matchMedia("(max-width: 52rem)").matches;
const dirOf = (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const noteURL = (p) => "/n/" + p.split("/").map(encodeURIComponent).join("/");
const under = (d, parent) => d.startsWith(parent + "/");
const quoteTok = (t) => (/\s/.test(t) ? `"${t}"` : t);

export { $, $$, q, vault, label, call, typing, results, palette, list, tokenize, setting, setSetting, mac, focused, openNote, withOpen, phone, dirOf, noteURL, under, quoteTok };
