// Uses an existing Playwright installation; no browser download or live AI request.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'test-results', 'sentence-analysis');
const temp = path.join(output, 'tmp');
fs.mkdirSync(temp, { recursive: true });
process.env.TEMP = temp;
process.env.TMP = temp;
const { chromium } = require(process.env.SVP_PLAYWRIGHT || 'playwright');
const fixture = require('../test/fixtures/sentence_analysis');

async function mock(page) {
    await page.addInitScript((fixture) => {
        window.saTest = { fixture, mode: 'success', requests: [], leaks: [], spoken: [], cancelled: 0 };
        Object.defineProperty(window, 'speechSynthesis', { value: {
            getVoices: () => [{ lang: 'en-US', name: 'Test English', default: true }],
            addEventListener: () => {},
            speak: utterance => { saTest.spoken.push(utterance.text); saTest.utterance = utterance; setTimeout(() => utterance.onstart?.(), 20); },
            cancel: () => { saTest.cancelled++; }
        } });
        window.SpeechSynthesisUtterance = function (text) { this.text = text; };
        const originalFetch = window.fetch;
        window.fetch = async (url, options) => {
            if (String(url).endsWith('/models')) return Response.json({ providers: [{ id: 'test', models: ['test'] }] });
            if (!String(url).endsWith('/stream')) return originalFetch(url, options);
            const payload = JSON.parse(options.body);
            saTest.requests.push(payload);
            const mode = saTest.mode;
            const isAnalysis = payload.user_message.includes('【句子解析】');
            const source = isAnalysis ? JSON.parse(payload.user_message.split('<句子资料>\n')[1].split('\n</句子资料>')[0]).source : '';
            let result = { ...fixture };
            if (source !== fixture.source && isAnalysis) {
                result = { annotations: [{ text: source.replace(/[.!?]$/, ''), type: 'subject' }], translation: '范围调整测试', issues: ['示例中只用于核对调整后的原文。'] };
            }
            if (mode === 'xss') result = { ...result, translation: '<img src=x onerror="window.saXss=true">', issues: ['<script>window.saXss=true</script>'] };
            if (mode === 'nestedtags') result = { ...result, annotations: [...result.annotations, { text: 'fearing', type: 'adverbial', form: 'present-participle' }] };
            const answer = !isAnalysis ? '这是后续解释。 **sent** 表示被发送的。' : mode === 'invalid' ? '{"annotations": broken' : JSON.stringify(result);
            const encoder = new TextEncoder();
            return new Response(new ReadableStream({ start(controller) {
                let offset = 0, closed = false, timer;
                const emit = event => controller.enqueue(encoder.encode('data: ' + JSON.stringify(event) + '\n\n'));
                options.signal.addEventListener('abort', () => {
                    if (!closed) { closed = true; clearTimeout(timer); controller.error(new DOMException('Aborted', 'AbortError')); }
                });
                function tick() {
                    if (closed) return;
                    emit({ type: 'delta', content: answer.slice(offset, offset + 97) }); offset += 97;
                    if (mode === 'stop') return;
                    if (mode === 'error') { emit({ type: 'error', message: '模拟网络中断' }); closed = true; controller.close(); return; }
                    if (offset < answer.length) timer = setTimeout(tick, 15);
                    else { emit({ type: 'done' }); closed = true; controller.close(); }
                }
                timer = setTimeout(tick, 60);
            } }), { headers: { 'Content-Type': 'text/event-stream' } });
        };
        document.addEventListener('DOMContentLoaded', () => {
            new MutationObserver(() => {
                if (/\{"annotations"/.test(document.querySelector('#aiChatMessages')?.textContent || '')) saTest.leaks.push('JSON leaked');
            }).observe(document.body, { subtree: true, childList: true, characterData: true });
        });
    }, fixture);
}

async function select(page, text, button = '#aiSelectionAnalyze') {
    await page.evaluate(text => {
        const walker = document.createTreeWalker(document.querySelector('#subtitles'), NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
            const at = node.textContent.indexOf(text);
            if (at < 0) continue;
            const range = document.createRange(); range.setStart(node, at); range.setEnd(node, at + text.length);
            getSelection().removeAllRanges(); getSelection().addRange(range);
            document.dispatchEvent(new Event('selectionchange')); return;
        }
        throw Error('No selection: ' + text);
    }, text);
    await page.waitForFunction(() => !document.querySelector('#aiSelectionBubble').hidden);
    await page.locator(button).click({ force: true });
}

async function done(page) {
    await page.waitForFunction(() => document.querySelector('#aiChatSend').textContent === '发送');
}

async function main() {
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    const report = [];
    try {
        for (const file of ['subtitle_video_player.html', 'subtitle_video_player.single.html']) {
            const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, reducedMotion: 'reduce', hasTouch: true });
            const page = await context.newPage();
            const errors = [];
            page.on('pageerror', err => errors.push(err.message));
            await mock(page);
            await page.route(/^https?:/, route => route.abort());
            await page.goto(pathToFileURL(path.join(root, file)).href);
            const srt = '1\n00:00:01,000 --> 00:00:04,000\nThe committee rejected the proposal submitted yesterday,\n\n2\n00:00:04,100 --> 00:00:10,000\nfearing that the plan, if implemented hastily, would undermine public trust.\n\n3\n00:00:12,000 --> 00:00:15,000\nPlease reconsider.\n';
            await page.locator('#videoFile').setInputFiles({ name: 'sentence-analysis.srt', mimeType: 'text/plain', buffer: Buffer.from(srt) });
            await page.waitForFunction(() => document.querySelector('#subtitles').textContent.includes('submitted'));
            await select(page, 'submitted');
            await done(page);
            const card = page.locator('.svp-sa').last();
            await card.locator('[data-sa-annotation]').first().waitFor();
            assert.equal(await card.locator('.sa-sentence .sa-text').evaluateAll(nodes => nodes.map(n => n.textContent).join('')), fixture.source);
            assert.equal(await card.locator('.sa-selection').innerText(), 'submitted');
            assert.equal(await card.locator('.sa-translation').innerText(), fixture.translation);
            assert.match(await card.locator('.sa-range-info').innerText(), /相邻字幕/);
            const initial = await page.evaluate(() => saTest.requests[0]);
            assert.equal(initial.preserve, true);
            assert.match(initial.user_message, /后续普通追问恢复自然语言/);
            assert.equal(await card.locator('.sa-issues').isVisible(), false);
            const formTag = card.locator('[data-sa-annotation="3"] > .sa-tag-anchor > .sa-tag');
            const senseTag = card.locator('[data-sa-annotation="4"] > .sa-tag-anchor > .sa-tag');
            const obstacleTag = card.locator('[data-sa-annotation="8"] > .sa-tag-anchor > .sa-tag');
            assert.equal(await formTag.getAttribute('data-sa-tag-kind'), 'form');
            assert.equal(await senseTag.getAttribute('data-sa-tag-kind'), 'sense');
            assert.equal(await obstacleTag.getAttribute('data-sa-tag-kind'), 'obstacle');
            assert.equal(await formTag.evaluate(n => getComputedStyle(n).color), 'rgb(104, 119, 134)');
            assert.equal(await senseTag.evaluate(n => getComputedStyle(n).color), 'rgb(128, 109, 143)');
            assert.equal(await obstacleTag.evaluate(n => getComputedStyle(n).color), 'rgb(23, 122, 83)', 'clause obstacles retain the clause color');

            const participle = card.locator('[data-sa-annotation="3"]');
            await participle.locator('.sa-text').first().hover();
            assert.equal(await card.locator('.sa-arrows path').count(), 2);
            assert.equal(await card.locator('.sa-linked').innerText(), 'proposal');
            assert.match(await card.locator('.sa-tip').innerText(), /过去分词/);
            assert.equal(await card.locator('[data-sa-annotation="0"] > .sa-text').first().evaluate(n => getComputedStyle(n).opacity), '0.34');
            await participle.locator('.sa-text').first().click();
            await card.locator('.sa-header strong').hover();
            assert.equal(await card.locator('.sa-tip').isVisible(), true, 'click pins tooltip');
            await participle.locator('.sa-text').first().click();
            assert.equal(await card.locator('.sa-tip').isVisible(), false, 'second click unpins');
            await card.locator('.sa-header strong').hover();

            const clause = card.locator('[data-sa-annotation="5"] > .sa-chip');
            await clause.hover();
            assert.match(await card.locator('.sa-tip').innerText(), /→ fearing/);
            assert.equal(await card.locator('.sa-arrows path').count(), 2);
            await clause.click();
            await page.keyboard.press('Escape');
            assert.equal(await card.locator('.sa-tip').isVisible(), false);
            await card.locator('.sa-header strong').hover();
            await card.locator('[data-sa-annotation="8"] > .sa-chip').hover();
            assert.match(await card.locator('.sa-tip').innerText(), /还原.*if the plan was implemented hastily/);
            assert.equal(await clause.evaluate(n => getComputedStyle(n).opacity), '1', 'outer clause badge stays visible');
            assert.equal(await card.locator('.sa-arrows path').count(), 0);

            await card.getByRole('button', { name: '只看主干', exact: true }).click();
            await card.getByRole('button', { name: '断句', exact: true }).click();
            assert.equal(await card.locator('[data-sa-annotation="3"] > .sa-text').first().isVisible(), false);
            assert.equal(await card.getByRole('button', { name: '只看主干', exact: true }).getAttribute('aria-pressed'), 'true');
            await card.getByRole('button', { name: '只看主干', exact: true }).click();
            assert.ok(await card.locator('.sa-slash:visible').count() > 0);
            await card.getByRole('button', { name: '断句', exact: true }).click();

            await card.getByRole('button', { name: '朗读', exact: true }).click();
            assert.equal(await page.evaluate(() => saTest.spoken.at(-1)), fixture.source);
            await card.getByRole('button', { name: '停止朗读', exact: true }).click();
            assert.ok(await page.evaluate(() => saTest.cancelled > 0));
            await card.getByRole('button', { name: '朗读', exact: true }).focus();
            await page.keyboard.press('Tab');
            assert.match(await card.locator('.sa-tip').innerText(), /主语/);
            await page.keyboard.press('Escape');
            assert.equal(await card.locator('.sa-tip').isVisible(), false);
            await card.locator('.sa-header strong').hover();
            await clause.hover();
            await clause.click();
            await card.screenshot({ path: path.join(output, file + '-desktop.png') });

            await page.setViewportSize({ width: 390, height: 844 });
            await card.locator('.sa-header strong').hover();
            await clause.hover();
            assert.ok(await card.evaluate(n => n.scrollWidth <= n.clientWidth + 2), 'no card overflow on narrow screen');
            const bubble = await card.locator('.sa-tip').boundingBox(), box = await card.boundingBox();
            assert.ok(bubble.x >= box.x && bubble.x + bubble.width <= box.x + box.width + 2, 'tooltip fits card');
            assert.equal(await card.locator('.sa-arrows path').count(), 2);
            await card.screenshot({ path: path.join(output, file + '-mobile.png') });
            await card.locator('.sa-header strong').tap();
            await clause.tap();
            assert.equal(await card.locator('.sa-tip').isVisible(), true, 'touch opens tooltip');
            await clause.tap();
            assert.equal(await card.locator('.sa-tip').isVisible(), false, 'touch closes tooltip');
            await page.evaluate(() => document.body.setAttribute('data-theme', 'dark'));
            assert.equal(await card.locator('[data-sa-annotation="1"] > .sa-text').evaluate(n => getComputedStyle(n).color), 'rgb(134, 166, 255)');
            assert.equal(await formTag.evaluate(n => getComputedStyle(n).color), 'rgb(167, 176, 188)');
            assert.equal(await senseTag.evaluate(n => getComputedStyle(n).color), 'rgb(194, 176, 209)');
            await page.evaluate(() => document.body.removeAttribute('data-theme'));
            await page.setViewportSize({ width: 1280, height: 1000 });

            await page.locator('#aiChatInput').fill('这里为什么用过去分词？');
            await page.locator('#aiChatSend').click(); await done(page);
            assert.equal(await page.locator('.svp-sa').count(), 1);
            assert.match(await page.locator('.ai-chat-msg-ai').last().innerText(), /后续解释/);
            assert.equal(await page.evaluate(() => saTest.requests.at(-1).id), initial.id);
            assert.doesNotMatch(await page.evaluate(() => saTest.requests.at(-1).user_message), /仅本轮返回 JSON/);

            await card.locator('summary').click();
            await card.locator('textarea').fill('Please reconsider.');
            await card.getByRole('button', { name: '重新解析', exact: true }).click(); await done(page);
            assert.match(await page.locator('.svp-sa').last().innerText(), /范围调整测试/);
            assert.equal(await page.locator('.svp-sa').count(), 2);

            for (const mode of ['invalid', 'error', 'stop', 'xss', 'nestedtags']) {
                await page.evaluate(mode => { saTest.mode = mode; }, mode);
                await select(page, 'submitted');
                if (mode === 'stop') {
                    await page.waitForFunction(() => document.querySelector('#aiChatSend').textContent === '停止');
                    await page.locator('#aiChatSend').click();
                }
                await done(page);
                const last = page.locator('.ai-chat-msg-ai').last();
                if (mode === 'invalid' || mode === 'error') {
                    assert.equal(await last.getByRole('button', { name: '重试', exact: true }).count(), 1);
                    const before = await page.evaluate(() => saTest.requests.at(-1).user_message);
                    await page.evaluate(() => { saTest.mode = 'success'; });
                    await last.getByRole('button', { name: '重试', exact: true }).click(); await done(page);
                    assert.equal(await last.locator('.sa-translation').innerText(), fixture.translation);
                    assert.equal(await page.evaluate(() => saTest.requests.at(-1).user_message), before);
                } else if (mode === 'stop') assert.match(await last.innerText(), /解析已停止/);
                else if (mode === 'xss') {
                    assert.equal(await last.locator('img,script').count(), 0);
                    assert.match(await last.innerText(), /<img/);
                    assert.equal(await page.evaluate(() => !!window.saXss), false);
                } else {
                    assert.equal(await last.locator('[data-sa-annotation="4"] > .sa-tag-anchor > .sa-tag').count(), 1);
                    assert.equal(await last.locator('[data-sa-annotation="13"] > .sa-tag-anchor > .sa-tag').count(), 0);
                }
            }
            assert.deepEqual(await page.evaluate(() => saTest.leaks), []);
            await page.locator('#aiChatNewConversation').click();
            assert.equal(await page.locator('.svp-sa').count(), 0);
            assert.deepEqual(errors, []);
            report.push({ file, result: 'passed', coverage: ['cross-cue scope', 'original text and selection', 'nested annotations', 'hover arrows', 'pin/unpin/Escape', 'keyboard focus', 'touch pin/unpin', 'dark theme', 'semantic tag colors', 'nested dimming', 'trunk and slashes', 'speech lifecycle mock', '390px layout', 'follow-up conversation', 'range editing', 'malformed output retry', 'network error retry', 'stop', 'safe text rendering', 'no streamed JSON leak', 'new conversation cleanup'] });
            await context.close();
        }
        fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
        console.log(JSON.stringify(report, null, 2));
    } finally {
        await browser.close();
        const resolved = fs.realpathSync(temp);
        if (resolved.startsWith(fs.realpathSync(root) + path.sep)) fs.rmSync(resolved, { recursive: true, force: true });
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
