const test = require('node:test');
const assert = require('node:assert/strict');
const pos = require('../js/pos_highlight');

function marked(text) {
    return pos.segments(text).filter(part => part.pos).map(part => part.text);
}

test('只把白名单里的词性英文简写标成词性片段', () => {
    assert.deepEqual(marked('在本句作 vt. （及物动词）'), ['vt.']);
    assert.deepEqual(marked('作 n. ，也可作 v./vt. 使用'), ['n.', 'v.', 'vt.']);
    assert.deepEqual(marked('adj./adv. 的用法'), ['adj.', 'adv.']);
    assert.deepEqual(marked('**pron.** 与 interj. 都在这里'), ['pron.', 'interj.']);
    assert.deepEqual(marked('vt.表示及物动词'), ['vt.']);
    assert.deepEqual(marked('（n.）'), ['n.']);
});

test('普通英文缩写、网址与嵌入位置不产生词性片段', () => {
    for (const text of [
        'e.g. 例如，etc. 以及 No. 5，vs. 10',
        'https://example.com/path',
        'U.S. / a.m. / i.e.',
        'xvt. vtx. vt.. adjx',
        '100.5 与 3.14',
        ''
    ]) {
        assert.deepEqual(marked(text), [], text);
    }
});

test('切分结果完整还原原文且不丢标点', () => {
    for (const text of [
        '在本句作 vt. （及物动词），另见 adj./adv.。',
        'vt.',
        ' vt. ',
        '开头 n. 结尾',
        '没有词性缩写'
    ]) {
        const parts = pos.segments(text);
        assert.equal(parts.map(part => part.text).join(''), text);
        assert.equal(parts.every(part => typeof part.text === 'string' && part.text.length > 0), true);
    }
});

test('缺失 DOM 环境时装饰安全退出', () => {
    assert.equal(pos.decorate(), 0);
    assert.equal(pos.decorate({}), 0);
});
