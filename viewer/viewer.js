/**
 * CBZ/CBR Reader
 *
 * Single reading body for all modes: slide (single/double page), scroll (continuous), compact (instant single).
 * Same DOM for all modes; layout and navigation change only. No virtual scroll, no dynamic add/remove.
 */
(function () {
    const pathModule = require('path');
    const urlModule = require('url');

    /**
     * Absolute path → file:// URL.
     *
     * Hand-rolling this ('file:///' + backslash swap) breaks in two ways:
     *   - on macOS the path already starts with '/', so you get file:////Users/…
     *   - any '#', '?' or '%' in a page filename truncates or corrupts the URL,
     *     on every platform.
     * pathToFileURL handles the separator, the leading slash and the escaping.
     */
    function toFileURL(absPath) {
        try {
            return urlModule.pathToFileURL(absPath).href;
        } catch (_) {
            // Last-ditch fallback for anything pathToFileURL rejects
            const p = absPath.replace(/\\/g, '/');
            return 'file://' + (p.startsWith('/') ? '' : '/') + encodeURI(p);
        }
    }

    /** file:// URL (or plain path) → absolute path, on either platform. */
    function fromFileURL(value) {
        if (!/^file:\/\//i.test(value)) return value;
        try {
            return urlModule.fileURLToPath(value);
        } catch (_) {
            let p = value.replace(/^file:\/\//i, '');
            try { p = decodeURIComponent(p); } catch (_) { }
            // Windows gives '/C:/x'; POSIX must keep its leading slash
            return /^\/[A-Za-z]:/.test(p) ? p.slice(1) : p;
        }
    }

    const urlParams = new URLSearchParams(window.location.search);
    const fileId = urlParams.get('id') || '';
    let filePath = pathModule.normalize(fromFileURL(urlParams.get('path') || ''));

    /**
     * ── Stale viewer guard ──────────────────────────────────────────────
     * Eagle sometimes reuses the preview host for the next archive without the
     * page actually re-executing (window reuse / back-forward cache). When that
     * happens this script never reruns, so the previously opened comic stays on
     * screen even though a different file was requested — which is exactly the
     * "it opened the previous one" symptom.
     *
     * We snapshot the query we booted with and reload if it ever changes, or if
     * the page is restored from bfcache. Both checks are no-ops in the normal
     * case, so this costs nothing when things work correctly.
     */
    const bootSearch = window.location.search;
    let reloadArmed = true;
    function reloadIfArchiveChanged(reason) {
        if (!reloadArmed) return;
        if (window.location.search === bootSearch) return;
        reloadArmed = false;
        console.warn('[cbz-reader] viewer reused for a different archive (' + reason + ') – reloading');
        try { archiveUtil.cleanup(filePath, sessionToken); } catch (_) { }
        window.location.reload();
    }
    window.addEventListener('pageshow', e => {
        if (e.persisted) {
            reloadArmed = false;
            window.location.reload();
        }
    });
    window.addEventListener('popstate', () => reloadIfArchiveChanged('popstate'));
    window.addEventListener('hashchange', () => reloadIfArchiveChanged('hashchange'));
    window.addEventListener('focus', () => reloadIfArchiveChanged('focus'));
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) reloadIfArchiveChanged('visibilitychange');
    });
    setInterval(() => reloadIfArchiveChanged('poll'), 750);

    const theme = (urlParams.get('theme') || 'dark').toLowerCase();
    document.documentElement.setAttribute('theme', theme === 'light' ? 'light' : 'dark');

    const readingContainer = document.getElementById('reading-container');
    const readingBody = readingContainer.querySelector('.reading-body');
    const readingTrack = document.getElementById('reading-track');
    const pageCurrentLabel = document.getElementById('page-current');
    const pageTotalLabel = document.getElementById('page-total');
    const pageSlider = document.getElementById('page-slider');
    const btnPrev = document.getElementById('btn-prev');
    const btnNext = document.getElementById('btn-next');
    const pagesToggle = document.getElementById('pages-toggle');
    const pagesSingleIcon = document.getElementById('pages-single-icon');
    const pagesDoubleIcon = document.getElementById('pages-double-icon');
    const continuousToggle = document.getElementById('continuous-toggle');
    const toolbar = document.getElementById('toolbar');
    const scrollWidthLabel = document.getElementById('scroll-width-label');
    const scrollGapToggle = document.getElementById('scroll-gap-toggle');
    const gapOnIcon = document.getElementById('gap-on-icon');
    const gapOffIcon = document.getElementById('gap-off-icon');
    const mangaRtlBtn = document.getElementById('manga-rtl');
    const scrollNavToggle = document.getElementById('scroll-nav-toggle');
    const mouseOnIcon = document.getElementById('mouse-on-icon');
    const mouseOffIcon = document.getElementById('mouse-off-icon');
    const transitionSpeedToggle = document.getElementById('transition-speed-toggle');
    const transitionSpeedLabel = document.getElementById('transition-speed-label');
    const dirLtrIcon = document.getElementById('dir-ltr-icon');
    const dirRtlIcon = document.getElementById('dir-rtl-icon');
    const zoomResetBtn = document.getElementById('zoom-reset');
    const zoomLabel = document.getElementById('zoom-label');
    const contentEl = document.getElementById('content');

    const STORAGE_PREFIX = (typeof eagle !== 'undefined' && eagle.plugin && eagle.plugin.manifest && eagle.plugin.manifest.id) ? eagle.plugin.manifest.id : 'eagle-cbz-cbr-reader';
    function getSetting(key, def) {
        try { const v = localStorage.getItem(STORAGE_PREFIX + ':setting:' + key); return v !== null ? v : def; } catch (_) { return def; }
    }
    function setSetting(key, val) {
        try { localStorage.setItem(STORAGE_PREFIX + ':setting:' + key, String(val)); } catch (_) { }
    }
    function getPosKey() {
        const key = fileId || filePath.replace(/\\/g, '/');
        return STORAGE_PREFIX + ':pos:' + key;
    }

    let imageNames = [];
    /** imagesData[index] = { width, height, aspectRatio } — 0-based image index */
    let imagesData = {};
    /** indexNum = spread count in double mode, image count otherwise (set by updateIndexNum) */
    let indexNum = 0;
    /** 1-based current spread index */
    let currentIndex = 1;
    /** Scroll mode: position of each image. imagesFullPosition[imageIndex] = { top, center, bottom, height } */
    let imagesFullPosition = {};
    /** Same data as a dense array ordered by index, for binary search during scroll */
    let posList = [];

    /** Index of the last page whose `top` is <= y (or 0). Assumes posList is sorted by top. */
    function findIndexAtOffset(y) {
        let lo = 0, hi = posList.length - 1, best = 0;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            const p = posList[mid];
            if (!p) { lo = mid + 1; continue; }
            if (p.top <= y) { best = mid; lo = mid + 1; }
            else { hi = mid - 1; }
        }
        return best;
    }
    let rightSize = { width: 0, height: 0, scrollHeight: 0 };
    let slideTrackTotalW = 0;

    /** 1 or 2 pages per view. Defaults to 1 for brand new files. */
    let pagesPerView = 1;
    /** Continuous scroll (vertical); when false = paged slide/compact */
    let continuous = getSetting('continuous', 'false') === 'true';
    /** Derived: 'single' | 'double' | 'scroll' for layout/nav (scroll when continuous) */
    let viewMode = continuous ? 'scroll' : (pagesPerView === 1 ? 'single' : 'double');
    let scrollWidth = Math.max(50, Math.min(100, parseInt(getSetting('scrollWidth', '100'), 10) || 100));
    if (![100, 75, 50].includes(scrollWidth)) scrollWidth = 100;
    let scrollGap = getSetting('scrollGap', 'true') !== 'false';
    let mangaRtl = getSetting('mangaRtl', 'false') === 'true';
    let scrollNavEnabled = getSetting('scrollNavEnabled', 'true') !== 'false';
    let pageTransitionMs = parseInt(getSetting('pageTransitionSpeed', '300'), 10);
    if (pageTransitionMs !== 0) pageTransitionMs = Math.max(100, Math.min(500, pageTransitionMs));

    let currentScale = 1;
    let unscaledTrackHeight = 0;
    let haveZoom = false;
    let currentZoomIndex = false; // 0-based index of zoomed page
    let scalePrevData = { tranX: 0, tranX2: 0, tranY: 0, tranY2: 0, scale: 1 };
    let originalRect = false;
    let zoomMoveData = {};

    // Drag navigation state
    let dragNav = null; // { startX, startY, startTx, startScrollTop }
    let rightDrag = null; // { startY, startScale }
    let rightDragUsed = false; // true after right-drag zoom, suppresses context menu once

    // Standard portrait comic/manga shape falls back here (width/height)
    const DEFAULT_ASPECT = 0.69;

    const archiveUtil = require('../js/archive-util.js');
    const VIDEO_EXT_SET = new Set(archiveUtil.VIDEO_EXT.map(e => e.toLowerCase()));

    /**
     * Identity of the archive session this viewer opened. Passed back to cleanup()
     * so a viewer closing late can never delete the temp files of a viewer that
     * has already reopened the same archive.
     */
    let sessionToken = null;

    function isVideoEntry(index) {
        const name = imageNames[index] || '';
        const ext = name.substring(name.lastIndexOf('.')).toLowerCase();
        return VIDEO_EXT_SET.has(ext);
    }

    function isVideoPath(fp) {
        const ext = fp.substring(fp.lastIndexOf('.')).toLowerCase();
        return VIDEO_EXT_SET.has(ext);
    }



    function getAspectRatio(imageIndex) {
        const d = imagesData[imageIndex];
        if (d && d.aspectRatio) return d.aspectRatio;
        return DEFAULT_ASPECT;
    }

    function loadImageSrc(index) {
        return archiveUtil.getImagePath(filePath, index).then(fp => {
            if (!fp) throw new Error('No path for page ' + index);
            // Skip dimension update for video entries — their real dims come from loadedmetadata
            if (!isVideoEntry(index)) {
                const dims = archiveUtil.getImageDimensions(filePath, [index]);
                if (dims && dims[0] && dims[0].width > 0) {
                    imagesData[index] = {
                        width: dims[0].width,
                        height: dims[0].height,
                        aspectRatio: dims[0].width / dims[0].height
                    };
                }
            }
            return toFileURL(fp);
        });
    }

    // Single track: one .r-flex per image for all 3 views. Double = 50% width + nav by spreads.
    function getSpreadCount(n) {
        if (n <= 1) return Math.max(1, n);
        return 2 + Math.floor((n - 2) / 2);
    }
    function getSpreadPages(n, spreadIndex0) {
        if (n <= 0) return { idx1: 0, idx2: null, single: true };
        if (spreadIndex0 <= 0) return { idx1: 0, idx2: null, single: true };

        // Spread 1 is indices [1, 2]. Spread 2 is indices [3, 4], etc.
        const idx1 = (spreadIndex0 * 2) - 1;
        const idx2 = idx1 + 1 < n ? idx1 + 1 : null;
        return { idx1, idx2, single: idx2 === null };
    }

    function getSpreadForImage(n, imageIndex0) {
        if (imageIndex0 <= 0) return 0;
        return Math.floor((imageIndex0 - 1) / 2) + 1;
    }

    function syncViewMode() {
        viewMode = continuous ? 'scroll' : (pagesPerView === 1 ? 'single' : 'double');
    }
    function updateIndexNum() {
        const n = imageNames.length;
        indexNum = pagesPerView === 2 ? getSpreadCount(n) : n;
    }

    /**
     * Cached element lists. These are rebuilt only when the track is rebuilt, which
     * removes a pile of querySelectorAll() calls from the navigation / scroll / preload
     * paths — those ran on every event and walked the whole track each time.
     */
    let rFlexEls = [];
    let mediaEls = [];

    // Build DOM: one .r-flex per image/video, same for all modes
    function addHtmlImages() {
        const n = imageNames.length;

        readingTrack.innerHTML = '';
        readingTrack.className = '';
        rFlexEls = new Array(n);
        mediaEls = new Array(n);

        const frag = document.createDocumentFragment();

        for (let i = 0; i < n; i++) {
            const rFlex = document.createElement('div');
            rFlex.className = 'r-flex';
            rFlex.dataset.index = String(i);

            const rImg = document.createElement('div');
            rImg.className = 'r-img r-img-i' + i;
            rImg.dataset.index = String(i);
            const wrap = document.createElement('div');

            if (isVideoEntry(i)) {
                // Video entry: create a <video> that loops silently with no controls
                const vid = document.createElement('video');
                vid.dataset.index = String(i);
                vid.dataset.isVideo = '1';
                vid.autoplay = true;
                vid.loop = true;
                vid.muted = true;
                vid.playsInline = true;
                vid.controls = false;
                vid.preload = 'none';
                wrap.appendChild(vid);
                mediaEls[i] = vid;
            } else {
                const img = document.createElement('img');
                img.alt = '';
                img.dataset.index = String(i);
                img.loading = 'eager';
                img.decoding = 'async';
                wrap.appendChild(img);
                mediaEls[i] = img;
            }

            rImg.appendChild(wrap);
            rFlex.appendChild(rImg);
            rFlexEls[i] = rFlex;
            frag.appendChild(rFlex);
        }

        // One reflow for the whole track instead of one per page
        readingTrack.appendChild(frag);

        readingTrack.classList.toggle('track-has-gap', scrollGap);
        hasAnimatedImages = false;
        lazyLoadObserver();
    }

    let imgObserver = null;
    let disposeAfterLoadTimer = 0;

    /** Monotonically increasing epoch – incremented on every navigation so stale tasks can bail out */
    let renderEpoch = 0;
    let preloadTimer = 0;

    /** Asynchronous render queue to prevent main-thread blocking during parallel image decodes */
    const renderQueue = {
        tasks: [],
        running: false,
        add: function (priority, idx, taskFn, epoch) {
            if (this.tasks.some(t => t.idx === idx)) return;
            this.tasks.push({ priority, idx, taskFn, epoch: epoch !== undefined ? epoch : renderEpoch });
            this.tasks.sort((a, b) => b.priority - a.priority);
            this.process();
        },
        process: async function () {
            if (this.running || this.tasks.length === 0) return;
            this.running = true;
            const task = this.tasks.shift();
            try {
                /* Skip stale tasks from a previous navigation epoch */
                if (task.epoch === renderEpoch) {
                    const abortToken = {
                        get aborted() { return task.epoch !== renderEpoch; }
                    };
                    await task.taskFn(abortToken);
                }
            } finally {
                this.running = false;
                this.process();
            }
        },
        clear: function () {
            this.tasks = [];
        }
    };

    /** Debounced layout pass after image loads – batches multiple loads into one pass */
    function scheduleDisposeAfterLoad() {
        if (disposeAfterLoadTimer) return; // already scheduled
        disposeAfterLoadTimer = setTimeout(() => {
            disposeAfterLoadTimer = 0;
            if (slideAnimationRaf) {
                scheduleDisposeAfterLoad();
                return;
            }
            // Loads firm up placeholder aspect ratios into real ones, so page
            // heights shift under the reader. Hold the anchor across the
            // recalculation or the strip slides while they are reading it.
            const anchor = captureScrollAnchor();
            disposeImages();
            if (continuous) {
                calculateView(false);
                restoreScrollAnchor(anchor);
                if (haveZoom) applyScale(currentScale, false);
            }
        }, continuous ? 150 : 16);
    }

    function getExpectedTargetWidth(idx) {
        const content = readingContainer;
        let contentHeight = rightSize.height > 0 ? rightSize.height : (content.clientHeight || 1);
        let contentWidth = rightSize.width > 0 ? rightSize.width : (content.clientWidth || 1);
        if (continuous) {
            const bodyDiv = content.querySelector('.reading-body') || content;
            contentWidth = bodyDiv.offsetWidth || contentWidth;
        }

        const n = imageNames.length;
        const isDouble = pagesPerView === 2;
        const isCover = idx === 0;
        const isLastSingle = (idx === n - 1) && (n % 2 === 0);

        const cellW = isDouble
            ? (isCover || isLastSingle ? contentWidth : (continuous ? Math.floor(contentWidth / 2) - 1 : contentWidth / 2))
            : contentWidth;

        const ar = getAspectRatio(idx);

        let imageWidth;
        if (!continuous) {
            imageWidth = contentHeight * ar;
            if (imageWidth > cellW) {
                imageWidth = cellW;
            }
        } else {
            imageWidth = cellW * (scrollWidth / 100);
        }

        return imageWidth;
    }

    /** True when a page is big enough that downscaling for display is worthwhile. */
    function shouldDownsample(displayWidthCss, imageIndex) {
        if (!displayWidthCss || displayWidthCss <= 0) return false;
        const dpr = window.devicePixelRatio || 1;
        const pxWidth = Math.round(displayWidthCss * dpr);
        if (imageIndex !== undefined && !isNaN(imageIndex)) {
            const d = imagesData[imageIndex];
            // Skip when already near native resolution — re-encoding would only
            // cost time and add generation loss
            if (d && d.width > 0 && pxWidth >= d.width * 0.95) return false;
        }
        return true;
    }

    /** Set the source of a video element */
    async function smartLoadVideo(vid, absolutePath, taskEpoch) {
        // Use dataset.loaded as the guard — NOT vid.src.
        // Chromium resolves the .src *property* to the page base URL when the src
        // *attribute* is an empty string (set by purgeRenderCache), making `if (vid.src)`
        // always truthy and preventing the video from ever loading after purge.
        if (vid.dataset.loaded === '1') return;

        const url = toFileURL(absolutePath);

        // Final safety abort before mutating DOM
        if (taskEpoch !== undefined && taskEpoch !== renderEpoch) return;

        // Listen for real dimensions once the browser parses the video header.
        // This fires quickly (no need to decode any video frames) and gives us the
        // true AR so we can reflow the layout beyond the 16:9 Node-side placeholder.
        vid.addEventListener('loadedmetadata', () => {
            const vw = vid.videoWidth;
            const vh = vid.videoHeight;
            if (vw && vh) {
                const idx = parseInt(vid.dataset.index, 10);
                if (!isNaN(idx)) {
                    imagesData[idx] = { width: vw, height: vh, aspectRatio: vw / vh };
                }
                // Recompute layout now that we have the real aspect ratio
                disposeImages();
                if (continuous) calculateView(false);
            }
        }, { once: true });

        vid.src = url;
        vid.load();

        // Only auto-play if this video is in the currently visible spread.
        // Preloaded videos start paused to avoid decoding dozens of videos simultaneously.
        const vidIdx = parseInt(vid.dataset.index, 10);
        const currentSpread = getSpreadAt(currentIndex - 1) || [];
        const isCurrentSpread = !isNaN(vidIdx) && currentSpread.some(s => s.index === vidIdx);
        if (isCurrentSpread) {
            vid.play().catch(() => { });
        }

        vid.dataset.loaded = '1';

        // Initial layout pass with placeholder AR (will be corrected by loadedmetadata above)
        requestAnimationFrame(() => { disposeImages(); });
    }

    /**
     * Pause all video elements that are NOT in the current visible spread,
     * and resume the one(s) that ARE. Called on every page-change event.
     */
    function syncVideoPlayback() {
        const currentSpread = getSpreadAt(currentIndex - 1) || [];
        const currentIndices = new Set(currentSpread.map(s => s.index));

        for (let idx = 0, len = mediaEls.length; idx < len; idx++) {
            const vid = mediaEls[idx];
            if (!vid || vid.tagName !== 'VIDEO') continue;
            if (vid.dataset.loaded !== '1') continue; // not yet loaded, skip

            if (currentIndices.has(idx)) {
                if (vid.paused) vid.play().catch(() => { });
            } else {
                if (!vid.paused) vid.pause();
            }
        }
    }

    /**
     * Produce (or reuse) a downscaled copy of a page at `pxWidth` via Sharp.
     *
     * archive-util's renderAtScale owns the on-disk cache (keyed by page and
     * width bucket, bounded/evicted there). That cache is what makes revisiting
     * a page, flipping back and forth, or toggling layout modes cheap — those
     * paths would otherwise force a fresh Sharp resize for every visible page.
     *
     * Returns the *original* file when resizing is pointless — because the page
     * is animated, or because the requested width is close enough to native that
     * a re-encode would cost time and lose quality for nothing.
     *
     * @returns {Promise<{url: string, native: boolean}|null>}
     */
    async function renderPageAtWidth(index, pxWidth) {
        const originalPath = await archiveUtil.getImagePath(filePath, index);
        if (!originalPath) return null;
        try {
            const scaledPath = await archiveUtil.renderAtScale(filePath, index, pxWidth);
            if (!scaledPath) return { url: toFileURL(originalPath), native: true };
            return { url: toFileURL(scaledPath), native: scaledPath === originalPath };
        } catch (err) {
            console.error('renderPageAtWidth failed for page ' + index + ':', err);
            return { url: toFileURL(originalPath), native: true };
        }
    }

    /**
     * In-flight render requests, keyed by page + width bucket.
     *
     * Without this, a single zoom gesture launches a fresh full-size resize on
     * every settle of the debounce, so several multi-hundred-megabyte jobs
     * for the same page run concurrently and starve each other. Collapsing them
     * means the second caller simply awaits the first.
     */
    const renderInFlight = new Map();

    function renderPageAtWidthShared(index, pxWidth) {
        const key = index + '|' + Math.round(pxWidth / 100);
        const existing = renderInFlight.get(key);
        if (existing) return existing;
        const work = renderPageAtWidth(index, pxWidth)
            .finally(() => { renderInFlight.delete(key); });
        renderInFlight.set(key, work);
        return work;
    }

    /** Set the source of an image, downsampled to the display size when worthwhile. */
    async function smartLoadImage(img, absolutePath, taskEpoch) {
        let targetWidth = 0;
        let imageIndex;
        const idxStr = img.dataset.index;
        if (idxStr !== undefined && !isNaN(parseInt(idxStr, 10))) {
            imageIndex = parseInt(idxStr, 10);
            targetWidth = getExpectedTargetWidth(imageIndex);
        } else {
            const wrap = img.closest('.r-img > div');
            targetWidth = wrap ? (parseInt(wrap.style.width, 10) || wrap.offsetWidth) : 0;
        }

        let url = toFileURL(absolutePath);
        // Read from container headers rather than a decode, and cached per page
        // in archive-util. We need it here up front to skip the native decode()
        // below, which on an animated WebP buffers every frame into the
        // compositor and destroys the frame rate.
        let isAnimated = imageIndex !== undefined
            && archiveUtil.isPageAnimated(filePath, imageIndex);

        /**
         * Pixel width of what actually ends up in the <img>. Recorded so a later
         * resize can tell whether a re-render would gain anything: growing the
         * window past this needs more pixels, everything else does not.
         * Serving the untouched file means full native resolution, which no
         * amount of window growth can improve on.
         */
        const nativeWidth = (imagesData[imageIndex] && imagesData[imageIndex].width) || 0;
        let renderedWidth = nativeWidth || Infinity;

        if (imageIndex !== undefined && !isAnimated && shouldDownsample(targetWidth, imageIndex)) {
            // Target pixel width follows the device pixel ratio so text stays crisp
            const pxWidth = Math.round(targetWidth * (window.devicePixelRatio || 1));

            // Abort if the user navigated away before the resize starts
            if (taskEpoch !== undefined && taskEpoch !== renderEpoch) return;

            try {
                const res = await renderPageAtWidthShared(imageIndex, pxWidth);

                // Abort if the user navigated away while the resize ran.
                // This instantly unlocks the renderQueue for the new page.
                if (taskEpoch !== undefined && taskEpoch !== renderEpoch) return;

                if (res) {
                    url = res.url;
                    // `native` means renderAtScale handed back the original file
                    // (animated, or already close enough to native to bother),
                    // so what is on screen is full resolution.
                    renderedWidth = res.native ? (nativeWidth || Infinity) : pxWidth;
                } else {
                    // Temp file purged out from under us — re-resolve
                    const recovered = await archiveUtil.getImagePath(filePath, imageIndex);
                    if (taskEpoch !== undefined && taskEpoch !== renderEpoch) return;
                    if (recovered) url = toFileURL(recovered);
                }
            } catch (err) {
                console.error('Downscale failed for page ' + imageIndex + ':', err);
                try {
                    const recovered = await archiveUtil.getImagePath(filePath, imageIndex);
                    if (taskEpoch !== undefined && taskEpoch !== renderEpoch) return;
                    if (recovered) url = toFileURL(recovered);
                } catch (_) { }
            }
        }

        try {
            const preloader = new Image();
            preloader.src = url;
            // Native decode() on animated WebP buffers massive frames into the compositor,
            // completely destroying frame rate. Only decode() static bounds natively.
            if (!isAnimated) {
                await preloader.decode(); // Wait until decoded in memory (0-frame flicker swap)
            }

            // Final safety abort before mutating DOM
            if (taskEpoch !== undefined && taskEpoch !== renderEpoch) return;

            img.src = url;
            // Now rendered at the current layout size, so no longer stale
            img.dataset.stale = '';
            img.dataset.renderedW = String(renderedWidth);
            if (isAnimated) {
                img.dataset.animated = "1";
                hasAnimatedImages = true;
                // Trigger a layout flush so `setRImgSize` replaces exact pixels with responsive bounds
                requestAnimationFrame(() => { disposeImages(); });
            }

            if (currentScale > 1 && !isAnimated) {
                scheduleHiResRender(); // Snap to high-res right after the chunk loads if the user is zoomed
            }
        } catch (e) {
            if (taskEpoch !== undefined && taskEpoch !== renderEpoch) return;
            img.src = url;
            img.dataset.stale = '';
        }
    }

    function lazyLoadObserver() {
        if (imgObserver) imgObserver.disconnect();
        imgObserver = new IntersectionObserver(entries => {
            for (const e of entries) {
                if (!e.isIntersecting) continue;
                const wrap = e.target;
                // Support both <img> and <video> media elements
                const vid = wrap.querySelector('video[data-is-video]');
                const img = vid ? null : (wrap.tagName === 'IMG' ? wrap : wrap.querySelector('img'));
                const mediaEl = vid || img;
                if (!mediaEl) continue;
                // Skip if already loaded
                if (vid && vid.dataset.loaded) continue;
                if (img && !needsLoad(img)) continue;
                const idx = parseInt(mediaEl.dataset.index, 10);
                if (isNaN(idx)) continue;
                const dist = Math.abs(idx - getCurrentCenterImageIndex());
                renderQueue.add(2000 - dist, idx, async (abortToken) => {
                    const taskEpoch = renderEpoch;
                    // Abort if user fast-scrolled far away before this task started
                    const currentDist = Math.abs(idx - getCurrentCenterImageIndex());
                    if (currentDist > 15) return;

                    if (vid && vid.dataset.loaded) return;
                    if (img && !needsLoad(img)) return;

                    try {
                        const fp = await archiveUtil.getImagePath(filePath, idx, abortToken);
                        if (!fp) return;
                        if (taskEpoch !== renderEpoch) return;

                        const dims = archiveUtil.getImageDimensions(filePath, [idx]);
                        // Skip dimension update for video entries — their real dims come from loadedmetadata
                        if (!isVideoEntry(idx) && dims && dims[0] && dims[0].width > 0) {
                            imagesData[idx] = { width: dims[0].width, height: dims[0].height, aspectRatio: dims[0].width / dims[0].height };
                        }

                        if (vid) {
                            await smartLoadVideo(vid, fp, taskEpoch);
                        } else {
                            if (img.dataset.index !== String(idx) || !needsLoad(img)) return;
                            if (idx === 0) {
                                img.addEventListener('load', function onFirstLoad() {
                                    img.removeEventListener('load', onFirstLoad);
                                    const w = img.closest('.r-img > div');
                                    if (w) { w.style.backgroundImage = ''; w.style.backgroundSize = ''; w.style.backgroundPosition = ''; w.style.backgroundRepeat = ''; }
                                });
                            }
                            await smartLoadImage(img, fp, taskEpoch);
                            if (img.decode) {
                                try { await img.decode(); } catch (_) { }
                            }
                        }
                        scheduleDisposeAfterLoad();
                    } catch (e) {
                        console.error('Failed to load media ' + idx, e);
                    }
                });
            }
        }, { root: readingContainer, rootMargin: '2000px', threshold: 0 });
        // Observe both img and video wraps
        readingTrack.querySelectorAll('.r-img > div').forEach(wrap => {
            imgObserver.observe(wrap);
        });
    }

    // Size and position images (disposeImages)
    function disposeImages() {
        const content = readingContainer;
        const rect = content.getBoundingClientRect();
        let contentHeight = rect.height || 1;
        let contentWidth = Math.round(rect.width) || 1;
        if (continuous) {
            const bodyDiv = content.querySelector('.reading-body') || content;
            contentWidth = bodyDiv.offsetWidth || content.clientWidth || 1;
        }
        const n = imageNames.length;

        const isDouble = pagesPerView === 2;

        for (let i = 0; i < n; i++) {
            const rFlex = rFlexEls[i];
            if (!rFlex) continue;

            const isCover = i === 0;
            const isLastSingle = (i === n - 1) && (n % 2 === 0);

            const cellW = isDouble
                ? (isCover || isLastSingle ? contentWidth : (continuous ? Math.floor(contentWidth / 2) - 1 : contentWidth / 2))
                : contentWidth;

            const ar = getAspectRatio(i);

            let imageWidth, imageHeight;
            if (!continuous) {
                imageHeight = contentHeight;
                imageWidth = imageHeight * ar;
                if (imageWidth > cellW) {
                    imageWidth = cellW;
                    imageHeight = imageWidth / ar;
                }
            } else {
                const effW = cellW * (scrollWidth / 100);
                imageWidth = effW;
                imageHeight = imageWidth / ar;
            }

            const rImg = rFlex.querySelector('.r-img');
            if (rImg) setRImgSize(rImg, imageWidth, imageHeight);

            rFlex.style.width = cellW + 'px';
            if (!continuous) {
                rFlex.style.height = contentHeight + 'px';
                rFlex.style.minHeight = '';
            } else {
                rFlex.style.minHeight = imageHeight + 'px';
                rFlex.style.height = '';
            }

            if (isDouble) {
                const isCover = i === 0;
                const isLastSingle = (i === n - 1) && (n % 2 === 0);
                rFlex.classList.remove('double-left', 'double-right');
                if (!isCover && !isLastSingle) {
                    rFlex.classList.add(i % 2 === 1 ? 'double-left' : 'double-right');
                }
            } else {
                rFlex.classList.remove('double-left', 'double-right');
            }
        }
    }

    function setRImgSize(rImg, w, h) {
        const wrap = rImg.querySelector(':scope > div');
        if (!wrap) return;

        const vid = wrap.querySelector('video[data-is-video]');
        const img = vid ? null : wrap.querySelector('img');
        const isAnimated = img && img.dataset.animated === '1';
        const isFlexible = isAnimated; // Only animated WebP needs responsive sizing; videos use exact px like static images

        if (isFlexible) {
            // For animated WebP: set both an explicit pixel size AND maintain max-bounds so
            // Chrome has a concrete rasterization target for animation frames
            wrap.style.width = w + 'px';
            wrap.style.height = h + 'px';
            wrap.style.maxWidth = w + 'px';
            wrap.style.maxHeight = h + 'px';
            wrap.style.margin = '0 auto';
            img.style.width = '100%';
            img.style.height = 'auto';
            img.style.maxWidth = w + 'px';
            img.style.maxHeight = h + 'px';
        } else {
            // Static images AND videos: lock to exact pixel bounds.
            // For images, the AR was read from the file so w/h already match exactly.
            // For videos, object-fit:contain (CSS) handles any AR mismatch without distortion.
            wrap.style.width = w + 'px';
            wrap.style.height = h + 'px';
            wrap.style.maxWidth = w + 'px';
            wrap.style.maxHeight = h + 'px';
            wrap.style.margin = '0';
            if (vid) {
                vid.style.width = w + 'px';
                vid.style.height = h + 'px';
                vid.style.maxWidth = w + 'px';
                vid.style.maxHeight = h + 'px';
                vid.style.display = 'block';
            } else if (img) {
                img.style.width = w + 'px';
                img.style.height = h + 'px';
                img.style.maxWidth = w + 'px';
                img.style.maxHeight = h + 'px';
                img.style.objectFit = 'fill';
            }
        }
    }

    // Layout mode (calculateView)
    /**
     * Remember where the reader is, as a page plus a fraction into that page.
     *
     * A whole-container fraction (scrollTop / scrollHeight) is not good enough
     * here. Page heights in continuous mode are derived from the container
     * width and each page's own aspect ratio, so a resize changes them by
     * different amounts — most of all on webtoon strips, where one page can be
     * many screens tall. Anchoring to a page and an offset within it survives
     * that; a global fraction drifts.
     *
     * Offsets are in unscaled layout space, matching imagesFullPosition, so the
     * anchor stays valid across a zoom change too.
     *
     * @returns {{index: number, frac: number}|null} null when not applicable
     */
    function captureScrollAnchor() {
        if (!continuous || !posList.length) return null;
        const y = readingContainer.scrollTop / (currentScale || 1);
        const index = findIndexAtOffset(y);
        const p = imagesFullPosition[index];
        if (!p || !(p.height > 0)) return { index, frac: 0 };
        // Clamped because y can land in the gap between pages, which belongs to
        // no page and would otherwise give a fraction above 1.
        const frac = Math.max(0, Math.min(1, (y - p.top) / p.height));
        return { index, frac };
    }

    /** Put the reader back where captureScrollAnchor() found them. */
    function restoreScrollAnchor(anchor) {
        if (!anchor || !continuous) return;
        const p = imagesFullPosition[anchor.index];
        if (!p) return;
        readingContainer.scrollTop = (p.top + anchor.frac * p.height) * (currentScale || 1);
    }

    function calculateView(first) {
        const content = readingContainer;
        const rect = content.getBoundingClientRect();
        rightSize = { width: Math.round(rect.width), height: Math.round(rect.height), scrollHeight: content.scrollHeight };

        if (continuous) {
            /* flex row + wrap so 1 page = one column, 2 pages = two columns; scroll vertical */
            readingTrack.classList.remove('slide-layout', 'compact-layout');
            readingTrack.classList.add('scroll-layout');
            readingTrack.style.width = '100%';
            readingTrack.style.height = '';
            readingTrack.style.flexDirection = 'row';
            readingTrack.style.flexWrap = 'wrap';
            readingTrack.style.transform = '';
            readingTrack.style.direction = mangaRtl ? 'rtl' : 'ltr';

            // Math-based position calculation: no DOM reads (.offsetHeight) needed.
            // Compute each row's height from aspect ratio + container width.
            const n = imageNames.length;
            const bodyDiv = content.querySelector('.reading-body') || content;
            const cW = bodyDiv.offsetWidth || content.clientWidth || 1;
            const isDouble = pagesPerView === 2;
            const gapPx = scrollGap ? 8 : 0;
            let runY = 0;

            // Wipe dict to rebuild row heights
            imagesFullPosition = {};
            posList = new Array(n);

            for (let i = 0; i < n; i++) {
                const ar = getAspectRatio(i);
                let rowHeight = 0;

                if (!isDouble) {
                    const effW = cW * (scrollWidth / 100);
                    rowHeight = effW / ar;
                    imagesFullPosition[i] = { top: runY, center: runY + rowHeight / 2, bottom: runY + rowHeight, height: rowHeight };
                } else {
                    const isCover = i === 0;
                    const isLastSole = (i === n - 1) && (n % 2 === 0);
                    if (isCover || isLastSole) {
                        const effW = cW * (scrollWidth / 100);
                        rowHeight = effW / ar;
                        imagesFullPosition[i] = { top: runY, center: runY + rowHeight / 2, bottom: runY + rowHeight, height: rowHeight };
                    } else {
                        // Two images per row
                        const nextI = i + 1;
                        const ar1 = ar;
                        const ar2 = nextI < n ? getAspectRatio(nextI) : ar1;
                        const effW = Math.floor((cW / 2) - 1) * (scrollWidth / 100);
                        const h1 = effW / ar1;
                        const h2 = effW / ar2;
                        rowHeight = Math.max(h1, h2);

                        imagesFullPosition[i] = { top: runY, center: runY + h1 / 2, bottom: runY + h1, height: h1 };
                        if (nextI < n) {
                            imagesFullPosition[nextI] = { top: runY, center: runY + h2 / 2, bottom: runY + h2, height: h2 };
                            i++; // Skip the next image as we processed it in this row
                        }
                    }
                }

                runY += rowHeight + gapPx;
            }

            // Dense, index-ordered mirror of imagesFullPosition. `top` is
            // non-decreasing, so lookups can binary search instead of scanning
            // every page on each scroll event.
            for (let i = 0; i < n; i++) posList[i] = imagesFullPosition[i] || null;

            unscaledTrackHeight = runY;
            refreshZoomMetrics();

            if (!scrollLayerRaf) scrollLayerRaf = requestAnimationFrame(updateScrollLayerClass);
        } else {
            readingTrack.classList.remove('scroll-layout', 'compact-layout');
            readingTrack.classList.add('slide-layout');
            readingTrack.style.flexDirection = '';
            readingTrack.style.direction = mangaRtl ? 'rtl' : '';
            const n = rFlexEls.length;
            let totalW = pagesPerView === 2
                ? (n <= 1 ? rect.width : rect.width * (1 + (n - 2) * 0.5 + (n % 2 === 1 ? 1 : 0.5)))
                : rect.width * n;
            readingTrack.style.width = totalW + 'px';
            slideTrackTotalW = totalW;
            readingTrack.style.height = rect.height + 'px';
            readingTrack.style.flexDirection = '';
            updateSlideLayerClass();
            refreshZoomMetrics();
        }
    }

    /** Add .slide-layer only to prev/current/next spreads to avoid layer explosion */
    function updateSlideLayerClass() {
        if (continuous || !readingTrack.classList.contains('slide-layout')) return;
        const indices = new Set();
        for (let s = -2; s <= 2; s++) {
            const spread0 = currentIndex - 1 + s;
            if (spread0 < 0) continue;
            const spread = getSpreadAt(spread0);
            if (spread) spread.forEach(p => indices.add(p.index));
        }
        for (let i = 0, len = rFlexEls.length; i < len; i++) {
            const r = rFlexEls[i];
            if (!r) continue;
            const shouldHave = indices.has(i);
            // Only touch the class list when the state actually changes; blind
            // toggles on every navigation invalidate style for the whole track.
            if (r.classList.contains('slide-layer') !== shouldHave) {
                r.classList.toggle('slide-layer', shouldHave);
            }
            if (r.classList.contains('scroll-layer')) r.classList.remove('scroll-layer');
        }
    }

    /** Add .scroll-layer only to items near viewport to limit layers and fix vertical flicker */
    let scrollLayerRaf = 0;
    function updateScrollLayerClass() {
        scrollLayerRaf = 0;
        if (!continuous || !readingTrack.classList.contains('scroll-layout')) return;

        // Map scroll coordinate back from the visually scaled space to unscaled layout space
        const scrollTop = readingContainer.scrollTop / currentScale;
        const viewHeight = rightSize.height / currentScale;

        const center = scrollTop + viewHeight / 2;
        const margin = viewHeight * 1.5;
        const viewTop = center - margin;
        const viewBot = center + margin;

        // Use math-based positions to find the visible range (no DOM reads, no full scan)
        let rangeStart = findIndexAtOffset(viewTop);
        // Walk back over any rows that still overlap viewTop (two-up rows share a top)
        while (rangeStart > 0 && posList[rangeStart - 1] && posList[rangeStart - 1].bottom >= viewTop) rangeStart--;
        let rangeEnd = findIndexAtOffset(viewBot);
        while (rangeEnd + 1 < posList.length && posList[rangeEnd + 1] && posList[rangeEnd + 1].top <= viewBot) rangeEnd++;

        // Only toggle classes on elements that changed state
        for (let i = 0, len = rFlexEls.length; i < len; i++) {
            const el = rFlexEls[i];
            if (!el) continue;
            const shouldHave = i >= rangeStart && i <= rangeEnd;
            if (el.classList.contains('scroll-layer') !== shouldHave) {
                el.classList.toggle('scroll-layer', shouldHave);
            }
            // Also clear stale slide-layer
            if (el.classList.contains('slide-layer')) {
                el.classList.remove('slide-layer');
            }
        }
    }

    /** Pixel offset of the left edge of spread (0-based) in slide mode */
    function getSpreadStartOffset(spreadIndex0, contentWidth) {
        if (spreadIndex0 <= 0) return 0;
        const k = spreadIndex0;
        if (pagesPerView === 2)
            return k * contentWidth;
        return k * contentWidth;
    }

    function returnLargerImage(spreadIndex0) {
        const n = imageNames.length;
        if (pagesPerView === 2) {
            const sp = getSpreadPages(n, spreadIndex0);
            const el0 = rFlexEls[sp.idx1];
            const el1 = sp.idx2 != null ? rFlexEls[sp.idx2] : null;
            const r0 = el0 ? (el0.querySelector('.r-img') || el0).getBoundingClientRect() : { height: 0, top: 0 };
            const r1 = el1 ? (el1.querySelector('.r-img') || el1).getBoundingClientRect() : { height: 0, top: 0 };
            if (r0.height >= r1.height) return { height: r0.height, top: r0.top };
            return { height: r1.height, top: r1.top };
        }
        const el = rFlexEls[spreadIndex0];
        const rImg = el ? el.querySelector('.r-img') : null;
        const r = rImg ? rImg.getBoundingClientRect() : { height: 0, top: 0 };
        return { height: r.height, top: r.top };
    }

    // Go to spread (goToIndex)
    let slideAnimationRaf = 0;
    let slideCurrentTx = 0;
    const slideAnimState = { startTx: 0, targetTx: 0, startTime: 0, durationMs: 0 };
    let slideTransitionEndBound = false;

    /** CSS transition runs on compositor thread, no main-thread stutter */
    function onSlideTransitionEnd() {
        slideAnimationRaf = 0;
        slideCurrentTx = slideAnimState.targetTx;
        preloadImagesAroundCurrent();
    }
    function bindSlideTransitionEnd() {
        if (slideTransitionEndBound) return;
        slideTransitionEndBound = true;
        readingTrack.addEventListener('transitionend', function (e) {
            if (e.target === readingTrack && e.propertyName === 'transform') onSlideTransitionEnd();
        });
    }

    function goToIndex(spreadIndex1Based, animation) {
        const eIndex = Math.max(1, Math.min(spreadIndex1Based, indexNum));
        const content = readingContainer;
        const durationMs = animation ? pageTransitionMs : 0;

        if (continuous) {
            // Use math-based positions (no DOM read / forced reflow)
            const imgIdx = pagesPerView === 2
                ? getSpreadPages(imageNames.length, eIndex - 1).idx1
                : (eIndex - 1);
            const pos = imagesFullPosition[imgIdx];
            if (pos) {
                content.scrollTop = pos.top * currentScale;
            }
            currentIndex = eIndex;
            return;
        }

        /* No layout read in slide path: use cached width so compositor transition isn't delayed */
        const contentWidth = rightSize.width;
        if (!contentWidth) {
            /* First time: instant jump and cache width; next navigation will animate */
            rightSize.width = content.getBoundingClientRect().width;
            slideAnimationRaf = 0;
            readingTrack.style.transition = 'none';
            const ltrOff = getSpreadStartOffset(eIndex - 1, rightSize.width);
            const tx = mangaRtl ? ltrOff - (slideTrackTotalW - rightSize.width) : -ltrOff;
            readingTrack.style.transform = 'translate3d(' + tx + 'px, 0, 0)';
            slideCurrentTx = tx;
            currentIndex = eIndex;
            updateSlideLayerClass();
            return;
        }
        const ltrOff2 = getSpreadStartOffset(eIndex - 1, contentWidth);
        const targetTx = mangaRtl ? ltrOff2 - (slideTrackTotalW - contentWidth) : -ltrOff2;
        if (durationMs <= 0) {
            slideAnimationRaf = 0;
            readingTrack.style.transition = 'none';
            readingTrack.style.transform = 'translate3d(' + targetTx + 'px, 0, 0)';
            slideCurrentTx = targetTx;
            currentIndex = eIndex;
            updateSlideLayerClass();
            return;
        }

        currentIndex = eIndex;
        updateSlideLayerClass();
        slideAnimState.targetTx = targetTx;
        slideAnimationRaf = 1; /* non-zero = animating, so scheduleDisposeAfterLoad defers */
        bindSlideTransitionEnd();
        /* Apply transition in next frame so no layout read + no other DOM work in same frame */
        const durationS = durationMs / 1000;
        const targetTxVal = targetTx;
        requestAnimationFrame(() => {
            readingTrack.style.transition = 'transform ' + durationS + 's cubic-bezier(0.215, 0.61, 0.355, 1)';
            readingTrack.style.transform = 'translate3d(' + targetTxVal + 'px, 0, 0)';
        });
    }

    let onScrollBlock = false;
    let scrollPreloadTimer = 0;
    function onScroll() {
        if (!continuous || onScrollBlock) return;
        const content = readingContainer;
        // Map scrollbar physical visual space back to unscaled layout space
        const scrollTop = content.scrollTop / currentScale;
        const center = scrollTop + (rightSize.height / 2) / currentScale;

        // Binary search instead of scanning every page: positions are index-ordered
        // and monotonic, and this runs on every scroll event.
        let selKey1 = findIndexAtOffset(center);
        let closest = Infinity;
        {
            const hit = posList[selKey1];
            if (hit && hit.top <= center && hit.bottom >= center) {
                closest = 0;
            } else {
                // Not inside a row (we may be in a gap): pick the nearest neighbour
                for (let k = Math.max(0, selKey1 - 2); k <= Math.min(posList.length - 1, selKey1 + 2); k++) {
                    const pos = posList[k];
                    if (!pos) continue;
                    const d = Math.abs(pos.center - center);
                    if (d < closest) { closest = d; selKey1 = k; }
                }
            }
        }

        // Secondary fallback: if we yoinked the scrollbar deep, but the layout engine hasn't 
        // measured those pages yet (so imagesFullPosition has huge gaps and closest is far),
        // we map the physical scroll ratio purely mathematically to the image array index.
        if (closest > rightSize.height * 3 && content.scrollHeight > rightSize.height) {
            const ratio = content.scrollTop / (content.scrollHeight - rightSize.height);
            selKey1 = Math.round(ratio * (indexNum - 1));
            // Ensure we map spread blocks accurately in 2-page view
            if (pagesPerView === 2) {
                const sp = getSpreadPages(imageNames.length, selKey1);
                selKey1 = sp.idx1;
            }
        }
        const newIndex = pagesPerView === 2 ? getSpreadForImage(imageNames.length, selKey1) + 1 : selKey1 + 1;
        if (newIndex !== currentIndex) {
            // Clear stale render tasks when user scrolls to a new page
            // so viewport-local images get priority
            renderQueue.clear();
            renderEpoch++;

            currentIndex = newIndex;
            updatePageInfo();
            preloadImagesAroundCurrent();
            syncVideoPlayback();
        }
        /* Keep preload pipeline full: run again after short delay so ahead images are requested early */
        clearTimeout(scrollPreloadTimer);
        scrollPreloadTimer = setTimeout(preloadImagesAroundCurrent, 200);
        savePosition();
        if (!scrollLayerRaf) scrollLayerRaf = requestAnimationFrame(updateScrollLayerClass);
    }

    // Position save/restore
    let savePositionTimer = 0;
    function savePositionImmediate() {
        clearTimeout(savePositionTimer);
        try {
            const data = {
                pagesPerView,
                continuous,
                index: currentIndex,
                spreadIndex: pagesPerView === 2 ? currentSpreadIndex() : undefined,
                savedAt: Date.now()
            };
            localStorage.setItem(getPosKey(), JSON.stringify(data));
        } catch (_) { }
    }
    function savePosition() {
        clearTimeout(savePositionTimer);
        savePositionTimer = setTimeout(savePositionImmediate, 100);
    }

    function currentSpreadIndex() {
        if (pagesPerView !== 2) return 0;
        return Math.max(0, Math.min(currentIndex - 1, indexNum - 1));
    }

    function restorePosition() {
        try {
            const raw = localStorage.getItem(getPosKey());
            if (!raw) return;
            const data = JSON.parse(raw);

            // Automatically expire reading progress after 24 hours
            if (data.savedAt && (Date.now() - data.savedAt > 24 * 60 * 60 * 1000)) {
                localStorage.removeItem(getPosKey());
                return;
            }

            if (typeof data.pagesPerView === 'number') pagesPerView = data.pagesPerView === 2 ? 2 : 1;
            if (typeof data.continuous === 'boolean') continuous = data.continuous;
            else if (data.mode === 'scroll') continuous = true;
            else if (data.mode === 'single' || data.mode === 'double') { continuous = false; pagesPerView = data.mode === 'double' ? 2 : 1; }
            syncViewMode();
            updateIndexNum();
            const idx = Math.max(1, Math.min(Number(data.index) || 1, indexNum));
            currentIndex = idx;
        } catch (_) { }
    }

    // Page info & nav
    function updatePageInfo() {
        const total = imageNames.length;
        let currentString = '';
        if (pagesPerView === 2) {
            const spread = getSpreadAt(currentIndex - 1);
            if (spread && spread.length === 2)
                currentString = (spread[0].index + 1) + '-' + (spread[1].index + 1);
            else if (spread && spread[0])
                currentString = (spread[0].index + 1);
            else
                currentString = '1';
        } else {
            const spread = getSpreadAt(currentIndex - 1);
            const first = spread && spread[0];
            currentString = first ? first.index + 1 : 1;
        }

        if (pageCurrentLabel) pageCurrentLabel.textContent = currentString;
        if (pageTotalLabel) pageTotalLabel.textContent = total;
        if (pageSlider) {
            pageSlider.max = indexNum || 1;
            pageSlider.value = currentIndex || 1;
        }
    }

    function getSpreadAt(spreadIndex0) {
        const n = imageNames.length;
        if (pagesPerView === 2) {
            const sp = getSpreadPages(n, spreadIndex0);
            const out = [{ index: sp.idx1 }];
            if (sp.idx2 != null) out.push({ index: sp.idx2 });
            return out;
        }
        if (spreadIndex0 < 0 || spreadIndex0 >= n) return null;
        return [{ index: spreadIndex0 }];
    }

    /** Current spread's first image index (0-based) for preload center */
    function getCurrentCenterImageIndex() {
        const spread = getSpreadAt(currentIndex - 1);
        return spread && spread[0] ? spread[0].index : 0;
    }

    /** Preload */
    const MAX_PREV = 5;
    const MAX_NEXT = 15;

    function applyPathMapToDom(pathMap, center, priority) {
        if (!pathMap || pathMap.size === 0) return;
        const resolvedIndices = [...pathMap.keys()];
        const dims = archiveUtil.getImageDimensions(filePath, resolvedIndices);
        if (dims && dims.length === resolvedIndices.length) {
            resolvedIndices.forEach((idx, i) => {
                // Skip video entries — their real dims come from the loadedmetadata browser event.
                // Writing the Node-side 16:9 placeholder here would overwrite the real AR
                // and cause a snap-back 200-500ms after navigation when the preloader fires.
                if (isVideoEntry(idx)) return;
                const d = dims[i];
                if (d && d.width > 0 && d.height > 0) {
                    imagesData[idx] = {
                        width: d.width,
                        height: d.height,
                        aspectRatio: d.width / d.height
                    };
                }
            });
        }
        const order = priority ? resolvedIndices : [...pathMap.keys()].sort((a, b) =>
            Math.abs(a - center) - Math.abs(b - center));

        for (const idx of order) {
            const mediaPath = pathMap.get(idx);
            // Cached lookup – no full-track query per preload pass
            const mediaEl = mediaEls[idx];
            if (!mediaPath || !mediaEl) continue;
            if (mediaEl.tagName === 'IMG') {
                if (!needsLoad(mediaEl) || mediaEl.dataset.index !== String(idx)) continue;
            } else if (mediaEl.dataset.loaded) {
                continue;
            }

            const dist = Math.abs(idx - center);
            let taskPriority = priority ? (1000 - dist) : (100 - dist);
            if (idx === center || (priority && idx > center && idx <= center + 2)) {
                taskPriority += 2000;
            }

            const isVid = mediaEl.tagName === 'VIDEO';

            renderQueue.add(taskPriority, idx, async (abortToken) => {
                const taskEpoch = renderEpoch;

                if (isVid) {
                    if (mediaEl.dataset.loaded) return;
                    await smartLoadVideo(mediaEl, mediaPath, taskEpoch);
                    scheduleDisposeAfterLoad();
                } else {
                    const img = mediaEl;
                    if (!needsLoad(img)) return;

                    if (idx === 0) {
                        img.addEventListener('load', function clearThumbnailPlaceholder() {
                            img.removeEventListener('load', clearThumbnailPlaceholder);
                            const w = img.closest('.r-img > div');
                            if (w) { w.style.backgroundImage = ''; w.style.backgroundSize = ''; w.style.backgroundPosition = ''; w.style.backgroundRepeat = ''; }
                        });
                    }

                    await smartLoadImage(img, mediaPath, taskEpoch);

                    if (img.decode) {
                        try { await img.decode(); } catch (_) { }
                    }
                    scheduleDisposeAfterLoad();
                }
            });
        }
    }

    let lastPreloadCenter = 0;
    function preloadImagesAroundCurrent() {
        const currentEpoch = renderEpoch;
        let center = getCurrentCenterImageIndex();

        // Track scroll momentum to bias preloading direction
        let scrollDirection = (center >= lastPreloadCenter) ? 1 : -1;
        lastPreloadCenter = center;

        // Ensure the CURRENT spread (which could be 1 or 2 pages) is the absolute highest priority
        const currentSpread = getSpreadAt(currentIndex - 1) || [];
        let priorityIndices = currentSpread.map(s => s.index);

        const n = imageNames.length;

        // Next priority: The immediate adjacent spreads (Prev and Next). 
        // We calculate what makes up the previous and next spread explicitly.
        const prevSpreadTarget = currentIndex - 2; // Index before the start of current spread
        const nextSpreadTarget = currentIndex - 1 + currentSpread.length; // Index after current spread

        let prevSpreadIdxs = [];
        if (prevSpreadTarget >= 0) {
            const spreadPrev = getSpreadAt(prevSpreadTarget) || [];
            prevSpreadIdxs = spreadPrev.map(s => s.index);
        }

        let nextSpreadIdxs = [];
        if (nextSpreadTarget < n) {
            const spreadNext = getSpreadAt(nextSpreadTarget) || [];
            nextSpreadIdxs = spreadNext.map(s => s.index);
        }

        // Add them to priority queue: favor the scroll-direction's adjacent spread first
        const firstAdjacent = scrollDirection === 1 ? nextSpreadIdxs : prevSpreadIdxs;
        const secondAdjacent = scrollDirection === 1 ? prevSpreadIdxs : nextSpreadIdxs;

        firstAdjacent.forEach(idx => { if (!priorityIndices.includes(idx)) priorityIndices.push(idx); });
        secondAdjacent.forEach(idx => { if (!priorityIndices.includes(idx)) priorityIndices.push(idx); });

        // Dynamically shift the 15/5 preload buffer to match the user's scroll direction
        let effectivePrev = scrollDirection === 1 ? MAX_PREV : MAX_NEXT;
        let effectiveNext = scrollDirection === 1 ? MAX_NEXT : MAX_PREV;

        const minI = Math.max(0, center - effectivePrev);
        const maxI = Math.min(n - 1, center + effectiveNext);
        const restIndices = [];
        for (let i = minI; i <= maxI; i++) {
            if (!priorityIndices.includes(i)) restIndices.push(i);
        }

        /* 1) Load priority first */
        if (priorityIndices.length > 0) {
            const token = { get aborted() { return renderEpoch !== currentEpoch; } };
            archiveUtil.getImagePathsInRange(filePath, priorityIndices, token).then(pathMap => {
                applyPathMapToDom(pathMap, center, true);
            }).catch(() => { });
        }

        /* 2) Load rest of window in background */
        if (restIndices.length > 0) {
            const token = { get aborted() { return renderEpoch !== currentEpoch; } };
            archiveUtil.getImagePathsInRange(filePath, restIndices, token).then(pathMap => {
                applyPathMapToDom(pathMap, center, false);
            }).catch(() => { });
        }
    }

    function updateNav() {
        const canPrev = currentIndex > 1;
        const canNext = currentIndex < indexNum;
        btnPrev.disabled = !canPrev;
        btnNext.disabled = !canNext;
    }

    function go(delta) {
        const newIndex = Math.max(1, Math.min(currentIndex + delta, indexNum));
        if (newIndex === currentIndex) return;

        // Reset zoom if navigating between distinct pages (not needed for continuous scrolling)
        if (haveZoom && !continuous) resetZoom();

        /* Only flush pending render work if we are taking a massive scrubber jump.
           For rapid sequential clicks, we PRESERVE the queue so the background preloader
           isn't brutally aborted right before we land on the image it's preparing! */
        const actualDelta = newIndex - currentIndex;
        if (Math.abs(actualDelta) > 5) {
            renderQueue.clear();
            renderEpoch++;
        }

        clearTimeout(preloadTimer);

        const anim = !continuous;
        goToIndex(newIndex, anim);
        updatePageInfo();
        updateNav();
        savePosition();
        syncVideoPlayback();

        /* Debounce preloading: only fire 200ms after the last navigation event.
           During rapid key-holds this means work is queued only once the user stops. */
        if (continuous || !anim || pageTransitionMs === 0) {
            preloadTimer = setTimeout(preloadImagesAroundCurrent, 200);
        }
    }

    /**
     * Does this image still need loading?
     *
     * An empty src means it was never loaded or was purged. A `stale` marker
     * means it is loaded but at the wrong size for the current layout, so it
     * should be re-rendered — while continuing to show its existing pixels until
     * the replacement is decoded and ready to swap in.
     */
    function needsLoad(img) {
        return !img.src || img.dataset.stale === '1';
    }

    /**
     * Re-rendering only ever buys sharpness, never correctness — the layout is
     * pure CSS and follows the window on its own. A page is worth redoing only
     * when the box it has to fill has outgrown the pixels we rendered for it.
     * Below this ratio the difference is invisible, and re-rendering every page
     * for a one-pixel drag is pure waste.
     */
    const RERENDER_GROWTH_THRESHOLD = 1.05;

    /**
     * Mark pages whose current render is now too low-resolution for the space
     * they occupy, without clearing what is on screen.
     *
     * purgeRenderCache() empties every src, which is right for a layout-mode
     * switch — the whole track is being rebuilt — but wrong for a window resize.
     * Blanking a page that is being looked at leaves a visible hole for as long
     * as the re-decode takes, and every load path is guarded on `src` being
     * empty, so clearing it is otherwise the only way to make a page reload.
     * Marking instead lets smartLoadImage do its usual decode-then-swap, which
     * never shows an empty frame.
     *
     * Shrinking the window marks nothing: a render made for a bigger box still
     * has more pixels than the smaller one needs, and the GPU downscales it for
     * free. Pages already served at native resolution are never marked either,
     * since no re-render can add detail that is not in the file.
     *
     * Videos are deliberately untouched: object-fit rescales them for free, and
     * reloading one would restart playback on every resize event.
     *
     * @returns {number} how many pages were marked
     */
    function invalidateRenderedSizes() {
        const dpr = window.devicePixelRatio || 1;
        let marked = 0;

        for (let i = 0, len = mediaEls.length; i < len; i++) {
            const el = mediaEls[i];
            if (!el || el.tagName !== 'IMG' || !el.src) continue;

            const rendered = parseFloat(el.dataset.renderedW);
            // Unknown provenance (e.g. loaded before this bookkeeping existed):
            // re-render rather than risk leaving it blurry.
            if (!isNaN(rendered) && rendered > 0) {
                const required = getExpectedTargetWidth(i) * dpr;
                if (required <= rendered * RERENDER_GROWTH_THRESHOLD) continue;
            }
            el.dataset.stale = '1';
            marked++;
        }

        // Only disturb in-flight work if there is actually something to redo
        if (marked > 0) {
            renderQueue.clear();
            renderEpoch++;
        }
        return marked;
    }

    /** Drop every loaded media source so the new layout footprint is re-evaluated */
    function purgeRenderCache() {
        for (let i = 0, len = mediaEls.length; i < len; i++) {
            const el = mediaEls[i];
            if (!el) continue;
            if (el.tagName === 'VIDEO') {
                el.pause();
                el.removeAttribute('src'); // removeAttribute avoids empty-string resolving to page URL
                el.load();
                delete el.dataset.loaded; // Remove entirely so the guard check works cleanly
            } else {
                el.src = '';
                el.removeAttribute('src');
                el.dataset.hiRes = '';
                el.dataset.stale = ''; // empty src already means "needs loading"
            }
        }
        renderQueue.clear();
        renderEpoch++;
    }

    // View: pages per view (1/2) + continuous toggle
    function applyView() {
        syncViewMode();
        setSetting('pagesPerView', pagesPerView);
        setSetting('continuous', continuous ? 'true' : 'false');
        // Single button, icon carries the state (same pattern as the LTR/RTL toggle)
        const isDoubleView = pagesPerView === 2;
        if (pagesSingleIcon) pagesSingleIcon.classList.toggle('hide', isDoubleView);
        if (pagesDoubleIcon) pagesDoubleIcon.classList.toggle('hide', !isDoubleView);
        if (pagesToggle) {
            pagesToggle.title = isDoubleView
                ? 'Double page – click for single page'
                : 'Single page – click for double page';
        }
        if (continuousToggle) continuousToggle.classList.toggle('active', continuous);
        toolbar.classList.remove('scroll-mode', 'single-mode', 'double-mode');
        toolbar.classList.add(continuous ? 'scroll-mode' : (pagesPerView === 1 ? 'single-mode' : 'double-mode'));

        /* Reset cached width so goToIndex recalculates from fresh container dimensions */
        rightSize.width = 0;

        readingContainer.classList.remove('width-100', 'width-75', 'width-50', 'scroll-mode');
        if (continuous) {
            readingContainer.classList.add('scroll-mode', 'width-' + scrollWidth);
        } else {
            // Force reset native scroll state so horizontal layout doesn't render permanently off-screen
            readingContainer.scrollTop = 0;
            readingContainer.scrollLeft = 0;
        }

        updateIndexNum();
        if (!readingTrack.querySelector('.r-flex[data-index="0"]')) addHtmlImages();
        else {
            readingTrack.classList.toggle('track-has-gap', scrollGap);
        }

        // Major layout switches dramatically alter the required rendering footprint.
        // Purge all preloaded images so they request a fresh native re-rasterization 
        // at the new DOM dimensions via the intersection/preload workers.
        purgeRenderCache();

        disposeImages();
        calculateView(true);
        goToIndex(currentIndex, false);
        updatePageInfo();
        updateNav();
        savePosition();
        preloadImagesAroundCurrent();

        if (continuous) {
            readingContainer.removeEventListener('scroll', onScroll);
            readingContainer.addEventListener('scroll', onScroll, { passive: true });
        }
        /* Re-run layout after first frame so container has real size (fixes cover = full width in double on first open) */
        requestAnimationFrame(() => {
            if (!readingTrack.children.length) return;
            disposeImages();
            calculateView(true);
            goToIndex(currentIndex, false);
            if (haveZoom) applyScale(currentScale, false);
        });
    }
    function setPagesPerView(nVal) {
        const oldPv = pagesPerView;
        pagesPerView = nVal === 2 ? 2 : 1;

        if (oldPv !== pagesPerView) {
            const n = imageNames.length;
            if (pagesPerView === 2) {
                currentIndex = getSpreadForImage(n, currentIndex - 1) + 1;
            } else {
                const sp = getSpreadPages(n, currentIndex - 1);
                currentIndex = sp.idx1 + 1;
            }
        }

        resetZoom(); // Always wipe lingering native/transform DOM state explicitly
        applyView();
    }

    function setContinuous(on) {
        const oldCont = continuous;
        continuous = !!on;

        resetZoom(); // Always wipe lingering native/transform DOM state explicitly
        applyView();
    }
    // Scroll options
    function applyScrollOptions() {
        resetZoom();

        // Changing the container width strictly changes the expected image targets
        purgeRenderCache();

        readingContainer.classList.remove('width-100', 'width-75', 'width-50');
        if (continuous) readingContainer.classList.add('width-' + scrollWidth);
        if (readingTrack.children.length) {
            // Save scroll fraction before recalculating
            const scrollFrac = continuous && readingContainer.scrollHeight > 0
                ? readingContainer.scrollTop / readingContainer.scrollHeight
                : 0;
            disposeImages();
            calculateView(true);
            if (continuous) {
                // Restore to same proportional position
                readingContainer.scrollTop = scrollFrac * readingContainer.scrollHeight;
            }
        }
    }

    // Scroll options
    function setScrollGap(on) {
        scrollGap = on;
        setSetting('scrollGap', on ? 'true' : 'false');
        if (gapOnIcon) gapOnIcon.classList.toggle('hide', !on);
        if (gapOffIcon) gapOffIcon.classList.toggle('hide', on);
        if (scrollGapToggle) scrollGapToggle.title = on ? 'Gap between images (on)' : 'Gap (off)';
        readingTrack.classList.toggle('track-has-gap', scrollGap);
    }
    function setMangaRtl(on) {
        mangaRtl = on;
        setSetting('mangaRtl', on ? 'true' : 'false');
        if (dirLtrIcon) dirLtrIcon.classList.toggle('hide', on);
        if (dirRtlIcon) dirRtlIcon.classList.toggle('hide', !on);
        if (!continuous) {
            updatePageInfo();
            updateNav();
            disposeImages();
            calculateView(false);
            goToIndex(currentIndex, false);
        }
    }
    function setScrollNavEnabled(on) {
        scrollNavEnabled = on;
        setSetting('scrollNavEnabled', on ? 'true' : 'false');
        if (scrollNavToggle) scrollNavToggle.classList.toggle('scroll-nav-off', !on);
        if (mouseOnIcon) mouseOnIcon.classList.toggle('hide', !on);
        if (mouseOffIcon) mouseOffIcon.classList.toggle('hide', on);
    }
    function setPageTransitionSpeed(ms) {
        pageTransitionMs = ms;
        setSetting('pageTransitionSpeed', String(ms));
        if (transitionSpeedLabel) transitionSpeedLabel.textContent = ms === 0 ? '0' : (ms / 1000) + 's';
        if (transitionSpeedToggle) {
            transitionSpeedToggle.classList.toggle('instant', ms === 0);
            transitionSpeedToggle.title = ms === 0 ? 'Instant' : 'Slide ' + (ms / 1000) + 's';
        }
        if (!continuous && pagesPerView === 1) {
            readingTrack.classList.toggle('compact-layout', ms === 0);
            readingTrack.classList.toggle('slide-layout', ms !== 0);
            calculateView(true);
            goToIndex(currentIndex, false);
        }
    }

    // Zoom — unified scaling model
    const MIN_SCALE = 0.5;
    const MAX_SCALE = 8;
    let zoomTx = 0, zoomTy = 0;

    /**
     * Cached layout measurements for the zoom path.
     *
     * applyScale() and dragZoom() run on every mousemove of a zoom or pan drag.
     * Reading getBoundingClientRect() and especially readingTrack.scrollWidth
     * there forces a synchronous layout of the whole track on each event, which
     * is what made rapid zoom drags stutter. These are refreshed whenever the
     * layout actually changes instead.
     */
    let cachedTrackScrollWidth = 0;
    /** Any animated image currently in the track? Avoids a per-event DOM query. */
    let hasAnimatedImages = false;

    function refreshZoomMetrics() {
        cachedTrackScrollWidth = readingTrack.scrollWidth;
    }

    /**
     * Viewport box, without forcing a layout when the size is already known.
     * calculateView() records it in rightSize on every layout change, so the
     * per-mousemove zoom path can read that instead of calling
     * getBoundingClientRect() on every event.
     */
    function viewportRect() {
        if (rightSize.width > 0 && rightSize.height > 0) {
            return { width: rightSize.width, height: rightSize.height };
        }
        const r = readingContainer.getBoundingClientRect();
        return { width: r.width, height: r.height };
    }

    /**
     * Opt-in zoom profiler.
     *
     * Run `cbzProfileZoom()` in the console, do one zoom drag, and it reports
     * where the time actually went: how long applyScale took per event, how many
     * frames were dropped, and any long task the browser recorded. Guessing at
     * compositor behaviour from symptoms is unreliable — this measures it.
     */
    let profiling = null;
    window.cbzProfileZoom = function (seconds) {
        const dur = (seconds || 8) * 1000;
        profiling = { applyScale: [], frames: [], longTasks: [], started: performance.now() };

        let lastFrame = performance.now();
        const onFrame = () => {
            if (!profiling) return; // run ended between frames
            const now = performance.now();
            profiling.frames.push(now - lastFrame);
            lastFrame = now;
            requestAnimationFrame(onFrame);
        };
        requestAnimationFrame(onFrame);

        let observer = null;
        try {
            observer = new PerformanceObserver(list => {
                for (const entry of list.getEntries()) profiling.longTasks.push(Math.round(entry.duration));
            });
            observer.observe({ entryTypes: ['longtask'] });
        } catch (_) { }

        console.log('[cbz-reader] profiling zoom for ' + (dur / 1000) + 's — do a zoom drag now');
        setTimeout(() => {
            const p = profiling;
            profiling = null;
            if (observer) try { observer.disconnect(); } catch (_) { }

            const stat = arr => {
                if (!arr.length) return 'none';
                const s = [...arr].sort((a, b) => a - b);
                const sum = s.reduce((a, b) => a + b, 0);
                return 'n=' + s.length +
                    ' avg=' + (sum / s.length).toFixed(1) + 'ms' +
                    ' p50=' + s[Math.floor(s.length * 0.5)].toFixed(1) +
                    ' p95=' + s[Math.floor(s.length * 0.95)].toFixed(1) +
                    ' max=' + s[s.length - 1].toFixed(1);
            };
            const dropped = p.frames.filter(f => f > 25).length;
            console.log('[cbz-reader] ── zoom profile ──');
            console.log('  applyScale : ' + stat(p.applyScale));
            console.log('  frame gaps : ' + stat(p.frames) +
                '   (' + dropped + ' of ' + p.frames.length + ' over 25ms)');
            console.log('  long tasks : ' + (p.longTasks.length
                ? p.longTasks.length + ' — ' + p.longTasks.join(', ') + ' ms'
                : 'none recorded'));
            console.log('  scale now  : ' + currentScale.toFixed(2) +
                '   page ' + currentIndex + '/' + indexNum +
                '   mode ' + (continuous ? 'scroll' : pagesPerView + '-page'));
        }, dur);
    };

    // Helper: get unscaled track height from math-based positions (no DOM read)
    function getUnscaledTrackHeight() {
        const n = imageNames.length;
        if (n > 0 && imagesFullPosition[n - 1]) {
            return imagesFullPosition[n - 1].bottom;
        }
        // Fallback: compute from last DOM element (only if positions not built yet)
        const last = readingTrack.lastElementChild;
        return last ? (last.offsetTop + last.offsetHeight) : readingContainer.clientHeight;
    }

    function applyScale(scale, animation, focalX, focalY) {
        const _t0 = profiling ? performance.now() : 0;
        try {
            applyScaleInner(scale, animation, focalX, focalY);
        } finally {
            if (profiling) profiling.applyScale.push(performance.now() - _t0);
        }
    }

    function applyScaleInner(scale, animation, focalX, focalY) {
        const prevScale = currentScale;
        currentScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale));
        haveZoom = currentScale !== 1;

        readingContainer.style.overflowX = 'hidden';
        readingContainer.style.overflowY = continuous ? 'auto' : 'hidden';

        if (!haveZoom) {
            zoomTx = 0; zoomTy = 0;
            scalePrevData = { tranX: 0, tranX2: 0, tranY: 0, tranY2: 0, scale: 1 };
        }
        if (zoomResetBtn) {
            const label = currentScale === 1 ? '1\u00d7' : currentScale.toFixed(1) + '\u00d7';
            zoomResetBtn.title = `Zoom: ${label} (Click to reset)`;
        }

        const rect = viewportRect();
        const fX = focalX !== undefined ? focalX : rect.width / 2;
        const fY = focalY !== undefined ? focalY : rect.height / 2;

        if (continuous) {
            const scrollBefore = readingContainer.scrollTop;

            // Y: scrollbar handles vertical focal placement.
            const absY = (scrollBefore + fY) / prevScale;
            const newAbsY = absY * currentScale;

            // X: transform handles horizontal offset.
            // Two-path algorithm (adapted from OpenComic):
            //
            // ZOOM IN  → focal-point math: shift zoomTx so the pixel under the cursor stays fixed.
            //   addX = distance from viewport center to focal point (signed, in content-space).
            //   The new offset accumulates the previous offset (rescaled up) plus the focal contribution.
            //
            // ZOOM OUT → proportional scale-down: as scale shrinks toward 1, zoomTx shrinks toward 0.
            //   Formula: prevTx * (scale - 1) / (prevScale - 1).
            //   At scale=1 the numerator is 0, so zoomTx converges to 0 with no snap.
            //
            // Both paths are then clamped by notCrossZoomLimitsX which returns 0 when the image
            // fits the viewport (no overflow) and ±maxTx when it overflows — so pan locking and
            // pan panning are handled by the same clamping step, never by a hard if/else snap.

            const zoomingOut = currentScale < prevScale;

            if (prevScale !== currentScale && prevScale > 0) {
                if (!zoomingOut) {
                    // Focal-point zoom-in: addX is horizontal distance (in layout-space) from center to cursor
                    const addX = (rect.width / 2 - fX); // positive = cursor left of center → shift right
                    zoomTx = (zoomTx / prevScale * currentScale) + (addX / prevScale * (currentScale - prevScale));
                } else {
                    // Proportional zoom-out: shrink offset back toward 0 as scale shrinks toward 1
                    const denom = prevScale - 1;
                    zoomTx = denom > 0 ? zoomTx * (currentScale - 1) / denom : 0;
                }
            }

            // Content-aware clamp: maxTx = half of the overflow beyond viewport width.
            // When image fits (scaledW <= viewportW) → maxTx = 0 → zoomTx forced to 0, no snap.
            // When image overflows → pan is allowed up to the image edge.
            const scaledW = cachedTrackScrollWidth * currentScale;
            const rawMaxTx = (scaledW - rect.width) / 2;
            const maxTx = Math.max(0, rawMaxTx);
            zoomTx = Math.max(-maxTx, Math.min(maxTx, zoomTx));

            if (prevScale !== currentScale && prevScale > 0) {
                scalePrevData.tranX2 = zoomTx;
                scalePrevData.tranY2 = zoomTy;
            }

            // Clear any paged mode zoom
            readingBody.style.transition = 'none';
            readingBody.style.transform = '';

            // Explicitly stretch the layout container so the native scrollbar physically matches the visual CSS zoom geometry
            readingBody.style.height = (unscaledTrackHeight * currentScale) + 'px';

            readingTrack.style.transition = animation ? 'transform 0.2s cubic-bezier(0.2, 0, 0.2, 1)' : 'none';
            // Anchor horizontal scaling to center (50%) to match the addX/center focal math.
            // Vertical scaling anchors to top (0); scrollbar handles the vertical focal placement.
            readingTrack.style.transformOrigin = '50% 0';

            // Translate FIRST so panning is 1:1 with mouse movement regardless of scale factor.
            readingTrack.style.transform = `translate3d(${zoomTx}px, 0, 0) scale(${currentScale})`;

            // Snap the scrollbar down so the focal point stays under the cursor
            readingContainer.scrollTop = newAbsY - fY;
        } else {
            // Paged mode scales outwards from the very center of the viewport

            // Unscaled distance from center to finger/mouse
            const cx = rect.width / 2;
            const cy = rect.height / 2;

            const vecX = (fX - cx - zoomTx) / prevScale;
            const vecY = (fY - cy - zoomTy) / prevScale;

            // When scaling up, points move further from center. We shift the other way to pin them.
            if (prevScale !== currentScale && prevScale > 0) {
                zoomTx = zoomTx - vecX * (currentScale - prevScale);
                zoomTy = zoomTy - vecY * (currentScale - prevScale);
            }

            // Absolutely NO bounds clamping during scale application!
            // If we clamp here, the focal point math is broken because the image shifts away from the mouse cursor.
            // This guarantees the point under your cursor stays exactly under your cursor, regardless of image size or aspect ratio.

            if (prevScale !== currentScale && prevScale > 0) {
                scalePrevData.tranX2 = zoomTx;
                scalePrevData.tranY2 = zoomTy;
            }

            readingBody.style.transition = animation ? `transform ${pageTransitionMs / 1000}s` : 'transform 0s';
            // Origin center natively tracks exactly the viewport center without needing track offsets
            readingBody.style.transformOrigin = 'center center';
            readingBody.style.transform = currentScale === 1
                ? ''
                : `translate(${zoomTx}px, ${zoomTy}px) scale(${currentScale})`;

            readingBody.style.height = '100%';
        }

        // --- Hardware Rasterization Kick for Animated Images ---
        // The compositor texture that blurs on zoom is on readingTrack, not on .r-flex.
        //
        // In PAGED mode: readingBody gets scale(N) for zoom; readingTrack is a child that has its
        //   own compositor layer (CSS: will-change: transform on .slide-layout). When readingBody is
        //   zoomed, Chromium simply magnifies readingTrack's existing frozen texture → blurry.
        //
        // In CONTINUOUS mode: the zoom scale is applied directly on readingTrack.style.transform.
        //   Same problem — readingTrack's own layer is frozen and just scaled up.
        //
        // Fix (per Chrome docs): temporarily remove will-change from readingTrack BEFORE the scale
        //   is committed to the compositor. Without will-change, Chrome re-rasterizes the layer at
        //   the new effective display resolution instead of stretching the frozen bitmap.
        //   Re-add will-change in a double-RAF so that subsequent smooth panning still uses the GPU.
        //
        // Only run when scale actually changes (not on pan-only calls) and not during a navigation
        // slide animation (where readingTrack needs its compositor layer for smooth 60fps scrolling).
        if (prevScale !== currentScale) {
            if (hasAnimatedImages && !slideAnimationRaf) {
                readingTrack.style.willChange = 'auto'; // Override CSS will-change: transform → de-freeze layer
                readingBody.style.willChange = 'auto';  // Also clear readingBody in case it was promoted too
                void readingTrack.offsetHeight;         // Synchronous layout flush → forces repaint at new scale

                // Re-promote to compositor in the second frame so panning after zoom stays smooth.
                // Frame 1: de-promoted repaint is committed to the compositor.
                // Frame 2: will-change re-instated — subsequent drags benefit from compositor panning.
                requestAnimationFrame(() => {
                    requestAnimationFrame(() => {
                        readingTrack.style.willChange = ''; // Remove override → CSS will-change: transform takes back over
                        readingBody.style.willChange = '';
                    });
                });
            }
        }

        contentEl.classList.toggle('zoomed', haveZoom);
        if (!rightDrag && !zoomMoveData.active) {
            scheduleHiResRender();
        }
    }

    /** After zoom settles, re-render the visible pages at higher resolution */
    let hiResTimer = 0;
    /** Bumped when zoom changes or a new hi-res pass starts — stale swaps bail out. */
    let hiResGeneration = 0;
    const HI_RES_DEBOUNCE_MS = 80;

    /**
     * De-promote readingTrack/readingBody from their compositor layer just long
     * enough for a hi-res swap to repaint at the current effective resolution,
     * then re-promote.
     *
     * Coalesced across the whole hi-res pass rather than toggled per-image: in
     * double-page mode the two pages finish their resize at different times
     * (decode cost depends on each page's own size/complexity), and toggling
     * these shared ancestors independently for each one means page A's swap
     * forces a second, later repaint of page B too — a page that was already
     * sharp and didn't need one. That second, out-of-sync repaint is what turns
     * a single settle into two, which is what a jiggle looks like. Reusing one
     * detach/reattach window for every swap that lands within a couple of
     * frames of each other keeps it to one repaint per pass.
     */
    let trackDetachedForHiRes = false;
    let trackReattachRaf1 = 0;
    let trackReattachRaf2 = 0;
    function detachTrackForHiResSwap() {
        if (!trackDetachedForHiRes) {
            trackDetachedForHiRes = true;
            readingTrack.style.willChange = 'auto';
            readingBody.style.willChange = 'auto';
        }
        cancelAnimationFrame(trackReattachRaf1);
        cancelAnimationFrame(trackReattachRaf2);
        trackReattachRaf1 = requestAnimationFrame(() => {
            trackReattachRaf2 = requestAnimationFrame(() => {
                trackDetachedForHiRes = false;
                readingTrack.style.willChange = '';
                readingBody.style.willChange = '';
            });
        });
    }

    /**
     * Promote a decoded hi-res frame into the visible <img> without a synchronous
     * layout flush. offsetHeight during swap was a major source of drag stutter
     * and occasional post-zoom nudges when the track was re-measured mid-gesture.
     */
    function commitHiResImage(img, url) {
        const wrap = img.closest('.r-img > div');
        if (wrap) {
            const w = wrap.style.width;
            const h = wrap.style.height;
            if (w) img.style.width = w;
            if (h) img.style.height = h;
            img.style.objectFit = 'fill';
        }

        const rFlex = img.closest('.r-flex');
        if (rFlex) rFlex.style.willChange = 'auto';
        detachTrackForHiResSwap();

        img.src = url;

        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                if (rFlex) rFlex.style.willChange = '';
            });
        });
    }

    function scheduleHiResRender(immediate) {
        clearTimeout(hiResTimer);
        if (currentScale <= 1) {
            revertHiRes();
            return;
        }
        // Heavy decode/resize during an active drag competes with compositor zoom
        // and replays the debounce on every mousemove pause — defer until release.
        if (!immediate && (rightDrag || zoomMoveData.active)) {
            return;
        }

        const gen = ++hiResGeneration;
        const delay = immediate ? 0 : HI_RES_DEBOUNCE_MS;
        hiResTimer = setTimeout(() => {
            if (rightDrag || zoomMoveData.active) return;
            runHiResRender(gen);
        }, delay);
    }

    function runHiResRender(gen) {
        const spread = getSpreadAt(currentIndex - 1);
        if (!spread) return;

        const scaleAtRun = currentScale;

        spread.forEach(p => {
            const idx = p.index;
            const img = mediaEls[idx];
            if (!img || img.tagName !== 'IMG' || img.dataset.animated === '1') return;

            const wrap = img.closest('.r-img > div');
            const explicitW = wrap ? parseInt(wrap.style.width, 10) : 0;
            const displayW = explicitW > 0 ? explicitW : (wrap ? wrap.getBoundingClientRect().width / currentScale : 0);
            if (displayW <= 0) return;

            const dpr = window.devicePixelRatio || 1;
            const d = imagesData[idx];
            const nativeCap = (d && d.width > 0) ? d.width / displayW : Infinity;
            const targetScale = Math.min(scaleAtRun * dpr, nativeCap);
            if (targetScale <= dpr * 1.1) return;

            // Sharp resizes natively (no browser canvas/WebCodecs memory ceiling to
            // clamp for), so the target pixel width is used as computed.
            const targetPixelWidth = Math.round(displayW * targetScale);

            const startedAt = performance.now();
            renderPageAtWidthShared(idx, targetPixelWidth)
                .then(async res => {
                    if (gen !== hiResGeneration || currentScale <= 1) return;
                    if (Math.abs(currentScale - scaleAtRun) > 0.15) return;
                    if (!res) return;

                    if (img.src === res.url) {
                        img.dataset.hiRes = '1';
                        return;
                    }

                    let preloadWidth = 0, preloadHeight = 0;
                    try {
                        const preload = new Image();
                        preload.src = res.url;
                        await preload.decode();
                        preloadWidth = preload.naturalWidth;
                        preloadHeight = preload.naturalHeight;

                        if (gen !== hiResGeneration) return;
                        if (img.dataset.index !== String(idx) || currentScale <= 1) return;

                        img.dataset.hiRes = '1';
                        commitHiResImage(img, preload.src);
                    } catch (err) {
                        console.warn('[cbz-reader] hi-res decode failed for page ' + idx + ':', err);
                    }

                    console.debug('[cbz-reader] hi-res page ' + idx + ': asked ' +
                        targetPixelWidth + 'px, got ' + (res.native ? 'original file' : 'scaled copy') +
                        ' ' + preloadWidth + 'x' + preloadHeight +
                        ' in ' + Math.round(performance.now() - startedAt) + 'ms');
                })
                .catch(err => {
                    console.warn('[cbz-reader] hi-res render failed for page ' + idx + ':', err);
                });
        });
    }

    function revertHiRes() {
        for (let idx = 0, len = mediaEls.length; idx < len; idx++) {
            const img = mediaEls[idx];
            if (!img || img.tagName !== 'IMG' || img.dataset.hiRes !== '1') continue;
            img.dataset.hiRes = '';

            archiveUtil.getImagePath(filePath, idx).then(fp => {
                // Re-render at display size; the result is disk-cached, so this is
                // usually just a file read rather than another resize.
                if (fp && img.dataset.index === String(idx) && currentScale <= 1) {
                    smartLoadImage(img, fp);
                }
            }).catch(() => { });
        }
    }

    /* Stepped zoom buttons were removed from the toolbar — right-click drag is the
       zoom gesture, matching Eagle's own image viewer. applyScale() remains the
       entry point if a keyboard or button zoom is ever wanted again. */

    function resetZoom() {
        currentScale = 1;
        scalePrevData = { tranX: 0, tranX2: 0, tranY: 0, tranY2: 0, scale: 1 };
        zoomTx = 0; zoomTy = 0;

        readingContainer.style.overflowX = 'hidden';
        readingContainer.style.overflowY = continuous ? 'auto' : 'hidden';

        readingBody.style.transform = '';
        readingBody.style.transition = '';

        // Remove hardcoded inline limits so the generic .scroll-mode CSS logic
        // takes over and rebuilds the scrollbar track properly in continuous view!
        readingBody.style.height = '';
        readingBody.style.transformOrigin = '';
        applyScale(1, false);
    }

    function dragZoom(dx, dy) {
        zoomTx = scalePrevData.tranX2 + dx;
        const rect = viewportRect();

        if (continuous) {
            // Same content-aware clamping as applyScale: lock to center when image fits,
            // allow panning up to the image edge when it overflows the viewport.
            const scaledW = cachedTrackScrollWidth * currentScale;
            const maxTx = Math.max(0, (scaledW - rect.width) / 2);
            zoomTx = Math.max(-maxTx, Math.min(maxTx, zoomTx));
        } else {
            const looseMaxTx = (rect.width * currentScale);
            zoomTx = Math.max(-looseMaxTx, Math.min(looseMaxTx, zoomTx));

            zoomTy = scalePrevData.tranY2 + dy;
            const looseMaxTy = (rect.height * currentScale);
            zoomTy = Math.max(-looseMaxTy, Math.min(looseMaxTy, zoomTy));
        }

        applyScale(currentScale, false); // no focal points, avoid triggering scale math
    }

    function dragZoomEnd() {
        scalePrevData.tranX2 = zoomTx;
        if (!continuous) {
            scalePrevData.tranY2 = zoomTy;
        }
        zoomMoveData.active = false;
    }

    /** Momentum / inertia scrolling for vertical drag release */
    let momentumRaf = 0;
    function momentumScroll(velocity) {
        cancelAnimationFrame(momentumRaf);
        const friction = 0.95;
        const step = () => {
            velocity *= friction;
            if (Math.abs(velocity) < 0.5) return;
            readingContainer.scrollTop += velocity;
            momentumRaf = requestAnimationFrame(step);
        };
        momentumRaf = requestAnimationFrame(step);
    }

    // Events
    if (pageSlider) {
        pageSlider.addEventListener('input', e => {
            const val = parseInt(e.target.value, 10);
            if (pageCurrentLabel) {
                if (pagesPerView === 2) {
                    const n = imageNames.length;
                    const sp = getSpreadPages(n, val - 1);
                    if (sp.idx2 != null) pageCurrentLabel.textContent = (sp.idx1 + 1) + '-' + (sp.idx2 + 1);
                    else pageCurrentLabel.textContent = (sp.idx1 + 1);
                } else {
                    pageCurrentLabel.textContent = val;
                }
            }
        });
        pageSlider.addEventListener('change', e => {
            const targetIndex = parseInt(e.target.value, 10);
            const offset = targetIndex - currentIndex;
            if (offset !== 0) go(offset);
        });
    }

    btnPrev.addEventListener('click', () => go(-1));
    btnNext.addEventListener('click', () => go(1));
    if (pagesToggle) pagesToggle.addEventListener('click', () => setPagesPerView(pagesPerView === 2 ? 1 : 2));
    if (continuousToggle) continuousToggle.addEventListener('click', () => setContinuous(!continuous));
    if (scrollGapToggle) scrollGapToggle.addEventListener('click', () => setScrollGap(!scrollGap));
    if (mangaRtlBtn) mangaRtlBtn.addEventListener('click', () => setMangaRtl(!mangaRtl));
    if (scrollNavToggle) scrollNavToggle.addEventListener('click', () => setScrollNavEnabled(!scrollNavEnabled));
    if (transitionSpeedToggle) transitionSpeedToggle.addEventListener('click', () => setPageTransitionSpeed(pageTransitionMs === 0 ? 300 : 0));

    if (contentEl) {
        contentEl.addEventListener('selectstart', e => e.preventDefault());
        contentEl.addEventListener('wheel', e => {
            if (continuous) return;
            if (!scrollNavEnabled) return;
            e.preventDefault();
            go(e.deltaY > 0 ? 1 : -1);
        }, { passive: false });

        // Custom per-image context menu (replaces default browser menu)
        contentEl.addEventListener('contextmenu', onImageContextMenu);

        // Mouse drag handlers
        contentEl.addEventListener('mousedown', e => {
            if (e.button === 2) {
                // Right-click drag → zoom
                e.preventDefault();
                clearTimeout(hiResTimer);
                hiResGeneration++;
                // Measure the container once, here, so the mousemove handler never has to
                const box = readingContainer.getBoundingClientRect();
                rightDrag = {
                    startX: e.clientX, startY: e.clientY, startScale: currentScale,
                    focalX: e.clientX - box.left, focalY: e.clientY - box.top,
                };
                contentEl.classList.add('dragging');
            } else if (e.button === 0) {
                // Left-click drag → navigate (or pan when zoomed)
                if (haveZoom) {
                    // Pan zoomed view
                    e.preventDefault();
                    zoomMoveData = {
                        x: e.clientX,
                        y: e.clientY,
                        active: true,
                        startScroll: readingContainer.scrollTop,
                        velocityHistory: []
                    };
                    contentEl.classList.add('dragging');
                } else if (!continuous && pageTransitionMs === 0) {
                    // Instant mode: no drag, just track clicks for navigation
                    dragNav = {
                        startX: e.clientX,
                        startY: e.clientY,
                        startTx: slideCurrentTx || 0,
                        startScrollTop: readingContainer.scrollTop,
                        moved: false,
                    };
                } else {
                    // Drag to navigate
                    cancelAnimationFrame(momentumRaf); // stop any ongoing momentum
                    dragNav = {
                        startX: e.clientX,
                        startY: e.clientY,
                        startTx: slideCurrentTx || 0,
                        startScrollTop: readingContainer.scrollTop,
                        moved: false,
                    };
                    contentEl.classList.add('dragging');
                }
            }
        });

        window.addEventListener('mousemove', e => {
            if (rightDrag) {
                // Right-drag zoom: up = zoom in, down = zoom out
                const dy = rightDrag.startY - e.clientY;
                const newScale = rightDrag.startScale * Math.pow(1.005, dy);

                // The focal point is fixed for the whole gesture, so its offset was
                // measured once on mousedown — re-reading the container box on every
                // mousemove would force a layout mid-drag.
                applyScale(newScale, false, rightDrag.focalX, rightDrag.focalY);
            } else if (zoomMoveData.active) {
                // Left-drag pan (zoomed)
                e.preventDefault();
                const dx = e.clientX - zoomMoveData.x;
                const dy = e.clientY - zoomMoveData.y;
                if (continuous) {
                    readingContainer.scrollTop = zoomMoveData.startScroll - dy;
                    const now = performance.now();
                    zoomMoveData.velocityHistory.push({ t: now, y: e.clientY });
                    if (zoomMoveData.velocityHistory.length > 5) zoomMoveData.velocityHistory.shift();
                }
                dragZoom(dx, dy);
            } else if (dragNav) {
                const dx = e.clientX - dragNav.startX;
                const dy = e.clientY - dragNav.startY;
                const maxDiff = Math.max(Math.abs(dx), Math.abs(dy));
                if (maxDiff > 5) dragNav.moved = true;

                if (!continuous && pageTransitionMs > 0) {
                    // Paged: drag the track horizontally with elastic resistance at boundaries
                    const dir = mangaRtl ? -dx : dx;
                    const atStart = currentIndex <= 1 && dir > 0;
                    const atEnd = currentIndex >= indexNum && dir < 0;
                    let effectiveDx = dx;
                    if (atStart || atEnd) {
                        // Rubber-band: reduce movement to 30% beyond boundary
                        effectiveDx = dx * 0.3;
                    }

                    // The physical translation of the track should always match the mouse vector exactly 
                    // (if you drag your mouse 100px right, the track must physically shift 100px right)
                    // We only invert `dir` for calculating if we hit the elastic boundary.
                    const offset = dragNav.startTx + effectiveDx;
                    readingTrack.style.transition = 'none';
                    readingTrack.style.transform = `translateX(${offset}px)`;
                } else if (!continuous) {
                    // Instant mode: don't physically drag, only track moved state
                } else {
                    // Scroll: drag vertically + track velocity for momentum
                    readingContainer.scrollTop = dragNav.startScrollTop - dy;
                    const now = performance.now();
                    if (!dragNav.velocityHistory) dragNav.velocityHistory = [];
                    dragNav.velocityHistory.push({ t: now, y: e.clientY });
                    // Keep only last 5 samples for velocity calculation
                    if (dragNav.velocityHistory.length > 5)
                        dragNav.velocityHistory.shift();
                }
            }
        });

        window.addEventListener('mouseup', e => {
            if (rightDrag) {
                const dx = e.clientX - rightDrag.startX;
                const dy = e.clientY - rightDrag.startY;
                rightDragUsed = Math.abs(dx) > 3 || Math.abs(dy) > 3;

                rightDrag = null;
                contentEl.classList.remove('dragging');
                if (Math.abs(currentScale - 1) < 0.05) resetZoom();
                else scheduleHiResRender(true);
            } else if (zoomMoveData.active) {
                if (continuous) {
                    const hist = zoomMoveData.velocityHistory;
                    if (hist && hist.length >= 2) {
                        const last = hist[hist.length - 1];
                        const first = hist[0];
                        const dt = last.t - first.t;
                        if (dt > 0 && dt < 300) {
                            const vy = -(last.y - first.y) / dt * 16;
                            momentumScroll(vy);
                        }
                    }
                }
                dragZoomEnd();
                contentEl.classList.remove('dragging');
                scheduleHiResRender(true);
            } else if (dragNav) {
                const wasDrag = dragNav.moved;
                contentEl.classList.remove('dragging');

                if (!wasDrag) {
                    // Click (no drag): navigate based on screen zone (25% left, 50% deadzone, 25% right)
                    if (e.button === 0) {
                        const width = window.innerWidth;
                        if (e.clientX < width * 0.25) {
                            go(mangaRtl ? 1 : -1);
                        } else if (e.clientX > width * 0.75) {
                            go(mangaRtl ? -1 : 1);
                        }
                    }
                } else if (!continuous) {
                    // Paged: snap to nearest page (with boundary awareness)
                    const dx = e.clientX - dragNav.startX;
                    const threshold = readingContainer.getBoundingClientRect().width * 0.05;
                    const dir = mangaRtl ? -dx : dx;
                    if (dir < -threshold && currentIndex < indexNum) go(1);
                    else if (dir > threshold && currentIndex > 1) go(-1);
                    else goToIndex(currentIndex, true); // snap back
                } else if (wasDrag) {
                    // Scroll: apply momentum
                    const hist = dragNav.velocityHistory;
                    if (hist && hist.length >= 2) {
                        const last = hist[hist.length - 1];
                        const first = hist[0];
                        const dt = last.t - first.t;
                        if (dt > 0 && dt < 300) {
                            const vy = -(last.y - first.y) / dt * 16; // px per frame
                            momentumScroll(vy);
                        }
                    }
                }
                dragNav = null;
            }
        });

        // Cancel all drags when mouse leaves reader or window loses focus
        function cancelAllDrags() {
            if (rightDrag) {
                rightDrag = null;
                contentEl.classList.remove('dragging');
                if (Math.abs(currentScale - 1) < 0.05) resetZoom();
                else scheduleHiResRender(true);
            }
            if (zoomMoveData.active) {
                dragZoomEnd();
                contentEl.classList.remove('dragging');
            }
            if (dragNav) {
                if (!continuous && dragNav.moved) {
                    goToIndex(currentIndex, false); // snap back
                }
                contentEl.classList.remove('dragging');
                dragNav = null;
            }
        }
        document.addEventListener('mouseleave', cancelAllDrags);
        window.addEventListener('blur', cancelAllDrags);
    }

    if (zoomResetBtn) zoomResetBtn.addEventListener('click', () => resetZoom());

    document.addEventListener('keydown', e => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
        if (mangaRtl && !continuous) {
            if (e.key === 'ArrowLeft') { e.preventDefault(); go(1); }
            if (e.key === 'ArrowRight') { e.preventDefault(); go(-1); }
        } else {
            if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
            if (e.key === 'ArrowRight') { e.preventDefault(); go(1); }
        }
    });

    /**
     * Re-render at the new window size, once the user stops dragging.
     *
     * Split from the layout work below on purpose. A drag-resize fires `resize`
     * continuously, and re-rasterising every page on every one of those events
     * is both wasteful and self-defeating — each pass cancels the last via
     * renderEpoch, so a slow drag could leave nothing finished. Layout stays
     * immediate so the page keeps tracking the window; only the expensive
     * re-render waits for things to settle.
     */
    let resizeRenderTimer = 0;
    const RESIZE_SETTLE_MS = 180;

    window.addEventListener('resize', () => {
        if (!readingTrack.children.length) return;

        // Where the reader is, captured before the layout moves under them
        const anchor = captureScrollAnchor();

        // Immediate: keep the layout correct while the window is being dragged.
        // Existing pixels are simply scaled by CSS in the meantime.
        disposeImages();
        calculateView(false);

        if (anchor) {
            // Continuous: hold the exact reading position. goToIndex would jump
            // to the top of the current page, which on a tall webtoon strip can
            // throw away several screens of progress for a one-pixel drag.
            restoreScrollAnchor(anchor);
        } else {
            // Paged: reposition the horizontal track on the active spread
            goToIndex(currentIndex, false);
        }

        // Zoom survives a resize. The pan offset is in layout pixels, so a new
        // viewport can put it out of range; re-applying the same scale runs the
        // clamp in applyScale against the new bounds and re-commits the
        // transform. Dropping to 1x instead — which is what this used to do —
        // threw away the reader's position for a one-pixel drag.
        if (haveZoom) applyScale(currentScale, false);

        // Deferred: re-render anything the resize left under-resolved.
        //
        // The preload call is the fix for pages vanishing on resize. Marking
        // alone is not enough: the IntersectionObserver only reacts to
        // intersection *changes*, and a page that was visible before the resize
        // is still visible after it, so nothing would ever ask for it again.
        clearTimeout(resizeRenderTimer);
        resizeRenderTimer = setTimeout(() => {
            if (!readingTrack.children.length) return;
            if (invalidateRenderedSizes() === 0) return; // nothing gained by redoing anything
            preloadImagesAroundCurrent();
        }, RESIZE_SETTLE_MS);
    });

    window.addEventListener('beforeunload', () => {
        savePositionImmediate();
        // Pass the token so we only tear down the session we actually opened
        archiveUtil.cleanup(filePath, sessionToken);
    });

    // ── Per-image context menu ──────────────────────────────────────────

    function getImageIndexFromEvent(e) {
        let el = e.target;
        while (el && el !== contentEl) {
            if (el.classList && el.classList.contains('r-flex') && el.dataset.index !== undefined) {
                return parseInt(el.dataset.index, 10);
            }
            el = el.parentElement;
        }
        return -1;
    }

    function getPageLabel(idx) {
        const name = imageNames[idx] || '';
        const basename = name.replace(/^.*[\\/]/, '');
        return `Page ${idx + 1} – ${basename}`;
    }

    async function unpackImage(idx) {
        try {
            const fp = await archiveUtil.getImagePath(filePath, idx);
            if (!fp) throw new Error('Image not extracted');
            const item = fileId ? await eagle.item.getById(fileId) : null;
            const basename = (imageNames[idx] || 'image').replace(/^.*[\\/]/, '');
            const cbzBasename = pathModule.basename(filePath, pathModule.extname(filePath));
            const name = `${cbzBasename} - ${pathModule.basename(basename, pathModule.extname(basename))}`;
            const opts = {};
            if (item) {
                if (item.tags && item.tags.length) opts.tags = item.tags;
                if (item.folders && item.folders.length) opts.folders = item.folders;
            }
            await eagle.item.addFromPath(fp, { name, ...opts });
            eagle.notification.show({ duration: 3000, title: 'Image Unpacked', body: getPageLabel(idx) });
        } catch (err) {
            console.error('Unpack failed:', err);
            eagle.notification.show({ duration: 3000, title: 'Unpack Failed', body: err.message });
        }
    }

    async function setAsThumbnail(idx) {
        try {
            const fp = await archiveUtil.getImagePath(filePath, idx);
            if (!fp) throw new Error('Image not extracted');
            if (!fileId) throw new Error('No file ID');
            const item = await eagle.item.getById(fileId);
            await item.setCustomThumbnail(fp);
            eagle.notification.show({ duration: 3000, title: 'Thumbnail Updated', body: getPageLabel(idx) });
        } catch (err) {
            console.error('Set thumbnail failed:', err);
            eagle.notification.show({ duration: 3000, title: 'Thumbnail Failed', body: err.message });
        }
    }

    async function saveImage(idx) {
        try {
            const fp = await archiveUtil.getImagePath(filePath, idx);
            if (!fp) throw new Error('Image not extracted');

            const basename = (imageNames[idx] || 'image').replace(/^.*[\\/]/, '');
            const cbzBasename = pathModule.basename(filePath, pathModule.extname(filePath));
            const defaultName = `${cbzBasename} - ${basename}`;

            const options = {
                title: 'Save Image',
                defaultPath: defaultName
            };

            const res = await eagle.dialog.showSaveDialog(options);
            const savePath = typeof res === 'string' ? res : (res && res.filePath);
            if (savePath) {
                const fs = require('fs');
                fs.copyFileSync(fp, savePath);
                eagle.notification.show({ duration: 3000, title: 'Image Saved', body: getPageLabel(idx) });
            }
        } catch (err) {
            console.error('Save failed:', err);
            eagle.notification.show({ duration: 3000, title: 'Save Failed', body: err.message });
        }
    }

    async function copyImage(idx) {
        try {
            const fp = await archiveUtil.getImagePath(filePath, idx);
            if (!fp) throw new Error('Image not extracted');

            const nativeImage = typeof require !== 'undefined' ? require('electron').nativeImage : window.nativeImage;
            let img = nativeImage.createFromPath(fp);
            eagle.clipboard.writeImage(img);

            eagle.notification.show({ duration: 3000, title: 'Image Copied', body: getPageLabel(idx) });
        } catch (err) {
            console.error('Copy failed:', err);
            eagle.notification.show({ duration: 3000, title: 'Copy Failed', body: err.message });
        }
    }

    function onImageContextMenu(e) {
        // Suppress menu after right-drag zoom gesture
        if (rightDragUsed) {
            rightDragUsed = false;
            e.preventDefault();
            return;
        }
        const idx = getImageIndexFromEvent(e);
        if (idx < 0) return; // Not on an image

        e.preventDefault();
        const isVid = isVideoEntry(idx);
        const mediaLabel = isVid ? 'Video' : 'Image';
        const menuItems = [
            { id: 'save', label: `Save ${mediaLabel}`, click: () => saveImage(idx) },
        ];
        if (!isVid) {
            menuItems.push({ id: 'copy', label: 'Copy Image', click: () => copyImage(idx) });
        }
        menuItems.push(
            { id: 'unpack', label: `Unpack ${mediaLabel} to Eagle`, click: () => unpackImage(idx) },
            { id: 'thumbnail', label: 'Set as Thumbnail', click: () => setAsThumbnail(idx) },
        );
        eagle.contextMenu.open(menuItems);
    }

    // Init
    if (!filePath) {
        console.error('No file path provided.');
        return;
    }

    archiveUtil.getSessionToken(filePath).then(token => {
        sessionToken = token;
        return archiveUtil.listImages(filePath);
    }).then(names => {
        imageNames = names;
        if (names.length === 0) {
            console.error('No images found in archive.');
            return;
        }

        setScrollGap(scrollGap);
        setMangaRtl(mangaRtl);
        setScrollNavEnabled(scrollNavEnabled);
        setPageTransitionSpeed(pageTransitionMs);
        restorePosition();
        applyView();
        updatePageInfo();
        updateNav();
    }).catch(err => {
        console.error('Failed to load archive:', err);
    });
})();