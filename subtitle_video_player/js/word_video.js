(function (root, factory) {
    var api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.SvpWordVideo = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';
    var ENDPOINT = 'https://baidu-word-video-service-c7e3.netlify.app/v1/video';
    var CANDIDATE_PROMPT = '你是英语词形分析器，只为词汇视频检索提供候选，不做查词讲解。输入 JSON 含 query 和 sentence。' +
        '先根据句子识别 query 的用法。优先返回词典原形（包括不规则屈折还原），其次是现代英语中直接、明确、常见且核心语义相关的其他词性派生词。' +
        '最多三个，按相关性排列，去重并排除 query 本身。原形之外不要枚举时态、单复数或同词性的其他形式。' +
        '不要近义词、反义词、仅拼写相似的词、远源词根联想、合成词或增加其他实词的扩展短语。保留否定前缀的意义。' +
        '固定短语只还原其中的屈折变化并保留整个短语，不拆成单词。没有可靠候选就返回空数组，不凑数量。' +
        '严格只返回 JSON 对象：{"candidates":["英文词条"]}。不要额外字段、词性、关系标签、说明、代码围栏或视频地址。';

    function normalizeWord(value) {
        var word = String(value || '').trim().toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/\s+/g, ' ');
        return word.length <= 80 && word.split(' ').length <= 6 && /^[a-z][a-z0-9]*(?:[ '-][a-z0-9]+)*$/.test(word) ? word : '';
    }

    function httpsUrl(value) {
        if (typeof value !== 'string' || value.length > 4096) return null;
        try {
            var url = new URL(value);
            return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
        } catch (error) { return null; }
    }

    function abortError() { return new DOMException('Video lookup cancelled', 'AbortError'); }
    function checkAbort(signal) { if (signal && signal.aborted) throw signal.reason || abortError(); }

    function waitFor(promise, signal) {
        if (!signal) return promise;
        return new Promise(function (resolve, reject) {
            function abort() { reject(signal.reason || abortError()); }
            signal.addEventListener('abort', abort, { once: true });
            Promise.resolve(promise).then(resolve, reject).finally(function () { signal.removeEventListener('abort', abort); });
            if (signal.aborted) abort();
        });
    }

    async function withDeadline(task, signal, milliseconds) {
        checkAbort(signal);
        var controller = new AbortController();
        function relay() { controller.abort(signal.reason || abortError()); }
        if (signal) signal.addEventListener('abort', relay, { once: true });
        var timer = setTimeout(function () { controller.abort(new DOMException('Video lookup timed out', 'TimeoutError')); }, milliseconds);
        try { return await waitFor(Promise.resolve().then(function () { checkAbort(controller.signal); return task(controller.signal); }), controller.signal); }
        finally {
            clearTimeout(timer);
            if (signal) signal.removeEventListener('abort', relay);
        }
    }

    // These queues belong only to the attachment; the main AI queue never waits on them.
    function createLimiter(limit) {
        var active = 0, pending = [];
        function drain() {
            while (active < limit && pending.length) {
                var entry = pending.shift();
                entry.signal.removeEventListener('abort', entry.cancel);
                if (entry.signal.aborted) { entry.reject(entry.signal.reason || abortError()); continue; }
                active++;
                Promise.resolve().then(entry.task).then(entry.resolve, entry.reject).finally(function () { active--; drain(); });
            }
        }
        return function (task, signal) {
            return new Promise(function (resolve, reject) {
                if (signal.aborted) { reject(signal.reason || abortError()); return; }
                var entry = { task: task, signal: signal, resolve: resolve, reject: reject };
                entry.cancel = function () {
                    var index = pending.indexOf(entry);
                    if (index >= 0) pending.splice(index, 1);
                    reject(signal.reason || abortError());
                };
                signal.addEventListener('abort', entry.cancel, { once: true });
                pending.push(entry); drain();
            });
        };
    }

    function createCache(maximum, now) {
        var entries = new Map();
        return {
            get: function (key) {
                var entry = entries.get(key);
                if (!entry || entry.expires <= now()) { entries.delete(key); return null; }
                entries.delete(key); entries.set(key, entry);
                return entry;
            },
            set: function (key, value, ttl) {
                entries.delete(key); entries.set(key, { value: value, expires: now() + ttl });
                while (entries.size > maximum) entries.delete(entries.keys().next().value);
            },
            clear: function () { entries.clear(); }
        };
    }

    function parseCandidates(text, original) {
        if (typeof text !== 'string' || text.length > 8192) throw new Error('Invalid word candidates');
        var data = JSON.parse(text);
        if (!data || !Array.isArray(data.candidates) || data.candidates.length > 3) throw new Error('Invalid word candidates');
        var words = [];
        data.candidates.forEach(function (value) {
            if (typeof value !== 'string' || !normalizeWord(value)) throw new Error('Invalid word candidate');
            var word = normalizeWord(value);
            if (word !== original && words.indexOf(word) < 0) words.push(word);
        });
        return words;
    }

    function createService(options) {
        options = options || {};
        var fetchImpl = options.fetch || globalThis.fetch.bind(globalThis);
        var now = options.now || Date.now;
        var videos = createCache(256, now), candidates = createCache(128, now);
        var inflight = new Map(), sessions = new Map();
        var videoQueue = createLimiter(2), candidateQueue = createLimiter(1);

        async function requestVideo(word, signal) {
            return withDeadline(async function (requestSignal) {
                var url = new URL(options.endpoint || ENDPOINT);
                url.searchParams.set('word', word);
                var response = await fetchImpl(url.href, { credentials: 'omit', signal: requestSignal });
                var data = await response.json();
                if (!response.ok || !data || data.ok !== true || data.word !== word || typeof data.hasVideo !== 'boolean') throw new Error('Video service unavailable');
                if (!data.hasVideo) return null;
                var source = data.video;
                if (!source || !httpsUrl(source.videoUrl)) throw new Error('Invalid video URL');
                return {
                    videoUrl: httpsUrl(source.videoUrl),
                    coverUrl: httpsUrl(source.coverUrl) || httpsUrl(source.thumbUrl) || httpsUrl(source.feedUrl),
                    videoTime: Number.isFinite(source.videoTime) && source.videoTime >= 0 ? source.videoTime : null
                };
            }, signal, options.videoTimeoutMs || 22000);
        }

        function lookup(word, signal) {
            word = normalizeWord(word);
            if (!word) return Promise.reject(new Error('Invalid word'));
            if (signal && signal.aborted) return Promise.reject(signal.reason || abortError());
            var cached = videos.get(word);
            if (cached) return Promise.resolve(cached.value);
            var shared = inflight.get(word);
            if (!shared) {
                shared = { controller: new AbortController(), users: 0, done: false };
                inflight.set(word, shared);
                var current = shared;
                shared.promise = videoQueue(function () { return requestVideo(word, current.controller.signal); }, current.controller.signal).then(function (video) {
                    checkAbort(current.controller.signal);
                    videos.set(word, video, video ? 3600000 : 300000);
                    return video;
                }).finally(function () {
                    current.done = true;
                    if (inflight.get(word) === current) inflight.delete(word);
                });
            }
            return new Promise(function (resolve, reject) {
                shared.users++;
                var settled = false;
                function finish(callback, value) {
                    if (settled) return;
                    settled = true;
                    if (signal) signal.removeEventListener('abort', cancel);
                    shared.users--;
                    if (!shared.users && !shared.done) {
                        shared.controller.abort();
                        if (inflight.get(word) === shared) inflight.delete(word);
                    }
                    callback(value);
                }
                function cancel() { finish(reject, signal.reason || abortError()); }
                shared.promise.then(function (video) { finish(resolve, video); }, function (error) { finish(reject, error); });
                if (signal) { signal.addEventListener('abort', cancel, { once: true }); if (signal.aborted) cancel(); }
            });
        }

        async function candidateWords(input, signal) {
            var context = input.context || {};
            var backend = String(context.backendUrl || '').trim().replace(/\/+$/, '');
            if (!/^https?:\/\//i.test(backend)) throw new Error('Missing AI backend');
            var route = JSON.stringify([backend, context.provider || '', context.model || '', context.conversationId || '']);
            var sentence = String(input.sentence || '').slice(0, 1200);
            var key = JSON.stringify([route, input.word, sentence]);
            return candidateQueue(function () {
                var cached = candidates.get(key);
                if (cached) return cached.value;
                return withDeadline(async function (requestSignal) {
                    if (!sessions.has(route)) sessions.set(route, 'svp-word-video-' + now().toString(36) + '-' + Math.random().toString(36).slice(2, 10));
                    var payload = {
                        id: sessions.get(route), preserve: false, system_message: CANDIDATE_PROMPT,
                        user_message: JSON.stringify({ query: input.word, sentence: sentence })
                    };
                    if (context.provider) {
                        payload.provider = context.provider;
                        if (context.model) payload.model = context.model;
                    }
                    var response = await fetchImpl(backend + '/', {
                        method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(payload), signal: requestSignal
                    });
                    if (!response.ok) throw new Error('Word candidates unavailable');
                    var words = parseCandidates(await response.text(), input.word);
                    checkAbort(requestSignal);
                    candidates.set(key, words, 900000);
                    return words;
                }, signal, options.candidateTimeoutMs || 20000);
            }, signal);
        }

        async function resolve(input, signal, onPhase) {
            var word = normalizeWord(input.word);
            if (!word) return null;
            return withDeadline(async function (requestSignal) {
                var video = await lookup(word, requestSignal);
                if (video) return { word: word, original: word, video: video };
                var tried = new Set([word]);
                if (options.getBaseCandidates) {
                    var bases = [];
                    try { bases = await waitFor(Promise.resolve(options.getBaseCandidates(word)), requestSignal); }
                    catch (error) { checkAbort(requestSignal); }
                    for (var i = 0; i < Math.min(bases.length, 3); i++) {
                        var base = normalizeWord(bases[i]);
                        if (!base || tried.has(base)) continue;
                        tried.add(base);
                        video = await lookup(base, requestSignal);
                        if (video) return { word: base, original: word, video: video };
                    }
                }
                if (onPhase) onPhase('candidates');
                var words = await candidateWords({ word: word, sentence: input.sentence, context: input.context }, requestSignal);
                for (var j = 0; j < words.length; j++) {
                    if (tried.has(words[j])) continue;
                    video = await lookup(words[j], requestSignal);
                    if (video) return { word: words[j], original: word, video: video };
                }
                return null;
            }, signal, options.totalTimeoutMs || 45000);
        }

        return { lookup: lookup, resolve: resolve, resetCandidates: function () { sessions.clear(); candidates.clear(); } };
    }

    function createController(host, container, options) {
        options = options || {};
        var doc = container.ownerDocument, records = new Map();
        function hook(name, value) {
            try { if (options[name]) return options[name](value); }
            catch (error) { host.console.warn('单词视频回调失败:', error); }
        }
        function change(action) {
            var pinned = hook('beforeChange');
            action();
            hook('afterChange', pinned);
        }
        var viewportFrame = null, savedOverflowAnchor = '';
        function restoreViewportAnchor() {
            if (viewportFrame === null) return;
            host.cancelAnimationFrame(viewportFrame);
            viewportFrame = null;
            container.style.overflowAnchor = savedOverflowAnchor;
        }
        // User expansion owns its viewport; it must not invoke the chat's bottom-follow hook.
        function changeViewport(action, settle) {
            if (viewportFrame === null) savedOverflowAnchor = container.style.overflowAnchor;
            else host.cancelAnimationFrame(viewportFrame);
            container.style.overflowAnchor = 'none';
            try {
                action();
                var expectedScroll = container.scrollTop;
                viewportFrame = host.requestAnimationFrame(function () {
                    viewportFrame = null;
                    try { if (settle && Math.abs(container.scrollTop - expectedScroll) <= 1) settle(); }
                    finally { container.style.overflowAnchor = savedOverflowAnchor; }
                });
            } catch (error) {
                viewportFrame = null; container.style.overflowAnchor = savedOverflowAnchor;
                throw error;
            }
        }
        var service = options.service || createService({
            fetch: host.fetch.bind(host),
            getBaseCandidates: async function (word) {
                if (!host.SvpCocaRank) return [];
                var data = await host.SvpCocaRank.load();
                var words = Array.from(new Set(host.SvpCocaRank.candidates(word, data).filter(function (candidate) {
                    return candidate.surface === word && candidate.match.indexOf('regular_') === 0;
                }).map(function (candidate) { return candidate.word; })));
                // Multiple plausible bases need the sentence-aware AI request instead.
                return words.length === 1 ? words : [];
            }
        });

        function pause() { records.forEach(function (record) { if (record.video) record.video.pause(); }); }
        function releaseVideo(record) {
            record.viewportVersion = (record.viewportVersion || 0) + 1;
            record.revealOnMetadata = false;
            record.resizeVideo = null;
            if (!record.video) return;
            record.video.pause(); record.video.removeAttribute('src'); record.video.load(); record.video = null;
        }
        function disposeRecord(record) {
            record.token++;
            if (record.controller) record.controller.abort();
            releaseVideo(record);
            if (resizeObserver) resizeObserver.unobserve(record.attachment);
            records.delete(record.message);
            if (record.group.parentNode && record.group.contains(record.message)) record.group.replaceWith(record.message);
        }
        function button(label, className) {
            var node = doc.createElement('button');
            node.type = 'button'; node.className = className || ''; node.textContent = label;
            return node;
        }
        function status(record, label, retry) {
            change(function () {
                record.attachment.hidden = false;
                record.attachment.className = 'word-video-attachment word-video-status';
                record.attachment.replaceChildren();
                var text = doc.createElement('span'); text.textContent = label;
                record.attachment.appendChild(text);
                if (retry) {
                    var retryButton = button('重试', 'word-video-retry');
                    retryButton.addEventListener('click', function () { start(record); });
                    record.attachment.appendChild(retryButton);
                }
            });
        }
        function ready(record, result) {
            change(function () {
                record.state = 'ready';
                record.attachment.hidden = false;
                record.attachment.className = 'word-video-attachment';
                record.attachment.replaceChildren();
                var header = button('', 'word-video-header');
                header.setAttribute('aria-expanded', 'false');
                header.setAttribute('aria-label', '播放 ' + result.word + ' 的单词视频');
                var thumbnail = doc.createElement('span'); thumbnail.className = 'word-video-thumbnail';
                if (result.video.coverUrl) {
                    var image = doc.createElement('img');
                    image.src = result.video.coverUrl; image.alt = ''; image.loading = 'lazy';
                    image.addEventListener('error', function () { image.remove(); }, { once: true });
                    thumbnail.appendChild(image);
                }
                var play = doc.createElement('span'); play.className = 'word-video-play'; play.textContent = '▶'; play.setAttribute('aria-hidden', 'true');
                thumbnail.appendChild(play);
                var info = doc.createElement('span'); info.className = 'word-video-info';
                var title = doc.createElement('span'); title.className = 'word-video-title'; title.textContent = '单词视频 · ' + result.word;
                var subtitle = doc.createElement('span'); subtitle.className = 'word-video-subtitle';
                var seconds = result.video.videoTime;
                subtitle.textContent = '百度翻译' + (seconds === null ? '' : ' · ' + Math.floor(seconds / 60) + ':' + String(Math.floor(seconds % 60)).padStart(2, '0'));
                if (result.word !== result.original) subtitle.textContent += ' · 相关词形';
                info.append(title, subtitle);
                var toggle = doc.createElement('span'); toggle.className = 'word-video-toggle'; toggle.textContent = '播放';
                header.append(thumbnail, info, toggle);
                var stage = doc.createElement('div'); stage.className = 'word-video-stage'; stage.hidden = true;
                var video = doc.createElement('video'); record.video = video;
                video.controls = true; video.playsInline = true; video.preload = 'none';
                video.setAttribute('controlslist', 'nodownload');
                if (result.video.coverUrl) video.poster = result.video.coverUrl;
                // Baidu's CDN does not grant CORS. Native media playback must omit crossorigin.
                stage.appendChild(video);
                record.resizeVideo = function () {
                    if (stage.hidden || !record.attachment.clientWidth || !container.clientHeight) return;
                    var ratio = video.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : 16 / 9;
                    var maximumHeight = Math.max(0, Math.min(container.clientHeight * 2 / 3, container.clientHeight - header.offsetHeight - 24));
                    var width = Math.min(record.attachment.clientWidth, maximumHeight * ratio);
                    stage.style.width = Math.floor(width) + 'px';
                    stage.style.height = Math.floor(width / ratio) + 'px';
                };
                function revealVideo() {
                    if (stage.hidden || !container.contains(stage) || !container.clientHeight) return;
                    var view = container.getBoundingClientRect();
                    var top = view.top + container.clientTop + 8;
                    var bottom = view.top + container.clientTop + container.clientHeight - 8;
                    var player = stage.getBoundingClientRect(), heading = header.getBoundingClientRect();
                    var delta = player.bottom > bottom ? player.bottom - bottom : 0;
                    if (heading.top - delta < top) delta = heading.top - top;
                    if (delta) container.scrollTop += delta;
                    record.revealScrollTop = container.scrollTop;
                }
                var notice = doc.createElement('div'); notice.className = 'word-video-notice'; notice.hidden = true;
                function playbackError() {
                    notice.hidden = false; notice.textContent = '视频暂时无法播放 ';
                    var retry = button('重试播放', 'word-video-retry');
                    retry.addEventListener('click', function () { video.removeAttribute('src'); video.load(); playVideo(); });
                    notice.appendChild(retry);
                }
                function playVideo() {
                    notice.hidden = true;
                    if (!video.getAttribute('src')) video.src = result.video.videoUrl;
                    var playing = video.play();
                    if (playing && playing.catch) playing.catch(function (error) { if (error.name !== 'AbortError') playbackError(); });
                }
                video.addEventListener('play', function () {
                    records.forEach(function (other) { if (other !== record && other.video) other.video.pause(); });
                    hook('beforePlay');
                });
                video.addEventListener('loadedmetadata', function () {
                    if (record.resizeVideo) {
                        var reveal = record.revealOnMetadata && !stage.hidden && Math.abs(container.scrollTop - record.revealScrollTop) <= 1;
                        record.revealOnMetadata = false;
                        if (reveal) {
                            var version = record.viewportVersion;
                            changeViewport(function () { record.resizeVideo(); revealVideo(); }, function () {
                                if (record.viewportVersion === version) revealVideo();
                            });
                        } else record.resizeVideo();
                    }
                    if (!video.videoWidth) { notice.hidden = false; notice.textContent = '当前浏览器仅能播放音频'; }
                });
                video.addEventListener('error', playbackError);
                video.addEventListener('keydown', function (event) { if (event.key !== 'Escape') event.stopPropagation(); });
                header.addEventListener('click', function () {
                    var expanded = stage.hidden;
                    var headingTop = header.getBoundingClientRect().top;
                    var version = record.viewportVersion = (record.viewportVersion || 0) + 1;
                    record.revealOnMetadata = expanded && !video.readyState;
                    changeViewport(function () {
                        stage.hidden = !expanded;
                        record.group.classList.toggle('word-video-expanded', expanded);
                        header.setAttribute('aria-expanded', String(expanded)); toggle.textContent = expanded ? '收起' : '播放';
                        record.resizeVideo();
                        if (expanded) revealVideo();
                        else container.scrollTop += header.getBoundingClientRect().top - headingTop;
                    }, function () {
                        if (expanded && record.viewportVersion === version) revealVideo();
                    });
                    if (expanded) playVideo(); else video.pause();
                });
                record.attachment.append(header, stage, notice);
            });
        }
        function start(record) {
            if (records.get(record.message) !== record || !container.contains(record.message)) return;
            if (record.controller) record.controller.abort();
            releaseVideo(record);
            record.controller = new AbortController(); record.state = 'loading';
            var signal = record.controller.signal, token = ++record.token;
            function current() { return !signal.aborted && records.get(record.message) === record && record.token === token && container.contains(record.message); }
            status(record, '正在查找单词视频…');
            Promise.resolve().then(function () {
                return service.resolve(record.input, signal, function () { if (current()) status(record, '正在查找相关词形视频…'); });
            }).then(function (result) {
                if (!current()) return;
                record.controller = null;
                if (result) ready(record, result);
                else change(function () { record.state = 'empty'; record.attachment.hidden = true; });
            }).catch(function (error) {
                if (!current()) return;
                record.controller = null; record.state = 'error';
                status(record, '单词视频暂不可用', true);
            });
        }
        function mount(message, input) {
            if (!normalizeWord(input.word)) return;
            if (records.has(message)) disposeRecord(records.get(message));
            var group = doc.createElement('div'); group.className = 'word-video-group';
            var attachment = doc.createElement('div'); attachment.className = 'word-video-attachment';
            attachment.setAttribute('aria-live', 'polite');
            var context = input.context || {};
            var record = { message: message, group: group, attachment: attachment, token: 0, input: {
                word: normalizeWord(input.word), sentence: input.sentence,
                context: { backendUrl: context.backendUrl, provider: context.provider, model: context.model, conversationId: context.conversationId }
            } };
            change(function () { message.before(group); group.append(message, attachment); });
            records.set(message, record); start(record);
            if (resizeObserver) resizeObserver.observe(attachment);
        }
        function cancel(message) {
            var record = records.get(message);
            if (!record) return;
            record.viewportVersion = (record.viewportVersion || 0) + 1;
            record.revealOnMetadata = false;
            record.token++;
            if (record.controller) { record.controller.abort(); record.controller = null; }
            if (record.state !== 'ready') change(function () { record.attachment.hidden = true; });
        }
        function reset() {
            restoreViewportAnchor();
            records.forEach(function (record) { cancel(record.message); });
            pause(); service.resetCandidates();
        }
        var observer = new host.MutationObserver(function () {
            records.forEach(function (record) { if (!container.contains(record.message)) disposeRecord(record); });
        });
        observer.observe(container, { childList: true });
        function resizeVideos() { records.forEach(function (record) { if (record.resizeVideo) record.resizeVideo(); }); }
        var resizeObserver = host.ResizeObserver ? new host.ResizeObserver(resizeVideos) : null;
        if (resizeObserver) resizeObserver.observe(container);
        else host.addEventListener('resize', resizeVideos);
        function visibility() { if (doc.hidden) pause(); }
        doc.addEventListener('visibilitychange', visibility);
        host.addEventListener('pagehide', reset);
        if (options.mainVideo) options.mainVideo.addEventListener('play', pause);
        return {
            mount: mount, cancel: cancel, reset: reset, pause: pause,
            dispose: function () {
                restoreViewportAnchor();
                observer.disconnect();
                if (resizeObserver) resizeObserver.disconnect();
                else host.removeEventListener('resize', resizeVideos);
                records.forEach(disposeRecord);
                doc.removeEventListener('visibilitychange', visibility);
                host.removeEventListener('pagehide', reset);
                if (options.mainVideo) options.mainVideo.removeEventListener('play', pause);
            }
        };
    }

    return { normalizeWord: normalizeWord, parseCandidates: parseCandidates, createService: createService, createController: createController };
});
