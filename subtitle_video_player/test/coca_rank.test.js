const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const rank = require('../js/coca_rank');
const asset = require('../js/coca_data');
const decoded = rank.decode(asset);

test('complete decoded dataset equals the source extraction, preserving rank gaps and POS', async () => {
    const { words } = await decoded;
    const canonical = [...words].map(([word, rows]) => [word, [...rows].sort((a, b) => a[1] - b[1])]);
    assert.equal(words.size, 53967);
    assert.equal(crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex'),
        '3e4f837801332a7e416366dc2a1c8195f51fd31d75b663a32dde737a1c6eb07d');
    const all = [...words.values()].flat().map(row => row[1]);
    assert.equal(all.length, 60022);
    const unique = new Set(all);
    assert.equal(unique.size, 60022);
    assert.deepEqual(Array.from({ length: 60024 }, (_, i) => i + 1).filter(n => !unique.has(n)), [30509, 34540]);
    assert.deepEqual(words.get('running'), [['j', 3273], ['n', 4719]]);
    assert.equal(words.get('run').find(row => row[0] === 'v')[1], 202);
    assert.deepEqual(words.get('apple'), [['n', 2711]]);
    assert.equal('freq' in asset, false);
});

test('decoder rejects corrupted resources and load failure can be retried', async () => {
    const bytes = zlib.gunzipSync(Buffer.from(asset.ranks, 'base64'));
    assert.throws(() => rank.decodeRanks(bytes.subarray(0, bytes.length - 1)), /length/);
    assert.throws(() => rank.decodeRanks(new Uint8Array([1, 2, 3])), /header/);
    const damaged = Buffer.from(bytes);
    damaged[damaged.length - 1] = 255;
    assert.throws(() => rank.decodeRanks(damaged), /record/);
    global.SvpCocaData = { ranks: 'bad' };
    await assert.rejects(rank.load());
    global.SvpCocaData = asset;
    const first = rank.load();
    assert.equal(first, rank.load());
    assert.equal((await first).words.size, 53967);
});

test('regular inflections and spelling changes provide ranked lemmas', async () => {
    const data = await decoded;
    const cases = [
        ['works', 'work', 'v'], ['studies', 'study', 'v'], ['worked', 'work', 'v'],
        ['studied', 'study', 'v'], ['stopped', 'stop', 'v'], ['working', 'work', 'v'],
        ['making', 'make', 'v'], ['lying', 'lie', 'v'], ['running', 'run', 'v'],
        ['books', 'book', 'n'], ['boxes', 'box', 'n'], ['stories', 'story', 'n'],
        ['apples', 'apple', 'n'], ['bigger', 'big', 'j'], ['biggest', 'big', 'j'],
        ['happier', 'happy', 'j'], ['happiest', 'happy', 'j'], ['nicer', 'nice', 'j'],
        ['nicest', 'nice', 'j'], ['played', 'play', 'v'], ['seeing', 'see', 'v'],
        ['being', 'be', 'v'], ['dyeing', 'dye', 'v']
    ];
    for (const [surface, word, pos] of cases) {
        assert.ok(rank.candidates(surface, data).some(c => c.word === word && c.pos === pos && c.match.startsWith('regular_')), surface);
    }
    for (const word of ['saw', 'went', 'gone', 'took', 'taken', 'ran']) {
        assert.ok(rank.candidates(word, data).every(c => !['see', 'go', 'take', 'run'].includes(c.word)), word);
    }
    assert.ok(rank.candidates('saw', data).some(c => c.word === 'saw' && c.match === 'exact_word_pos'));
    for (const [surface, wrong] of [['hoped', 'hop'], ['rated', 'rat'], ['hardly', 'hard'], ['friendly', 'friend'], ['news', 'new']]) {
        assert.ok(!rank.candidates(surface, data).some(c => c.word === wrong), surface);
    }
});

test('running keeps exact adjective/noun and regular verb for contextual AI selection', async () => {
    const context = rank.createContext('running', await decoded);
    assert.deepEqual(context.candidates.map(c => [c.word, c.pos]), [['running', 'j'], ['running', 'n'], ['run', 'v']]);
    for (const [pos, expected] of [['j', '3273'], ['n', '4719'], ['v', '202']]) {
        const candidate = context.candidates.find(c => c.pos === pos);
        const output = rank.render(`running [[COCA:${context.namespace}:${candidate.candidate_id}]]`, context);
        assert.ok(output.includes(`第 **${expected}** 位`));
        assert.equal(output.includes('原形 run'), pos === 'v');
    }
});

test('phrase candidates stay local, identify scope and have stable IDs per retry', async () => {
    const data = await decoded;
    const context = rank.createContext('Running costs', data);
    assert.ok(context.candidates.every(c => ['running costs', 'running', 'costs'].includes(c.surface)));
    assert.ok(context.candidates.every(c => c.scope === 'word'));
    assert.deepEqual(context.candidates, rank.candidates('Running costs', data));
    assert.match(rank.prompt(context), /绝不能称为整个词组的排名/);
    assert.match(rank.prompt(context), /选择和排除候选的过程不要写进回答/);
    assert.match(rank.prompt(context), /搭配只选当前义项/);
    const word = context.candidates.find(c => c.word === 'running' && c.pos === 'j');
    const rendered = rank.render(`running costs: running [[COCA:${context.namespace}:${word.candidate_id}]]`, context);
    assert.match(rendered, /running·形容词/);
    assert.doesNotMatch(rendered, /costs.*costs.*排名/);
    const fixture = { words: new Map([['in front', [['i', 12]]], ['front', [['n', 25]]]]), relations: {} };
    assert.equal(rank.candidates('in front', fixture)[0].scope, 'phrase');
    assert.equal(rank.candidates('x '.repeat(40), data).length, 0);
});

test('one-step explicit relations only, with accurate entries taking precedence', async () => {
    const data = await decoded;
    const relation = Object.entries(data.relations).find(([word, rows]) => /^[a-z]+$/.test(word) && rows.some(r => r[0] === 'r' && r[2] === 'j'));
    const context = rank.createContext(relation[0], data);
    const candidate = context.candidates.find(c => c.match === 'derivational_reference');
    assert.ok(candidate);
    const output = rank.render(`词汇 [[COCA:${context.namespace}:${candidate.candidate_id}]]`, context);
    assert.ok(output.includes(`参考 ${candidate.word} 的形容词`));
    assert.ok(rank.candidates('beautifully', data).every(c => c.match === 'exact_word_pos'));
    const fixture = { words: new Map([['friendly', [['j', 30]]], ['friend', [['n', 20]]]]), relations: {} };
    assert.deepEqual(rank.candidates('friendli', fixture), []);
    assert.ok(rank.candidates('friendly', fixture).every(c => c.word === 'friendly'));
    fixture.relations.friendly = [['n', 'friend', 'n']];
    const next = rank.createContext('friendly', fixture);
    const exact = next.candidates.find(c => c.match === 'exact_word_pos');
    const fallback = next.candidates.find(c => c.match.endsWith('_reference'));
    assert.ok(fallback);
    const both = rank.render(`[[COCA:${next.namespace}:${fallback.candidate_id}]] [[COCA:${next.namespace}:${exact.candidate_id}]]`, next);
    assert.doesNotMatch(both, /参考/);
    assert.match(both, /第 \*\*30\*\* 位/);
});

test('references never leak at any stream boundary, or when invalid, repeated, aborted or stale', async () => {
    const context = rank.createContext('running', await decoded);
    const marker = `[[COCA:${context.namespace}:c1]]`;
    for (let i = 1; i < marker.length; i++) {
        assert.equal(rank.render('before ' + marker.slice(0, i), context), 'before ', `split ${i}`);
    }
    assert.equal(rank.render('ordinary explanation', context), 'ordinary explanation');
    assert.equal(rank.render('ordinary [', null), 'ordinary [');
    assert.equal(rank.render('before [[COCA:invalid:c9]] after', context), 'before  after');
    assert.equal(rank.render('before [[COCA:\nbad]] after', context), 'before  after');
    assert.equal(rank.render(marker, null), '');
    assert.equal(rank.render(marker, rank.createContext('running', await decoded)), '');
    const twice = rank.render(marker + marker, context);
    assert.equal((twice.match(/COCA 排名/g) || []).length, 1);
    assert.doesNotMatch(twice, /\[\[|c1/);
    const works = rank.createContext('works', await decoded);
    const plural = works.candidates.find(c => c.match === 'regular_plural');
    assert.equal(rank.render(`[[COCA:${works.namespace}:${plural.candidate_id}]]`, works), '');
});

test('at most one fallback is rendered across core words', () => {
    const fixture = { words: new Map([['clear', [['j', 10]]], ['slow', [['j', 20]]]]),
        relations: { clearly: [['r', 'clear', 'j']], slowly: [['r', 'slow', 'j']] } };
    const context = rank.createContext('clearly slowly', fixture);
    const text = context.candidates.map(c => `[[COCA:${context.namespace}:${c.candidate_id}]]`).join(' ');
    assert.equal((rank.render(text, context).match(/参考/g) || []).length, 1);
});

test('saw sense selection belongs to AI and its valid citation is independent of wording order', async () => {
    const context = rank.createContext('saw', await decoded);
    const candidate = context.candidates.find(c => c.word === 'saw' && c.pos === 'v');
    const marker = `[[COCA:${context.namespace}:${candidate.candidate_id}]]`;
    assert.match(candidate.usage, /see的过去式禁止引用/);
    assert.match(rank.prompt(context), /saw作为see的过去式时不引用saw\/v/);
    assert.ok(context.candidates.every(c => c.word === 'saw'));
    for (const text of [`这里的 saw 是动词${marker}，表示用锯切割。`, `saw 在这里表示用锯切割 ${marker}。`, `saw ${marker} means to cut with a saw.`]) {
        assert.match(rank.render(text, context), /第 \*\*14302\*\* 位/);
    }
    assert.equal(rank.render('saw 是 see 的过去式，表示看见。', context), 'saw 是 see 的过去式，表示看见。');
});

test('final ee, doubled z plurals and inserted k forms keep their regular lemmas', async () => {
    const data = await decoded;
    const cases = [
        ['agreed', 'agree', 'v'], ['freed', 'free', 'v'], ['guaranteed', 'guarantee', 'v'],
        ['freer', 'free', 'j'], ['freest', 'free', 'j'], ['quizzes', 'quiz', 'n'],
        ['quizzes', 'quiz', 'v'], ['panicked', 'panic', 'v'], ['panicking', 'panic', 'v'],
        ['picnicked', 'picnic', 'v'], ['picnicking', 'picnic', 'v']
    ];
    for (const [surface, word, pos] of cases) {
        const context = rank.createContext(surface, data);
        const candidate = context.candidates.find(c => c.word === word && c.pos === pos && c.match.startsWith('regular_'));
        assert.ok(candidate, `${surface} -> ${word}/${pos}`);
        assert.match(rank.render(`核心词 [[COCA:${context.namespace}:${candidate.candidate_id}]]`, context), /COCA 排名第/);
    }
    for (const [surface, wrong] of [['seeing', 'seee'], ['agreed', 'agre'], ['quizzes', 'qui'], ['hoped', 'hop'], ['rated', 'rat']]) {
        assert.ok(!rank.candidates(surface, data).some(c => c.word === wrong), `${surface} != ${wrong}`);
    }
});

test('malformed rank references preserve following prose and independent speech markers', async () => {
    const context = rank.createContext('running', await decoded);
    for (const end of [']', '']) {
        const source = `**running**[[COCA:${context.namespace}:c1${end} 是形容词。\n\n**词源**：来自 run。`;
        assert.equal(rank.render(source, context), '**running** 是形容词。\n\n**词源**：来自 run。');
        assert.equal(rank.render(source, null), '**running** 是形容词。\n\n**词源**：来自 run。');
    }
    assert.equal(rank.render(`**running**[[COCA:${context.namespace}:c1][[SPEAK:running]] 表示持续。`, context), '**running**[[SPEAK:running]] 表示持续。');
    assert.equal(rank.render(`**running**[[COCA:${context.namespace}:c1[[SPEAK:running]] 表示持续。`, context), '**running**[[SPEAK:running]] 表示持续。');
});

test('lookup strips model-written rank claims at every stream boundary, keeping only local ID labels', async () => {
    const context = rank.createContext('running', await decoded);
    const marker = `[[COCA:${context.namespace}:c1]]`;
    const claims = ['COCA 排名第 999999 位', 'COCA词频排名第９９９９９９位', '**COCA rank: 999,999**',
        'COCA排名第三千二百位', '排名第999999位', 'COCA frequency rank #999999'];
    for (const claim of claims) {
        for (let i = 1; i <= claim.length; i++) {
            assert.doesNotMatch(rank.render('释义 ' + claim.slice(0, i), context), /[9９三千二百]/, `${claim} split ${i}`);
        }
        const text = `核心词${marker}（${claim}），表示持续发生。`;
        assert.equal(rank.render(text, context), '核心词（running·形容词，COCA 排名第 **3273** 位），表示持续发生。');
        assert.equal(rank.render(claim, context), '');
        assert.equal(rank.render(claim, { candidates: [] }), '');
        assert.equal(rank.render(claim, null), claim);
    }
    assert.equal(rank.render('发生在2016年，共3种用法。', context), '发生在2016年，共3种用法。');
    assert.equal(rank.render('**running** 是形容词，COCA 排名第999999位，表示持续。', context), '**running** 是形容词，表示持续。');
    assert.equal(rank.render('COCA 排名第999999位，表示持续。', context), '表示持续。');
    assert.equal(rank.render(`释义 COCA 排名第999999位 ${marker}，后文。`, context), '释义 （running·形容词，COCA 排名第 **3273** 位），后文。');
});
