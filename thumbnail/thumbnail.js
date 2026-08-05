/**
 * Eagle format extension thumbnail: first page from a CBZ/CBR.
 *
 * Only the first entry is extracted — the archive is never fully decompressed.
 * If that entry is a video, its first frame is grabbed with the ffmpeg binary
 * provided by Eagle's FFmpeg dependency module (declared in manifest.json).
 * When that module is not installed we fall back to the first still image, so
 * thumbnails keep working either way.
 */
const fs = require('fs');
const path = require('path');
const pluginRoot = path.join(__dirname, '..');
const sizeOf = require(path.join(pluginRoot, 'node_modules', 'image-size'));
const archive = require(path.join(pluginRoot, 'js', 'archive-util.js'));

/** Resolve the ffmpeg executable from Eagle's extraModule, if it is installed. */
function resolveFfmpegPath(extraModule) {
    try {
        const ffmpeg = extraModule && extraModule.ffmpeg;
        if (!ffmpeg || !ffmpeg.isInstalled) return null;
        return (ffmpeg.paths && ffmpeg.paths.ffmpeg) || null;
    } catch (_) {
        return null;
    }
}

module.exports = async ({ src, dest, item, extraModule }) => {
    const ext = path.extname(src).toLowerCase();
    if (ext !== '.cbz' && ext !== '.cbr') {
        throw new Error('Unsupported format for thumbnail');
    }
    try {
        const buffer = await archive.getFirstImageBuffer(src, {
            ffmpegPath: resolveFfmpegPath(extraModule),
        });
        if (!buffer || buffer.length === 0) {
            throw new Error('No images found in archive');
        }
        fs.writeFileSync(dest, buffer);
        let size;
        try {
            size = sizeOf(dest);
        } catch (_) {
            size = { width: 0, height: 0 };
        }
        if (!fs.existsSync(dest) || !size || (size.width === 0 && size.height === 0)) {
            throw new Error('Archive thumbnail generate fail');
        }
        item.height = size.height || item.height;
        item.width = size.width || item.width;
        return item;
    } finally {
        // Thumbnailing opens an archive session (temp dir + a file handle kept open
        // for fast page seeks). Release it immediately — a library import can queue
        // thousands of these, and leaked descriptors would eventually break Eagle.
        try { archive.cleanup(src); } catch (_) { }
    }
};
