// Persistent SUP OCR cache.
// Stores converted subtitle text by SUP identity in browser storage.
// Primary: IndexedDB. Fallback: localStorage.
//
// Exposes: window.SupOcrCache

(function () {
    'use strict';

    const CACHE_VERSION = 1;
    const DB_NAME = 'subtitle_video_player_cache';
    const DB_VERSION = 1;
    const STORE = 'sup_ocr';
    const LS_PREFIX = 'svp:sup_ocr:v1:';

    function nowIso() {
        return new Date().toISOString();
    }

    function safeString(x) {
        if (x === null || x === undefined) return '';
        return String(x);
    }

    function makeSupId(fileLike, sourceIdOverride) {
        // Goal: stable across sessions without reading full file bytes.
        // For File: name + size + lastModified.
        // For URL blob: pass the URL string as sourceIdOverride.
        const base = safeString(sourceIdOverride)
            || (fileLike && typeof fileLike.name === 'string' ? fileLike.name : '')
            || (fileLike && typeof fileLike.type === 'string' ? fileLike.type : '')
            || 'unknown.sup';

        const size = fileLike && typeof fileLike.size === 'number' ? fileLike.size : 0;
        const lm = fileLike && typeof fileLike.lastModified === 'number' ? fileLike.lastModified : 0;
        return `${base}|${size}|${lm}`;
    }

    function makeMovieId(fileLike, sourceIdOverride) {
        const base = safeString(sourceIdOverride)
            || (fileLike && typeof fileLike.name === 'string' ? fileLike.name : '')
            || 'no-movie';
        const size = fileLike && typeof fileLike.size === 'number' ? fileLike.size : 0;
        const lm = fileLike && typeof fileLike.lastModified === 'number' ? fileLike.lastModified : 0;
        return `${base}|${size}|${lm}`;
    }

    function makeCacheKey(movieId, supId) {
        return `movie=${safeString(movieId || 'no-movie')}::sup=${safeString(supId)}`;
    }

    function openDb() {
        if (!('indexedDB' in window)) {
            return Promise.resolve(null);
        }
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(STORE)) {
                    db.createObjectStore(STORE, { keyPath: 'key' });
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => resolve(null);
            req.onblocked = () => resolve(null);
        });
    }

    async function idbGet(key) {
        const db = await openDb();
        if (!db) return null;
        return new Promise((resolve) => {
            const tx = db.transaction(STORE, 'readonly');
            const store = tx.objectStore(STORE);
            const req = store.get(key);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => resolve(null);
        });
    }

    async function idbPut(entry) {
        const db = await openDb();
        if (!db) return false;
        return new Promise((resolve) => {
            const tx = db.transaction(STORE, 'readwrite');
            const store = tx.objectStore(STORE);
            const req = store.put(entry);
            req.onsuccess = () => resolve(true);
            req.onerror = () => resolve(false);
        });
    }

    function lsGet(key) {
        try {
            const raw = localStorage.getItem(LS_PREFIX + key);
            if (!raw) return null;
            return JSON.parse(raw);
        } catch {
            return null;
        }
    }

    function lsPut(key, entry) {
        try {
            localStorage.setItem(LS_PREFIX + key, JSON.stringify(entry));
            return true;
        } catch {
            return false;
        }
    }

    async function get(key) {
        const fromIdb = await idbGet(key);
        if (fromIdb) return fromIdb;
        return lsGet(key);
    }

    async function put(entry) {
        if (!entry || !entry.key) return false;
        entry.updatedAt = nowIso();
        const okIdb = await idbPut(entry);
        if (okIdb) return true;
        return lsPut(entry.key, entry);
    }

    function createEntry({ key, supId, cues }) {
        return {
            key,
            cacheVersion: CACHE_VERSION,
            supId,
            createdAt: nowIso(),
            updatedAt: nowIso(),
            status: 'partial',
            cues: (cues || []).map((c) => ({
                start: c.start,
                end: c.end,
                text: c.text || '',
            })),
            doneCount: (cues || []).reduce((n, c) => n + (c.text ? 1 : 0), 0),
        };
    }

    function isUsableEntry(entry, expectedCueCount) {
        if (!entry) return false;
        if (entry.cacheVersion !== CACHE_VERSION) return false;
        if (!Array.isArray(entry.cues)) return false;
        if (typeof expectedCueCount === 'number' && expectedCueCount >= 0) {
            if (entry.cues.length !== expectedCueCount) return false;
        }
        return true;
    }

    window.SupOcrCache = {
        makeSupId,
        makeMovieId,
        makeCacheKey,
        get,
        put,
        createEntry,
        isUsableEntry,
    };
})();
