const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const { runBatch, dryRunBatch, scanFolder, isVideoFile, getBinaries, VIDEO_EXTS } = require('../encoder/pipeline');
const { flattenRunDir } = require('../encoder/flatten');
const { findOrphanPartials, deletePartials } = require('../encoder/orphans');

let mainWindow = null;
let stopRequested = false;
let queueRunning = false;

// ----- Lightweight per-user preferences (no external dep) -------------------
// Persists the last-used source folder so the browse picker defaults there.
function prefsPath() {
  return path.join(app.getPath('userData'), 'prefs.json');
}
let prefs = {};
function loadPrefs() {
  try { prefs = JSON.parse(fs.readFileSync(prefsPath(), 'utf8')); }
  catch { prefs = {}; }
}
function savePrefs() {
  try {
    fs.mkdirSync(path.dirname(prefsPath()), { recursive: true });
    fs.writeFileSync(prefsPath(), JSON.stringify(prefs, null, 2));
  } catch (e) { /* non-fatal */ }
}

/* ─────────── Lifetime reclaimed: drive resolution ───────────
   Keying rule: a path under /Volumes/<name>/... belongs to that
   /Volumes/<name>; everything else belongs to the boot drive '/'.
   Boot label is the visible name of the symlink at /Volumes/<name>
   whose target is '/'. Cached after first lookup. */
let _bootLabel = null;
function detectBootLabel() {
  try {
    const entries = fs.readdirSync('/Volumes', { withFileTypes: true });
    for (const e of entries) {
      if (e.isSymbolicLink && e.isSymbolicLink()) {
        try {
          const target = fs.readlinkSync(path.join('/Volumes', e.name));
          if (target === '/') return e.name;
        } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
  return 'Macintosh HD';
}
function bootLabel() {
  if (_bootLabel == null) _bootLabel = detectBootLabel();
  return _bootLabel;
}
function driveKeyForPath(p) {
  if (!p || typeof p !== 'string') return null;
  const m = /^\/Volumes\/([^/]+)/.exec(p);
  if (m) return `/Volumes/${m[1]}`;
  return '/';
}
function driveLabelForKey(k) {
  if (k === '/') return bootLabel();
  return path.basename(k);
}

/* Output flattening lives in ../encoder/flatten (pure fs, unit-tested in
   test/trust_day1.js). main just calls flattenRunDir after each batch:
   it mirrors source structure into a single flat run folder, suffixes
   name collisions _2/_3, and sweeps any stray .tmp.mp4 partials. */

/* Orphaned-partial detection lives in ../encoder/orphans (pure fs,
   unit-tested in test/trust_day1.js). findOrphanPartials scans an
   interrupted run's dest(s) for leftover .tmp.mp4; deletePartials removes
   only those, never originals or finished outputs. */

// Per-batch runtime state for row-level Pause / Resume / Stop.
// Only one batch runs at a time, but keeping it keyed by id lets renderer
// dispatch actions targeted at a specific row without ambiguity.
const runtime = new Map(); // batchId -> { child, paused, cancelled }

function rt(id) {
  if (!runtime.has(id)) runtime.set(id, { child: null, paused: false, cancelled: false });
  return runtime.get(id);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 1080,
    minHeight: 760,
    backgroundColor: '#1a1d22',
    titleBarStyle: 'hiddenInset',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
}

app.whenReady().then(() => {
  loadPrefs();
  const bins = getBinaries();
  if (!fs.existsSync(bins.ffmpeg) || !fs.existsSync(bins.ffprobe)) {
    dialog.showErrorBox(
      'Missing bundled tools',
      `Expected ffmpeg at:\n${bins.ffmpeg}\nand ffprobe at:\n${bins.ffprobe}\n\nThe app cannot run without them.`
    );
    app.quit();
    return;
  }
  createWindow();

  /* Orphaned-partial sweep: if a previous run was interrupted, its dest(s)
     are still recorded in prefs.pendingDests. Scan them once, hand any
     leftover .tmp.mp4 partials to the renderer (which offers to delete),
     then clear the marker so we never nag twice for the same crash. */
  const pendingDests = Array.isArray(prefs.pendingDests) ? prefs.pendingDests.slice() : [];
  if (pendingDests.length) {
    findOrphanPartials(pendingDests)
      .then((orphans) => {
        prefs.pendingDests = [];
        savePrefs();
        if (orphans.length && mainWindow && !mainWindow.isDestroyed()) {
          const send = () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('orphans-found', { orphans });
            }
          };
          if (mainWindow.webContents.isLoading()) {
            mainWindow.webContents.once('did-finish-load', send);
          } else {
            send();
          }
        }
      })
      .catch(() => { prefs.pendingDests = []; savePrefs(); });
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

/* Version read from Electron's bundled identity — single source of truth.
   In dev this falls through to package.json; in a packaged .app it returns
   CFBundleShortVersionString. The renderer fetches it once at startup. */
ipcMain.handle('app-version', async () => app.getVersion());

ipcMain.handle('choose-destination', async (_evt, defaultPath) => {
  const opts = { properties: ['openDirectory', 'createDirectory'] };
  if (defaultPath && fs.existsSync(defaultPath)) opts.defaultPath = defaultPath;
  const r = await dialog.showOpenDialog(mainWindow, opts);
  if (r.canceled || !r.filePaths.length) return null;
  return r.filePaths[0];
});

ipcMain.handle('scan-source', async (_evt, srcPath) => {
  return await scanFolder(srcPath);
});

/* Stat — lets the renderer distinguish a dropped folder from dropped files
   so it can dispatch to the existing folder scan path vs the new file-list
   path without re-implementing folder detection on the renderer side. */
ipcMain.handle('stat-path', async (_evt, p) => {
  if (!p || typeof p !== 'string') return null;
  try {
    const s = await fsp.stat(p);
    return { isFile: s.isFile(), isDirectory: s.isDirectory() };
  } catch { return null; }
});

/* File picker — multi-select, video-typed. macOS dialogs can't pick folders
   AND files in one dialog, so the browse button now picks files; folders
   still arrive via drag-drop. */
ipcMain.handle('browse-source-files', async (_evt, suggestedFallback) => {
  const exts = [...VIDEO_EXTS].map((e) => e.replace(/^\./, ''));
  const opts = {
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Video files', extensions: exts },
      { name: 'All files', extensions: ['*'] }
    ]
  };
  if (prefs.lastSrc && fs.existsSync(prefs.lastSrc)) {
    // lastSrc may be a folder OR a file — defaultPath as a file is fine.
    opts.defaultPath = prefs.lastSrc;
  } else if (suggestedFallback && fs.existsSync(suggestedFallback)) {
    opts.defaultPath = suggestedFallback;
  } else {
    opts.defaultPath = app.getPath('home');
  }
  const r = await dialog.showOpenDialog(mainWindow, opts);
  if (r.canceled || !r.filePaths.length) return null;
  // Persist the picker's anchor as the parent of the first selected file
  // — next open lands in the same folder.
  prefs.lastSrc = path.dirname(r.filePaths[0]);
  savePrefs();
  return r.filePaths;
});

/* scan-files — probe a heterogeneous list of paths (files and/or folders).
   Each folder expands via the existing scanFolder; each file is probed
   individually. Folder scanning is the validated path and is reused
   unchanged — we just don't take that path when the renderer routed a
   dropped/picked file-list batch here. */
ipcMain.handle('scan-files', async (_evt, srcPaths) => {
  if (!Array.isArray(srcPaths) || srcPaths.length === 0) {
    return { rootKind: 'files', root: null, videos: [], ignored: 0, totalSize: 0 };
  }
  const videos = [];
  let ignored = 0;
  let totalSize = 0;
  for (const p of srcPaths) {
    if (!p || typeof p !== 'string') { ignored++; continue; }
    try {
      const sub = await scanFolder(p);     // handles both file + dir cases
      videos.push(...sub.videos);
      ignored += sub.ignored || 0;
      totalSize += sub.totalSize || 0;
    } catch {
      ignored++;
    }
  }
  return { rootKind: 'files', root: srcPaths[0], videos, ignored, totalSize };
});

ipcMain.handle('start-queue', async (_evt, batches) => {
  if (queueRunning) return { ok: false, error: 'Already running' };
  queueRunning = true;
  stopRequested = false;

  /* Mark this run's real (non-dry) destinations as in-flight so a crash
     mid-encode is recoverable: the next launch scans these for orphaned
     .tmp.mp4 partials. Cleared in the finally below once the run ends
     cleanly (whether finished or user-stopped). */
  try {
    const runDests = [...new Set(
      (batches || []).filter((b) => b && !b.dryRun).map((b) => b.dest).filter(Boolean)
    )];
    prefs.pendingDests = runDests;
    savePrefs();
  } catch { /* non-fatal */ }

  const send = (channel, payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
  };

  const totals = { processed: 0, failed: 0, failedCopied: 0, failedNoCopy: 0, skippedNonVideo: 0, reclaimed: 0, alreadyDone: 0 };

  try {
    for (let i = 0; i < batches.length; i++) {
      if (stopRequested) break;
      const batch = batches[i];
      send('batch-status', { id: batch.id, status: 'Running' });

      const isDry = !!batch.dryRun;
      const state = rt(batch.id);
      state.child = null; state.paused = false; state.cancelled = false;

      const control = {
        shouldStop: () => stopRequested,
        isCancelled: () => state.cancelled,
        /* If cancel fired between "begin next file" and "spawn ffmpeg",
           the new child arrives AFTER the cancel handler already kicked.
           Kill it on the spot so pipeline's runCmd returns immediately
           and the next cancel check breaks out of the batch. */
        onSpawn: (child) => {
          state.child = child;
          if (state.cancelled) {
            try { child.kill('SIGTERM'); } catch {}
            setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 1200);
          }
        }
      };

      /* File-list batches arrive with batch.kind === 'files' and an array
         of original file paths in batch.fileSources. We stage them in a
         temp dir of symlinks named so the encoder sees a regular folder
         and mirrors output under "Selected files (<id>)/". Pipeline.js is
         untouched — it walks the temp dir like any other source.
         Cleanup runs in finally so symlinks never leak. */
      let runSrc = batch.src;
      let tmpCleanup = null;
      if (batch.kind === 'files' && Array.isArray(batch.fileSources) && batch.fileSources.length > 0) {
        const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'squeeze-fl-'));
        const niceName = `Selected files (${batch.id})`;
        const stageDir = path.join(tmpRoot, niceName);
        await fsp.mkdir(stageDir, { recursive: true });
        const used = new Set();
        for (const fp of batch.fileSources) {
          let base = path.basename(fp);
          let safe = base;
          let n = 1;
          while (used.has(safe)) {
            const ext = path.extname(base);
            const stem = base.slice(0, base.length - ext.length);
            safe = `${stem} (${n})${ext}`;
            n++;
          }
          used.add(safe);
          const linkPath = path.join(stageDir, safe);
          /* Hardlink so the entry shows up as a regular file to pipeline's
             readdir({withFileTypes:true}) walker. Symlinks are skipped
             because Dirent#isFile() returns false for them. If the source
             is on a different filesystem (EXDEV — e.g. /Volumes/NAS),
             fall back to a copy that uses APFS clonefile when available
             (effectively free CoW). */
          try {
            await fsp.link(fp, linkPath);
          } catch (e) {
            if (e && e.code === 'EXDEV') {
              await fsp.copyFile(fp, linkPath, fs.constants.COPYFILE_FICLONE);
            } else {
              throw e;
            }
          }
        }
        runSrc = stageDir;
        tmpCleanup = tmpRoot;
      }

      const wrappedBatch = (runSrc === batch.src) ? batch : { ...batch, src: runSrc };

      let result;
      try {
        result = isDry
          ? await dryRunBatch(wrappedBatch, (progress) => send('progress', { batchId: batch.id, ...progress }))
          : await runBatch(wrappedBatch, control, (progress) => send('progress', { batchId: batch.id, ...progress }));
      } finally {
        if (tmpCleanup) {
          try { await fsp.rm(tmpCleanup, { recursive: true, force: true }); } catch { /* non-fatal */ }
        }
      }

      /* Flatten EVERYTHING into runDir.
         Pipeline mirrors source structure (per spec §6), so a folder batch
         produces <runDir>/<src basename>/<...inner mirror...>/file.mp4 and
         a file-list batch produces <runDir>/Selected files (<id>)/file.mp4.
         The operator wants a single canonical layout regardless of how the
         source was supplied: files DIRECTLY under Compressed_<run>/, with
         no per-source / per-batch subfolder, no internal mirror.
         compress.log stays at runDir level (pipeline wrote it there); the
         _FAILED/ directory is kept intact so failure diagnostics aren't
         flattened too.
         Name collisions (same basename across batches in the same run, or
         from two different source subfolders within one batch) get an
         "_2" / "_3" suffix — no output is silently lost. */
      if (!isDry && result && result.runDir && fs.existsSync(result.runDir)) {
        const lifted = await flattenRunDir(result.runDir);
        try {
          fs.appendFileSync(
            path.join(result.runDir, 'compress.log'),
            `# Flatten: lifted=${lifted} — canonical layout is`
            + ` <chosen output>/Compressed_<run>/<files> (flat, no subfolders)\n`
          );
        } catch {}
      }

      totals.processed += result.processed || 0;
      totals.failed += result.failed || 0;
      totals.failedCopied += result.failedCopied || 0;
      totals.failedNoCopy += result.failedNoCopy || 0;
      totals.skippedNonVideo += result.skippedNonVideo || 0;
      totals.reclaimed += result.reclaimed || 0;
      totals.alreadyDone += result.alreadyDone || 0;

      let finalStatus;
      if (state.cancelled)        finalStatus = 'Cancelled';
      else if (result.failed > 0) finalStatus = 'Done (with failures)';
      else                        finalStatus = 'Done';

      send('batch-status', { id: batch.id, status: finalStatus, result });

      state.child = null;
      if (stopRequested) break;
    }
  } finally {
    queueRunning = false;
    // Run reached a clean end — no orphaned partials to recover next launch.
    try { prefs.pendingDests = []; savePrefs(); } catch { /* non-fatal */ }
    send('queue-finished', { totals, stopped: stopRequested });
  }
  return { ok: true };
});

ipcMain.handle('stop-queue', async () => {
  stopRequested = true;
  return { ok: true };
});

function sendBatchUpdate(batchId, status) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('batch-status', { id: batchId, status });
  }
}

ipcMain.handle('pause-batch', async (_evt, batchId) => {
  const state = rt(batchId);
  if (!state.child || state.paused) return { ok: false };
  try {
    state.child.kill('SIGSTOP');
    state.paused = true;
    sendBatchUpdate(batchId, 'Paused');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('resume-batch', async (_evt, batchId) => {
  const state = rt(batchId);
  if (!state.child || !state.paused) return { ok: false };
  try {
    state.child.kill('SIGCONT');
    state.paused = false;
    sendBatchUpdate(batchId, 'Running');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('cancel-batch', async (_evt, batchId) => {
  const state = rt(batchId);
  state.cancelled = true;
  const child = state.child;
  // If paused, unpause first so the child can react to SIGTERM.
  if (child && state.paused) {
    try { child.kill('SIGCONT'); } catch {}
    state.paused = false;
  }
  if (child) {
    try { child.kill('SIGTERM'); } catch {}
    /* ffmpeg occasionally takes its time finishing the current frame on
       SIGTERM; SIGKILL after 1.2s guarantees the encode dies and pipeline's
       runCmd resolves so the cancel check can break the batch loop. */
    setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 1200);
  }
  sendBatchUpdate(batchId, 'Cancelling');
  return { ok: true };
});

/* Click-to-browse source folder.
   Default-path priority: persisted lastSrc → renderer-suggested fallback
   (typically the current output's parent) → user's home. Selected path is
   persisted so subsequent opens (and drops) land in a useful place. */
ipcMain.handle('browse-source', async (_evt, suggestedFallback) => {
  const opts = { properties: ['openDirectory', 'createDirectory'] };
  if (prefs.lastSrc && fs.existsSync(prefs.lastSrc)) {
    opts.defaultPath = prefs.lastSrc;
  } else if (suggestedFallback && fs.existsSync(suggestedFallback)) {
    opts.defaultPath = suggestedFallback;
  } else {
    opts.defaultPath = app.getPath('home');
  }
  const r = await dialog.showOpenDialog(mainWindow, opts);
  if (r.canceled || !r.filePaths.length) return null;
  prefs.lastSrc = r.filePaths[0];
  savePrefs();
  return r.filePaths[0];
});

ipcMain.handle('save-last-src', async (_evt, p) => {
  if (typeof p === 'string' && p.length > 0) {
    prefs.lastSrc = p;
    savePrefs();
  }
});

/* ─────────── Lifetime reclaimed: IPC ───────────
   - get-lifetime-drives → sorted (totalReclaimed desc) array of records.
   - add-reclaimed → credits a batch's contribution to its drive. Caller
     is the renderer; it has already excluded dry-run batches and filtered
     to files that finished with status 'done', so we just accumulate.
     New drives are auto-created on first credit.
   - reset-drive → zeroes counters for ONE drive (no file effects). */
ipcMain.handle('get-lifetime-drives', async () => {
  const drives = prefs.lifetimeDrives || {};
  return Object.values(drives).sort((a, b) => (b.totalReclaimed || 0) - (a.totalReclaimed || 0));
});

ipcMain.handle('add-reclaimed', async (_evt, payload) => {
  if (!payload || !payload.dest) return null;
  const filesAdded = Math.max(0, Math.floor(payload.filesAdded || 0));
  const addedBytes = Math.max(0, Math.floor(payload.addedBytes || 0));
  // No work? Don't create a drive row for nothing.
  if (filesAdded === 0) return null;

  const driveKey = driveKeyForPath(payload.dest);
  if (!driveKey) return null;

  prefs.lifetimeDrives = prefs.lifetimeDrives || {};
  const now = Date.now();
  let rec = prefs.lifetimeDrives[driveKey];
  if (!rec) {
    rec = {
      driveKey,
      label: driveLabelForKey(driveKey),
      totalReclaimed: 0,
      filesProcessed: 0,
      runsCount: 0,
      firstSeen: now,
      lastUsed: now
    };
    prefs.lifetimeDrives[driveKey] = rec;
  } else {
    // Cheap refresh in case the mount was renamed since first seen.
    rec.label = driveLabelForKey(driveKey);
  }
  rec.totalReclaimed += addedBytes;
  rec.filesProcessed += filesAdded;
  rec.runsCount += 1;        // one batch with real work = one run
  rec.lastUsed = now;
  savePrefs();
  return rec;
});

ipcMain.handle('reset-drive', async (_evt, driveKey) => {
  if (!driveKey || !prefs.lifetimeDrives) return null;
  const rec = prefs.lifetimeDrives[driveKey];
  if (!rec) return null;
  const now = Date.now();
  rec.totalReclaimed = 0;
  rec.filesProcessed = 0;
  rec.runsCount = 0;
  rec.firstSeen = now;        // counter starts over from now
  rec.lastUsed = now;
  savePrefs();
  return rec;
});

/* ─── Disk-space pre-flight ───────────────────────────────────────────
   Returns the free bytes available to an unprivileged writer on the volume
   that holds `p` (bavail × bsize). Returns null free when the path can't be
   stat'd (e.g. drive unplugged) so the renderer can fail OPEN — never block
   a run just because we couldn't read the figure. */
ipcMain.handle('free-space', async (_evt, p) => {
  if (!p || typeof p !== 'string') return { free: null };
  try {
    const s = await fsp.statfs(p);
    return { free: s.bavail * s.bsize };
  } catch {
    return { free: null };
  }
});

/* ─── Orphaned-partial deletion ───────────────────────────────────────
   Renderer hands back the subset the operator approved. deletePartials
   re-validates every path defensively (only ".tmp.mp4" under a
   "Compressed_" run folder is ever unlinked) — see ../encoder/orphans. */
ipcMain.handle('delete-orphans', async (_evt, paths) => {
  const deleted = await deletePartials(paths);
  return { deleted };
});

ipcMain.handle('open-path', async (_evt, p) => {
  if (p && fs.existsSync(p)) shell.openPath(p);
});

ipcMain.handle('reveal-path', async (_evt, p) => {
  if (p && fs.existsSync(p)) shell.showItemInFolder(p);
});
