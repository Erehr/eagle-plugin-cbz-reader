/**
 * Page downscaling, isolated from everything that knows about archives.
 *
 * Shared by `render-worker.js` (worker thread) and `archive-util.js`
 * (in-process fallback). A job is plain data, so it survives structured clone.
 */
const path = require('path');
const fs = require('fs');

const PLUGIN_ROOT = path.join(__dirname, '..');

/** @napi-rs/image, resolved lazily and cached. */
let _imageLib;
function requireImageLib() {
    if (_imageLib === undefined) {
        try {
            _imageLib = require(path.join(PLUGIN_ROOT, 'node_modules', '@napi-rs', 'image'));
        } catch (err) {
            // No prebuilt binary for this platform/arch. Latch the failure so
            // the caller degrades to serving the original file.
            _imageLib = null;
            console.warn('[render-image] @napi-rs/image unavailable on ' +
                process.platform + '/' + process.arch +
                ', serving pages at native resolution:', err && err.message);
        }
    }
    return _imageLib;
}

/** Lanczos3 in the FastResizeFilter enum; numeric value pinned as a fallback. */
const FAST_RESIZE_LANCZOS3 = 5;
function lanczos3(lib) {
    const e = lib && lib.FastResizeFilter;
    return (e && typeof e.Lanczos3 === 'number') ? e.Lanczos3 : FAST_RESIZE_LANCZOS3;
}

/** JPEG quality for downscaled pages. */
const JPEG_QUALITY = 85;

/** WebP quality. */
const WEBP_QUALITY = 90;

/** `CompressionType.Fast` in the addon's enum. */
const PNG_COMPRESSION_FAST = 1;

/**
 * Pick the output encoder for a page.
 *
 * Same format out as in, except GIF: the addon decodes it but cannot encode it,
 * so a static GIF is written as PNG.
 *
 * @param {string} format - detected container, from image-format.js
 * @returns {{ext: string, encoder: 'jpeg'|'png'|'webp', quality: number}}
 */
function encoderFor(format) {
    switch (format) {
        case 'png':
            return { ext: '.png', encoder: 'png', quality: PNG_COMPRESSION_FAST };
        case 'webp':
            return { ext: '.webp', encoder: 'webp', quality: WEBP_QUALITY };
        case 'gif':
            return { ext: '.png', encoder: 'png', quality: PNG_COMPRESSION_FAST };
        case 'avif':
            // AVIF encoding is too slow for an interactive path.
            return { ext: '.jpg', encoder: 'jpeg', quality: JPEG_QUALITY };
        default:
            return { ext: '.jpg', encoder: 'jpeg', quality: JPEG_QUALITY };
    }
}

/** Apply the encoder named by `encoderFor`. Returns a Promise<Buffer>. */
function encode(transformer, encoder, quality) {
    switch (encoder) {
        case 'png':
            // CompressionType.Fast — this is a display cache, not an archive.
            return transformer.png({ compressionType: quality });
        case 'webp':
            return transformer.webp(quality);
        default:
            return transformer.jpeg(quality);
    }
}

/** Within this fraction of native width, serve the original instead of resizing. */
const NATIVE_ENOUGH = 0.95;

/** Above this, dimensions are implausible enough that the guess is not trusted. */
const MAX_SANE_DIMENSION = 10000;

/**
 * Resize one page and write it to `outPath`.
 *
 * `srcWidth`/`srcHeight` are optional; when omitted the addon is asked, which
 * costs a decode. `{skipped: true}` means the caller should use the original.
 *
 * @param {object} job
 * @param {string} job.srcPath - extracted page on disk
 * @param {string} job.outPath - where to write the resized copy
 * @param {number} job.targetPixelWidth - requested width in device pixels
 * @param {'jpeg'|'png'|'webp'} job.encoder
 * @param {number} job.quality
 * @param {number} [job.srcWidth]
 * @param {number} [job.srcHeight]
 * @returns {Promise<{skipped: true} | {path: string, width: number, height: number}>}
 */
async function renderToFile(job) {
    let width = job.srcWidth;
    let height = job.srcHeight;

    // When dimensions are known, settle the no-resize case before loading the addon.
    if (width > 0 && height > 0 && isNativeEnough(job.targetPixelWidth, width, height)) {
        return { skipped: true };
    }

    const lib = requireImageLib();
    // No addon on this platform: the caller uses the original file.
    if (!lib) return { skipped: true };

    const bytes = await fs.promises.readFile(job.srcPath);
    const transformer = new lib.Transformer(bytes);

    if (!(width > 0) || !(height > 0)) {
        const meta = await transformer.metadata(false);
        if (!meta || !meta.width || !meta.height) {
            throw new Error('Could not determine image dimensions');
        }
        width = meta.width;
        height = meta.height;
        if (isNativeEnough(job.targetPixelWidth, width, height)) return { skipped: true };
    }

    const targetW = Math.max(1, Math.min(job.targetPixelWidth, width));
    const targetH = Math.max(1, Math.round(height * (targetW / width)));

    // fastResize is the SIMD path.
    transformer.fastResize({
        width: targetW,
        height: targetH,
        filter: lanczos3(lib),
    });

    const out = await encode(transformer, job.encoder, job.quality);
    if (!out || !out.length) throw new Error('Encoder produced no output');

    await fs.promises.writeFile(job.outPath, out);
    return { path: job.outPath, width: targetW, height: targetH };
}

/** Is the requested width close enough to native that resizing is pointless? */
function isNativeEnough(targetPixelWidth, width, height) {
    const targetW = Math.min(targetPixelWidth, width);
    return targetW >= width * NATIVE_ENOUGH
        && width <= MAX_SANE_DIMENSION
        && height <= MAX_SANE_DIMENSION;
}

module.exports = {
    encoderFor,
    renderToFile,
    isNativeEnough,
    requireImageLib,
    JPEG_QUALITY,
    WEBP_QUALITY,
    NATIVE_ENOUGH,
};
