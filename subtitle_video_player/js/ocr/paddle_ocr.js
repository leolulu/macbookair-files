// PaddleOCR (browser) orchestration for SUP bitmap subtitles.
// Exposes window.PaddleSubtitleOcr.

(function () {
    'use strict';

    function svpOcrLog(event, details) {
        try {
            const msg = '[SVP_OCR] ' + event;
            if (details !== undefined) {
                console.log(msg, details);
            } else {
                console.log(msg);
            }
        } catch {
            // ignore
        }
    }

    function postprocessSubtitleText(text) {
        if (!text) return '';
        let t = String(text);
        t = t.replace(/\r\n/g, '\n');
        t = t.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
        t = t.replace(/\s+$/g, '');
        t = t.replace(/^\s+/g, '');
        t = t.replace(/[ \t]+/g, ' ');
        t = t.replace(/\n\s+/g, '\n');
        return t.trim();
    }

    function yieldToBrowser(label, timeoutMs) {
        timeoutMs = typeof timeoutMs === 'number' ? timeoutMs : 16;
        return new Promise((resolve) => {
            let done = false;
            function finish(source) {
                if (done) return;
                done = true;
                svpOcrLog('yieldToBrowser finish', { label, source });
                resolve();
            }

            if (typeof requestAnimationFrame === 'function') {
                requestAnimationFrame(() => finish('raf'));
            }
            setTimeout(() => finish('timer'), timeoutMs);
        });
    }

    function withTimeout(promise, timeoutMs, label) {
        return Promise.race([
            promise,
            new Promise((_, reject) => {
                setTimeout(() => {
                    reject(new Error((label || 'operation') + ' timed out after ' + timeoutMs + 'ms'));
                }, timeoutMs);
            }),
        ]);
    }

    async function fetchTextWithTimeout(url, timeoutMs) {
        const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
        let timer = null;
        try {
            if (controller) {
                timer = setTimeout(() => controller.abort(), timeoutMs);
            }
            const response = await fetch(url, controller ? { signal: controller.signal } : undefined);
            if (!response.ok) {
                throw new Error('Failed to fetch ' + url + ' (' + response.status + ')');
            }
            return await response.text();
        } catch (err) {
            if (err && err.name === 'AbortError') {
                throw new Error('fetch timed out after ' + timeoutMs + 'ms: ' + url);
            }
            throw err;
        } finally {
            if (timer) {
                clearTimeout(timer);
            }
        }
    }

    function fnv1a32(bytes) {
        let hash = 0x811c9dc5;
        for (let i = 0; i < bytes.length; i += 16) {
            hash ^= bytes[i];
            hash = Math.imul(hash, 0x01000193);
        }
        return (hash >>> 0).toString(16);
    }

    function waitForOpenCvReady(timeoutMs) {
        timeoutMs = timeoutMs || 20000;
        const start = Date.now();
        svpOcrLog('waitForOpenCvReady enter', { timeoutMs, hasCv: !!window.cv });

        function isPromiseLike(value) {
            return !!value && (typeof value === 'object' || typeof value === 'function') && typeof value.then === 'function';
        }

        function isActuallyReady(cvObj) {
            if (!cvObj) return false;
            const hasMat = typeof cvObj.matFromImageData === 'function';
            const hasMatCtor = typeof cvObj.Mat === 'function';
            const calledRunReady = cvObj.calledRun === true;
            const noCalledRunInfo = typeof cvObj.calledRun === 'undefined';
            return hasMat && hasMatCtor && (calledRunReady || noCalledRunInfo);
        }

        return new Promise((resolve, reject) => {
            let firstCheck = true;

            async function check() {
                try {
                    let cvObj = window.cv;
                    if (firstCheck) {
                        firstCheck = false;
                        svpOcrLog('waitForOpenCvReady first-check', {
                            hasCv: !!cvObj,
                            isPromiseLike: isPromiseLike(cvObj),
                            hasMatFromImageData: !!(cvObj && typeof cvObj.matFromImageData === 'function'),
                            hasMatCtor: !!(cvObj && typeof cvObj.Mat === 'function'),
                            calledRun: cvObj && typeof cvObj.calledRun !== 'undefined' ? cvObj.calledRun : '(missing)',
                        });
                    }

                    if (isPromiseLike(cvObj)) {
                        svpOcrLog('waitForOpenCvReady awaiting cv promise');
                        cvObj = await withTimeout(cvObj, timeoutMs, 'window.cv promise');
                        window.cv = cvObj;
                        svpOcrLog('waitForOpenCvReady cv promise resolved', {
                            hasMatFromImageData: !!(cvObj && typeof cvObj.matFromImageData === 'function'),
                            hasMatCtor: !!(cvObj && typeof cvObj.Mat === 'function'),
                            calledRun: cvObj && typeof cvObj.calledRun !== 'undefined' ? cvObj.calledRun : '(missing)',
                        });
                    }

                    if (isActuallyReady(cvObj)) {
                        svpOcrLog('waitForOpenCvReady resolve-ready', {
                            elapsedMs: Date.now() - start,
                            calledRun: typeof cvObj.calledRun !== 'undefined' ? cvObj.calledRun : '(missing)',
                        });
                        resolve(cvObj);
                        return;
                    }

                    if (Date.now() - start > timeoutMs) {
                        svpOcrLog('waitForOpenCvReady timeout', {
                            elapsedMs: Date.now() - start,
                            hasCv: !!cvObj,
                            isPromiseLike: isPromiseLike(cvObj),
                            hasMatFromImageData: !!(cvObj && typeof cvObj.matFromImageData === 'function'),
                            hasMatCtor: !!(cvObj && typeof cvObj.Mat === 'function'),
                            calledRun: cvObj && typeof cvObj.calledRun !== 'undefined' ? cvObj.calledRun : '(missing)',
                        });
                        reject(new Error('OpenCV runtime did not become ready in time'));
                        return;
                    }

                    setTimeout(check, 50);
                } catch (error) {
                    svpOcrLog('waitForOpenCvReady failed', {
                        message: String(error && error.message ? error.message : error),
                    });
                    reject(error);
                }
            }

            check();
        });
    }

    function waitForCondition(testFn, timeoutMs, errorMessage) {
        timeoutMs = timeoutMs || 20000;
        const start = Date.now();
        return new Promise((resolve, reject) => {
            function check() {
                try {
                    if (testFn()) {
                        resolve();
                        return;
                    }
                } catch (err) {
                    reject(err);
                    return;
                }
                if (Date.now() - start > timeoutMs) {
                    reject(new Error(errorMessage || 'Timed out waiting for runtime'));
                    return;
                }
                setTimeout(check, 50);
            }
            check();
        });
    }

    function loadScriptOnce(key, src, testFn) {
        if (window[key]) {
            svpOcrLog('loadScriptOnce cache-hit', { key, src });
            return window[key];
        }
        window[key] = new Promise((resolve, reject) => {
            if (testFn && testFn()) {
                svpOcrLog('loadScriptOnce already-ready', { key, src });
                resolve();
                return;
            }

            const existing = document.querySelector('script[src="' + src + '"]');
            if (existing) {
                svpOcrLog('loadScriptOnce existing-tag', { key, src });
                waitForCondition(testFn || function () { return true; }, 30000, 'Timed out waiting for script: ' + src)
                    .then(resolve)
                    .catch(reject);
                return;
            }

            const script = document.createElement('script');
            script.src = src;
            script.async = true;
            script.onload = () => {
                svpOcrLog('loadScriptOnce onload', { key, src });
                waitForCondition(testFn || function () { return true; }, 30000, 'Timed out waiting for script: ' + src)
                    .then(resolve)
                    .catch(reject);
            };
            script.onerror = () => reject(new Error('Failed to load script: ' + src));
            svpOcrLog('loadScriptOnce append', { key, src });
            document.head.appendChild(script);
        });
        return window[key];
    }

    class PaddleSubtitleOcrEngine {
        constructor() {
            this._readyPromise = null;
            this._cache = new Map();
            this._ocrInstance = null;
            this._ocrModule = null;
            this._statusNotifier = null;
            this._statusDedup = new Set();
            this._progressBatchSeq = 0;
            this._worker = null;
            this._workerSeq = 0;
            this._pendingWorkerRequests = new Map();
        }

        setStatusNotifier(notifier) {
            this._statusNotifier = typeof notifier === 'function' ? notifier : null;
        }

        _emitStatus(message, type, durationMs, dedupeKey) {
            if (!this._statusNotifier) {
                return;
            }
            const key = dedupeKey || message;
            if (this._statusDedup.has(key)) {
                return;
            }
            this._statusDedup.add(key);
            this._statusNotifier(message, type || 'info', durationMs);
        }

        _emitProgressStatus(batchId, completed, total, forceFinal) {
            if (!this._statusNotifier || !total || total <= 0) {
                return;
            }

            // Low-frequency progress buckets: first item, then every 20%, then final item.
            let bucket;
            if (forceFinal || completed >= total) {
                bucket = 'done';
            } else if (completed <= 1) {
                bucket = 'start';
            } else {
                bucket = 'p' + Math.floor((completed / total) * 5);
            }

            const dedupeKey = 'ocr-progress:' + batchId + ':' + bucket;
            const message = completed >= total
                ? ('字幕 OCR 识别完成 ' + total + '/' + total)
                : ('正在识别第 ' + completed + '/' + total + ' 条字幕');
            const type = completed >= total ? 'success' : 'info';
            const duration = completed >= total ? 1800 : 1400;

            this._emitStatus(message, type, duration, dedupeKey);
        }

        _ensureWorker() {
            if (this._worker) {
                return this._worker;
            }
            const worker = new Worker('js/ocr/paddle_ocr_worker.js');
            worker.onmessage = (event) => {
                const payload = event.data || {};
                if (payload.type === 'status') {
                    this._emitStatus(payload.message, payload.level, payload.durationMs, payload.dedupeKey);
                    return;
                }
                if (payload.type === 'log') {
                    svpOcrLog(payload.event, payload.details);
                    return;
                }
                const pending = this._pendingWorkerRequests.get(payload.requestId);
                if (!pending) {
                    return;
                }
                if (payload.type === 'update') {
                    if (pending.onUpdate) {
                        pending.onUpdate({
                            index: payload.index,
                            text: payload.text,
                            score: payload.score,
                            cached: payload.cached,
                            recognized: payload.recognized,
                            final: payload.final,
                            attemptsUsed: payload.attemptsUsed,
                        });
                    }
                    return;
                }
                if (payload.type === 'done') {
                    this._pendingWorkerRequests.delete(payload.requestId);
                    pending.resolve();
                    return;
                }
                if (payload.type === 'error') {
                    this._pendingWorkerRequests.delete(payload.requestId);
                    pending.reject(new Error(payload.message || 'Worker OCR request failed'));
                }
            };
            worker.onerror = (error) => {
                const message = String(error && error.message ? error.message : error);
                svpOcrLog('worker error', { message: message });
                for (const [requestId, pending] of this._pendingWorkerRequests.entries()) {
                    this._pendingWorkerRequests.delete(requestId);
                    pending.reject(new Error(message));
                }
                this._worker = null;
                this._readyPromise = null;
            };
            this._worker = worker;
            return worker;
        }

        _callWorker(type, payload, onUpdate) {
            const worker = this._ensureWorker();
            const requestId = ++this._workerSeq;
            return new Promise((resolve, reject) => {
                this._pendingWorkerRequests.set(requestId, {
                    resolve,
                    reject,
                    onUpdate,
                });
                worker.postMessage(Object.assign({ type: type, requestId: requestId }, payload || {}));
            });
        }

        ensureReady() {
            if (this._readyPromise) {
                svpOcrLog('ensureReady reuse-existing-promise');
                return this._readyPromise;
            }

            this._readyPromise = this._callWorker('ensureReady').then(() => {
                this._ocrInstance = { worker: true };
            }).catch((err) => {
                svpOcrLog('ensureReady failed', { message: String(err && err.message ? err.message : err), stack: err && err.stack ? String(err.stack) : null });
                this._emitStatus('OCR 初始化失败，请查看控制台', 'warning', 3600, 'ocr-init-failed');
                this._readyPromise = null;
                throw err;
            });

            return this._readyPromise;
        }

        async recognizeSupItems(supItems, onUpdate) {
            await this.ensureReady();
            if (!supItems || supItems.length === 0) return;

            svpOcrLog('recognizeSupItems start', { totalItems: supItems.length, workerMode: true });
            const payload = {
                items: supItems.map((item, index) => ({
                    index: index,
                    text: item && item.text ? item.text : '',
                    __ocrSkip: !!(item && item.__ocrSkip === true),
                    imageRawData: item && item.imageRawData ? {
                        data: item.imageRawData.data,
                        width: item.imageRawData.width,
                        height: item.imageRawData.height,
                    } : null,
                })),
            };
            await this._callWorker('recognize', payload, onUpdate);
        }
    }

    window.PaddleSubtitleOcr = new PaddleSubtitleOcrEngine();
})();
