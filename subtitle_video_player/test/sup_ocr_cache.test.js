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

test('legacy complete and partial SUP results are ignored in either store', async () => {
    for (const status of ['complete', 'partial']) {
        const legacy = entry(1, status, 'old OCR text');
        assert.equal(await openCache(legacy, legacy).get(key), null);
    }
});

test('a legacy IndexedDB result does not hide a current localStorage result', async () => {
    const cache = openCache(entry(1, 'complete', 'old'), entry(2, 'partial', 'current'));
    const cached = await cache.get(key);
    assert.equal(cached.cacheVersion, 2);
    assert.equal(cached.status, 'partial');
    assert.equal(cached.cues[0].text, 'current');
});

test('new SUP results use the current version and take precedence in IndexedDB', async () => {
    const current = entry(2, 'complete', 'current');
    const cache = openCache(current, entry(1, 'partial', 'old'));
    assert.equal(cache.createEntry({ key }).cacheVersion, 2);
    assert.equal(await cache.get(key), current);
});
