(function (root, factory) {
    var api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.SvpLookupSpeech = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    // Only explicit speech references authorize buttons; emphasis remains purely visual.
    function spokenText(value) {
        var text = String(value || '').trim().replace(/\s+/g, ' ');
        if (text.length > 80 || !/^[a-z]+(?:['’\-][a-z]+)*(?: [a-z]+(?:['’\-][a-z]+)*){0,5}$/i.test(text)) return '';
        return text;
    }

    function chooseVoice(voices) {
        var english = voices.filter(function (voice) { return /^en(?:[-_]|$)/i.test(voice.lang); });
        var american = english.filter(function (voice) { return /^en[-_]US$/i.test(voice.lang); });
        var choices = american.length ? american : english;
        return choices.find(function (voice) { return voice.default; }) || choices[0] || null;
    }

    function extract(value) {
        var source = String(value || '');
        var references = [];
        var text = '';
        var cursor = 0;
        // Also remove malformed, single-bracket and unfinished references, but never execute them.
        var pattern = /\[{1,2}SPEAK(?=[:\s\]]|$)(?:[^\[\]]*\]{1,2}|[a-z0-9: '’\-\t]*)/gi;
        var match;
        while ((match = pattern.exec(source))) {
            text += source.slice(cursor, match.index);
            var valid = /^\[\[SPEAK:([^\]\r\n]+)\]\]$/i.exec(match[0]);
            var word = valid && spokenText(valid[1]);
            if (word && references.length < 12) references.push({ text: word, before: text });
            cursor = pattern.lastIndex;
        }
        text += source.slice(cursor);
        ['[[SPEAK:', '[SPEAK:'].forEach(function (prefix) {
            for (var length = prefix.length; length > 0; length--) {
                if (text.toUpperCase().endsWith(prefix.slice(0, length))) {
                    text = text.slice(0, -length);
                    break;
                }
            }
        });
        return { text: text, references: references };
    }

    function wordMatches(text, word) {
        var escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+');
        var pattern = new RegExp(escaped, 'gi');
        var matches = [];
        var match;
        while ((match = pattern.exec(text))) {
            var left = text.slice(0, match.index);
            var right = text.slice(pattern.lastIndex);
            if (/[a-z](?:['’\-])?$/i.test(left) || /^(?:['’\-])?[a-z]/i.test(right)) continue;
            matches.push({ start: match.index, end: pattern.lastIndex });
        }
        return matches;
    }

    // Match the occurrence immediately preceding the marker, even when earlier mentions exist.
    // Parsing only marker prefixes counts rendered words rather than Markdown URLs/attributes.
    function locateReference(plainText, prefix, word) {
        if (!spokenText(word)) return null;
        var before = wordMatches(prefix, word);
        if (!before.length || !/^[\s*_`“”‘’"「」『』]*$/.test(prefix.slice(before[before.length - 1].end))) return null;
        return wordMatches(plainText, word)[before.length - 1] || null;
    }

    function createController(host, container, options) {
        options = options || {};
        var synth = host.speechSynthesis;
        var supported = !!(synth && host.SpeechSynthesisUtterance);
        var buttonWords = new WeakMap();
        var active = null;
        var timeout = null;
        var voices = [];

        function refreshVoices() {
            try { voices = synth.getVoices(); } catch (_) { voices = []; }
        }

        function updateButtons() {
            container.querySelectorAll('.lookup-speech-button').forEach(function (button) {
                var entry = buttonWords.get(button);
                button.setAttribute('aria-pressed', String(!!(active && entry && active.message === entry.message && active.text === entry.text)));
            });
        }

        function stop() {
            var wasActive = !!active;
            active = null;
            host.clearTimeout(timeout);
            timeout = null;
            if (wasActive) synth.cancel();
            updateButtons();
        }

        function fail(message) {
            stop();
            if (options.onError) options.onError(message);
        }

        function speak(text, message) {
            text = spokenText(text);
            if (!supported || !text) return;
            stop();
            refreshVoices();
            var voice = chooseVoice(voices);
            if (voices.length && !voice) {
                fail('当前设备没有可用的英语音色');
                return;
            }
            var utterance = new host.SpeechSynthesisUtterance(text);
            utterance.lang = voice ? voice.lang : 'en-US';
            if (voice) utterance.voice = voice;
            utterance.rate = 1;
            var request = { text: text, message: message, utterance: utterance };
            active = request; // Retain the utterance until end/error, including across streamed DOM updates.
            utterance.onend = function () {
                if (active !== request) return;
                active = null;
                host.clearTimeout(timeout);
                timeout = null;
                updateButtons();
            };
            utterance.onerror = function () {
                if (active === request) fail('发音暂不可用，请重试或检查设备的英语语音设置');
            };
            updateButtons();
            timeout = host.setTimeout(function () {
                if (active === request) fail('发音未完成，请重试');
            }, 20000);
            try {
                if (options.beforeSpeak) options.beforeSpeak();
                // Keep speak in the user's click handler, including when voices load asynchronously.
                synth.speak(utterance);
            } catch (_) {
                fail('发音暂不可用，请重试');
            }
        }

        function decorate(message, references, renderPrefix) {
            if (!supported) return;
            var seen = new Set();
            var walker = message.ownerDocument.createTreeWalker(message, 4);
            var nodes = [];
            var plainText = '';
            var current;
            while ((current = walker.nextNode())) {
                nodes.push({ node: current, start: plainText.length, end: plainText.length + current.textContent.length });
                plainText += current.textContent;
            }
            var insertions = [];
            (references || []).forEach(function (reference) {
                var text = reference.text;
                var key = text.toLowerCase();
                if (seen.has(key) || !renderPrefix) return;
                var template = message.ownerDocument.createElement('template');
                template.innerHTML = renderPrefix(reference.before);
                var position = locateReference(plainText, template.content.textContent, text);
                if (!position) return;
                var target = nodes.find(function (entry) { return entry.start < position.end && entry.end >= position.end; });
                if (!target || target.node.parentElement.closest('a, pre, code, h1, h2, h3, h4, h5, h6')) return;
                seen.add(key);
                insertions.push({ target: target, offset: position.end - target.start, text: text });
            });
            // Insert from the end so splitting one text node does not invalidate earlier offsets.
            insertions.reverse().forEach(function (entry) {
                var text = entry.text;
                var button = message.ownerDocument.createElement('button');
                button.type = 'button';
                button.className = 'lookup-speech-button';
                button.title = '朗读 ' + text + '（优先美式英语）';
                button.setAttribute('aria-label', '朗读 ' + text);
                // Static, text-free artwork: selection/copy contains only the original answer.
                button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M11 5 6 9H3v6h3l5 4V5Z"/><path d="M15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/></svg>';
                buttonWords.set(button, { text: text, message: message });
                var node = entry.target.node;
                if (entry.offset === node.textContent.length) {
                    // Place the control outside inline emphasis when it ends with the target word.
                    while (node.parentElement !== message && /^(STRONG|B|EM|I|SPAN|DEL|S)$/.test(node.parentElement.tagName) && !node.nextSibling) node = node.parentElement;
                    node.after(button);
                } else {
                    node.splitText(entry.offset).before(button);
                }
            });
            updateButtons();
        }

        if (supported) {
            refreshVoices();
            synth.addEventListener('voiceschanged', refreshVoices);
            container.addEventListener('click', function (event) {
                var button = event.target.closest('.lookup-speech-button');
                var entry = button && buttonWords.get(button);
                if (!entry) return;
                event.preventDefault();
                event.stopPropagation();
                speak(entry.text, entry.message);
            });
            host.addEventListener('pagehide', stop);
            host.document.addEventListener('visibilitychange', function () {
                if (host.document.hidden) stop();
            });
        }

        return { decorate: decorate, speak: speak, stop: stop, supported: supported };
    }

    return { spokenText: spokenText, chooseVoice: chooseVoice, extract: extract, locateReference: locateReference, createController: createController };
});
