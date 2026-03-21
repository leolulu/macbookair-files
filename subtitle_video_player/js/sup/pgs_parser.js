// SUP/PGS parser + bitmap renderer (browser).
// Exposes window.SupPgsParser.parseSupPgsToCues(arrayBuffer)

(function () {
    'use strict';

    function accTime(num) {
        return parseFloat(num.toFixed(3));
    }

    function supPtsToSeconds(pts90kHz) {
        return pts90kHz / 90000;
    }

    function ycrcbToRgba(y, cr, cb, alpha) {
        const r = Math.max(0, Math.min(255, Math.floor(y + 1.4075 * (cr - 128))));
        const g = Math.max(0, Math.min(255, Math.floor(y - 0.3455 * (cb - 128) - 0.7169 * (cr - 128))));
        const b = Math.max(0, Math.min(255, Math.floor(y + 1.779 * (cb - 128))));
        return [r, g, b, alpha];
    }

    function readUint24BE(view, offset) {
        return (view.getUint8(offset) << 16) | (view.getUint8(offset + 1) << 8) | view.getUint8(offset + 2);
    }

    async function rleDecodeToIndexBuffer(rleData, width, height) {
        const out = new Uint8Array(width * height);
        let p = 0;
        let x = 0;
        let y = 0;
        let lastYieldAt = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        while (p < rleData.length && y < height) {
            const b1 = rleData[p];
            if (b1 !== 0) {
                if (x < width) {
                    out[y * width + x] = b1;
                }
                x += 1;
                p += 1;
                continue;
            }

            if (p + 1 >= rleData.length) {
                break;
            }
            const b2 = rleData[p + 1];
            p += 2;

            if (b2 === 0) {
                x = 0;
                y += 1;
                continue;
            }

            const prefix = b2 & 0xC0;
            let runLength = 0;
            let color = 0;

            if (prefix === 0x00) {
                runLength = b2 & 0x3F;
                color = 0;
            } else if (prefix === 0x40) {
                if (p >= rleData.length) {
                    break;
                }
                const b3 = rleData[p];
                p += 1;
                runLength = ((b2 & 0x3F) << 8) | b3;
                color = 0;
            } else if (prefix === 0x80) {
                if (p >= rleData.length) {
                    break;
                }
                const b3 = rleData[p];
                p += 1;
                runLength = b2 & 0x3F;
                color = b3;
            } else {
                if (p + 1 >= rleData.length) {
                    break;
                }
                const b3 = rleData[p];
                const b4 = rleData[p + 1];
                p += 2;
                runLength = ((b2 & 0x3F) << 8) | b3;
                color = b4;
            }

            if (runLength <= 0) {
                continue;
            }

            const maxWritable = Math.max(0, width - x);
            const writeLen = Math.min(runLength, maxWritable);
            if (writeLen > 0) {
                out.fill(color, y * width + x, y * width + x + writeLen);
            }
            x += runLength;

            const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
            if (now - lastYieldAt >= 12) {
                await yieldToMainThread(16);
                lastYieldAt = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
            }
        }

        return out;
    }

    async function findNonTransparentBounds(rgba, width, height) {
        let minX = width;
        let minY = height;
        let maxX = -1;
        let maxY = -1;
        let lastYieldAt = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();

        for (let y = 0; y < height; y++) {
            const rowOffset = y * width * 4;
            for (let x = 0; x < width; x++) {
                const a = rgba[rowOffset + x * 4 + 3];
                if (a !== 0) {
                    if (x < minX) minX = x;
                    if (y < minY) minY = y;
                    if (x > maxX) maxX = x;
                    if (y > maxY) maxY = y;
                }
            }

            const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
            if (now - lastYieldAt >= 12) {
                await yieldToMainThread(16);
                lastYieldAt = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
            }
        }

        if (maxX < 0 || maxY < 0) {
            return null;
        }
        return { minX, minY, maxX, maxY };
    }

    function cropRgbaToImageData(rgba, width, height, bounds) {
        const cropW = bounds.maxX - bounds.minX + 1;
        const cropH = bounds.maxY - bounds.minY + 1;
        const cropped = new Uint8ClampedArray(cropW * cropH * 4);

        for (let y = 0; y < cropH; y++) {
            const srcY = bounds.minY + y;
            const srcOffset = (srcY * width + bounds.minX) * 4;
            const dstOffset = y * cropW * 4;
            cropped.set(rgba.subarray(srcOffset, srcOffset + cropW * 4), dstOffset);
        }

        return new ImageData(cropped, cropW, cropH);
    }

    function yieldToMainThread(timeoutMs) {
        timeoutMs = typeof timeoutMs === 'number' ? timeoutMs : 16;
        return new Promise((resolve) => {
            let done = false;
            function finish() {
                if (done) return;
                done = true;
                resolve();
            }
            if (typeof requestAnimationFrame === 'function') {
                requestAnimationFrame(finish);
            }
            setTimeout(finish, timeoutMs);
        });
    }

    function imageDataToPngDataUrl(imageData) {
        const canvas = document.createElement('canvas');
        canvas.width = imageData.width;
        canvas.height = imageData.height;
        const ctx = canvas.getContext('2d');
        ctx.putImageData(imageData, 0, 0);
        return canvas.toDataURL('image/png');
    }

    async function renderPgsCompositionToImageData(screenWidth, screenHeight, compositionObjects, windowsById, objectsById, paletteById, paletteId) {
        const palette = paletteById.get(paletteId);
        if (!palette) {
            return null;
        }

        let minX = screenWidth;
        let minY = screenHeight;
        let maxX = -1;
        let maxY = -1;

        const placements = [];

        for (const obj of compositionObjects) {
            const objectEntry = objectsById.get(obj.objectId);
            if (!objectEntry || !objectEntry.indexBuffer) {
                continue;
            }

            let drawX = obj.x;
            let drawY = obj.y;
            let drawW = objectEntry.width;
            let drawH = objectEntry.height;
            let cropX = 0;
            let cropY = 0;

            if (obj.cropped) {
                cropX = obj.cropX;
                cropY = obj.cropY;
                drawW = obj.cropW;
                drawH = obj.cropH;
            }

            const win = windowsById.get(obj.windowId);

            const objMinX = drawX;
            const objMinY = drawY;
            const objMaxX = drawX + drawW - 1;
            const objMaxY = drawY + drawH - 1;

            if (objMinX < minX) minX = objMinX;
            if (objMinY < minY) minY = objMinY;
            if (objMaxX > maxX) maxX = objMaxX;
            if (objMaxY > maxY) maxY = objMaxY;

            placements.push({
                objectEntry,
                x: drawX,
                y: drawY,
                w: drawW,
                h: drawH,
                cropX,
                cropY,
                window: win,
            });
        }

        if (maxX < 0 || maxY < 0) {
            return null;
        }

        minX = Math.max(0, Math.min(screenWidth - 1, minX));
        minY = Math.max(0, Math.min(screenHeight - 1, minY));
        maxX = Math.max(0, Math.min(screenWidth - 1, maxX));
        maxY = Math.max(0, Math.min(screenHeight - 1, maxY));

        const outW = maxX - minX + 1;
        const outH = maxY - minY + 1;
        const rgba = new Uint8ClampedArray(outW * outH * 4);
        let lastYieldAt = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();

        for (const place of placements) {
            const srcW = place.objectEntry.width;
            const srcH = place.objectEntry.height;
            const src = place.objectEntry.indexBuffer;
            const startX = Math.max(0, place.x);
            const startY = Math.max(0, place.y);
            const endX = Math.min(screenWidth, place.x + place.w);
            const endY = Math.min(screenHeight, place.y + place.h);

            for (let y = startY; y < endY; y++) {
                const srcY = (y - place.y) + place.cropY;
                if (srcY < 0 || srcY >= srcH) continue;
                for (let x = startX; x < endX; x++) {
                    const srcX = (x - place.x) + place.cropX;
                    if (srcX < 0 || srcX >= srcW) continue;
                    const colorIndex = src[srcY * srcW + srcX];
                    const pal = palette[colorIndex];
                    if (!pal) continue;
                    const a = pal[3];
                    if (a === 0) continue;
                    const dstX = x - minX;
                    const dstY = y - minY;
                    const dstIdx = (dstY * outW + dstX) * 4;
                    rgba[dstIdx] = pal[0];
                    rgba[dstIdx + 1] = pal[1];
                    rgba[dstIdx + 2] = pal[2];
                    rgba[dstIdx + 3] = a;
                }

                const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
                if (now - lastYieldAt >= 12) {
                    await yieldToMainThread(16);
                    lastYieldAt = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
                }
            }
        }

        const bounds = await findNonTransparentBounds(rgba, outW, outH);
        if (!bounds) {
            return null;
        }
        return cropRgbaToImageData(rgba, outW, outH, bounds);
    }

    async function parseSupPgsToCues(arrayBuffer) {
        const view = new DataView(arrayBuffer);
        const bytes = new Uint8Array(arrayBuffer);

        const SEGMENT_TYPE = {
            PDS: 0x14,
            ODS: 0x15,
            PCS: 0x16,
            WDS: 0x17,
            END: 0x80,
        };

        const paletteById = new Map();
        const objectsById = new Map();
        const windowsById = new Map();
        const pendingObjectFragments = new Map();

        const cues = [];
        let lastCue = null;

        let currentPcs = null;
        let displaySetPtsSec = null;
        let lastYieldAt = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();

        function resetEpoch() {
            paletteById.clear();
            objectsById.clear();
            windowsById.clear();
            pendingObjectFragments.clear();
        }

        async function finalizeDisplaySet() {
            if (!currentPcs) {
                return;
            }
            const ptsSec = displaySetPtsSec;
            if (ptsSec === null) {
                return;
            }

            if (currentPcs.numObjects === 0) {
                if (lastCue && (lastCue.end === null || lastCue.end > ptsSec)) {
                    lastCue.end = ptsSec;
                }
                lastCue = null;
                return;
            }

            const imageData = await renderPgsCompositionToImageData(
                currentPcs.width,
                currentPcs.height,
                currentPcs.objects,
                windowsById,
                objectsById,
                paletteById,
                currentPcs.paletteId
            );

            if (!imageData) {
                return;
            }

            if (lastCue && lastCue.end === null) {
                lastCue.end = ptsSec;
            }
            const cue = {
                start: accTime(ptsSec),
                end: null,
                imageRawData: {
                    data: imageData.data,
                    width: imageData.width,
                    height: imageData.height,
                },
            };
            cues.push(cue);
            lastCue = cue;

            const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
            if (now - lastYieldAt >= 20) {
                await yieldToMainThread(16);
                lastYieldAt = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
            }
        }

        let offset = 0;
        while (offset + 13 <= view.byteLength) {
            const magic = view.getUint16(offset, false);
            if (magic !== 0x5047) {
                break;
            }
            const pts = view.getUint32(offset + 2, false);
            const segmentType = view.getUint8(offset + 10);
            const segmentSize = view.getUint16(offset + 11, false);
            const payloadStart = offset + 13;
            const payloadEnd = payloadStart + segmentSize;
            if (payloadEnd > view.byteLength) {
                break;
            }
            const payload = bytes.subarray(payloadStart, payloadEnd);

            const ptsSec = supPtsToSeconds(pts);
            if (displaySetPtsSec === null) {
                displaySetPtsSec = ptsSec;
            }

            if (segmentType === SEGMENT_TYPE.PCS) {
                currentPcs = null;
                displaySetPtsSec = ptsSec;

                const pcsView = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
                const width = pcsView.getUint16(0, false);
                const height = pcsView.getUint16(2, false);
                const compositionState = pcsView.getUint8(7);
                const paletteId = pcsView.getUint8(9);
                const numObjects = pcsView.getUint8(10);

                if (compositionState === 0x80) {
                    resetEpoch();
                }

                let p = 11;
                const objects = [];
                for (let i = 0; i < numObjects; i++) {
                    const objectId = pcsView.getUint16(p, false);
                    const windowId = pcsView.getUint8(p + 2);
                    const croppedFlag = pcsView.getUint8(p + 3);
                    const x = pcsView.getUint16(p + 4, false);
                    const y = pcsView.getUint16(p + 6, false);
                    const cropped = (croppedFlag & 0x40) !== 0;
                    let cropX = 0;
                    let cropY = 0;
                    let cropW = 0;
                    let cropH = 0;
                    if (cropped) {
                        cropX = pcsView.getUint16(p + 8, false);
                        cropY = pcsView.getUint16(p + 10, false);
                        cropW = pcsView.getUint16(p + 12, false);
                        cropH = pcsView.getUint16(p + 14, false);
                        p += 16;
                    } else {
                        p += 8;
                    }
                    objects.push({ objectId, windowId, x, y, cropped, cropX, cropY, cropW, cropH });
                }

                currentPcs = { width, height, compositionState, paletteId, numObjects, objects };
            } else if (segmentType === SEGMENT_TYPE.WDS) {
                const wdsView = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
                const numWindows = wdsView.getUint8(0);
                let p = 1;
                for (let i = 0; i < numWindows; i++) {
                    const windowId = wdsView.getUint8(p);
                    const x = wdsView.getUint16(p + 1, false);
                    const y = wdsView.getUint16(p + 3, false);
                    const w = wdsView.getUint16(p + 5, false);
                    const h = wdsView.getUint16(p + 7, false);
                    windowsById.set(windowId, { x, y, w, h });
                    p += 9;
                }
            } else if (segmentType === SEGMENT_TYPE.PDS) {
                const pdsView = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
                const paletteId = pdsView.getUint8(0);
                let palette = paletteById.get(paletteId);
                if (!palette) {
                    palette = new Array(256);
                    for (let i = 0; i < 256; i++) {
                        palette[i] = [0, 0, 0, 0];
                    }
                    paletteById.set(paletteId, palette);
                }
                for (let p = 2; p + 4 < payload.byteLength; p += 5) {
                    const entryId = pdsView.getUint8(p);
                    const y = pdsView.getUint8(p + 1);
                    const cr = pdsView.getUint8(p + 2);
                    const cb = pdsView.getUint8(p + 3);
                    const alpha = pdsView.getUint8(p + 4);
                    palette[entryId] = ycrcbToRgba(y, cr, cb, alpha);
                }
            } else if (segmentType === SEGMENT_TYPE.ODS) {
                const odsView = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
                const objectId = odsView.getUint16(0, false);
                const sequenceFlag = odsView.getUint8(3);
                readUint24BE(odsView, 4);
                const isFirst = (sequenceFlag & 0x80) !== 0;
                const isLast = (sequenceFlag & 0x40) !== 0;

                let p = 7;
                let width = null;
                let height = null;
                if (isFirst) {
                    width = odsView.getUint16(p, false);
                    height = odsView.getUint16(p + 2, false);
                    p += 4;
                }

                let frag = pendingObjectFragments.get(objectId);
                if (!frag || isFirst) {
                    frag = { width: width || 0, height: height || 0, chunks: [] };
                    pendingObjectFragments.set(objectId, frag);
                }
                if (isFirst && width !== null && height !== null) {
                    frag.width = width;
                    frag.height = height;
                }

                const fragmentData = payload.subarray(p);
                frag.chunks.push(fragmentData);

                if (isLast) {
                    const totalLen = frag.chunks.reduce((sum, c) => sum + c.length, 0);
                    const combined = new Uint8Array(totalLen);
                    let wOff = 0;
                    for (const c of frag.chunks) {
                        combined.set(c, wOff);
                        wOff += c.length;
                    }
                    const w = frag.width;
                    const h = frag.height;
                    if (w > 0 && h > 0) {
                        const indexBuffer = await rleDecodeToIndexBuffer(combined, w, h);
                        objectsById.set(objectId, { width: w, height: h, indexBuffer });
                    }
                    pendingObjectFragments.delete(objectId);
                }
            } else if (segmentType === SEGMENT_TYPE.END) {
                await finalizeDisplaySet();
                currentPcs = null;
                displaySetPtsSec = null;
            }

            offset = payloadEnd;

            const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
            if (now - lastYieldAt >= 20) {
                await yieldToMainThread(16);
                lastYieldAt = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
            }
        }

        for (let i = 0; i < cues.length; i++) {
            if (cues[i].end === null) {
                if (i + 1 < cues.length) {
                    cues[i].end = cues[i + 1].start;
                } else {
                    cues[i].end = accTime(cues[i].start + 5);
                }
            }
        }

        return cues;
    }

    window.SupPgsParser = {
        parseSupPgsToCues,
    };
})();
