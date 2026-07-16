const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const ENTRY_HTML = path.join(ROOT, 'subtitle_video_player.html');
const OUTPUT_HTML = path.join(ROOT, 'subtitle_video_player.single.html');

// Lite single-file build: OCR is NOT bundled. The heavy OCR assets (ONNX models,
// ORT wasm, opencv.js, esearch-ocr.js, dictionary) are fetched on demand from
// jsDelivr, which mirrors this repo's files WITH permissive CORS. (GitHub Release
// assets send no access-control-allow-origin header, so a worker fetch() of them
// is blocked by the browser — that's why we use jsDelivr, not the Release.)
// OCR only runs for image-based SUP/PGS subtitles, never for SRT/JSON/ASS, so the
// base file stays well under 1MB and the ~37MB of OCR assets download once (then
// get browser-cached) the first time OCR is actually used.
//
// The base URL is pinned to the exact commit this build came from, auto-resolved
// from GITHUB_SHA (CI) or `git rev-parse HEAD` (local) — never hand-edited. The
// publish workflow also triggers on changes under assets/, so updating a model and
// pushing automatically rebuilds and re-pins here: no manual step to forget, and
// every shipped build stays locked to the asset versions it was tested with. That
// last point is critical because the worker inlines a version-specific patch of
// esearch-ocr.js (minified symbol names), which a floating ref like @master would
// silently desync. See DEVLOG.md ("OCR 体积解耦") for the full rationale.
function resolveOcrCommitSha() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA.trim();
  try {
    return execSync('git rev-parse HEAD', { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return null;
  }
}

const OCR_COMMIT_SHA = resolveOcrCommitSha();
if (!OCR_COMMIT_SHA) {
  throw new Error('build_single-html: cannot resolve a commit SHA for the OCR asset base URL (set GITHUB_SHA, or build from a git checkout).');
}
const OCR_BASE_URL = `https://cdn.jsdelivr.net/gh/leolulu/macbookair-files@${OCR_COMMIT_SHA}/subtitle_video_player`;

function readText(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function readBytes(filePath) {
  return fs.readFileSync(filePath);
}

function toBase64(buffer) {
  return buffer.toString('base64');
}

function toDataUrl(buffer, mime) {
  return `data:${mime};base64,${toBase64(buffer)}`;
}

function guessMime(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.css') return 'text/css';
  if (ext === '.js') return 'text/javascript';
  if (ext === '.txt') return 'text/plain';
  if (ext === '.png') return 'image/png';
  return 'application/octet-stream';
}

function replaceOnce(text, oldFragment, newFragment, label) {
  const index = text.indexOf(oldFragment);
  if (index !== -1) {
    return text.slice(0, index) + newFragment + text.slice(index + oldFragment.length);
  }

  const oldCrlf = oldFragment.replace(/\n/g, '\r\n');
  const indexCrlf = text.indexOf(oldCrlf);
  if (indexCrlf !== -1) {
    const newCrlf = newFragment.replace(/\n/g, '\r\n');
    return text.slice(0, indexCrlf) + newCrlf + text.slice(indexCrlf + oldCrlf.length);
  }

  throw new Error(`Expected fragment not found${label ? `: ${label}` : ''}`);
}

function inlineCssUrls(cssText, cssPath) {
  const pattern = /url\((['"]?)([^)"']+)\1\)/g;
  return cssText.replace(pattern, (fullMatch, quote, rawPath) => {
    const candidate = String(rawPath || '').trim();
    if (!candidate || candidate.startsWith('data:') || candidate.startsWith('http:') || candidate.startsWith('https:')) {
      return fullMatch;
    }
    const assetPath = path.resolve(path.dirname(cssPath), candidate);
    const dataUrl = toDataUrl(readBytes(assetPath), guessMime(assetPath));
    return `url('${dataUrl}')`;
  });
}

function patchMainOcrJs(source) {
  const oldFragment = "const worker = new Worker('js/ocr/paddle_ocr_worker.js');";
  const newFragment = "const workerSource = window.__SVP_SINGLE_FILE_BUNDLE__.workerSource;\n            const workerBlob = new Blob([workerSource], { type: 'text/javascript' });\n            const worker = new Worker(URL.createObjectURL(workerBlob));";
  return replaceOnce(source, oldFragment, newFragment, 'Failed to patch worker creation in paddle_ocr.js');
}

function patchWorkerJs(source) {
  // Repoint the worker's asset resolver at jsDelivr. The worker runs from a Blob
  // URL in the single file, so relative resolution against self.location is
  // meaningless; instead resolve every relative asset path against the worker's
  // mirrored location on jsDelivr. This preserves the repo's directory layout,
  // so '../../assets/...' lands on the right CDN path — including the ORT wasm
  // directory that ort.env.wasm.wasmPaths is derived from.
  const oldResolve = `    function resolveUrl(relativePath) {
        return new URL(relativePath, self.location.href).toString();
    }
`;
  const newResolve = `    function resolveUrl(relativePath) {
        return new URL(relativePath, '${OCR_BASE_URL}/js/ocr/paddle_ocr_worker.js').toString();
    }
`;
  return replaceOnce(source, oldResolve, newResolve, 'Failed to patch resolveUrl() in paddle_ocr_worker.js');
}

function build() {
  let html = readText(ENTRY_HTML);

  const cssPath = path.join(ROOT, 'assets/vendor/jquery/jquery-ui-1.13.2.css');
  const cssText = inlineCssUrls(readText(cssPath), cssPath);
  html = replaceOnce(
    html,
    '<link rel="stylesheet" href="assets/vendor/jquery/jquery-ui-1.13.2.css">',
    `<style>\n${cssText}\n</style>`,
    'Failed to inline jquery-ui CSS link'
  );

  // Only small, OCR-independent scripts are inlined into the base file.
  // ort.min.js / opencv.js / esearch-ocr.js / models / wasm are intentionally
  // excluded and fetched from the remote OCR pack on demand (see OCR_BASE_URL).
  const inlineScripts = {
    'assets/vendor/jquery/jquery-3.6.0.min.js': readText(path.join(ROOT, 'assets/vendor/jquery/jquery-3.6.0.min.js')),
    'assets/vendor/jquery/jquery-ui-1.13.2.min.js': readText(path.join(ROOT, 'assets/vendor/jquery/jquery-ui-1.13.2.min.js')),
    'assets/vendor/marked/marked.umd.js': readText(path.join(ROOT, 'assets/vendor/marked/marked.umd.js')),
    'assets/vendor/dompurify/purify.min.js': readText(path.join(ROOT, 'assets/vendor/dompurify/purify.min.js')),
    'js/cache/sup_ocr_cache.js': readText(path.join(ROOT, 'js/cache/sup_ocr_cache.js')),
    'js/sup/pgs_parser.js': readText(path.join(ROOT, 'js/sup/pgs_parser.js')),
    'js/ocr/paddle_ocr.js': patchMainOcrJs(readText(path.join(ROOT, 'js/ocr/paddle_ocr.js')))
  };

  const workerSource = patchWorkerJs(readText(path.join(ROOT, 'js/ocr/paddle_ocr_worker.js')));
  const bootstrap = `<script>\nwindow.__SVP_SINGLE_FILE_BUNDLE__ = ${JSON.stringify({ workerSource })};\n</script>`;

  html = replaceOnce(
    html,
    '<script src="assets/vendor/jquery/jquery-3.6.0.min.js"></script>',
    `<script>\n${inlineScripts['assets/vendor/jquery/jquery-3.6.0.min.js']}\n</script>`,
    'Failed to inline jquery'
  );
  html = replaceOnce(
    html,
    '<script src="assets/vendor/jquery/jquery-ui-1.13.2.min.js"></script>',
    `<script>\n${inlineScripts['assets/vendor/jquery/jquery-ui-1.13.2.min.js']}\n</script>`,
    'Failed to inline jquery-ui'
  );
  html = replaceOnce(
    html,
    '<script src="assets/vendor/marked/marked.umd.js"></script>',
    `<script>\n${inlineScripts['assets/vendor/marked/marked.umd.js']}\n</script>`,
    'Failed to inline marked'
  );
  html = replaceOnce(
    html,
    '<script src="assets/vendor/dompurify/purify.min.js"></script>',
    `<script>\n${inlineScripts['assets/vendor/dompurify/purify.min.js']}\n</script>`,
    'Failed to inline dompurify'
  );
  html = replaceOnce(
    html,
    '<script src="js/cache/sup_ocr_cache.js"></script>',
    `<script>\n${inlineScripts['js/cache/sup_ocr_cache.js']}\n</script>`,
    'Failed to inline sup_ocr_cache.js'
  );
  html = replaceOnce(
    html,
    '<script src="js/sup/pgs_parser.js"></script>',
    `<script>\n${inlineScripts['js/sup/pgs_parser.js']}\n</script>`,
    'Failed to inline pgs_parser.js'
  );
  html = replaceOnce(
    html,
    '<script src="js/ocr/paddle_ocr.js"></script>',
    `${bootstrap}\n<script>\n${inlineScripts['js/ocr/paddle_ocr.js']}\n</script>`,
    'Failed to inline patched paddle_ocr.js'
  );

  fs.writeFileSync(OUTPUT_HTML, html, 'utf8');
  return OUTPUT_HTML;
}

if (require.main === module) {
  const output = build();
  process.stdout.write(`${output}\n`);
}

module.exports = {
  build
};
