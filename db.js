/* =============================================================
   SLATE — db.js
   -------------------------------------------------------------
   THE DATABASE LAYER. This is the ONLY file that talks to
   IndexedDB directly. Everything above it (store.js) calls these
   functions and never touches `indexedDB` itself. That rule is
   what keeps the app modular: if you ever swap IndexedDB for
   something else, you only rewrite THIS file.

   -------------------------------------------------------------
   A 60-SECOND MENTAL MODEL OF INDEXEDDB
   -------------------------------------------------------------
   • A "database" has a NAME and a VERSION (a number).
   • Inside it are "object stores" — think of them as tables.
       We use two:  "notes"  and  "folders".
   • Each store holds JS objects, looked up by a "keyPath"
       (the property used as the primary key — here, "id").
   • An "index" lets you query by a non-key field quickly
       (e.g. find all notes in a folder). We add a couple.
   • You read/write inside a "transaction". A transaction is
       scoped to one or more stores and a mode: "readonly" or
       "readwrite".
   • The API is EVENT-based (onsuccess/onerror), which is clunky,
       so we wrap every request in a Promise and use async/await.

   -------------------------------------------------------------
   HOW TO CHANGE THE SCHEMA LATER (read this before you edit!)
   -------------------------------------------------------------
   IndexedDB only lets you create/alter stores and indexes inside
   an "upgrade" event, which fires when the DB VERSION goes up.
   So to change the schema:
     1. Bump DB_VERSION (e.g. 1 → 2).
     2. Add an `if (oldVersion < 2) { ... }` block in
        runUpgrade() with your changes.
   The step-by-step `if (oldVersion < N)` pattern means users on
   ANY older version get upgraded correctly, one step at a time.
   ============================================================= */


/* ============ CONFIG ============ */
const DB_NAME = 'slate';   // the database name (shows up in devtools)
const DB_VERSION = 1;      // bump this when you change the schema (see above)

// Store names kept in one place so we never mistype them as strings.
export const STORES = {
  NOTES: 'notes',
  FOLDERS: 'folders',
};

// We cache the open connection so we only open the DB once.
let dbPromise = null;


/* ============ 1. OPEN / CREATE THE DATABASE ============ */
/*
   open() returns a Promise that resolves to the live IDBDatabase
   connection. The first time it runs (or after a version bump),
   the browser fires "onupgradeneeded" where we build/upgrade the
   schema. On every later call we just reuse the cached promise.
*/
export function open() {
  // Already opening/opened? Reuse it — don't open twice.
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    // Ask the browser to open (or create) the database.
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    // Fired when the DB is brand new OR DB_VERSION increased.
    // This is the ONLY place you're allowed to change structure.
    request.onupgradeneeded = (event) => {
      const db = request.result;
      // oldVersion tells us where the user is upgrading FROM.
      runUpgrade(db, event.oldVersion);
    };

    // Success: hand back the open connection.
    request.onsuccess = () => {
      const db = request.result;

      // Safety net: if another tab opens a NEWER version, this
      // connection must close so the upgrade elsewhere can proceed.
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
        console.warn('Slate DB closed: a newer version opened in another tab.');
      };

      resolve(db);
    };

    // Failure: reject so callers can handle it.
    request.onerror = () => reject(request.error);

    // Rare: another tab is holding an old version open and blocks us.
    request.onblocked = () => {
      console.warn('Slate DB upgrade blocked — close other tabs of this app.');
    };
  });

  return dbPromise;
}


/* ============ 2. SCHEMA / UPGRADES ============ */
/*
   runUpgrade builds the schema step by step. Each `if` handles
   the jump INTO one version. Because they're not `else if`, a
   user coming from version 0 (brand new) runs every block in
   order, and a user from version 1 runs only the later ones.

   To evolve the schema later: bump DB_VERSION above, then add a
   new `if (oldVersion < 2) { ... }` block here. Never edit an
   existing block — users may have already run it.
*/
function runUpgrade(db, oldVersion) {
  // --- v1: initial schema ---
  if (oldVersion < 1) {
    // NOTES store. Primary key is each note's "id".
    const notes = db.createObjectStore(STORES.NOTES, { keyPath: 'id' });
    // Indexes let us sort/query without scanning everything:
    notes.createIndex('by_updated', 'updatedAt');   // recent-first lists
    notes.createIndex('by_folder', 'folderId');     // notes in a folder
    notes.createIndex('by_pinned', 'pinned');       // pinned notes

    // FOLDERS store. Also keyed by "id".
    const folders = db.createObjectStore(STORES.FOLDERS, { keyPath: 'id' });
    folders.createIndex('by_name', 'name');
  }

  /*  --- EXAMPLE for the future (do NOT uncomment now) ---
  if (oldVersion < 2) {
    // Say you add a "color" field and want to query by it:
    const notes = request.transaction.objectStore(STORES.NOTES);
    notes.createIndex('by_color', 'color');
  }
  */
}


/* ============ 3. A PROMISE WRAPPER FOR REQUESTS ============ */
/*
   Every IndexedDB request is event-based. Rather than writing
   onsuccess/onerror by hand a dozen times, this helper turns a
   single request into a Promise. Internal use only.
*/
function promisifyRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/*
   withStore(storeName, mode, work)
   -------------------------------------------------------------
   Opens a transaction, hands you the object store, and resolves
   with whatever your `work(store)` callback returns (after the
   transaction commits). Centralizing this means every CRUD
   function below stays tiny and consistent, and error handling
   lives in ONE place.
*/
async function withStore(storeName, mode, work) {
  const db = await open();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);

    let result;
    // Run the caller's logic; it may kick off a request.
    Promise.resolve(work(store))
      .then((value) => { result = value; })
      .catch(reject);

    // The transaction "commits" when it completes. We resolve
    // THEN, so callers know the data is actually persisted.
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}


/* ============ 4. CRUD — NOTES ============ */
/*
   Create + Update are the same operation in IndexedDB: `put`.
   It inserts if the key is new, or overwrites if it exists. That
   suits autosave perfectly (we just keep putting the same note).
*/

/** Insert or update a single note. Resolves with the note. */
export async function putNote(note) {
  await withStore(STORES.NOTES, 'readwrite', (store) => {
    store.put(note);
  });
  return note;
}

/** Fetch one note by id (or undefined if not found). */
export async function getNote(id) {
  return withStore(STORES.NOTES, 'readonly', (store) =>
    promisifyRequest(store.get(id))
  );
}

/** Fetch ALL notes as an array. Sorting/filtering happens in store.js. */
export async function getAllNotes() {
  return withStore(STORES.NOTES, 'readonly', (store) =>
    promisifyRequest(store.getAll())
  );
}

/** Delete one note by id. */
export async function deleteNote(id) {
  return withStore(STORES.NOTES, 'readwrite', (store) => {
    store.delete(id);
  });
}


/* ============ 5. CRUD — FOLDERS ============ */

/** Insert or update a folder. */
export async function putFolder(folder) {
  await withStore(STORES.FOLDERS, 'readwrite', (store) => {
    store.put(folder);
  });
  return folder;
}

/** Fetch all folders as an array. */
export async function getAllFolders() {
  return withStore(STORES.FOLDERS, 'readonly', (store) =>
    promisifyRequest(store.getAll())
  );
}

/** Delete a folder by id. (store.js decides what happens to its notes.) */
export async function deleteFolder(id) {
  return withStore(STORES.FOLDERS, 'readwrite', (store) => {
    store.delete(id);
  });
}


/* ============ 6. BULK HELPERS (used by Import) ============ */
/*
   bulkPut writes many records in ONE transaction. That's far
   faster and safer than looping one-by-one: if any write fails,
   the whole transaction aborts and nothing is half-imported.
*/

/** Write many notes at once. */
export async function bulkPutNotes(notes = []) {
  return withStore(STORES.NOTES, 'readwrite', (store) => {
    for (const note of notes) store.put(note);
  });
}

/** Write many folders at once. */
export async function bulkPutFolders(folders = []) {
  return withStore(STORES.FOLDERS, 'readwrite', (store) => {
    for (const folder of folders) store.put(folder);
  });
}


/* ============ 7. MAINTENANCE ============ */

/**
 * Wipe every note and folder. Used by Import's "replace" mode
 * and any future "reset app" feature. Both stores are cleared in
 * a single transaction so we never end up half-empty.
 */
export async function clearAll() {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORES.NOTES, STORES.FOLDERS], 'readwrite');
    tx.objectStore(STORES.NOTES).clear();
    tx.objectStore(STORES.FOLDERS).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
