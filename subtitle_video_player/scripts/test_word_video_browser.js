// Isolated browser checks: all AI, video metadata and CDN requests are mocked.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'test-results', 'word-video');
const temp = path.join(output, 'tmp');
fs.mkdirSync(temp, { recursive: true }); process.env.TEMP = temp; process.env.TMP = temp;
const { chromium } = require(process.env.SVP_PLAYWRIGHT || 'playwright');
const report = [];
const srt = '1\n00:00:01,000 --> 00:00:04,000\nShe sings beautifully and ran home.\n\n2\n00:00:05,000 --> 00:00:08,000\nThe program has useful features.\n\n3\n00:00:09,000 --> 00:00:12,000\nWe need an apricot.\n';

async function installMocks(page) {
    await page.addInitScript(() => {
        localStorage.setItem('AI_CHAT_SETTINGS_V1', JSON.stringify({ backendUrl: 'http://mock-ai.test', provider: 'mock', model: 'selected-model', backgroundRequest: false }));
        const state = window.wordVideoTest = { chats: [], metadata: [], candidates: [], modes: {}, candidateMode: 'hold', candidatesValue: ['beautiful'], speech: 0, mainPlaying: false, mainPauses: 0 };
        const original = window.fetch;
        window.fetch = (url, options = {}) => {
            const address = String(url);
            if (address.endsWith('/models')) return Promise.resolve(Response.json({ providers: [{ id: 'mock', models: ['selected-model'] }] }));
            if (address.endsWith('/stream')) {
                const payload = JSON.parse(options.body), entry = { payload, aborted: false, closed: false };
                state.chats.push(entry);
                return Promise.resolve(new Response(new ReadableStream({ start(controller) {
                    const encoder = new TextEncoder(); let closed = false;
                    const emit = data => { if (!closed) controller.enqueue(encoder.encode('data: ' + JSON.stringify(data) + '\n\n')); };
                    entry.delta = text => emit({ type: 'delta', content: text });
                    entry.finish = () => { if (closed) return; emit({ type: 'delta', content: '\n回答完成。' }); emit({ type: 'done' }); closed = true; entry.closed = true; controller.close(); };
                    entry.delta('词汇详解：**beautifully**[[SPEAK:beautifully]] 用于本句。');
                    options.signal.addEventListener('abort', () => { entry.aborted = true; entry.closed = true; if (!closed) { closed = true; controller.error(new DOMException('Aborted', 'AbortError')); } });
                } }), { headers: { 'Content-Type': 'text/event-stream' } }));
            }
            if (address.startsWith('https://baidu-word-video-service-c7e3.netlify.app/v1/video')) {
                const word = new URL(address).searchParams.get('word');
                const entry = { word, signal: options.signal }; state.metadata.push(entry);
                const answer = () => Response.json({ ok: true, word, hasVideo: ['beautiful', 'feature', 'run'].includes(word), video: ['beautiful', 'feature', 'run'].includes(word) ? {
                    videoUrl: 'https://media.example.test/' + (word === 'run' ? 'portrait.mp4' : 'word.mp4'), coverUrl: 'https://media.example.test/cover.svg', videoTime: 30
                } : null });
                const mode = state.modes[word];
                if (mode === 'error') return Promise.resolve(Response.json({ ok: false }, { status: 503 }));
                if (mode === 'hold' || mode === 'late') return new Promise((resolve, reject) => {
                    entry.finish = () => resolve(answer());
                    options.signal.addEventListener('abort', () => { entry.aborted = true; if (mode !== 'late') reject(new DOMException('Aborted', 'AbortError')); });
                });
                return Promise.resolve(answer());
            }
            if (address === 'http://mock-ai.test/') {
                const entry = { payload: JSON.parse(options.body), signal: options.signal }; state.candidates.push(entry);
                const response = () => state.candidateMode === 'error' ? new Response('unavailable', { status: 503 }) : new Response(JSON.stringify({ candidates: state.candidatesValue }));
                if (state.candidateMode === 'hold') return new Promise((resolve, reject) => {
                    entry.finish = () => resolve(response());
                    options.signal.addEventListener('abort', () => { entry.aborted = true; reject(new DOMException('Aborted', 'AbortError')); });
                });
                return Promise.resolve(response());
            }
            return original(url, options);
        };
        Object.defineProperty(window, 'speechSynthesis', { value: { getVoices: () => [{ lang: 'en-US', default: true }], addEventListener() {}, speak() { state.speech++; }, cancel() {} } });
        window.SpeechSynthesisUtterance = function (text) { this.text = text; };
        document.addEventListener('DOMContentLoaded', () => {
            const main = document.querySelector('#video');
            Object.defineProperty(main, 'currentTime', { get: () => 2, set() {} });
            Object.defineProperty(main, 'paused', { get: () => !state.mainPlaying });
            main.pause = () => { state.mainPauses++; state.mainPlaying = false; };
        });
    });
}

async function show(page) { if (await page.locator('#aiChatWindow').evaluate(node => node.hidden)) await page.locator('#toggleAiChat').click(); }
async function lookup(page, word) {
    await page.evaluate(word => {
        const walker = document.createTreeWalker(document.querySelector('#subtitles'), NodeFilter.SHOW_TEXT); let node;
        while ((node = walker.nextNode())) {
            const start = node.textContent.indexOf(word); if (start < 0) continue;
            const range = document.createRange(); range.setStart(node, start); range.setEnd(node, start + word.length);
            getSelection().removeAllRanges(); getSelection().addRange(range); document.dispatchEvent(new Event('selectionchange')); return;
        }
        throw Error('Missing word ' + word);
    }, word);
    await page.waitForFunction(() => !document.querySelector('#aiSelectionBubble').hidden);
    await page.locator('#aiSelectionLookup').click({ force: true });
}
async function finish(page) {
    await page.waitForFunction(() => wordVideoTest.chats.at(-1)?.finish && !wordVideoTest.chats.at(-1).closed);
    await page.evaluate(() => wordVideoTest.chats.at(-1).finish());
    await page.waitForFunction(() => document.querySelector('#aiChatStop').hidden);
}
async function fresh(page) { await show(page); await page.locator('#aiChatNewConversation').click(); }
async function submit(page, text) { await show(page); await page.locator('#aiChatInput').fill(text); await page.locator('#aiChatInput').press('Enter'); }
async function heightWithinAnswerArea(page) {
    await page.waitForFunction(() => {
        const stage = document.querySelector('.word-video-stage');
        return stage && stage.clientHeight > 0 && stage.clientHeight <= document.querySelector('#aiChatMessages').clientHeight * 2 / 3;
    });
}
async function videoFullyVisible(page) {
    await page.waitForFunction(() => {
        const box = document.querySelector('#aiChatMessages');
        const stage = document.querySelector('.word-video-stage');
        const header = document.querySelector('.word-video-header');
        if (!stage || stage.hidden) return false;
        const view = box.getBoundingClientRect(), player = stage.getBoundingClientRect();
        return header.getBoundingClientRect().top >= view.top + box.clientTop && player.bottom <= view.top + box.clientTop + box.clientHeight;
    }, null, { timeout: 3000 });
}

async function main() {
    const server = http.createServer((request, response) => {
        const file = path.resolve(root, '.' + decodeURIComponent(new URL(request.url, 'http://localhost').pathname));
        if (!file.startsWith(root + path.sep)) { response.writeHead(403).end(); return; }
        const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[path.extname(file)] || 'application/octet-stream';
        fs.readFile(file, (error, data) => { response.writeHead(error ? 404 : 200, { 'Content-Type': mime }); response.end(error ? '' : data); });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = 'http://127.0.0.1:' + server.address().port;
    const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--mute-audio'], downloadsPath: path.join(temp, 'downloads') });
    try {
        for (const file of ['subtitle_video_player.html']) {
            const checks = [], errors = [], mediaRequests = [];
            const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, reducedMotion: 'reduce' });
            const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
            let holdMedia = false, releaseMedia, mediaArrived;
            await installMocks(page);
            await page.route('https://media.example.test/**', route => {
                mediaRequests.push(route.request().url());
                if (route.request().url().endsWith('.svg')) return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="88"><rect width="128" height="88" fill="#5275ac"/><text x="12" y="49" fill="white" font-size="18">Word video</text></svg>' });
                const fulfill = () => route.fulfill({ contentType: 'video/mp4', body: fs.readFileSync(path.join(output, route.request().url().endsWith('portrait.mp4') ? 'mock-portrait.mp4' : 'mock.mp4')) });
                if (holdMedia) {
                    holdMedia = false;
                    releaseMedia = fulfill;
                    mediaArrived();
                    return;
                }
                return fulfill();
            });
            await page.route(/https?:\/\//, route => route.request().url().startsWith(base) || route.request().url().startsWith('https://media.example.test/') ? route.fallback() : route.abort());
            await page.goto(base + '/' + file);
            await page.locator('#videoFile').setInputFiles({ name: 'word-video.srt', mimeType: 'text/plain', buffer: Buffer.from(srt) });
            await page.waitForFunction(() => document.querySelector('#subtitles').textContent.includes('beautifully'));

            await lookup(page, 'beautifully');
            await page.waitForFunction(() => wordVideoTest.candidates.length === 1);
            const payloads = await page.evaluate(() => ({ chat: wordVideoTest.chats[0].payload, candidate: wordVideoTest.candidates[0].payload }));
            assert.notEqual(payloads.chat.id, payloads.candidate.id);
            assert.equal(payloads.chat.preserve, true); assert.equal(payloads.candidate.preserve, false);
            assert.equal(payloads.candidate.provider, payloads.chat.provider); assert.equal(payloads.candidate.model, payloads.chat.model);
            assert.doesNotMatch(JSON.stringify(payloads.candidate), /apricot|COCA|完整字幕/);
            await finish(page);
            await submit(page, '普通问答继续');
            assert.equal(await page.evaluate(() => wordVideoTest.chats.length), 2);
            await page.evaluate(() => wordVideoTest.candidates[0].finish());
            await page.waitForFunction(() => document.querySelector('.word-video-title')?.textContent.includes('beautiful'));
            assert.equal(await page.locator('.word-video-group .ai-chat-msg-ai').count(), 1);
            assert.match(await page.locator('.word-video-subtitle').textContent(), /相关词形/);
            assert.equal(await page.locator('.word-video-stage video').getAttribute('src'), null);
            assert.equal(mediaRequests.some(url => url.endsWith('.mp4')), false);
            await finish(page);
            checks.push('main AI finishes and starts the next question while an isolated candidate request is pending; late attachment stays on its own card');
            checks.push('candidate uses captured provider/model, a separate id, preserve:false and only the selected word/sentence; video is not prefetched');

            await page.locator('#aiChatWindow').evaluate(node => { node.style.width = '1100px'; node.style.height = '850px'; node.style.left = '16px'; node.style.top = '16px'; node.style.bottom = 'auto'; });
            await page.evaluate(() => {
                document.querySelectorAll('.ai-chat-msg-ai').forEach(message => {
                    const paragraph = document.createElement('p'); paragraph.textContent = '用于复现历史回答中间展开视频的完整讲解。'.repeat(180); message.appendChild(paragraph);
                });
                const box = document.querySelector('#aiChatMessages'), header = document.querySelector('.word-video-header');
                box.scrollTop += header.getBoundingClientRect().top - box.getBoundingClientRect().top - box.clientHeight * 0.45;
            });
            const arrival = new Promise(resolve => { mediaArrived = resolve; }); holdMedia = true;
            await page.locator('#aiChatWindow').screenshot({ path: path.join(output, file + '-history-before.png') });
            await page.locator('.word-video-header').click();
            await arrival;
            try { await videoFullyVisible(page); }
            catch (error) { await page.locator('#aiChatWindow').screenshot({ path: path.join(output, file + '-history-clipped.png') }); throw error; }
            await page.locator('#aiChatWindow').screenshot({ path: path.join(output, file + '-history-expanded.png') });
            const manualScroll = await page.evaluate(() => {
                const box = document.querySelector('#aiChatMessages'); box.scrollTop += 300; return box.scrollTop;
            });
            await releaseMedia();
            await page.waitForFunction(() => document.querySelector('.word-video-stage video').videoWidth === 320);
            await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
            assert.ok(Math.abs(await page.locator('#aiChatMessages').evaluate(box => box.scrollTop) - manualScroll) <= 1);
            await page.locator('.word-video-header').click();
            await page.locator('.word-video-header').click();
            await videoFullyVisible(page);
            await heightWithinAnswerArea(page);
            await page.locator('#aiChatWindow').evaluate(node => { node.style.width = '420px'; node.style.height = '520px'; });
            checks.push('opening an older card reveals the whole player; delayed metadata respects manual scrolling; reopening keeps the whole player visible');

            await fresh(page); await lookup(page, 'features');
            await page.waitForFunction(() => document.querySelector('.word-video-title')?.textContent.includes('feature'));
            assert.equal(await page.evaluate(() => wordVideoTest.candidates.length), 1);
            await page.evaluate(() => { wordVideoTest.mainPlaying = true; });
            await page.locator('.word-video-header').click();
            await page.waitForFunction(() => document.querySelector('.word-video-stage video').videoWidth === 320);
            await heightWithinAnswerArea(page);
            assert.equal(await page.locator('.word-video-stage video').getAttribute('crossorigin'), null);
            assert.equal(await page.evaluate(() => wordVideoTest.mainPlaying), false);
            await page.evaluate(() => {
                Object.defineProperty(document.querySelector('#video'), 'readyState', { value: 4, configurable: true });
                document.querySelector('#hideControl').checked = true;
                window.jQuery('#video').trigger('mouseleave');
            });
            const panelStyles = await page.evaluate(() => Array.from(document.head.querySelectorAll('style')).map(node => node.textContent).find(text => text.includes('media-controls-panel')));
            assert.match(panelStyles, /#video::-webkit-media-controls-panel/);
            assert.doesNotMatch(panelStyles, /(?:^|\n)\s*video::/);
            await page.locator('.word-video-stage video').hover();
            const seekBox = await page.locator('.word-video-stage video').boundingBox();
            await page.mouse.move(seekBox.x + seekBox.width * 0.25, seekBox.y + seekBox.height - 19);
            await page.mouse.down();
            await page.mouse.move(seekBox.x + seekBox.width * 0.7, seekBox.y + seekBox.height - 19, { steps: 8 });
            await page.mouse.up();
            await page.waitForFunction(() => document.querySelector('.word-video-stage video').currentTime > 10);
            await page.evaluate(() => { wordVideoTest.videoNode = document.querySelector('.word-video-stage video'); wordVideoTest.chats.at(-1).delta('\n流式追加文字。'); });
            await page.waitForFunction(() => document.querySelector('.ai-chat-msg-ai').textContent.includes('流式追加文字'));
            assert.equal(await page.evaluate(() => document.querySelector('.word-video-stage video') === wordVideoTest.videoNode), true);
            assert.equal(await page.locator('.word-video-stage video').evaluate(video => video.paused), false);
            await page.locator('.lookup-speech-button').click();
            assert.equal(await page.locator('.word-video-stage video').evaluate(video => video.paused), true);
            await page.locator('.word-video-stage video').evaluate(video => video.play());
            await page.evaluate(() => document.querySelector('#video').dispatchEvent(new Event('play')));
            assert.equal(await page.locator('.word-video-stage video').evaluate(video => video.paused), true);
            await page.locator('.word-video-stage video').evaluate(video => video.play());
            await page.locator('#aiChatClose').click();
            assert.equal(await page.locator('.word-video-stage video').evaluate(video => video.paused), true);
            assert.equal(await page.evaluate(() => wordVideoTest.chats.at(-1).aborted), false);
            await finish(page); await show(page);
            await page.locator('#aiChatWindow').screenshot({ path: path.join(output, file + '-desktop.png') });
            await page.setViewportSize({ width: 390, height: 844 });
            await page.waitForFunction(() => document.querySelector('#aiChatWindow').getBoundingClientRect().width <= innerWidth);
            await heightWithinAnswerArea(page);
            assert.equal(await page.locator('.word-video-group').evaluate(node => node.scrollWidth <= node.clientWidth + 1), true);
            await page.locator('#aiChatWindow').screenshot({ path: path.join(output, file + '-mobile.png') });
            await page.setViewportSize({ width: 1280, height: 1000 });
            await page.locator('#aiChatWindow').evaluate(node => { node.style.width = '1100px'; node.style.height = '850px'; node.style.left = '16px'; node.style.top = '16px'; node.style.bottom = 'auto'; });
            await page.waitForFunction(() => document.querySelector('#aiChatWindow').clientWidth >= 1000);
            await heightWithinAnswerArea(page);
            await page.locator('.word-video-stage video').hover();
            await page.locator('.word-video-stage').scrollIntoViewIfNeeded();
            await page.locator('#aiChatWindow').screenshot({ path: path.join(output, file + '-wide-landscape.png') });
            await fresh(page);
            await page.evaluate(() => { wordVideoTest.candidateMode = 'success'; wordVideoTest.candidatesValue = ['run']; });
            await lookup(page, 'ran');
            await page.waitForFunction(() => document.querySelector('.word-video-title')?.textContent.includes('run'));
            await page.locator('.word-video-header').click();
            await page.waitForFunction(() => document.querySelector('.word-video-stage video').videoHeight === 320);
            await videoFullyVisible(page);
            await heightWithinAnswerArea(page);
            const portrait = await page.locator('.word-video-stage').boundingBox();
            assert.ok(portrait.width / portrait.height < 0.57);
            await page.locator('.word-video-stage video').hover();
            const portraitSeek = await page.locator('.word-video-stage video').boundingBox();
            await page.mouse.move(portraitSeek.x + portraitSeek.width * 0.25, portraitSeek.y + portraitSeek.height - 19);
            await page.mouse.down();
            await page.mouse.move(portraitSeek.x + portraitSeek.width * 0.7, portraitSeek.y + portraitSeek.height - 19, { steps: 8 });
            await page.mouse.up();
            await page.waitForFunction(() => document.querySelector('.word-video-stage video').currentTime > 10);
            await finish(page);
            await page.locator('.word-video-stage video').hover();
            await page.locator('#aiChatWindow').screenshot({ path: path.join(output, file + '-wide-portrait.png') });
            await page.locator('#aiChatWindow').evaluate(node => { node.style.width = '420px'; node.style.height = '520px'; });
            await page.waitForFunction(() => document.querySelector('.word-video-stage').clientHeight < 400);
            await heightWithinAnswerArea(page);
            checks.push('video height stays within two thirds of the visible answer area on desktop, mobile, landscape, portrait and window resize');
            checks.push('main-player hidden controls do not hide attachment controls; real mouse seeks work in landscape and portrait; sizing follows video ratio and window resizing');
            checks.push('local base avoids extra AI; direct playback, speech and main-video audio coordination work; streaming preserves the same playing video node');
            checks.push('hiding pauses the attachment without aborting generation; desktop and narrow layouts fit');

            await fresh(page);
            await page.evaluate(() => { wordVideoTest.modes.apricot = 'error'; });
            const before = await page.evaluate(() => wordVideoTest.candidates.length);
            await lookup(page, 'apricot'); await finish(page);
            await page.waitForFunction(() => document.querySelector('.word-video-retry'));
            assert.equal(await page.evaluate(() => wordVideoTest.candidates.length), before);
            assert.equal(await page.locator('.ai-chat-msg-error').count(), 0);
            const mainCount = await page.evaluate(() => wordVideoTest.chats.length);
            await page.locator('#aiChatInput').fill('保留输入草稿');
            await page.evaluate(() => { delete wordVideoTest.modes.apricot; wordVideoTest.candidateMode = 'success'; wordVideoTest.candidatesValue = []; });
            await page.locator('.word-video-retry').click();
            await page.waitForFunction(() => document.querySelector('.word-video-attachment').hidden);
            assert.equal(await page.evaluate(() => wordVideoTest.chats.length), mainCount);
            assert.equal(await page.locator('#aiChatInput').inputValue(), '保留输入草稿');
            checks.push('video failure has only an attachment retry; no AI error, queue pause, extra main request or draft loss; normal absence hides the attachment');

            await fresh(page);
            await page.evaluate(() => { wordVideoTest.modes.program = 'late'; });
            await lookup(page, 'program');
            await page.waitForFunction(() => wordVideoTest.metadata.some(entry => entry.word === 'program' && entry.finish));
            await page.locator('#aiChatStop').click();
            await page.waitForFunction(() => document.querySelector('#aiChatStop').hidden);
            await page.evaluate(() => wordVideoTest.metadata.filter(entry => entry.word === 'program' && entry.finish).at(-1).finish());
            await page.waitForFunction(() => document.querySelector('.word-video-attachment').hidden);
            await fresh(page);
            await page.evaluate(() => { wordVideoTest.modes.sings = 'late'; });
            await lookup(page, 'sings');
            await page.waitForFunction(() => wordVideoTest.metadata.some(entry => entry.word === 'sings' && entry.finish));
            await fresh(page);
            await page.evaluate(() => wordVideoTest.metadata.filter(entry => entry.word === 'sings' && entry.finish).at(-1).finish());
            await submit(page, '新会话正常问答'); await finish(page);
            assert.equal(await page.locator('.word-video-group').count(), 0);
            checks.push('stop and new conversation ignore late uncooperative metadata without attaching to the next reply');
            assert.deepEqual(errors, []);
            report.push({ file, result: 'passed', checks, mainRequests: await page.evaluate(() => wordVideoTest.chats.length) });
            await context.close();
            for (const fault of ['missing', 'initialization failure']) {
                const isolated = await browser.newContext();
                const fallbackPage = await isolated.newPage();
                const fallbackErrors = [];
                fallbackPage.on('pageerror', error => fallbackErrors.push(error.message));
                await installMocks(fallbackPage);
                await fallbackPage.addInitScript(fault => {
                    Object.defineProperty(window, 'SvpWordVideo', {
                        get: () => fault === 'missing' ? undefined : { createController() { throw Error('simulated optional module failure'); } },
                        set() {}
                    });
                }, fault);
                await fallbackPage.route(/^https?:/, route => route.request().url().startsWith(base) ? route.continue() : route.abort());
                await fallbackPage.goto(base + '/' + file);
                await fallbackPage.locator('#videoFile').setInputFiles({ name: 'optional-module.srt', mimeType: 'text/plain', buffer: Buffer.from(srt) });
                await fallbackPage.waitForFunction(() => document.querySelector('#subtitles').textContent.includes('beautifully'));
                await lookup(fallbackPage, 'beautifully'); await finish(fallbackPage);
                assert.equal(await fallbackPage.locator('.word-video-group').count(), 0);
                assert.equal(await fallbackPage.locator('.lookup-speech-button').count(), 1);
                assert.match(await fallbackPage.locator('.ai-chat-msg-ai').textContent(), /回答完成/);
                assert.equal(await fallbackPage.evaluate(() => wordVideoTest.candidates.length + wordVideoTest.metadata.length), 0);
                assert.deepEqual(fallbackErrors, []);
                await isolated.close();
            }
            checks.push('missing or throwing optional module preserves lookup, speech controls and normal AI completion');
        }
        fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
        console.log(JSON.stringify(report, null, 2));
    } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
