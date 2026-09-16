/* Sandboxed renderer — REAL main.js, REAL preload, REAL renderer, sandbox:true.
   Proves, from inside the sandboxed page:
     · the window really is sandboxed (no require/process in the page)
     · every window.api method the bridge exposes is callable over IPC
     · drag-drop: webUtils.getPathForFile resolves a real OS-backed File, and a
       synthetic drop on the dropzone stages that exact path
     · theme switching: setTheme round-trips to the NSWindow background colour
     · IPC validation: bad scan-source / start-queue / enqueue-batch payloads are
       refused with a clear error, a real batchToPayload shape is accepted
     · open-path / reveal-path act only inside a known output root
   Dialog-opening calls (chooseDestination, browseSource, browseSourceFiles) are
   not invoked — they would block on a modal; they share the same invoke path.
   Run: ./node_modules/.bin/electron test/sandbox_ipc_test.js */
const { app, BrowserWindow, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const FFMPEG = path.join(ROOT, 'resources/bin/ffmpeg');
const { CANVAS } = require(path.join(ROOT, 'src/shared/theme'));

const PASS = [], FAIL = [];
const check = (c, l) => { (c ? PASS : FAIL).push(l); console.log((c ? 'PASS' : 'FAIL') + ': ' + l); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sv-sandbox-ipc-')));
app.setPath('userData', path.join(SANDBOX, 'userData'));
const SRC = path.join(SANDBOX, 'Footage');
const DEST = path.join(SANDBOX, 'Out');
fs.mkdirSync(SRC); fs.mkdirSync(DEST);
const CLIP = path.join(SRC, 'clip.mov');
spawnSync(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30:duration=1',
  '-c:v', 'h264_videotoolbox', '-pix_fmt', 'yuv420p', CLIP]);

/* Never open Finder or a log viewer from a test: record instead. */
const opened = [];
shell.openPath = async (p) => { opened.push(['open', p]); return ''; };
shell.showItemInFolder = (p) => { opened.push(['reveal', p]); };

require(path.join(ROOT, 'src/main/main.js'));

function finish() {
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch {}
  console.log('\n[sandbox-ipc] PASS: ' + PASS.length + ' FAIL: ' + FAIL.length);
  app.exit(FAIL.length ? 1 : 0);
}
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  try {
    await wait(50);
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) { check(false, 'main.js created a window'); return finish(); }
    await new Promise((r) => (win.webContents.isLoading() ? win.webContents.once('did-finish-load', r) : r()));
    const js = (code) => win.webContents.executeJavaScript(code, true);

    // ── sandbox is real
    check(win.webContents.getLastWebPreferences().sandbox === true, 'window webPreferences.sandbox === true');
    check(await js(`typeof require === 'undefined' && typeof process === 'undefined'`), 'page has no require / process');

    // ── bridge surface
    const keys = await js(`Object.keys(window.api).filter((k) => typeof window.api[k] === 'function').sort()`);
    const declared = [...fs.readFileSync(path.join(ROOT, 'src/main/preload.js'), 'utf8').matchAll(/^\s{2}(\w+):\s*\(/gm)].map((m) => m[1]).sort();
    check(declared.length > 30 && JSON.stringify(keys) === JSON.stringify(declared),
      `window.api exposes all ${declared.length} functions preload.js declares (got ${keys.length})`);

    // ── every non-dialog IPC call, over the real bridge
    const results = await js(`(async () => {
      const a = window.api, out = {};
      const t = async (name, fn) => { try { out[name] = { ok: true, v: await fn() }; } catch (e) { out[name] = { ok: false, e: String(e && e.message || e) }; } };
      await t('getAppVersion', () => a.getAppVersion());
      await t('getTierDefaults', () => a.getTierDefaults());
      await t('checkEngine', () => a.checkEngine());
      await t('statPath', () => a.statPath(${JSON.stringify(SRC)}));
      await t('scanSource', () => a.scanSource(${JSON.stringify(SRC)}));
      await t('scanFiles', () => a.scanFiles([${JSON.stringify(CLIP)}]));
      await t('saveLastSrc', () => a.saveLastSrc(${JSON.stringify(SRC)}));
      await t('freeSpace', () => a.freeSpace(${JSON.stringify(DEST)}));
      await t('getLifetimeDrives', () => a.getLifetimeDrives());
      await t('addReclaimed', () => a.addReclaimed({ dest: ${JSON.stringify(DEST)}, filesAdded: 0, addedBytes: 0 }));
      await t('resetDrive', () => a.resetDrive('/nonexistent-drive'));
      await t('getHistory', () => a.getHistory());
      await t('getUpdatePref', () => a.getUpdatePref());
      await t('setUpdatePref', () => a.setUpdatePref(false));
      await t('updateAction', () => a.updateAction('later'));
      await t('setBatchSkips', () => a.setBatchSkips(9999, []));
      await t('pauseBatch', () => a.pauseBatch(9999));
      await t('resumeBatch', () => a.resumeBatch(9999));
      await t('cancelBatch', () => a.cancelBatch(9999));
      await t('removeBatch', () => a.removeBatch(9999));
      await t('stopQueue', () => a.stopQueue());
      await t('deleteOrphans', () => a.deleteOrphans([]));
      await t('revealInFinder', () => a.revealInFinder(${JSON.stringify(path.join(SANDBOX, 'nope.mov'))}));
      await t('revealFolder', () => a.revealFolder(${JSON.stringify(path.join(SANDBOX, 'nope'))}));
      for (const on of ['onProgress', 'onBatchStatus', 'onQueueFinished', 'onOrphansFound', 'onUpdateAvailable']) await t(on, () => { a[on](() => {}); });
      return out;
    })()`);
    const failed = Object.entries(results).filter(([, r]) => !r.ok);
    check(failed.length === 0, `${Object.keys(results).length} bridge calls resolved without error${failed.length ? ': ' + JSON.stringify(failed) : ''}`);
    check(results.scanSource.ok && results.scanSource.v.videos.length === 1, 'scanSource over the sandboxed bridge found the clip');
    check(results.checkEngine.ok && results.checkEngine.v.ok === true, 'checkEngine reports the bundled engine');

    // ── drag-drop: a real OS-backed File via CDP, then a drop on the dropzone
    const dbg = win.webContents.debugger;
    dbg.attach('1.3');
    await js(`(() => { const i = document.createElement('input'); i.type = 'file'; i.id = '__t_file'; document.body.appendChild(i); })()`);
    const { root } = await dbg.sendCommand('DOM.getDocument');
    const { nodeId } = await dbg.sendCommand('DOM.querySelector', { nodeId: root.nodeId, selector: '#__t_file' });
    await dbg.sendCommand('DOM.setFileInputFiles', { nodeId, files: [CLIP] });
    dbg.detach();
    const got = await js(`window.api.pathForFile(document.getElementById('__t_file').files[0])`);
    check(got === CLIP, `webUtils.getPathForFile resolves the real path under sandbox (${got})`);
    check(await js(`window.api.pathForFile(new File(['x'], 'x.txt')) === ''`), 'a memory-only File yields no path (no throw)');
    await js(`(() => {
      const dt = new DataTransfer(); dt.items.add(document.getElementById('__t_file').files[0]);
      document.getElementById('dropzone').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    })()`);
    let staged = null;
    for (let i = 0; i < 50 && !(staged && staged.length); i++) { await wait(100); staged = await js('current.fileSources'); }
    check(Array.isArray(staged) && staged.length === 1 && staged[0] === CLIP, `drop staged the dropped file by path (${JSON.stringify(staged)})`);

    // ── theme switching round-trip
    await js('window.api.setTheme(true)'); await wait(150);
    check(win.getBackgroundColor().toUpperCase().startsWith(CANVAS.dark.toUpperCase()), `setTheme(true) → window ${win.getBackgroundColor()}`);
    await js('window.api.setTheme(false)'); await wait(150);
    check(win.getBackgroundColor().toUpperCase().startsWith(CANVAS.light.toUpperCase()), `setTheme(false) → window ${win.getBackgroundColor()}`);

    // ── validation, over the real channels
    const v = await js(`(async () => {
      const a = window.api, good = { id: 7, src: ${JSON.stringify(SRC)}, dest: ${JSON.stringify(DEST)}, tier: 'regular', dryRun: true, kind: 'folder', settings: undefined, fileSources: [], skipped: [] };
      const scanErr = await a.scanSource('').then(() => null, (e) => String(e.message));
      const scanErr2 = await a.scanSource({ path: '/' }).then(() => null, (e) => String(e.message));
      return {
        scanErr, scanErr2,
        notArray: await a.startQueue({ ...good }),
        badTier: await a.startQueue([{ ...good, tier: 'ultra' }]),
        badId: await a.startQueue([{ ...good, id: '7' }]),
        extraKey: await a.startQueue([{ ...good, cmd: 'rm -rf /' }]),
        badSkipped: await a.startQueue([{ ...good, skipped: [1] }]),
        badDry: await a.startQueue([{ ...good, dryRun: 'yes' }]),
        folderNoSrc: await a.startQueue([{ ...good, src: null }]),
        enqNull: await a.enqueueBatch(null),
        enqGood: await a.enqueueBatch({ ...good, id: 8 }),
        filesNullSrc: await a.enqueueBatch({ ...good, id: 9, kind: 'files', src: null, fileSources: [${JSON.stringify(CLIP)}] }),
        goodRun: await a.startQueue([{ ...good, dryRun: false }]),
      };
    })()`);
    check(/non-empty string/.test(v.scanErr || '') && /non-empty string/.test(v.scanErr2 || ''), `scan-source rejects '' and non-strings (${v.scanErr})`);
    for (const k of ['notArray', 'badTier', 'badId', 'extraKey', 'badSkipped', 'badDry', 'folderNoSrc', 'enqNull']) {
      check(v[k] && v[k].ok === false && /refused/.test(v[k].error || ''), `${k} refused: ${v[k] && v[k].error}`);
    }
    check(v.enqGood.ok === true, 'a real batchToPayload shape passes enqueue-batch');
    check(v.filesNullSrc.ok === true, 'a files-kind batch with src null passes');
    check(v.goodRun.ok === true, 'a real batchToPayload shape runs a real encode');

    // ── open-path / reveal-path limits. DEST became a known root via the real run above.
    const inside = path.join(DEST, 'Compressed_x', 'compress.log');
    fs.mkdirSync(path.dirname(inside), { recursive: true }); fs.writeFileSync(inside, 'log');
    const outsideLink = path.join(DEST, 'escape');          // symlink inside the root pointing out of it
    fs.symlinkSync(os.homedir(), outsideLink);
    const lim = await js(`(async () => ({
      outside: await window.api.openPath(${JSON.stringify(path.join(SRC, 'clip.mov'))}),
      etc: await window.api.revealPath('/etc/hosts'),
      viaLink: await window.api.revealPath(${JSON.stringify(outsideLink)}),
      missing: await window.api.openPath(${JSON.stringify(path.join(DEST, 'gone.log'))}),
      open: await window.api.openPath(${JSON.stringify(inside)}),
      reveal: await window.api.revealPath(${JSON.stringify(path.dirname(inside))}),
    }))()`);
    check(lim.outside.ok === false && lim.etc.ok === false, 'open/reveal outside every output root refused');
    check(lim.viaLink.ok === false, 'a symlink inside a root that resolves outside it is refused (realpath)');
    check(lim.missing.ok === false, 'a missing path is refused');
    check(lim.open.ok === true && lim.reveal.ok === true, 'paths inside a known output root are acted on');
    check(JSON.stringify(opened) === JSON.stringify([['open', inside], ['reveal', path.dirname(inside)]]),
      `shell was called only for the two allowed paths (${JSON.stringify(opened)})`);
  } catch (e) {
    check(false, 'unexpected error: ' + (e && e.stack || e));
  }
  finish();
});
