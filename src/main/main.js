const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { runBatch, dryRunBatch, scanFolder, getBinaries } = require('../encoder/pipeline');

let mainWindow = null;
let stopRequested = false;
let queueRunning = false;

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
      const result = isDry
        ? await dryRunBatch(batch, (progress) => send('progress', { batchId: batch.id, ...progress }))
        : await runBatch(batch, () => stopRequested, (progress) => send('progress', { batchId: batch.id, ...progress }));

      totals.processed += result.processed || 0;
      totals.failed += result.failed || 0;
      totals.skippedNonVideo += result.skippedNonVideo || 0;
      totals.reclaimed += result.reclaimed || 0;
      totals.alreadyDone += result.alreadyDone || 0;

      send('batch-status', {
        id: batch.id,
        status: result.failed > 0 ? 'Done (with failures)' : 'Done',
        result
      });

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

ipcMain.handle('open-path', async (_evt, p) => {
  if (p && fs.existsSync(p)) shell.openPath(p);
});

ipcMain.handle('reveal-path', async (_evt, p) => {
  if (p && fs.existsSync(p)) shell.showItemInFolder(p);
});
