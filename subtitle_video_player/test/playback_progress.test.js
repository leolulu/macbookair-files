const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createFirebaseClient, createController, makeUrlSourceId, formatTime, restorableRecord } = require('../js/playback_progress');

test('online identities use only the URL path across protocols, hosts, ports and query parameters', () => {
    const expected = '/media/%E7%94%B5%E5%BD%B1.mp4';
    for (const url of [
        'http://192.168.123.222:1127/media/电影.mp4?token=first#t=10',
        'https://example.com:8443/media/电影.mp4?token=second#t=20',
        'http://another.example/media/%E7%94%B5%E5%BD%B1.mp4',
        '//another.example:1234/media/电影.mp4?download=1',
        '/media/电影.mp4?token=third',
        '电影.mp4?token=fourth'
    ]) {
        assert.equal(makeUrlSourceId(url, 'http://localhost/media/'), expected);
    }
    assert.notEqual(makeUrlSourceId('https://example.com/other/电影.mp4'), expected);
    assert.notEqual(makeUrlSourceId('https://example.com/media/另一部电影.mp4'), expected);
    assert.notEqual(makeUrlSourceId('https://example.com/media/Movie.mp4'), makeUrlSourceId('https://example.com/media/movie.mp4'));
});

function eventTarget() {
    const listeners = new Map();
    return {
        addEventListener(type, handler) {
            if (!listeners.has(type)) listeners.set(type, new Set());
            listeners.get(type).add(handler);
        },
        removeEventListener(type, handler) {
            if (listeners.has(type)) listeners.get(type).delete(handler);
        },
        emit(type) {
            for (const handler of listeners.get(type) || []) handler();
        }
    };
}

function deferred() {
    let resolve;
    const promise = new Promise(resolvePromise => { resolve = resolvePromise; });
    return { promise, resolve };
}

function settle() {
    return new Promise(resolve => setImmediate(resolve));
}

function fakeTimers() {
    let serial = 0;
    let time = 0;
    const tasks = new Map();
    return {
        setTimeout(callback, delay) {
            const task = { id: ++serial, callback, at: time + delay };
            tasks.set(task.id, task);
            return task.id;
        },
        clearTimeout(id) { tasks.delete(id); },
        advance(milliseconds) {
            time += milliseconds;
            for (const task of [...tasks.values()].sort((a, b) => a.at - b.at)) {
                if (task.at <= time) {
                    tasks.delete(task.id);
                    task.callback();
                }
            }
        },
        get size() { return tasks.size; },
        get now() { return time; }
    };
}

function fixture(options = {}) {
    const video = Object.assign(eventTarget(), { currentTime: 0, duration: 120, paused: false });
    const host = eventTarget();
    const document = Object.assign(eventTarget(), { hidden: false });
    const timers = fakeTimers();
    const saves = [];
    const prompts = [];
    const warnings = [];
    let currentPrompt = null;
    const client = {
        load: options.load || (() => Promise.resolve(null)),
        save: options.save || ((id, record, requestOptions) => {
            saves.push({ id, record, options: requestOptions });
            return Promise.resolve();
        })
    };
    const controller = createController({
        video,
        host,
        document,
        client,
        saveIntervalMs: 10000,
        minSaveIntervalMs: typeof options.minSaveIntervalMs === 'number' ? options.minSaveIntervalMs : 0,
        now: options.now || (() => Date.UTC(2026, 9, 27, 1, 2, 3) + timers.now),
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout,
        onPrompt(prompt) {
            currentPrompt = prompt;
            prompts.push(prompt);
        },
        logger: { warn: (...args) => warnings.push(args) }
    });
    return {
        video, host, document, timers, saves, prompts, warnings, client, controller,
        get prompt() { return currentPrompt; }
    };
}

test('restores a saved position without a redundant rewrite or overwriting it while prompting', async () => {
    const f = fixture({
        load: () => Promise.resolve({ position: 42.5, duration: 120 })
    });
    f.controller.setSource({ id: 'movie-a', name: 'a.mp4' });
    f.video.emit('loadedmetadata');
    await settle();
    assert.equal(f.prompt.position, 42.5);
    assert.equal(f.saves.length, 0);
    f.prompt.resume();
    await f.controller.flush();
    assert.equal(f.video.currentTime, 42.5);
    assert.equal(f.prompt, null);
    f.video.emit('seeked');
    await f.controller.flush();
    assert.equal(f.saves.length, 0);
    f.video.currentTime = 50;
    f.video.emit('seeked');
    await f.controller.flush();
    assert.equal(f.saves.at(-1).record.position, 50);
    f.controller.destroy();
});

test('dismissing a restore prompt resumes saving from the current position', async () => {
    const f = fixture({
        load: () => Promise.resolve({ position: 38, duration: 120 })
    });
    f.controller.setSource({ id: 'movie-a' });
    f.video.emit('loadedmetadata');
    await settle();
    f.prompt.dismiss();
    await f.controller.flush();
    assert.equal(f.prompt, null);
    assert.equal(f.saves.at(-1).record.position, 0);
    f.controller.destroy();
});

test('a late response from the previous video cannot prompt over the new video', async () => {
    const first = deferred(), second = deferred();
    const loads = [first.promise, second.promise];
    const f = fixture({ load: () => loads.shift() });
    f.controller.setSource({ id: 'old-movie' });
    f.video.emit('loadedmetadata');
    f.controller.setSource({ id: 'new-movie' });
    f.video.emit('loadedmetadata');
    second.resolve({ position: 30, duration: 120 });
    await settle();
    first.resolve({ position: 80, duration: 120 });
    await settle();
    assert.equal(f.prompt.position, 30);
    assert.equal(f.prompts.filter(Boolean).length, 1);
    f.controller.destroy();
});

test('time updates save at the configured interval and pause flushes the latest position', async () => {
    const f = fixture();
    f.controller.setSource({ id: 'movie-a' });
    f.video.emit('loadedmetadata');
    await settle();
    f.video.currentTime = 12;
    f.video.emit('timeupdate');
    f.timers.advance(9999);
    assert.equal(f.saves.length, 0);
    f.timers.advance(1);
    await f.controller.flush();
    assert.equal(f.saves.length, 1);
    assert.equal(f.saves[0].record.position, 12);
    f.video.currentTime = 18;
    f.video.emit('timeupdate');
    assert.equal(f.timers.size, 1);
    f.video.emit('pause');
    await f.controller.flush();
    assert.equal(f.timers.size, 0);
    assert.equal(f.saves.at(-1).record.position, 18);
    f.controller.destroy();
});

test('switching videos saves the old identity before starting the new restore', async () => {
    const f = fixture();
    f.controller.setSource({ id: 'movie-a' });
    f.video.emit('loadedmetadata');
    await settle();
    f.video.currentTime = 27;
    f.controller.setSource({ id: 'movie-b' });
    await f.controller.flush();
    assert.equal(f.saves.at(-1).id, 'movie-a');
    assert.equal(f.saves.at(-1).record.position, 27);
    f.controller.destroy();
});

test('a failed save remains pending and the next lifecycle save retries the newest position', async () => {
    let attempts = 0;
    const f = fixture({
        save: (id, record) => {
            attempts += 1;
            if (attempts === 1) return Promise.reject(new Error('offline'));
            return Promise.resolve();
        }
    });
    f.controller.setSource({ id: 'movie-a' });
    f.video.emit('loadedmetadata');
    await settle();
    f.video.currentTime = 5;
    f.video.emit('pause');
    await f.controller.flush();
    f.video.currentTime = 9;
    f.video.emit('pause');
    await f.controller.flush();
    assert.equal(attempts, 2);
    assert.equal(f.warnings.length, 1);
    f.controller.destroy();
});

test('rapid lifecycle saves coalesce and reads and writes stay outside the storage rate-limit window', async () => {
    const first = deferred();
    const attempts = [];
    const f = fixture({
        minSaveIntervalMs: 10000,
        save: (id, record) => {
            attempts.push({ at: f.timers.now, position: record.position });
            return attempts.length === 1 ? first.promise : Promise.resolve();
        }
    });
    f.controller.setSource({ id: 'movie-a' });
    f.video.emit('loadedmetadata');
    await settle();
    f.video.currentTime = 5;
    f.video.emit('pause');
    await settle();
    assert.equal(attempts.length, 0);
    f.timers.advance(10000);
    await settle();
    f.video.currentTime = 9;
    f.video.emit('pause');
    first.resolve();
    await settle();
    f.timers.advance(9999);
    await settle();
    assert.equal(attempts.length, 1);
    f.timers.advance(1);
    await f.controller.flush();
    assert.deepEqual(attempts, [{ at: 10000, position: 5 }, { at: 20000, position: 9 }]);
    f.controller.destroy();
});

test('playing without answering the resume prompt dismisses it and records playback', async () => {
    const f = fixture({ load: async () => ({ position: 38, duration: 120 }) });
    f.controller.setSource({ id: 'movie-a' });
    f.video.emit('loadedmetadata');
    await settle();
    assert.equal(f.prompt.position, 38);
    f.video.emit('play');
    assert.equal(f.prompt, null);
    f.video.currentTime = 25;
    f.timers.advance(10000);
    await f.controller.flush();
    assert.equal(f.saves.at(-1).record.position, 25);
    assert.equal(f.saves.at(-1).options.keepalive, true);
    f.controller.destroy();
});

test('seeking without answering the resume prompt saves the chosen position', async () => {
    const f = fixture({ load: async () => ({ position: 38, duration: 120 }) });
    f.video.paused = true;
    f.controller.setSource({ id: 'movie-a' });
    f.video.emit('loadedmetadata');
    await settle();
    f.video.currentTime = 12;
    f.video.emit('seeked');
    await f.controller.flush();
    assert.equal(f.prompt, null);
    assert.equal(f.saves.at(-1).record.position, 12);
    assert.equal(f.video.paused, true);
    f.controller.destroy();
});

test('playback or seeking before the read finishes prevents a late resume prompt', async () => {
    for (const event of ['play', 'seeked']) {
        const read = deferred();
        const f = fixture({ load: () => read.promise });
        f.controller.setSource({ id: 'movie-a' });
        f.video.emit('loadedmetadata');
        f.video.currentTime = 12;
        f.video.emit(event);
        read.resolve({ position: 38, duration: 120 });
        await settle();
        assert.equal(f.prompts.filter(Boolean).length, 0, event);
        f.video.emit('pause');
        await f.controller.flush();
        assert.equal(f.saves.at(-1).record.position, 12, event);
        f.controller.destroy();
    }
});

test('an unanswered prompt still protects the old record when the user has not played or sought', async () => {
    const f = fixture({ load: async () => ({ position: 38, duration: 120 }) });
    f.video.paused = true;
    f.controller.setSource({ id: 'movie-a' });
    f.video.emit('loadedmetadata');
    await settle();
    f.video.emit('timeupdate');
    f.video.emit('pause');
    f.document.hidden = true;
    f.document.emit('visibilitychange');
    f.host.emit('pagehide');
    await f.controller.flush();
    assert.equal(f.saves.length, 0);
    assert.equal(f.prompt.position, 38);
    f.prompt.resume();
    f.video.emit('seeked');
    await f.controller.flush();
    assert.equal(f.saves.length, 0);
    assert.equal(f.video.currentTime, 38);
    assert.equal(f.video.paused, true);
    f.controller.destroy();
});

test('hiding wakes a throttled save and pagehide does not repeat the same snapshot', async () => {
    const f = fixture({ minSaveIntervalMs: 10000 });
    f.controller.setSource({ id: 'movie-a' });
    f.video.emit('loadedmetadata');
    await settle();
    f.timers.advance(2000);
    f.video.currentTime = 2;
    f.video.emit('pause');
    assert.equal(f.saves.length, 0);
    assert.equal(f.timers.size, 1);
    f.document.hidden = true;
    f.document.emit('visibilitychange');
    await settle();
    assert.equal(f.saves.length, 1);
    assert.equal(f.saves[0].record.position, 2);
    assert.equal(f.saves[0].options.keepalive, true);
    assert.equal(f.timers.now, 2000);
    assert.equal(f.timers.size, 0);
    f.host.emit('pagehide');
    await f.controller.flush();
    assert.equal(f.saves.length, 1);
    f.controller.destroy();
});

test('exit saves stay behind an in-flight write and coalesce to the latest position', async () => {
    const first = deferred();
    const attempts = [];
    let stored;
    const f = fixture({
        minSaveIntervalMs: 10000,
        save: async (id, record, options) => {
            attempts.push({ position: record.position, options });
            if (attempts.length === 1) await first.promise;
            stored = record.position;
        }
    });
    f.controller.setSource({ id: 'movie-a' });
    f.video.emit('loadedmetadata');
    await settle();
    f.timers.advance(10000);
    f.video.currentTime = 60;
    f.video.emit('pause');
    f.video.currentTime = 63;
    f.document.hidden = true;
    f.document.emit('visibilitychange');
    f.video.currentTime = 64;
    f.host.emit('pagehide');
    assert.equal(attempts.length, 1);
    first.resolve();
    await f.controller.flush();
    assert.deepEqual(attempts.map(item => item.position), [60, 64]);
    assert.ok(attempts.every(item => item.options.keepalive));
    assert.equal(stored, 64);
    assert.equal(f.timers.now, 10000);
    f.controller.destroy();
});

test('reopening a video resets save deduplication after reading a newer cloud record', async () => {
    let reads = 0;
    const f = fixture({ load: async () => ++reads === 1 ? null : { position: 80, duration: 120 } });
    f.controller.setSource({ id: 'movie-a' });
    f.video.emit('loadedmetadata');
    await settle();
    f.video.currentTime = 60;
    f.video.emit('pause');
    await f.controller.flush();
    f.controller.setSource({ id: 'movie-a' });
    f.video.currentTime = 0;
    f.video.emit('loadedmetadata');
    await settle();
    assert.equal(f.prompt.position, 80);
    f.video.currentTime = 60;
    f.video.emit('seeked');
    await f.controller.flush();
    assert.equal(f.saves.length, 2);
    assert.equal(f.saves.at(-1).record.position, 60);
    f.controller.destroy();
});

test('a failed video does not block saving another pending video or retry in a loop', async () => {
    const first = deferred();
    const attempts = [];
    const f = fixture({
        save: async (id, record) => {
            attempts.push({ id, position: record.position });
            if (attempts.length === 1) {
                await first.promise;
                throw new Error('timeout');
            }
        }
    });
    f.controller.setSource({ id: 'movie-a' });
    f.video.emit('loadedmetadata');
    await settle();
    f.video.currentTime = 10;
    f.video.emit('pause');
    f.controller.setSource({ id: 'movie-b' });
    f.video.currentTime = 0;
    f.video.emit('loadedmetadata');
    await settle();
    f.video.currentTime = 20;
    f.video.emit('pause');
    first.resolve();
    await f.controller.flush();
    assert.deepEqual(attempts, [{ id: 'movie-a', position: 10 }, { id: 'movie-b', position: 20 }]);
    assert.equal(f.warnings.length, 1);
    f.video.emit('pause');
    await f.controller.flush();
    assert.deepEqual(attempts.at(-1), { id: 'movie-a', position: 10 });
    f.controller.destroy();
});

function firebaseFixture(fetch) {
    const timers = fakeTimers();
    const client = createFirebaseClient({
        url: 'https://example.invalid',
        fetch,
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout
    });
    return { client, timers };
}

function jsonResponse(payload) {
    return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
}

test('Firebase preserves SHA-256 record URLs and starts saves before yielding', async () => {
    const requests = [];
    const f = firebaseFixture(async (url, init) => {
        requests.push({ url, init });
        return jsonResponse(null);
    });
    await f.client.load('movie-a');
    const save = f.client.save('movie-a', { position: 15 }, { keepalive: true });
    assert.equal(requests.length, 2);
    const expectedKey = createHash('sha256').update('movie-a').digest('hex');
    assert.equal(requests[0].url, 'https://example.invalid/progress/' + expectedKey + '.json');
    assert.equal(requests[1].url, requests[0].url);
    assert.equal(requests[1].init.method, 'PUT');
    assert.equal(requests[1].init.keepalive, true);
    await save;
    assert.equal(f.timers.size, 0);
});

test('browser hashing preserves existing keys without using Web Crypto', async () => {
    const rootDir = path.resolve(__dirname, '..');
    const vendor = fs.readFileSync(path.join(rootDir, 'assets/vendor/js-sha256/sha256-1.0.0.min.js'), 'utf8');
    const progress = fs.readFileSync(path.join(rootDir, 'js/playback_progress.js'), 'utf8');
    const identities = ['', 'abc', '中文视频🎬.mp4|4372373|1234567890', 'https://example.com/movie.mp4?token=' + 'x'.repeat(1000), '\ud800', ...[55, 56, 63, 64, 65].map(length => 'x'.repeat(length))];
    for (const crypto of [undefined, { subtle: { digest() { throw new Error('Native hashing must not be called'); } } }]) {
        const requests = [];
        const sandbox = {
            crypto, TextEncoder, AbortController, setTimeout, clearTimeout,
            fetch: async (url, init) => { requests.push({ url, init }); return jsonResponse(null); }
        };
        vm.runInNewContext(vendor, sandbox);
        vm.runInNewContext(progress, sandbox);
        const client = sandbox.SvpPlaybackProgress.createFirebaseClient({ url: 'https://example.invalid' });
        for (const identity of identities) {
            await client.load(identity);
            const expectedKey = createHash('sha256').update(identity).digest('hex');
            assert.equal(requests.at(-1).url, 'https://example.invalid/progress/' + expectedKey + '.json');
        }
    }
});

test('a stalled Firebase read aborts after ten seconds and the controller can then save', async () => {
    const started = deferred();
    const writes = [];
    let readSignal;
    const firebase = firebaseFixture((url, init) => {
        if (init.method === 'GET') {
            readSignal = init.signal;
            started.resolve();
            return new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
        }
        writes.push(JSON.parse(init.body));
        return Promise.resolve(jsonResponse(null));
    });
    const f = fixture({ load: id => firebase.client.load(id), save: (...args) => firebase.client.save(...args) });
    f.controller.setSource({ id: 'movie-a' });
    f.video.emit('loadedmetadata');
    await started.promise;
    firebase.timers.advance(9999);
    assert.equal(readSignal.aborted, false);
    firebase.timers.advance(1);
    await settle();
    assert.equal(readSignal.aborted, true);
    assert.equal(f.warnings.length, 1);
    f.video.currentTime = 15;
    f.video.emit('pause');
    await f.controller.flush();
    assert.equal(writes[0].position, 15);
    assert.equal(firebase.timers.size, 0);
    f.controller.destroy();
});

test('a stalled Firebase response body times out and the next save retries the newest position', async () => {
    const bodyStarted = deferred();
    const writes = [];
    const firebase = firebaseFixture(async (url, init) => {
        if (init.method === 'GET') return jsonResponse(null);
        writes.push(JSON.parse(init.body));
        if (writes.length > 1) return jsonResponse(null);
        return {
            ok: true,
            status: 200,
            text: () => {
                bodyStarted.resolve();
                return new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
            }
        };
    });
    await firebase.client.load('movie-a');
    const f = fixture({ save: (...args) => firebase.client.save(...args) });
    f.controller.setSource({ id: 'movie-a' });
    f.video.emit('loadedmetadata');
    await settle();
    f.video.currentTime = 15;
    f.video.emit('pause');
    await bodyStarted.promise;
    f.video.currentTime = 20;
    f.video.emit('pause');
    firebase.timers.advance(10000);
    await f.controller.flush();
    assert.equal(f.warnings.length, 1);
    assert.equal(writes.length, 1);
    f.video.emit('pause');
    await f.controller.flush();
    assert.deepEqual(writes.map(record => record.position), [15, 20]);
    assert.equal(firebase.timers.size, 0);
    f.controller.destroy();
});

test('pagehide sends the latest position with keepalive', async () => {
    const f = fixture();
    f.controller.setSource({ id: 'movie-a' });
    f.video.emit('loadedmetadata');
    await settle();
    f.video.currentTime = 33;
    f.host.emit('pagehide');
    await settle();
    assert.equal(f.saves.at(-1).record.position, 33);
    assert.equal(f.saves.at(-1).options.keepalive, true);
    f.controller.destroy();
});

test('invalid, zero and effectively completed positions do not offer a resume', () => {
    assert.equal(restorableRecord(null, 120), null);
    assert.equal(restorableRecord({ position: 0 }, 120), null);
    assert.equal(restorableRecord({ position: 116 }, 120), null);
    assert.equal(restorableRecord({ position: Number.NaN }, 120), null);
    assert.equal(restorableRecord({ position: 12 }, Number.NaN), null);
    assert.equal(restorableRecord({ position: 12 }, 120).position, 12);
});

test('resume time formatting stays compact below one hour and explicit above it', () => {
    assert.equal(formatTime(65.9), '1:05');
    assert.equal(formatTime(3661), '1:01:01');
});
