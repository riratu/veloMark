import { $, call } from "./dom.js";

// ---- links out of the notes: the default browser, not the app window ----
// Installed as an app, a web link would open in the app's own window; the
// server hands it to the desktop instead. In a browser tab it stays there.
const outside = (href) => {
    try {
        const u = new URL(href, location.href);
        return u.origin !== location.origin && /^(https?|mailto):$/.test(u.protocol) ? u.href : "";
    } catch (e) { return ""; }
};

export function init() {
    if (matchMedia("(display-mode: standalone), (display-mode: window-controls-overlay), (display-mode: minimal-ui)").matches) {
        const openOut = async (href) => {
            const res = await call("/openlink", { method: "POST", body: new URLSearchParams({ url: href }) }).catch(() => null);
            if (!res?.ok) nativeOpen(href, "_blank");
        };
        const nativeOpen = window.open.bind(window);
        // The editor follows a link with Ctrl+click through window.open.
        window.open = (href, ...rest) => {
            const out = outside(href);
            if (!out) return nativeOpen(href, ...rest);
            openOut(out);
            return null;
        };
        document.addEventListener("click", (e) => {
            const a = e.target.closest?.("a[href]");
            const out = a && !a.hasAttribute("download") && outside(a.href);
            if (!out || e.defaultPrevented || e.button !== 0) return;
            e.preventDefault();
            openOut(out);
        }, true);
    }
}

export { outside };
