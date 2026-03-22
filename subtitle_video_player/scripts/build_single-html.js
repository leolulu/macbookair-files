const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ENTRY_HTML = path.join(ROOT, 'subtitle_video_player.html');
const OUTPUT_HTML = path.join(ROOT, 'subtitle_video_player.single.html');

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
  if (ext === '.onnx') return 'application/octet-stream';
  if (ext === '.wasm') return 'application/wasm';
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

function patchWorkerJs(source, resourceSpecs, wasmFetchOverrides) {
  const marker = "    'use strict';";
  const prelude = `${marker}\n\n` +
    `    const __SVP_SINGLE_FILE_RESOURCES__ = ${JSON.stringify(resourceSpecs)};\n` +
    `    const __SVP_SINGLE_FILE_WASM_FETCH_OVERRIDES__ = ${JSON.stringify(wasmFetchOverrides)};\n` +
String.raw`    const __SVP_SINGLE_FILE_URL_CACHE__ = new Map();

    function __svpBase64ToUint8Array(base64) {
        const binary = atob(base64);
        const out = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            out[i] = binary.charCodeAt(i);
        }
        return out;
    }

    function __svpCreateObjectUrl(spec) {
        const bytes = __svpBase64ToUint8Array(spec.base64);
        const blob = new Blob([bytes], { type: spec.mime });
        return URL.createObjectURL(blob);
    }

    function __svpResolveBundledPath(path) {
        const normalized = String(path || '').replace(/\\/g, '/');
        const spec = __SVP_SINGLE_FILE_RESOURCES__[normalized];
        if (!spec) return null;
        if (!__SVP_SINGLE_FILE_URL_CACHE__.has(normalized)) {
            __SVP_SINGLE_FILE_URL_CACHE__.set(normalized, __svpCreateObjectUrl(spec));
        }
        return __SVP_SINGLE_FILE_URL_CACHE__.get(normalized);
    }

    const __svpOriginalFetch = typeof self.fetch === 'function' ? self.fetch.bind(self) : null;
    self.fetch = function (input, init) {
        const candidate = typeof input === 'string'
            ? input
            : (input && typeof input.url === 'string' ? input.url : '');
        const spec = __SVP_SINGLE_FILE_WASM_FETCH_OVERRIDES__[candidate];
        if (spec) {
            const bytes = __svpBase64ToUint8Array(spec.base64);
            return Promise.resolve(new Response(bytes, {
                status: 200,
                headers: {
                    'Content-Type': spec.mime,
                },
            }));
        }
        if (!__svpOriginalFetch) {
            return Promise.reject(new Error('fetch is not available in this worker'));
        }
        return __svpOriginalFetch(input, init);
    };
`;

  source = replaceOnce(source, marker, prelude, 'Failed to find strict-mode marker in paddle_ocr_worker.js');

  const oldResolve = `    function resolveUrl(relativePath) {
        return new URL(relativePath, self.location.href).toString();
    }
`;
  const newResolve = String.raw`    function resolveUrl(relativePath) {
        const bundled = __svpResolveBundledPath(relativePath);
        if (bundled) {
            return bundled;
        }
        return new URL(relativePath, self.location.href).toString();
    }
`;
  source = replaceOnce(source, oldResolve, newResolve, 'Failed to patch resolveUrl() in paddle_ocr_worker.js');

  const oldWasm = String.raw`                self.ort.env.wasm.wasmPaths = resolveUrl('../../assets/vendor/ort/')
                    .replace(/ort\/$/, 'ort/');
                self.ort.env.wasm.numThreads = 1;
                self.ort.env.wasm.proxy = false;
                self.ort.env.wasm.initTimeout = 30000;
`;
  const newWasm = `                self.ort.env.wasm.wasmPaths = '';
                self.ort.env.wasm.numThreads = 1;
                self.ort.env.wasm.proxy = false;
                self.ort.env.wasm.initTimeout = 30000;
`;
  source = replaceOnce(source, oldWasm, newWasm, 'Failed to patch ORT wasm configuration in paddle_ocr_worker.js');

  return source;
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

  const resourcePaths = {
    '../../assets/vendor/ort/ort.min.js': path.join(ROOT, 'assets/vendor/ort/ort.min.js'),
    '../../assets/vendor/opencv/opencv.js': path.join(ROOT, 'assets/vendor/opencv/opencv.js'),
    '../../assets/vendor/esearch-ocr/esearch-ocr.js': path.join(ROOT, 'assets/vendor/esearch-ocr/esearch-ocr.js'),
    '../../assets/ocr/esearch/ch/ppocr_keys_v1.txt': path.join(ROOT, 'assets/ocr/esearch/ch/ppocr_keys_v1.txt'),
    '../../assets/ocr/esearch/ch/ppocr_det.onnx': path.join(ROOT, 'assets/ocr/esearch/ch/ppocr_det.onnx'),
    '../../assets/ocr/esearch/ch/ppocr_rec.onnx': path.join(ROOT, 'assets/ocr/esearch/ch/ppocr_rec.onnx')
  };
  const resourceSpecs = {};
  for (const [key, filePath] of Object.entries(resourcePaths)) {
    resourceSpecs[key] = {
      mime: guessMime(filePath),
      base64: toBase64(readBytes(filePath))
    };
  }

  const inlineScripts = {
    'assets/vendor/jquery/jquery-3.6.0.min.js': readText(path.join(ROOT, 'assets/vendor/jquery/jquery-3.6.0.min.js')),
    'assets/vendor/jquery/jquery-ui-1.13.2.min.js': readText(path.join(ROOT, 'assets/vendor/jquery/jquery-ui-1.13.2.min.js')),
    'assets/vendor/ort/ort.min.js': readText(path.join(ROOT, 'assets/vendor/ort/ort.min.js')),
    'assets/vendor/opencv/opencv.js': readText(path.join(ROOT, 'assets/vendor/opencv/opencv.js')),
    'js/cache/sup_ocr_cache.js': readText(path.join(ROOT, 'js/cache/sup_ocr_cache.js')),
    'js/sup/pgs_parser.js': readText(path.join(ROOT, 'js/sup/pgs_parser.js')),
    'js/ocr/paddle_ocr.js': patchMainOcrJs(readText(path.join(ROOT, 'js/ocr/paddle_ocr.js')))
  };

  const wasmFetchOverrides = {};
  for (const name of [
    'ort-wasm.wasm',
    'ort-wasm-simd.wasm',
    'ort-wasm-threaded.wasm',
    'ort-wasm-simd-threaded.wasm'
  ]) {
    wasmFetchOverrides[name] = {
      mime: 'application/wasm',
      base64: toBase64(readBytes(path.join(ROOT, 'assets/vendor/ort', name)))
    };
  }

  const workerSource = patchWorkerJs(
    readText(path.join(ROOT, 'js/ocr/paddle_ocr_worker.js')),
    resourceSpecs,
    wasmFetchOverrides
  );
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
    '<script src="assets/vendor/ort/ort.min.js"></script>',
    `<script>\n${inlineScripts['assets/vendor/ort/ort.min.js']}\n</script>`,
    'Failed to inline ort.min.js'
  );
  html = replaceOnce(
    html,
    '<script src="assets/vendor/opencv/opencv.js"></script>',
    `<script>\n${inlineScripts['assets/vendor/opencv/opencv.js']}\n</script>`,
    'Failed to inline opencv.js'
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
