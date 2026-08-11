/**
 * Worker-thread half of the page resize pipeline.
 *
 * The reader runs in Eagle's renderer process, and `archive-util.js` is
 * required straight into it, so anything that module does synchronously happens
 * on the thread that paints. The resize is the expensive part — decode, SIMD
 * scale, re-encode — and @napi-rs/image performs at least the scale inline
 * rather than on the libuv pool, which is what Sharp used to do for us. Running
 * it here means the renderer is never blocked by it regardless of what the
 * addon does internally.
 *
 * Deliberately thin: all the real logic lives in `render-image.js` so the
 * in-process fallback in archive-util.js behaves identically to this.
 *
 * Protocol, in both directions, is one plain object per message:
 *   in   { id, ...job }                       see render-image.renderToFile
 *   out  { id, ok: true, skipped: true }      original file should be used
 *        { id, ok: true, path }               resized file written
 *        { id, ok: false, error }             failed; caller falls back
 */
const { parentPort } = require('worker_threads');
const renderImage = require('./render-image.js');

if (!parentPort) {
    throw new Error('render-worker.js must be started as a worker thread');
}

parentPort.on('message', async (job) => {
    // Jobs are independent, so this handler is deliberately not serialised:
    // several can be in flight and the addon's async encoders will overlap.
    // Ordering does not matter — every reply carries its own id.
    try {
        const result = await renderImage.renderToFile(job);
        parentPort.postMessage({ id: job.id, ok: true, ...result });
    } catch (err) {
        parentPort.postMessage({
            id: job.id,
            ok: false,
            error: (err && err.message) || String(err),
        });
    }
});
