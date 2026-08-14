/**
 * Page downscaling, isolated from everything that knows about archives.
 *
 * This module exists so that exactly one implementation of the resize can be
 * driven from two places: `render-worker.js` runs it on a worker thread, which
 * is where it belongs, and `archive-util.js` calls it directly as a fallback
 * when worker threads are unavailable. Keeping it dependency-free — it needs
 * nothing but `fs`, `path` and the image addon — is what makes running it on a
 * bare worker cheap.
 *
 * A job is plain data (see `renderToFile`), so it survives the structured clone
 * between threads without any special handling.
 */
const path = require('path');
const fs = require('fs');

const PLUGIN_ROOT = path.join(__dirname, '..');

/**
 * @napi-rs/image, resolved lazily and cached.
 *
 * Lazy because callers that never resize anything — thumbnail generation, or a
 * session where every page is served at native resolution — should not pay to
 * load a ~24MB native addon. Cached because require() cost adds up per page.
 */
let _imageLib;
function requireImageLib() {
    if (_imageLib === undefined) {
        try {
            _imageLib = require(path.join(PLUGIN_ROOT, 'node_modules', '@napi-rs', 'image'));
        } catch (err) {
            // No prebuilt binary for this platform/arch. Latch the failure as
            // null rather than letting the throw escape on every page: the
            // caller degrades to serving the original file, which is correct,
            // just not downscaled. Retrying the require per page would only
            // repeat the same resolution walk and the same console noise.
            _imageLib = null;
            console.warn('[render-image] @napi-rs/image unavailable on ' +
                process.platform + '/' + process.arch +
                ', serving pages at native resolution:', err && err.message);
        }
    }
    return _imageLib;
}

/**
 * Lanczos3 in the FastResizeFilter enum. The binding is built with
 * `--no-const-enum` so the enum object exists at runtime, but pinning the
 * numeric value as a fallback means a change in how the enum is emitted
 * degrades to "still resizes correctly" rather than throwing on every page.
 */
const FAST_RESIZE_LANCZOS3 = 5;
function lanczos3(lib) {
    const e = lib && lib.FastResizeFilter;
    return (e && typeof e.Lanczos3 === 'number') ? e.Lanczos3 : FAST_RESIZE_LANCZOS3;
}

/**
 * JPEG quality for downscaled pages.
 *
 * 85 rather than 90: this is a display cache that is thrown away when the
 * archive closes, and at the sizes a page is actually shown the difference is
 * not visible on a scan, while the encode is measurably cheaper. Matches what
 * the Sharp implementation used.
 */
const JPEG_QUALITY = 85;

/** WebP quality. No effort/speed knob is exposed by the binding. */
const WEBP_QUALITY = 90;

/**
 * `CompressionType.Fast` in the addon's enum. Pinned for the same reason as the
 * resize filter above.
 */
const PNG_COMPRESSION_FAST = 1;

/**
 * Pick the output encoder for a page.
 *
 * The rule is "same format out as in", so a page never changes character just
 * because it was resized — with one exception. @napi-rs/image decodes GIF but
 * cannot encode it, so a static GIF is re-encoded as PNG: both are lossless,
 * and a GIF page reaching this code is single-frame by definition (animated
 * ones are served untouched and never get here).
 *
 * Returned as a plain descriptor rather than a closure so it can be decided on
 * one thread and applied on another.
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
            // Encoding AVIF is far too slow for an interactive path (seconds per
            // page); JPEG keeps the resize worth doing at all.
            return { ext: '.jpg', encoder: 'jpeg', quality: JPEG_QUALITY };
        default:
            return { ext: '.jpg', encoder: 'jpeg', quality: JPEG_QUALITY };
    }
}

/** Apply the encoder named by `encoderFor`. Returns a Promise<Buffer>. */
function encode(transformer, encoder, quality) {
    switch (encoder) {
        case 'png':
            // CompressionType.Fast — this is a display cache, not an archive;
            // spending CPU on a smaller temp file is a bad trade.
            return transformer.png({ compressionType: quality });
        case 'webp':
            return transformer.webp(quality);
        default:
            return transformer.jpeg(quality);
    }
}

/**
 * Within this fraction of native width, serve the original instead of resizing:
 * re-encoding would cost time and add a generation of loss for no visible gain.
 */
const NATIVE_ENOUGH = 0.95;

/** Above this, dimensions are implausible enough that the guess is not trusted. */
const MAX_SANE_DIMENSION = 10000;

/**
 * Resize one page and write it to `outPath`.
 *
 * `srcWidth`/`srcHeight` are optional. When the caller already knows them —
 * archive-util does, from image-size, for every page it has extracted — they
 * are used directly and no metadata pass happens at all. When they are missing
 * or unusable the addon is asked, which is correct but costs a decode, so it is
 * the fallback rather than the norm.
 *
 * Returning `{skipped: true}` rather than a path is not a failure: it means the
 * requested width was close enough to native that the original file is the
 * better answer, and the caller should use it.
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

    // The cheap decision first, and before the addon is even loaded: when
    // dimensions are known, a page that does not need resizing is settled
    // without reading a single byte of it.
    if (width > 0 && height > 0 && isNativeEnough(job.targetPixelWidth, width, height)) {
        return { skipped: true };
    }

    const lib = requireImageLib();
    // Same contract as "close enough to native": the caller should use the
    // original file. A platform with no prebuilt addon still reads comics.
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

    // fastResize is the SIMD path; Lanczos3 matches the quality of the previous
    // libvips output closely enough to be indistinguishable on comic scans.
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
