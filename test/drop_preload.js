/* Test-only preload: the REAL preload, with pathForFile mapping an in-memory
   File to "/drop/<name>" (a synthetic drop has no on-disk path for
   webUtils.getPathForFile to return). Everything else is the real API.
   Needs a window with sandbox: false (to require the real preload). */
const { contextBridge } = require('electron');
const expose = contextBridge.exposeInMainWorld.bind(contextBridge);
contextBridge.exposeInMainWorld = (key, api) => expose(key, key === 'api' ? { ...api, pathForFile: (f) => (f && f.name ? '/drop/' + f.name : null) } : api);
require('../src/main/preload.js');
