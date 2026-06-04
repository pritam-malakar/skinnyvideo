const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const { runBatch, dryRunBatch, scanFolder, isVideoFile, getBinaries, VIDEO_EXTS } = require('../encoder/pipeline');
const { flattenRunDir } = require('../encoder/flatten');
const { findOrphanPartials, deletePartials } = require('../encoder/orphans');
const { stageFileList } = require('../encoder/stage');

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

  /* Orphaned-partial sweep (BUG 2 — intended scope, documented):
     On every launch we scan EVERY output folder Squeeze has written to —
     prefs.outputRoots accumulates each destination ever used — plus any
     in-flight pendingDests, for leftover .tmp.mp4 partials under their
     "Compressed_" run folders. This catches partials from ANY interrupted
     run, not just the most recent one. We deliberately do NOT walk the whole
     filesystem: scope is "known Squeeze output locations". pendingDests is
     cleared after the scan; outputRoots persists so a partial the operator
     chooses to keep is re-offered next launch until it's resolved. */
  const sweepRoots = [...new Set([
    ...(Array.isArray(prefs.outputRoots) ? prefs.outputRoots : []),
    ...(Array.isArray(prefs.pendingDests) ? prefs.pendingDests : [])
  ])];
  if (sweepRoots.length) {
    findOrphanPartials(sweepRoots)
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
     cleanly (whether finished or user-stopped).
     Also fold them into prefs.outputRoots — the persistent set of every
     destination Squeeze has ever written to — so the launch sweep (BUG 2)
     can find orphans under ANY past output location, not just the last run. */
  try {
    const runDests = [...new Set(
      (batches || []).filter((b) => b && !b.dryRun).map((b) => b.dest).filter(Boolean)
    )];
    prefs.pendingDests = runDests;
    const roots = new Set(Array.isArray(prefs.outputRoots) ? prefs.outputRoots : []);
    for (const d of runDests) roots.add(d);
    prefs.outputRoots = [...roots];
    savePrefs();
  } catch { /* non-fatal */ }

  const send = (channel, payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
  };

  const totals = { processed: 0, failed: 0, failedCopied: 0, failedNoCopy: 0, failedDestLost: 0, destLost: false, skippedNonVideo: 0, reclaimed: 0, alreadyDone: 0 };

  try {
    for (let i = 0; i < batches.length; i++) {
      if (stopRequested) break;
      const batch = batches[i];
      send('batch-status', { id: batch.id, status: 'Running' });

      const isDry = !!batch.dryRun;
      const state = rt(batch.id);
      state.child = null; state.paused = false; state.cancelled = false; state.resolved = false;

      const control = {
        shouldStop: () => stopRequested,
        isCancelled: () => state.cancelled,
        /* So the encoder's stall watchdog never kills a deliberately paused
           (SIGSTOP'd) encode, which legitimately emits no output. */
        isPaused: () => state.paused,
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

      /* FIX 1 — AUTO-ADVANCE: a single batch's failure (for ANY reason) must
         never halt the queue. The whole per-batch body is wrapped: on any
         unexpected throw we fail THIS batch and the loop continues to the next,
         exactly as it continues past a failed file within a batch. (Staging and
         runBatch already have their own handling; this is the backstop that
         also covers e.g. a flatten error.) */
      try {

      /* BUG 2 (v2.1.15): AUTHORITATIVE skip filter at THIS batch's turn. The
         renderer pre-filters skipped files only into the start-of-queue payload
         snapshot; a file skipped AFTER Start (e.g. in batch 03 while batch 01
         runs) never reached this frozen payload, so it used to get staged/
         encoded anyway. rt().skips is kept live by the 'set-batch-skips' IPC;
         fall back to the payload's frozen skipped[] if no live update arrived.
         Skipped ORIGINAL paths are removed from fileSources before staging, and
         passed to runBatch as batch.skip for folder batches (scan.videos[].file
         is the original path there). A skipped file is therefore never staged
         nor encoded, whenever the skip was toggled. */
      const skipSet = (state.skips instanceof Set)
        ? state.skips
        : new Set(Array.isArray(batch.skipped) ? batch.skipped : []);
      const effSources = (Array.isArray(batch.fileSources) ? batch.fileSources : [])
        .filter((p) => !skipSet.has(p));
      batch.skip = [...skipSet];   // consumed by runBatch for folder batches

      // All files in a file-list batch skipped → nothing to do; clean Done.
      if (batch.kind === 'files' && (batch.fileSources || []).length > 0 && effSources.length === 0) {
        send('batch-status', { id: batch.id, status: 'Done', result: {
          runDir: null, processed: 0, failed: 0, failedCopied: 0, failedNoCopy: 0, failedDestLost: 0,
          destLost: false, alreadyDone: 0, skippedNonVideo: 0, reclaimed: 0, totalFiles: 0
        } });
        state.resolved = true; state.child = null;
        continue;
      }

      /* File-list staging (file-pick / multi-file-drop, or a folder batch with
         skips → kind:'files'). Hardlink/copy each original into a temp dir so
         the encoder reads a stable path (this is what makes a STARTED job
         robust to the original moving/being deleted). stageMap maps temp →
         original for progress translation (BUG A).
         FIX 1 — the staging is WRAPPED: if a source is missing/unstageable
         (e.g. deleted before this batch's turn) stageFileList throws, we catch
         it, fail this batch CLEANLY as source-missing, and CONTINUE the queue.
         Previously this throw escaped the per-batch try/catch and left the
         batch stuck on "Running". */
      let runSrc = batch.src;
      let tmpCleanup = null;
      let stageMap = new Map();
      let stageMissing = [];
      let stageError = null;
      if (batch.kind === 'files' && effSources.length > 0) {
        try {
          const staged = await stageFileList(batch.id, effSources);
          runSrc = staged.stageDir;
          tmpCleanup = staged.tmpRoot;
          stageMap = staged.stageMap;
          /* v2.1.14 BUG 2: per-file staging isolation. stageFileList no longer
             throws when ONE source is missing — it stages what it can and lists
             the rest in `missing`. We run the staged files, then fold the missing
             ones in as per-file source-missing failures below. stageFileList only
             throws now if it couldn't create the staging area at all. */
          stageMissing = staged.missing || [];
        } catch (e) {
          stageError = e;
        }
      }

      if (stageError) {
        const n = Math.max(1, effSources.length);
        const result = {
          runDir: null, logPath: null,
          processed: 0, failed: n, failedCopied: 0, failedNoCopy: n, failedDestLost: 0,
          destLost: false, alreadyDone: 0, skippedNonVideo: 0, reclaimed: 0, totalFiles: n,
          sourceMissing: true, error: stageError && stageError.message
        };
        totals.failed += n;
        totals.failedNoCopy += n;
        send('batch-status', { id: batch.id, status: 'Failed', result });
        state.resolved = true;
        state.child = null;
        continue;   // queue continues to the next batch — never stuck on Running
      }

      const wrappedBatch = (runSrc === batch.src) ? batch : { ...batch, src: runSrc };

      /* Forward progress to the renderer, translating staged temp paths back
         to original source paths so file rows resolve by exact path (BUG A). */
      const forward = (progress) => {
        let p = progress;
        if (stageMap.size && p && typeof p.file === 'string' && stageMap.has(p.file)) {
          const orig = stageMap.get(p.file);
          p = { ...p, file: orig, basename: path.basename(orig) };
        }
        send('progress', { batchId: batch.id, ...p });
      };

      let result;
      try {
        result = isDry
          ? await dryRunBatch(wrappedBatch, forward)
          : await runBatch(wrappedBatch, control, forward);
      } catch (e) {
        /* BUG 3 backstop: any unexpected hard failure (e.g. the destination
           drive vanished before we could write) must fail the batch cleanly,
           never leave it stuck on "Running". */
        result = {
          runDir: null, logPath: null,
          processed: 0, failed: 0, failedCopied: 0, failedNoCopy: 0, failedDestLost: 0,
          destLost: true, alreadyDone: 0, skippedNonVideo: 0, reclaimed: 0, totalFiles: 0,
          error: e && e.message
        };
      } finally {
        if (tmpCleanup) {
          try { await fsp.rm(tmpCleanup, { recursive: true, force: true }); } catch { /* non-fatal */ }
        }
      }

      /* Per-file staging isolation (v2.1.14 BUG 2): sources that could not be
         staged (deleted/moved before their turn) fail INDIVIDUALLY — the rest
         of the batch already encoded above. Fold them in as source-missing
         failures and emit a per-file event so each missing row resolves to
         "failed" by exact path (the batch's reconcile would catch them too, but
         this keeps the counts and rows precise). The batch then finishes with
         partial success instead of the whole batch being sunk by one bad file. */
      if (stageMissing.length) {
        result.failed = (result.failed || 0) + stageMissing.length;
        result.failedNoCopy = (result.failedNoCopy || 0) + stageMissing.length;
        result.totalFiles = (result.totalFiles || 0) + stageMissing.length;
        result.sourceMissing = true;
        const tot = result.totalFiles || stageMissing.length;
        for (const mp of stageMissing) {
          forward({
            type: 'file-done', index: tot, total: tot,
            file: mp, basename: path.basename(mp),
            outcome: 'fail', failKind: 'source-missing', outBytes: -1,
            processed: result.processed || 0, failed: result.failed || 0,
            alreadyDone: result.alreadyDone || 0
          });
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
        // Flatten failure is non-fatal — the encode already succeeded; never
        // let it throw and abort the queue (FIX 1).
        try {
          const lifted = await flattenRunDir(result.runDir);
          try {
            fs.appendFileSync(
              path.join(result.runDir, 'compress.log'),
              `# Flatten: lifted=${lifted} — canonical layout is`
              + ` <chosen output>/Compressed_<run>/<files> (flat, no subfolders)\n`
            );
          } catch {}
        } catch (e) { /* non-fatal */ }
      }

      totals.processed += result.processed || 0;
      totals.failed += result.failed || 0;
      totals.failedCopied += result.failedCopied || 0;
      totals.failedNoCopy += result.failedNoCopy || 0;
      totals.failedDestLost += result.failedDestLost || 0;
      if (result.destLost) totals.destLost = true;
      totals.skippedNonVideo += result.skippedNonVideo || 0;
      totals.reclaimed += result.reclaimed || 0;
      totals.alreadyDone += result.alreadyDone || 0;

      let finalStatus;
      if (state.cancelled)                                 finalStatus = 'Cancelled';
      // Destination vanished with nothing saved → a failure, never green "Done".
      else if (result.destLost && (result.processed || 0) === 0) finalStatus = 'Failed';
      else if (result.failed > 0)                          finalStatus = 'Done (with failures)';
      else                                                 finalStatus = 'Done';

      send('batch-status', { id: batch.id, status: finalStatus, result });
      state.resolved = true;   // the batch reported a terminal status — cancel watchdog stands down

      } catch (e) {
        /* FIX 1 backstop: any unexpected error in this batch must not halt the
           queue. If we haven't already reported a terminal status, fail this
           batch and carry on to the next one. */
        if (!state.resolved) {
          send('batch-status', {
            id: batch.id, status: 'Failed',
            result: { runDir: null, processed: 0, failed: 1, failedCopied: 0, failedNoCopy: 1, failedDestLost: 0, destLost: false, reclaimed: 0, error: e && e.message }
          });
          state.resolved = true;
        }
      }

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

/* BUG 2 (v2.1.15): the renderer pushes a batch's current skipped ORIGINAL paths
   here every time the user toggles skip — including AFTER Start, for batches not
   yet at their turn. start-queue reads rt(id).skips at each batch's turn so the
   filter reflects the latest skip state, not the frozen start-of-queue payload. */
ipcMain.handle('set-batch-skips', async (_evt, { batchId, skipped }) => {
  const state = rt(batchId);
  state.skips = new Set(Array.isArray(skipped) ? skipped : []);
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

const CANCEL_HARD_MS = 4000;   // pill must resolve within this, no matter what

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
    /* Bounded SIGKILL fallback: if the child hasn't died on SIGTERM shortly,
       force-kill it. (pipeline's runCmd also resolves immediately on the
       cancel flag, so the batch loop never waits for the child to confirm
       death — see runCmd's cancel poll.) */
    setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 1000);
  }
  sendBatchUpdate(batchId, 'Cancelling');

  /* BUG C hard guarantee: the pill must NEVER stick on "Cancelling". If the
     batch loop hasn't reported a terminal status within CANCEL_HARD_MS (e.g.
     a child wedged in uninterruptible I/O that even SIGKILL can't reap), force
     the UI to Cancelled regardless of whether the child confirmed death. */
  setTimeout(() => {
    if (!state.resolved) {
      state.resolved = true;
      sendBatchUpdate(batchId, 'Cancelled');
    }
  }, CANCEL_HARD_MS);

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
