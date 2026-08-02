(function (root, factory) {
    var api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    if (root) {
        root.SvpEudic = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    var API_BASE_URL = 'https://api.frdic.com/api/open/v1/studylist';

    function EudicApiError(code, message, status) {
        this.name = 'EudicApiError';
        this.code = code;
        this.message = message;
        this.status = status || 0;
        this.noteSaved = false;
        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, EudicApiError);
        }
    }
    EudicApiError.prototype = Object.create(Error.prototype);
    EudicApiError.prototype.constructor = EudicApiError;

    function normalizeWord(value) {
        return String(value || '').trim().replace(/\u2019/g, "'").toLowerCase();
    }

    function maskAuthorization(value) {
        var authorization = String(value || '').trim();
        if (!authorization) {
            return '';
        }
        if (authorization.length <= 2) {
            return authorization;
        }
        if (authorization.length <= 8) {
            return authorization.slice(0, 1)
                + '•'.repeat(authorization.length - 2)
                + authorization.slice(-1);
        }
        if (authorization.length <= 16) {
            return authorization.slice(0, 3)
                + '•'.repeat(authorization.length - 6)
                + authorization.slice(-3);
        }
        if (authorization.length <= 24) {
            return authorization.slice(0, 4)
                + '•'.repeat(authorization.length - 12)
                + authorization.slice(-8);
        }
        return authorization.slice(0, 8)
            + '•'.repeat(authorization.length - 24)
            + authorization.slice(-16);
    }

    function isSupportedWord(value) {
        return /^[a-z]+(?:'[a-z]+)*(?:-[a-z]+(?:'[a-z]+)*)*$/.test(normalizeWord(value));
    }

    function escapeMarkdownInline(value) {
        return String(value || '').replace(/([\\`*_[\]])/g, '\\$1');
    }

    function flattenContextLine(value) {
        return String(value || '').replace(/\s+/g, ' ').trim();
    }

    function findSelectionStart(sentence, selectedText, approximateStart) {
        var source = String(sentence || '');
        var selected = String(selectedText || '');
        if (!selected) {
            return -1;
        }

        var candidates = [];
        var fromIndex = 0;
        while (fromIndex <= source.length) {
            var index = source.indexOf(selected, fromIndex);
            if (index === -1) {
                break;
            }
            candidates.push(index);
            fromIndex = index + Math.max(1, selected.length);
        }

        if (!candidates.length) {
            var lowerSource = source.toLowerCase();
            var lowerSelected = selected.toLowerCase();
            fromIndex = 0;
            while (fromIndex <= lowerSource.length) {
                var lowerIndex = lowerSource.indexOf(lowerSelected, fromIndex);
                if (lowerIndex === -1) {
                    break;
                }
                candidates.push(lowerIndex);
                fromIndex = lowerIndex + Math.max(1, lowerSelected.length);
            }
        }

        if (!candidates.length) {
            return -1;
        }
        if (!Number.isFinite(approximateStart)) {
            return candidates[0];
        }
        return candidates.reduce(function (best, candidate) {
            return Math.abs(candidate - approximateStart) < Math.abs(best - approximateStart)
                ? candidate
                : best;
        }, candidates[0]);
    }

    function formatCurrentLine(sentence, selectedText, approximateStart) {
        var source = String(sentence || '').trim();
        var selected = String(selectedText || '').trim();
        var start = findSelectionStart(source, selected, approximateStart);
        if (start < 0) {
            throw new Error('无法在当前字幕中定位选中的单词');
        }
        return escapeMarkdownInline(source.slice(0, start))
            + '**'
            + escapeMarkdownInline(source.slice(start, start + selected.length))
            + '**'
            + escapeMarkdownInline(source.slice(start + selected.length));
    }

    function buildNote(options) {
        options = options || {};
        var lines = Array.isArray(options.lines) ? options.lines : [];
        var currentIndex = Number(options.currentIndex);
        if (!Number.isInteger(currentIndex) || currentIndex < 0 || currentIndex >= lines.length) {
            throw new Error('当前字幕索引无效');
        }

        return buildNoteFromContext({
            videoName: options.videoName,
            previousLine: currentIndex > 0 ? lines[currentIndex - 1] : '',
            currentLine: lines[currentIndex],
            nextLine: currentIndex + 1 < lines.length ? lines[currentIndex + 1] : '',
            selectedText: options.selectedText,
            selectionStart: options.selectionStart
        });
    }

    function buildNoteFromContext(options) {
        options = options || {};
        var context = [];
        if (options.includePrevious !== false && String(options.previousLine || '').trim()) {
            context.push(escapeMarkdownInline(flattenContextLine(options.previousLine)));
        }
        context.push(flattenContextLine(formatCurrentLine(
            String(options.currentLine || ''),
            options.selectedText,
            Number(options.selectionStart)
        )));
        if (options.includeNext !== false && String(options.nextLine || '').trim()) {
            context.push(escapeMarkdownInline(flattenContextLine(options.nextLine)));
        }

        return '**来源：**《' + escapeMarkdownInline(String(options.videoName || '未知').trim() || '未知') + '》\n'
            + context.map(function (line) {
                return '> ' + line;
            }).join('\n');
    }

    function getFetch(fetchImpl) {
        var selectedFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
        if (!selectedFetch) {
            throw new EudicApiError('fetch_unavailable', '当前环境不支持网络请求');
        }
        return selectedFetch;
    }

    async function requestJson(path, authorization, options, fetchImpl) {
        var requestOptions = Object.assign({}, options || {});
        requestOptions.headers = Object.assign({
            'Authorization': String(authorization || '').trim(),
            'Accept': 'application/json'
        }, requestOptions.headers || {});
        if (requestOptions.body !== undefined) {
            requestOptions.headers['Content-Type'] = 'application/json';
        }

        var response;
        try {
            response = await getFetch(fetchImpl)(API_BASE_URL + path, requestOptions);
        } catch (error) {
            throw new EudicApiError('network_error', '无法连接欧路词典，请检查网络后重试');
        }

        var payload = null;
        try {
            var text = await response.text();
            payload = text ? JSON.parse(text) : null;
        } catch (error) {
            if (response.ok) {
                throw new EudicApiError('invalid_response', '欧路词典返回了无法识别的数据', response.status);
            }
        }

        if (!response.ok) {
            var code = response.status === 401 || response.status === 403
                ? 'authorization_failed'
                : 'http_error';
            var message = code === 'authorization_failed'
                ? '欧路认证密钥无效或已失效'
                : '欧路词典请求失败（HTTP ' + response.status + '）';
            throw new EudicApiError(code, message, response.status);
        }
        return payload;
    }

    function isWordPayloadPresent(payload, requestedWord) {
        if (!payload) {
            return false;
        }
        var requested = normalizeWord(requestedWord);
        var candidate = Object.prototype.hasOwnProperty.call(payload, 'data') ? payload.data : payload;
        if (Array.isArray(candidate)) {
            return candidate.some(function (item) {
                return item && normalizeWord(item.word) === requested;
            });
        }
        return Boolean(candidate
            && typeof candidate === 'object'
            && typeof candidate.word === 'string'
            && normalizeWord(candidate.word) === requested);
    }

    async function validateAuthorization(authorization, fetchImpl) {
        if (!String(authorization || '').trim()) {
            throw new EudicApiError('authorization_missing', '请先输入欧路认证密钥');
        }
        await requestJson('/category?language=en', authorization, { method: 'GET' }, fetchImpl);
        return true;
    }

    async function getWord(authorization, word, fetchImpl) {
        var normalized = normalizeWord(word);
        var path = '/word?language=en&word=' + encodeURIComponent(normalized);
        try {
            var payload = await requestJson(path, authorization, { method: 'GET' }, fetchImpl);
            return isWordPayloadPresent(payload, normalized) ? payload : null;
        } catch (error) {
            if (error && error.status === 404) {
                return null;
            }
            throw error;
        }
    }

    async function saveNote(authorization, word, note, fetchImpl) {
        return requestJson('/note', authorization, {
            method: 'POST',
            body: JSON.stringify({
                language: 'en',
                word: normalizeWord(word),
                note: String(note || '')
            })
        }, fetchImpl);
    }

    async function addWord(authorization, word, fetchImpl) {
        return requestJson('/word', authorization, {
            method: 'POST',
            body: JSON.stringify({
                language: 'en',
                word: normalizeWord(word)
            })
        }, fetchImpl);
    }

    async function submitWord(options) {
        options = options || {};
        var authorization = String(options.authorization || '').trim();
        var word = normalizeWord(options.word);
        if (!authorization) {
            throw new EudicApiError('authorization_missing', '请先配置欧路认证密钥');
        }
        if (!isSupportedWord(word)) {
            throw new EudicApiError('invalid_word', '请选择一个完整的英文单词');
        }

        var existing = await getWord(authorization, word, options.fetchImpl);
        if (existing) {
            return { status: 'duplicate', word: word };
        }

        await saveNote(authorization, word, options.note, options.fetchImpl);
        try {
            await addWord(authorization, word, options.fetchImpl);
        } catch (error) {
            error.noteSaved = true;
            throw error;
        }
        return { status: 'created', word: word };
    }

    return {
        API_BASE_URL: API_BASE_URL,
        EudicApiError: EudicApiError,
        maskAuthorization: maskAuthorization,
        normalizeWord: normalizeWord,
        isSupportedWord: isSupportedWord,
        findSelectionStart: findSelectionStart,
        formatCurrentLine: formatCurrentLine,
        buildNote: buildNote,
        buildNoteFromContext: buildNoteFromContext,
        normalizeContextLine: flattenContextLine,
        isWordPayloadPresent: isWordPayloadPresent,
        validateAuthorization: validateAuthorization,
        getWord: getWord,
        saveNote: saveNote,
        addWord: addWord,
        submitWord: submitWord
    };
});
