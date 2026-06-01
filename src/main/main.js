const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { runBatch, dryRunBatch, scanFolder, getBinaries } = require('../encoder/pipeline');

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
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
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

ipcMain.handle('start-queue', async (_evt, batches) => {
  if (queueRunning) return { ok: false, error: 'Already running' };
  queueRunning = true;
  stopRequested = false;

  const send = (channel, payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
  };

  const totals = { processed: 0, failed: 0, skippedNonVideo: 0, reclaimed: 0, alreadyDone: 0 };

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
        onSpawn: (child) => { state.child = child; }
      };

      const result = isDry
        ? await dryRunBatch(batch, (progress) => send('progress', { batchId: batch.id, ...progress }))
        : await runBatch(batch, control, (progress) => send('progress', { batchId: batch.id, ...progress }));

      totals.processed += result.processed || 0;
      totals.failed += result.failed || 0;
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
  // If paused, unpause first so the child can react to SIGTERM.
  if (state.child && state.paused) {
    try { state.child.kill('SIGCONT'); } catch {}
    state.paused = false;
  }
  if (state.child) {
    try { state.child.kill('SIGTERM'); } catch {}
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

ipcMain.handle('open-path', async (_evt, p) => {
  if (p && fs.existsSync(p)) shell.openPath(p);
});

ipcMain.handle('reveal-path', async (_evt, p) => {
  if (p && fs.existsSync(p)) shell.showItemInFolder(p);
});
