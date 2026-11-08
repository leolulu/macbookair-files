// Worker-side OCR runtime for SUP bitmap subtitles.

(function () {
    'use strict';

    let readyPromise = null;
    let ocrModule = null;
    let ocrInstance = null;
    const textCache = new Map();

    function resolveUrl(relativePath) {
        return new URL(relativePath, self.location.href).toString();
    }

    function post(type, payload) {
        self.postMessage(Object.assign({ type: type }, payload || {}));
    }

    function log(event, details) {
        post('log', { event: event, details: details });
    }

    function status(message, level, durationMs, dedupeKey) {
        post('status', {
            message: message,
            level: level || 'info',
            durationMs: durationMs,
            dedupeKey: dedupeKey || message,
        });
    }

    function yieldToWorker(timeoutMs) {
        timeoutMs = typeof timeoutMs === 'number' ? timeoutMs : 16;
        return new Promise(function (resolve) {
            setTimeout(resolve, timeoutMs);
        });
    }

    function withTimeout(promise, timeoutMs, label) {
        return Promise.race([
            promise,
            new Promise(function (_, reject) {
                setTimeout(function () {
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
                timer = setTimeout(function () { controller.abort(); }, timeoutMs);
            }
            const response = await fetch(url, controller ? { signal: controller.signal } : undefined);
            if (!response.ok) {
                throw new Error('Failed to fetch ' + url + ' (' + response.status + ')');
            }
            return await response.text();
        } catch (error) {
            if (error && error.name === 'AbortError') {
                throw new Error('fetch timed out after ' + timeoutMs + 'ms: ' + url);
            }
            throw error;
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

    function postprocessSubtitleText(text) {
        if (!text) return '';
        let value = String(text);
        value = value.replace(/\r\n/g, '\n');
        value = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
        value = value.replace(/\s+$/g, '');
        value = value.replace(/^\s+/g, '');
        value = value.replace(/[ \t]+/g, ' ');
        value = value.replace(/\n\s+/g, '\n');
        return value.trim();
    }

    function createImageDataLike(data, width, height) {
        if (typeof ImageData === 'function') {
            return new ImageData(data, width, height);
        }
        return { data: data, width: width, height: height };
    }

    function addWhiteBorder(imageData, padding) {
        const width = imageData.width + padding * 2;
        const height = imageData.height + padding * 2;
        const data = new Uint8ClampedArray(width * height * 4).fill(255);
        const rowBytes = imageData.width * 4;
        for (let y = 0; y < imageData.height; y++) {
            const start = y * rowBytes;
            const offset = ((y + padding) * width + padding) * 4;
            data.set(imageData.data.subarray(start, start + rowBytes), offset);
        }
        return createImageDataLike(data, width, height);
    }

    function normalizeLightSubtitle(imageData) {
        const { data, width, height } = imageData;
        const rowBytes = width * 4;
        let hasTransparency = false;
        let hasLightInk = false;
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const pixel = y * rowBytes + x * 4;
                const alpha = pixel + 3;
                if (data[alpha] === 0) {
                    hasTransparency = true;
                    continue;
                }
                const gray = data[pixel];
                if (gray !== data[pixel + 1] || gray !== data[pixel + 2]) return null;
                if (gray >= 112 && data[alpha] >= 128) hasLightInk = true;

                // Light pixels at the silhouette can be an outline around dark lettering.
                if (gray > 64 && (x === 0 || x === width - 1 || y === 0 || y === height - 1
                    || data[alpha - 4] === 0 || data[alpha + 4] === 0
                    || data[alpha - rowBytes] === 0 || data[alpha + rowBytes] === 0)) return null;
            }
        }
        if (!hasTransparency || !hasLightInk) return null;

        const normalized = new Uint8ClampedArray(data.length);
        for (let i = 0; i < data.length; i += 4) {
            const ink = Math.max(0, Math.min(255, (data[i] - 24) * 2.2));
            const gray = 255 - ink * (data[i + 3] / 255);
            normalized[i] = normalized[i + 1] = normalized[i + 2] = gray;
            normalized[i + 3] = 255;
        }
        return createImageDataLike(normalized, width, height);
    }

    function expandClippedLeft(image, box) {
        const { data, width } = image;
        const [topLeft, topRight, bottomRight, bottomLeft] = box;
        const left = topLeft[0];
        const top = topLeft[1];
        const bottom = bottomLeft[1];
        if (left < 1 || left >= width || left !== bottomLeft[0]) return null;

        const lineHeight = bottom - top;
        const minCrossingRows = Math.ceil(lineHeight * 0.8);
        const hasInk = (x, y) => data[(y * width + x) * 4] <= 128;
        let crossingRows = 0;
        for (let y = top; y < bottom; y++) {
            crossingRows = hasInk(left, y) && hasInk(left - 1, y) ? crossingRows + 1 : 0;
            if (crossingRows >= minCrossingRows) break;
        }
        if (crossingRows < minCrossingRows) return null;

        // A blank gap close to the edge separates the clipped stroke from the next glyph.
        const gapWidth = Math.ceil(lineHeight / 7);
        const maxStrokeWidth = Math.ceil(lineHeight / 4);
        const end = Math.min(topRight[0], left + maxStrokeWidth + gapWidth);
        let blankColumns = 0;
        for (let x = left + 1; x < end; x++) {
            let blank = true;
            for (let y = top; y < bottom; y++) {
                if (hasInk(x, y)) {
                    blank = false;
                    break;
                }
            }
            blankColumns = blank ? blankColumns + 1 : 0;
            if (blankColumns >= gapWidth) {
                const expanded = Math.max(0, left - 4);
                return [[expanded, top], topRight, bottomRight, [expanded, bottom]];
            }
        }
        return null;
    }

    function upscaleImageData(imageData, scale) {
        if (!imageData || !imageData.data || !imageData.width || !imageData.height || scale <= 1) {
            return imageData;
        }
        if (typeof OffscreenCanvas === 'function') {
            const sourceCanvas = new OffscreenCanvas(imageData.width, imageData.height);
            const sourceCtx = sourceCanvas.getContext('2d');
            const targetCanvas = new OffscreenCanvas(imageData.width * scale, imageData.height * scale);
            const targetCtx = targetCanvas.getContext('2d');
            if (sourceCtx && targetCtx) {
                sourceCtx.putImageData(createImageDataLike(new Uint8ClampedArray(imageData.data), imageData.width, imageData.height), 0, 0);
                targetCtx.imageSmoothingEnabled = false;
                targetCtx.drawImage(sourceCanvas, 0, 0, targetCanvas.width, targetCanvas.height);
                return targetCtx.getImageData(0, 0, targetCanvas.width, targetCanvas.height);
            }
        }

        const scaledWidth = imageData.width * scale;
        const scaledHeight = imageData.height * scale;
        const out = new Uint8ClampedArray(scaledWidth * scaledHeight * 4);
        for (let y = 0; y < scaledHeight; y++) {
            const srcY = Math.min(imageData.height - 1, Math.floor(y / scale));
            for (let x = 0; x < scaledWidth; x++) {
                const srcX = Math.min(imageData.width - 1, Math.floor(x / scale));
                const srcIdx = (srcY * imageData.width + srcX) * 4;
                const dstIdx = (y * scaledWidth + x) * 4;
                out[dstIdx] = imageData.data[srcIdx];
                out[dstIdx + 1] = imageData.data[srcIdx + 1];
                out[dstIdx + 2] = imageData.data[srcIdx + 2];
                out[dstIdx + 3] = imageData.data[srcIdx + 3];
            }
        }
        return createImageDataLike(out, scaledWidth, scaledHeight);
    }

    function thresholdImageData(imageData, threshold) {
        if (!imageData || !imageData.data || !imageData.width || !imageData.height) {
            return imageData;
        }
        const out = new Uint8ClampedArray(imageData.data.length);
        threshold = typeof threshold === 'number' ? threshold : 180;
        for (let i = 0; i < imageData.data.length; i += 4) {
            const gray = Math.round(imageData.data[i] * 0.299 + imageData.data[i + 1] * 0.587 + imageData.data[i + 2] * 0.114);
            const value = gray >= threshold ? 255 : 0;
            out[i] = value;
            out[i + 1] = value;
            out[i + 2] = value;
            out[i + 3] = 255;
        }
        return createImageDataLike(out, imageData.width, imageData.height);
    }

    async function recognizeOcrInput(ocrInput) {
        const result = await ocrInstance.ocr(ocrInput);
        const paragraphs = result && result.parragraphs ? result.parragraphs : [];
        const textRaw = paragraphs.map(function (paragraph) {
            return paragraph && paragraph.text ? String(paragraph.text) : '';
        }).filter(Boolean).join('\n');
        const score = paragraphs.length
            ? (paragraphs.reduce(function (sum, paragraph) {
                return sum + (paragraph && typeof paragraph.mean === 'number' ? paragraph.mean : 0);
            }, 0) / paragraphs.length)
            : 0;
        return {
            text: postprocessSubtitleText(textRaw),
            score: score,
        };
    }

    async function recognizeItemWithRetries(imageData, rawImageData) {
        const baseImage = createImageDataLike(new Uint8ClampedArray(imageData.data), imageData.width, imageData.height);
        const highContrastImage = normalizeLightSubtitle(rawImageData);
        let enlargedImage;
        const getEnlargedImage = () => (enlargedImage ??= upscaleImageData(baseImage, 2));
        const attempts = [
            () => addWhiteBorder(baseImage, 32),
            () => baseImage,
            getEnlargedImage,
            () => thresholdImageData(getEnlargedImage(), 180),
        ];
        if (highContrastImage) {
            attempts.unshift(() => {
                const input = addWhiteBorder(highContrastImage, 32);
                input.__svpExpandClippedLeft = true;
                return input;
            });
        }

        let best = { recognized: false, text: '', score: 0, attemptsUsed: 0 };
        let lastError = null;

        for (let i = 0; i < attempts.length; i++) {
            try {
                const current = await recognizeOcrInput(attempts[i]());
                if (current.text) {
                    return {
                        recognized: true,
                        text: current.text,
                        score: current.score,
                        attemptsUsed: i + 1,
                    };
                }
                if (current.score >= best.score) {
                    best = {
                        recognized: false,
                        text: '',
                        score: current.score,
                        attemptsUsed: i + 1,
                    };
                }
            } catch (error) {
                lastError = error;
            }
            await yieldToWorker(8);
        }

        if (lastError) {
            throw lastError;
        }
        return best;
    }

    async function loadScriptOnce(url) {
        log('loadScriptOnce start', { url: url });
        self.importScripts(url);
        log('loadScriptOnce done', { url: url });
    }

    async function loadEsearchOcrModule() {
        if (ocrModule) {
            log('loadEsearchOcrModule cache-hit');
            return ocrModule;
        }
        const sourceUrl = resolveUrl('../../assets/vendor/esearch-ocr/esearch-ocr.js');
        log('loadEsearchOcrModule fetch start', { url: sourceUrl });
        const source = await fetchTextWithTimeout(sourceUrl, 30000);
        log('loadEsearchOcrModule fetch done', { length: source.length });
        const detect = 'const X = Vi(_.data, _.dims[3], _.dims[2], n);';
        const region = 'c.push({ box: k, img: q, style: { bg: H, text: z } });';
        // Carry the per-input option through detection and widen only the recognition image.
        const patched = source
            .replace(detect, 'if (f.__svpExpandClippedLeft) n.__svpExpandClippedLeft = true;\n  ' + detect)
            .replace(region, [
                'const expanded = m.__svpExpandClippedLeft ? expandClippedLeft(m, E) : null;',
                'c.push({ box: k, img: expanded ? $i(m, expanded) : q, style: { bg: H, text: z } });',
            ].join('\n    '))
            .replace(/export\s*\{[\s\S]*?\};?\s*$/, () => expandClippedLeft.toString() + '\nself.__svpEsearchOcr = { det: me, init: hn, ocr: Hi, rec: Pe };');
        if (!patched.includes('self.__svpEsearchOcr')) {
            throw new Error('Failed to patch esearch-ocr worker export');
        }
        self.__svpEsearchOcr = null;
        log('loadEsearchOcrModule eval start');
        (0, eval)(patched);
        if (!self.__svpEsearchOcr || typeof self.__svpEsearchOcr.init !== 'function') {
            throw new Error('Failed to initialize esearch-ocr worker module');
        }
        ocrModule = self.__svpEsearchOcr;
        log('loadEsearchOcrModule eval done');
        return ocrModule;
    }

    async function waitForOpenCvReady(timeoutMs) {
        timeoutMs = typeof timeoutMs === 'number' ? timeoutMs : 30000;
        const start = Date.now();
        log('waitForOpenCvReady enter', { timeoutMs: timeoutMs, hasCv: !!self.cv });

        function isPromiseLike(value) {
            return !!value && (typeof value === 'object' || typeof value === 'function') && typeof value.then === 'function';
        }

        function isReady(cvObj) {
            if (!cvObj) return false;
            const hasMat = typeof cvObj.matFromImageData === 'function';
            const hasCtor = typeof cvObj.Mat === 'function';
            const calledRunReady = cvObj.calledRun === true;
            const noCalledRunInfo = typeof cvObj.calledRun === 'undefined';
            return hasMat && hasCtor && (calledRunReady || noCalledRunInfo);
        }

        while (Date.now() - start <= timeoutMs) {
            let cvObj = self.cv;
            log('waitForOpenCvReady check', {
                isPromiseLike: isPromiseLike(cvObj),
                hasMat: !!(cvObj && typeof cvObj.matFromImageData === 'function'),
                hasMatCtor: !!(cvObj && typeof cvObj.Mat === 'function'),
                calledRun: cvObj && typeof cvObj.calledRun !== 'undefined' ? cvObj.calledRun : '(missing)',
            });
            if (isReady(cvObj)) {
                log('waitForOpenCvReady ready-before-promise', { elapsedMs: Date.now() - start });
                return { cv: cvObj };
            }
            if (isPromiseLike(cvObj)) {
                log('waitForOpenCvReady promise-like pending');
            }
            if (isReady(cvObj)) {
                log('waitForOpenCvReady ready', { elapsedMs: Date.now() - start });
                return { cv: cvObj };
            }
            await yieldToWorker(16);
        }

        throw new Error('OpenCV runtime did not become ready in worker');
    }

    async function ensureReady() {
        if (readyPromise) {
            log('ensureReady reuse-existing-promise');
            return readyPromise;
        }

        readyPromise = (async function () {
            log('ensureReady start');
            status('正在加载本地 OCR 运行时...', 'info', 2600, 'ocr-runtime-start');
            await yieldToWorker(16);

            await loadScriptOnce(resolveUrl('../../assets/vendor/ort/ort.min.js'));
            log('ensureReady ort ready', { hasOrt: !!self.ort });
            if (!self.ort) {
                throw new Error('ONNX Runtime failed to load in worker');
            }

            await loadScriptOnce(resolveUrl('../../assets/vendor/opencv/opencv.js'));
            log('ensureReady opencv global present', { hasCv: !!self.cv });
            status('正在准备 OCR 识别模块...', 'info', 2400, 'ocr-module-start');
            await yieldToWorker(16);

            const module = await loadEsearchOcrModule();
            log('ensureReady esearch ready', { hasInit: !!(module && module.init) });
            status('正在初始化图像处理能力...', 'info', 2400, 'ocr-opencv-ready');
            const cvReady = await waitForOpenCvReady(30000);
            const cv = cvReady.cv;
            log('ensureReady opencv ready', { hasCv: !!cv });

            if (self.ort && self.ort.env && self.ort.env.wasm) {
                self.ort.env.wasm.wasmPaths = resolveUrl('../../assets/vendor/ort/')
                    .replace(/ort\/$/, 'ort/');
                self.ort.env.wasm.numThreads = 1;
                self.ort.env.wasm.proxy = false;
                self.ort.env.wasm.initTimeout = 30000;
            }
            log('ensureReady ort wasm env set', {
                wasmPaths: self.ort && self.ort.env && self.ort.env.wasm ? self.ort.env.wasm.wasmPaths : null,
                numThreads: self.ort && self.ort.env && self.ort.env.wasm ? self.ort.env.wasm.numThreads : null,
                proxy: self.ort && self.ort.env && self.ort.env.wasm ? self.ort.env.wasm.proxy : null,
                initTimeout: self.ort && self.ort.env && self.ort.env.wasm ? self.ort.env.wasm.initTimeout : null,
            });

            status('正在加载 OCR 模型与字典...', 'info', 2800, 'ocr-dict-start');
            await yieldToWorker(16);
            const dicText = await fetchTextWithTimeout(resolveUrl('../../assets/ocr/esearch/ch/ppocr_keys_v1.txt'), 15000);
            log('ensureReady dictionary loaded', { length: dicText.length });

            status('正在初始化 Paddle OCR 模型，首次可能较慢...', 'info', 3400, 'ocr-model-init');
            await yieldToWorker(16);
            log('ensureReady init start');
            ocrInstance = await withTimeout(module.init({
                ort: self.ort,
                detPath: resolveUrl('../../assets/ocr/esearch/ch/ppocr_det.onnx'),
                recPath: resolveUrl('../../assets/ocr/esearch/ch/ppocr_rec.onnx'),
                dic: dicText,
                imgh: 48,
                dev: false,
                ortOption: {
                    executionProviders: ['wasm'],
                },
                cv: cv,
                canvas: function (width, height) {
                    if (typeof OffscreenCanvas === 'function') {
                        return new OffscreenCanvas(width, height);
                    }
                    throw new Error('OffscreenCanvas is not available in OCR worker');
                },
                imageData: function (data, width, height) {
                    if (typeof ImageData === 'function') {
                        return new ImageData(data, width, height);
                    }
                    return { data: data, width: width, height: height };
                },
            }), 120000, 'OCR model initialization');
            log('ensureReady init done', { hasOcrInstance: !!ocrInstance });

            status('Paddle OCR 已就绪，开始转换字幕', 'success', 2600, 'ocr-ready');
            log('ensureReady done');
        })().catch(function (error) {
            log('ensureReady failed', { message: String(error && error.message ? error.message : error), stack: error && error.stack ? String(error.stack) : null });
            readyPromise = null;
            ocrInstance = null;
            status('OCR 初始化失败，请查看控制台', 'warning', 3600, 'ocr-init-failed');
            throw error;
        });

        return readyPromise;
    }

    function emitProgressStatus(batchId, completed, total, forceFinal) {
        if (!total || total <= 0) {
            return;
        }
        let bucket;
        if (forceFinal || completed >= total) {
            bucket = 'done';
        } else if (completed <= 1) {
            bucket = 'start';
        } else {
            bucket = 'p' + Math.floor((completed / total) * 5);
        }
        status(
            completed >= total ? ('字幕 OCR 识别完成 ' + total + '/' + total) : ('正在识别第 ' + completed + '/' + total + ' 条字幕'),
            completed >= total ? 'success' : 'info',
            completed >= total ? 1800 : 1400,
            'ocr-progress:' + batchId + ':' + bucket
        );
    }

    async function recognizeItems(items, requestId) {
        await ensureReady();
        if (!items || items.length === 0) {
            return;
        }

        let totalPending = 0;
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            if (!item || item.__ocrSkip === true || !item.imageRawData || !item.imageRawData.data) {
                continue;
            }
            const hash = fnv1a32(item.imageRawData.data);
            if (textCache.has(hash)) {
                continue;
            }
            totalPending++;
        }

        const batchId = Date.now();
        let completedPending = 0;

        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            if (item && item.__ocrSkip === true) {
                if (item.text && typeof item.text === 'string' && !item.text.includes('<img')) {
                    post('update', { requestId: requestId, index: item.index, text: item.text, score: 1, cached: true });
                }
                continue;
            }
            if (!item || !item.imageRawData || !item.imageRawData.data) {
                continue;
            }

            const bytes = item.imageRawData.data;
            const hash = fnv1a32(bytes);
            if (textCache.has(hash)) {
                const cachedResult = textCache.get(hash);
                post('update', {
                    requestId: requestId,
                    index: item.index,
                    text: cachedResult && cachedResult.text ? cachedResult.text : '',
                    score: cachedResult && typeof cachedResult.score === 'number' ? cachedResult.score : 0,
                    cached: true,
                    recognized: !!(cachedResult && cachedResult.recognized),
                    final: true,
                    attemptsUsed: cachedResult && typeof cachedResult.attemptsUsed === 'number' ? cachedResult.attemptsUsed : 0,
                });
                continue;
            }

            const filled = new Uint8ClampedArray(bytes.length);
            for (let p = 0; p < bytes.length; p += 4) {
                const alpha = bytes[p + 3];
                if (alpha === 0) {
                    filled[p] = 255;
                    filled[p + 1] = 255;
                    filled[p + 2] = 255;
                    filled[p + 3] = 255;
                } else {
                    filled[p] = bytes[p];
                    filled[p + 1] = bytes[p + 1];
                    filled[p + 2] = bytes[p + 2];
                    filled[p + 3] = 255;
                }
            }

            const ocrInput = createImageDataLike(filled, item.imageRawData.width, item.imageRawData.height);
            const recognizedResult = await recognizeItemWithRetries(ocrInput, item.imageRawData);

            textCache.set(hash, recognizedResult);
            completedPending++;
            emitProgressStatus(batchId, completedPending, totalPending, completedPending >= totalPending);
            post('update', {
                requestId: requestId,
                index: item.index,
                text: recognizedResult.text,
                score: recognizedResult.score,
                cached: false,
                recognized: recognizedResult.recognized,
                final: true,
                attemptsUsed: recognizedResult.attemptsUsed,
            });
            await yieldToWorker(16);
        }
    }

    self.onmessage = async function (event) {
        const message = event.data || {};
        const requestId = message.requestId;
        try {
            if (message.type === 'ensureReady') {
                await ensureReady();
                post('done', { requestId: requestId });
                return;
            }
            if (message.type === 'recognize') {
                await recognizeItems(message.items || [], requestId);
                post('done', { requestId: requestId });
                return;
            }
            throw new Error('Unknown worker message type: ' + message.type);
        } catch (error) {
            post('error', {
                requestId: requestId,
                message: String(error && error.message ? error.message : error),
                stack: error && error.stack ? String(error.stack) : null,
            });
        }
    };
})();
