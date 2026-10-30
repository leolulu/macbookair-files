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
async function selection(page, button, text = 'submitted') {
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
    await page.locator(button).click({ force: true });
}
async function load(page, name = 'queue.srt') {
    const srt = '1\n00:00:01,000 --> 00:00:04,000\nThe committee rejected the proposal submitted yesterday,\n\n2\n00:00:04,100 --> 00:00:10,000\nfearing that the plan, if implemented hastily, would undermine public trust.\n\n3\n00:00:12,000 --> 00:00:15,000\nPlease reconsider.\n';
    await page.locator('#videoFile').setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from(srt) });
    await page.waitForFunction(() => document.querySelector('#subtitles').textContent.includes('submitted'));
}
async function fresh(page) { await show(page); await page.locator('#aiChatNewConversation').click(); await idle(page); await waitPending(page, 0); }
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
            const sourceCount = await requests(page); await load(page, 'same-text-new-file.srt'); await idle(page); await waitPending(page, 0);
            assert.equal(await requests(page), sourceCount); await submit(page, '新字幕问题'); await finish(page);
            checks.push('new subtitle file clears queue even when text and weak fingerprint are identical');
            await submit(page, '换视频当前项'); await submit(page, '旧视频队列');
            await page.evaluate(() => { document.querySelector('#videoUrl').value = 'https://example.invalid/new-video.mp4'; document.querySelector('#loadVideoUrl').click(); });
            await idle(page); await waitPending(page, 0); checks.push('video source change aborts current response and clears old queue');

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
            await notice.press(file.endsWith('.single.html') ? 'Space' : 'Enter');
            assert.equal(await page.locator('#aiChatWindow').evaluate(node => node.hidden), false);
            assert.equal(await page.locator('.ai-result-toast-open').count(), 0);
            assert.equal(await page.locator('#toggleAiChat').evaluate(node => node.classList.contains('ai-chat-unread')), false);
            assert.equal(await page.getByText('保留原有常驻 toast', { exact: true }).count(), 1);
            checks.push('larger completion target fits 390px; hover and focus pause dismissal; keyboard opens and clears AI notices only');

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
            await page.locator('.ai-result-toast-open').last().click();
            assert.equal(await page.locator('#aiChatWindow').evaluate(node => node.hidden), false);
            checks.push('disabled background resets auto-open; old checked-disabled settings load unchecked and stay off when re-enabled');

            await background(page, true); await fresh(page); await hide(page);
            await selection(page, '#aiSelectionLookup'); await selection(page, '#aiSelectionAnalyze'); await waitPending(page, 1);
            assert.equal(await page.locator('#aiChatWindow').evaluate(node => node.hidden), true);
            await page.locator('#video').focus();
            const focusBefore = await page.evaluate(() => document.activeElement.id);
            await finish(page, true);
            assert.equal(await page.locator('#aiChatWindow').evaluate(node => node.hidden), false);
            assert.equal(await page.evaluate(() => document.activeElement.id), focusBefore);
            assert.equal(await page.locator('.ai-result-toast-open').count(), 0);
            assert.equal(await page.locator('#toggleAiChat').evaluate(node => node.classList.contains('ai-chat-unread')), false);
            await finish(page);
            checks.push('auto-open waits for success, preserves focus, consumes unread state, and allows queued analysis to continue');

            await fresh(page); await page.evaluate(() => { queueTest.nextMode = 'error'; });
            await hide(page); await selection(page, '#aiSelectionLookup'); await finish(page);
            assert.equal(await page.locator('#aiChatWindow').evaluate(node => node.hidden), true);
            assert.equal(await page.locator('#toggleAiChat').evaluate(node => node.classList.contains('ai-chat-unread-error')), true);
            await page.locator('.ai-result-toast-open').last().click();
            assert.equal(await page.locator('#aiChatWindow').evaluate(node => node.hidden), false);
            assert.equal(await page.locator('#toggleAiChat').evaluate(node => node.classList.contains('ai-chat-unread-error')), false);
            checks.push('failure stays hidden with a clickable error notice even when auto-open is enabled');

            await fresh(page); await hide(page); await selection(page, '#aiSelectionLookup');
            await background(page, false); await hide(page); await finish(page);
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
            checks.push('fullscreen Esc and an existing file-selection modal keep their existing behavior');

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
