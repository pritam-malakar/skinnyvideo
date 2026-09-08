const { app, BrowserWindow, ipcMain, dialog, shell, Menu, MenuItem, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const { runBatch, dryRunBatch, scanFolder, isVideoFile, getBinaries, ffmpegStatus, ENGINE_MISSING_MESSAGE, VIDEO_EXTS, tierDefaults } = require('../encoder/pipeline');
const { flattenRunDir } = require('../encoder/flatten');
const { findOrphanPartials, deletePartials } = require('../encoder/orphans');
const { stageFileList } = require('../encoder/stage');
const { runQueue, releasePauseGate } = require('./queue-runner');
const { revealInFinder, revealFolder } = require('./reveal');
const { writeJsonAtomic } = require('./prefs-store');
const { appendHistoryEntry, readHistory } = require('./history-store');
const { RUN_DIALOG, handleCloseAttempt, applyProgressToQuitState } = require('./close-guard');
const { beginCancel, quitViaCancel } = require('./quit-teardown');
const { installUpdater } = require('./updater');
const { canvasFor } = require('../shared/theme');

let mainWindow = null;
let stopRequested = false;
let queueRunning = false;
/* Close-guard state. v2.9.6: queueRunning mirrors the run flag for the WHOLE
   run — guarding on isFinalizing alone (the flush sub-window) let the red
   button through for the entire encode, killing ffmpeg and leaving a partial
   with no moov atom. dialogOpen/closing are the re-entry guards. */
const quitState = {
  queueRunning: false, isFinalizing: false,
  forceQuit: false, dialogOpen: false, closing: false
};
/* The in-flight runQueue promise, held so "Stop and quit" can await REAL
   encoder exit + cleanup instead of guessing at a timeout. */
let runPromise = null;
/* Auto-update handle (installed at whenReady; a no-op object in dev). Held so
   the end of a run can flush a restart prompt that was held back mid-encode. */
let updater = { notifyIdle() {} };
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
/* ─── v2.11.0 one-time userData migration: Squeeze → SkinnyVideo ───────────
   The app was renamed, and Electron derives userData from productName — so a
   fresh 2.11.0 launch points at .../Application Support/SkinnyVideo and would
   silently start with empty prefs, an empty history ledger and a zeroed
   lifetime-reclaimed total while the real data sat in the old Squeeze dir.

   WHAT MOVES: the app's own JSON stores only (prefs.json today, and any
   future *.json ledger sitting alongside it). Chromium's own state in that
   directory — Cache, GPUCache, Local Storage, Preferences, Trust Tokens — is
   deliberately NOT copied: it is keyed to the old app identity, and copying
   it across is at best useless and at worst corrupting.

   WHEN IT RUNS: only when the new dir holds no *.json of its own. Chromium
   creates and populates the new userData dir before whenReady fires, so a
   bare "is the directory empty" test would never be true on a real launch;
   "has this app written any data here yet" is the honest first-run test.

   NEVER DELETES the old directory — a 2.10.x build must keep working if the
   operator rolls back. Wrapped end-to-end in try/catch: a migration that
   fails must not stop the app from launching. */
const OLD_USERDATA_NAME = 'Squeeze';
function migrateLegacyUserData() {
  try {
    const newDir = app.getPath('userData');
    const oldDir = path.join(path.dirname(newDir), OLD_USERDATA_NAME);
    if (oldDir === newDir) return;                       // nothing to do
    if (!fs.existsSync(oldDir)) return;                  // no legacy install

    const listJson = (dir) => {
      try {
        return fs.readdirSync(dir, { withFileTypes: true })
          .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.json'))
          .map((e) => e.name);
      } catch { return []; }
    };

    if (listJson(newDir).length) return;                 // already migrated
    const carry = listJson(oldDir);
    if (!carry.length) return;                           // nothing worth moving

    fs.mkdirSync(newDir, { recursive: true });
    const moved = [];
    for (const name of carry) {
      try {
        fs.copyFileSync(path.join(oldDir, name), path.join(newDir, name));
        moved.push(name);
      } catch { /* skip this file, keep going */ }
    }
    if (moved.length) {
      console.log(`[SkinnyVideo] Migrated ${moved.length} file(s) from ${oldDir} into ${newDir}: ${moved.join(', ')} — original left in place.`);
    }
  } catch (e) {
    console.log(`[SkinnyVideo] userData migration skipped: ${(e && e.message) || e}`);
  }
}

let prefs = {};
function loadPrefs() {
  try { prefs = JSON.parse(fs.readFileSync(prefsPath(), 'utf8')); }
  catch { prefs = {}; }
}
/* v2.10.0: ATOMIC. Every caller is unchanged — the write itself moved to
   temp+fsync+rename in ./prefs-store so a crash mid-write can no longer leave
   a truncated prefs.json (which loadPrefs' catch would silently reset to {},
   taking lifetimeDrives and history with it). See prefs-store.js for the
   full rationale. */
function savePrefs() {
  writeJsonAtomic(prefsPath(), prefs);   // never throws; false = old file kept
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
       what gives the milky floating panels.

       backgroundColor = the mockup canvas — NOT a constant. It tracks the
       renderer's --canvas per appearance (../shared/theme), because macOS shows
       any disagreement: the system corner mask leaves a crescent of bare
       NSWindow above the square top edge of the web contents, and that crescent
       is painted with THIS colour. Seeded here from the system appearance so the
       very first frame is right; kept in sync afterwards by 'theme:changed'
       below, which the renderer sends for every theme change including its
       manual override. */
    backgroundColor: canvasFor(nativeTheme.shouldUseDarkColors),
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

  /* Close-guard: a red-button close during a run (running OR paused) confirms
     first. Idle → close is untouched, zero friction. */
  mainWindow.on('close', (e) => {
    handleCloseAttempt(quitState, {
      preventDefault: () => e.preventDefault(),
      confirmQuit: confirmStopAndQuit,
      proceed: () => stopRunThenQuit(() => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
      })
    });
  });
}

/* Native confirm for the close-guard. Returns true iff the operator chose
   "Stop and quit" (button index 1). Synchronous so it can answer Electron's
   close/before-quit events inline — those events cannot be awaited. */
function confirmStopAndQuit() {
  const parent = (mainWindow && !mainWindow.isDestroyed()) ? mainWindow : null;
  const choice = parent
    ? dialog.showMessageBoxSync(parent, RUN_DIALOG)
    : dialog.showMessageBoxSync(RUN_DIALOG);
  return choice === 1;
}

/* "Stop and quit": the CANCEL path, not the Stop button's graceful
   stop-after-current-file — see quit-teardown.js for why the two differ.
   Reuses the same beginCancel() the cancel-batch IPC handler uses, so there is
   one kill implementation. Awaits the held run promise so the encoder has
   really exited and the run's finally (partial cleanup, prefs) has completed
   before we close — no fixed timeout, and no waiting out the current file.
   quitState.closing (set by handleCloseAttempt) makes any close attempt
   arriving while this runs a no-op, so nothing stacks or re-kills. */
function stopRunThenQuit(finish) {
  quitViaCancel({
    runtime,
    releasePauseGate,
    stopQueue: () => { stopRequested = true; },
    runPromise: () => runPromise,
    onSettled: () => {
      quitState.forceQuit = true;   // set only now — teardown is genuinely done
      quitState.closing = false;
      finish();
    }
  });
}

/* ─── Attribution: native About panel + a way to read the shipped licenses ──
   SkinnyVideo is GPL-2.0-or-later and bundles GPL'd FFmpeg/x265, MIT Electron
   and OFL fonts, so the credits below are an obligation, not decoration. We
   use macOS's own About panel and the default app menu — no new UI, no
   renderer involvement.

   The full license texts ship as plain files in Contents/Resources/licenses
   (see extraResources in package.json); the menu item just opens that folder
   in Finder so they can actually be read. */
const CREDITS = [
  'Licensed under the GNU GPL, version 2 or later.',
  "This software uses code of FFmpeg licensed under the GPLv2 and its source can be downloaded from the project's releases page.",
  'HEVC encoding by x265 (GPL-2.0-or-later). Hardware encoding via Apple VideoToolbox.',
  'Built with Electron (MIT). Fonts: Geist and Geist Mono by Vercel, Poppins by Indian Type Foundry — SIL Open Font License 1.1.',
  'Updates via electron-updater (MIT).',
].join('\n');

/* Packaged: Contents/Resources/licenses. Dev (`npm start`): there is no
   Resources dir, so fall back to the repo root, which holds LICENSE. */
function licensesDir() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'licenses')
    : path.join(__dirname, '..', '..');
}

function installAboutAndCredits() {
  app.setAboutPanelOptions({
    applicationName: 'SkinnyVideo',
    applicationVersion: app.getVersion(),
    copyright: '© 2026 Pritam Malakar',
    credits: CREDITS,
  });

  /* Take the default menu Electron already built and insert one item, rather
     than restating the whole macOS template (and risking losing standard
     roles). items[0] is the app-name menu; index 1 puts us directly below
     "About SkinnyVideo". */
  const menu = Menu.getApplicationMenu();
  if (!menu || !menu.items.length || !menu.items[0].submenu) return;
  menu.items[0].submenu.insert(1, new MenuItem({
    label: 'Third-Party Licenses',
    click: () => { shell.openPath(licensesDir()); },
  }));
  Menu.setApplicationMenu(menu);
}

app.whenReady().then(() => {
  migrateLegacyUserData();   // MUST precede any prefs/history read
  loadPrefs();
  /* Self-contained engine: verify the BUNDLED ffmpeg/ffprobe exist and are
     executable at launch. No fallback to any other binary — if it's gone the
     app cannot encode, so fail fast with plain-language wording. */
  const engine = ffmpegStatus();
  if (!engine.ok) {
    dialog.showErrorBox('SkinnyVideo', ENGINE_MISSING_MESSAGE);
    app.quit();
    return;
  }
  createWindow();
  installAboutAndCredits();

  /* Auto-update. Packaged builds only; the module no-ops in dev. isBusy is the
     same pair the close-guard arms on, so a downloaded update can never
     interrupt an encode or the container flush that follows it. */
  updater = installUpdater({
    isBusy: () => queueRunning || quitState.isFinalizing,
    getWindow: () => mainWindow,
  });

  /* Orphaned-partial sweep (BUG 2 — intended scope, documented):
     On every launch we scan EVERY output folder SkinnyVideo has written to —
     prefs.outputRoots accumulates each destination ever used — plus any
     in-flight pendingDests, for leftover .tmp.mp4 partials under their
     "Compressed_" run folders. This catches partials from ANY interrupted
     run, not just the most recent one. We deliberately do NOT walk the whole
     filesystem: scope is "known SkinnyVideo output locations". pendingDests is
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

/* Close-guard for ⌘Q / app-level quit — IDENTICAL behavior to the red button:
   same predicate, same dialog, same teardown. forceQuit (set once teardown
   finishes) lets the re-entrant quit through. */
app.on('before-quit', (e) => {
  handleCloseAttempt(quitState, {
    preventDefault: () => e.preventDefault(),
    confirmQuit: confirmStopAndQuit,
    proceed: () => stopRunThenQuit(() => app.quit())
  });
});

/* ─── Window canvas mirror ────────────────────────────────────────────────
   The RENDERER is the authority on which theme is active: it seeds from
   matchMedia at startup, live-follows system appearance changes, and honours a
   manual segment click that overrides both. Main deliberately does NOT listen
   to nativeTheme — that would fight the manual override and repaint the window
   to a colour the renderer is not showing. Main only mirrors what it is told.

   Fire-and-forget (send/on, not invoke/handle): the renderer has already
   repainted by the time this arrives and has nothing to wait for. Guarded for a
   window destroyed between the send and the delivery. */
ipcMain.on('theme:changed', (_evt, payload) => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.setBackgroundColor(canvasFor(!!(payload && payload.dark)));
});

/* Version read from Electron's bundled identity — single source of truth.
   In dev this falls through to package.json; in a packaged .app it returns
   CFBundleShortVersionString. The renderer fetches it once at startup. */
ipcMain.handle('app-version', async () => app.getVersion());

/* Pro Mode foundation: the per-tier encode defaults, resolved renderer-side
   into each batch payload's `settings` field at enqueue time. Single source
   of truth is pipeline.js tierDefaults (derived from TIER_CONSTANTS) — the
   renderer only caches this table at startup, it never defines values. */
ipcMain.handle('get-tier-defaults', async () => ({
  regular: tierDefaults('regular'),
  preserve: tierDefaults('preserve')
}));

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
  quitState.queueRunning = true;   // arm the close-guard for the WHOLE run
  stopRequested = false;

  /* Mark this run's real (non-dry) destinations as in-flight so a crash
     mid-encode is recoverable: the next launch scans these for orphaned
     .tmp.mp4 partials. Cleared in the finally below once the run ends
     cleanly (whether finished or user-stopped).
     Also fold them into prefs.outputRoots — the persistent set of every
     destination SkinnyVideo has ever written to — so the launch sweep (BUG 2)
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
    // Track the finalizing window off the same progress stream the renderer sees.
    applyProgressToQuitState(quitState, channel, payload);
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
  };

  let totals;
  try {
    // Per-batch loop + auto-advance live in the shared, test-covered runner.
    // `batches` is the SAME array 'enqueue-batch' appends to → mid-run drops drain.
    liveBatches = batches;
    /* Hold the promise so the close-guard's "Stop and quit" can await REAL
       encoder exit + this finally block, rather than a guessed timeout. */
    runPromise = runQueue(batches, { send, isStopRequested: () => stopRequested, rt });
    totals = await runPromise;
  } finally {
    liveBatches = null;   // run over → further drops start a fresh run
    queueRunning = false;
    runPromise = null;
    quitState.queueRunning = false;   // run ended → guard disarms, close is instant
    quitState.isFinalizing = false;   // run ended → never leave the guard armed
    // Run reached a clean end — no orphaned partials to recover next launch.
    try { prefs.pendingDests = []; savePrefs(); } catch { /* non-fatal */ }
    send('queue-finished', {
      totals: totals || { processed: 0, failed: 0, failedCopied: 0, failedNoCopy: 0, failedDestLost: 0, destLost: false, skippedNonVideo: 0, reclaimed: 0, alreadyDone: 0 },
      stopped: stopRequested
    });
    /* The queue is idle now, so a restart prompt held back during the run is
       safe to show. No-op when there is nothing pending. */
    try { updater.notifyIdle(); } catch { /* never let this break a run's teardown */ }
  }
  return { ok: true };
});

ipcMain.handle('stop-queue', async () => {
  stopRequested = true;
  // Wake any pipeline parked on the pause gate so it re-checks shouldStop and
  // tears down — the event gate has no poll to notice the stop on its own.
  for (const state of runtime.values()) releasePauseGate(state);
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

/* PHANTOM FREEZE: removing a QUEUED batch in the renderer mid-run previously
   only filtered the renderer's view — liveBatches still held the batch, so the
   engine encoded it with no visible row (Start hidden, nothing Running → the
   app read as frozen until queue-finished). The renderer now reports the
   removal here; the tombstone makes runQueue skip the batch at its turn.
   Tombstone (not splice): liveBatches is being iterated by index — splicing
   would shift the loop. A batch already past its turn (running/finished) is
   unaffected: the flag is only consulted at the turn boundary. Ids are
   session-monotonic (renderer nextId++), so a tombstone can never collide
   with a later batch. Safe to set with no run live (pre-Start removals never
   reach the Start payload anyway — it's rebuilt from the renderer queue). */
ipcMain.handle('remove-batch', async (_evt, batchId) => {
  rt(batchId).removed = true;
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
  // Already paused, or the batch has resolved (nothing left to pause) → no-op.
  if (state.paused || state.resolved) return { ok: false };
  /* Set the flag FIRST, independent of a live child. Between files (the ffprobe
     window) there is no child to SIGSTOP, but the pre-spawn gate in queue-runner
     reads state.paused to hold the next encoder — so pause must register even
     with no child. SIGSTOP only when a child is actually encoding. */
  state.paused = true;
  if (state.child) { try { state.child.kill('SIGSTOP'); } catch {} }
  sendBatchUpdate(batchId, 'Paused');
  return { ok: true };
});

ipcMain.handle('resume-batch', async (_evt, batchId) => {
  const state = rt(batchId);
  if (!state.paused) return { ok: false };
  /* Clear the flag unconditionally — a probe-window pause stopped no child, so
     resume must NOT require a SIGCONT-able child. Clearing state.paused releases
     the queue-runner gate; SIGCONT only when a child was actually suspended. The
     queue can't hang: the gate polls this flag. */
  state.paused = false;
  releasePauseGate(state);   // wake a probe-window (no-child) gated pipeline
  if (state.child) { try { state.child.kill('SIGCONT'); } catch {} }
  sendBatchUpdate(batchId, 'Running');
  return { ok: true };
});

const CANCEL_HARD_MS = 4000;   // pill must resolve within this, no matter what

ipcMain.handle('cancel-batch', async (_evt, batchId) => {
  const state = rt(batchId);
  /* Shared with "Stop and quit" (quit-teardown.js) so there is ONE kill
     implementation: flag cancelled, SIGCONT+unpause so a suspended child can
     receive the signal, wake the pause gate so a probe-window (no-child)
     pipeline re-checks isCancelled, SIGTERM, then a bounded SIGKILL.
     (pipeline's runCmd also resolves immediately on the cancel flag, so the
     batch loop never waits for the child to confirm death.) */
  beginCancel(state, { releasePauseGate });
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
   - reset-drive → zeroes counters for ONE drive (no file effects).
   - get-history → the run ledger (see below), newest first. */

/* ─────────── History (v2.10.0) ───────────
   One entry per completed REAL run. It rides the SAME add-reclaimed call that
   credits the lifetime ledger — one channel, one savePrefs write, and the two
   can never disagree about which runs counted. Both policy gates live in the
   renderer (dry-run excluded at maybeCreditBatch; zero done files → no call);
   the cap, the ordering and the shape guard live in ./history-store so tests
   can exercise them directly. */

ipcMain.handle('get-history', async () => readHistory(prefs));

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

  /* History rides along on this same call — appended before the single
     savePrefs below so the ledger and the run list are written together. */
  appendHistoryEntry(prefs, payload.historyEntry, now);

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

/* Reveal a run FOLDER in Finder, clicked from a History row. Async
   stat-gated + isDirectory-checked in ../main/reveal — never the sync
   existsSync of 'reveal-path' above, which would block the main thread on an
   unmounted/slow volume and tells the renderer nothing. */
ipcMain.handle('reveal-folder', async (_evt, p) => revealFolder(p));
