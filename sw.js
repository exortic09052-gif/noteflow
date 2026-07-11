/* =============================================================
   NoteFlow â€” sw.js  (Service Worker)
   -------------------------------------------------------------
   Runs in the background as a programmable proxy between the app
   and the network: it intercepts fetches and answers from a CACHE
   or the network. This gives us offline support + installability.

   Lifecycle: install (pre-cache shell) â†’ activate (purge old
   caches) â†’ fetch (serve per strategy). Plain standalone JS â€” a
   service worker can't use ES module imports or touch the DOM.
   ============================================================= */


/* ============ CACHE VERSIONING ============ */
/*
   Bump CACHE_VERSION whenever any shell file changes. The new SW
   installs under the new cache name and 'activate' purges the old
   ones, so users never get a half-old/half-new mix.

   â”€â”€ CHANGELOG â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
   v1 â†’ v2 : Phase 1 / Feature 1 (Export note as PDF).
   v2 â†’ v3 : Phase 1 / Feature 2 (Export note as PNG/JPG image).
   v3 â†’ v4 : Phase 1 / Feature 3 (Trash & Restore â€” soft delete).
             store.js, ui.js, app.js changed.
   â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
*/
const CACHE_VERSION = 'v4';
const CACHE_NAME = `noteflow-${CACHE_VERSION}`;

/*
   THE APP SHELL â€” files needed to boot the UI. User DATA is NOT
   cached here (IndexedDB owns that). Paths are relative so this
   works under any hosting path.
*/
const APP_SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './utils.js',
  './db.js',
  './store.js',
  './ui.js',
  './manifest.webmanifest',
];


/* ============ 1. INSTALL ============ */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});


/* ============ 2. ACTIVATE ============ */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});


/* ============ 3. FETCH ============ */
/*
   Navigations = network-first (fresh HTML, offline fallback to
   cached index.html). Other same-origin GETs = cache-first with
   background cache-fill. Non-GET and cross-origin are left alone.
*/
self.addEventListener('fetch', (event) => {
  const { request } = event;

  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put('./index.html', copy));
          return response;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (response && response.status === 200 && response.type === 'basic') {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      });
    })
  );
});


/* ============ 4. UPDATE HANDLING ============ */
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
