/**
 * Container header inspection — format identification and animation detection.
 *
 * Sharp answered "is this page animated?" via `metadata().pages`, but
 * @napi-rs/image exposes no frame count, so we read the container headers
 * ourselves. That turns out to be the better trade anyway: these checks touch a
 * few hundred bytes of header and never invoke a decoder, whereas the old
 * metadata() call spun up libvips for every page.
 *
 * Everything here reads from a small prefix of the file. Callers that already
 * hold the bytes can pass them straight in; `inspectFile` reads just enough from
 * disk for the answer.
 */
const fs = require('fs');

/** Header bytes to read from disk. Enough for a WebP VP8X chunk, a GIF's first
 *  frames, or an AVIF ftyp box with a generous compatible-brand list. */
const HEADER_BYTES = 4096;

/** Formats that can carry more than one frame, so are worth checking. */
const MULTIFRAME_EXT = new Set(['.webp', '.gif', '.avif']);

// ── Low-level helpers ────────────────────────────────────────────────────

function u32be(buf, off) {
    return ((buf[off] << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3]) >>> 0;
}

function u32le(buf, off) {
    return ((buf[off]) | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24)) >>> 0;
}

function ascii(buf, off, len) {
    let s = '';
    for (let i = 0; i < len; i++) s += String.fromCharCode(buf[off + i]);
    return s;
}

// ── Format detection by magic number ─────────────────────────────────────

/**
 * Identify the container from its magic bytes. More trustworthy than the file
 * extension, which inside a CBZ is whatever the packer felt like writing.
 * @returns {'jpeg'|'png'|'gif'|'webp'|'avif'|'bmp'|'tiff'|null}
 */
function detectFormat(buf) {
    if (!buf || buf.length < 12) return null;

    if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'jpeg';

    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47 &&
        buf[4] === 0x0D && buf[5] === 0x0A && buf[6] === 0x1A && buf[7] === 0x0A) return 'png';

    if (ascii(buf, 0, 3) === 'GIF') return 'gif';

    if (ascii(buf, 0, 4) === 'RIFF' && ascii(buf, 8, 4) === 'WEBP') return 'webp';

    if (buf[0] === 0x42 && buf[1] === 0x4D) return 'bmp';

    if ((buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2A && buf[3] === 0x00) ||
        (buf[0] === 0x4D && buf[1] === 0x4D && buf[2] === 0x00 && buf[3] === 0x2A)) return 'tiff';

    // ISO-BMFF: 4-byte box size, then 'ftyp'. AVIF/HEIF live here.
    if (ascii(buf, 4, 4) === 'ftyp') {
        const brands = isoBrands(buf);
        if (brands.some(b => b === 'avif' || b === 'avis')) return 'avif';
        if (brands.some(b => b === 'heic' || b === 'heix' || b === 'hevc' || b === 'mif1')) return 'heic';
    }

    return null;
}

// ── ISO-BMFF (AVIF) ──────────────────────────────────────────────────────

/** Major brand plus every compatible brand from the ftyp box. */
function isoBrands(buf) {
    if (buf.length < 16) return [];
    const size = u32be(buf, 0);
    // A degenerate/oversized box still has a readable major brand
    const end = (size >= 16 && size <= buf.length) ? size : buf.length;

    const brands = [ascii(buf, 8, 4)]; // major_brand
    // bytes 12..16 are minor_version; compatible_brands follow to the box end
    for (let off = 16; off + 4 <= end; off += 4) {
        brands.push(ascii(buf, off, 4));
    }
    return brands;
}

/**
 * Animated AVIF is signalled by the 'avis' brand (AVIF image *sequence*),
 * which appears as either the major brand or a compatible brand.
 */
function isAnimatedAvif(buf) {
    if (buf.length < 16 || ascii(buf, 4, 4) !== 'ftyp') return false;
    return isoBrands(buf).includes('avis');
}

// ── WebP ─────────────────────────────────────────────────────────────────

/**
 * Animated WebP is an extended-format file: a VP8X chunk whose flags byte has
 * the ANIM bit set. A plain VP8 / VP8L file cannot be animated at all.
 *
 * RIFF layout: 'RIFF' u32 size 'WEBP' then chunks of ['FourCC' u32 size payload].
 * VP8X, when present, is required to be the first chunk.
 */
function isAnimatedWebp(buf) {
    if (buf.length < 21) return false;
    if (ascii(buf, 0, 4) !== 'RIFF' || ascii(buf, 8, 4) !== 'WEBP') return false;
    if (ascii(buf, 12, 4) !== 'VP8X') return false;

    // 16..20 = chunk size, 20 = flags. Bit 1 (0x02) is ANIM.
    const flags = buf[20];
    return (flags & 0x02) !== 0;
}

// ── GIF ──────────────────────────────────────────────────────────────────

/**
 * Walk the GIF block structure counting image descriptors, stopping as soon as
 * a second one is found. Counting frames is the only correct test: the
 * NETSCAPE loop extension is a common shortcut but it is neither required for
 * animation nor absent from some single-frame files.
 *
 * Tri-state on purpose. Unlike WebP and AVIF — whose animation markers sit at a
 * fixed offset near the start — a GIF's second frame can be anywhere, typically
 * tens of kilobytes in. Answering `false` from a truncated prefix would call a
 * real animation static and let it be resized into a single frame, so a walk
 * that runs out of bytes reports `undefined` and lets the caller decide whether
 * to re-read the whole file.
 *
 * @returns {boolean|undefined} undefined = inconclusive, needs more bytes
 */
function isAnimatedGif(buf) {
    if (buf.length < 13 || ascii(buf, 0, 3) !== 'GIF') return false;

    let off = 6; // past 'GIF87a' / 'GIF89a'
    const packed = buf[off + 4];
    off += 7; // logical screen descriptor

    // Global colour table, if the flag is set
    if (packed & 0x80) {
        off += 3 * (1 << ((packed & 0x07) + 1));
    }

    let frames = 0;
    while (off < buf.length) {
        const block = buf[off];

        if (block === 0x3B) return false;          // trailer, cleanly single-frame

        if (block === 0x21) {                       // extension
            off += 2;                               // marker + label
            off = skipSubBlocks(buf, off);
            if (off < 0) return undefined;          // ran out mid-chain
            continue;
        }

        if (block === 0x2C) {                       // image descriptor = one frame
            frames++;
            if (frames > 1) return true;
            if (off + 10 > buf.length) return undefined;
            const lPacked = buf[off + 9];
            off += 10;
            if (lPacked & 0x80) {                   // local colour table
                off += 3 * (1 << ((lPacked & 0x07) + 1));
            }
            off += 1;                               // LZW minimum code size
            off = skipSubBlocks(buf, off);
            if (off < 0) return undefined;          // pixel data continues past the prefix
            continue;
        }

        return false; // unexpected byte — bail out rather than guess
    }

    return undefined; // reached the end of the prefix without a verdict
}

/** Skip a GIF sub-block chain. Returns the offset after it, or -1 if truncated. */
function skipSubBlocks(buf, off) {
    while (off < buf.length) {
        const len = buf[off];
        if (len === 0) return off + 1; // block terminator
        off += len + 1;
    }
    return -1;
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Is this image animated?
 *
 * @param {Buffer|Uint8Array} buf - file bytes
 * @returns {boolean|undefined} undefined only for a GIF whose frame count could
 *   not be settled from the bytes given; pass the whole file to resolve it.
 */
function isAnimatedBuffer(buf) {
    if (!buf || buf.length < 12) return false;
    switch (detectFormat(buf)) {
        case 'webp': return isAnimatedWebp(buf);
        case 'gif': return isAnimatedGif(buf);
        case 'avif': return isAnimatedAvif(buf);
        default: return false; // jpeg/png/bmp/tiff cannot animate in any way we care about
    }
}

/** Read only the header of a file. Returns null if it cannot be read. */
function readHeader(filePath, bytes) {
    let fd;
    try {
        fd = fs.openSync(filePath, 'r');
        const buf = Buffer.allocUnsafe(bytes || HEADER_BYTES);
        const read = fs.readSync(fd, buf, 0, buf.length, 0);
        return read > 0 ? buf.subarray(0, read) : null;
    } catch (_) {
        return null;
    } finally {
        if (fd !== undefined) { try { fs.closeSync(fd); } catch (_) { } }
    }
}

/**
 * Inspect a file on disk.
 *
 * Reads a small header first, which settles every case except a GIF whose
 * second frame lies beyond it. Only then does it fall back to reading the whole
 * file — an animated GIF page is rare in a comic archive, and being wrong there
 * means resizing an animation down to one dead frame.
 *
 * @returns {{format: string|null, animated: boolean}}
 */
function inspectFile(filePath) {
    const buf = readHeader(filePath);
    if (!buf) return { format: null, animated: false };

    const format = detectFormat(buf);
    if (format !== 'webp' && format !== 'gif' && format !== 'avif') {
        return { format, animated: false };
    }

    let animated = isAnimatedBuffer(buf);
    if (animated === undefined) {
        // GIF only, and only when the prefix was not enough
        try {
            animated = isAnimatedBuffer(fs.readFileSync(filePath));
        } catch (_) {
            animated = undefined;
        }
        // Still unresolved (unreadable or malformed): assume animated, because
        // skipping a resize is cheap and flattening an animation is not.
        if (animated === undefined) animated = true;
    }

    return { format, animated };
}

/** Convenience: is the file at this path an animated image? */
function isAnimatedFile(filePath) {
    return inspectFile(filePath).animated;
}

module.exports = {
    detectFormat,
    isAnimatedBuffer,
    isAnimatedFile,
    inspectFile,
    readHeader,
    // exported for tests
    isAnimatedWebp,
    isAnimatedGif,
    isAnimatedAvif,
    MULTIFRAME_EXT,
    HEADER_BYTES,
};
