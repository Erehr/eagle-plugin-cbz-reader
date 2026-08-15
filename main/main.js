/**
 * CBZ Creator – Window plugin for creating CBZ archives from selected Eagle images.
 * Uses yazl with compress: false (STORE method) for zero-overhead archiving.
 */
const path = require('path');
const fs = require('fs');
const urlModule = require('url');
const pluginRoot = path.join(__dirname, '..');
const yazl = require(path.join(pluginRoot, 'node_modules', 'yazl'));

/**
 * Absolute path → file:// URL. Handles the macOS leading slash and escapes
 * '#', '?' and '%' in filenames, which naive string concatenation does not.
 */
function toFileURL(absPath) {
    try {
        return urlModule.pathToFileURL(absPath).href;
    } catch (_) {
        const p = absPath.replace(/\\/g, '/');
        return 'file://' + (p.startsWith('/') ? '' : '/') + encodeURI(p);
    }
}

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.avif']);

// ── Archive name validation ─────────────────────────────────

/** Illegal in a filename on at least one supported platform (non-global: `test` must be stateless). */
const ILLEGAL_NAME_CHARS = /[<>:"/\\|?*\u0000-\u001f]/;
/** Same set, global, for stripping as the user types. */
const ILLEGAL_NAME_CHARS_G = /[<>:"/\\|?*\u0000-\u001f]/g;
/** Windows reserves these device names whatever extension follows. */
const RESERVED_BASENAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * Validate the typed archive name as a *single* file basename.
 *
 * Path separators, '.'/'..' and drive-relative forms are rejected rather than
 * quietly rewritten, so the file created is always the one the user typed.
 *
 * @returns {{ok: true, name: string} | {ok: false, reason: string}}
 */
function validateArchiveName(input) {
    const name = String(input == null ? '' : input).trim().replace(/\.cbz$/i, '').trim();

    if (!name) return { ok: false, reason: 'Enter a file name' };
    if (name.length > 120) return { ok: false, reason: 'File name is too long' };
    if (/[/\\]/.test(name)) return { ok: false, reason: 'File name cannot contain / or \\' };
    if (ILLEGAL_NAME_CHARS.test(name)) return { ok: false, reason: 'File name contains an invalid character' };
    if (name === '.' || name === '..' || name.startsWith('.')) return { ok: false, reason: 'File name cannot start with a dot' };
    if (/[. ]$/.test(name)) return { ok: false, reason: 'File name cannot end with a dot or space' };
    if (RESERVED_BASENAMES.test(name)) return { ok: false, reason: 'That file name is reserved by the system' };
    if (path.basename(name) !== name) return { ok: false, reason: 'File name must not contain a path' };

    return { ok: true, name };
}

/**
 * Resolve `name` to an absolute path that is provably a direct child of `dir`.
 *
 * @returns {string|null}
 */
function resolveInside(dir, name) {
    if (typeof name !== 'string' || !name || name === '.' || name === '..') return null;
    if (name.includes('/') || name.includes('\\') || name.includes('\0')) return null;

    const root = path.resolve(dir);
    const target = path.resolve(root, name);
    const rel = path.relative(root, target);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || rel.includes(path.sep)) return null;
    return target;
}

let items = []; // Eagle Item objects
let listEl, emptyEl, nameInput, btnCreate, statusEl, titlebarText, chkTrashOriginals;
let nameField, nameMirror, nameSuffix;
let dragReorder = { fromIndex: -1 }; // drag-to-reorder state

// ── Eagle lifecycle ─────────────────────────────────────────

eagle.onPluginCreate((plugin) => {
    console.log('CBZ Creator: onPluginCreate', plugin.manifest.name);

    listEl = document.getElementById('image-list');
    emptyEl = document.getElementById('empty-state');
    nameInput = document.getElementById('cbz-name');
    btnCreate = document.getElementById('btn-create');
    statusEl = document.getElementById('status');
    titlebarText = document.getElementById('titlebar-text');
    chkTrashOriginals = document.getElementById('chk-trash-originals');
    nameField = document.getElementById('name-field');
    nameMirror = document.getElementById('cbz-mirror');
    nameSuffix = document.getElementById('cbz-suffix');

    // Deliberately not remembered between runs. This option deletes user
    // content, so it always starts off and has to be an explicit choice each
    // time rather than something left switched on from a previous session.
    chkTrashOriginals.checked = false;

    btnCreate.addEventListener('click', createCBZ);
    nameInput.addEventListener('keydown', e => {
        if (e.key === 'Enter') createCBZ();
    });
    nameInput.addEventListener('input', () => {
        // Characters that cannot appear in a filename are dropped as they are
        // typed, so the field can never show a name we would have to reject.
        const cleaned = nameInput.value.replace(ILLEGAL_NAME_CHARS_G, '');
        if (cleaned !== nameInput.value) {
            const caret = nameInput.selectionStart - (nameInput.value.length - cleaned.length);
            nameInput.value = cleaned;
            nameInput.setSelectionRange(caret, caret);
        }
        onNameChanged();
    });
    // The input is only as wide as its text, so clicking the empty part of the
    // field would otherwise do nothing.
    nameField.addEventListener('mousedown', e => {
        if (e.target !== nameInput) {
            e.preventDefault();
            nameInput.focus();
            nameInput.setSelectionRange(nameInput.value.length, nameInput.value.length);
        }
    });

    window.addEventListener('resize', syncNameSuffix);
    onNameChanged();

    // Close button (frameless window)
    const btnClose = document.getElementById('btn-close');
    if (btnClose) {
        btnClose.addEventListener('click', () => {
            resetWindow();
            eagle.window.hide();
        });
    }

    // Drag and drop support
    setupDragDrop();
});

eagle.onPluginRun(() => {
    console.log('CBZ Creator: onPluginRun');
    resetWindow();
    loadSelected();
});

eagle.onPluginShow(() => {
    console.log('CBZ Creator: onPluginShow');
    // Refresh selection each time the window is shown
    loadSelected();
});

function resetWindow() {
    items = [];
    nameInput.value = '';
    // The window is created once and reused, so clear the toggle here too —
    // otherwise it would stay switched on for the next run from the last one.
    if (chkTrashOriginals) chkTrashOriginals.checked = false;
    updateUI();
}

// ── Name field ──────────────────────────────────────────────

function onNameChanged() {
    updateButtonState();
    syncNameSuffix();
}

/**
 * Keep the ".cbz" suffix immediately after the typed text rather than at the far
 * edge of the field. A hidden mirror span gives the exact text width.
 */
function syncNameSuffix() {
    if (!nameField || !nameMirror) return;
    nameMirror.textContent = nameInput.value || nameInput.placeholder || '';
    const available = nameField.clientWidth - nameSuffix.offsetWidth - 26;
    const width = Math.min(Math.max(nameMirror.offsetWidth + 1, 8), Math.max(available, 8));
    nameInput.style.width = width + 'px';
}

// ── Load selected images ────────────────────────────────────

async function loadSelected() {
    try {
        const selected = await eagle.item.getSelected();
        const imageItems = selected.filter(item => {
            const ext = ('.' + (item.ext || '')).toLowerCase();
            return IMAGE_EXTS.has(ext);
        });

        if (imageItems.length > 0) {
            // Merge with existing items (avoid duplicates by id)
            const existingIds = new Set(items.map(it => it.id));
            for (const item of imageItems) {
                if (!existingIds.has(item.id)) {
                    items.push(item);
                }
            }
        }

        updateUI();

        // Prefill name from currently selected folder (if not already set)
        if (!nameInput.value) {
            try {
                const folders = await eagle.folder.getSelected();
                if (folders && folders.length > 0 && folders[0].name) {
                    nameInput.value = folders[0].name.replace(ILLEGAL_NAME_CHARS_G, '');
                }
            } catch (_) { }
            onNameChanged();
        }
    } catch (err) {
        console.error('Failed to load selected items:', err);
        statusEl.textContent = 'Error loading items';
    }
}

// ── Drag and drop ───────────────────────────────────────────

function setupDragDrop() {
    const dropTarget = document.body;

    dropTarget.addEventListener('dragover', e => {
        e.preventDefault();
        e.stopPropagation();
        listEl.classList.add('drag-over');
    });

    dropTarget.addEventListener('dragleave', e => {
        e.preventDefault();
        e.stopPropagation();
        listEl.classList.remove('drag-over');
    });

    dropTarget.addEventListener('drop', async e => {
        e.preventDefault();
        e.stopPropagation();
        listEl.classList.remove('drag-over');

        const files = e.dataTransfer.files;
        if (!files || files.length === 0) return;

        const existingIds = new Set(items.map(it => it.id));

        for (const file of files) {
            const ext = path.extname(file.name).toLowerCase();
            if (!IMAGE_EXTS.has(ext)) continue;

            // Create a pseudo-item for dropped files (not from Eagle)
            const pseudoItem = {
                id: 'drop_' + Date.now() + '_' + Math.random().toString(36).slice(2),
                name: path.basename(file.name, ext),
                ext: ext.slice(1),
                filePath: file.path,
                size: file.size,
                width: 0,
                height: 0,
                thumbnailURL: '',
            };

            if (!existingIds.has(pseudoItem.id)) {
                items.push(pseudoItem);
                existingIds.add(pseudoItem.id);
            }
        }

        updateUI();
    });
}

// ── UI ──────────────────────────────────────────────────────

function updateUI() {
    if (items.length === 0) {
        emptyEl.style.display = '';
        titlebarText.textContent = 'Create CBZ';
        statusEl.textContent = 'No images selected';
    } else {
        emptyEl.style.display = 'none';
        titlebarText.textContent = `Create CBZ (${items.length} images)`;
        statusEl.textContent = ''; // Clear status to favor space for packing feedback
    }

    onNameChanged();
    renderList();
}

function updateButtonState() {
    btnCreate.disabled = items.length === 0 || !validateArchiveName(nameInput.value).ok;
}

function renderList() {
    // Clear existing items but keep empty state
    listEl.querySelectorAll('.image-item').forEach(el => el.remove());

    items.forEach((item, i) => {
        const row = document.createElement('div');
        row.className = 'image-item';
        row.draggable = true;
        row.dataset.index = i;

        // Drag handle
        const handle = document.createElement('div');
        handle.className = 'drag-handle';
        handle.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14"><circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="18" r="1.5"/></svg>';

        // Reorder drag events
        row.addEventListener('dragstart', e => {
            dragReorder.fromIndex = i;
            row.classList.add('dragging');
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', String(i));
        });
        row.addEventListener('dragend', () => {
            row.classList.remove('dragging');
            dragReorder.fromIndex = -1;
            listEl.querySelectorAll('.drag-over-row').forEach(el => el.classList.remove('drag-over-row'));
        });
        row.addEventListener('dragover', e => {
            if (dragReorder.fromIndex < 0) return; // external drop, ignore
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            listEl.querySelectorAll('.drag-over-row').forEach(el => el.classList.remove('drag-over-row'));
            row.classList.add('drag-over-row');
        });
        row.addEventListener('dragleave', () => {
            row.classList.remove('drag-over-row');
        });
        row.addEventListener('drop', e => {
            e.preventDefault();
            row.classList.remove('drag-over-row');
            const from = dragReorder.fromIndex;
            const to = i;
            if (from < 0 || from === to) return;
            const [moved] = items.splice(from, 1);
            items.splice(to, 0, moved);
            dragReorder.fromIndex = -1;
            renderList();
        });

        const thumb = document.createElement('img');
        thumb.className = 'thumb';
        thumb.draggable = false;
        // Use thumbnailURL for Eagle items, or try to load from filePath for drops
        if (item.thumbnailURL) {
            thumb.src = item.thumbnailURL;
        } else if (item.filePath) {
            thumb.src = toFileURL(item.filePath);
        }
        thumb.alt = '';
        thumb.onerror = () => { thumb.style.display = 'none'; };

        const info = document.createElement('div');
        info.className = 'info';

        const name = document.createElement('div');
        name.className = 'name';
        name.textContent = item.name + '.' + item.ext;
        info.appendChild(name);

        const resDOM = document.createElement('div');
        resDOM.className = 'resolution';
        resDOM.textContent = (item.width && item.height) ? item.width + '×' + item.height : '';

        const sizeDOM = document.createElement('div');
        sizeDOM.className = 'size';
        sizeDOM.textContent = item.size ? formatSize(item.size) : '';

        const removeBtn = document.createElement('button');
        removeBtn.className = 'btn-remove';
        removeBtn.title = 'Remove from list';
        removeBtn.innerHTML = '<svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
        removeBtn.addEventListener('click', () => {
            items.splice(i, 1);
            updateUI();
        });

        // Pack grid struct columns sequentially: handle -> thumb -> info -> resolution -> size -> btn
        row.appendChild(handle);
        row.appendChild(thumb);
        row.appendChild(info);
        row.appendChild(resDOM);
        row.appendChild(sizeDOM);
        row.appendChild(removeBtn);
        listEl.appendChild(row);
    });
}

function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

// ── Create CBZ ──────────────────────────────────────────────

/**
 * Confirm the destructive half of the operation before any of it starts.
 *
 * "Move originals to Trash" is remembered between runs, so it is spelled out
 * with a count and asked before the archive is built.
 */
async function confirmTrashOriginals(archiveName, count) {
    try {
        const result = await eagle.dialog.showMessageBox({
            type: 'warning',
            title: 'Move originals to Trash',
            message: `Create ${archiveName}.cbz and move ${count} original ${count === 1 ? 'item' : 'items'} to Trash?`,
            detail: 'The originals go to Eagle\'s Trash, where you can restore them until you empty it.',
            buttons: ['Cancel', 'Create and Move to Trash'],
            defaultId: 0,
            cancelId: 0,
        });
        return result && result.response === 1;
    } catch (err) {
        // A dialog we cannot show is not consent — fail closed.
        console.error('Confirmation dialog failed:', err);
        return false;
    }
}

async function createCBZ() {
    if (items.length === 0) return;

    const check = validateArchiveName(nameInput.value);
    if (!check.ok) {
        statusEl.textContent = check.reason;
        nameInput.focus();
        return;
    }
    const archiveName = check.name;

    // Only Eagle-sourced items can be trashed; files dropped onto the window
    // are not in the library and are never touched.
    const trashIds = chkTrashOriginals.checked
        ? items.filter(x => !String(x.id).startsWith('drop_')).map(x => x.id)
        : [];

    if (trashIds.length > 0 && !(await confirmTrashOriginals(archiveName, trashIds.length))) {
        statusEl.textContent = 'Cancelled';
        return;
    }

    btnCreate.disabled = true;
    btnCreate.classList.add('working');
    statusEl.textContent = 'Creating CBZ…';

    let tmpDir = null;
    try {
        // Determine target folder: currently selected folder in Eagle
        let targetFolders = [];
        try {
            const selectedFolders = await eagle.folder.getSelected();
            if (selectedFolders && selectedFolders.length > 0) {
                targetFolders = [selectedFolders[0].id];
            }
        } catch (_) { }

        // Build CBZ in a temp directory of our own.
        tmpDir = fs.mkdtempSync(path.join(eagle.os.tmpdir(), 'eagle-cbz-creator-'));
        const tmpFile = resolveInside(tmpDir, archiveName + '.cbz');
        if (!tmpFile) throw new Error('Invalid file name');

        await new Promise((resolve, reject) => {
            const zip = new yazl.ZipFile();
            const ws = fs.createWriteStream(tmpFile, { flags: 'wx' });
            zip.outputStream.pipe(ws);

            // Track filenames to avoid duplicates
            const usedNames = new Set();

            items.forEach((item, i) => {
                const ext = '.' + (item.ext || 'jpg');
                // Zero-pad page number for natural sort order
                const pad = String(i + 1).padStart(String(items.length).length + 1, '0');
                let fileName = pad + '_' + sanitize(item.name) + ext;

                // Deduplicate
                let base = fileName;
                let counter = 2;
                while (usedNames.has(fileName.toLowerCase())) {
                    fileName = base.replace(ext, '_' + counter + ext);
                    counter++;
                }
                usedNames.add(fileName.toLowerCase());

                zip.addFile(item.filePath, fileName, { compress: false });
            });

            zip.end();

            ws.on('finish', () => {
                try {
                    const stats = fs.statSync(tmpFile);
                    if (stats.size > 22) {
                        resolve();
                    } else {
                        reject(new Error('Created archive is empty or corrupted'));
                    }
                } catch (e) {
                    reject(e);
                }
            });
            ws.on('error', reject);
        });

        statusEl.textContent = 'Adding to Eagle…';

        // Add CBZ to Eagle
        const opts = { name: archiveName };
        if (targetFolders.length > 0) opts.folders = targetFolders;
        await eagle.item.addFromPath(tmpFile, opts);

        // Trash the originals only after the new archive is safely in the library.
        // Confirmed up front, so by this point consent is already on record.
        if (trashIds.length > 0) {
            statusEl.textContent = 'Moving originals to Trash…';
            try {
                // The local HTTP API is used rather than the plugin API because it
                // takes an array of item IDs, so this is one call instead of N.
                await fetch('http://127.0.0.1:41595/api/item/moveToTrash', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ itemIds: trashIds })
                });
            } catch (e) {
                console.error('Failed to bulk trash items via generic API:', e);
            }
        }

        statusEl.textContent = 'Done! ' + archiveName + '.cbz created';
        eagle.notification.show({
            duration: 3000,
            title: 'CBZ Created',
            body: archiveName + '.cbz – ' + items.length + ' images',
        });

        // Close window immediately upon absolute completion
        resetWindow();
        eagle.window.hide();

    } catch (err) {
        console.error('CBZ creation failed:', err);
        statusEl.textContent = 'Error: ' + err.message;
        eagle.notification.show({
            duration: 3000,
            title: 'CBZ Creation Failed',
            body: err.message,
        });
    } finally {
        // Remove the whole session directory, not just the file we know about,
        // so a partially written archive never lingers in temp.
        if (tmpDir) {
            try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { }
        }
        btnCreate.disabled = false;
        btnCreate.classList.remove('working');
    }
}

/**
 * Flatten an Eagle item name into an entry name for inside the archive.
 * Separators and characters illegal on any supported platform are replaced.
 */
function sanitize(name) {
    return String(name == null ? '' : name)
        .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
        .replace(/\s+/g, '_')
        .replace(/^\.+/, '')
        .slice(0, 80) || 'image';
}
