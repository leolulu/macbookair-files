// Uses existing Playwright and Chrome, isolated profiles, and a controlled mock backend.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const singleHtml = process.env.SVP_SINGLE_HTML || path.join(root, 'subtitle_video_player.single.html');
const output = path.join(root, 'test-results', 'ai-queue');
const temp = path.join(output, 'tmp');
fs.mkdirSync(temp, { recursive: true }); process.env.TEMP = temp; process.env.TMP = temp;
const { chromium } = require(process.env.SVP_PLAYWRIGHT || 'playwright');
const fixture = require('../test/fixtures/sentence_analysis');
const report = [];

async function mock(page) {
    await page.addInitScript(fixture => {
        window.queueTest = { requests: [], entries: [], results: [], nextMode: 'success', active: null, live: 0, maxLive: 0, histories: {} };
        const original = window.fetch;
        window.fetch = async (url, options) => {
            if (String(url).endsWith('/models')) return Response.json({ providers: [{ id: 'mock', models: ['mock-model'] }] });
            if (!String(url).endsWith('/stream')) return original(url, options);
            const payload = JSON.parse(options.body), mode = queueTest.nextMode; queueTest.nextMode = 'success';
            const record = { payload, url: String(url), previous: [...(queueTest.histories[payload.id] || [])] };
            queueTest.requests.push(record);
            queueTest.live++; queueTest.maxLive = Math.max(queueTest.maxLive, queueTest.live);
            const entry = { closed: false, logicalClosed: false, ignoreAbort: false };
            queueTest.entries.push(entry); queueTest.active = entry;
            const end = () => { if (!entry.logicalClosed) { entry.logicalClosed = true; queueTest.live--; } };
            const analysis = payload.user_message.includes('【句子解析】');
            const source = analysis ? JSON.parse(payload.user_message.split('<句子资料>\n')[1].split('\n</句子资料>')[0]).source : '';
            const result = source === fixture.source ? fixture : { annotations: [{ text: source.replace(/[.!?]$/, ''), type: 'subject' }], translation: '队列解析结果', issues: [] };
            const answer = mode === 'empty' ? '' : analysis ? JSON.stringify(result) : '这是一次完整回复。';
            const encoder = new TextEncoder();
            return new Response(new ReadableStream({ start(controller) {
                const emit = event => { if (!entry.closed) controller.enqueue(encoder.encode('data: ' + JSON.stringify(event) + '\n\n')); };
                emit({ type: 'delta', content: answer.slice(0, 5) });
                entry.finish = () => {
                    if (entry.closed) return;
                    if (mode === 'error') emit({ type: 'error', message: '模拟队列请求失败' });
                    else {
                        emit({ type: 'delta', content: answer.slice(5) }); emit({ type: 'done' });
                        (queueTest.histories[payload.id] ||= []).push(payload.user_message);
                    }
                    entry.closed = true; end(); controller.close();
                };
                options.signal.addEventListener('abort', () => {
                    end(); entry.aborted = true;
                    if (!entry.ignoreAbort && !entry.closed) { entry.closed = true; controller.error(new DOMException('Aborted', 'AbortError')); }
                });
            } }), { headers: { 'Content-Type': 'text/event-stream' } });
        };
        document.addEventListener('DOMContentLoaded', () => {
            let time = 2;
            Object.defineProperty(document.querySelector('#video'), 'currentTime', { get: () => time, set: value => { time = value; } });
            const seen = new Set();
            new MutationObserver(() => {
                document.querySelectorAll('#toastContainer [data-toast-key^="ai-request-status-result-"]').forEach(node => {
                    if (seen.has(node.dataset.toastKey)) return;
                    seen.add(node.dataset.toastKey); queueTest.results.push(node.textContent);
                });
            }).observe(document.querySelector('#toastContainer'), { subtree: true, childList: true, characterData: true });
        });
    }, fixture);
}

const requests = page => page.evaluate(() => queueTest.requests.length);
const waitRequests = (page, number) => page.waitForFunction(number => queueTest.requests.length === number, number);
const waitPending = (page, number) => page.waitForFunction(number => document.querySelectorAll('[data-queue-item]').length === number, number);
const idle = page => page.waitForFunction(() => document.querySelector('#aiChatStop').hidden);
const rows = page => page.locator('[data-queue-item]');
async function show(page) { if (await page.locator('#aiChatWindow').evaluate(node => node.hidden)) await page.locator('#toggleAiChat').click(); }
async function hide(page) { if (!await page.locator('#aiChatWindow').evaluate(node => node.hidden)) await page.locator('#aiChatClose').click(); }
async function submit(page, text) { await show(page); await page.locator('#aiChatInput').fill(text); await page.locator('#aiChatInput').press('Enter'); }
async function finish(page, next = false) {
    await page.waitForFunction(() => queueTest.active && !queueTest.active.closed);
    const before = await requests(page); await page.evaluate(() => queueTest.active.finish());
    if (next) await waitRequests(page, before + 1); else await idle(page);
}
async function selectSubtitle(page, text = 'submitted') {
    await page.evaluate(text => {
        const walker = document.createTreeWalker(document.querySelector('#subtitles'), NodeFilter.SHOW_TEXT); let node;
        while ((node = walker.nextNode())) {
            const start = node.textContent.indexOf(text); if (start < 0) continue;
            const range = document.createRange(); range.setStart(node, start); range.setEnd(node, start + text.length);
            getSelection().removeAllRanges(); getSelection().addRange(range); document.dispatchEvent(new Event('selectionchange')); return;
        }
        throw Error('Missing selection: ' + text);
    }, text);
    await page.waitForFunction(() => !document.querySelector('#aiSelectionBubble').hidden);
}
async function selection(page, button, text = 'submitted') {
    await selectSubtitle(page, text);
    await page.locator(button).click({ force: true });
}
async function quickSelection(page, text = 'submitted') {
    await selectSubtitle(page, text);
    await page.locator('#aiSelectionQuickInput').waitFor({ state: 'visible' });
}
async function waitQuickOpacity(page, expected) {
    await page.waitForFunction(expected => {
        const activeSurface = document.querySelector('.ai-selection-quick-active-surface');
        const input = document.querySelector('#aiSelectionQuickInput');
        const button = document.querySelector('#aiSelectionQuickSend');
        const surfaceExpected = expected === 1 ? 1 : 0;
        return Math.abs(Number(getComputedStyle(activeSurface).opacity) - surfaceExpected) < 0.01
            && [input, button].every(node => Math.abs(Number(getComputedStyle(node).opacity) - expected) < 0.01);
    }, expected);
}
async function load(page, name = 'queue.srt') {
    const srt = '1\n00:00:01,000 --> 00:00:04,000\nThe committee rejected the proposal submitted yesterday,\n\n2\n00:00:04,100 --> 00:00:10,000\nfearing that the plan, if implemented hastily, would undermine public trust.\n\n3\n00:00:12,000 --> 00:00:15,000\nPlease reconsider.\n';
    await page.locator('#videoFile').setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from(srt) });
    await page.waitForFunction(() => document.querySelector('#subtitles').textContent.includes('submitted'));
}

async function verifySupSession(page, checks) {
    await page.evaluate(() => {
        const sup = queueTest.sup = { runs: [], cache: new Map() };
        const readAsText = FileReader.prototype.readAsText;
        FileReader.prototype.readAsText = function (file) {
            if (file.name !== 'delayed-before-sup.srt') return readAsText.apply(this, arguments);
            FileReader.prototype.readAsText = readAsText;
            sup.finishTextRead = () => this.onload({
                target: { result: '1\n00:00:01,000 --> 00:00:04,000\nSuperseded SRT text.\n\n' }
            });
        };
        window.SupOcrCache.get = async () => null;
        window.SupOcrCache.put = async entry => { sup.cache.set(entry.key, structuredClone(entry)); };
        window.SupPgsParser.parseSupPgsToCues = async () => [{ start: 1, end: 3 }, { start: 6, end: 8 }];
        window.PaddleSubtitleOcr.recognizeSupItems = (_items, update) => new Promise(resolve => {
            sup.runs.push({ update, resolve });
        });
        Object.defineProperty(document.querySelector('#video'), 'readyState', { value: 1, configurable: true });
    });
    const startSup = async (name, count) => {
        await page.locator('#videoFile').setInputFiles({ name, mimeType: 'application/octet-stream', buffer: Buffer.from('SUP test fixture') });
        await page.waitForFunction(count => queueTest.sup.runs.length === count, count);
    };
    const emit = (run, index, text, complete = false) => page.evaluate(({ run, index, text, complete }) => {
        const task = queueTest.sup.runs[run];
        task.update({ index, text, recognized: true });
        if (complete) task.resolve();
    }, { run, index, text, complete });

    await page.locator('#videoFile').setInputFiles({ name: 'delayed-before-sup.srt', mimeType: 'text/plain', buffer: Buffer.from('delayed read') });
    await page.waitForFunction(() => !!queueTest.sup.finishTextRead);
    await startSup('continuing.sup', 1);
    await page.evaluate(() => queueTest.sup.finishTextRead());
    assert.doesNotMatch(await page.locator('#subtitles').textContent(), /Superseded SRT text/);
    checks.push('a delayed text file read cannot replace a newer SUP subtitle list');
    await emit(0, 0, 'The first OCR line is ready.');
    await page.waitForFunction(() => document.querySelector('#subtitles').textContent.includes('first OCR line'));
    await submit(page, 'OCR 中途提问'); await finish(page);
    const supId = await page.evaluate(() => queueTest.requests.at(-1).payload.id);
    await selection(page, '#aiSelectionAnalyze', 'first OCR line'); await finish(page);

    await emit(0, 1, 'The final OCR line is now ready.', true);
    await submit(page, 'OCR 完成后追问'); await finish(page);
    const followup = await page.evaluate(() => queueTest.requests.at(-1));
    assert.equal(followup.payload.id, supId);
    assert.ok(followup.previous.includes('OCR 中途提问'));
    assert.match(followup.payload.system_message, /The final OCR line is now ready/);
    checks.push('SUP completion keeps the same chat history and includes new OCR text in the next request');

    const range = page.locator('.sa-range-editor').last();
    await range.locator('summary').click();
    await range.getByRole('button', { name: '加入后一条字幕' }).click();
    assert.match(await range.locator('textarea').inputValue(), /The final OCR line is now ready/);
    await range.getByRole('button', { name: '重新解析', exact: true }).click(); await finish(page);
    assert.equal(await page.evaluate(() => queueTest.requests.at(-1).payload.id), supId);
    checks.push('a sentence card can use newly recognized adjacent text in the same SUP list');

    await startSup('sup-before-replacement.sup', 2);
    await fresh(page);
    await emit(1, 0, 'OCR continues after starting a new chat.');
    await page.waitForFunction(() => document.querySelector('#subtitles').textContent.includes('OCR continues'));
    await load(page, 'replacement-after-ocr.srt');
    const newText = await page.locator('#subtitles').textContent();
    await emit(1, 1, 'Late OCR from the old SUP.', true);
    await page.waitForFunction(() => Array.from(queueTest.sup.cache.values()).some(entry =>
        entry.status === 'complete' && entry.cues[1].text === 'Late OCR from the old SUP.' && entry.cues[1].start === 6));
    assert.equal(await page.locator('#subtitles').textContent(), newText);
    await submit(page, '换字幕后的问题'); await finish(page);
    const replacement = await page.evaluate(() => queueTest.requests.at(-1));
    assert.notEqual(replacement.payload.id, supId);
    assert.match(replacement.payload.system_message, /proposal submitted yesterday/);
    assert.doesNotMatch(replacement.payload.system_message, /Late OCR from the old SUP/);
    await page.evaluate(() => { delete document.querySelector('#video').readyState; });
    checks.push('new chat leaves SUP recognition running and late OCR after a subtitle load only updates its original cache');
}

async function fresh(page) { await show(page); await page.locator('#aiChatNewConversation').click(); await idle(page); await waitPending(page, 0); }
async function moveChatWindow(page, left, top) {
    const box = await page.locator('#aiChatWindow').boundingBox();
    const handle = await page.locator('.ai-chat-header-drag-space').boundingBox();
    const x = handle.x + handle.width / 2, y = handle.y + handle.height / 2;
    await page.mouse.move(x, y); await page.mouse.down();
    await page.mouse.move(x + left - box.x, y + top - box.y, { steps: 4 }); await page.mouse.up();
}
async function resizeChatWindow(page, width, height) {
    const box = await page.locator('#aiChatWindow').boundingBox();
    const handle = await page.locator('[data-resize-direction="se"]').boundingBox();
    const x = handle.x + handle.width / 2, y = handle.y + handle.height / 2;
    await page.mouse.move(x, y); await page.mouse.down();
    await page.mouse.move(x + width - box.width, y + height - box.height, { steps: 4 }); await page.mouse.up();
}
async function settleChatLayout(page) {
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function verifyFixedComposerLayout(page, file) {
    for (const pending of [1, 3]) {
        await fresh(page);
        await page.evaluate(() => {
            const message = document.createElement('div');
            message.className = 'ai-chat-msg ai-chat-msg-ai ai-chat-md';
            for (let index = 0; index < 60; index++) {
                const paragraph = document.createElement('p');
                paragraph.textContent = '长回复布局样本 ' + (index + 1) + '：这段内容用于确认消息区滚动不会挤压其他必要功能区域。';
                message.appendChild(paragraph);
            }
            document.querySelector('#aiChatMessages').appendChild(message);
        });
        await submit(page, '布局验证当前项 ' + pending);
        for (let index = 0; index < pending; index++) await submit(page, '布局验证待发送 ' + pending + '-' + index);
        await waitPending(page, pending);
        await hide(page); await show(page);
        const layout = await page.locator('#aiChatQueue').evaluate((node, expectedPending) => {
            const header = node.querySelector('.ai-chat-queue-header');
            const list = document.querySelector('#aiChatQueueList');
            const messages = document.querySelector('#aiChatMessages');
            const input = document.querySelector('.ai-chat-input-row');
            const queueBox = node.getBoundingClientRect(), headerBox = header.getBoundingClientRect();
            return {
                expectedPending,
                queueHeight: queueBox.height,
                queueBottom: queueBox.bottom,
                headerHeight: headerBox.height,
                headerBottom: headerBox.bottom,
                inputTop: input.getBoundingClientRect().top,
                inputBottom: input.getBoundingClientRect().bottom,
                windowBottom: document.querySelector('#aiChatWindow').getBoundingClientRect().bottom,
                listClientHeight: list.clientHeight,
                listScrollHeight: list.scrollHeight,
                messagesHeight: messages.clientHeight,
                messagesScrollHeight: messages.scrollHeight,
                messagesScrollTop: messages.scrollTop,
                settingsHidden: document.querySelector('#aiChatSettings').hidden,
                quoteHidden: document.querySelector('#aiChatQuoteChip').hidden
            };
        }, pending);
        await page.locator('#aiChatWindow').screenshot({ path: path.join(output, file + '-long-message-queue-' + pending + '.png') });
        assert.ok(layout.queueHeight + 1 >= layout.headerHeight
            && layout.headerBottom <= layout.queueBottom + 1
            && layout.headerBottom <= layout.inputTop + 1
            && layout.inputBottom <= layout.windowBottom + 1, JSON.stringify(layout));
        assert.ok(layout.listClientHeight + 1 >= layout.listScrollHeight, JSON.stringify(layout));
        assert.ok(layout.messagesHeight > 0 && layout.messagesScrollHeight > layout.messagesHeight, JSON.stringify(layout));
        assert.equal(layout.messagesScrollTop, 0, JSON.stringify(layout));
        assert.equal(layout.settingsHidden && layout.quoteHidden, true, JSON.stringify(layout));
        await page.locator('#aiChatQueueToggle').click();
        assert.equal(await page.locator('#aiChatQueueList').isVisible(), false);
        const collapsed = await page.locator('#aiChatQueue').evaluate(node => ({
            queueBottom: node.getBoundingClientRect().bottom,
            headerBottom: node.querySelector('.ai-chat-queue-header').getBoundingClientRect().bottom
        }));
        assert.ok(collapsed.headerBottom <= collapsed.queueBottom + 1, JSON.stringify(collapsed));
        await page.locator('#aiChatQueueToggle').click();
        assert.equal(await page.locator('#aiChatQueueList').isVisible(), true);
        await page.locator('#aiChatQueueClear').click(); await waitPending(page, 0); await finish(page);
    }
}
async function verifyComposerMinimumHeight(page, file) {
    const original = await page.locator('#aiChatWindow').boundingBox();
    await moveChatWindow(page, 16, 16);
    await resizeChatWindow(page, 420, 900);
    await submit(page, '最小高度当前项');
    for (let index = 0; index < 9; index++) await submit(page, '最小高度待发送 ' + index);
    await waitPending(page, 9);
    await selection(page, '#aiSelectionAsk');
    await page.locator('#aiChatInput').fill(Array(8).fill('保留多行输入草稿').join('\n'));
    await page.locator('#aiChatSettingsToggle').click();
    const readLayout = () => page.locator('#aiChatWindow').evaluate(node => {
        const box = element => {
            const rect = element.getBoundingClientRect();
            return { top: rect.top, bottom: rect.bottom, height: rect.height };
        };
        return {
            window: box(node), messages: box(document.querySelector('#aiChatMessages')),
            fixed: ['#aiChatHeader', '#aiChatSettings', '#aiChatQueue', '#aiChatQuoteChip', '.ai-chat-input-row']
                .map(selector => ({ selector, ...box(node.querySelector(selector)) }))
        };
    });
    const expanded = await readLayout();
    await resizeChatWindow(page, 420, 260);
    const minimum = await readLayout();
    assert.ok(minimum.window.height > 260 && minimum.window.height < expanded.window.height, JSON.stringify(minimum));
    assert.ok(minimum.messages.height < expanded.messages.height, JSON.stringify({ expanded, minimum }));
    minimum.fixed.forEach((region, index) => {
        assert.ok(Math.abs(region.height - expanded.fixed[index].height) < 1
            && region.top >= minimum.window.top - 1 && region.bottom <= minimum.window.bottom + 1,
        JSON.stringify({ region, expanded: expanded.fixed[index], minimum }));
    });
    await page.locator('#aiChatWindow').screenshot({ path: path.join(output, file + '-minimum-height.png') });
    for (const direction of ['n', 'ne', 's']) {
        const before = await page.locator('#aiChatWindow').boundingBox();
        const handle = await page.locator('[data-resize-direction="' + direction + '"]').boundingBox();
        const x = handle.x + handle.width / 2, y = handle.y + handle.height / 2;
        await page.mouse.move(x, y); await page.mouse.down();
        await page.mouse.move(x + (direction === 'ne' ? 40 : 0), y + (direction === 's' ? -200 : 200), { steps: 4 });
        await page.mouse.up();
        const resized = await readLayout();
        const anchoredEdge = direction === 's' ? 'top' : 'bottom';
        const expectedEdge = direction === 's' ? before.y : before.y + before.height;
        assert.ok(Math.abs(resized.window[anchoredEdge] - expectedEdge) < 1, JSON.stringify({ direction, before, resized }));
        resized.fixed.forEach(region => assert.ok(region.top >= resized.window.top - 1
            && region.bottom <= resized.window.bottom + 1, JSON.stringify({ direction, region, resized })));
    }
    await page.locator('#aiChatSettingsToggle').click();
    await page.locator('#aiChatQuoteRemove').click();
    await page.locator('#aiChatInput').fill('');
    await page.locator('#aiChatQueueClear').click(); await waitPending(page, 0); await finish(page);
    await resizeChatWindow(page, original.width, original.height);
    await moveChatWindow(page, original.x, original.y);
    await hide(page); await show(page);
}
async function verifyGeometryMemory(page, file) {
    const originalViewport = page.viewportSize();
    const original = await page.locator('#aiChatWindow').boundingBox();
    await fresh(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await moveChatWindow(page, 16, 264);
    await submit(page, '尺寸记忆当前项'); await submit(page, '尺寸记忆待发送'); await waitPending(page, 1);
    const readLayout = () => page.locator('#aiChatWindow').evaluate(node => {
        const box = element => {
            const rect = element.getBoundingClientRect();
            return { top: rect.top, bottom: rect.bottom, height: rect.height, width: rect.width };
        };
        return {
            window: box(node), viewportHeight: innerHeight,
            regions: ['#aiChatHeader', '#aiChatSettings', '#aiChatQueue', '.ai-chat-input-row', '#aiChatSend', '#aiChatStop']
                .map(selector => ({ selector, ...box(node.querySelector(selector)) })).filter(region => region.height > 0),
            stored: JSON.parse(localStorage.getItem('AI_CHAT_WINDOW_STATE_V1')).geometry
        };
    });
    const initial = await readLayout();
    await page.locator('#aiChatSettingsToggle').click(); await settleChatLayout(page);
    await page.waitForTimeout(400);
    const expanded = await readLayout();
    assert.ok(expanded.window.height > initial.window.height && expanded.window.bottom <= expanded.viewportHeight,
        JSON.stringify({ initial, expanded }));
    expanded.regions.forEach(region => assert.ok(region.top >= 0 && region.bottom <= expanded.viewportHeight,
        JSON.stringify({ region, expanded })));
    assert.equal(expanded.stored.height, initial.stored.height, JSON.stringify(expanded));
    await page.locator('#aiChatWindow').screenshot({ path: path.join(output, file + '-geometry-expanded.png') });
    await hide(page); await show(page); await settleChatLayout(page);
    const restored = await readLayout();
    assert.ok(Math.abs(restored.window.height - initial.window.height) < 1
        && Math.abs(restored.window.top - initial.window.top) < 1, JSON.stringify({ initial, restored }));
    await moveChatWindow(page, 16, 16);
    const moved = await readLayout();
    await page.locator('#aiChatSettingsToggle').click(); await settleChatLayout(page);
    const nearTop = await readLayout();
    assert.ok(Math.abs(nearTop.window.top - moved.window.top) < 1 && nearTop.window.bottom <= nearTop.viewportHeight,
        JSON.stringify({ moved, nearTop }));
    const drag = await page.locator('.ai-chat-header-drag-space').boundingBox();
    const x = drag.x + drag.width / 2, y = drag.y + drag.height / 2;
    await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x, y + 40, { steps: 4 });
    await finish(page, true); await settleChatLayout(page);
    const duringDrag = await readLayout();
    assert.ok(Math.abs(duringDrag.window.top - nearTop.window.top - 40) < 1, JSON.stringify({ nearTop, duringDrag }));
    await page.mouse.up();
    await submit(page, '拖动后的待发送'); await waitPending(page, 1);
    await hide(page); await show(page); await settleChatLayout(page);
    await resizeChatWindow(page, 420, 600);
    const resized = await readLayout();
    assert.ok(Math.abs(resized.window.height - 600) < 1 && resized.stored.height === 600, JSON.stringify(resized));
    await hide(page); await show(page);
    assert.ok(Math.abs((await readLayout()).window.height - resized.window.height) < 1);
    await page.locator('#aiChatQueueClear').click(); await waitPending(page, 0); await finish(page);
    await page.reload(); await load(page); await show(page);
    const reloaded = await readLayout();
    assert.ok(Math.abs(reloaded.window.height - resized.window.height) < 1
        && Math.abs(reloaded.window.top - resized.window.top) < 1, JSON.stringify({ resized, reloaded }));
    await page.setViewportSize(originalViewport);
    await resizeChatWindow(page, original.width, original.height);
    await moveChatWindow(page, original.x, original.y);
    await hide(page); await show(page);
}
async function action(page, index, action) { await rows(page).nth(index).locator('[data-queue-action="' + action + '"]').click(); }
async function background(page, autoOpen) {
    await show(page);
    if (await page.locator('#aiChatSettings').evaluate(node => node.hidden)) await page.locator('#aiChatSettingsToggle').click();
    await page.locator('#aiChatBackgroundRequest').check();
    await page.locator('#aiChatBackgroundAutoOpen').setChecked(autoOpen);
    await page.locator('#aiChatSettingsToggle').click();
}
async function backgroundLayout(page) {
    return page.evaluate(() => {
        const parent = document.querySelector('#aiChatBackgroundRequest').getBoundingClientRect();
        const child = document.querySelector('#aiChatBackgroundAutoOpen').getBoundingClientRect();
        return {
            height: document.querySelector('#aiChatSettings').getBoundingClientRect().height,
            nextTop: document.querySelector('.ai-chat-selection-bubble-setting').getBoundingClientRect().top,
            parentY: parent.y + parent.height / 2, childY: child.y + child.height / 2
        };
    });
}

async function watchVideoPause(page, initiallyPaused = false) {
    await page.evaluate(pausedAtStart => {
        const video = document.querySelector('#video');
        let paused = pausedAtStart;
        window.__svpVideoPauseCount = 0;
        Object.defineProperty(video, 'paused', { configurable: true, get: () => paused });
        video.pause = () => { paused = true; window.__svpVideoPauseCount++; };
    }, initiallyPaused);
}

async function restoreVideoPause(page) {
    return page.evaluate(() => {
        const video = document.querySelector('#video');
        const result = { calls: window.__svpVideoPauseCount, paused: video.paused };
        delete video.paused;
        delete video.pause;
        delete window.__svpVideoPauseCount;
        return result;
    });
}

async function verifyEudicEscape(page, checks, file) {
    await load(page, 'eudic-escape.srt'); await show(page);
    const viewport = page.viewportSize();
    await page.evaluate(() => {
        const state = queueTest.eudicEscape = { original: SvpEudic.submitWord, calls: 0, leaks: 0 };
        const listener = event => { if (event.key === 'Escape' && !event.defaultPrevented) state.leaks++; };
        document.addEventListener('keydown', listener);
        state.removeListener = () => document.removeEventListener('keydown', listener);
        SvpEudic.submitWord = options => {
            state.calls++;
            if (state.pending) return new Promise((resolve, reject) => { state.reject = reject; });
            return Promise.resolve({ status: 'created', word: options.word });
        };
    });
    const overlay = page.locator('#eudicContextOverlay'), entry = page.locator('#eudicContextEntryWord');
    const open = async () => {
        await selectSubtitle(page, 'implemented');
        await page.locator('#aiSelectionAddEudic').evaluate(node => node.click());
        await page.waitForFunction(() => document.activeElement.id === 'eudicContextEntryWord');
    };
    const escape = () => page.keyboard.press('Escape');
    const draft = () => page.locator('#eudicContextOverlay input, #eudicContextOverlay textarea')
        .evaluateAll(nodes => nodes.map(node => node.type === 'checkbox' ? node.checked : node.value));
    const aiVisible = async () => assert.equal(await page.locator('#aiChatWindow').isVisible(), true);
    try {
        await page.locator('#videoPlaybackRateControl').evaluate(node => node.click());
        await open(); await entry.fill('implement');
        for (const id of ['eudicContextPrevious', 'eudicContextCurrent', 'eudicContextNext']) {
            const input = page.locator('#' + id);
            await input.fill((await input.inputValue()) + ' [edited]');
        }
        const edited = await draft(); await entry.focus();
        for (const extra of [{ isComposing: true }, { keyCode: 229 }, { repeat: true }, { ctrlKey: true }, { altKey: true }, { metaKey: true }, { shiftKey: true }]) {
            await entry.evaluate((node, extra) => node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, ...extra })), extra);
            assert.equal(await page.evaluate(() => document.activeElement.id), 'eudicContextEntryWord');
        }
        await entry.evaluate(node => {
            node.addEventListener('keydown', event => event.preventDefault(), { once: true });
            node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        });
        assert.equal(await page.evaluate(() => document.activeElement.id), 'eudicContextEntryWord');
        assert.equal(await page.evaluate(() => queueTest.eudicEscape.leaks), 0);
        checks.push('Eudic Escape respects IME, modified, repeated and locally consumed keys');

        for (const id of ['eudicContextEntryWord', 'eudicContextPrevious', 'eudicContextCurrent', 'eudicContextNext',
            'eudicContextPreviousInclude', 'eudicContextNextInclude', 'eudicContextReset', 'eudicContextCancel', 'eudicContextSubmit', 'eudicContextClose']) {
            await page.locator('#' + id).focus(); await escape();
            assert.equal(await page.evaluate(() => document.activeElement === document.body), true);
            assert.equal(await overlay.isVisible(), true); assert.deepEqual(await draft(), edited); await aiVisible();
        }
        await page.locator('#eudicContextNextInclude').press('Space');
        const excluded = await draft(); await escape(); assert.deepEqual(await draft(), excluded);
        assert.equal(await page.locator('#eudicContextNext').isDisabled(), true);
        checks.push('Eudic Escape from word, all subtitle fields, checkboxes and buttons only blurs while preserving edits and inclusion choices');

        await page.keyboard.press('Enter'); assert.equal(await page.evaluate(() => queueTest.eudicEscape.calls), 0);
        await page.evaluate(() => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', repeat: true, bubbles: true, cancelable: true })));
        await page.waitForTimeout(5100);
        assert.equal(await overlay.isVisible(), true); assert.deepEqual(await draft(), excluded);
        assert.equal(await page.evaluate(() => document.activeElement === document.body), true);
        await page.keyboard.down('Escape'); await page.keyboard.down('Escape'); await page.keyboard.up('Escape');
        assert.equal(await overlay.isVisible(), false); await aiVisible();
        assert.equal(await page.locator('#fastForwardLimitPopover').isVisible(), true);
        await page.locator('#videoPlaybackRateControl').evaluate(node => node.click());
        checks.push('a separate Eudic Escape cancels only the dialog; focus timers and repeats before and after closing leave lower playback and AI layers intact');

        await open();
        for (const id of ['eudicContextPrevious', 'eudicContextCurrent', 'eudicContextNext']) {
            const input = page.locator('#' + id), before = await input.inputValue();
            await input.press('End'); await input.press('Enter');
            assert.equal((await input.inputValue()).length, before.length + 1);
        }
        await entry.evaluate(node => node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true })));
        assert.equal(await page.evaluate(() => queueTest.eudicEscape.calls), 0);
        await page.locator('#eudicContextCancel').press('Enter'); assert.equal(await overlay.isVisible(), false);
        await open(); await entry.press('Enter'); await overlay.waitFor({ state: 'hidden' });
        assert.equal(await page.evaluate(() => queueTest.eudicEscape.calls), 1);
        checks.push('Eudic keeps subtitle Enter newlines, composing Enter, native cancel-button Enter and word Enter submission unchanged');

        await open(); await entry.fill('implement');
        const submitted = await draft();
        await page.evaluate(() => { queueTest.eudicEscape.pending = true; });
        await entry.press('Enter'); await escape(); await escape();
        await page.evaluate(() => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', repeat: true, bubbles: true, cancelable: true })));
        assert.equal(await overlay.isVisible(), true); assert.equal(await page.locator('#eudicContextSubmit').isDisabled(), true);
        assert.equal(await page.evaluate(() => queueTest.eudicEscape.calls), 2); await aiVisible();
        await page.evaluate(() => queueTest.eudicEscape.reject(Error('isolated Eudic submission failure')));
        await page.waitForFunction(() => !document.querySelector('#eudicContextSubmit').disabled);
        await page.locator('#eudicContextCurrent').focus(); await escape();
        assert.equal(await overlay.isVisible(), true); assert.deepEqual(await draft(), submitted);
        assert.equal(await page.locator('#eudicContextError').textContent(), 'isolated Eudic submission failure');
        await escape(); assert.equal(await overlay.isVisible(), false); await aiVisible();
        checks.push('pending Eudic submission consumes Escape without dismissal; after failure the edited draft and two-step Escape remain available');

        await open(); await entry.evaluate(node => node.blur()); await escape();
        assert.equal(await overlay.isVisible(), false); await aiVisible();
        await open(); await page.evaluate(() => document.querySelector('#container').requestFullscreen());
        await escape(); assert.equal(await overlay.isVisible(), true); await aiVisible();
        await page.evaluate(async () => { if (document.fullscreenElement) await document.exitFullscreen(); });
        await entry.focus(); await escape(); await escape(); assert.equal(await overlay.isVisible(), false);
        checks.push('Eudic closes with one Escape when already unfocused and preserves native fullscreen Escape');

        await page.setViewportSize({ width: 390, height: 844 }); await open();
        assert.equal(await page.locator('.eudic-context-shortcut').textContent(), 'Esc 先失焦，再按取消');
        assert.equal(await page.locator('#eudicContextDialog').evaluate(node => {
            const bounds = node.getBoundingClientRect();
            const hint = node.querySelector('.eudic-context-shortcut').getBoundingClientRect();
            const actions = node.querySelector('.eudic-context-actions').getBoundingClientRect();
            return hint.left >= bounds.left && hint.right <= actions.left
                && actions.right <= bounds.right && Math.max(hint.bottom, actions.bottom) <= bounds.bottom;
        }), true);
        await page.locator('.eudic-context-footer').screenshot({ path: path.join(output, file + '-eudic-esc-footer-mobile.png') });
        await escape(); await escape(); assert.equal(await overlay.isVisible(), false);
        await page.setViewportSize(viewport);
        await page.locator('#aiChatInput').press('Escape');
        assert.equal(await page.locator('#aiChatWindow').isVisible(), false);
        checks.push('updated Eudic Escape hint and actions fit 390px; after closing the dialog AI Escape is unchanged');
    } finally {
        await page.evaluate(() => {
            SvpEudic.submitWord = queueTest.eudicEscape.original;
            queueTest.eudicEscape.removeListener(); delete queueTest.eudicEscape;
        });
        await page.setViewportSize(viewport);
    }
}

async function verifyDufsKeyboard(page, checks) {
    await page.evaluate(() => {
        const video = document.querySelector('#video');
        Object.defineProperty(video, 'readyState', { value: 1, configurable: true });
        Object.defineProperty(video, 'duration', { value: 52.208, configurable: true });
    });
    await load(page, 'dufs-keyboard.srt'); await show(page);
    await page.evaluate(() => {
        const original = window.fetch;
        const state = queueTest.dufs = { directories: [], files: [], originalFetch: original };
        const paths = url => url.pathname.endsWith('/season/')
            ? [{ name: 'captions.srt', path_type: 'File' }]
            : [{ name: 'season', path_type: 'Dir' }, { name: 'notes.srt', path_type: 'File' }];
        window.fetch = async (url, options) => {
            if (!String(url).startsWith('https://dufs.invalid/')) return original(url, options);
            const parsed = new URL(url);
            if (parsed.search === '?json') {
                state.directories.push(String(url));
                if (state.delayDirectory) await new Promise(resolve => {
                    state.finishDirectory = () => { state.delayDirectory = false; resolve(); };
                });
                return Response.json({ paths: paths(parsed) });
            }
            state.files.push(String(url));
            if (state.delayFile) await new Promise(resolve => {
                state.finishFile = () => { state.delayFile = false; resolve(); };
            });
            if (state.failFile) throw Error('isolated DUFS download failure');
            return new Response('1\n00:00:01,000 --> 00:00:04,000\nThe committee rejected the proposal submitted yesterday.\n');
        };
        queueTest.dufsTimeline = document.querySelector('#speaker-container');
    });
    const overlay = page.locator('#modalOverlay'), filter = page.locator('#dufsTreeFilter');
    const file = page.locator('input[name="file"][value="season/captions.srt"]');
    const loadButton = page.locator('#loadSelectedFiles');
    const open = async (keyboard = false) => {
        await page.locator('#dufsUrl').fill('https://dufs.invalid/keyboard/');
        if (keyboard) await page.locator('#dufsUrl').press('Enter');
        else await page.locator('#fetchDufsFiles').click();
        await page.locator('input[name="file"]').first().waitFor();
        assert.equal(await page.evaluate(() => document.activeElement.id), 'dufsTreeFilter');
    };
    const aiVisible = async () => assert.equal(await page.locator('#aiChatWindow').isVisible(), true);
    const files = () => page.evaluate(() => queueTest.dufs.files);
    const escape = () => page.keyboard.press('Escape');
    try {
        await open();
        checks.push('DUFS mouse opening focuses the live filter');
        assert.equal(await page.evaluate(() => !!queueTest.dufsTimeline), true);
        await loadButton.click();
        await file.press('Enter');
        assert.deepEqual(await files(), []); assert.equal(await overlay.isVisible(), true);
        assert.equal(await page.evaluate(() => document.querySelector('#speaker-container') === queueTest.dufsTimeline), true);
        checks.push('empty DUFS mouse and keyboard submissions leave the modal and timeline intact');

        await file.check(); await filter.fill('captions');
        const directoryCount = await page.evaluate(() => queueTest.dufs.directories.length);
        await filter.press('Enter');
        assert.deepEqual(await files(), []); assert.equal(await file.isChecked(), true);
        assert.equal(await page.locator('input[name="file"]').count(), 1);
        assert.equal(await page.evaluate(() => queueTest.dufs.directories.length), directoryCount);
        checks.push('DUFS filter stays live; Enter neither loads checked files nor refetches the directory');

        for (const extra of [{ isComposing: true }, { keyCode: 229 }, { ctrlKey: true }, { altKey: true }, { metaKey: true }, { shiftKey: true }]) {
            await filter.evaluate((node, extra) => node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, ...extra })), extra);
            assert.equal(await page.evaluate(() => document.activeElement.id), 'dufsTreeFilter');
        }
        await filter.evaluate(node => {
            node.addEventListener('keydown', event => event.preventDefault(), { once: true });
            node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        });
        assert.equal(await page.evaluate(() => document.activeElement.id), 'dufsTreeFilter');
        checks.push('DUFS respects composing, modified and locally consumed Escape');

        await filter.press('Escape');
        assert.equal(await page.evaluate(() => document.activeElement === document.body), true);
        assert.equal(await overlay.isVisible(), true); assert.equal(await filter.inputValue(), 'captions');
        assert.equal(await file.isChecked(), true); await aiVisible();
        await page.evaluate(() => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', repeat: true, bubbles: true, cancelable: true })));
        await page.waitForTimeout(5100);
        assert.equal(await page.evaluate(() => document.activeElement === document.body), true);
        assert.equal(await overlay.isVisible(), true);
        await escape(); assert.equal(await overlay.isVisible(), false); await aiVisible();
        checks.push('DUFS Escape first blurs without losing filter or selection; repeats and focus timers do not close it; a separate Escape closes only DUFS');

        await open(true);
        for (const selector of ['#closeFileList', '#loadSelectedFiles', '#checkDufsTree', '#clearDufsTreeFilter', '.dufs-toggle', 'input[name="file"]']) {
            await page.locator(selector).first().focus(); await escape();
            assert.equal(await page.evaluate(() => document.activeElement === document.body), true);
            assert.equal(await overlay.isVisible(), true); await aiVisible();
        }
        await escape(); assert.equal(await overlay.isVisible(), false); await aiVisible();
        checks.push('DUFS URL Enter focuses the filter; Escape from action buttons, tree toggles and checkboxes only blurs first');

        await open();
        await page.locator('#clearDufsTreeFilter').press('Enter'); assert.equal(await filter.inputValue(), '');
        await page.locator('#collapseDufsTree').press('Enter'); assert.ok(await page.locator('.dufs-collapsed').count());
        await page.locator('#expandDufsTree').press('Enter'); assert.equal(await page.locator('.dufs-collapsed').count(), 0);
        await file.press('Space'); assert.equal(await file.isChecked(), true);
        await file.press('Space'); assert.equal(await file.isChecked(), false);
        await page.locator('#closeFileList').press('Enter');
        assert.equal(await overlay.isVisible(), false); assert.deepEqual(await files(), []); await aiVisible();
        checks.push('DUFS toolbar, clear and close buttons retain native Enter; checkbox Space keeps toggling without submission');

        await page.locator('#videoPlaybackRateControl').evaluate(node => node.click());
        await open(true);
        assert.equal(await page.locator('#fastForwardLimitPopover').isVisible(), true);
        await escape();
        assert.equal(await overlay.isVisible(), true);
        await page.evaluate(() => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', repeat: true, bubbles: true, cancelable: true })));
        assert.equal(await page.locator('#fastForwardLimitPopover').isVisible(), true);
        await escape(); assert.equal(await overlay.isVisible(), false);
        assert.equal(await page.locator('#fastForwardLimitPopover').isVisible(), true); await aiVisible();
        await page.locator('#videoPlaybackRateControl').evaluate(node => node.click());
        checks.push('both DUFS Escape steps and held-key repeats are consumed before underlying playback and AI popovers');

        await open(); await selectSubtitle(page);
        await page.locator('#aiSelectionAddEudic').evaluate(node => node.click());
        await page.waitForFunction(() => document.activeElement.id === 'eudicContextEntryWord');
        await escape();
        assert.equal(await page.locator('#eudicContextOverlay').isVisible(), true);
        assert.equal(await page.evaluate(() => document.activeElement === document.body), true);
        assert.equal(await overlay.isVisible(), true); await aiVisible();
        await escape();
        assert.equal(await page.locator('#eudicContextOverlay').isVisible(), false);
        assert.equal(await overlay.isVisible(), true); await aiVisible();
        await escape(); assert.equal(await overlay.isVisible(), false);
        checks.push('both steps of upper Eudic Escape leave DUFS and AI intact; the following Escape closes only unfocused DUFS');

        await open(); await page.evaluate(() => document.querySelector('#container').requestFullscreen());
        await escape(); assert.equal(await overlay.isVisible(), true); await aiVisible();
        await page.evaluate(async () => { if (document.fullscreenElement) await document.exitFullscreen(); });
        await filter.focus(); await escape(); await escape();
        assert.equal(await overlay.isVisible(), false);
        checks.push('native fullscreen Escape leaves DUFS and the underlying AI window intact');

        await open(); await page.evaluate(() => { queueTest.dufs.delayFile = true; });
        await page.locator('.dufs-file-name').filter({ hasText: 'captions.srt' }).click();
        assert.equal(await page.evaluate(() => document.activeElement === document.body), true);
        await page.keyboard.press('Enter');
        await page.waitForFunction(() => queueTest.dufs.files.length === 1);
        assert.equal(await loadButton.isDisabled(), true); assert.equal(await overlay.isVisible(), true);
        await page.keyboard.press('Enter');
        await page.evaluate(() => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', repeat: true, bubbles: true, cancelable: true })));
        await loadButton.evaluate(node => node.dispatchEvent(new MouseEvent('click', { bubbles: true })));
        assert.equal((await files()).length, 1);
        await page.evaluate(() => queueTest.dufs.finishFile());
        await overlay.waitFor({ state: 'hidden' });
        await page.waitForFunction(() => !document.querySelector('#loadSelectedFiles').disabled);
        assert.equal(await page.locator('#subtitles').textContent().then(text => text.includes('submitted')), true);
        checks.push('Enter after clicking a DUFS filename imports once; duplicate mouse and keyboard submissions are blocked until completion and normal auto-close remains');

        await open(); await file.check(); await filter.fill('notes');
        assert.equal(await file.count(), 0);
        await loadButton.press('Enter'); await overlay.waitFor({ state: 'hidden' });
        assert.equal((await files()).length, 2); assert.ok((await files())[1].endsWith('/season/captions.srt'));
        assert.equal(await loadButton.isDisabled(), false);
        checks.push('load-button Enter keeps existing selection semantics, including checked files hidden by filtering');

        await open(); await page.locator('#clearDufsTreeFilter').click();
        await file.check(); await page.evaluate(() => { queueTest.dufs.failFile = true; });
        await file.press('Enter'); await overlay.waitFor({ state: 'hidden' });
        assert.equal((await files()).length, 3); assert.equal(await loadButton.isDisabled(), false);
        await page.evaluate(() => { queueTest.dufs.failFile = false; });
        checks.push('DUFS checkbox Enter submits and download failure releases the same submission guard');

        await page.evaluate(() => { queueTest.dufs.delayDirectory = true; });
        await page.locator('#dufsUrl').fill('https://dufs.invalid/slow/');
        await page.locator('#fetchDufsFiles').click();
        assert.equal(await page.evaluate(() => document.activeElement.id), 'dufsTreeFilter');
        await loadButton.click(); assert.equal(await overlay.isVisible(), true);
        await escape(); await escape(); assert.equal(await overlay.isVisible(), false); await aiVisible();
        await page.evaluate(() => queueTest.dufs.finishDirectory());
        await page.waitForFunction(() => queueTest.dufs.directories.some(url => url.includes('/slow/season/')));
        await settleChatLayout(page); assert.equal(await overlay.isVisible(), false);
        checks.push('DUFS focuses before directory download; empty loading submission is harmless and two-step Escape keeps late results from reopening it');

        await page.locator('#aiChatInput').press('Escape');
        assert.equal(await page.locator('#aiChatWindow').isVisible(), false);
        checks.push('after DUFS closes, AI Escape retains its original behavior');
    } finally {
        await page.evaluate(() => { window.fetch = queueTest.dufs.originalFetch; delete queueTest.dufs; delete queueTest.dufsTimeline; });
    }
}

async function main() {
    const browser = await chromium.launch({ channel: 'chrome', headless: true, downloadsPath: path.join(temp, 'downloads') });
    try {
        for (const file of ['subtitle_video_player.html', 'subtitle_video_player.single.html']) {
            const checks = [], errors = [];
            const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, reducedMotion: 'reduce' });
            const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
            await mock(page); await page.route(/^https?:/, route => route.abort());
            await page.goto(pathToFileURL(file.endsWith('.single.html') ? singleHtml : path.join(root, file)).href);
            await load(page); await show(page); await page.locator('#aiChatSettingsToggle').click();
            assert.equal(await page.locator('#aiChatBackgroundOptions').isVisible(), true);
            assert.equal(await page.locator('#aiChatBackgroundAutoOpen').isChecked(), false);
            assert.equal(await page.locator('#aiChatBackgroundAutoOpen').isDisabled(), true);
            const disabledLayout = await backgroundLayout(page);
            await page.locator('#aiChatBackgroundRequest').check();
            assert.equal(await page.locator('#aiChatBackgroundOptions').isVisible(), true);
            assert.equal(await page.locator('#aiChatBackgroundAutoOpen').isDisabled(), false);
            assert.deepEqual(await backgroundLayout(page), disabledLayout);
            assert.ok(Math.abs(disabledLayout.parentY - disabledLayout.childY) < 1);
            checks.push('auto-open stays inline, defaults off, and changes enabled state without shifting following settings');
            await page.locator('#aiChatProvider').selectOption('mock'); await page.locator('#aiChatModel').selectOption('mock-model');
            await page.locator('#aiChatSettingsToggle').click();
            for (const close of [
                () => page.locator('#aiChatClose').click(),
                () => page.locator('#toggleAiChat').click(),
                () => page.locator('#aiChatInput').press('Escape')
            ]) {
                await page.locator('#aiChatSettingsToggle').click();
                assert.equal(await page.locator('#aiChatSettings').isVisible(), true);
                await close();
                assert.equal(await page.locator('#aiChatWindow').evaluate(node => node.hidden), true);
                await show(page);
                assert.equal(await page.locator('#aiChatSettings').isVisible(), false);
                assert.equal(await page.locator('#aiChatSettingsToggle').getAttribute('aria-expanded'), 'false');
            }
            checks.push('close button, AI toggle and Esc reset settings expansion; each reopen starts collapsed and manual expansion still works');
            await verifyFixedComposerLayout(page, file);
            checks.push('long messages leave fixed composer regions intact with one and three pending items; settings stay closed across chat reopen');
            await verifyComposerMinimumHeight(page, file);
            checks.push('window minimum height preserves settings, queue, quote and multiline input; north, corner and south resize keep the opposite edge anchored');
            await verifyGeometryMemory(page, file);
            checks.push('content growth stays in the viewport without overwriting geometry; queue advance preserves dragging; manual placement and resize survive reopen and reload');
            await fresh(page);
            const quickStart = await requests(page);
            const quickInput = page.locator('#aiSelectionQuickInput');
            await selection(page, '#aiSelectionAsk');
            assert.equal(await requests(page), quickStart);
            assert.equal(await page.locator('#aiChatWindow').evaluate(node => node.hidden), false);
            assert.equal(await page.locator('#aiChatQuoteChip').isVisible(), true);
            await page.locator('#aiChatInput').fill('保留大浮窗草稿');
            await hide(page); await quickSelection(page);
            await waitQuickOpacity(page, 0.5);
            assert.equal(await page.locator('#aiSelectionQuickInput').isVisible(), true);
            const quickSurfaceStyle = await page.locator('#aiSelectionQuickForm').evaluate(node => {
                const style = getComputedStyle(node.closest('.ai-selection-bubble'));
                const surfaceStyle = getComputedStyle(node.closest('.ai-selection-bubble').querySelector('.ai-selection-quick-active-surface'));
                return {
                    property: surfaceStyle.transitionProperty,
                    duration: surfaceStyle.transitionDuration,
                    timing: surfaceStyle.transitionTimingFunction,
                    backdropFilter: style.backdropFilter,
                    borderColor: style.borderColor
                };
            });
            assert.deepEqual(quickSurfaceStyle, {
                property: 'opacity', duration: '0.16s', timing: 'ease-out', backdropFilter: 'blur(18px)', borderColor: 'rgb(48, 62, 81)'
            });
            assert.equal(await page.locator('.ai-selection-menu').evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(37, 46, 61)');
            assert.equal(await page.locator('.ai-selection-menu').evaluate(node => getComputedStyle(node).opacity), '1');
            const quickGeometry = await page.evaluate(() => {
                const form = document.querySelector('#aiSelectionQuickForm').getBoundingClientRect();
                const menu = document.querySelector('.ai-selection-menu').getBoundingClientRect();
                const button = document.querySelector('#aiSelectionAsk').getBoundingClientRect();
                return {
                    formWidth: form.width, formLeft: form.left, formBottom: form.bottom,
                    menuWidth: menu.width, menuLeft: menu.left, menuTop: menu.top,
                    buttonTop: button.top,
                    gapCount: document.querySelectorAll('.ai-selection-quick-gap-blur').length
                };
            });
            assert.ok(Math.abs(quickGeometry.formWidth - quickGeometry.menuWidth) < 1);
            assert.ok(Math.abs(quickGeometry.formLeft - quickGeometry.menuLeft) < 1);
            assert.ok(quickGeometry.formBottom <= quickGeometry.buttonTop - 2);
            assert.ok(Math.abs(quickGeometry.formBottom - quickGeometry.menuTop) < 1);
            assert.equal(quickGeometry.gapCount, 0);
            await page.screenshot({ path: path.join(output, file + '-quick-ask.png') });
            await page.mouse.move(0, 500);
            await page.evaluate(() => {
                document.querySelector('#layoutOrientationPortrait').click();
                document.querySelector('#video-player').style.display = 'none';
                const position = document.querySelector('#aiSelectionBubblePosition');
                position.value = 'subtitle-top';
                position.dispatchEvent(new Event('change', { bubbles: true }));
            });
            await page.waitForFunction(() => document.querySelector('#aiSelectionQuickForm').dataset.placement === 'below');
            const quickInitialEdge = await page.evaluate(() => {
                const form = document.querySelector('#aiSelectionQuickForm').getBoundingClientRect();
                const button = document.querySelector('#aiSelectionAsk').getBoundingClientRect();
                const bubble = document.querySelector('#aiSelectionBubble').getBoundingClientRect();
                const menu = document.querySelector('.ai-selection-menu').getBoundingClientRect();
                const quickGradient = getComputedStyle(document.querySelector('#aiSelectionBubble')).backgroundImage;
                return {
                    formTop: form.top, buttonBottom: button.bottom, bubbleTop: bubble.top,
                    menuBottom: menu.bottom, quickGradient
                };
            });
            assert.ok(quickInitialEdge.formTop >= quickInitialEdge.buttonBottom - 1);
            assert.ok(quickInitialEdge.bubbleTop >= 8);
            assert.ok(Math.abs(quickInitialEdge.menuBottom - quickInitialEdge.formTop) < 1);
            assert.equal(quickInitialEdge.quickGradient, 'linear-gradient(0deg, rgba(65, 75, 89, 0.5) 0px, rgb(37, 46, 61) 40px, rgb(37, 46, 61) 100%)');
            await waitQuickOpacity(page, 0.5);
            await page.evaluate(() => {
                document.querySelector('#video-player').style.display = '';
                const position = document.querySelector('#aiSelectionBubblePosition');
                position.value = 'auto';
                position.dispatchEvent(new Event('change', { bubbles: true }));
                document.querySelector('#layoutOrientationLandscape').click();
            });
            await page.waitForFunction(() => document.querySelector('#aiSelectionQuickForm').dataset.placement === 'above');
            await page.locator('#aiSelectionLookup').hover();
            await waitQuickOpacity(page, 0.5);
            await page.locator('#aiSelectionAsk').hover();
            await waitQuickOpacity(page, 1);
            assert.equal(await page.locator('#aiSelectionBubble').evaluate(node => getComputedStyle(node).borderColor), 'rgb(48, 62, 81)');
            assert.equal(await page.locator('.ai-selection-menu').evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(37, 46, 61)');
            assert.equal(await page.locator('.ai-selection-menu').evaluate(node => getComputedStyle(node).opacity), '1');
            await page.screenshot({ path: path.join(output, file + '-quick-ask-hover.png') });
            const askBox = await page.locator('#aiSelectionAsk').boundingBox();
            await page.mouse.move(askBox.x + askBox.width / 2, askBox.y - 4, { steps: 8 });
            assert.equal(await page.locator('#aiSelectionQuickInput').isVisible(), true);
            const quickInputBox = await page.locator('#aiSelectionQuickInput').boundingBox();
            await page.mouse.move(quickInputBox.x + quickInputBox.width / 2, quickInputBox.y + quickInputBox.height / 2, { steps: 8 });
            assert.equal(await page.locator('#aiSelectionQuickInput').isVisible(), true);
            await waitQuickOpacity(page, 1);
            await page.locator('#aiSelectionQuickInput').focus();
            await page.mouse.move(0, 500);
            await waitQuickOpacity(page, 1);
            await page.locator('#aiSelectionLookup').focus();
            await waitQuickOpacity(page, 0.5);
            assert.equal(await page.locator('#aiSelectionQuickInput').isVisible(), true);
            await page.locator('#aiSelectionQuickInput').hover();
            await waitQuickOpacity(page, 1);
            await page.mouse.move(0, 500);
            await waitQuickOpacity(page, 0.5);
            checks.push('quick ask and menu share one bordered shell with no gap element or internal shadow, in both visual orders');
            checks.push('quick ask uses a 160ms opacity transition from the form or ask button, holds opacity while focused, and dims after blur without hover');
            await page.locator('#aiSelectionQuickInput').press('Enter');
            assert.equal(await requests(page), quickStart);
            await page.locator('#aiSelectionQuickInput').fill('输入法草稿');
            await page.locator('#aiSelectionQuickInput').evaluate(node => node.dispatchEvent(new KeyboardEvent('keydown', {
                key: 'Enter', isComposing: true, bubbles: true, cancelable: true
            })));
            assert.equal(await requests(page), quickStart);
            assert.equal(await page.locator('#aiSelectionQuickInput').inputValue(), '输入法草稿');
            await page.locator('#aiSelectionQuickInput').clear();
            await page.evaluate(() => {
                const bubble = document.querySelector('#aiSelectionBubble');
                bubble.style.left = (window.innerWidth - bubble.getBoundingClientRect().width - 8) + 'px';
                bubble.style.top = '8px';
                document.querySelector('#aiSelectionQuickInput').dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
            });
            const quickEdge = await page.evaluate(() => {
                const form = document.querySelector('#aiSelectionQuickForm').getBoundingClientRect();
                const button = document.querySelector('#aiSelectionAsk').getBoundingClientRect();
                const menu = document.querySelector('.ai-selection-menu').getBoundingClientRect();
                return {
                    left: form.left, right: form.right, top: form.top, buttonBottom: button.bottom,
                    menuBottom: menu.bottom, width: window.innerWidth
                };
            });
            assert.ok(quickEdge.left >= 8 && quickEdge.right <= quickEdge.width - 8);
            assert.ok(quickEdge.top >= quickEdge.buttonBottom - 1);
            assert.ok(Math.abs(quickEdge.menuBottom - quickEdge.top) < 1);
            await page.locator('#aiSelectionBubble').evaluate(node => { node.style.left = '8px'; });
            const subtitle = page.locator('#subtitles .subtitle').first();
            const highlightBackground = () => subtitle.evaluate(node => getComputedStyle(node, '::highlight(svp-quick-quote)').backgroundColor);
            const drag = await subtitle.evaluate(node => {
                const text = node.firstChild;
                const start = text.data.indexOf('proposal');
                const range = document.createRange();
                range.setStart(text, start);
                range.setEnd(text, start + 'proposal'.length);
                const rect = range.getBoundingClientRect();
                return { left: rect.left + 0.5, right: rect.right - 0.5, y: rect.top + rect.height / 2 };
            });
            await page.mouse.move(drag.left, drag.y);
            await page.mouse.down();
            await page.mouse.move(drag.right, drag.y, { steps: 8 });
            await page.waitForTimeout(220);
            assert.equal(await page.locator('#aiSelectionBubble').isHidden(), true);
            assert.equal(await page.evaluate(() => String(getSelection())), 'proposal');
            assert.notEqual(await page.evaluate(() => document.activeElement.id), 'aiSelectionQuickInput');
            await page.mouse.up();
            await quickInput.waitFor({ state: 'visible' });
            assert.notEqual(await page.evaluate(() => document.activeElement.id), 'aiSelectionQuickInput');
            assert.equal(await page.evaluate(() => String(getSelection())), 'proposal');
            await page.locator('#aiSelectionAsk').hover();
            await waitQuickOpacity(page, 1);
            assert.equal(await highlightBackground(), 'rgba(0, 0, 0, 0)');
            assert.equal(await page.evaluate(() => String(getSelection())), 'proposal');
            await context.grantPermissions(['clipboard-read']);
            await page.keyboard.press('ControlOrMeta+c');
            assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'proposal');
            await quickInput.click();
            await page.mouse.move(0, 500);
            await page.keyboard.type('快捷引用提问');
            assert.equal(await quickInput.inputValue(), '快捷引用提问');
            assert.deepEqual(await page.evaluate(() => Array.from(CSS.highlights.get('svp-quick-quote'), String)), ['proposal']);
            assert.equal(await highlightBackground(), 'rgb(255, 224, 138)');
            await quickInput.evaluate(node => node.setSelectionRange(0, 2));
            await page.keyboard.press('ControlOrMeta+c');
            assert.equal(await page.evaluate(() => navigator.clipboard.readText()), '快捷');
            await quickInput.evaluate(node => node.setSelectionRange(2, 2));
            await page.keyboard.press('ControlOrMeta+c');
            assert.equal(await page.evaluate(() => navigator.clipboard.readText()), '快捷');
            await context.clearPermissions();
            checks.push('subtitle drag and ask hover preserve native selection and copy; the quick input copies only selected draft text');
            await page.keyboard.press('Tab');
            assert.equal(await page.evaluate(() => document.activeElement.id), 'aiSelectionQuickSend');
            assert.equal(await highlightBackground(), 'rgb(255, 224, 138)');
            await page.keyboard.press('Tab');
            assert.equal(await page.evaluate(() => document.activeElement.id), 'aiSelectionAsk');
            assert.equal(await highlightBackground(), 'rgba(0, 0, 0, 0)');
            await quickInput.click();
            await page.keyboard.press('Enter'); await waitRequests(page, quickStart + 1);
            assert.equal(await page.evaluate(() => CSS.highlights.has('svp-quick-quote')), false);
            const quickPayload = await page.evaluate(() => queueTest.requests.at(-1).payload.user_message);
            assert.match(quickPayload, /当前播放到 0:00:02/);
            assert.match(quickPayload, /【引用字幕 [^\n]+】"proposal"\n快捷引用提问/);
            assert.equal(await page.locator('#aiChatWindow').evaluate(node => node.hidden), true);
            assert.equal(await page.locator('#aiSelectionBubble').evaluate(node => node.hidden), true);
            assert.equal(await page.locator('#aiChatInput').inputValue(), '保留大浮窗草稿');
            assert.equal(await page.locator('#aiChatQuoteChip').evaluate(node => node.hidden), false);
            await hide(page); await quickSelection(page);
            await page.locator('#aiSelectionQuickInput').fill('快捷排队提问');
            await page.locator('#aiSelectionQuickSend').click(); await waitPending(page, 1);
            assert.equal(await requests(page), quickStart + 1);
            assert.equal(await page.locator('#aiChatWindow').evaluate(node => node.hidden), true);
            const quickQueuedToast = page.locator('#toastContainer [data-toast-key^="ai-request-status-"]:not([data-toast-key^="ai-request-status-result-"])');
            await quickQueuedToast.getByText('已提交').waitFor();
            assert.match(await quickQueuedToast.textContent(), /问答「快捷排队提问」已提交/);
            assert.equal(await page.locator('#aiSelectionQuickSend').textContent(), '排队');
            await finish(page, true); await finish(page);
            assert.equal(await page.locator('#aiChatInput').inputValue(), '保留大浮窗草稿');
            assert.equal(await page.locator('#aiChatQuoteChip').evaluate(node => node.hidden), false);
            checks.push('clicking quick ask highlights the new quote through the send button, stops highlighting outside the form, and sends without replacing the main draft or quote');
            checks.push('quick ask respects enabled background mode, flips at viewport edges, handles empty and composing Enter, and joins FIFO');

            await show(page);
            await page.locator('#aiChatSettingsToggle').click(); await page.locator('#aiChatBackgroundRequest').uncheck();
            await page.locator('#aiChatSettingsToggle').click(); await hide(page);
            const quickBackgroundOff = await requests(page);
            await quickSelection(page); await page.locator('#aiSelectionQuickInput').fill('关闭后台快捷提问');
            await page.locator('#aiSelectionQuickInput').press('Enter'); await waitRequests(page, quickBackgroundOff + 1);
            assert.equal(await page.locator('#aiChatWindow').evaluate(node => node.hidden), false);
            await finish(page);
            await page.locator('#aiChatSettingsToggle').click(); await page.locator('#aiChatBackgroundRequest').check();
            await page.locator('#aiChatSettingsToggle').click();
            checks.push('quick ask also opens the chat with background mode disabled; original ask still only prepares a quote');

            await fresh(page); await background(page, true);
            const quickMessages = page.locator('#aiChatMessages');
            await quickMessages.evaluate(messages => {
                const history = document.createElement('div');
                history.className = 'ai-chat-msg ai-chat-msg-ai';
                history.textContent = '较早的回复\n'.repeat(60);
                messages.appendChild(history);
            });
            await hide(page);
            const beforeQuickAutoOpen = await requests(page);
            await quickSelection(page); await page.locator('#aiSelectionQuickInput').fill('后台快捷提问自动展开');
            await page.locator('#aiSelectionQuickInput').press('Enter'); await waitRequests(page, beforeQuickAutoOpen + 1);
            assert.equal(await page.locator('#aiChatWindow').evaluate(node => node.hidden), true);
            await page.locator('#video').focus();
            const quickAutoFocus = await page.evaluate(() => document.activeElement.id);
            await watchVideoPause(page);
            await finish(page);
            assert.equal(await page.locator('#aiChatWindow').evaluate(node => node.hidden), false);
            assert.equal(await quickMessages.locator('.ai-chat-msg-ai').last().evaluate(reply => {
                const bounds = reply.parentElement.getBoundingClientRect();
                const replyBounds = reply.getBoundingClientRect();
                return replyBounds.top >= bounds.top && replyBounds.bottom <= bounds.bottom + 1;
            }), true);
            assert.equal(await page.evaluate(() => document.activeElement.id), quickAutoFocus);
            assert.deepEqual(await restoreVideoPause(page), { calls: 1, paused: true });
            await background(page, false);
            checks.push('quick ask uses background queue notices; success-only auto-open reveals the latest reply, pauses playback and preserves focus');

            await fresh(page); await page.locator('#aiChatInput').fill('');
            await submit(page, '第一条普通问答'); const first = await requests(page); await waitRequests(page, first);
            await selection(page, '#aiSelectionLookup');
            await page.evaluate(() => { document.querySelector('#video').currentTime = 6; });
            await selection(page, '#aiSelectionAnalyze');
            await page.locator('#aiChatSettingsToggle').click(); await page.locator('#aiChatNoSpoiler').uncheck(); await page.locator('#aiChatAttachPosition').uncheck(); await page.locator('#aiChatSettingsToggle').click();
            await submit(page, '最后一条问答'); await waitPending(page, 3);
            assert.equal(await requests(page), first); assert.equal(await page.locator('.ai-chat-msg-user').count(), 1);
            assert.equal(await page.locator('#aiChatSend').textContent(), '排队'); assert.equal(await page.locator('#aiChatStop').isVisible(), true);
            checks.push('chat, lookup and analysis share FIFO; pending items are not added to transcript');
            await page.locator('#aiChatWindow').screenshot({ path: path.join(output, file + '-desktop.png') });
            await hide(page); const notices = await page.evaluate(() => queueTest.results.length);
            await page.evaluate(() => { document.querySelector('#video').currentTime = 30; });
            await finish(page, true);
            const lookup = await page.evaluate(() => queueTest.requests.at(-1));
            assert.match(lookup.payload.user_message, /当前播放到 0:00:02/); assert.match(lookup.payload.user_message, /【查词】「submitted」/);
            assert.match(lookup.payload.system_message, /不得透露、暗示或影射/); assert.equal(lookup.payload.provider, 'mock'); assert.equal(lookup.payload.model, 'mock-model');
            assert.ok(lookup.previous.some(text => text.includes('第一条普通问答')));
            assert.ok(await page.locator('#toastContainer').getByText('问答「第一条普通问答」已完成', { exact: true }).count());
            await finish(page, true); assert.match(await page.evaluate(() => queueTest.requests.at(-1).payload.user_message), /当前播放到 0:00:06/);
            await finish(page, true); assert.doesNotMatch(await page.evaluate(() => queueTest.requests.at(-1).payload.system_message), /不得透露、暗示或影射/);
            await finish(page); await waitPending(page, 0);
            assert.equal(await page.evaluate(() => queueTest.results.length), notices + 4);
            assert.equal(await page.locator('#aiChatWindow').evaluate(node => node.hidden), true);
            assert.equal(await page.locator('#toggleAiChat').evaluate(node => node.classList.contains('ai-chat-unread')), true);
            checks.push('captures position and settings at submission while conversation history grows serially');
            checks.push('each completion has its own background toast, preserved when the next request starts');
            checks.push('automatic dequeue preserves hidden window and unread marker');

            await fresh(page); await background(page, false); await hide(page);
            const beforeBackgroundQueue = await requests(page);
            await selection(page, '#aiSelectionLookup'); await waitRequests(page, beforeBackgroundQueue + 1);
            await selection(page, '#aiSelectionAnalyze'); await waitPending(page, 1);
            await selection(page, '#aiSelectionLookup'); await waitPending(page, 2);
            const queuedToast = page.locator('#toastContainer [data-toast-key^="ai-request-status-"]:not([data-toast-key^="ai-request-status-result-"])');
            await queuedToast.waitFor({ state: 'visible' });
            await queuedToast.getByText('已提交').waitFor();
            assert.match(await queuedToast.textContent(), /查词「submitted」/);
            assert.match(await queuedToast.textContent(), /当前正在回答上一项/);
            assert.match(await queuedToast.textContent(), /当前正在回答上一项\n前面还有 1 项待发送，排队第 2 项/);
            assert.equal(await queuedToast.evaluate(node => getComputedStyle(node).whiteSpace), 'pre-line');
            assert.equal(await requests(page), beforeBackgroundQueue + 1);
            assert.equal(await page.locator('#aiChatWindow').evaluate(node => node.hidden), true);
            await finish(page, true); await finish(page, true); await finish(page);
            checks.push('hidden background lookup/analyze queue submission confirms type, acceptance, active work and queue position');

            const beforeEditBatch = await requests(page);
            await fresh(page); await submit(page, '编辑测试当前项'); await waitRequests(page, beforeEditBatch + 1);
            await submit(page, '将被取消的问答'); await selection(page, '#aiSelectionLookup'); await selection(page, '#aiSelectionAnalyze');
            await waitPending(page, 3); await page.locator('#aiChatInput').fill('保留这份未发送草稿');
            await action(page, 2, 'up'); await action(page, 0, 'remove'); await waitPending(page, 2);
            assert.match(await rows(page).first().textContent(), /析句/);
            await action(page, 1, 'edit'); await page.locator('.ai-chat-queue-editor').fill('proposal'); await action(page, 1, 'save');
            await action(page, 0, 'edit'); await page.locator('.ai-chat-queue-editor').fill('Please reconsider carefully.');
            const beforeEdit = await requests(page); await finish(page); assert.equal(await requests(page), beforeEdit);
            assert.match(await page.locator('#aiChatQueueToggle').textContent(), /等待编辑/);
            await selection(page, '#aiSelectionLookup');
            assert.equal(await page.locator('.ai-chat-queue-editor').inputValue(), 'Please reconsider carefully.');
            assert.equal(await page.locator('#aiChatInput').inputValue(), '保留这份未发送草稿');
            await action(page, 0, 'save'); await waitRequests(page, beforeEdit + 1);
            assert.match(await page.evaluate(() => queueTest.requests.at(-1).payload.user_message), /Please reconsider carefully/);
            await finish(page, true); assert.match(await page.evaluate(() => queueTest.requests.at(-1).payload.user_message), /【查词】「proposal」/);
            await finish(page, true); await finish(page);
            assert.equal(await page.locator('#aiChatInput').inputValue(), '保留这份未发送草稿');
            checks.push('reorder and cancel only waiting items; typed lookup and analysis edits retain their request type');
            checks.push('editing head blocks automatic delivery without losing editor text or composer draft');
            await fresh(page); await submit(page, '取消编辑当前项'); await submit(page, '原始待发送问题');
            await action(page, 0, 'edit'); await page.locator('.ai-chat-queue-editor').fill('不保存的修改');
            await finish(page); const beforeCancel = await requests(page); await page.locator('.ai-chat-queue-editor').press('Escape'); await waitRequests(page, beforeCancel + 1);
            assert.equal(await page.locator('#aiChatWindow').evaluate(node => node.hidden), false);
            assert.match(await page.evaluate(() => queueTest.requests.at(-1).payload.user_message), /原始待发送问题/); await finish(page);
            checks.push('cancel edit restores original item and resumes waiting head');

            await fresh(page); const frontNotices = await page.evaluate(() => queueTest.results.length);
            await submit(page, '普通问答编辑当前项');
            await page.evaluate(() => { document.querySelector('#video').currentTime = 17; });
            await selection(page, '#aiSelectionAsk'); await submit(page, '带引用的待发送原问题');
            await action(page, 0, 'edit'); await page.locator('.ai-chat-queue-editor').fill('修改后的引用问题'); await action(page, 0, 'save');
            await page.evaluate(() => { document.querySelector('#video').currentTime = 40; }); await finish(page, true);
            const editedChat = await page.evaluate(() => queueTest.requests.at(-1).payload.user_message);
            assert.match(editedChat, /修改后的引用问题/); assert.match(editedChat, /【引用字幕/); await finish(page);
            assert.equal(await page.evaluate(() => queueTest.results.length), frontNotices);
            checks.push('chat edit retains frozen quote and foreground completion emits no state toast');

            await fresh(page); await page.evaluate(() => { queueTest.nextMode = 'error'; });
            await submit(page, '会失败的问题'); await submit(page, '失败后第一项'); await finish(page);
            assert.match(await page.locator('#aiChatQueueToggle').textContent(), /失败暂停/);
            const failed = await requests(page); await submit(page, '失败后追加项'); assert.equal(await requests(page), failed);
            await page.locator('.ai-chat-retry-btn').last().click(); await waitRequests(page, failed + 1);
            assert.equal(await page.locator('#aiChatQueueResume').isDisabled(), true);
            await finish(page, true); assert.match(await page.evaluate(() => queueTest.requests.at(-1).payload.user_message), /失败后第一项/);
            await finish(page, true); await finish(page); checks.push('failure pauses pending work; retry of failed item resumes FIFO after success');

            await fresh(page); await page.evaluate(() => { queueTest.nextMode = 'error'; });
            await submit(page, '历史失败项'); await finish(page);
            await submit(page, '历史重试时正在执行的问题'); const beforeQueuedRetry = await requests(page);
            await page.locator('.ai-chat-retry-btn').last().click(); await waitPending(page, 1);
            assert.equal(await requests(page), beforeQueuedRetry); assert.equal(await page.locator('.ai-chat-retry-btn').last().isDisabled(), true);
            await action(page, 0, 'remove'); assert.equal(await page.locator('.ai-chat-retry-btn').last().isDisabled(), false);
            await page.locator('.ai-chat-retry-btn').last().click(); await finish(page, true); await finish(page);
            checks.push('historical retry queues behind active work and can be cancelled independently');

            await fresh(page); await page.evaluate(() => { queueTest.nextMode = 'empty'; });
            await selection(page, '#aiSelectionAnalyze'); await submit(page, '格式错误后等待的问题'); await finish(page);
            assert.match(await page.locator('#aiChatQueueToggle').textContent(), /失败暂停/);
            const formatFailure = await requests(page); await page.locator('#aiChatQueueResume').click(); await waitRequests(page, formatFailure + 1); await finish(page);
            checks.push('client-side analysis format errors pause queue and explicit continue skips failed item');

            await fresh(page); await page.evaluate(() => { queueTest.nextMode = 'empty'; });
            await submit(page, '空回复仍按原判定'); await submit(page, '空回复后正常继续'); await finish(page, true); await finish(page);
            checks.push('ordinary empty reply preserves success classification and continues queue');

            await fresh(page); await submit(page, '字幕重新分组当前项'); await selection(page, '#aiSelectionLookup');
            const regroupCount = await requests(page); const regroupId = await page.evaluate(() => queueTest.requests.at(-1).payload.id);
            const originalLength = await page.locator('#textLength').inputValue();
            await page.locator('#textLength').evaluate(node => { node.value = '500'; node.dispatchEvent(new Event('input', { bubbles: true })); });
            await submit(page, '重新分组后追加的问题'); await waitPending(page, 2); assert.equal(await requests(page), regroupCount);
            await finish(page, true); assert.equal(await page.evaluate(() => queueTest.requests.at(-1).payload.id), regroupId);
            assert.match(await page.evaluate(() => queueTest.requests.at(-1).payload.user_message), /【查词】「submitted」/);
            await finish(page, true); await finish(page);
            await page.locator('#textLength').evaluate((node, value) => { node.value = value; node.dispatchEvent(new Event('input', { bubbles: true })); }, originalLength);
            checks.push('same-file subtitle regrouping does not clear active queue or change frozen requests');

            await fresh(page); await submit(page, '准备停止的问题'); await submit(page, '停止后待发送');
            await page.locator('#aiChatInput').fill('停止时不能覆盖的草稿'); await selection(page, '#aiSelectionAsk');
            await page.locator('#aiChatStop').click(); await idle(page);
            assert.equal(await page.locator('#aiChatInput').inputValue(), '停止时不能覆盖的草稿');
            assert.equal(await page.locator('#aiChatQuoteChip').isVisible(), true);
            assert.match(await page.locator('#aiChatQueueToggle').textContent(), /已暂停/);
            const stopped = await requests(page); await page.locator('#aiChatInput').press('Enter'); await waitPending(page, 2);
            assert.equal(await requests(page), stopped);
            await page.locator('#aiChatQueueResume').click(); await waitRequests(page, stopped + 1); await finish(page, true);
            assert.match(await page.evaluate(() => queueTest.requests.at(-1).payload.user_message), /【引用字幕/); await finish(page);
            checks.push('stop pauses queue, protects draft and quote, and requires explicit continue');

            await fresh(page); await submit(page, '清空时当前项'); await submit(page, '清空项一'); await submit(page, '清空项二');
            const clearCount = await requests(page); await page.locator('#aiChatQueueClear').click(); await waitPending(page, 0);
            assert.equal(await page.locator('#aiChatStop').isVisible(), true); await finish(page); assert.equal(await requests(page), clearCount);
            checks.push('clear removes pending items without aborting current response');

            await fresh(page); await submit(page, '等待迟到回调'); await submit(page, '不能进入新会话的队列');
            const oldIndex = await page.evaluate(() => { queueTest.active.ignoreAbort = true; return queueTest.entries.length - 1; });
            const oldId = await page.evaluate(() => queueTest.requests.at(-1).payload.id); await fresh(page);
            await submit(page, '新会话当前问题'); const newCount = await requests(page);
            await page.evaluate(index => queueTest.entries[index].finish(), oldIndex);
            assert.equal(await page.locator('#aiChatStop').isVisible(), true); assert.notEqual(await page.evaluate(() => queueTest.requests.at(-1).payload.id), oldId);
            await finish(page); assert.equal(await requests(page), newCount); assert.equal(await page.locator('.ai-chat-msg-user').count(), 1);
            checks.push('new conversation clears old work and rejects late callbacks without stopping new request');

            await fresh(page); await submit(page, '换字幕当前项'); await submit(page, '旧字幕队列');
            await quickSelection(page); await quickInput.fill('旧字幕快捷草稿');
            const subtitleId = await page.evaluate(() => queueTest.requests.at(-1).payload.id);
            const sourceCount = await requests(page); await load(page, 'same-text-new-file.srt'); await idle(page); await waitPending(page, 0);
            assert.equal(await page.locator('#aiSelectionBubble').isHidden(), true);
            assert.equal(await quickInput.inputValue(), '');
            assert.equal(await page.evaluate(() => CSS.highlights.has('svp-quick-quote')), false);
            await page.locator('#aiSelectionAsk').evaluate(button => button.click());
            assert.equal(await page.locator('#aiChatQuoteChip').isHidden(), true);
            assert.equal(await requests(page), sourceCount); await submit(page, '新字幕问题'); await finish(page);
            assert.notEqual(await page.evaluate(() => queueTest.requests.at(-1).payload.id), subtitleId);
            checks.push('loading a subtitle file with identical text still starts a new conversation and clears the old queue and selection');

            await submit(page, '换视频当前项'); await submit(page, '换视频后继续的队列');
            const videoId = await page.evaluate(() => queueTest.requests.at(-1).payload.id);
            const retainedSubtitles = await page.locator('#subtitles').textContent();
            await selection(page, '#aiSelectionAsk');
            await page.evaluate(() => { document.querySelector('#videoUrl').value = 'https://example.invalid/new-video.mp4'; document.querySelector('#loadVideoUrl').click(); });
            await page.evaluate(() => {
                const dataTransfer = new DataTransfer();
                dataTransfer.items.add(new File(['test'], 'dropped-video.mp4', { type: 'video/mp4' }));
                document.querySelector('#videoFile').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
            });
            assert.equal(await page.locator('#videoFileName').textContent(), 'dropped-video.mp4');
            const dufsListing = url => url.origin === 'https://dufs-session.invalid' && url.search === '?json';
            await page.route(dufsListing, route => route.fulfill({ json: { paths: [{ name: 'dufs-video.mp4', path_type: 'File' }] } }));
            await page.locator('#dufsUrl').fill('https://dufs-session.invalid/videos/');
            await page.locator('#fetchDufsFiles').click();
            await page.locator('input[name="file"][value="dufs-video.mp4"]').check();
            await page.locator('#loadSelectedFiles').click();
            await page.locator('#modalOverlay').waitFor({ state: 'hidden' });
            await page.unroute(dufsListing);
            assert.equal(await page.locator('#videoFileName').textContent(), 'dufs-video.mp4');
            assert.equal(await page.locator('#subtitles').textContent(), retainedSubtitles);
            assert.equal(await page.locator('#aiChatStop').isVisible(), true);
            assert.equal(await page.locator('#aiChatQuoteChip').isVisible(), true);
            await waitPending(page, 1);
            await finish(page, true);
            assert.equal(await page.evaluate(() => queueTest.requests.at(-1).payload.id), videoId);
            await finish(page);
            await page.locator('#textLength').evaluate(node => { node.value = '500'; node.dispatchEvent(new Event('input', { bubbles: true })); });
            assert.equal(await page.locator('#subtitles .subtitle').count(), 1);
            await submit(page, '换视频并重新分组后追问'); await finish(page);
            const videoFollowup = await page.evaluate(() => queueTest.requests.at(-1).payload);
            assert.equal(videoFollowup.id, videoId);
            assert.match(videoFollowup.system_message, /dufs-video\.mp4/);
            await page.locator('#textLength').evaluate((node, value) => { node.value = value; node.dispatchEvent(new Event('input', { bubbles: true })); }, originalLength);
            checks.push('URL, drop and DUFS video loads preserve the session, queue, quote and SRT regrouping');

            await verifySupSession(page, checks);

            await submit(page, '刷新当前项'); await submit(page, '刷新队列项'); await page.reload();
            await idle(page); await waitPending(page, 0); assert.equal(await page.locator('#aiChatQueue').isVisible(), false);
            assert.equal(await page.locator('#aiChatBackgroundRequest').isChecked(), true);
            checks.push('refresh keeps settings but restores no queue or request');

            await submit(page, '没有字幕时的提示'); assert.equal(await requests(page), 0);
            assert.match(await page.locator('#toastContainer').textContent(), /请先加载字幕再使用 AI 对话/);
            checks.push('original blocked-operation toast still works in foreground');

            await load(page);
            await page.evaluate(() => showStatusToast('保留原有常驻 toast', 'info', 0));
            await page.locator('#aiChatInput').fill('中文输入草稿');
            await page.locator('#aiChatInput').evaluate(node => node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true })));
            await page.locator('#aiChatInput').press('Shift+Enter'); assert.equal(await requests(page), 0);
            checks.push('IME confirmation and Shift+Enter never submit or enqueue');
            await page.setViewportSize({ width: 390, height: 844 }); await submit(page, '窄屏当前项');
            for (let index = 0; index < 8; index++) await submit(page, '窄屏待发送 ' + index);
            await submit(page, '<img src=x onerror="window.queueXss=true">'); await waitPending(page, 9);
            const layout = await page.locator('#aiChatQueue').evaluate(node => {
                const list = document.querySelector('#aiChatQueueList'), box = node.getBoundingClientRect();
                return { width: box.width, height: box.height, overflow: node.scrollWidth > node.clientWidth + 1, scrollable: list.scrollHeight > list.clientHeight };
            });
            await page.locator('#aiChatWindow').screenshot({ path: path.join(output, file + '-mobile.png') });
            assert.ok(layout.width <= 390 && !layout.overflow && layout.scrollable && layout.height <= 220, JSON.stringify(layout));
            assert.equal(await page.locator('#aiChatQueue img').count(), 0); assert.equal(await page.evaluate(() => !!window.queueXss), false);
            await page.locator('#aiChatQueueToggle').click(); assert.equal(await page.locator('#aiChatQueueList').isVisible(), false);
            await page.locator('#aiChatQueueToggle').click();
            checks.push('narrow queue scrolls and collapses without overflow; user text remains inert');
            await action(page, 8, 'edit');
            await page.locator('.ai-chat-queue-editor').fill('正在编辑较后面的排队问题');
            await finish(page, true);
            const editingLayout = await page.locator('.ai-chat-queue-editor').evaluate(node => {
                const box = node.getBoundingClientRect(), view = document.querySelector('#aiChatQueueList').getBoundingClientRect();
                return { focused: document.activeElement === node, value: node.value, top: box.top, bottom: box.bottom, viewTop: view.top, viewBottom: view.bottom };
            });
            await page.locator('#aiChatWindow').screenshot({ path: path.join(output, file + '-mobile-edit.png') });
            assert.equal(editingLayout.value, '正在编辑较后面的排队问题');
            assert.ok(editingLayout.focused && editingLayout.bottom > editingLayout.viewTop && editingLayout.top < editingLayout.viewBottom, JSON.stringify(editingLayout));
            checks.push('long-queue editor keeps focus, draft and visible position while earlier items advance');
            await page.locator('#aiChatQueueClear').click(); await finish(page);
            assert.equal(await page.getByText('保留原有常驻 toast', { exact: true }).count(), 1);
            checks.push('queue and notification cleanup preserve unrelated toast');

            await fresh(page); await background(page, false); await hide(page);
            await page.clock.install();
            await selection(page, '#aiSelectionLookup'); await finish(page);
            const notice = page.locator('.ai-result-toast-open').last();
            await page.clock.runFor(250);
            await page.waitForFunction(() => getComputedStyle(document.querySelector('.ai-result-toast')).opacity === '1');
            assert.equal(await page.locator('#aiChatWindow').evaluate(node => node.hidden), true);
            assert.equal(await page.locator('#toggleAiChat').evaluate(node => node.classList.contains('ai-chat-unread')), true);
            assert.ok((await notice.boundingBox()).height >= 64);
            const noticeBox = await notice.boundingBox(); assert.ok(noticeBox.x >= 0 && noticeBox.x + noticeBox.width <= 390);
            await page.screenshot({ path: path.join(output, file + '-clickable-toast-mobile.png') });
            await page.locator('.ai-result-toast').last().screenshot({ path: path.join(output, file + '-clickable-toast.png') });
            await notice.hover(); await page.clock.fastForward(6500);
            assert.equal(await notice.isVisible(), true);
            await page.mouse.move(0, 500); await notice.focus(); await page.clock.fastForward(6500);
            assert.equal(await notice.isVisible(), true);
            await watchVideoPause(page);
            await notice.press(file.endsWith('.single.html') ? 'Space' : 'Enter');
            assert.deepEqual(await restoreVideoPause(page), { calls: 1, paused: true });
            assert.equal(await page.locator('#aiChatWindow').evaluate(node => node.hidden), false);
            assert.equal(await page.locator('.ai-result-toast-open').count(), 0);
            assert.equal(await page.locator('#toggleAiChat').evaluate(node => node.classList.contains('ai-chat-unread')), false);
            assert.equal(await page.getByText('保留原有常驻 toast', { exact: true }).count(), 1);
            checks.push('background success toast pauses playback when opened by keyboard, preserves focus timeout and clears AI notices only');

            await hide(page); await selection(page, '#aiSelectionLookup'); await finish(page);
            await page.mouse.move(0, 500); await page.clock.fastForward(6300);
            await page.clock.runFor(250);
            assert.equal(await page.locator('.ai-result-toast-open').count(), 0);
            assert.equal(await page.locator('#toggleAiChat').evaluate(node => node.classList.contains('ai-chat-unread')), true);
            checks.push('completion toast expires after six seconds without clearing the unread marker');

            await page.setViewportSize({ width: 1280, height: 1000 });
            await fresh(page); await background(page, true);
            await page.locator('#aiChatSettingsToggle').click();
            await page.locator('#aiChatSettings').screenshot({ path: path.join(output, file + '-background-options.png') });
            for (const width of [390, 320]) {
                await page.setViewportSize({ width, height: 844 });
                await page.locator('#aiChatBackgroundRequest').check();
                const optionsBox = await page.locator('#aiChatBackgroundOptions label').boundingBox();
                assert.ok(optionsBox.x >= 0 && optionsBox.x + optionsBox.width <= width);
                const enabledLayout = await backgroundLayout(page);
                assert.ok(Math.abs(enabledLayout.parentY - enabledLayout.childY) < 1);
                await page.locator('#aiChatSettings').screenshot({ path: path.join(output, file + '-background-options-' + width + '.png'), style: '#toastContainer { visibility: hidden; }' });
                await page.locator('#aiChatBackgroundRequest').uncheck();
                assert.deepEqual(await backgroundLayout(page), enabledLayout);
                assert.equal(await page.locator('#aiChatBackgroundAutoOpen').isChecked(), false);
                await page.locator('#aiChatSettings').screenshot({ path: path.join(output, file + '-background-disabled-' + width + '.png'), style: '#toastContainer { visibility: hidden; }' });
            }
            await page.setViewportSize({ width: 1280, height: 1000 });
            await page.locator('#aiChatBackgroundRequest').uncheck();
            assert.equal(await page.locator('#aiChatBackgroundOptions').isVisible(), true);
            assert.equal(await page.locator('#aiChatBackgroundAutoOpen').isChecked(), false);
            assert.equal(await page.locator('#aiChatBackgroundAutoOpen').isDisabled(), true);
            assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('AI_CHAT_SETTINGS_V1')).backgroundAutoOpen), false);
            await page.evaluate(() => {
                const settings = JSON.parse(localStorage.getItem('AI_CHAT_SETTINGS_V1'));
                settings.backgroundAutoOpen = true;
                localStorage.setItem('AI_CHAT_SETTINGS_V1', JSON.stringify(settings));
            });
            await page.reload(); await load(page); await show(page); await page.locator('#aiChatSettingsToggle').click();
            assert.equal(await page.locator('#aiChatBackgroundRequest').isChecked(), false);
            assert.equal(await page.locator('#aiChatBackgroundOptions').isVisible(), true);
            assert.equal(await page.locator('#aiChatBackgroundAutoOpen').isChecked(), false);
            await page.locator('#aiChatBackgroundRequest').check();
            assert.equal(await page.locator('#aiChatBackgroundAutoOpen').isChecked(), false);
            await page.locator('#aiChatBackgroundRequest').uncheck();
            await page.locator('#aiChatSettingsToggle').click();
            await submit(page, '关闭后台请求后保持收起'); await hide(page); await finish(page);
            assert.equal(await page.locator('#aiChatWindow').evaluate(node => node.hidden), true);
            await watchVideoPause(page);
            await page.locator('.ai-result-toast-open').last().click();
            assert.deepEqual(await restoreVideoPause(page), { calls: 0, paused: false });
            assert.equal(await page.locator('#aiChatWindow').evaluate(node => node.hidden), false);
            checks.push('disabled background resets auto-open; old checked-disabled settings load unchecked and stay off when re-enabled');

            await background(page, true); await fresh(page); await hide(page);
            await selection(page, '#aiSelectionLookup'); await selection(page, '#aiSelectionAnalyze'); await waitPending(page, 1);
            assert.equal(await page.locator('#aiChatWindow').evaluate(node => node.hidden), true);
            await page.locator('#video').focus();
            const focusBefore = await page.evaluate(() => document.activeElement.id);
            await watchVideoPause(page);
            await finish(page, true);
            assert.equal(await page.locator('#aiChatWindow').evaluate(node => node.hidden), false);
            assert.equal(await page.evaluate(() => document.activeElement.id), focusBefore);
            assert.deepEqual(await restoreVideoPause(page), { calls: 1, paused: true });
            assert.equal(await page.locator('.ai-result-toast-open').count(), 0);
            assert.equal(await page.locator('#toggleAiChat').evaluate(node => node.classList.contains('ai-chat-unread')), false);
            await finish(page);
            checks.push('auto-open pauses an active video, preserves focus, consumes unread state, and allows queued analysis to continue');

            await fresh(page); await hide(page); await selection(page, '#aiSelectionLookup');
            await watchVideoPause(page, true); await finish(page);
            assert.equal(await page.locator('#aiChatWindow').evaluate(node => node.hidden), false);
            assert.deepEqual(await restoreVideoPause(page), { calls: 0, paused: true });
            checks.push('auto-open keeps already-paused playback unchanged');

            await fresh(page); await page.evaluate(() => { queueTest.nextMode = 'error'; });
            await hide(page); await selection(page, '#aiSelectionLookup');
            await watchVideoPause(page); await finish(page);
            assert.deepEqual(await restoreVideoPause(page), { calls: 0, paused: false });
            assert.equal(await page.locator('#aiChatWindow').evaluate(node => node.hidden), true);
            assert.equal(await page.locator('#toggleAiChat').evaluate(node => node.classList.contains('ai-chat-unread-error')), true);
            await watchVideoPause(page);
            await page.locator('.ai-result-toast-open').last().click();
            assert.deepEqual(await restoreVideoPause(page), { calls: 0, paused: false });
            assert.equal(await page.locator('#aiChatWindow').evaluate(node => node.hidden), false);
            assert.equal(await page.locator('#toggleAiChat').evaluate(node => node.classList.contains('ai-chat-unread-error')), false);
            checks.push('failure stays hidden with a clickable error notice even when auto-open is enabled');

            await fresh(page); await hide(page); await selection(page, '#aiSelectionLookup');
            await background(page, false); await hide(page);
            await watchVideoPause(page); await finish(page);
            assert.deepEqual(await restoreVideoPause(page), { calls: 0, paused: false });
            assert.equal(await page.locator('#aiChatWindow').evaluate(node => node.hidden), true);
            checks.push('turning auto-open off during generation takes effect at completion');

            await fresh(page); await background(page, true); await hide(page); await selection(page, '#aiSelectionLookup');
            const stale = await page.evaluate(() => { queueTest.active.ignoreAbort = true; return queueTest.entries.length - 1; });
            await fresh(page); await hide(page); await page.evaluate(index => queueTest.entries[index].finish(), stale);
            assert.equal(await page.locator('#aiChatWindow').evaluate(node => node.hidden), true);
            assert.equal(await page.locator('.ai-result-toast-open').count(), 0);
            checks.push('cancelled stale completion cannot auto-open a new conversation');

            await fresh(page); await background(page, false);
            await submit(page, 'Esc 收起时继续生成'); await submit(page, 'Esc 收起后继续排队');
            await page.locator('#aiChatInput').fill('收起后保留的草稿');
            await page.waitForFunction(() => queueTest.active && !queueTest.active.closed);
            await page.locator('#aiChatInput').press('Escape');
            assert.equal(await page.locator('#aiChatWindow').evaluate(node => node.hidden), true);
            assert.equal(await page.evaluate(() => document.activeElement.id), 'video');
            assert.equal(await page.locator('#aiChatInput').inputValue(), '收起后保留的草稿');
            assert.equal(await page.evaluate(() => !!queueTest.active.aborted), false);
            await waitPending(page, 1); await finish(page, true); await finish(page);
            await show(page);
            assert.equal(await page.locator('#aiChatInput').inputValue(), '收起后保留的草稿');
            checks.push('Esc from composer hides window, returns video focus, preserves draft and continues active and queued requests');

            for (const extra of [{ isComposing: true }, { repeat: true }, { ctrlKey: true }, { altKey: true }, { shiftKey: true }, { metaKey: true }]) {
                await page.locator('#aiChatInput').evaluate((node, extra) => node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, ...extra })), extra);
                assert.equal(await page.locator('#aiChatWindow').evaluate(node => node.hidden), false);
            }
            await fresh(page); await page.locator('#aiChatSettingsToggle').click(); await page.locator('#aiChatProvider').click();
            await page.keyboard.press('Escape');
            assert.equal(await page.locator('#aiChatWindow').evaluate(node => node.hidden), false);
            await page.locator('#aiChatSettingsToggle').click();
            checks.push('IME, held-key repeats, modified Esc and native select dismissal never hide the window');

            await page.locator('#videoPlaybackRateControl').click();
            await page.locator('#fastForwardLimit').press('Escape');
            assert.equal(await page.locator('#fastForwardLimitPopover').isVisible(), false);
            assert.equal(await page.locator('#aiChatWindow').evaluate(node => node.hidden), false);
            await page.keyboard.press('Escape');
            assert.equal(await page.locator('#aiChatWindow').evaluate(node => node.hidden), true);
            checks.push('playback popover consumes its own Esc; the following press can hide AI from outside the window');

            await fresh(page); await submit(page, '队列按钮 Esc 当前项'); await submit(page, '队列按钮 Esc 等待项');
            await rows(page).first().locator('[data-queue-action="edit"]').focus();
            await page.keyboard.press('Escape');
            assert.equal(await page.locator('#aiChatWindow').evaluate(node => node.hidden), true);
            await waitPending(page, 1); await finish(page, true); await finish(page);
            checks.push('Esc on queue controls hides the window without editing, removing or stopping queued work');

            await fresh(page); await selection(page, '#aiSelectionAnalyze'); await finish(page);
            const escapeCard = page.locator('.svp-sa').last();
            await page.locator('#aiChatInput').focus();
            await escapeCard.locator('[data-sa-annotation="3"] > .sa-text').first().hover();
            assert.equal(await escapeCard.locator('.sa-tip').isVisible(), true);
            await page.keyboard.press('Escape');
            assert.equal(await escapeCard.locator('.sa-tip').isVisible(), false);
            assert.equal(await page.locator('#aiChatWindow').evaluate(node => node.hidden), false);
            await page.keyboard.press('Escape');
            assert.equal(await page.locator('#aiChatWindow').evaluate(node => node.hidden), true);
            checks.push('hovered analysis tooltip has Esc priority even while keyboard focus remains in composer');

            await show(page);
            await page.evaluate(() => document.querySelector('#container').requestFullscreen());
            await page.keyboard.press('Escape');
            assert.equal(await page.locator('#aiChatWindow').evaluate(node => node.hidden), false);
            await page.evaluate(async () => { if (document.fullscreenElement) await document.exitFullscreen(); });
            await page.locator('#modalOverlay').evaluate(node => { node.style.display = 'block'; });
            await page.keyboard.press('Escape');
            assert.equal(await page.locator('#aiChatWindow').evaluate(node => node.hidden), false);
            await page.locator('#modalOverlay').evaluate(node => { node.style.display = 'none'; });
            checks.push('fullscreen Esc and a DUFS modal never dismiss the underlying AI window');

            assert.equal(await page.evaluate(() => queueTest.maxLive), 1);
            await page.evaluate(() => {
                localStorage.setItem('svp.dufsUrlHistory.v1', JSON.stringify([{ url: 'http://example.invalid/videos/' }]));
                localStorage.setItem('EUDIC_STUDY_AUTHORIZATION_V1', 'NIS isolated-escape-test');
            });
            await page.reload(); await load(page); await show(page);
            await page.locator('#dufsUrl').focus(); await page.locator('#dufsUrlHistoryList.visible').waitFor();
            await page.locator('#dufsUrl').press('Escape');
            assert.equal(await page.locator('#dufsUrlHistoryList').isVisible(), false);
            assert.equal(await page.locator('#aiChatWindow').evaluate(node => node.hidden), false);
            await selection(page, '#aiSelectionAddEudic'); await page.locator('#eudicContextOverlay').waitFor({ state: 'visible' });
            await page.waitForFunction(() => document.activeElement.id === 'eudicContextEntryWord');
            await page.keyboard.press('Escape');
            assert.equal(await page.locator('#eudicContextOverlay').isVisible(), true);
            assert.equal(await page.evaluate(() => document.activeElement === document.body), true);
            await page.keyboard.press('Escape');
            assert.equal(await page.locator('#eudicContextOverlay').isVisible(), false);
            assert.equal(await page.locator('#aiChatWindow').evaluate(node => node.hidden), false);
            await selection(page, '#aiSelectionAddEudic');
            await page.evaluate(() => { window.SvpEudic.submitWord = () => new Promise((resolve, reject) => { queueTest.rejectEudic = reject; }); });
            await page.locator('#eudicContextSubmit').click(); await page.keyboard.press('Escape');
            assert.equal(await page.locator('#eudicContextOverlay').isVisible(), true);
            assert.equal(await page.locator('#aiChatWindow').evaluate(node => node.hidden), false);
            await page.evaluate(() => queueTest.rejectEudic(new Error('isolated submission cancelled by test')));
            await page.waitForFunction(() => !document.querySelector('#eudicContextSubmit').disabled);
            await page.locator('#eudicContextCurrent').focus();
            await page.keyboard.press('Escape');
            assert.equal(await page.locator('#eudicContextOverlay').isVisible(), true);
            await page.keyboard.press('Escape');
            assert.equal(await page.locator('#eudicContextOverlay').isVisible(), false);
            assert.equal(await page.locator('#aiChatWindow').evaluate(node => node.hidden), false);
            checks.push('DUFS history and Eudic dialog consume Esc first; pending Eudic submission protects both layers');

            await page.route('https://subtitle-video-player-default-rtdb.asia-southeast1.firebasedatabase.app/progress/**', route => route.fulfill({ json: { position: 12, duration: 52.208 } }));
            await page.evaluate(() => {
                const video = document.querySelector('#video'); Object.defineProperty(video, 'duration', { value: 52.208, configurable: true });
                window.svpPlaybackProgress.setSource({ id: 'isolated-escape-priority', name: 'Esc priority fixture' });
                video.dispatchEvent(new Event('loadedmetadata'));
            });
            await page.locator('#resumeProgressPrompt').waitFor({ state: 'visible' });
            await page.locator('#video').focus(); await page.keyboard.press('Escape');
            assert.equal(await page.locator('#aiChatWindow').evaluate(node => node.hidden), true);
            assert.equal(await page.locator('#resumeProgressPrompt').isVisible(), true);
            await page.locator('#video').evaluate(node => node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', repeat: true, bubbles: true, cancelable: true })));
            assert.equal(await page.locator('#resumeProgressPrompt').isVisible(), true);
            await page.keyboard.press('Escape');
            assert.equal(await page.locator('#resumeProgressPrompt').isVisible(), false);
            await page.evaluate(() => window.svpPlaybackProgress.destroy());
            checks.push('one Esc hides only AI; held-key repeats preserve the resume prompt; a separate Esc keeps its original dismissal');
            await verifyEudicEscape(page, checks, file);
            await verifyDufsKeyboard(page, checks);
            assert.equal(await requests(page), 0); assert.deepEqual(errors, []);
            checks.push('never more than one logical request, no page errors, no live AI calls');
            report.push({ file, result: 'passed', checks, layout });
            fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
            console.log(JSON.stringify({ file, result: 'passed', checks: checks.length }));
            await context.close();
        }
    } finally {
        await browser.close(); const resolved = fs.realpathSync(temp);
        assert.ok(resolved.startsWith(fs.realpathSync(root) + path.sep)); fs.rmSync(resolved, { recursive: true, force: true });
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
