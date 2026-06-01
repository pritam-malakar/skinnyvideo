const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getAppVersion: () => ipcRenderer.invoke('app-version'),
  chooseDestination: (defaultPath) => ipcRenderer.invoke('choose-destination', defaultPath),
  scanSource: (srcPath) => ipcRenderer.invoke('scan-source', srcPath),
  startQueue: (batches) => ipcRenderer.invoke('start-queue', batches),
  stopQueue: () => ipcRenderer.invoke('stop-queue'),
  pauseBatch: (id) => ipcRenderer.invoke('pause-batch', id),
  resumeBatch: (id) => ipcRenderer.invoke('resume-batch', id),
  cancelBatch: (id) => ipcRenderer.invoke('cancel-batch', id),
  browseSource: (suggestedFallback) => ipcRenderer.invoke('browse-source', suggestedFallback),
  browseSourceFiles: (suggestedFallback) => ipcRenderer.invoke('browse-source-files', suggestedFallback),
  scanFiles: (paths) => ipcRenderer.invoke('scan-files', paths),
  statPath: (p) => ipcRenderer.invoke('stat-path', p),
  saveLastSrc: (p) => ipcRenderer.invoke('save-last-src', p),
  getLifetimeDrives: () => ipcRenderer.invoke('get-lifetime-drives'),
  addReclaimed: (payload) => ipcRenderer.invoke('add-reclaimed', payload),
  resetDrive: (driveKey) => ipcRenderer.invoke('reset-drive', driveKey),
  openPath: (p) => ipcRenderer.invoke('open-path', p),
  revealPath: (p) => ipcRenderer.invoke('reveal-path', p),
  onProgress: (cb) => ipcRenderer.on('progress', (_e, d) => cb(d)),
  onBatchStatus: (cb) => ipcRenderer.on('batch-status', (_e, d) => cb(d)),
  onQueueFinished: (cb) => ipcRenderer.on('queue-finished', (_e, d) => cb(d)),
  pathForFile: (file) => {
    try { return webUtils.getPathForFile(file); } catch { return null; }
  }
});
