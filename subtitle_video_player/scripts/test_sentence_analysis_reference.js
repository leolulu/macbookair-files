// Compare native player DOM with the installed Read Frog 1.52.1 snapshot and interaction oracle.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'test-results', 'sentence-analysis-reference');
const temp = path.join(output, 'tmp');
fs.mkdirSync(temp, { recursive: true }); process.env.TEMP = temp; process.env.TMP = temp;
const playwrightPath = process.env.SVP_PLAYWRIGHT || 'playwright';
const { chromium } = require(playwrightPath);
const { PNG } = require(require.resolve('pngjs', { paths: [path.dirname(require.resolve(playwrightPath))] }));
const reference = require('../test/fixtures/readfrog-1.52.1.json');
const states = [
    { name: 'default' }, { name: 'subject', id: 11 }, { name: 'attributive', id: 3 },
    { name: 'appositive', id: 9 }, { name: 'conditional', id: 12 },
    { name: 'trunk', trunk: true }, { name: 'slashes', slashes: true }, { name: 'both', trunk: true, slashes: true }
];

function compare(a, b, diffPath) {
    const width = Math.max(a.width, b.width), height = Math.max(a.height, b.height);
    const diff = new PNG({ width, height });
    let different = 0;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4, ai = (y * a.width + x) * 4, bi = (y * b.width + x) * 4;
        const mismatch = x >= a.width || x >= b.width || y >= a.height || y >= b.height || [0, 1, 2, 3].some(c => Math.abs(a.data[ai + c] - b.data[bi + c]) > 20);
        if (mismatch) { different++; diff.data[i] = 220; diff.data[i + 1] = 20; diff.data[i + 2] = 70; }
        else { diff.data[i] = diff.data[i + 1] = diff.data[i + 2] = 245; }
        diff.data[i + 3] = 255;
    }
    fs.writeFileSync(diffPath, PNG.sync.write(diff));
    return { reference: [a.width, a.height], player: [b.width, b.height], differentPixels: different, ratio: different / (width * height) };
}

async function main() {
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    const results = [];
    try {
        const context = await browser.newContext({ viewport: { width: 1280, height: 950 }, reducedMotion: 'reduce' });
        const page = await context.newPage();
        await page.setContent('<style>body{margin:0;background:#fff}.surface{position:absolute;top:48px;background:#fff}#native{left:24px}#player{left:660px}.caption{position:absolute;top:14px;font:14px system-ui}#native-label{left:24px}</style><div id="native-label" class="caption">陪读蛙 1.52.1</div><div id="player-label" class="caption">播放器原生面板</div><div id="native" class="surface"></div><div id="player" class="surface"></div>');
        await page.addStyleTag({ path: path.join(root, 'assets/sentence_analysis.css') });
        await page.addScriptTag({ path: path.join(root, 'js/sentence_analysis.js') });
        await page.addScriptTag({ path: path.join(root, 'test/fixtures/readfrog-interaction.js') });
        await page.evaluate(reference => {
            const host = document.querySelector('#native'); host.attachShadow({ mode: 'open' });
            host.style.fontFamily = reference.font; host.style.fontSize = '14px'; host.style.lineHeight = '1.5'; host.style.position = 'absolute';
            for (const [k, v] of Object.entries(reference.vars)) host.style.setProperty(k, v);
            window.playerController = SvpSentenceAnalysis.createController(window, document.querySelector('#player'));
        }, reference);
        for (const theme of ['light', 'dark']) for (const width of [288, 468]) for (const state of states) {
            await page.mouse.move(1240, 900);
            await page.evaluate(({ reference, width, theme }) => {
                window.referenceController?.destroy(); playerController.reset();
                const host = document.querySelector('#native'), own = document.querySelector('#player');
                host.style.width = own.style.width = width + 'px'; host.removeAttribute('data-tip-active'); host.removeAttribute('data-toggles');
                own.style.left = document.querySelector('#player-label').style.left = (width + 72) + 'px';
                document.body.dataset.theme = theme; host.dataset.theme = theme;
                const bg = theme === 'dark' ? 'oklch(20.5% 0 0)' : '#fff';
                document.body.style.background = host.style.background = own.style.background = bg;
                document.body.style.color = theme === 'dark' ? '#fafafa' : '#171717';
                for (const [key, value] of Object.entries(reference.vars)) host.style.setProperty(key, value);
                if (theme === 'dark') for (const [key, value] of Object.entries({ '--rf-popover': bg, '--rf-popover-foreground': 'oklch(98.5% 0 0)', '--rf-border': 'rgb(255 255 255 / .1)', '--rf-muted-foreground': 'oklch(70.8% 0 0)', '--rf-secondary': 'oklch(26.9% 0 0)', '--rf-muted': 'oklch(26.9% 0 0)' })) host.style.setProperty(key, value);
                host.shadowRoot.innerHTML = reference.styles.map(s => '<style>' + s + '</style>').join('') + reference.html;
                window.referenceController = installReadFrogReference(host.shadowRoot, host);
                const message = document.createElement('div'); message.className = 'ai-chat-msg ai-chat-msg-ai';
                Object.assign(message.style, { padding: '0', border: '0', background: bg }); own.replaceChildren(message);
                window.playerPanel = playerController.mount(message, { source: reference.source, selection: reference.source, selectionStart: 0, selectionEnd: reference.source.length, notes: [], startIdx: 0, endIdx: 0 });
                // The reference specifies definite heads; encode them in the player's explicit-certainty contract.
                const playerData = { ...reference.data, annotations: reference.data.annotations.map(entry => entry.head ? { ...entry, uncertain: false } : entry) };
                playerPanel.update(JSON.stringify(playerData), 'done');
                // Layout oracle: use the legacy neutral tag color here; semantic palette coverage lives in the browser suite.
                own.querySelector('.svp-sa').style.setProperty('--sa-tag-form', 'var(--sa-faded)');
                own.querySelector('.svp-sa').style.setProperty('--sa-tag-sense', 'var(--sa-faded)');
                own.querySelectorAll('.sa-header,.sa-range-info,.sa-status,.sa-skeleton,.sa-issues,.sa-range-editor').forEach(n => { n.style.display = 'none'; });
            }, { reference, width, theme });
            for (const [on, name, selector] of [[state.trunk, '只看主干', '[data-toggle="trunk"]'], [state.slashes, '断句', '[data-toggle="slashes"]']]) {
                if (!on) continue;
                await page.locator('#native').locator(selector).click();
                await page.locator('#player').getByRole('button', { name, exact: true }).click();
            }
            if (state.id !== undefined) {
                const native = page.locator('#native').locator('[data-rf-key="rf-an-' + state.id + '"]');
                const own = page.locator('#player [data-sa-annotation="' + state.id + '"]');
                const nt = await native.locator(':scope > .rf-chip').count() ? native.locator(':scope > .rf-chip') : native.locator(':scope > .rf-t').first();
                const ot = await own.locator(':scope > .sa-chip').count() ? own.locator(':scope > .sa-chip') : own.locator(':scope > .sa-text').first();
                await nt.hover(); await nt.click(); await ot.hover(); await ot.click();
            }
            await page.mouse.move(1240, 900);
            const prefix = theme + '-' + width + '-' + state.name;
            const nativePath = path.join(output, prefix + '-reference.png');
            const ownPath = path.join(output, prefix + '-player.png');
            await page.locator('#native').screenshot({ path: nativePath });
            await page.locator('#player .sa-layout').screenshot({ path: ownPath });
            const result = compare(PNG.sync.read(fs.readFileSync(nativePath)), PNG.sync.read(fs.readFileSync(ownPath)), path.join(output, prefix + '-diff.png'));
            if (['default', 'appositive', 'conditional'].includes(state.name)) await page.screenshot({ path: path.join(output, prefix + '-comparison.png'), clip: { x: 8, y: 8, width: width * 2 + 80, height: Math.max(result.reference[1], result.player[1]) + 56 } });
            const metrics = await page.evaluate(() => {
                const native = document.querySelector('#native'), own = document.querySelector('#player .sa-layout');
                function inspect(root, textSelector, tipSelector, arrowSelector) {
                    const origin = root.getBoundingClientRect();
                    return {
                        words: [...(root.shadowRoot || root).querySelectorAll(textSelector)].filter(n => n.getClientRects().length).map(n => { const r = n.getBoundingClientRect(); return { text: n.textContent, x: +(r.left - origin.left).toFixed(2), y: +(r.top - origin.top).toFixed(2), width: +r.width.toFixed(2), height: +r.height.toFixed(2) }; }),
                        tip: (root.shadowRoot || root).querySelector(tipSelector)?.textContent,
                        arrows: [...(root.shadowRoot || root).querySelectorAll(arrowSelector + ' path')].map(n => n.getAttribute('d'))
                    };
                }
                return { reference: inspect(native, '.rf-sa-sentence .rf-t', '[data-tip-bubble]', '[data-tip-arrows]'), player: inspect(own, '.sa-sentence .sa-text', '.sa-tip', '.sa-arrows') };
            });
            results.push({ theme, width, state: state.name, ...result, metrics });
            console.log(JSON.stringify({ theme, width, state: state.name, ...result }));
        }
        fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(results, null, 2));
        for (const result of results) {
            assert.deepEqual(result.player, result.reference, 'core layout dimensions: ' + result.width + '/' + result.state);
            assert.deepEqual(result.metrics.player.words, result.metrics.reference.words, 'word positions and wrapping');
            assert.ok(result.ratio < 0.0005, 'visual difference exceeds 0.05%: ' + result.width + '/' + result.state + ' = ' + result.ratio);
            assert.deepEqual(result.metrics.player.arrows, result.metrics.reference.arrows, 'relationship arrow paths');
        }
        await context.close();
    } finally {
        await browser.close();
        const resolved = fs.realpathSync(temp);
        if (resolved.startsWith(fs.realpathSync(root) + path.sep)) fs.rmSync(resolved, { recursive: true, force: true });
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
