// Explicit opt-in real backend corpus check. Set SVP_AI_BACKEND, SVP_AI_PROVIDER and SVP_AI_MODEL; SVP_SENTENCE_CASE optionally selects one fixture id.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'test-results', 'sentence-analysis-live');
const temp = path.join(output, 'tmp');
const backend = process.env.SVP_AI_BACKEND, provider = process.env.SVP_AI_PROVIDER, model = process.env.SVP_AI_MODEL;
if (!backend || !provider || !model) throw Error('Set SVP_AI_BACKEND, SVP_AI_PROVIDER and SVP_AI_MODEL explicitly.');
fs.mkdirSync(temp, { recursive: true }); process.env.TEMP = temp; process.env.TMP = temp;
const { chromium } = require(process.env.SVP_PLAYWRIGHT || 'playwright');
const acceptanceCases = require('../test/fixtures/sentence_analysis_acceptance');

function timestamp(seconds) {
    return '00:00:' + String(seconds).padStart(2, '0') + ',000';
}

function makeSrt(cues) {
    return cues.map((text, index) => {
        const start = index * 5 + 1;
        return (index + 1) + '\n' + timestamp(start) + ' --> ' + timestamp(start + 3) + '\n' + text + '\n';
    }).join('\n');
}

function matches(annotation, expected, source) {
    for (const field of ['text', 'type', 'form', 'sense', 'obstacle']) {
        if (expected[field] !== undefined && annotation[field] !== expected[field]) return false;
    }
    if (expected.head !== undefined) {
        if (!annotation.head || source.slice(annotation.head.start, annotation.head.end) !== expected.head) return false;
    }
    if (expected.restoreIncludes && !(annotation.restore || '').includes(expected.restoreIncludes)) return false;
    return true;
}
function annotationDetails(annotation, source) {
    return {
        text: annotation.text, type: annotation.type, form: annotation.form, sense: annotation.sense,
        obstacle: annotation.obstacle, restore: annotation.restore,
        head: annotation.head ? source.slice(annotation.head.start, annotation.head.end) : ''
    };
}


function evaluateResult(testCase, analysis) {
    const missing = [];
    for (const expectation of testCase.expect) {
        const alternatives = expectation.anyOf || [expectation];
        if (alternatives.some(expected => analysis.result.annotations.some(annotation => matches(annotation, expected, analysis.source)))) continue;
        const texts = alternatives.map(expected => expected.text);
        missing.push({
            expected: expectation,
            candidates: analysis.result.annotations.filter(annotation => texts.includes(annotation.text)).map(annotation => annotationDetails(annotation, analysis.source))
        });
    }
    const violations = [];
    for (const rule of testCase.forbidden || []) {
        const matchesForbidden = analysis.result.annotations.filter(annotation => matches(annotation, rule, analysis.source));
        if (matchesForbidden.length) violations.push({ rule, annotations: matchesForbidden.map(annotation => annotationDetails(annotation, analysis.source)) });
    }
    return {
        missing,
        violations,
        mappingIssues: analysis.result.issues.filter(issue => /未能准确对应|未能对应|已略过/.test(issue)),
        translationMissing: !analysis.result.translation.trim()
    };
}

async function runCase(browser, testCase, report) {
    const record = { id: testCase.id, source: testCase.source, expectedCount: testCase.expect.length, forbiddenCount: (testCase.forbidden || []).length, errors: [], result: 'running' };
    report.cases.push(record);
    const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    const bodies = [], requests = [];
    try {
        page.on('pageerror', error => {
            record.errors.push(error.message);
            report.errors.push(testCase.id + ': ' + error.message);
        });
        await page.addInitScript(settings => localStorage.setItem('AI_CHAT_SETTINGS_V1', JSON.stringify(settings)), {
            backendUrl: backend, provider, model, noSpoiler: true, attachPosition: true, selectionBubblePosition: 'auto'
        });
        page.on('request', request => {
            if (!request.url().endsWith('/stream')) return;
            const payload = request.postDataJSON();
            const item = { case: testCase.id, provider: payload.provider, model: payload.model, id: payload.id, preserve: payload.preserve, started: Date.now() };
            requests.push(item); report.requests.push(item);
            console.log(testCase.id + ': request ' + requests.length + ' / ' + payload.provider + ' / ' + payload.model);
        });
        page.on('response', response => {
            if (!response.url().endsWith('/stream')) return;
            const item = requests[requests.length - 1];
            bodies.push(response.text().then(text => {
                item.elapsedMs = Date.now() - item.started; item.httpStatus = response.status();
                fs.writeFileSync(path.join(output, 'response-' + testCase.id + '-' + item.started + '.txt'), text);
            }).catch(error => { item.readError = error.message; }));
        });
        await page.goto(pathToFileURL(path.join(root, 'subtitle_video_player.html')).href);
        await page.locator('#videoFile').setInputFiles({ name: 'sentence-analysis-' + testCase.id + '.srt', mimeType: 'text/plain', buffer: Buffer.from(makeSrt(testCase.cues)) });
        await page.waitForFunction(model => document.querySelector('#aiChatModel').value === model && !document.querySelector('#aiChatModel').disabled, model);
        await page.evaluate(selection => {
            const walker = document.createTreeWalker(document.querySelector('#subtitles'), NodeFilter.SHOW_TEXT);
            let node;
            while ((node = walker.nextNode())) {
                const at = node.textContent.indexOf(selection); if (at < 0) continue;
                const range = document.createRange(); range.setStart(node, at); range.setEnd(node, at + selection.length);
                getSelection().removeAllRanges(); getSelection().addRange(range); document.dispatchEvent(new Event('selectionchange')); return;
            }
            throw Error('No subtitle selection: ' + selection);
        }, testCase.selection);
        await page.waitForFunction(() => !document.querySelector('#aiSelectionBubble').hidden);
        await page.locator('#aiSelectionAnalyze').click({ force: true });
        await page.waitForFunction(() => document.querySelector('.svp-sa'));
        await page.waitForFunction(() => document.querySelector('#aiChatSend').textContent === '发送', {}, { timeout: 240000 });
        const card = page.locator('.svp-sa').last();
        record.cardText = await card.innerText();
        if (await page.locator('.ai-chat-retry-btn').count()) throw Error(await page.locator('.ai-chat-error-line').innerText());
        const analysis = await page.evaluate(() => {
            const panel = document.querySelector('.ai-chat-msg-ai').sentencePanel;
            return { source: panel.context.source, result: panel.result };
        });
        assert.equal(analysis.source, testCase.source);
        record.annotationCount = analysis.result.annotations.length;
        record.issues = analysis.result.issues;
        record.translation = analysis.result.translation;
        const evaluation = evaluateResult(testCase, analysis);
        record.missing = evaluation.missing;
        record.mappingIssues = evaluation.mappingIssues;
        record.violations = evaluation.violations;
        if (evaluation.translationMissing) record.errors.push('Empty translation');
        fs.writeFileSync(path.join(output, 'parsed-' + testCase.id + '.json'), JSON.stringify(analysis, null, 2));

        if (testCase.id === 'reduced-clause') {
            const linked = analysis.result.annotations.find(annotation => annotation.head);
            assert.ok(linked, 'Real output should expose at least one relationship');
            const target = card.locator('[data-sa-annotation="' + linked.id + '"]');
            const activation = await target.locator(':scope > .sa-chip').count() ? target.locator(':scope > .sa-chip') : target.locator(':scope > .sa-text').first();
            await activation.hover(); await activation.click();
            assert.equal(await card.locator('.sa-arrows path').count(), 2);
            await card.screenshot({ path: path.join(output, 'real-desktop.png') });
            await page.setViewportSize({ width: 390, height: 844 });
            await card.screenshot({ path: path.join(output, 'real-mobile.png') });
            assert.ok(await card.evaluate(node => node.scrollWidth <= node.clientWidth + 2));
            await page.setViewportSize({ width: 1280, height: 1000 });
            await page.locator('#aiChatInput').fill('请解释刚才解析里的 submitted 为什么用过去分词，它修饰什么？用普通中文回答。');
            await page.locator('#aiChatSend').click();
            await page.waitForFunction(() => document.querySelector('#aiChatSend').textContent === '发送', {}, { timeout: 240000 });
            if (await page.locator('.ai-chat-retry-btn').count()) throw Error(await page.locator('.ai-chat-error-line').innerText());
            record.followup = await page.locator('.ai-chat-msg-ai').last().innerText();
            assert.doesNotMatch(record.followup, /^\s*\{\s*"annotations"/);
            assert.match(record.followup, /submitted|过去分词/);
            assert.equal(requests.length, 2);
            assert.equal(requests[0].id, requests[1].id);
        }
        await Promise.all(bodies);
        for (const request of requests) {
            assert.equal(request.provider, provider); assert.equal(request.model, model);
            assert.equal(request.preserve, true); assert.equal(request.httpStatus, 200);
            assert.ifError(request.readError);
        }
        assert.deepEqual(record.errors, []);
        record.result = evaluation.missing.length || evaluation.violations.length || evaluation.mappingIssues.length ? 'failed' : 'passed';
    } finally {
        await Promise.all(bodies);
        await context.close();
    }
}

async function main() {
    const filter = process.env.SVP_SENTENCE_CASE || '';
    const cases = filter ? acceptanceCases.filter(testCase => testCase.id === filter) : acceptanceCases;
    const report = { provider, model, caseFilter: filter, requests: [], cases: [], errors: [], result: 'running' };
    let browser;
    try {
        if (!cases.length) throw Error('Unknown SVP_SENTENCE_CASE: ' + filter);
        browser = await chromium.launch({ channel: 'chrome', headless: true });
        for (const testCase of cases) {
            try {
                await runCase(browser, testCase, report);
            } catch (error) {
                const record = report.cases.find(item => item.id === testCase.id);
                if (record) { record.result = 'failed'; record.error = error.message; }
                else report.cases.push({ id: testCase.id, result: 'failed', error: error.message });
                console.error(testCase.id + ': ' + error.message);
            }
        }
        const failed = report.cases.filter(testCase => testCase.result !== 'passed');
        report.result = failed.length ? 'failed' : 'passed';
        console.log(JSON.stringify({ result: report.result, cases: report.cases.map(testCase => ({
            id: testCase.id, result: testCase.result, annotations: testCase.annotationCount,
            missing: testCase.missing?.length, violations: testCase.violations?.length, mappingIssues: testCase.mappingIssues, error: testCase.error
        })) }, null, 2));
        if (failed.length) throw Error(failed.map(testCase => testCase.id).join(', ') + ' did not meet the acceptance contract');
    } catch (error) {
        report.result = 'failed'; report.error = error.message; throw error;
    } finally {
        fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
        if (browser) await browser.close();
        const resolved = fs.realpathSync(temp);
        if (resolved.startsWith(fs.realpathSync(root) + path.sep)) fs.rmSync(temp, { recursive: true, force: true });
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
