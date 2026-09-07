// Run with Playwright available, or set SVP_PLAYWRIGHT to its module directory.
const { chromium } = require(process.env.SVP_PLAYWRIGHT || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function installMock(page) {
    await page.addInitScript(() => {
        window.cocaTest = { mode: 'success', requests: [], leaks: [], previousMarker: '' };
        const original = window.fetch;
        window.fetch = async (url, options) => {
            if (String(url).endsWith('/models')) return Response.json({ providers: [{ id: 'mock', models: ['mock'] }] });
            if (!String(url).endsWith('/stream')) return original(url, options);
            const state = window.cocaTest;
            const payload = JSON.parse(options.body);
            state.requests.push(payload);
            const match = /\[\[COCA:([a-z0-9]+):候选ID\]\]/.exec(payload.user_message);
            let marker = '';
            let chosen;
            if (match) {
                const candidates = JSON.parse(payload.user_message.slice(payload.user_message.lastIndexOf('\n') + 1));
                const sentence = /出处[^\n]+/.exec(payload.user_message)?.[0] || '';
                const pos = sentence.includes('He is running.') ? 'v' : sentence.includes('Running is fun.') ? 'n' : 'j';
                chosen = candidates.find(c => c.pos === pos && ['running', 'run'].includes(c.word)) || candidates.find(c => c.match.endsWith('_reference')) || candidates[0];
                marker = `[[COCA:${match[1]}:${chosen.candidate_id}]]`;
                state.previousMarker = marker;
            }
            if (state.mode === 'followup') marker = state.previousMarker;
            const mode = state.mode;
            const encoder = new TextEncoder();
            const stream = new ReadableStream({
                start(controller) {
                    let closed = false;
                    options.signal.addEventListener('abort', () => {
                        if (!closed) { closed = true; controller.error(new DOMException('Aborted', 'AbortError')); }
                    });
                    const emit = (event) => {
                        if (!closed) controller.enqueue(encoder.encode('data: ' + JSON.stringify(event) + '\n\n'));
                    };
                    emit({ type: 'delta', content: '1. 这里表示持续发生的。\n\n2. **' + (chosen ? chosen.surface : 'running') + '** 是当前讲解的核心词' + marker.slice(0, 5) });
                    if (mode === 'stop') return;
                    setTimeout(() => {
                        if (closed) return;
                        if (mode === 'fail') {
                            emit({ type: 'error', message: '模拟连接中断 [[COCA:bad:c1]]' });
                        } else {
                            emit({ type: 'delta', content: marker.slice(5) + '，表示持续发生的。\n\n3. 本句说明持续发生的费用。 [00:01]' });
                            emit({ type: 'done' });
                        }
                        closed = true;
                        controller.close();
                    }, 300);
                }
            });
            return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
        };
        document.addEventListener('DOMContentLoaded', () => {
            new MutationObserver(() => {
                const text = document.querySelector('#aiChatMessages')?.textContent || '';
                if (/\[\[COCA|候选ID/.test(text)) window.cocaTest.leaks.push(text);
            }).observe(document.body, { childList: true, subtree: true, characterData: true });
        });
    });
}

async function selectLookup(page, text = 'running', sentence = '') {
    await page.evaluate(({ text, sentence }) => {
        const walker = document.createTreeWalker(document.querySelector('#subtitles'), NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
            const index = node.textContent.indexOf(text);
            if (index < 0 || (sentence && !node.textContent.includes(sentence))) continue;
            const range = document.createRange();
            range.setStart(node, index);
            range.setEnd(node, index + text.length);
            window.getSelection().removeAllRanges();
            window.getSelection().addRange(range);
            document.dispatchEvent(new Event('selectionchange'));
            return;
        }
        throw new Error('Selection text not found: ' + text);
    }, { text, sentence });
    await page.waitForFunction(() => !document.querySelector('#aiSelectionBubble').hidden);
    await page.locator('#aiSelectionLookup').click({ force: true });
}

async function waitFinished(page) {
    await page.waitForFunction(() => document.querySelector('#aiChatSend').textContent === '发送');
}

async function main() {
    const output = fs.mkdtempSync(path.join(os.tmpdir(), 'svp-coca-browser-'));
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    const report = [];
    try {
        for (const file of ['subtitle_video_player.html', 'subtitle_video_player.single.html']) {
            const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
            const page = await context.newPage();
            const errors = [];
            page.on('pageerror', error => errors.push(error.message));
            await installMock(page);
            await page.goto(pathToFileURL(path.resolve(__dirname, '..', file)).href);
            await page.locator('#videoFile').setInputFiles({ name: 'coca-check.srt', mimeType: 'text/plain',
                buffer: Buffer.from('1\n00:00:01,000 --> 00:00:05,000\nOur running costs grow.\n\n2\n00:00:06,000 --> 00:00:10,000\nHe is running.\n\n3\n00:00:11,000 --> 00:00:14,000\nHe spoke algebraically.\n\n4\n00:00:15,000 --> 00:00:19,000\nRunning is fun.\n') });
            await page.waitForFunction(() => document.querySelector('#subtitles').textContent.includes('running'));
            await page.evaluate(() => {
                const load = SvpCocaRank.load;
                SvpCocaRank.load = async () => {
                    const start = performance.now();
                    const data = await load();
                    cocaTest.timings = (cocaTest.timings || []).concat(performance.now() - start);
                    return data;
                };
            });
            await selectLookup(page);
            await waitFinished(page);
            const reply = page.locator('.ai-chat-msg-ai').last();
            assert.match(await reply.innerText(), /running·形容词，COCA 排名第 3273 位/);
            assert.equal(await page.evaluate(() => cocaTest.requests.length), 1);
            assert.equal(await reply.locator('.ai-chat-time-link').count(), 1);
            const first = await page.evaluate(() => cocaTest.requests[0]);
            assert.ok(first.user_message.includes('本轮本地 COCA 候选'));
            assert.ok(!first.system_message.includes('COCA'));
            assert.ok(!first.user_message.includes('"freq"'));
            await page.screenshot({ path: path.join(output, file + '-desktop.png') });

            await page.evaluate(() => { cocaTest.mode = 'followup'; });
            await page.locator('#aiChatInput').fill('进一步解释');
            await page.locator('#aiChatSend').click();
            await waitFinished(page);
            assert.doesNotMatch(await page.locator('.ai-chat-msg-ai').last().innerText(), /\[\[COCA|第 3273/);
            assert.ok(!await page.evaluate(() => cocaTest.requests.at(-1).user_message.includes('本轮本地 COCA')));

            await page.evaluate(() => { cocaTest.mode = 'stop'; });
            await selectLookup(page);
            await page.waitForFunction(() => cocaTest.requests.length === 3);
            await page.locator('#aiChatSend').click();
            await waitFinished(page);
            assert.doesNotMatch(await page.locator('.ai-chat-msg-ai').last().innerText(), /\[\[|COCA/);

            await page.evaluate(() => { cocaTest.mode = 'fail'; });
            await selectLookup(page);
            await page.locator('.ai-chat-retry-btn').waitFor();
            assert.doesNotMatch(await page.locator('.ai-chat-msg-ai').last().innerText(), /\[\[|COCA/);
            const failedPayload = await page.evaluate(() => cocaTest.requests.at(-1).user_message);
            await page.evaluate(() => { cocaTest.mode = 'success'; });
            await page.locator('.ai-chat-retry-btn').click();
            await waitFinished(page);
            assert.equal(await page.evaluate(() => cocaTest.requests.at(-1).user_message), failedPayload);
            assert.match(await page.locator('.ai-chat-msg-ai').last().innerText(), /第 3273 位/);

            await selectLookup(page, 'running costs');
            await waitFinished(page);
            assert.match(await page.locator('.ai-chat-msg-ai').last().innerText(), /running·形容词，COCA 排名第 3273 位/);
            assert.doesNotMatch(await page.locator('.ai-chat-msg-ai').last().innerText(), /costs·.*COCA/);

            await selectLookup(page, 'running', 'He is running.');
            await waitFinished(page);
            assert.match(await page.locator('.ai-chat-msg-ai').last().innerText(), /原形 run·动词，COCA 排名第 202 位/);
            await selectLookup(page, 'Running', 'Running is fun.');
            await waitFinished(page);
            assert.match(await page.locator('.ai-chat-msg-ai').last().innerText(), /running·名词，COCA 排名第 4719 位/);
            await selectLookup(page, 'algebraically');
            await waitFinished(page);
            assert.match(await page.locator('.ai-chat-msg-ai').last().innerText(), /参考 algebraic 的形容词/);

            await page.evaluate(() => {
                cocaTest.savedLoad = SvpCocaRank.load;
                SvpCocaRank.load = () => Promise.reject(new Error('test missing data'));
            });
            await selectLookup(page);
            await waitFinished(page);
            assert.doesNotMatch(await page.locator('.ai-chat-msg-ai').last().innerText(), /COCA|\[\[/);
            assert.ok(!await page.evaluate(() => cocaTest.requests.at(-1).user_message.includes('本轮本地 COCA')));
            await page.evaluate(() => { SvpCocaRank.load = cocaTest.savedLoad; });

            await page.evaluate(() => {
                SvpCocaRank.load = () => new Promise(resolve => { cocaTest.resolveLoad = resolve; });
            });
            const beforeCancelledLoad = await page.evaluate(() => cocaTest.requests.length);
            await selectLookup(page);
            await page.locator('#aiChatNewConversation').click();
            await page.evaluate(async () => {
                SvpCocaRank.load = cocaTest.savedLoad;
                cocaTest.resolveLoad(await SvpCocaRank.load());
            });
            await waitFinished(page);
            assert.equal(await page.evaluate(() => cocaTest.requests.length), beforeCancelledLoad);
            assert.equal(await page.locator('.ai-chat-msg').count(), 0);

            await selectLookup(page);
            await waitFinished(page);
            await page.setViewportSize({ width: 390, height: 844 });
            await page.screenshot({ path: path.join(output, file + '-mobile.png') });
            const overflow = await page.locator('.ai-chat-msg-ai').last().evaluate(el => el.scrollWidth > el.clientWidth + 1);
            assert.equal(overflow, false);
            const stats = await page.evaluate(() => ({ timings: cocaTest.timings, requests: cocaTest.requests.length, leaks: cocaTest.leaks }));
            assert.deepEqual(stats.leaks, []);
            assert.deepEqual(errors, []);
            report.push({ file, ...stats, errors, bytes: fs.statSync(path.resolve(__dirname, '..', file)).size });
            await context.close();
        }
    } finally {
        await browser.close();
    }
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ output, report }, null, 2));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
