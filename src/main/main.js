const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const { runBatch, dryRunBatch, scanFolder, isVideoFile, getBinaries, ffmpegStatus, ENGINE_MISSING_MESSAGE, VIDEO_EXTS } = require('../encoder/pipeline');
const { flattenRunDir } = require('../encoder/flatten');
const { findOrphanPartials, deletePartials } = require('../encoder/orphans');
const { stageFileList } = require('../encoder/stage');
const { runQueue } = require('./queue-runner');
const { revealInFinder } = require('./reveal');

let mainWindow = null;
let stopRequested = false;
let queueRunning = false;
/* The LIVE batch list the running queue is draining (the same array object
   passed to runQueue). Mid-run drops are appended here via 'enqueue-batch', and
   runQueue's loop re-reads `.length` each turn so it absorbs them in the SAME
   run. Null whenever no run is active — an enqueue then is a fresh-run drop, not
   a resurrection of the finished run. */
let liveBatches = null;

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
    /* Pass 7 — REVERSES Pass 3's OS vibrancy. The window is now OPAQUE and the
       renderer paints its own atmospheric backdrop (the mockup's gradient stack),
       exactly like the mockup .html. Real OS vibrancy is dropped: it required a
       transparent window over a near-black desktop, which made the frosted panels
       sample a dark backdrop and read flat/sunken. An opaque painted backdrop is
       what gives the milky floating panels. backgroundColor = the mockup canvas. */
    backgroundColor: '#05070a',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
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
  /* Self-contained engine: verify the BUNDLED ffmpeg/ffprobe exist and are
     executable at launch. No fallback to any other binary — if it's gone the
     app cannot encode, so fail fast with plain-language wording. */
  const engine = ffmpegStatus();
  if (!engine.ok) {
    dialog.showErrorBox('Squeeze', ENGINE_MISSING_MESSAGE);
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

/* Engine pre-flight for the renderer's Start handler: returns {ok} plus the
   plain-language message on failure, so the run can be blocked BEFORE any UI
   flips to "running" and before a single ffmpeg is spawned. */
ipcMain.handle('check-engine', async () => {
  const s = ffmpegStatus();
  return { ok: s.ok, message: s.ok ? null : ENGINE_MISSING_MESSAGE };
});

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
  /* NO SILENT FALLBACK: refuse to start — and never reach runQueue/spawn — if
     the bundled engine is gone. Returned to the renderer as engineMissing so it
     surfaces the plain-language message. queueRunning stays false (no run). */
  const engine = ffmpegStatus();
  if (!engine.ok) return { ok: false, engineMissing: true, error: ENGINE_MISSING_MESSAGE };
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

  let totals;
  try {
    // Per-batch loop + auto-advance live in the shared, test-covered runner.
    // `batches` is the SAME array 'enqueue-batch' appends to → mid-run drops drain.
    liveBatches = batches;
    totals = await runQueue(batches, { send, isStopRequested: () => stopRequested, rt });
  } finally {
    liveBatches = null;   // run over → further drops start a fresh run
    queueRunning = false;
    // Run reached a clean end — no orphaned partials to recover next launch.
    try { prefs.pendingDests = []; savePrefs(); } catch { /* non-fatal */ }
    send('queue-finished', {
      totals: totals || { processed: 0, failed: 0, failedCopied: 0, failedNoCopy: 0, failedDestLost: 0, destLost: false, skippedNonVideo: 0, reclaimed: 0, alreadyDone: 0 },
      stopped: stopRequested
    });
  }
  return { ok: true };
});

ipcMain.handle('stop-queue', async () => {
  stopRequested = true;
  return { ok: true };
});

/* OPTION A — a running queue drains ALL queued batches, including ones dropped
   WHILE it runs. The renderer calls this when a batch is added during a live run;
   we append it to the SAME array runQueue is iterating, so the loop picks it up at
   its turn (re-reading `.length`) and stages it normally (hardlink→symlink→copy).
   ABSORBED ONLY while a run is live: if the run has already ended (liveBatches is
   null / queueRunning false), the drop is NOT folded into the finished run — the
   renderer leaves it Queued for the next Start, which is a fresh run with its own
   summary. (The check is synchronous w.r.t. the loop's turn boundary, so there is
   no window where an absorbed batch is stranded unrun.) Honors stop the same way
   the loop does: a stopped run won't reach an appended batch. */
ipcMain.handle('enqueue-batch', async (_evt, batch) => {
  if (!queueRunning || !liveBatches || !batch) return { ok: true, absorbed: false };
  liveBatches.push(batch);
  /* Keep orphan-recovery bookkeeping honest for the new destination too. */
  if (!batch.dryRun && batch.dest) {
    try {
      const pend = new Set(Array.isArray(prefs.pendingDests) ? prefs.pendingDests : []);
      pend.add(batch.dest); prefs.pendingDests = [...pend];
      const roots = new Set(Array.isArray(prefs.outputRoots) ? prefs.outputRoots : []);
      roots.add(batch.dest); prefs.outputRoots = [...roots];
      savePrefs();
    } catch { /* non-fatal */ }
  }
  return { ok: true, absorbed: true };
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

/* Reveal an ORIGINAL source file in Finder, clicked from a queue file row.
   Stat-gated in ../main/reveal so a moved/deleted original never reaches
   showItemInFolder; returns {ok} so the renderer can show a non-blocking
   "may have moved" notice on failure. */
ipcMain.handle('reveal-in-finder', async (_evt, p) => revealInFinder(p));
