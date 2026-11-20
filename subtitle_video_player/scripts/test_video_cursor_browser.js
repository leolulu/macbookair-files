const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const temp = path.join(root, 'test-results', 'video-cursor', 'tmp');
fs.mkdirSync(temp, { recursive: true });
process.env.TEMP = process.env.TMP = process.env.TMPDIR = temp;
const { chromium } = require(process.env.SVP_PLAYWRIGHT || 'playwright');

// The page sees the whole native control bar as <video>. Inspect the actual hit inside it.
async function cursorAt(session, point) {
    const { backendNodeId } = await session.send('DOM.getNodeForLocation', {
        ...point, includeUserAgentShadowDOM: true
    });
    const { nodeIds } = await session.send('DOM.pushNodesByBackendIdsToFrontend', { backendNodeIds: [backendNodeId] });
    const { computedStyle } = await session.send('CSS.getComputedStyleForNode', { nodeId: nodeIds[0] });
    return computedStyle.find(property => property.name === 'cursor').value;
}

async function nativePlayButtonCenter(session) {
    const { root } = await session.send('DOM.getDocument');
    const { nodeId } = await session.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#video' });
    const { node } = await session.send('DOM.describeNode', { nodeId, depth: -1, pierce: true });
    const { object } = await session.send('DOM.resolveNode', { backendNodeId: node.shadowRoots[0].backendNodeId });
    const { result } = await session.send('Runtime.callFunctionOn', {
        objectId: object.objectId,
        functionDeclaration: `function () {
            const button = this.querySelector('[pseudo="-webkit-media-controls-panel"] [pseudo="-webkit-media-controls-play-button"]');
            const box = button?.getBoundingClientRect();
            if (!box?.width) return null;
            return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
        }`,
        returnByValue: true
    });
    assert.ok(result.value, 'native play button must be visible');
    return result.value;
}

async function checkPage(page, file) {
    await page.route(/^https?:/, route => route.abort());
    await page.goto(pathToFileURL(path.join(root, file)).href);
    await page.waitForFunction(() => !!window.svpPlaybackProgress);
    await page.evaluate(() => window.svpPlaybackProgress.destroy());
    await page.locator('#videoFile').setInputFiles(path.join(root, 'test/fixtures/cursor-playback.webm'));
    const video = page.locator('#video');
    await page.waitForFunction(() => document.querySelector('#video').readyState >= 3);
    await video.evaluate(element => {
        for (const type of ['pause', 'playing']) {
            element.addEventListener(type, () => { window.cursorTestMediaEvent = type; });
        }
    });
    const box = await video.boundingBox();
    const picture = { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 3) };
    const session = await page.context().newCDPSession(page);
    await session.send('DOM.enable');
    await session.send('CSS.enable');
    await page.mouse.move(picture.x, picture.y);
    const button = await nativePlayButtonCenter(session);
    const waitForMediaEvent = type => page.waitForFunction(value => window.cursorTestMediaEvent === value, type);

    // Space operates the focused native button while the pointer stays on the picture.
    await page.mouse.click(button.x, button.y);
    await waitForMediaEvent('playing');
    await page.mouse.move(picture.x, picture.y);
    await page.keyboard.press('Space');
    await waitForMediaEvent('pause');
    assert.notEqual(await cursorAt(session, picture), 'none');
    await page.keyboard.press('Space');
    await waitForMediaEvent('playing');
    await page.waitForTimeout(2200);
    assert.equal(await cursorAt(session, picture), 'none', 'stationary pointer after keyboard resume');

    await page.mouse.move(picture.x + 2, picture.y);
    assert.notEqual(await cursorAt(session, { x: picture.x + 2, y: picture.y }), 'none', 'mouse movement');
    await page.mouse.move(button.x, button.y);
    await page.waitForTimeout(2200);
    assert.notEqual(await cursorAt(session, button), 'none', 'stationary pointer over a native control');

    // Closing this popover returns focus to the video after the pointer is already idle.
    await page.locator('#videoPlaybackRateControl').click();
    await page.keyboard.press('Escape');
    await page.mouse.move(picture.x, picture.y);
    await page.waitForTimeout(2200);
    assert.equal(await cursorAt(session, picture), 'none');
    await page.waitForFunction(() => document.activeElement === document.querySelector('#video'));
    assert.equal(await cursorAt(session, picture), 'none', 'delayed video focus');
    await page.keyboard.press('Space');
    await waitForMediaEvent('pause');
    assert.notEqual(await cursorAt(session, picture), 'none', 'pause without moving');
}

async function main() {
    const browser = await chromium.launch({
        channel: 'chrome', headless: !process.argv.includes('--headed'), args: ['--mute-audio']
    });
    try {
        for (const file of ['subtitle_video_player.html', 'subtitle_video_player.single.html']) {
            const page = await browser.newPage({ viewport: { width: 1240, height: 850 } });
            await checkPage(page, file);
            await page.close();
            console.log(file + ' cursor checks passed');
        }
    } finally {
        await browser.close();
    }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
