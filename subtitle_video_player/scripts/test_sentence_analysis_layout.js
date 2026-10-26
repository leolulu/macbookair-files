// Visual regressions for reported label/underline collisions. Uses existing Playwright and Chrome.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'test-results', 'sentence-analysis-layout');
const temp = path.join(output, 'tmp');
fs.mkdirSync(temp, { recursive: true });
process.env.TEMP = temp; process.env.TMP = temp;
const { chromium } = require(process.env.SVP_PLAYWRIGHT || 'playwright');
const cases = [
    {
        source: 'She knocked it out of the sky?', translation: '她把那东西从天上打了下来？',
        annotations: [
            { text: 'She', type: 'subject' },
            { text: 'knocked', type: 'predicate', obstacle: 'split' },
            { text: 'it', type: 'object' },
            { text: 'out', type: 'predicate', obstacle: 'split', note: '与 knocked 一起构成拆分的动词结构。' },
            { text: 'of the sky', type: 'adverbial' }
        ], issues: []
    },
    {
        source: 'Why would you try to hole up in a forward position?', translation: '你为什么要试图固守在一个前沿阵地？',
        annotations: [
            { text: 'Why', type: 'adverbial' },
            { text: 'would', type: 'predicate' },
            { text: 'you', type: 'subject' },
            { text: 'try', type: 'predicate' },
            { text: 'to hole up', type: 'object', form: 'infinitive', head: 'try', uncertain: false },
            { text: 'hole up', type: 'predicate', form: 'infinitive', note: '表示躲藏或固守；与前面的 to 一起构成不定式。' },
            { text: 'in a forward position', type: 'adverbial' }
        ], issues: []
    }
];

async function inspect(page) {
    return page.evaluate(() => {
        const root = document.querySelector('.svp-sa');
        const box = root.getBoundingClientRect();
        const glyphs = [...root.querySelectorAll('.sa-sentence .sa-text')].flatMap(node => {
            const range = document.createRange(); range.selectNodeContents(node);
            return [...range.getClientRects()].map(r => ({ left: r.left, right: r.right, top: r.top, bottom: r.bottom }));
        });
        const tags = [...root.querySelectorAll('.sa-tag')].filter(node => node.getClientRects().length).map(node => {
            const r = node.getBoundingClientRect();
            return { text: node.textContent, left: r.left, right: r.right, top: r.top, bottom: r.bottom };
        });
        const intersects = (a, b, gap = 0) => a.left < b.right && a.right > b.left && a.top < b.bottom + gap && a.bottom + gap > b.top;
        return {
            tags, overflow: root.scrollWidth > root.clientWidth + 1,
            borders: [...root.querySelectorAll('.sa-selection')].map(n => getComputedStyle(n).borderBottomWidth),
            textCollisions: tags.flatMap(t => glyphs.filter(g => intersects(t, g, 4)).map(g => ({ tag: t.text, tagRect: t, glyph: g }))),
            tagCollisions: tags.flatMap((t, i) => tags.slice(i + 1).filter(other => intersects(t, other)).map(other => [t.text, other.text])),
            outOfBounds: tags.filter(t => t.left < box.left - 1 || t.right > box.right + 1)
        };
    });
}

async function geometry(page) {
    return page.evaluate(() => {
        const root = document.querySelector('.svp-sa'), scroller = document.querySelector('#aiChatMessages');
        const rect = node => {
            const r = node.getBoundingClientRect();
            return [r.x, r.y, r.width, r.height].map(n => Math.round(n * 10) / 10);
        };
        return {
            card: rect(root), sentence: rect(root.querySelector('.sa-sentence')),
            tools: rect(root.querySelector('.sa-tools')), translation: rect(root.querySelector('.sa-translation')),
            scrollTop: scroller.scrollTop, scrollHeight: scroller.scrollHeight,
            words: [...root.querySelectorAll('.sa-sentence .sa-text')].map(rect)
        };
    });
}

async function checkFloatingTip(page) {
    const targets = page.locator('.sa-sentence [data-sa-annotation]');
    for (let i = 0; i < await targets.count(); i++) {
        const target = targets.nth(i).locator(':scope > .sa-text').first();
        if (!await target.count()) continue;
        await page.mouse.move(1100, 1050);
        await page.evaluate(() => layoutPanel.clearTip());
        await target.scrollIntoViewIfNeeded();
        const before = await geometry(page);
        await target.hover();
        assert.equal(await page.locator('.sa-tip').isVisible(), true);
        assert.deepEqual(await geometry(page), before, 'hover preserves text, controls, card size and scrolling');
        await target.click();
        await page.mouse.move(1100, 1050);
        assert.equal(await page.locator('.sa-tip').isVisible(), true);
        assert.deepEqual(await geometry(page), before, 'pinning preserves the document flow');
        await page.keyboard.press('Escape');
        assert.deepEqual(await geometry(page), before, 'closing preserves the document flow');
    }
}

async function main() {
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    const report = [];
    try {
        for (const file of ['subtitle_video_player.html', 'subtitle_video_player.single.html']) {
            const context = await browser.newContext({ viewport: { width: 1280, height: 1100 }, reducedMotion: 'reduce' });
            const page = await context.newPage();
            const errors = [];
            page.on('pageerror', e => errors.push(e.message));
            await page.addInitScript(() => {
                const original = window.fetch;
                window.fetch = (url, options) => String(url).endsWith('/models') ? Promise.resolve(Response.json({ providers: [] })) : original(url, options);
            });
            await page.goto(pathToFileURL(path.join(root, file)).href);
            await page.waitForFunction(() => !!window.SvpSentenceAnalysis);
            await page.evaluate(() => {
                const windowNode = document.querySelector('#aiChatWindow');
                windowNode.hidden = false;
                Object.assign(windowNode.style, { left: '20px', top: '20px', bottom: 'auto', width: '900px', height: '1000px' });
                window.layoutController = SvpSentenceAnalysis.createController(window, document.querySelector('#aiChatMessages'));
            });
            for (const [index, data] of cases.entries()) {
                await page.evaluate(data => {
                    layoutController.reset();
                    const container = document.querySelector('#aiChatMessages');
                    const message = document.createElement('div'); message.className = 'ai-chat-msg ai-chat-msg-ai';
                    message.style.maxWidth = 'none'; container.replaceChildren(message);
                    window.layoutPanel = layoutController.mount(message, { source: data.source, selection: data.source, selectionStart: 0, selectionEnd: data.source.length, notes: [], startIdx: 0, endIdx: 0 });
                }, data);
                assert.ok((await inspect(page)).borders.every(value => value === '0px'), 'selection underline absent while generating');
                await page.evaluate(data => layoutPanel.update(JSON.stringify(data), 'done'), data);
                for (const fontSize of [16, 22]) {
                    for (const width of [280, 340, 520, 720]) {
                        await page.evaluate(({ width, fontSize }) => {
                            document.querySelector('.svp-sa').style.width = width + 'px';
                            document.querySelector('.sa-sentence').style.fontSize = fontSize + 'px';
                        }, { width, fontSize });
                        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
                        await page.mouse.move(1100, 1050);
                        await page.evaluate(() => layoutPanel.clearTip());
                        const state = await inspect(page);
                        assert.deepEqual(state.textCollisions, [], JSON.stringify({ file, index, width, fontSize, state }));
                        assert.deepEqual(state.tagCollisions, []);
                        assert.deepEqual(state.outOfBounds, []);
                        assert.equal(state.overflow, false, JSON.stringify({ file, index, width, fontSize, state }));
                        assert.ok(state.tags.length > 0, 'labels remain visible when space is available');
                        assert.ok(state.borders.every(value => value === '0px'));
                        await checkFloatingTip(page);
                        if (fontSize === 22 && (width === 340 || width === 720)) {
                            await page.locator('.svp-sa').screenshot({ path: path.join(output, file + '-' + index + '-' + width + '.png') });
                        }
                        report.push({ file, sentence: index + 1, width, fontSize, visibleLabels: state.tags.length, result: 'passed' });
                    }
                }
                const tag = page.locator('.sa-tag:visible').first();
                await page.getByRole('button', { name: '只看主干', exact: true }).click();
                await page.getByRole('button', { name: '只看主干', exact: true }).click();
                assert.equal((await inspect(page)).textCollisions.length, 0);
                await tag.waitFor();
            }
            assert.deepEqual(errors, []);
            await context.close();
        }
        fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
        console.log('Passed ' + report.length + ' layout cases, including hover/pin/close document-flow and scroll stability.');
    } finally {
        await browser.close();
        const resolved = fs.realpathSync(temp);
        if (resolved.startsWith(fs.realpathSync(root) + path.sep)) fs.rmSync(resolved, { recursive: true, force: true });
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
