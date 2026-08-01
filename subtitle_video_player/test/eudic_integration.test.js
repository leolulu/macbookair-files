const test = require('node:test');
const assert = require('node:assert/strict');

const eudic = require('../js/eudic_integration.js');

function jsonResponse(status, payload) {
    return {
        ok: status >= 200 && status < 300,
        status,
        async text() {
            return payload === null ? '' : JSON.stringify(payload);
        }
    };
}

test('buildNote keeps three available lines and bolds the selected occurrence', () => {
    const note = eudic.buildNote({
        videoName: 'Demo.mkv',
        lines: ['The word opens.', 'word then word again.', 'The scene ends.'],
        currentIndex: 1,
        selectedText: 'word',
        selectionStart: 10
    });

    assert.equal(
        note,
        '**来源：**《Demo.mkv》\n'
        + '> The word opens.\n'
        + '> word then **word** again.\n'
        + '> The scene ends.'
    );
    assert.doesNotMatch(note, /\[\d+:\d+/);
});

test('buildNote omits a missing previous line at the beginning', () => {
    const note = eudic.buildNote({
        videoName: 'Demo',
        lines: ['Hello world.', 'Next line.'],
        currentIndex: 0,
        selectedText: 'Hello',
        selectionStart: 0
    });

    assert.equal(note, '**来源：**《Demo》\n> **Hello** world.\n> Next line.');
});

test('buildNote flattens multiline SRT cues into one quote line per cue', () => {
    const note = eudic.buildNote({
        videoName: 'Demo.srt',
        lines: [
            'Previous subtitle\r\ncontinues here.',
            'I am here to rescue a poor Beastfolk soul\nwho has fallen victim.',
            'Next subtitle\rcontinues too.'
        ],
        currentIndex: 1,
        selectedText: 'Beastfolk',
        selectionStart: 27
    });

    assert.equal(
        note,
        '**来源：**《Demo.srt》\n'
        + '> Previous subtitle continues here.\n'
        + '> I am here to rescue a poor **Beastfolk** soul who has fallen victim.\n'
        + '> Next subtitle continues too.'
    );
});

test('buildNote flattens a cleaned ASS hard break after bolding the selected word', () => {
    const sentence = "We're going to have to find\nsome work in the next town.";
    const note = eudic.buildNote({
        videoName: 'Demo.ass',
        lines: [sentence],
        currentIndex: 0,
        selectedText: 'work',
        selectionStart: sentence.indexOf('work')
    });

    assert.equal(
        note,
        "**来源：**《Demo.ass》\n> We're going to have to find some **work** in the next town."
    );
});

test('word validation accepts apostrophes and hyphens but rejects phrases', () => {
    assert.equal(eudic.normalizeWord('  Don’t  '), "don't");
    assert.equal(eudic.isSupportedWord("don't"), true);
    assert.equal(eudic.isSupportedWord('state-of-the-art'), true);
    assert.equal(eudic.isSupportedWord('two words'), false);
});

test('maskAuthorization preserves length and keeps a recognizable prefix and suffix', () => {
    const authorization = 'NIS abcdefghijklmnopqrstuvwxyz0123456789';
    const masked = eudic.maskAuthorization(authorization);

    assert.equal(masked.length, authorization.length);
    assert.equal(masked, 'NIS abcd' + '•'.repeat(16) + 'uvwxyz0123456789');
    assert.equal(eudic.maskAuthorization('abcdefgh'), 'a' + '•'.repeat(6) + 'h');
});

test('submitWord stops immediately when the word already exists', async () => {
    const calls = [];
    const result = await eudic.submitWord({
        authorization: 'NIS test',
        word: 'Hello',
        note: 'unused',
        fetchImpl: async (url, options) => {
            calls.push({ url, options });
            return jsonResponse(200, { word: 'hello', exp: '' });
        }
    });

    assert.deepEqual(result, { status: 'duplicate', word: 'hello' });
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/word\?language=en&word=hello$/);
});

test('submitWord saves the note before adding a new word', async () => {
    const calls = [];
    const responses = [
        jsonResponse(200, { data: [] }),
        jsonResponse(201, { message: 'note saved' }),
        jsonResponse(201, { message: 'word added' })
    ];
    const result = await eudic.submitWord({
        authorization: 'NIS test',
        word: 'Hello',
        note: 'context',
        fetchImpl: async (url, options) => {
            calls.push({ url, options });
            return responses.shift();
        }
    });

    assert.equal(result.status, 'created');
    assert.match(calls[1].url, /\/note$/);
    assert.deepEqual(JSON.parse(calls[1].options.body), {
        language: 'en',
        word: 'hello',
        note: 'context'
    });
    assert.match(calls[2].url, /\/word$/);
});

test('submitWord reports when the note was saved but adding the word failed', async () => {
    const responses = [
        jsonResponse(200, { data: null }),
        jsonResponse(201, { message: 'note saved' }),
        jsonResponse(500, { message: 'failed' })
    ];

    await assert.rejects(
        eudic.submitWord({
            authorization: 'NIS test',
            word: 'hello',
            note: 'context',
            fetchImpl: async () => responses.shift()
        }),
        error => error.code === 'http_error' && error.noteSaved === true
    );
});

test('validateAuthorization never needs to expose the key in an error', async () => {
    await assert.rejects(
        eudic.validateAuthorization('NIS super-secret', async () => jsonResponse(401, null)),
        error => error.code === 'authorization_failed'
            && !error.message.includes('super-secret')
    );
});
