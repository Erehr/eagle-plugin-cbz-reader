/**
 * Verifies the resize re-render path in viewer.js.
 *
 * The bug: window resize purged every <img> src but never asked the loader to
 * run again, so visible pages went blank permanently — the IntersectionObserver
 * only fires on intersection *changes*, and a page visible before the resize is
 * still visible after it.
 *
 * Functions are lifted out of the viewer IIFE by source extraction, so this
 * exercises the shipped code rather than a re-implementation.
 */
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(
    process.argv[2] || path.join(__dirname, '..', 'viewer', 'viewer.js'), 'utf8');

function extract(name) {
    const start = SRC.indexOf('function ' + name + '(');
    if (start < 0) throw new Error('not found: ' + name);
    let depth = 0, end = -1;
    for (let i = SRC.indexOf('{', start); i < SRC.length; i++) {
        if (SRC[i] === '{') depth++;
        else if (SRC[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
    }
    return SRC.slice(start, end);
}

let pass = 0, fail = 0;
function check(name, actual, expected) {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { pass++; console.log('  ok   ' + name + ' => ' + a); }
    else { fail++; console.log('  FAIL ' + name + ' => ' + a + ', expected ' + e); }
}

// ── needsLoad ────────────────────────────────────────────────────────────
const needsLoad = new Function('return ' + extract('needsLoad'))();

console.log('\n-- needsLoad --');
check('never-loaded image', needsLoad({ src: '', dataset: {} }), true);
check('loaded image', needsLoad({ src: 'file:///a.jpg', dataset: {} }), false);
check('loaded but stale', needsLoad({ src: 'file:///a.jpg', dataset: { stale: '1' } }), true);
check('loaded, stale cleared', needsLoad({ src: 'file:///a.jpg', dataset: { stale: '' } }), false);
check('purged (src emptied)', needsLoad({ src: '', dataset: { stale: '' } }), true);

// ── invalidateRenderedSizes ──────────────────────────────────────────────
// Rebuilt per scenario: the function closes over mediaEls, the render queue,
// renderEpoch, getExpectedTargetWidth and devicePixelRatio.
const invalidateSrc = extract('invalidateRenderedSizes')
    .replace(/renderEpoch\+\+/, 'renderEpochRef.v++')
    // Injected under a distinct name: substituting `dpr` here would produce
    // `const dpr = dpr` and shadow the parameter.
    .replace(/window\.devicePixelRatio \|\| 1/, '_dpr');
const thresholdSrc = SRC.slice(SRC.indexOf('const RERENDER_GROWTH_THRESHOLD'),
    SRC.indexOf(';', SRC.indexOf('const RERENDER_GROWTH_THRESHOLD')) + 1);

function makeInvalidate(mediaEls, requiredWidths, dpr) {
    const renderQueue = { cleared: 0, clear() { this.cleared++; } };
    const renderEpochRef = { v: 0 };
    const fn = new Function(
        'mediaEls', 'renderQueue', 'renderEpochRef', 'getExpectedTargetWidth', '_dpr',
        thresholdSrc + invalidateSrc + '; return invalidateRenderedSizes;'
    )(mediaEls, renderQueue, renderEpochRef, i => requiredWidths[i], dpr);
    return { run: fn, renderQueue, renderEpochRef };
}

console.log('\n-- invalidateRenderedSizes: what gets marked --');
{
    const grew = { tagName: 'IMG', src: 'a', dataset: { renderedW: '800' } };
    const shrank = { tagName: 'IMG', src: 'b', dataset: { renderedW: '1600' } };
    const tiny = { tagName: 'IMG', src: 'c', dataset: { renderedW: '1000' } };
    const native = { tagName: 'IMG', src: 'd', dataset: { renderedW: 'Infinity' } };
    const unknown = { tagName: 'IMG', src: 'e', dataset: {} };
    const blank = { tagName: 'IMG', src: '', dataset: {} };
    const video = { tagName: 'VIDEO', src: 'v', dataset: { loaded: '1' } };
    const els = [grew, shrank, tiny, native, unknown, blank, video, null];
    //            1600  800     1030  99999   1200     500    500
    const req = [1600, 800, 1030, 99999, 1200, 500, 500];

    const h = makeInvalidate(els, req, 1);
    const marked = h.run();

    check('window grew past the render -> marked', grew.dataset.stale, '1');
    check('window shrank -> NOT marked', shrank.dataset.stale, undefined);
    check('grew only 3% (under threshold) -> NOT marked', tiny.dataset.stale, undefined);
    check('already native resolution -> NOT marked', native.dataset.stale, undefined);
    check('unknown render width -> marked (conservative)', unknown.dataset.stale, '1');
    check('blank src -> not marked (already reloads)', blank.dataset.stale, undefined);
    check('video left alone', video.dataset.stale, undefined);
    check('video keeps src (no playback restart)', video.src, 'v');
    check('marked count returned', marked, 2);
    check('kept src on marked page (no blank frame)', grew.src, 'a');
    check('render queue cleared once', h.renderQueue.cleared, 1);
    check('render epoch bumped', h.renderEpochRef.v, 1);
}

console.log('\n-- nothing to redo: in-flight work is left alone --');
{
    const a = { tagName: 'IMG', src: 'a', dataset: { renderedW: '2000' } };
    const h = makeInvalidate([a], [900], 1);
    const marked = h.run();
    check('marked count is zero', marked, 0);
    check('render queue NOT cleared', h.renderQueue.cleared, 0);
    check('render epoch NOT bumped', h.renderEpochRef.v, 0);
}

console.log('\n-- devicePixelRatio is accounted for --');
{
    const a = { tagName: 'IMG', src: 'a', dataset: { renderedW: '1000' } };
    // 600 CSS px on a 2x display needs 1200 real px > 1000
    const h = makeInvalidate([a], [600], 2);
    check('hi-dpi growth marked', h.run(), 1);

    const b = { tagName: 'IMG', src: 'b', dataset: { renderedW: '1000' } };
    const h2 = makeInvalidate([b], [600], 1);
    check('same size at 1x not marked', h2.run(), 0);
}

console.log('\n-- the marked image is now reloadable --');
{
    const img = { tagName: 'IMG', src: 'a', dataset: { renderedW: '800', stale: '1' } };
    check('stale image needs load', needsLoad(img), true);
    img.dataset.stale = '';   // what smartLoadImage does after swapping in
    check('cleared after render', needsLoad(img), false);
}

// ── the actual regression: resize must re-trigger loading ────────────────
console.log('\n-- resize handler wiring --');
const handler = SRC.slice(SRC.indexOf("window.addEventListener('resize'"));
const body = handler.slice(0, handler.indexOf('\n    });') + 8);

check('re-triggers the loader', /preloadImagesAroundCurrent\s*\(/.test(body), true);
check('marks pages stale instead of blanking', /invalidateRenderedSizes\s*\(/.test(body), true);
check('does NOT blank srcs via purgeRenderCache', /purgeRenderCache\s*\(/.test(body), false);
check('debounced', /setTimeout\(/.test(body), true);
check('clears a pending debounce', /clearTimeout\(/.test(body), true);
check('layout still runs immediately', /disposeImages\s*\(/.test(body), true);

// Order matters: invalidate must precede the preload, or the guards still block
const iInv = body.indexOf('invalidateRenderedSizes');
const iPre = body.indexOf('preloadImagesAroundCurrent');
check('invalidate runs before preload', iInv >= 0 && iPre > iInv, true);

console.log('\n-- zoom survives a resize --');
check('does NOT reset zoom', /resetZoom\s*\(/.test(body), false);
check('re-applies the current scale to re-clamp', /applyScale\(currentScale/.test(body), true);
// Guarded, so an unzoomed reader does not pay for a pointless transform commit
check('only when zoomed', /haveZoom\)\s*applyScale/.test(body), true);

console.log('\n-- resize skips work when nothing is under-resolved --');
check('bails out on a zero mark count', /invalidateRenderedSizes\(\)\s*===\s*0\)\s*return/.test(body), true);

console.log('\n-- continuous mode holds the reading position --');
check('captures an anchor before relayout', /captureScrollAnchor\s*\(/.test(body), true);
check('restores it after relayout', /restoreScrollAnchor\s*\(/.test(body), true);
check('does not snap to page top when anchored',
    /if \(anchor\) \{[\s\S]*restoreScrollAnchor\(anchor\);[\s\S]*\} else \{[\s\S]*goToIndex/.test(body), true);
const iCap = body.indexOf('captureScrollAnchor');
const iCalc = body.indexOf('calculateView');
check('anchor captured before calculateView', iCap >= 0 && iCalc > iCap, true);

// ── the anchor math ──────────────────────────────────────────────────────
function makeAnchorFns(state) {
    const src = extract('captureScrollAnchor') + '\n' + extract('restoreScrollAnchor') +
        '\n; return { capture: captureScrollAnchor, restore: restoreScrollAnchor };';
    return new Function(
        'continuous', 'posList', 'imagesFullPosition', 'readingContainer', 'currentScale', 'findIndexAtOffset',
        src
    )(state.continuous, state.posList, state.imagesFullPosition, state.container,
        state.currentScale, extractFindIndex(state.posList));
}
function extractFindIndex(posList) {
    return new Function('posList', extract('findIndexAtOffset') + '; return findIndexAtOffset;')(posList);
}
function layout(heights, gap) {
    const pos = {}; const list = []; let y = 0;
    heights.forEach((h, i) => {
        pos[i] = { top: y, center: y + h / 2, bottom: y + h, height: h };
        list[i] = pos[i];
        y += h + (gap || 0);
    });
    return { pos, list };
}

console.log('\n-- anchor math: webtoon strip, pages get taller on resize --');
{
    // Narrow window: one very tall strip page among normal ones
    const before = layout([1000, 12000, 1000]);
    const container = { scrollTop: 0 };
    // Scrolled 60% into the tall page
    container.scrollTop = before.pos[1].top + 0.6 * before.pos[1].height;

    const fns = makeAnchorFns({
        continuous: true, posList: before.list, imagesFullPosition: before.pos,
        container, currentScale: 1,
    });
    const anchor = fns.capture();
    check('anchored to the tall page', anchor.index, 1);
    check('60% into it', Math.round(anchor.frac * 100) / 100, 0.6);

    // Window widened: every page grows, the tall one by a lot
    const after = layout([1400, 16800, 1400]);
    const fns2 = makeAnchorFns({
        continuous: true, posList: after.list, imagesFullPosition: after.pos,
        container, currentScale: 1,
    });
    fns2.restore(anchor);
    const expected = after.pos[1].top + 0.6 * after.pos[1].height;
    check('restored to the same point in the page', container.scrollTop, expected);
    check('NOT snapped to the page top', container.scrollTop !== after.pos[1].top, true);
}

console.log('\n-- anchor math: edge cases --');
{
    const l = layout([500, 500], 20);
    const container = { scrollTop: 0 };
    const mk = sc => makeAnchorFns({
        continuous: true, posList: l.list, imagesFullPosition: l.pos, container, currentScale: sc,
    });

    container.scrollTop = 0;
    check('top of the strip', mk(1).capture(), { index: 0, frac: 0 });

    // Land in the gap between pages: belongs to no page, must not exceed 1
    container.scrollTop = l.pos[0].bottom + 10;
    const inGap = mk(1).capture();
    check('gap clamps to end of previous page', inGap, { index: 0, frac: 1 });

    // Zoomed: scrollTop is in scaled space, anchors are in layout space
    container.scrollTop = (l.pos[1].top + 250) * 2;
    check('zoom accounted for on capture', mk(2).capture(), { index: 1, frac: 0.5 });
    container.scrollTop = 0;
    mk(2).restore({ index: 1, frac: 0.5 });
    check('zoom accounted for on restore', container.scrollTop, (l.pos[1].top + 250) * 2);

    // Paged mode opts out entirely
    const paged = makeAnchorFns({
        continuous: false, posList: l.list, imagesFullPosition: l.pos, container, currentScale: 1,
    });
    check('no anchor in paged mode', paged.capture(), null);
    container.scrollTop = 123;
    paged.restore({ index: 1, frac: 0.5 });
    check('restore is a no-op in paged mode', container.scrollTop, 123);

    // Missing page data must not throw or move anything
    const empty = makeAnchorFns({
        continuous: true, posList: [], imagesFullPosition: {}, container, currentScale: 1,
    });
    check('no anchor without layout data', empty.capture(), null);
    empty.restore(null);
    check('restore(null) is a no-op', container.scrollTop, 123);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail === 0 ? 0 : 1);
