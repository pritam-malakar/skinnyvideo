const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  chooseDestination: (defaultPath) => ipcRenderer.invoke('choose-destination', defaultPath),
  scanSource: (srcPath) => ipcRenderer.invoke('scan-source', srcPath),
  startQueue: (batches) => ipcRenderer.invoke('start-queue', batches),
  stopQueue: () => ipcRenderer.invoke('stop-queue'),
  openPath: (p) => ipcRenderer.invoke('open-path', p),
  revealPath: (p) => ipcRenderer.invoke('reveal-path', p),
  onProgress: (cb) => ipcRenderer.on('progress', (_e, d) => cb(d)),
  onBatchStatus: (cb) => ipcRenderer.on('batch-status', (_e, d) => cb(d)),
  onQueueFinished: (cb) => ipcRenderer.on('queue-finished', (_e, d) => cb(d)),
  pathForFile: (file) => {
    try { return webUtils.getPathForFile(file); } catch { return null; }
  }
});
