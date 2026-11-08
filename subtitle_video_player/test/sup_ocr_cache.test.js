const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../js/cache/sup_ocr_cache.js'), 'utf8');
const key = 'sup-cache-key';

function openCache(indexedEntry, localEntry) {
    function request(result) {
        const req = { result };
        queueMicrotask(() => req.onsuccess());
        return req;
    }

    const store = { get: () => request(indexedEntry) };
    const db = { transaction: () => ({ objectStore: () => store }) };
    const indexedDB = { open: () => request(db) };
    const localStorage = {
        getItem: name => name === 'svp:sup_ocr:v1:' + key && localEntry ? JSON.stringify(localEntry) : null,
    };
    const window = { indexedDB };
    vm.runInNewContext(source, { window, indexedDB, localStorage });
    return window.SupOcrCache;
}

function entry(cacheVersion, status, text) {
    return { key, cacheVersion, status, cues: [{ start: 1, end: 2, text }] };
}

const currentVersion = openCache().createEntry({ key }).cacheVersion;

test('legacy complete and partial SUP results are ignored in either store', async () => {
    for (const status of ['complete', 'partial']) {
        const legacy = entry(currentVersion - 1, status, 'old OCR text');
        assert.equal(await openCache(legacy, legacy).get(key), null);
    }
});

test('a legacy IndexedDB result does not hide a current localStorage result', async () => {
    const cache = openCache(entry(currentVersion - 1, 'complete', 'old'), entry(currentVersion, 'partial', 'current'));
    const cached = await cache.get(key);
    assert.equal(cached.cacheVersion, currentVersion);
    assert.equal(cached.status, 'partial');
    assert.equal(cached.cues[0].text, 'current');
});

test('current SUP results take precedence in IndexedDB', async () => {
    const current = entry(currentVersion, 'complete', 'current');
    const cache = openCache(current, entry(currentVersion - 1, 'partial', 'old'));
    assert.equal(await cache.get(key), current);
});
