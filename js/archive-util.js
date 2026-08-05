/**
 * Archive helpers for CBZ (ZIP) and CBR (RAR).
 *
 * Strategy: lazy extraction to temp directory.
 *  - On first access, list all entries (opens archive once).
 *  - Extract images on-demand in a window around the requested index (±PRELOAD_AHEAD).
 *  - Purge extracted files beyond ±PURGE_DISTANCE to save disk space.
 *  - Return file paths (not buffers) so the renderer can use file:// URLs.
 *  - Provide image dimensions via image-size for virtual scroll height calculation.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

const PLUGIN_ROOT = path.join(__dirname, '..');
const requireYauzl = () => require(path.join(PLUGIN_ROOT, 'node_modules', 'yauzl'));
const requireUnrar = () => require(path.join(PLUGIN_ROOT, 'node_modules', 'node-unrar-js'));
const requireImageSize = () => require(path.join(PLUGIN_ROOT, 'node_modules', 'image-size'));
const requireYazl = () => require(path.join(PLUGIN_ROOT, 'node_modules', 'yazl'));
const imageFormat = require(path.join(__dirname, 'image-format.js'));

const IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.avif'];
const IMAGE_EXT_SET = new Set(IMAGE_EXT.map(e => e.toLowerCase()));
const VIDEO_EXT = ['.mp4', '.webm'];
const VIDEO_EXT_SET = new Set(VIDEO_EXT.map(e => e.toLowerCase()));
/** All supported media extensions (images + videos) */
const MEDIA_EXT = [...IMAGE_EXT, ...VIDEO_EXT];

/** How many images ahead/behind to extract around the current page */
const PRELOAD_AHEAD = 7;
/** Purge extracted files further than this from the current page (keep plenty to avoid re-extract on back/forward) */
const PURGE_DISTANCE = 80;
/** Only run purge when center has moved at least this many pages from last purge (reduces unlink spam) */
const PURGE_STEP = 25;

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * Junk entries that macOS adds when creating a zip:
 *  - everything under __MACOSX/
 *  - AppleDouble resource forks, which are siblings named ._page001.jpg. These
 *    keep the original extension, so an extension check alone lets them through
 *    and you get a duplicate unreadable "page" next to every real one.
 */
function isMacResourceFork(name) {
    if (name.includes('__MACOSX')) return true;
    const base = name.replace(/^.*[\\/]/, '');
    return base.startsWith('._');
}

function isVideoFileName(name) {
    const ext = path.extname(name).toLowerCase();
    return VIDEO_EXT_SET.has(ext) && !isMacResourceFork(name);
}

function isImageFileName(name) {
    const ext = path.extname(name).toLowerCase();
    return (IMAGE_EXT_SET.has(ext) || VIDEO_EXT_SET.has(ext)) && !isMacResourceFork(name);
}

function naturalSort(a, b) {
    return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

function isCBZ(fp) { return path.extname(fp).toLowerCase() === '.cbz'; }
function isCBR(fp) { return path.extname(fp).toLowerCase() === '.cbr'; }

function safeName(entryName) {
    // Flatten any directory structure into a single filename to avoid path issues
    return entryName.replace(/[/\\]/g, '__');
}

// ── Per-Archive Session ──────────────────────────────────────────────────

/**
 * Cache of open archive sessions:  archivePath → ArchiveSession
 * Each session holds the temp dir, sorted entry list, and extraction state.
 */
const sessions = new Map();

/** Monotonic counter so every session gets a unique identity token */
let _sessionSeq = 0;

class ArchiveSession {
    constructor(archivePath, tmpDir, imageEntries, zip, entryMap) {
        this.archivePath = archivePath;
        this.tmpDir = tmpDir;
        /** Long-lived yauzl handle (CBZ only) so batches don't re-scan the archive */
        this.zip = zip || null;
        /** Map<entryName, yauzl.Entry> for direct seeking (CBZ only) */
        this.entryMap = entryMap || new Map();
        /**
         * Unique identity for this session. A viewer captures it on open and passes
         * it back to cleanup(), so a slow-closing viewer can never tear down the
         * session that a newly opened viewer already created for the same archive.
         */
        this.token = 'sess_' + (++_sessionSeq) + '_' + Date.now();
        /** Sorted list of entry names (inside-archive paths) */
        this.imageEntries = imageEntries;
        /** Map<index, absoluteFilePath> – tracks which pages are extracted */
        this.extracted = new Map();
        /** Map<index, {width, height}> – dimension cache */
        this.dimensions = new Map();
        /** Serializes extraction calls so concurrent requests wait properly */
        this._extractionChain = Promise.resolve();
        /** Last center index we purged for – only purge again when center moved by PURGE_STEP */
        this._lastPurgeCenter = null;
        /**
         * Map<index, string|null> – detected container per page, and
         * Map<index, boolean> – whether that page is an animated image.
         * Both come from one header read and are keyed by page, not by file, so
         * they survive the extracted file being purged and re-extracted.
         */
        this.formats = new Map();
        this.animated = new Map();
        /** True once destroy() ran, so late async work can bail out instead of recreating files */
        this.destroyed = false;
        /** Timestamp of last access, used by the idle-session reaper */
        this.lastUsed = Date.now();
    }

    get pageCount() { return this.imageEntries.length; }

    /** Absolute path for a page's extracted file */
    pathForIndex(index) {
        return this.extracted.get(index) || null;
    }

    /** Purge extracted files far from `centerIndex`. Throttled so we don't purge on every getImagePath. */
    purge(centerIndex) {
        if (this._lastPurgeCenter != null && Math.abs(centerIndex - this._lastPurgeCenter) < PURGE_STEP) {
            return;
        }
        this._lastPurgeCenter = centerIndex;
        for (const [idx, filePath] of this.extracted) {
            if (Math.abs(idx - centerIndex) > PURGE_DISTANCE) {
                try { fs.unlinkSync(filePath); } catch (_) { }
                this.extracted.delete(idx);
            }
        }
        // Scaled renders belong to a page; drop them alongside their source
        if (this._scaledCache) {
            for (const [key, entry] of this._scaledCache) {
                if (entry && Math.abs(entry.index - centerIndex) > PURGE_DISTANCE) {
                    try { fs.unlinkSync(entry.path); } catch (_) { }
                    this._scaledCache.delete(key);
                }
            }
        }
    }

    /**
     * Run `fn` with exclusive access to this archive.
     *
     * Important: the chain is joined *synchronously*, so callers must not await
     * anything between deciding to queue work and calling this. Otherwise two
     * operations can both observe the same "previous" link and interleave — which
     * is how a page removal could close the archive handle out from under an
     * extraction batch that was supposed to run first.
     */
    runExclusive(fn) {
        const p = this._extractionChain.then(fn, fn);
        this._extractionChain = p.then(() => { }, () => { });
        return p;
    }

    /**
     * Re-open the archive handle if it was released (or was never opened).
     * Keeps extraction working after a close without callers having to care.
     */
    async ensureArchive() {
        if (this.destroyed) return null;
        if (this.zip) return this.zip;
        if (!isCBZ(this.archivePath)) return null;
        const res = await listEntriesCBZ(this.archivePath);
        if (this.destroyed) {
            try { res.zipfile.close(); } catch (_) { }
            return null;
        }
        this.zip = res.zipfile;
        this.entryMap = res.entryMap;
        return this.zip;
    }

    /** Release the archive file handle (safe to call more than once) */
    closeArchive() {
        if (this.zip) {
            try { this.zip.close(); } catch (_) { }
            this.zip = null;
        }
        this.entryMap = new Map();
        this._unrar = null;
    }

    /** Remove the entire temp directory */
    destroy() {
        this.destroyed = true;
        this.closeArchive();
        try { fs.rmSync(this.tmpDir, { recursive: true, force: true }); } catch (_) { }
        // Only unregister if we are still the session on record. A stale viewer
        // closing late must not evict a fresher session for the same archive.
        if (sessions.get(this.archivePath) === this) sessions.delete(this.archivePath);
    }
}

// ── CBZ: list entries ────────────────────────────────────────────────────

/**
 * Open the zip once and keep the handle. Returns the media entry names (sorted)
 * plus the live ZipFile and a name→Entry map.
 *
 * Holding the handle is what makes extraction cheap: yauzl with lazyEntries has
 * to walk the central directory from the start on every open, so re-opening for
 * each preload batch was O(entries) work per batch — very noticeable on long
 * archives once you are deep into them. With the Entry objects cached we can
 * seek straight to the local header of any page.
 */
function listEntriesCBZ(src) {
    return new Promise((resolve, reject) => {
        const yauzl = requireYauzl();
        const names = [];
        const entryMap = new Map();
        yauzl.open(src, { lazyEntries: true, autoClose: false }, (err, zipfile) => {
            if (err) return reject(err);
            zipfile.readEntry();
            zipfile.on('entry', entry => {
                if (!/\/$/.test(entry.fileName) && isImageFileName(entry.fileName)) {
                    names.push(entry.fileName);
                    entryMap.set(entry.fileName, entry);
                }
                zipfile.readEntry();
            });
            zipfile.on('end', () => {
                names.sort(naturalSort);
                resolve({ names, zipfile, entryMap });
            });
            zipfile.on('error', err2 => {
                try { zipfile.close(); } catch (_) { }
                reject(err2);
            });
        });
    });
}

// ── CBZ: extract a batch of entries to temp dir ──────────────────────────

/** How many pages to decompress at once. Above ~4 the disk writes start to thrash. */
const EXTRACT_CONCURRENCY = 4;

function extractOneCBZ(zipfile, entry, tmpDir) {
    return new Promise((resolve, reject) => {
        zipfile.openReadStream(entry, (errS, stream) => {
            if (errS) return reject(errS);
            const outPath = path.join(tmpDir, safeName(entry.fileName));
            const ws = fs.createWriteStream(outPath);
            stream.on('error', reject);
            ws.on('error', reject);
            ws.on('finish', () => resolve(outPath));
            stream.pipe(ws);
        });
    });
}

/**
 * Extract the requested entries from an open session, several at a time.
 * fd-slicer supports concurrent read streams on one descriptor, so this
 * overlaps inflate (CPU) with disk writes (IO) instead of strictly serialising.
 */
async function extractBatchCBZ(session, targetNames) {
    const results = new Map(); // entryName → filePath
    if (!targetNames.length || session.destroyed) return results;
    // The handle may have been released (e.g. by a page removal); reopen on demand.
    const zip = await session.ensureArchive();
    if (!zip) return results;
    const entryMap = session.entryMap;

    let cursor = 0;
    const workers = new Array(Math.min(EXTRACT_CONCURRENCY, targetNames.length))
        .fill(0)
        .map(async () => {
            while (cursor < targetNames.length) {
                const name = targetNames[cursor++];
                const entry = entryMap.get(name);
                if (!entry) continue;
                try {
                    const outPath = await extractOneCBZ(zip, entry, session.tmpDir);
                    results.set(name, outPath);
                } catch (err) {
                    console.error('[archive-util] extract failed for', name, err && err.message);
                }
            }
        });

    await Promise.all(workers);
    return results;
}

// ── CBR: list entries ────────────────────────────────────────────────────

async function listEntriesCBR(src) {
    const unrar = requireUnrar();
    const ext = await unrar.createExtractorFromFile({ filepath: src });
    const list = ext.getFileList();
    const headers = [...list.fileHeaders];
    const names = headers
        .filter(h => !h.flags.directory && isImageFileName(h.name))
        .map(h => h.name);
    names.sort(naturalSort);
    return names;
}

// ── CBR: extract a batch to temp dir ─────────────────────────────────────

async function extractBatchCBR(src, tmpDir, targetNames, session) {
    const unrar = requireUnrar();
    // Reuse one extractor per session: creating it re-reads and re-parses the RAR
    // headers every time, which is the dominant cost on large CBRs.
    let ext = session && session._unrar;
    if (!ext) {
        ext = await unrar.createExtractorFromFile({
            filepath: src,
            targetPath: tmpDir,
        });
        if (session) session._unrar = ext;
    }
    const extracted = ext.extract({ files: targetNames });
    const files = [...extracted.files]; // force iteration

    const results = new Map();
    for (const name of targetNames) {
        const normalized = name.replace(/\\/g, path.sep);
        const fullPath = path.join(tmpDir, normalized);
        const altPath = path.join(tmpDir, path.basename(name));
        const safePath = path.join(tmpDir, safeName(name));

        // node-unrar-js preserves directory structure; find the file
        let readPath = null;
        if (fs.existsSync(fullPath)) readPath = fullPath;
        else if (fs.existsSync(altPath)) readPath = altPath;
        else if (fs.existsSync(safePath)) readPath = safePath;

        if (readPath) {
            // Move to flat safe name if needed
            if (readPath !== safePath) {
                try {
                    fs.renameSync(readPath, safePath);
                    readPath = safePath;
                } catch (_) { }
            }
            results.set(name, readPath);
        }
    }
    return results;
}

// ── Session management ───────────────────────────────────────────────────

/**
 * Get or create a session for the given archive.
 * On first call, lists all entries (opens archive once).
 */
/** In-flight session creations, so two concurrent callers share one session (and one temp dir). */
const pendingSessions = new Map();

/** Safety net: never keep more than this many archives open at once */
const MAX_SESSIONS = 8;
/** Only ever evict a session that has been untouched for this long */
const SESSION_IDLE_MS = 60 * 1000;

/**
 * Drop the least-recently-used idle sessions if too many are open.
 * An active viewer touches its session on every preload, so it is never a
 * candidate; this only reclaims things like batch thumbnail generation that
 * forgot to clean up.
 */
function reapIdleSessions() {
    if (sessions.size <= MAX_SESSIONS) return;
    const now = Date.now();
    const idle = [...sessions.values()]
        .filter(s => now - (s.lastUsed || 0) > SESSION_IDLE_MS)
        .sort((a, b) => (a.lastUsed || 0) - (b.lastUsed || 0));
    let over = sessions.size - MAX_SESSIONS;
    for (const s of idle) {
        if (over-- <= 0) break;
        s.destroy();
    }
}

async function getSession(archivePath) {
    const normPath = path.normalize(archivePath);
    if (sessions.has(normPath)) {
        const s = sessions.get(normPath);
        s.lastUsed = Date.now();
        return s;
    }
    if (pendingSessions.has(normPath)) return pendingSessions.get(normPath);

    const work = (async () => {
        const tmpDir = path.join(os.tmpdir(), `eagle-cbr-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        let entries, zip = null, entryMap = null;
        try {
            if (isCBZ(normPath)) {
                const res = await listEntriesCBZ(normPath);
                entries = res.names;
                zip = res.zipfile;
                entryMap = res.entryMap;
            } else if (isCBR(normPath)) {
                entries = await listEntriesCBR(normPath);
            } else {
                throw new Error('Unsupported format');
            }
        } catch (err) {
            try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { }
            throw err;
        }

        const session = new ArchiveSession(normPath, tmpDir, entries, zip, entryMap);
        sessions.set(normPath, session);
        reapIdleSessions();
        return session;
    })();

    pendingSessions.set(normPath, work);
    try {
        return await work;
    } finally {
        pendingSessions.delete(normPath);
    }
}

/**
 * Open (or reuse) a session and return its identity token.
 * Callers should hold on to this and pass it to cleanup() so they only ever
 * tear down the session they actually opened.
 */
async function getSessionToken(filePath) {
    const session = await getSession(filePath);
    return session.token;
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * List image names in archive (sorted).
 */
async function listImages(filePath) {
    const session = await getSession(filePath);
    return session.imageEntries;
}

/**
 * Ensure pages in [centerIndex - PRELOAD_AHEAD, centerIndex + PRELOAD_AHEAD]
 * are extracted to temp. Purges far-away files. Returns the path for centerIndex.
 */
async function ensureExtracted(filePath, centerIndex, abortToken) {
    const session = await getSession(filePath);

    // Chain extraction requests: if a previous extraction is in-flight,
    // wait for it to finish before starting a new batch.
    await session.runExclusive(async () => {
        if (abortToken && abortToken.aborted) return; // Drop stale request
        if (session.destroyed) return;

        const total = session.pageCount;
        const lo = Math.max(0, centerIndex - PRELOAD_AHEAD);
        const hi = Math.min(total - 1, centerIndex + PRELOAD_AHEAD);

        // Find which indices need extraction (check again after await)
        const needed = [];
        const neededNames = [];
        for (let i = lo; i <= hi; i++) {
            if (!session.extracted.has(i)) {
                needed.push(i);
                neededNames.push(session.imageEntries[i]);
            }
        }

        if (neededNames.length > 0) {
            const normPath = path.normalize(filePath);
            let results;
            if (isCBZ(normPath)) {
                results = await extractBatchCBZ(session, neededNames);
            } else {
                results = await extractBatchCBR(normPath, session.tmpDir, neededNames, session);
            }

            for (const idx of needed) {
                const entryName = session.imageEntries[idx];
                const extractedPath = results.get(entryName);
                if (extractedPath) {
                    session.extracted.set(idx, extractedPath);
                }
            }
        }

        if (!abortToken || !abortToken.aborted) {
            session.purge(centerIndex);
        }
    });

    return session.pathForIndex(centerIndex);
}

/**
 * Get the file path for a specific page.
 * Triggers lazy extraction of surrounding pages.
 */
async function getImagePath(filePath, index, abortToken) {
    return ensureExtracted(filePath, index, abortToken);
}

/**
 * Extract a range of pages in one batch and return paths for all.
 * Use for preload so the whole window is ready at once instead of one-by-one.
 * @param {string} filePath - archive path
 * @param {number[]} indices - 0-based image indices to extract
 * @param {object} abortToken - object with .aborted boolean
 * @returns {Promise<Map<number, string>>} index -> absolute file path
 */
async function getImagePathsInRange(filePath, indices, abortToken) {
    const session = await getSession(filePath);
    const unique = [...new Set(indices)].filter(i => i >= 0 && i < session.pageCount);
    if (unique.length === 0) return new Map();

    const centerForPurge = Math.floor(unique.reduce((a, b) => a + b, 0) / unique.length);

    await session.runExclusive(async () => {
        if (abortToken && abortToken.aborted) return; // Drop stale request
        if (session.destroyed) return;

        const needed = [];
        const neededNames = [];
        for (const i of unique) {
            if (!session.extracted.has(i)) {
                needed.push(i);
                neededNames.push(session.imageEntries[i]);
            }
        }

        if (neededNames.length > 0) {
            const normPath = path.normalize(filePath);
            let results;
            if (isCBZ(normPath)) {
                results = await extractBatchCBZ(session, neededNames);
            } else {
                results = await extractBatchCBR(normPath, session.tmpDir, neededNames, session);
            }

            for (const idx of needed) {
                const entryName = session.imageEntries[idx];
                const extractedPath = results.get(entryName);
                if (extractedPath) {
                    session.extracted.set(idx, extractedPath);
                }
            }
        }

        if (!abortToken || !abortToken.aborted) {
            session.purge(centerForPurge);
        }
    });

    const out = new Map();
    for (const i of unique) {
        const p = session.pathForIndex(i);
        if (p) out.set(i, p);
    }
    return out;
}

/**
 * Get the buffer for a specific page (backwards compat, used by thumbnail).
 */
async function getImageBufferByIndex(filePath, index) {
    const imgPath = await getImagePath(filePath, index);
    if (!imgPath) throw new Error('Failed to extract page ' + index);
    return fs.readFileSync(imgPath);
}

/**
 * Extract the first frame of a video as a JPEG buffer.
 *
 * The ffmpeg binary is supplied by Eagle's FFmpeg dependency module rather than
 * bundled: `ffmpeg-static` ships a single ~80MB platform-specific executable, so
 * bundling it would have made the plugin Windows-only (and huge). Eagle installs
 * the right binary for the user's platform on demand.
 *
 * @param {string} videoPath - Absolute path to the extracted video file
 * @param {string} ffmpegBin - Absolute path to the ffmpeg executable
 * @returns {Buffer|null} null if ffmpeg is unavailable or extraction fails
 */
function getVideoFrameBuffer(videoPath, ffmpegBin) {
    if (!ffmpegBin) {
        console.warn('[archive-util] no ffmpeg binary available, cannot extract video frame');
        return null;
    }

    const outPath = videoPath + '.thumb.jpg';
    try {
        // Extract first key-frame as JPEG, timeout 10s
        const result = spawnSync(
            ffmpegBin,
            [
                '-y',                  // overwrite without prompting
                '-i', videoPath,       // input
                '-frames:v', '1',      // only one frame
                '-q:v', '2',           // JPEG quality (2 = high)
                '-f', 'image2',        // force image2 muxer
                outPath
            ],
            { timeout: 10000, encoding: 'buffer' }
        );

        if (result.status !== 0 || !fs.existsSync(outPath)) {
            return null;
        }

        const buf = fs.readFileSync(outPath);
        try { fs.unlinkSync(outPath); } catch (_) { }
        return buf;
    } catch (err) {
        console.error('[archive-util] ffmpeg frame extraction failed:', err);
        try { fs.unlinkSync(outPath); } catch (_) { }
        return null;
    }
}

/**
 * Get the first image buffer (for thumbnail generation).
 * If the first entry is a video, extracts its first frame via ffmpeg.
 * Falls back to the first non-video entry if frame extraction fails.
 *
 * @param {string} filePath - archive path
 * @param {object} [opts]
 * @param {string} [opts.ffmpegPath] - ffmpeg executable from Eagle's FFmpeg module.
 *   When absent, video-first archives simply fall back to their first still image.
 */
async function getFirstImageBuffer(filePath, opts) {
    const names = await listImages(filePath);
    if (names.length === 0) throw new Error('No images found in archive');

    const firstName = names[0];

    if (isVideoFileName(firstName)) {
        const ffmpegPath = opts && opts.ffmpegPath;
        if (ffmpegPath) {
            // Extract the video to temp dir first, then grab a frame from it
            const videoPath = await getImagePath(filePath, 0);
            if (videoPath) {
                const frameBuf = getVideoFrameBuffer(videoPath, ffmpegPath);
                if (frameBuf && frameBuf.length > 0) return frameBuf;
            }
        }

        // ffmpeg unavailable or failed — fall back to first image entry
        for (let i = 1; i < names.length; i++) {
            if (!isVideoFileName(names[i])) {
                return getImageBufferByIndex(filePath, i);
            }
        }
        throw new Error(
            'Archive contains only video entries. Install the FFmpeg plugin from the ' +
            'Eagle Plugin Center to generate thumbnails from video frames.'
        );
    }

    return getImageBufferByIndex(filePath, 0);
}

/**
 * Get dimensions for a range of pages.
 * Returns array of {width, height} (or null if not yet extracted).
 * Reads dimensions from already-extracted files.
 */
function getImageDimensions(filePath, indices) {
    const normPath = path.normalize(filePath);
    const session = sessions.get(normPath);
    if (!session) return indices.map(() => null);

    const imageSize = requireImageSize();
    return indices.map(idx => {
        if (session.dimensions.has(idx)) return session.dimensions.get(idx);
        const fp = session.extracted.get(idx);
        if (!fp) return null;

        // Videos: image-size cannot read them – return a 16:9 placeholder so layout has an AR
        const ext = path.extname(fp).toLowerCase();
        if (VIDEO_EXT_SET.has(ext)) {
            const result = { width: 1920, height: 1080 };
            session.dimensions.set(idx, result);
            return result;
        }

        try {
            const dim = imageSize(fp);
            const result = { width: dim.width || 0, height: dim.height || 0 };
            session.dimensions.set(idx, result);
            return result;
        } catch (_) {
            return null;
        }
    });
}

/**
 * Get all known dimensions (for pages already extracted).
 */
async function getAllDimensions(filePath) {
    const session = await getSession(filePath);
    const total = session.pageCount;
    const indices = [];
    for (let i = 0; i < total; i++) indices.push(i);

    return getImageDimensions(filePath, indices);
}

// ── Image pipeline ───────────────────────────────────────────────────────

/**
 * @napi-rs/image, resolved lazily and cached.
 *
 * Lazy because the thumbnail path never resizes anything, and loading a ~24MB
 * native addon during a library import that only needs first-page bytes is
 * wasted work. Cached because require() cost adds up across pages.
 */
let _imageLib;
function requireImageLib() {
    if (_imageLib === undefined) {
        _imageLib = require(path.join(PLUGIN_ROOT, 'node_modules', '@napi-rs', 'image'));
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
 * Detected container for a page, cached on the session.
 * Read from magic bytes rather than the file extension, which inside an archive
 * is whatever the packer happened to write.
 */
function detectPageFormat(session, index, filePath) {
    if (session.formats.has(index)) return session.formats.get(index);
    const info = imageFormat.inspectFile(filePath);
    session.formats.set(index, info.format);
    session.animated.set(index, info.animated);
    return info.format;
}

/** Is this page an animated image? Cached on the session alongside the format. */
function isAnimatedPage(session, index, filePath) {
    if (session.animated.has(index)) return session.animated.get(index);
    const info = imageFormat.inspectFile(filePath);
    session.formats.set(index, info.format);
    session.animated.set(index, info.animated);
    return info.animated;
}

/** How many scaled renders to keep on disk before evicting the oldest */
const SCALED_CACHE_MAX = 140;

/**
 * Disk cache for downscaled pages, keyed by page + render-width bucket. Widths
 * bucket to 100px so that small layout changes reuse an existing render instead
 * of producing a new one. Tying entries to their source index lets purge() drop
 * scaled copies alongside the page they came from.
 */
function rememberScaled(session, cacheKey, outPath, index) {
    if (!session._scaledCache) session._scaledCache = new Map();
    session._scaledCache.set(cacheKey, { path: outPath, index });
    // Simple FIFO eviction – Map preserves insertion order
    while (session._scaledCache.size > SCALED_CACHE_MAX) {
        const oldestKey = session._scaledCache.keys().next().value;
        const oldest = session._scaledCache.get(oldestKey);
        session._scaledCache.delete(oldestKey);
        if (oldest) { try { fs.unlinkSync(oldest.path); } catch (_) { } }
    }
}

/**
 * Pick the output encoder for a page.
 *
 * The rule is "same format out as in", so a page never changes character just
 * because it was resized — with one exception. @napi-rs/image decodes GIF but
 * cannot encode it, so a static GIF is re-encoded as PNG: both are lossless,
 * and a GIF page here is single-frame by definition (animated ones never reach
 * this code).
 *
 * @param {string} format - detected container, from image-format.js
 * @returns {{ext: string, encode: (t: any) => Promise<Buffer>}}
 */
function encoderFor(format) {
    switch (format) {
        case 'png':
            // CompressionType.Fast — this is a display cache, not an archive;
            // spending CPU on a smaller temp file is a bad trade.
            return { ext: '.png', encode: t => t.png({ compressionType: 1 }) };
        case 'webp':
            return { ext: '.webp', encode: t => t.webp(90) };
        case 'gif':
            return { ext: '.png', encode: t => t.png({ compressionType: 1 }) };
        case 'avif':
            // Encoding AVIF is far too slow for an interactive path (seconds per
            // page); JPEG keeps the resize worth doing at all.
            return { ext: '.jpg', encode: t => t.jpeg(90) };
        default:
            return { ext: '.jpg', encode: t => t.jpeg(90) };
    }
}

/**
 * Render a single page at a specific pixel width.
 *
 * Backed by @napi-rs/image: prebuilt Rust/N-API binaries, so there is no
 * node-gyp step and one build works across Node and Electron versions. The
 * encoders run on the libuv threadpool, which keeps the decode/resize off the
 * renderer's main thread — hence the async-only API here.
 *
 * @param {string} filePath - Absolute path to the CBZ/CBR archive
 * @param {number} index - 0-based image index
 * @param {number} targetPixelWidth - Absolute pixel width requested (e.g. 1450)
 * @returns {Promise<string|null>} path to the scaled image, the original path
 *   when resizing is not worthwhile, or null on failure
 */
async function renderAtScale(filePath, index, targetPixelWidth) {
    if (!targetPixelWidth || targetPixelWidth <= 0) return null;
    const normPath = path.normalize(filePath);
    const session = sessions.get(normPath);
    if (!session || session.destroyed) return null;

    const originalPath = session.pathForIndex(index);
    if (!originalPath) return null;

    // Round target to nearest 100px for caching bucket reuse
    const scaleKey = Math.max(100, Math.round(targetPixelWidth / 100) * 100);
    const cacheKey = `page_${String(index).padStart(4, '0')}_w${scaleKey}`;

    // Check if already rendered at this scale
    if (session._scaledCache && session._scaledCache.has(cacheKey)) {
        const cached = session._scaledCache.get(cacheKey);
        try { fs.accessSync(cached.path); return cached.path; } catch (_) { /* re-render */ }
    }

    try {
        // Animated pages are served untouched — resizing one would flatten it to
        // a single frame. Cached per page, so the header read happens once.
        if (isAnimatedPage(session, index, originalPath)) return originalPath;

        const lib = requireImageLib();
        const bytes = fs.readFileSync(originalPath);
        const transformer = new lib.Transformer(bytes);

        const meta = await transformer.metadata(false);
        if (!meta || !meta.width || !meta.height) return null;

        // Target width capped at original (no upscale)
        const targetW = Math.min(targetPixelWidth, meta.width);

        // Within 95% of native, serve the original: re-encoding would cost time
        // and add a generation of loss for no visible gain. This is the common
        // case at high zoom, where the original is exactly what should be shown.
        if (targetW >= meta.width * 0.95 && meta.width <= 10000 && meta.height <= 10000) {
            return originalPath;
        }

        const format = detectPageFormat(session, index, originalPath) || 'jpeg';
        const { ext, encode } = encoderFor(format);
        const outPath = path.join(session.tmpDir, cacheKey + ext);

        // fastResize is the SIMD path; Lanczos3 matches the quality of the
        // previous libvips output closely enough to be indistinguishable on
        // comic scans. Height is derived from the aspect ratio.
        const targetH = Math.max(1, Math.round(meta.height * (targetW / meta.width)));
        transformer.fastResize({
            width: targetW,
            height: targetH,
            filter: lanczos3(lib),
        });

        const out = await encode(transformer);
        if (!out || !out.length) return null;

        // The session can be torn down while the threadpool is working
        if (session.destroyed) return null;

        fs.writeFileSync(outPath, out);
        rememberScaled(session, cacheKey, outPath, index);
        return outPath;
    } catch (err) {
        console.error('renderAtScale failed for page ' + index + ':', err && err.message);
        return null;
    }
}


/**
 * Is this page an animated image (animated WebP / GIF / AVIF)?
 *
 * Determined from container headers, not a decode, and cached per page for the
 * life of the session. The viewer needs this to skip its native `decode()` call
 * — decoding an animated WebP buffers every frame into the compositor and wrecks
 * the frame rate — and to switch the page to responsive sizing.
 *
 * @returns {boolean} false when the page is not extracted yet or is unreadable
 */
function isPageAnimated(filePath, index) {
    const session = sessions.get(path.normalize(filePath));
    if (!session || session.destroyed) return false;
    if (session.animated.has(index)) return session.animated.get(index);
    const fp = session.pathForIndex(index);
    if (!fp) return false;
    return isAnimatedPage(session, index, fp);
}

/**
 * Clean up the session for an archive (remove temp files).
 * @param {string} filePath
 * @param {string} [expectedToken] - if given, only destroy when the live session
 *   still matches this token. Prevents a closing viewer from wiping the temp dir
 *   of a viewer that has just reopened the same archive.
 */
function cleanup(filePath, expectedToken) {
    const normPath = path.normalize(filePath);
    const session = sessions.get(normPath);
    if (!session) return;
    if (expectedToken && session.token !== expectedToken) return;
    session.destroy();
}

/**
 * Clean up all sessions.
 */
function cleanupAll() {
    for (const session of sessions.values()) {
        session.destroy();
    }
    sessions.clear();
}

// ── CBZ: remove entry without re-compression ────────────────────────────

/**
 * Remove a single entry from a CBZ (ZIP) archive.
 * Uses yauzl to read raw compressed streams and yazl to write them
 * into a new archive, skipping the entry to delete. No re-compression.
 * Atomically replaces the original file.
 */
/** Busy-wait a few ms without pulling in a dependency (only used on the rename retry path). */
function sleepSync(ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* spin */ }
}

/**
 * Replace `dest` with `src`. Retries because on Windows a lingering handle on the
 * destination (Eagle's own preview, an antivirus scanner, a just-closed read
 * stream) makes rename fail with EPERM/EBUSY for a few tens of milliseconds.
 */
function replaceFileWithRetry(src, dest, attempts = 8) {
    let lastErr;
    for (let i = 0; i < attempts; i++) {
        try {
            fs.renameSync(src, dest);
            return;
        } catch (err) {
            lastErr = err;
            if (err && (err.code === 'EXDEV')) {
                // Different volume: rename can never work here
                fs.copyFileSync(src, dest);
                try { fs.unlinkSync(src); } catch (_) { }
                return;
            }
            sleepSync(40 + i * 30);
        }
    }
    // Last resort: overwrite in place rather than replacing the directory entry
    try {
        fs.copyFileSync(src, dest);
        try { fs.unlinkSync(src); } catch (_) { }
        return;
    } catch (_) { }
    throw lastErr;
}

function rewriteCBZWithout(archivePath, entryNames) {
    return new Promise((resolve, reject) => {
        const yauzl = requireYauzl();
        const yazl = requireYazl();
        const tmpOut = archivePath + '.tmp-' + process.pid + '-' + Date.now();
        const skipSet = new Set(entryNames);

        let settled = false;
        let zipfileRef = null;
        const fail = err => {
            if (settled) return;
            settled = true;
            try { if (zipfileRef) zipfileRef.close(); } catch (_) { }
            try { fs.unlinkSync(tmpOut); } catch (_) { }
            reject(err);
        };

        yauzl.open(archivePath, { lazyEntries: true, autoClose: false }, (err, zipfile) => {
            if (err) return fail(err);
            zipfileRef = zipfile;

            const outZip = new yazl.ZipFile();
            const ws = fs.createWriteStream(tmpOut);
            outZip.outputStream.pipe(ws);

            let kept = 0;

            // The source file handle and the destination stream close independently.
            // On Windows, renaming over a file that still has an open handle fails with
            // EPERM/EBUSY — so we wait for BOTH before replacing the original.
            let writeDone = false;
            let readDone = false;
            const finishIfReady = () => {
                if (settled || !writeDone || !readDone) return;
                settled = true;

                if (kept === 0) {
                    try { fs.unlinkSync(tmpOut); } catch (_) { }
                    return reject(new Error('Refusing to write an empty archive'));
                }

                try {
                    // Sanity check: the rewritten file must be a plausible zip
                    const st = fs.statSync(tmpOut);
                    if (st.size <= 22) throw new Error('Rewritten archive is empty or corrupted');
                    replaceFileWithRetry(tmpOut, archivePath);
                } catch (e) {
                    try { fs.unlinkSync(tmpOut); } catch (_) { }
                    return reject(e);
                }

                resolve(kept);
            };

            zipfile.readEntry();
            zipfile.on('entry', entry => {
                if (settled) return;
                if (skipSet.has(entry.fileName)) {
                    // Skip this entry
                    zipfile.readEntry();
                    return;
                }

                if (/\/$/.test(entry.fileName)) {
                    // Directory entry
                    try {
                        outZip.addEmptyDirectory(entry.fileName, { mtime: entry.getLastModDate() });
                    } catch (_) { /* yazl rejects some odd paths; dropping an empty dir is harmless */ }
                    zipfile.readEntry();
                } else {
                    // File entry: read uncompressed data and let yazl re-compress if originally compressed.
                    // Piping raw deflated bytes into yazl(compress: false) corrupts the archive's CRC32 signature.
                    zipfile.openReadStream(entry, (errS, stream) => {
                        if (errS) return fail(errS);
                        try {
                            outZip.addReadStream(stream, entry.fileName, {
                                mtime: entry.getLastModDate(),
                                compress: entry.compressionMethod !== 0, // match original
                                size: entry.uncompressedSize,
                            });
                            kept++;
                        } catch (e) {
                            return fail(e);
                        }
                        stream.on('error', fail);
                        stream.on('end', () => { if (!settled) zipfile.readEntry(); });
                    });
                }
            });

            zipfile.on('end', () => {
                // All entries queued. close() unrefs the fd; the actual fs.close is async,
                // so wait for the 'close' event rather than assuming the handle is gone.
                outZip.end();
                zipfile.on('close', () => { readDone = true; finishIfReady(); });
                zipfile.close();
                // yauzl only emits 'close' when autoClose owns the fd; guard with a fallback
                // so we never hang if the event does not arrive.
                setTimeout(() => { readDone = true; finishIfReady(); }, 250);
            });

            ws.on('finish', () => { writeDone = true; finishIfReady(); });
            ws.on('error', fail);
            zipfile.on('error', fail);
        });
    });
}

/**
 * Remove one or more entries from a CBZ.
 * Serialized against in-flight extraction for the same archive: on Windows an
 * open read handle from a background preload batch makes the rename fail, which
 * is what made "Remove from Archive" appear broken.
 */
async function removeEntryCBZ(archivePath, entryName) {
    const normPath = path.normalize(archivePath);
    const names = Array.isArray(entryName) ? entryName : [entryName];
    const session = sessions.get(normPath);

    const run = async () => {
        if (session) {
            // Release the long-lived read handle. On Windows the rename below fails
            // with EPERM while any handle on the archive is still open — this was
            // the main reason "Remove from Archive" silently failed.
            session.closeArchive();
            // Drop our own extracted copies too; they are about to be stale anyway.
            for (const [idx, fp] of session.extracted) {
                try { fs.unlinkSync(fp); } catch (_) { }
                session.extracted.delete(idx);
            }
            // Give the OS a tick to actually release the descriptor
            await new Promise(r => setTimeout(r, 30));
        }
        await rewriteCBZWithout(normPath, names);
        // Invalidate session cache so the next listImages() re-reads from disk
        const live = sessions.get(normPath);
        if (live) live.destroy();
    };

    if (!session) return run();

    // Queue behind any pending extraction so no read stream is open on the archive.
    return session.runExclusive(run);
}

// Cleanup on process exit
process.on('exit', cleanupAll);
process.on('SIGINT', () => { cleanupAll(); process.exit(); });
process.on('SIGTERM', () => { cleanupAll(); process.exit(); });

module.exports = {
    listImages,
    getImagePath,
    getImagePathsInRange,
    getImageBufferByIndex,
    getFirstImageBuffer,
    getImageDimensions,
    getAllDimensions,
    getSessionToken,
    renderAtScale,
    isPageAnimated,
    removeEntryCBZ,
    cleanup,
    cleanupAll,
    isImageFileName,
    isVideoFileName,
    IMAGE_EXT,
    VIDEO_EXT,
    MEDIA_EXT,
    PRELOAD_AHEAD,
    PURGE_DISTANCE,
};
