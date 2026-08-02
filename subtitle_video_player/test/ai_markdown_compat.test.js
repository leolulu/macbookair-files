const test = require('node:test');
const assert = require('node:assert/strict');

const { Marked } = require('../assets/vendor/marked/marked.umd.js');
const compatibility = require('../js/ai_markdown_compat.js');

function createParser(withCompatibility = true) {
    const parser = new Marked({ gfm: true, breaks: true });
    if (withCompatibility) {
        compatibility.install(parser);
    }
    return parser;
}

function parse(markdown) {
    return createParser().parse(markdown);
}

test('renders the real Chinese quote-wrapped strong-emphasis failure', () => {
    const html = parse('在这句台词中，「reassuring」的意思是**“令人安心的、让人感到放心的”**。');

    assert.match(html, /意思是<strong>“令人安心的、让人感到放心的”<\/strong>。/);
    assert.doesNotMatch(html, /\*\*/);
});

test('supports the complete emphasis delimiter family', () => {
    const cases = [
        ['中文*“内容”*。', '<em>“内容”</em>'],
        ['中文_“内容”_。', '<em>“内容”</em>'],
        ['中文**“内容”**。', '<strong>“内容”</strong>'],
        ['中文__“内容”__。', '<strong>“内容”</strong>'],
        ['中文***“内容”***。', '<strong><em>“内容”</em></strong>'],
        ['中文___“内容”___。', '<strong><em>“内容”</em></strong>'],
        ['中文~~“内容”~~。', '<del>“内容”</del>']
    ];

    for (const [markdown, expected] of cases) {
        assert.match(parse(markdown), new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
});

test('supports the centralized balanced-punctuation pairs', () => {
    const pairs = [
        ['“', '”'], ['‘', '’'], ['「', '」'], ['『', '』'],
        ['"', '"'], ["'", "'"], ['《', '》'], ['〈', '〉'],
        ['（', '）'], ['【', '】'], ['〔', '〕']
    ];

    for (const [opening, closing] of pairs) {
        const html = parse(`中文**${opening}内容${closing}**。`);
        assert.match(html, /<strong>/, `${opening}${closing} should be compatible`);
        assert.doesNotMatch(html, /\*\*/);
    }
});

test('waits for later stream chunks and renders once the marker is complete', () => {
    const chunks = ['中文**“令', '人安心', '”**。'];
    let accumulated = '';

    for (let index = 0; index < chunks.length - 1; index += 1) {
        accumulated += chunks[index];
        const html = parse(accumulated);
        assert.doesNotMatch(html, /<strong>/);
        assert.match(html, /\*\*/);
    }

    accumulated += chunks[chunks.length - 1];
    assert.match(parse(accumulated), /中文<strong>“令人安心”<\/strong>。/);
});

test('leaves code spans and fenced code blocks untouched', () => {
    const inline = parse('`中文**“内容”**。`');
    const fenced = parse('```text\n中文**“内容”**。\n```');
    const rawHtmlCode = parse('<code>中文**“内容”**。</code>');

    assert.match(inline, /<code>中文\*\*“内容”\*\*。<\/code>/);
    assert.doesNotMatch(inline, /<strong>/);
    assert.match(fenced, /<pre><code class="language-text">中文\*\*“内容”\*\*。/);
    assert.doesNotMatch(fenced, /<strong>/);
    assert.equal(rawHtmlCode, '<p><code>中文**“内容”**。</code></p>\n');
    assert.doesNotMatch(rawHtmlCode, /<strong>/);
});

test('leaves escaped, incomplete, ambiguous and multiline inputs to Marked', () => {
    const inputs = [
        '\\**“内容”**。',
        '中文**“内容',
        '中文**“内容」**。',
        '中文**“ 内容”**。',
        '中文**“内容 ”**。',
        '中文**“跨行\n内容”**。',
        '2**3**4'
    ];

    for (const markdown of inputs) {
        const baseline = createParser(false).parse(markdown);
        assert.equal(parse(markdown), baseline, markdown);
    }
});

test('preserves ordinary valid Markdown and parses nested inline Markdown', () => {
    const validInputs = [
        '**正常粗体**',
        '中文**正常粗体**。',
        '[链接](https://example.com)',
        '文字 *正常斜体* 与 ~~正常删除线~~'
    ];

    for (const markdown of validInputs) {
        assert.equal(parse(markdown), createParser(false).parse(markdown), markdown);
    }

    assert.match(
        parse('中文**“包含 *正常斜体* 的内容”**。'),
        /<strong>“包含 <em>正常斜体<\/em> 的内容”<\/strong>/
    );
});

test('handles multiple compatible occurrences independently', () => {
    const html = parse('中文**“第一处”**，然后中文_「第二处」_。');

    assert.match(html, /<strong>“第一处”<\/strong>/);
    assert.match(html, /<em>「第二处」<\/em>/);
});

test('recognizes a preceding non-BMP Unicode letter as text', () => {
    assert.match(parse('𐐀**“content”**。'), /𐐀<strong>“content”<\/strong>。/);
});
