// The service worker that makes gonotes installable as an app. It keeps
// nothing of the notes: every page and note comes from the server, which is
// on the same machine. Only the page's own files (styles, scripts, icons)
// are kept, so the window opens at once; a newer server replaces them.
const CACHE = "gonotes-static";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (e) => {
    const url = new URL(e.request.url);
    if (e.request.method !== "GET" || url.origin !== location.origin || !url.pathname.startsWith("/static/")) return;
    // The network first, the copy when the server cannot be reached.
    e.respondWith(
        fetch(e.request)
            .then((res) => {
                const copy = res.clone();
                caches.open(CACHE).then((c) => c.put(e.request, copy));
                return res;
            })
            .catch(() => caches.match(e.request)),
    );
});
