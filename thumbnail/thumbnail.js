/**
 * Eagle format extension thumbnail: first page from a CBZ/CBR.
 *
 * Only the first image entry is extracted.
 */
const fs = require('fs');
const path = require('path');
const pluginRoot = path.join(__dirname, '..');
const sizeOf = require(path.join(pluginRoot, 'node_modules', 'image-size'));
const archive = require(path.join(pluginRoot, 'js', 'archive-util.js'));

module.exports = async ({ src, dest, item }) => {
    const ext = path.extname(src).toLowerCase();
    if (ext !== '.cbz' && ext !== '.cbr') {
        throw new Error('Unsupported format for thumbnail');
    }
    try {
        const buffer = await archive.getFirstImageBuffer(src);
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
        // Release the archive session immediately — a library import can queue
        // thousands of these.
        try { archive.cleanup(src); } catch (_) { }
    }
};
