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

test('buildNote does not double-escape an already escaped filename underscore', () => {
    const note = eudic.buildNote({
        videoName: 'KAMUI.Hes.Behind.You.S01E02.MSubs-ToonsHub\\_x264.mp4',
        lines: ['Enough already about that bogus psychic.'],
        currentIndex: 0,
        selectedText: 'bogus',
        selectionStart: 26
    });

    assert.equal(
        note,
        '**来源：**《KAMUI.Hes.Behind.You.S01E02.MSubs-ToonsHub\\_x264.mp4》\n'
        + '> Enough already about that **bogus** psychic.'
    );
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

test('buildNoteFromContext uses edited lines and omits unchecked neighbours', () => {
    const note = eudic.buildNoteFromContext({
        videoName: 'Demo.ass',
        previousLine: '427.38 -39.02 428.17 -39.08',
        currentLine: 'It is surprisingly nice out today.',
        nextLine: 'It really is.',
        includePrevious: false,
        includeNext: true,
        selectedText: 'nice',
        selectionStart: 21
    });

    assert.equal(
        note,
        '**来源：**《Demo.ass》\n'
        + '> It is surprisingly **nice** out today.\n'
        + '> It really is.'
    );
    assert.doesNotMatch(note, /427\.38/);
});

test('buildNoteFromContext normalizes whitespace in manually edited cues', () => {
    const note = eudic.buildNoteFromContext({
        videoName: 'Demo.srt',
        previousLine: 'Previous\nline',
        currentLine: 'The   selected\r\nword remains.',
        nextLine: '',
        selectedText: 'word',
        selectionStart: 15
    });

    assert.equal(
        note,
        '**来源：**《Demo.srt》\n'
        + '> Previous line\n'
        + '> The selected **word** remains.'
    );
});

test('buildNoteFromContext requires the selected term in the edited current cue', () => {
    assert.throws(
        () => eudic.buildNoteFromContext({
            videoName: 'Demo',
            currentLine: 'The word was removed.',
            selectedText: 'missing',
            selectionStart: 0
        }),
        /无法在当前字幕中定位选中的词条/
    );
});

test('term normalization trims edge punctuation and keeps phrase characters', () => {
    assert.equal(eudic.normalizeSelectedTerm('  “Take   care of,”  '), 'Take care of');
    assert.equal(eudic.normalizeWord('  “Take   care of,”  '), 'take care of');
    assert.equal(eudic.normalizeWord('  Don’t  '), "don't");
});

test('term validation accepts phrases, apostrophes, and hyphens', () => {
    assert.equal(eudic.isSupportedWord("don't"), true);
    assert.equal(eudic.isSupportedWord('state-of-the-art'), true);
    assert.equal(eudic.isSupportedWord('take care of'), true);
    assert.equal(eudic.isSupportedWord("don't give-up"), true);
});

test('term validation rejects internal punctuation, digits, and special symbols', () => {
    assert.equal(eudic.isSupportedWord('hello, how are'), false);
    assert.equal(eudic.isSupportedWord('COVID-19'), false);
    assert.equal(eudic.isSupportedWord('24/7'), false);
    assert.equal(eudic.isSupportedWord('C++'), false);
    assert.equal(eudic.isSupportedWord('rock & roll'), false);
});

test('partial selection expands to the complete subtitle word form', () => {
    assert.deepEqual(
        eudic.expandSelectionToWordBoundaries('He works every day.', 3, 7),
        { text: 'works', start: 3, end: 8 }
    );
    assert.deepEqual(
        eudic.expandSelectionToWordBoundaries('She tried again.', 5, 8),
        { text: 'tried', start: 4, end: 9 }
    );
});

test('selection expansion trims edge punctuation and preserves phrase boundaries', () => {
    assert.deepEqual(
        eudic.expandSelectionToWordBoundaries('She said, “Take care of yourself.”', 10, 24),
        { text: 'Take care of', start: 11, end: 23 }
    );
    assert.deepEqual(
        eudic.expandSelectionToWordBoundaries("Please don't give-up now.", 8, 20),
        { text: "don't give-up", start: 7, end: 20 }
    );
});

test('selection expansion rejects ranges without an English word', () => {
    assert.equal(eudic.expandSelectionToWordBoundaries('Wait ... now.', 5, 8), null);
    assert.equal(eudic.expandSelectionToWordBoundaries('Hello', NaN, NaN), null);
});

test('buildNoteFromContext bolds the complete selected phrase without edge punctuation', () => {
    const note = eudic.buildNoteFromContext({
        videoName: 'Demo',
        currentLine: 'She said, “Take care of yourself.”',
        selectedText: '“Take care of',
        selectionStart: 11
    });

    assert.equal(note, '**来源：**《Demo》\n> She said, “**Take care of** yourself.”');
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

test('submitWord normalizes and saves a phrase before adding it', async () => {
    const calls = [];
    const responses = [
        jsonResponse(200, { data: [] }),
        jsonResponse(201, { message: 'note saved' }),
        jsonResponse(201, { message: 'word added' })
    ];
    const result = await eudic.submitWord({
        authorization: 'NIS test',
        word: '“Take  Care Of,”',
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
        word: 'take care of',
        note: 'context'
    });
    assert.match(calls[2].url, /\/word$/);
    assert.deepEqual(JSON.parse(calls[2].options.body), {
        language: 'en',
        word: 'take care of'
    });
});

test('an edited dictionary entry keeps the original subtitle form in the note', async () => {
    const note = eudic.buildNoteFromContext({
        videoName: 'Demo',
        currentLine: 'She tried again.',
        selectedText: 'tried',
        selectionStart: 4
    });
    const calls = [];
    const responses = [
        jsonResponse(200, { data: [] }),
        jsonResponse(201, { message: 'note saved' }),
        jsonResponse(201, { message: 'word added' })
    ];

    const result = await eudic.submitWord({
        authorization: 'NIS test',
        word: 'try',
        note,
        fetchImpl: async (url, options) => {
            calls.push({ url, options });
            return responses.shift();
        }
    });

    assert.deepEqual(result, { status: 'created', word: 'try' });
    assert.match(note, /> She \*\*tried\*\* again\./);
    assert.deepEqual(JSON.parse(calls[1].options.body), {
        language: 'en',
        word: 'try',
        note
    });
    assert.deepEqual(JSON.parse(calls[2].options.body), {
        language: 'en',
        word: 'try'
    });
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
