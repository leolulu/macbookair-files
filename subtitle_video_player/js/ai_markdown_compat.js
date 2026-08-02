(function (root, factory) {
    var api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    if (root) {
        root.SvpAiMarkdownCompat = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    // Marked 遵循 CommonMark 的左右侧边界规则。当前一个字符是文字/数字、强调标记后
    // 紧跟引号等标点时，例如“中文**“内容”**”，标记不会被视为有效的开启符。
    // 这里只解释完整且意图明确的“强调标记 + 成对标点”结构；原文、提示词与流式累计
    // 缓冲均不改写。新增兼容标点时集中扩展此表，避免在渲染链路散落特例正则。
    var PUNCTUATION_PAIRS = [
        ['“', '”'], ['‘', '’'], ['「', '」'], ['『', '』'],
        ['"', '"'], ["'", "'"], ['《', '》'], ['〈', '〉'],
        ['（', '）'], ['【', '】'], ['〔', '〕']
    ];

    var DELIMITERS = [
        { marker: '***', kind: 'strong-em' },
        { marker: '___', kind: 'strong-em' },
        { marker: '**', kind: 'strong' },
        { marker: '__', kind: 'strong' },
        { marker: '~~', kind: 'del' },
        { marker: '*', kind: 'em' },
        { marker: '_', kind: 'em' }
    ];

    var LETTER_OR_NUMBER = /[\p{L}\p{N}]$/u;

    function previousSourceChar(tokens) {
        if (!tokens.length) {
            return '';
        }
        var raw = String(tokens[tokens.length - 1].raw || '');
        var characters = Array.from(raw);
        return characters.length ? characters[characters.length - 1] : '';
    }

    function markerWasEscaped(tokens, marker) {
        if (!tokens.length) {
            return false;
        }
        var previous = tokens[tokens.length - 1];
        return previous.type === 'escape' && String(previous.raw || '').slice(-1) === marker.charAt(0);
    }

    function findCandidate(src, tokens) {
        var previousChar = previousSourceChar(tokens);
        if (!LETTER_OR_NUMBER.test(previousChar)) {
            return null;
        }

        for (var delimiterIndex = 0; delimiterIndex < DELIMITERS.length; delimiterIndex += 1) {
            var delimiter = DELIMITERS[delimiterIndex];
            var marker = delimiter.marker;
            if (src.indexOf(marker) !== 0 || markerWasEscaped(tokens, marker)) {
                continue;
            }

            var afterMarker = src.slice(marker.length);
            for (var pairIndex = 0; pairIndex < PUNCTUATION_PAIRS.length; pairIndex += 1) {
                var pair = PUNCTUATION_PAIRS[pairIndex];
                var opening = pair[0];
                var closing = pair[1];
                if (afterMarker.indexOf(opening) !== 0) {
                    continue;
                }

                var contentStart = opening.length;
                var closingSequence = closing + marker;
                var closingIndex = afterMarker.indexOf(closingSequence, contentStart);
                if (closingIndex < 0) {
                    return null;
                }

                var inner = afterMarker.slice(contentStart, closingIndex);
                var rawLength = marker.length + closingIndex + closingSequence.length;
                var nextChar = src.charAt(rawLength);
                if (!inner || /\r|\n/.test(inner) || /^\s|\s$/.test(inner) || nextChar === marker.charAt(0)) {
                    return null;
                }

                return {
                    raw: src.slice(0, rawLength),
                    text: opening + inner + closing,
                    kind: delimiter.kind
                };
            }
        }
        return null;
    }

    function renderCompatibleEmphasis(token, parser) {
        var content = parser.parseInline(token.tokens);
        if (token.kind === 'strong') {
            return '<strong>' + content + '</strong>';
        }
        if (token.kind === 'em') {
            return '<em>' + content + '</em>';
        }
        if (token.kind === 'del') {
            return '<del>' + content + '</del>';
        }
        return '<strong><em>' + content + '</em></strong>';
    }

    function createExtension() {
        return {
            name: 'svpQuotedEmphasis',
            level: 'inline',
            start: function (src) {
                var match = src.match(/[*_~]/);
                return match ? match.index : undefined;
            },
            tokenizer: function (src, tokens) {
                // 扩展执行顺序早于 Marked 的默认 tokenizer，因此显式避开原始 HTML
                // 的 pre/code/kbd/script 内容；反引号代码和围栏代码由 Marked 先行分块。
                if (this.lexer.state.inRawBlock) {
                    return false;
                }
                var candidate = findCandidate(src, tokens);
                if (!candidate) {
                    return false;
                }
                return {
                    type: 'svpQuotedEmphasis',
                    raw: candidate.raw,
                    text: candidate.text,
                    kind: candidate.kind,
                    tokens: this.lexer.inlineTokens(candidate.text)
                };
            },
            renderer: function (token) {
                return renderCompatibleEmphasis(token, this.parser);
            },
            childTokens: ['tokens']
        };
    }

    function install(markedApi) {
        if (!markedApi || typeof markedApi.use !== 'function') {
            throw new TypeError('SvpAiMarkdownCompat.install requires a Marked instance');
        }
        markedApi.use({ extensions: [createExtension()] });
    }

    return {
        createExtension: createExtension,
        install: install
    };
});
