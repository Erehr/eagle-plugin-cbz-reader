/**
 * Worker-thread half of the page resize pipeline.
 *
 * Keeps the resize off the renderer thread. All logic lives in
 * `render-image.js`, so the in-process fallback behaves identically.
 *
 * Protocol, one plain object per message:
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
    // Jobs are independent and may overlap; every reply carries its own id.
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
