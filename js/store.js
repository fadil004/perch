// Persistence: IndexedDB for library snapshots + thumbnail bytes, Cache API for values the service worker reads.

const DB_NAME = 'perch';
const DB_VERSION = 1;
let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
        if (!db.objectStoreNames.contains('thumbs')) db.createObjectStore('thumbs');
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => { db.close(); dbPromise = null; };
        resolve(db);
      };
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('IndexedDB is blocked'));
    }).catch((e) => { dbPromise = null; throw e; });
  }
  return dbPromise;
}

function run(store, mode, op) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = op(tx.objectStore(store));
    let result;
    if (req) req.onsuccess = () => { result = req.result; };
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('aborted'));
  }));
}

export const kv = {
  get: (key) => run('kv', 'readonly', (s) => s.get(key)),
  set: (key, value) => run('kv', 'readwrite', (s) => s.put(value, key)),
  del: (key) => run('kv', 'readwrite', (s) => s.delete(key)),
};

// Thumbnails are stored as raw bytes + type (most robust across Safari versions).
export const thumbStore = {
  async get(id) {
    const rec = await run('thumbs', 'readonly', (s) => s.get(id));
    return rec ? new Blob([rec.buf], { type: rec.type || 'image/png' }) : null;
  },
  async put(id, blob) {
    const buf = await blob.arrayBuffer();
    return run('thumbs', 'readwrite', (s) => s.put({ buf, type: blob.type }, id));
  },
  has: (id) => run('thumbs', 'readonly', (s) => s.getKey(id)).then((k) => k !== undefined),
};

export async function wipeAll() {
  try { const db = await openDb(); db.close(); } catch { /* ignore */ }
  dbPromise = null;
  await new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
  try { await caches.delete('perch-kv'); } catch { /* ignore */ }
}

// Small JSON values shared with the service worker (it can't see localStorage).
const KV_CACHE = 'perch-kv';
const kvUrl = (k) => new URL(`__kv/${k}`, document.baseURI).href;

export const swkv = {
  async set(key, value) {
    try {
      const c = await caches.open(KV_CACHE);
      await c.put(kvUrl(key), new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } }));
    } catch { /* Cache API unavailable (insecure context) */ }
  },
  async del(key) {
    try { const c = await caches.open(KV_CACHE); await c.delete(kvUrl(key)); } catch { /* ignore */ }
  },
};
