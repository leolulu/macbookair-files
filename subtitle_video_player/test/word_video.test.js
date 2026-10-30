const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeWord, parseCandidates, createService } = require('../js/word_video');
const route = { backendUrl: 'http://ai.test', provider: 'kimi', model: 'kimi-for-coding-highspeed', conversationId: 'main-conversation' };
const source = 'https://cdn.test/word.mp4';
const tick = () => new Promise(resolve => setImmediate(resolve));
function videoResponse(word, hasVideo = true) {
    return Response.json({ ok: true, word, hasVideo, video: hasVideo ? { videoUrl: source, coverUrl: 'https://cdn.test/cover.jpg', videoTime: 62 } : null });
}
function fixture(extra = {}) {
    const calls = [];
    let clock = 100;
    const service = createService({
        now: () => clock,
        fetch: async (url, init) => {
            calls.push({ url, init });
            return extra.respond ? extra.respond(url, init) : videoResponse(new URL(url).searchParams.get('word'));
        },
        ...extra
    });
    return { service, calls, advance: ms => { clock += ms; } };
}

test('only accepts short English lookups and validates model candidates without executing or rendering them', () => {
    assert.equal(normalizeWord('  COVID-19  '), 'covid-19');
    assert.equal(normalizeWord('CAN’T'), "can't");
    for (const word of ['中文', 'a'.repeat(81), 'a b c d e f g', '<video>', 'https://evil.test']) assert.equal(normalizeWord(word), '');
    assert.deepEqual(parseCandidates('{"candidates":["Beautiful","beauty","beauty"]}', 'beautifully'), ['beautiful', 'beauty']);
    assert.deepEqual(parseCandidates('{"candidates":["run"]}', 'run'), []);
    for (const text of ['```json\n{}\n```', '{"candidates":"run"}', '{"candidates":["https://evil.test"]}', '{"candidates":[1]}', '{"candidates":["a","b","c","d"]}']) {
        assert.throws(() => parseCandidates(text, 'ran'));
    }
});

test('an exact video returns immediately without an AI request or morphology dependency', async () => {
    const f = fixture({ getBaseCandidates: () => { throw Error('must not run'); } });
    const result = await f.service.resolve({ word: 'feature', context: route });
    assert.equal(result.word, 'feature');
    assert.equal(result.video.videoUrl, source);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].init.credentials, 'omit');
});

test('shares same-word queries and keeps positive and negative cache lifetimes separate', async () => {
    let complete;
    const f = fixture({ respond: url => new Promise(resolve => { complete = () => resolve(videoResponse(new URL(url).searchParams.get('word'), false)); }) });
    const a = f.service.lookup('apricot'), b = f.service.lookup('apricot');
    await tick(); assert.equal(f.calls.length, 1); complete();
    assert.deepEqual(await Promise.all([a, b]), [null, null]);
    f.advance(299999); assert.equal(await f.service.lookup('apricot'), null); assert.equal(f.calls.length, 1);
    f.advance(2); const next = f.service.lookup('apricot'); await tick(); complete(); await next;
    assert.equal(f.calls.length, 2);
    const positive = fixture(); await positive.service.lookup('feature'); positive.advance(3599999);
    await positive.service.lookup('feature'); assert.equal(positive.calls.length, 1);
    positive.advance(2); await positive.service.lookup('feature'); assert.equal(positive.calls.length, 2);
});

test('cancelling one subscriber preserves shared work, while cancelling the last aborts and permits a fresh request', async () => {
    const pending = [];
    const f = fixture({ respond: (url, init) => new Promise(resolve => pending.push({ signal: init.signal, finish: () => resolve(videoResponse(new URL(url).searchParams.get('word'))) })) });
    const one = new AbortController(), two = new AbortController();
    const a = f.service.lookup('feature', one.signal), b = f.service.lookup('feature', two.signal);
    await tick(); one.abort(); await assert.rejects(a, { name: 'AbortError' });
    assert.equal(pending[0].signal.aborted, false);
    pending[0].finish(); assert.ok(await b);
    const three = new AbortController();
    const c = f.service.lookup('other', three.signal); await tick(); three.abort();
    await assert.rejects(c, { name: 'AbortError' }); assert.equal(pending[1].signal.aborted, true);
    const fresh = f.service.lookup('other'); await tick();
    // This fetch ignores abort deliberately; the earlier result must not be accepted or cached.
    pending[1].finish();
    const cancelled = new AbortController(); cancelled.abort();
    await assert.rejects(f.service.lookup('other', cancelled.signal), { name: 'AbortError' });
    pending[2].finish();
    assert.ok(await fresh);
    await f.service.lookup('other'); assert.equal(f.calls.length, 3);
});

test('upstream errors, mismatched words and unsafe URLs never become negative cache entries or trigger fallback', async () => {
    for (const reply of [() => Response.json({ ok: false }, { status: 503 }), () => videoResponse('wrong'), () => Response.json({ ok: true, word: 'feature', hasVideo: true, video: { videoUrl: 'javascript:alert(1)' } })]) {
        const f = fixture({ respond: reply });
        await assert.rejects(f.service.resolve({ word: 'feature', context: route }));
        await assert.rejects(f.service.resolve({ word: 'feature', context: route }));
        assert.equal(f.calls.length, 2);
        assert.ok(f.calls.every(call => call.url.startsWith('https://')));
    }
});

test('a validated local base precedes AI and a failed optional dictionary still allows AI fallback', async () => {
    const f = fixture({ getBaseCandidates: () => ['feature'], respond: url => videoResponse(new URL(url).searchParams.get('word'), url.includes('word=feature&') || url.endsWith('word=feature')) });
    assert.equal((await f.service.resolve({ word: 'features', context: route })).word, 'feature');
    assert.equal(f.calls.length, 2);
    const failed = fixture({ getBaseCandidates: () => { throw Error('dictionary offline'); }, respond: url => url.startsWith('http://ai.test') ? new Response('{"candidates":["run"]}') : videoResponse(new URL(url).searchParams.get('word'), url.endsWith('word=run')) });
    assert.equal((await failed.service.resolve({ word: 'ran', context: route })).word, 'run');
});

test('uses a separate non-preserving AI session, captured route and short sentence, then stops on the first real video', async () => {
    const f = fixture({ respond: url => url.startsWith('http://ai.test') ? new Response('{"candidates":["successful","success","succeed"]}') : videoResponse(new URL(url).searchParams.get('word'), url.endsWith('word=success')) });
    const context = { ...route, systemMessage: 'PRIVATE FULL TRANSCRIPT' };
    const result = await f.service.resolve({ word: 'successfully', sentence: 'They completed it successfully.', context });
    assert.equal(result.word, 'success'); assert.equal(result.original, 'successfully');
    const payload = JSON.parse(f.calls.find(call => call.url.startsWith('http://')).init.body);
    assert.equal(payload.provider, route.provider); assert.equal(payload.model, route.model);
    assert.equal(payload.preserve, false); assert.notEqual(payload.id, route.conversationId);
    assert.match(payload.id, /^svp-word-video-/);
    assert.doesNotMatch(JSON.stringify(payload), /PRIVATE FULL TRANSCRIPT/);
    assert.deepEqual(JSON.parse(payload.user_message), { query: 'successfully', sentence: 'They completed it successfully.' });
    assert.equal(f.calls.some(call => call.url.endsWith('word=succeed')), false);
});

test('candidate caching is sentence and route specific; reset creates a fresh helper session', async () => {
    const f = fixture({ respond: url => url.startsWith('http://') ? new Response('{"candidates":[]}') : videoResponse(new URL(url).searchParams.get('word'), false) });
    const input = { word: 'left', sentence: 'Turn left.', context: route };
    await f.service.resolve(input); await f.service.resolve(input);
    await f.service.resolve({ ...input, sentence: 'She left.' });
    await f.service.resolve({ ...input, context: { ...route, model: 'another-model' } });
    const payloads = () => f.calls.filter(call => call.url.startsWith('http://')).map(call => JSON.parse(call.init.body));
    assert.equal(payloads().length, 3); assert.equal(payloads()[0].id, payloads()[1].id);
    assert.notEqual(payloads()[1].id, payloads()[2].id);
    f.service.resetCandidates(); await f.service.resolve(input);
    assert.notEqual(payloads()[0].id, payloads()[3].id);
});

test('default routing remains default and malformed AI output stays an attachment error', async () => {
    const f = fixture({ respond: url => url.startsWith('http://') ? new Response('not JSON') : videoResponse(new URL(url).searchParams.get('word'), false) });
    await assert.rejects(f.service.resolve({ word: 'ran', context: { backendUrl: route.backendUrl } }));
    const payload = JSON.parse(f.calls[1].init.body);
    assert.equal('provider' in payload, false); assert.equal('model' in payload, false);
    assert.equal(f.calls.length, 2);
});

test('bounds metadata concurrency and removes cancelled queued work before it reaches the network', async () => {
    const waiting = [];
    const f = fixture({ respond: url => new Promise(resolve => waiting.push(() => resolve(videoResponse(new URL(url).searchParams.get('word'))))) });
    const abort = new AbortController();
    const a = f.service.lookup('one'), b = f.service.lookup('two'), c = f.service.lookup('three', abort.signal);
    await tick(); assert.equal(f.calls.length, 2);
    abort.abort(); await assert.rejects(c, { name: 'AbortError' });
    waiting.forEach(finish => finish()); await Promise.all([a, b]); await tick();
    assert.equal(f.calls.length, 2);
});

test('timeouts release an uncooperative fetch and never report a normal empty result', async () => {
    const f = fixture({ videoTimeoutMs: 15, respond: () => new Promise(() => {}) });
    await assert.rejects(f.service.lookup('feature'), { name: 'TimeoutError' });
    await assert.rejects(f.service.lookup('feature'), { name: 'TimeoutError' });
    assert.equal(f.calls.length, 2);
});
