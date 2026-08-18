/**
 * Archive helpers for CBZ (ZIP) and CBR (RAR).
 *
 * Lazy extraction to a temp directory: list entries once, extract images
 * on-demand in a window around the requested index, purge files beyond
 * ±PURGE_DISTANCE (and above MAX_EXTRACTED_FILES however close they are), and
 * return file paths so the renderer can use file:// URLs.
 *
 * Nothing here scales with archive length: temp-directory usage is bounded by
 * the purge window, not by page count, so a 5000-page CBZ costs the same as a
 * 50-page one.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

const PLUGIN_ROOT = path.join(__dirname, '..');
const requireYauzl = () => require(path.join(PLUGIN_ROOT, 'node_modules', 'yauzl'));
const requireUnrar = () => require(path.join(PLUGIN_ROOT, 'node_modules', 'node-unrar-js'));
const requireImageSize = () => require(path.join(PLUGIN_ROOT, 'node_modules', 'image-size'));
const imageFormat = require(path.join(__dirname, 'image-format.js'));
const renderImage = require(path.join(__dirname, 'render-image.js'));

const IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.avif'];
const IMAGE_EXT_SET = new Set(IMAGE_EXT.map(e => e.toLowerCase()));
/** All supported media extensions. Kept as an alias so callers need not care. */
const MEDIA_EXT = [...IMAGE_EXT];

/** How many images ahead/behind to extract around the current page */
const PRELOAD_AHEAD = 7;
/**
 * Purge extracted files further than this from the current page.
 *
 * Sized at roughly twice the viewer's preload window (20 pages), which bounds
 * the temp directory at ~90 pages however long the archive is. Large enough
 * that ordinary back/forward reading never re-extracts, small enough that a
 * 2000-page CBZ cannot fill the disk.
 */
const PURGE_DISTANCE = 45;
/** Only run purge when center has moved at least this many pages from last purge (reduces unlink spam) */
const PURGE_STEP = 10;
/**
 * Hard ceiling on extracted pages, independent of distance.
 *
 * PURGE_DISTANCE alone bounds a linear read, but a reader who scrubs around
 * accumulates pages faster than the throttled distance purge drops them. When
 * this trips, the pages furthest from the current centre go first.
 */
const MAX_EXTRACTED_FILES = 2 * PURGE_DISTANCE + 8;

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * Junk entries macOS adds when creating a zip: everything under __MACOSX/, and
 * AppleDouble resource forks (siblings named ._page001.jpg, which keep the
 * original extension so an extension check alone lets them through).
 */
function isMacResourceFork(name) {
    if (name.includes('__MACOSX')) return true;
    const base = name.replace(/^.*[\\/]/, '');
    return base.startsWith('._');
}

function isImageFileName(name) {
    const ext = path.extname(name).toLowerCase();
    return IMAGE_EXT_SET.has(ext) && !isMacResourceFork(name);
}

function naturalSort(a, b) {
    return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

function isCBZ(fp) { return path.extname(fp).toLowerCase() === '.cbz'; }
function isCBR(fp) { return path.extname(fp).toLowerCase() === '.cbr'; }

/** Longest entry-derived suffix we keep, so the final basename stays well under filesystem limits */
const MAX_SAFE_STEM = 64;

/**
 * Extensions we are willing to put on a file we create in the temp directory.
 * Taken from an allowlist rather than from the entry name.
 */
const SAFE_EXT_SET = new Set(MEDIA_EXT.map(e => e.toLowerCase()));

/**
 * Build a flat, filesystem-safe basename for an archive entry.
 *
 * The entry name only contributes a cosmetic suffix; `index` is what makes the
 * result unique, so collisions are impossible by construction.
 *
 * @param {string} entryName - path of the entry inside the archive
 * @param {number} index - position of the entry in the session's sorted list
 * @returns {string} a basename with no directory components
 */
function safeEntryFileName(entryName, index) {
    const base = String(entryName == null ? '' : entryName).replace(/^.*[\\/]/, '');

    const rawExt = path.extname(base).toLowerCase();
    const ext = SAFE_EXT_SET.has(rawExt) ? rawExt : '.bin';

    const stem = base
        .slice(0, base.length - path.extname(base).length)
        .replace(/[^A-Za-z0-9._-]+/g, '_')  // strips separators, colons, control chars, unicode
        .replace(/^[._]+/, '')              // never a leading dot: no hidden files, no '..'
        .replace(/_{2,}/g, '_')
        .slice(0, MAX_SAFE_STEM);

    return 'p' + String(index).padStart(6, '0') + (stem ? '_' + stem : '') + ext;
}

/**
 * Resolve `name` to an absolute path directly inside `dir`, or return null.
 *
 * @returns {string|null} absolute path, guaranteed to be an immediate child of `dir`
 */
function resolveInside(dir, name) {
    if (typeof name !== 'string' || name === '' || name === '.' || name === '..') return null;
    if (name.includes('/') || name.includes('\\') || name.includes('\0')) return null;

    const root = path.resolve(dir);
    const target = path.resolve(root, name);
    const rel = path.relative(root, target);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || rel.includes(path.sep)) return null;
    return target;
}

// ── Per-Archive Session ──────────────────────────────────────────────────

/**
 * Cache of open archive sessions: archivePath → ArchiveSession.
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
         * it back to cleanup(), so a slow-closing viewer cannot tear down a session
         * a newly opened viewer already created.
         */
        this.token = 'sess_' + (++_sessionSeq) + '_' + Date.now();
        /** Sorted list of entry names (inside-archive paths) */
        this.imageEntries = imageEntries;
        /**
         * entryName → flat on-disk basename, precomputed from the sorted entry
         * list. Every extraction target comes from here, so two entries can never
         * resolve to the same file.
         */
        this.safeNames = new Map(imageEntries.map((n, i) => [n, safeEntryFileName(n, i)]));
        /** Counter for names assigned to entries that were not in the listing */
        this._extraSeq = 0;
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
         * Map<index, boolean> – whether that page is an animated image. Keyed by
         * page, so they survive a file being purged and re-extracted.
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

    /**
     * Flat on-disk basename for an entry.
     *
     * Precomputed for every entry we listed. Anything else gets a name assigned
     * here on the spot, with an index past the end of the entry list so it
     * cannot collide with a real page.
     */
    diskNameFor(entryName) {
        let name = this.safeNames.get(entryName);
        if (!name) {
            name = safeEntryFileName(entryName, this.imageEntries.length + (this._extraSeq++));
            this.safeNames.set(entryName, name);
        }
        return name;
    }

    /**
     * Absolute path to write an entry to, inside this session's temp directory.
     * Returns null if the name fails the containment check, in which case
     * callers skip the entry.
     */
    targetPathFor(entryName) {
        return resolveInside(this.tmpDir, this.diskNameFor(entryName));
    }

    /** Drop one extracted page from disk and from the bookkeeping. */
    _dropExtracted(idx) {
        const filePath = this.extracted.get(idx);
        if (filePath) { try { fs.unlinkSync(filePath); } catch (_) { } }
        this.extracted.delete(idx);
    }

    /**
     * Purge extracted files far from `centerIndex`.
     *
     * Two rules, both needed. The distance rule is throttled by PURGE_STEP so a
     * page turn does not unlink on every call; the count rule is not, because it
     * is the one that has to hold when the throttle is suppressing the first —
     * scrubbing back and forth inside PURGE_STEP still extracts new pages, and
     * without a ceiling they accumulate until the archive is exhausted.
     */
    purge(centerIndex) {
        const throttled = this._lastPurgeCenter != null
            && Math.abs(centerIndex - this._lastPurgeCenter) < PURGE_STEP;

        if (!throttled) {
            this._lastPurgeCenter = centerIndex;
            for (const idx of [...this.extracted.keys()]) {
                if (Math.abs(idx - centerIndex) > PURGE_DISTANCE) this._dropExtracted(idx);
            }
        }

        // Hard ceiling: evict furthest-first until back under the limit.
        if (this.extracted.size > MAX_EXTRACTED_FILES) {
            const byDistance = [...this.extracted.keys()]
                .sort((a, b) => Math.abs(b - centerIndex) - Math.abs(a - centerIndex));
            let over = this.extracted.size - MAX_EXTRACTED_FILES;
            for (const idx of byDistance) {
                if (over-- <= 0) break;
                this._dropExtracted(idx);
            }
        }

        // Scaled renders belong to a page; drop them alongside their source.
        // A render whose source page is gone is dead weight regardless of distance.
        if (this._scaledCache) {
            for (const [key, entry] of this._scaledCache) {
                if (!entry) { this._scaledCache.delete(key); continue; }
                if (Math.abs(entry.index - centerIndex) > PURGE_DISTANCE
                    || !this.extracted.has(entry.index)) {
                    try { fs.unlinkSync(entry.path); } catch (_) { }
                    this._scaledCache.delete(key);
                }
            }
        }
    }

    /**
     * Run `fn` with exclusive access to this archive.
     *
     * The chain is joined *synchronously*, so callers must not await anything
     * between deciding to queue work and calling this, or two operations can
     * both observe the same previous link and interleave.
     */
    runExclusive(fn) {
        const p = this._extractionChain.then(fn, fn);
        this._extractionChain = p.then(() => { }, () => { });
        return p;
    }

    /** Re-open the archive handle if it was released, or was never opened. */
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
 * Holding the handle keeps extraction cheap: yauzl with lazyEntries walks the
 * central directory on every open, so re-opening per batch was O(entries).
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

function extractOneCBZ(zipfile, entry, session) {
    const outPath = session.targetPathFor(entry.fileName);
    if (!outPath) {
        return Promise.reject(new Error('Unsafe archive entry name: ' + entry.fileName));
    }
    return new Promise((resolve, reject) => {
        zipfile.openReadStream(entry, (errS, stream) => {
            if (errS) return reject(errS);
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
 * fd-slicer supports concurrent read streams on one descriptor, so inflate
 * overlaps with disk writes instead of strictly serialising.
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
                    const outPath = await extractOneCBZ(zip, entry, session);
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

/**
 * Extract the requested entries from a CBR into the session temp directory.
 *
 * Every entry is mapped through `diskNameFor`, so `filenameTransform` can only
 * return a flat basename we generated. The same mapping finds the file again
 * afterwards, so the two cannot disagree.
 */
async function extractBatchCBR(src, session, targetNames) {
    const unrar = requireUnrar();
    // Reuse one extractor per session: creating it re-reads and re-parses the RAR
    // headers every time, which is the dominant cost on large CBRs.
    let ext = session._unrar;
    if (!ext) {
        ext = await unrar.createExtractorFromFile({
            filepath: src,
            targetPath: session.tmpDir,
            filenameTransform: name => session.diskNameFor(name),
        });
        session._unrar = ext;
    }

    // The generator must be drained to the end even if we stop caring about the
    // results — the native archive object is only destructed once it completes.
    const unpacked = [];
    for (const file of ext.extract({ files: targetNames }).files) {
        const name = file.fileHeader && file.fileHeader.name;
        if (name && !(file.fileHeader.flags && file.fileHeader.flags.directory)) unpacked.push(name);
    }

    const results = new Map();
    if (session.destroyed) return results;

    for (const name of unpacked) {
        const outPath = session.targetPathFor(name);
        if (!outPath) {
            console.warn('[archive-util] skipping unsafe archive entry name:', name);
            continue;
        }
        // Confirm the transform actually produced the file we expect, rather
        // than trusting that extraction succeeded.
        try {
            fs.accessSync(outPath);
            results.set(name, outPath);
        } catch (_) { /* entry failed to unpack; caller treats it as missing */ }
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
 * Drop the least-recently-used idle sessions if too many are open. An active
 * viewer touches its session on every preload, so it is never a candidate.
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
        // mkdtemp rather than mkdir: it creates a directory that is guaranteed
        // not to have existed, so a session can never inherit — or clobber —
        // files left behind by anything else in the system temp directory.
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eagle-cbr-'));

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
 * Open (or reuse) a session and return its identity token. Callers pass it to
 * cleanup() so they only tear down the session they actually opened.
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
                results = await extractBatchCBR(normPath, session, neededNames);
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
                results = await extractBatchCBR(normPath, session, neededNames);
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
 * Get the first image buffer (for thumbnail generation).
 *
 * @param {string} filePath - archive path
 */
async function getFirstImageBuffer(filePath) {
    const names = await listImages(filePath);
    if (names.length === 0) throw new Error('No images found in archive');
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

// ── Render worker pool ───────────────────────────────────────────────────

/**
 * How many worker threads share the resize work.
 *
 * Two: enough that an urgent page is not stuck behind a background one, but no
 * more, since each worker loads its own copy of the ~24MB image addon.
 */
const RENDER_WORKERS = 2;

/** Tear the pool down after this long with nothing to do, to give the memory back. */
const WORKER_IDLE_MS = 2 * 60 * 1000;

/**
 * The pool, or null if it has not been started. `_poolUnavailable` latches when
 * worker threads turn out not to work in this host.
 */
let _pool = null;
let _poolUnavailable = false;
let _jobSeq = 0;

/**
 * Start the pool, or return null if worker threads are not usable here.
 *
 * Whether `worker_threads` works in an Electron renderer depends on the build,
 * so we try, and on failure fall back to rendering in-process.
 */
function getRenderPool() {
    if (_poolUnavailable) return null;
    if (_pool) return _pool;

    try {
        const { Worker } = require('worker_threads');
        const workerPath = path.join(__dirname, 'render-worker.js');
        const pool = { workers: [], idleTimer: null };

        for (let i = 0; i < RENDER_WORKERS; i++) {
            const worker = new Worker(workerPath);
            const entry = { worker, inFlight: new Map() };

            worker.on('message', msg => {
                const job = entry.inFlight.get(msg.id);
                if (!job) return;
                entry.inFlight.delete(msg.id);
                refWorker(entry);
                job.resolve(msg);
            });
            // A worker that errors or exits takes the whole pool with it; the
            // in-process fallback is always available. In-flight jobs reject and
            // their callers retry inline.
            worker.on('error', err => disableRenderPool(err));
            worker.on('exit', code => {
                if (code !== 0) disableRenderPool(new Error('render worker exited with code ' + code));
            });
            // An idle worker must not hold the process open. It is ref'd again
            // for as long as it has a job (see refWorker).
            worker.unref();

            pool.workers.push(entry);
        }

        _pool = pool;
        return _pool;
    } catch (err) {
        console.warn('[archive-util] render worker unavailable, resizing in-process:',
            err && err.message);
        _poolUnavailable = true;
        _pool = null;
        return null;
    }
}

/** Keep a worker ref'd exactly while it is busy, so a reply cannot be lost to exit. */
function refWorker(entry) {
    if (entry.inFlight.size > 0) entry.worker.ref();
    else entry.worker.unref();
}

/** Reject everything outstanding and stop using workers for the rest of the session. */
function disableRenderPool(err) {
    if (err) {
        console.warn('[archive-util] render worker failed, resizing in-process from now on:',
            err && err.message);
    }
    _poolUnavailable = true;
    const pool = _pool;
    _pool = null;
    if (!pool) return;
    clearTimeout(pool.idleTimer);
    for (const entry of pool.workers) {
        for (const job of entry.inFlight.values()) job.reject(err || new Error('render pool shut down'));
        entry.inFlight.clear();
        try { entry.worker.terminate(); } catch (_) { }
    }
}

/** Shut the pool down cleanly. Unlike disableRenderPool, a later call may restart it. */
function stopRenderPool() {
    const pool = _pool;
    _pool = null;
    if (!pool) return;
    clearTimeout(pool.idleTimer);
    for (const entry of pool.workers) {
        for (const job of entry.inFlight.values()) job.reject(new Error('render pool stopped'));
        entry.inFlight.clear();
        try { entry.worker.terminate(); } catch (_) { }
    }
}

/** Restart the idle countdown; fires only once every worker is free. */
function scheduleRenderPoolIdle(pool) {
    clearTimeout(pool.idleTimer);
    pool.idleTimer = setTimeout(() => {
        if (_pool !== pool) return;
        if (pool.workers.some(e => e.inFlight.size > 0)) {
            scheduleRenderPoolIdle(pool);
            return;
        }
        stopRenderPool();
    }, WORKER_IDLE_MS);
    if (pool.idleTimer && typeof pool.idleTimer.unref === 'function') pool.idleTimer.unref();
}

/**
 * Run one render job on the pool.
 *
 * Dispatch goes to the least loaded worker rather than round-robin.
 *
 * @returns {Promise<object|null>} the worker's reply, or null if there is no
 *   usable pool — in which case the caller should render in-process.
 */
function renderOnPool(job) {
    const pool = getRenderPool();
    if (!pool) return Promise.resolve(null);

    let target = pool.workers[0];
    for (const entry of pool.workers) {
        if (entry.inFlight.size < target.inFlight.size) target = entry;
    }

    const id = ++_jobSeq;
    return new Promise((resolve, reject) => {
        target.inFlight.set(id, { resolve, reject });
        refWorker(target);
        try {
            target.worker.postMessage({ ...job, id });
        } catch (err) {
            target.inFlight.delete(id);
            refWorker(target);
            reject(err);
            return;
        }
        scheduleRenderPoolIdle(pool);
    });
}

// ── Image pipeline ───────────────────────────────────────────────────────

/**
 * Detected container for a page, cached on the session. Read from magic bytes
 * rather than the file extension.
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

/**
 * How many scaled renders to keep on disk before evicting the oldest.
 *
 * Held below the extracted-page ceiling: a render is only useful while its
 * source page is still around, and purge() drops orphans anyway.
 */
const SCALED_CACHE_MAX = 60;

/**
 * Disk cache for downscaled pages, keyed by page + render-width bucket. Widths
 * bucket to 100px so small layout changes reuse an existing render. Entries are
 * tied to their source index so purge() can drop them with the page.
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
 * Render a single page at a specific pixel width.
 *
 * The work runs on a worker thread: @napi-rs/image performs the resize inline
 * on the calling thread, and this module is required into Eagle's renderer
 * process, so left in place every page turn would block the thread that paints.
 * If worker threads are not available the same code runs in-process; see
 * getRenderPool().
 *
 * Three things are settled before any file is touched: the on-disk cache,
 * whether the page is animated, and whether the requested width is close enough
 * to native to make resizing pointless.
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

        // Dimensions from image-size: a header read, cached on the session and
        // in practice already done by the viewer's layout pass.
        const known = getImageDimensions(normPath, [index])[0];
        const srcWidth = (known && known.width) || 0;
        const srcHeight = (known && known.height) || 0;

        // The early exit, now reached without reading the file. This is the
        // common case at high zoom, where the original is exactly what should
        // be shown.
        if (srcWidth > 0 && srcHeight > 0 &&
            renderImage.isNativeEnough(targetPixelWidth, srcWidth, srcHeight)) {
            return originalPath;
        }

        const format = detectPageFormat(session, index, originalPath) || 'jpeg';
        const { ext, encoder, quality } = renderImage.encoderFor(format);
        // cacheKey is built from a number, but route it through the same check
        // as archive entries so every write in this module has one gatekeeper.
        const outPath = resolveInside(session.tmpDir, cacheKey + ext);
        if (!outPath) return null;

        const job = {
            srcPath: originalPath,
            outPath,
            targetPixelWidth,
            encoder,
            quality,
            srcWidth,
            srcHeight,
        };

        let result = null;
        try {
            const reply = await renderOnPool(job);
            if (reply && !reply.ok) throw new Error(reply.error);
            result = reply;
        } catch (err) {
            // Either this page defeated the worker, or worker threads are not
            // usable at all. Both fall through to the in-process path. Only the
            // second case latches, via disableRenderPool.
            console.warn('[archive-util] worker render failed for page ' + index +
                ', retrying in-process:', err && err.message);
            result = null;
        }

        if (!result) result = await renderImage.renderToFile(job);

        // The addon's own metadata disagreed with image-size, or none was
        // available: the page turned out not to need resizing after all.
        if (result.skipped) return originalPath;

        // The session can be torn down while the worker is working
        if (session.destroyed) return null;

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
 * From container headers, not a decode, and cached per page. The viewer uses it
 * to skip its native `decode()` call and to switch to responsive sizing.
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
 * Clean up all sessions. Also stops the render workers: with no session left
 * there is nothing they could be asked to resize.
 */
function cleanupAll() {
    for (const session of sessions.values()) {
        session.destroy();
    }
    sessions.clear();
    stopRenderPool();
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
    cleanup,
    cleanupAll,
    isImageFileName,
    IMAGE_EXT,
    MEDIA_EXT,
    PRELOAD_AHEAD,
    PURGE_DISTANCE,
    MAX_EXTRACTED_FILES,
};
