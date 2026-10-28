(function (root, factory) {
    var api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.SvpPosHighlight = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    // 查词回答里的词性英语简写。只认白名单内的小写缩写，避免把 e.g.、etc.、No.、vs.
    // 这类普通英文缩写一起染红；需要新增词性时在此追加即可。
    var ABBREVIATIONS = ['adj', 'adv', 'art', 'aux', 'compar', 'conj', 'det', 'interj',
        'n', 'num', 'phr', 'pl', 'prep', 'pron', 'sing', 'superl', 'v', 'vi', 'vt'];

    // 左侧不能贴着拉丁字母、数字或点（排除网址与 e.g. 之类的连续缩写），右侧不能
    // 紧接拉丁字母、数字或点；中文字符不算边界，兼容“作vt.表示”这种无空格写法。
    var PATTERN = new RegExp('(^|[^A-Za-z0-9.])(' + ABBREVIATIONS.slice().sort(function (a, b) {
        return b.length - a.length;
    }).join('|') + ')\\.(?![A-Za-z0-9.])', 'g');

    // 把纯文本切成普通片段与词性缩写片段，供 DOM 装饰和单元测试共用。
    function segments(text) {
        var value = String(text || '');
        var parts = [];
        var cursor = 0;
        PATTERN.lastIndex = 0;
        var match;
        while ((match = PATTERN.exec(value)) !== null) {
            var start = match.index + match[1].length;
            var end = start + match[2].length + 1;
            if (start > cursor) parts.push({ text: value.slice(cursor, start), pos: false });
            parts.push({ text: value.slice(start, end), pos: true });
            cursor = end;
            PATTERN.lastIndex = end;
        }
        if (cursor < value.length) parts.push({ text: value.slice(cursor), pos: false });
        return parts;
    }

    // AI 回答是流式重渲染的，每次渲染后重新装饰文本节点；代码、链接和已有装饰
    // 内部不改，重复调用也只会选中新节点。
    function decorate(container) {
        var doc = container && container.ownerDocument;
        if (!doc || typeof doc.createTreeWalker !== 'function') return 0;
        var walker = doc.createTreeWalker(container, 4);
        var nodes = [];
        var current;
        while ((current = walker.nextNode())) nodes.push(current);
        var changed = 0;
        nodes.forEach(function (textNode) {
            var parent = textNode.parentElement;
            if (!parent || !parent.closest || parent.closest('pre, code, a, .ai-pos-abbr')) return;
            var parts = segments(textNode.nodeValue);
            if (!parts.some(function (part) { return part.pos; })) return;
            var fragment = doc.createDocumentFragment();
            parts.forEach(function (part) {
                if (!part.pos) {
                    fragment.appendChild(doc.createTextNode(part.text));
                    return;
                }
                var span = doc.createElement('span');
                span.className = 'ai-pos-abbr';
                span.textContent = part.text;
                fragment.appendChild(span);
                changed += 1;
            });
            parent.replaceChild(fragment, textNode);
        });
        return changed;
    }

    return { segments: segments, decorate: decorate };
});
