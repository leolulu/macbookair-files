(function (root, factory) {
    var hash = typeof module === 'object' && module.exports
        ? require('../assets/vendor/js-sha256/sha256-1.0.0.min.js').sha256
        : root && root.sha256;
    var api = factory(root, hash);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.SvpPlaybackProgress = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root, sha256) {
    'use strict';


    function formatTime(seconds) {
        var total = Math.max(0, Math.floor(Number(seconds) || 0));
        var hours = Math.floor(total / 3600);
        var minutes = Math.floor((total % 3600) / 60);
        var remainingSeconds = String(total % 60).padStart(2, '0');
        if (hours > 0) return hours + ':' + String(minutes).padStart(2, '0') + ':' + remainingSeconds;
        return minutes + ':' + remainingSeconds;
    }

    function restorableRecord(record, duration, endPaddingSeconds) {
        if (!record || typeof record !== 'object') return null;
        var position = Number(record.position);
        var mediaDuration = Number(duration);
        var endPadding = typeof endPaddingSeconds === 'number' ? endPaddingSeconds : 5;
        if (!Number.isFinite(position) || !Number.isFinite(mediaDuration) || mediaDuration <= 0) return null;
        if (position <= 0 || position >= mediaDuration - endPadding) return null;
        return {
            position: position,
            duration: Number.isFinite(Number(record.duration)) ? Number(record.duration) : mediaDuration,
            updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : ''
        };
    }

    function createFirebaseClient(options) {
        var url = options.url;
        var baseUrl = url ? url.replace(/\/+$/, '') + '/progress/' : '';
        var fetchImpl = options.fetch || (root && root.fetch ? root.fetch.bind(root) : null);
        if (!baseUrl || !fetchImpl) throw new Error('Firebase progress storage is unavailable');
        if (typeof sha256 !== 'function') throw new Error('SHA-256 hashing is unavailable');
        var encoder = new TextEncoder();
        var keyUrls = new Map();
        var schedule = options.setTimeout || root.setTimeout.bind(root);
        var unschedule = options.clearTimeout || root.clearTimeout.bind(root);

        function keyUrl(sourceId) {
            var id = String(sourceId);
            if (keyUrls.has(id)) return keyUrls.get(id);
            var result = baseUrl + sha256(encoder.encode(id)) + '.json';
            keyUrls.set(id, result);
            return result;
        }

        async function request(method, sourceId, body, requestOptions) {
            var init = {
                method: method,
                headers: { 'Accept': 'application/json' },
                keepalive: !!(requestOptions && requestOptions.keepalive)
            };
            if (method === 'GET') init.cache = 'no-store';
            if (body !== undefined) {
                init.headers['Content-Type'] = 'application/json';
                init.body = JSON.stringify(body);
            }
            // Synchronous hashing lets lifecycle saves start fetch before yielding.
            var requestUrl = keyUrl(sourceId);
            var controller = new AbortController();
            init.signal = controller.signal;
            var timer = schedule(function () { controller.abort(); }, 10000);
            try {
                var response = await fetchImpl(requestUrl, init);
                var text = await response.text();
                if (method === 'GET' && response.status === 404) return null;
                if (!response.ok) {
                    var httpError = new Error('Firebase request failed with HTTP ' + response.status);
                    httpError.status = response.status;
                    throw httpError;
                }
                if (!text) return null;
                try { return JSON.parse(text); }
                catch (error) { throw new Error('Firebase returned invalid JSON'); }
            } finally {
                unschedule(timer);
            }
        }

        return {
            load: function (sourceId) { return request('GET', sourceId); },
            save: function (sourceId, record, requestOptions) {
                return request('PUT', sourceId, record, requestOptions);
            }
        };
    }

    function createController(options) {
        var video = options.video;
        var client = options.client;
        var host = options.host || root;
        var doc = options.document || (host && host.document);
        var onPrompt = options.onPrompt || function () { };
        var logger = options.logger || (root && root.console ? root.console : { warn: function () { } });
        var saveIntervalMs = typeof options.saveIntervalMs === 'number' ? options.saveIntervalMs : 30000;
        var minSaveIntervalMs = typeof options.minSaveIntervalMs === 'number' ? options.minSaveIntervalMs : 10000;
        var endPaddingSeconds = options.endPaddingSeconds;
        var now = options.now || Date.now;
        var schedule = options.setTimeout || (host && host.setTimeout ? host.setTimeout.bind(host) : setTimeout);
        var unschedule = options.clearTimeout || (host && host.clearTimeout ? host.clearTimeout.bind(host) : clearTimeout);

        var source = null;
        var generation = 0;
        var restoreStarted = false;
        var loadPromise = null;
        var canSave = false;
        var saveTimer = null;
        var pending = new Map();
        var drainPromise = null;
        var saveWaitTimer = null;
        var finishSaveWait = null;
        var lastSent = null;
        var destroyed = false;
        var lastRequestAt = -Infinity;
        var resumeSeekPosition = null;

        function logError(error) {
            if (logger && typeof logger.warn === 'function') logger.warn('[SVP_PROGRESS] Cloud save unavailable', error);
        }

        function isCurrent(token) {
            return !destroyed && token === generation;
        }

        function clearSaveTimer() {
            if (saveTimer !== null) {
                unschedule(saveTimer);
                saveTimer = null;
            }
        }

        function releaseSaveWait() {
            if (saveWaitTimer !== null) {
                unschedule(saveWaitTimer);
                saveWaitTimer = null;
            }
            if (finishSaveWait) {
                var resolve = finishSaveWait;
                finishSaveWait = null;
                resolve();
            }
        }

        function captureProgress() {
            if (!canSave || !source) return null;
            var position = Number(video.currentTime);
            var duration = Number(video.duration);
            if (!Number.isFinite(position) || !Number.isFinite(duration) || position < 0 || duration <= 0) return null;
            return {
                id: source.id,
                record: {
                    position: Math.round(position * 1000) / 1000,
                    duration: Math.round(duration * 1000) / 1000,
                    updatedAt: new Date(now()).toISOString()
                }
            };
        }

        function drain() {
            if (drainPromise) return drainPromise;
            if (!pending.size) return Promise.resolve();
            drainPromise = (async function () {
                var failed = new Set();
                while (!destroyed && pending.size) {
                    var entries = Array.from(pending.entries()).filter(function (entry) { return !failed.has(entry[0]); });
                    if (!entries.length) break;
                    var next = entries.find(function (entry) { return entry[1].urgent; }) || entries[0];
                    var waitMs = next[1].urgent ? 0 : minSaveIntervalMs - (now() - lastRequestAt);
                    if (waitMs > 0) {
                        await new Promise(function (resolve) {
                            finishSaveWait = resolve;
                            saveWaitTimer = schedule(releaseSaveWait, waitMs);
                        });
                        continue;
                    }
                    var id = next[0];
                    var item = next[1];
                    pending.delete(id);
                    lastRequestAt = now();
                    lastSent = item;
                    try {
                        await client.save(id, item.record, { keepalive: true });
                    } catch (error) {
                        lastSent = null;
                        if (!pending.has(id)) pending.set(id, item);
                        failed.add(id);
                        logError(error);
                    }
                }
            })().finally(function () {
                drainPromise = null;
            });
            return drainPromise;
        }

        function saveNow(urgent) {
            var item = captureProgress();
            if (!item) return drain();
            var previous = pending.get(item.id);
            if (lastSent && lastSent.id === item.id && lastSent.record.position === item.record.position && lastSent.record.duration === item.record.duration) {
                pending.delete(item.id);
            } else {
                item.urgent = !!urgent || !!(previous && previous.urgent);
                pending.set(item.id, item);
            }
            if (urgent) releaseSaveWait();
            return drain();
        }

        function saveOnExit() {
            clearSaveTimer();
            saveNow(true);
        }

        function saveOnMetadataLoaded() {
            if (!source || restoreStarted) return;
            restoreStarted = true;
            var token = generation;
            var currentSource = source;
            loadPromise.then(function (result) {
                if (!isCurrent(token)) return;
                if (result.error) {
                    canSave = true;
                    logError(result.error);
                    return;
                }
                if (canSave) return;
                var record = restorableRecord(result.payload, video.duration, endPaddingSeconds);
                if (!record) {
                    canSave = true;
                    return;
                }
                onPrompt({
                    name: currentSource.name,
                    position: record.position,
                    duration: record.duration,
                    updatedAt: record.updatedAt,
                    resume: function () {
                        if (!isCurrent(token)) return;
                        canSave = true;
                        onPrompt(null);
                        resumeSeekPosition = record.position;
                        video.currentTime = record.position;
                    },
                    dismiss: function () {
                        if (!isCurrent(token)) return;
                        canSave = true;
                        onPrompt(null);
                        saveNow(false);
                    }
                });
            });
        }

        function setSource(nextSource) {
            clearSaveTimer();
            saveNow(false);
            generation += 1;
            source = nextSource && nextSource.id ? { id: String(nextSource.id), name: nextSource.name || '' } : null;
            restoreStarted = false;
            canSave = false;
            lastSent = null;
            resumeSeekPosition = null;
            onPrompt(null);
            if (!source) {
                loadPromise = Promise.resolve({ payload: null });
                return;
            }
            lastRequestAt = now();
            loadPromise = Promise.resolve(client.load(source.id)).then(function (payload) {
                return { payload: payload };
            }, function (error) {
                return { error: error };
            });
        }

        function onTimeUpdate() {
            if (!canSave || video.paused || saveTimer !== null) return;
            saveTimer = schedule(function () {
                saveTimer = null;
                saveNow(false);
            }, saveIntervalMs);
        }

        function onPause() {
            clearSaveTimer();
            saveNow(false);
        }

        function chooseCurrentPosition() {
            if (!source || canSave) return;
            canSave = true;
            onPrompt(null);
        }

        function onPlay() {
            chooseCurrentPosition();
            onTimeUpdate();
        }

        function onSeeked() {
            if (resumeSeekPosition !== null) {
                var expected = resumeSeekPosition;
                resumeSeekPosition = null;
                if (Math.abs(Number(video.currentTime) - expected) < 0.01) {
                    clearSaveTimer();
                    return;
                }
            }
            if (restoreStarted) chooseCurrentPosition();
            onPause();
        }

        function onVisibilityChange() {
            if (doc && doc.hidden) saveOnExit();
        }

        function destroy() {
            clearSaveTimer();
            destroyed = true;
            pending.clear();
            releaseSaveWait();
            generation += 1;
            source = null;
            onPrompt(null);
            video.removeEventListener('loadedmetadata', saveOnMetadataLoaded);
            video.removeEventListener('timeupdate', onTimeUpdate);
            video.removeEventListener('play', onPlay);
            video.removeEventListener('pause', onPause);
            video.removeEventListener('seeked', onSeeked);
            video.removeEventListener('ended', onPause);
            if (host) host.removeEventListener('pagehide', saveOnExit);
            if (doc) doc.removeEventListener('visibilitychange', onVisibilityChange);
        }

        video.addEventListener('loadedmetadata', saveOnMetadataLoaded);
        video.addEventListener('timeupdate', onTimeUpdate);
        video.addEventListener('play', onPlay);
        video.addEventListener('pause', onPause);
        video.addEventListener('seeked', onSeeked);
        video.addEventListener('ended', onPause);
        if (host) host.addEventListener('pagehide', saveOnExit);
        if (doc) doc.addEventListener('visibilitychange', onVisibilityChange);

        return { setSource: setSource, flush: drain, destroy: destroy };
    }

    return {
        createFirebaseClient: createFirebaseClient,
        createController: createController,
        formatTime: formatTime,
        restorableRecord: restorableRecord
    };
});
