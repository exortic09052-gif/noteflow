/* =============================================================
   NoteFlow â€” sw.js  (Service Worker)
   -------------------------------------------------------------
   A service worker is a script the browser runs IN THE BACKGROUND,
   separate from any page. It sits between the app and the network
   like a programmable proxy: it can intercept every fetch and
   decide whether to answer from a CACHE or go to the network.

   That's what makes the app:
     â€¢ OFFLINE-CAPABLE â€” the app shell is cached, so it loads with
       no connection. (Your notes already live in IndexedDB, which
       works offline on its own, so together the app is fully usable
       with zero network.)
     â€¢ INSTALLABLE â€” a registered SW + the manifest = installable PWA.

   -------------------------------------------------------------
   THE LIFECYCLE (three events, in order):
     1. install   â†’ pre-cache the app shell, then take over fast.
     2. activate  â†’ delete OLD caches from previous versions.
     3. fetch     â†’ answer requests from cache / network per strategy.
   -------------------------------------------------------------
   Note: a service worker CANNOT use ES module imports the way our
   app files do, so this file is plain standalone JS. It also can't
   touch the DOM â€” it only handles caching and network.
   ============================================================= */


/* ============ CACHE VERSIONING ============ */
/*
   The cache name carries a VERSION. This is the single most
   important habit for safe updates:

     â€¢ Bump CACHE_VERSION whenever you change ANY shell file
       (html/css/js/manifest). e.g. 'v1' â†’ 'v2'.
     â€¢ On the next visit, the new SW installs under the NEW cache
       name, and 'activate' deletes every cache that isn't current.

   Result: users never get a half-old/half-new mix. Each version's
   files live in their own bucket, and stale buckets are purged.

   â”€â”€ CHANGELOG â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
   v1 â†’ v2 : Phase 1 / Feature 1 (Export note as PDF).
             index.html + app.js changed.
   v2 â†’ v3 : Phase 1 / Feature 2 (Export note as PNG/JPG image).
             index.html + app.js changed (canvas image export).
   â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
*/
const CACHE_VERSION = 'v3';
const CACHE_NAME = `noteflow-${CACHE_VERSION}`;

/*
   THE APP SHELL â€” the minimum set of files needed to boot the UI.
   We deliberately DON'T cache user data here (that's IndexedDB's
   job). Paths are relative so this works under any hosting path.
*/
const APP_SHELL = [
  './',                 // the start_url (resolves to index.html)
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
/*
   Fires once when this SW version is first downloaded. We open
   the versioned cache and store the shell. addAll() is atomic:
   if ANY file fails to fetch, the whole install fails and this
   SW never activates â€” so we never ship a broken partial cache.

   skipWaiting() tells the browser not to wait for old tabs to
   close before this SW takes control. Paired with clients.claim()
   in activate, updates apply promptly.
*/
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});


/* ============ 2. ACTIVATE ============ */
/*
   Fires after install, when this SW becomes the active one. This
   is where we CLEAN UP: delete any cache whose name isn't our
   current CACHE_NAME (i.e. leftovers from older versions).

   clients.claim() lets this SW start controlling already-open
   pages immediately, instead of only new ones.
*/
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME) // anything not current
          .map((key) => caches.delete(key))     // purge it
      ))
      .then(() => self.clients.claim())
  );
});


/* ============ 3. FETCH (the strategy) ============ */
/*
   Every network request from the app passes through here. We use
   two strategies depending on the request:

     A. NAVIGATIONS (loading a page):  NETWORK-FIRST.
        Try the network so users get the freshest HTML; if offline,
        fall back to the cached index.html. This avoids serving a
        stale shell forever while still working offline.

     B. EVERYTHING ELSE (css/js/icons): CACHE-FIRST.
        Serve instantly from cache; if it's missing, fetch from the
        network and tuck a copy into the cache for next time
        (a.k.a. "stale-while-cache-fill").

   We ignore non-GET requests (POST etc.) â€” those aren't cacheable.
*/
self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only handle GET; let the browser do its normal thing otherwise.
  if (request.method !== 'GET') return;

  // Only handle same-origin requests; leave cross-origin (CDNs,
  // fonts) to the network so we don't accidentally cache them.
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // --- A. Page navigations: network-first ---
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          // Keep the cached shell fresh with the latest HTML.
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put('./index.html', copy));
          return response;
        })
        .catch(() => caches.match('./index.html')) // offline fallback
    );
    return;
  }

  // --- B. Assets: cache-first ---
  event.respondWith(
    caches.match(request).then((cached) => {
      // Return the cached copy immediately if we have it.
      if (cached) return cached;

      // Otherwise go to the network and cache a copy for next time.
      return fetch(request).then((response) => {
        // Only cache valid, basic (same-origin) responses.
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
/*
   Optional but handy: lets the running app tell a waiting SW to
   activate right away. In app.js you could listen for a new worker
   and post {type:'SKIP_WAITING'} to apply an update without a
   manual reload. Safe no-op if you never send the message.
*/
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
