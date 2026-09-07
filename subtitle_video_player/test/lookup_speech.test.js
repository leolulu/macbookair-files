const test = require('node:test');
const assert = require('node:assert/strict');
const speech = require('../js/lookup_speech');
const { Marked } = require('../assets/vendor/marked/marked.umd');
const compat = require('../js/ai_markdown_compat');

test('speech extraction preserves Markdown exactly, including mistakenly nested markers', () => {
    const parser = new Marked({ gfm: true, breaks: true });
    compat.install(parser);
    for (const [source, clean] of [
        ['这里的 **running**[[SPEAK:running]] 是形容词。', '这里的 **running** 是形容词。'],
        ['这里的 **running[[SPEAK:running]]** 是形容词。', '这里的 **running** 是形容词。'],
        ['***running[[SPEAK:running]]***', '***running***'],
        ['__running[[SPEAK:running]]__', '__running__'],
        ['这里的**“running[[SPEAK:running]]”**。', '这里的**“running”**。'],
        ['**running costs**[[SPEAK:running costs]] 与 **operating costs**。', '**running costs** 与 **operating costs**。'],
        ['went[[SPEAK:went]]', 'went'],
        ['**running**[[SPEAK:running]][[COCA:abc:c1]]', '**running**[[COCA:abc:c1]]']
    ]) {
        const result = speech.extract(source);
        assert.equal(result.text, clean);
        assert.equal(parser.parse(result.text), parser.parse(clean));
        assert.equal(result.references.length, 1);
    }
    assert.deepEqual(speech.extract('**operating costs**').references, []);
});

test('every streamed marker prefix is hidden without swallowing the original word', () => {
    const marker = '[[SPEAK:running]]';
    for (let end = 0; end < marker.length; end++) {
        const result = speech.extract('**running**' + marker.slice(0, end));
        assert.equal(result.text, '**running**', marker.slice(0, end));
        assert.deepEqual(result.references, []);
    }
    assert.equal(speech.extract('**running**' + marker).references.length, 1);
    for (const source of ['**running[[SPEAK:running**', '**running[[SPEAK:running**\n下一段', '**running[[SPEAK:running**。']) {
        assert.doesNotMatch(speech.extract(source).text, /SPEAK|\[\[/);
        assert.match(speech.extract(source).text, /\*\*running\*\*/);
    }
});

test('invalid references and ordinary Markdown brackets do not authorize speech', () => {
    for (const marker of ['[[SPEAK:3273]]', '[[SPEAK:中文]]', '[[SPEAK:run/v]]', '[SPEAK:running]', '[[SPEAK:running]', '[[SPEAK running]]']) {
        const result = speech.extract('running' + marker);
        assert.equal(result.text, 'running');
        assert.deepEqual(result.references, []);
    }
    for (const text of ['[说明](https://example.com)', '[1]', '普通[[备注]]', '**中文**']) assert.equal(speech.extract(text).text, text);
    assert.equal(speech.extract('running[[SPEAK:running\nbad]] 后文').text, 'running 后文');
    assert.equal(speech.extract('running[[SPEAK:running[[COCA:ns:c1]] 后文').text, 'running[[COCA:ns:c1]] 后文');
});

test('references locate their own occurrence instead of an earlier mention or similar spelling', () => {
    const plain = 'running 是目标。这里的 running 是形容词。';
    assert.deepEqual(speech.locateReference(plain, 'running 是目标。这里的 **running', 'running'), { start: 16, end: 23 });
    assert.equal(speech.locateReference('running costs', 'running costs', 'run'), null);
    assert.equal(speech.locateReference('running 是词', 'running 是词', 'running'), null);
    assert.deepEqual(speech.locateReference('running costs 表示费用', '**running costs', 'running costs'), { start: 0, end: 13 });
    assert.deepEqual(speech.locateReference('‘running’ 表示跑', '‘running’', 'running'), { start: 1, end: 8 });
    assert.equal(speech.locateReference("runner's", "runner's", 'runner'), null);
});

test('pronounces English words and short phrases independently of rank or morphology', () => {
    for (const word of ['running', 'ran', 'went', 'algebraically', 'Quidditch', "don't", 'mother-in-law', 'running costs']) {
        assert.equal(speech.spokenText(word), word);
    }
    assert.equal(speech.spokenText('  give   up '), 'give up');
    for (const text of ['3273', 'COCA 排名', 'running（形容词）', '词汇详解', 'https://example.com', 'a b c d e f g', 'a'.repeat(81)]) {
        assert.equal(speech.spokenText(text), '');
    }
});

test('prefers any American voice over other English defaults, with an English fallback', () => {
    const uk = { lang: 'en-GB', default: true };
    const us = { lang: 'en-US', localService: false };
    const usDefault = { lang: 'en_US', default: true };
    const chinese = { lang: 'zh-CN', default: true };
    assert.equal(speech.chooseVoice([chinese, uk, us]), us);
    assert.equal(speech.chooseVoice([us, uk, usDefault]), usDefault);
    assert.equal(speech.chooseVoice([chinese, uk]), uk);
    assert.equal(speech.chooseVoice([chinese]), null);
    assert.equal(speech.chooseVoice([]), null);
});

function fixture(initialVoices = []) {
    const calls = [];
    const listeners = {};
    const errors = [];
    const timers = new Map();
    let timerId = 0;
    let voices = initialVoices;
    const host = {
        speechSynthesis: {
            getVoices: () => voices,
            addEventListener: (name, fn) => { listeners[name] = fn; },
            speak: utterance => calls.push(['speak', utterance]),
            cancel: () => calls.push(['cancel'])
        },
        SpeechSynthesisUtterance: function (text) { this.text = text; },
        setTimeout: fn => { timers.set(++timerId, fn); return timerId; },
        clearTimeout: id => timers.delete(id),
        addEventListener: (name, fn) => { listeners[name] = fn; },
        document: { hidden: false, addEventListener: (name, fn) => { listeners[name] = fn; } }
    };
    const container = { querySelectorAll: () => [], addEventListener: () => {} };
    const controller = speech.createController(host, container, {
        beforeSpeak: () => calls.push(['pause-video']),
        onError: message => errors.push(message)
    });
    return { host, controller, calls, errors, listeners, timers, setVoices: value => { voices = value; } };
}

test('an initially empty voice list still attempts en-US synchronously, then uses loaded voices', () => {
    const f = fixture();
    f.controller.speak('running');
    assert.deepEqual(f.calls.map(call => call[0]), ['pause-video', 'speak']);
    assert.equal(f.calls[1][1].lang, 'en-US');
    f.calls[1][1].onend();
    const voice = { lang: 'en-US' };
    f.setVoices([voice]);
    f.listeners.voiceschanged();
    f.controller.speak('ran');
    assert.equal(f.calls.at(-1)[1].voice, voice);
});

test('rapid replay cancels the old utterance; stale errors cannot cancel the new one', () => {
    const f = fixture();
    f.controller.speak('running');
    const old = f.calls.at(-1)[1];
    f.controller.speak('went');
    const latest = f.calls.at(-1)[1];
    assert.deepEqual(f.calls.map(call => call[0]), ['pause-video', 'speak', 'cancel', 'pause-video', 'speak']);
    old.onerror({ error: 'canceled' });
    old.onend();
    assert.deepEqual(f.errors, []);
    assert.equal(f.timers.size, 1);
    latest.onend();
    assert.equal(f.timers.size, 0);
});

test('missing English voices and synthesis failures leave a retryable control', () => {
    const f = fixture([{ lang: 'zh-CN' }]);
    f.controller.speak('running');
    assert.equal(f.calls.length, 0);
    assert.equal(f.errors.length, 1);
    f.setVoices([{ lang: 'en-GB' }]);
    f.controller.speak('running');
    f.calls.at(-1)[1].onerror({ error: 'network' });
    assert.equal(f.timers.size, 0);
    assert.equal(f.errors.length, 2);
    f.controller.speak('running');
    f.calls.at(-1)[1].onend();
    assert.equal(f.errors.length, 2);
});

test('page hiding cancels speech and cleans its timeout without reporting an error', () => {
    const f = fixture();
    f.controller.speak('running');
    const utterance = f.calls.at(-1)[1];
    f.host.document.hidden = true;
    f.listeners.visibilitychange();
    utterance.onerror({ error: 'interrupted' });
    assert.equal(f.calls.at(-1)[0], 'cancel');
    assert.equal(f.timers.size, 0);
    assert.deepEqual(f.errors, []);
});

test('an unresponsive or throwing engine clears playback state', () => {
    const f = fixture();
    f.controller.speak('running');
    [...f.timers.values()][0]();
    assert.equal(f.timers.size, 0);
    assert.equal(f.calls.at(-1)[0], 'cancel');
    f.host.speechSynthesis.speak = () => { throw new Error('unavailable'); };
    f.controller.speak('running');
    assert.equal(f.timers.size, 0);
    assert.equal(f.errors.length, 2);
});

test('unsupported browsers preserve the answer without pronunciation controls', () => {
    const controller = speech.createController({}, {}, {});
    assert.equal(controller.supported, false);
    controller.decorate({});
    controller.speak('running');
});
