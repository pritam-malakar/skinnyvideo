/* Repo regression (v2.2.4): per-file progress bar tracks the live encode.
   Guards the off-by-one introduced by the v2.2.3 per-tray .qfile-head strip
   (filesList.children[idx] pointed at the strip / the previous row). Real
   renderer + real preload + real IPC mirroring main.js + real runQueue + real
   pipeline (real ffmpeg). A MULTI-file batch (short clip then long clip) so a
   file finishes while a later one is still encoding — required to catch the
   "stomp" (assertion c). Asserts against REAL progress events:
     (a) the RUNNING file's .qrow .status .progressbar > i width CLIMBS past 0
         (a later sample strictly greater than an earlier one — not just >0 once);
     (b) a DONE file's bar reaches EXACTLY 100% and is green;
     (c) while a LATER file encodes, the EARLIER done file's bar STAYS at 100%
         (proves the running file's % is no longer written onto the done row).
   Fail-on-old (strip present): (a) stuck 0, (c) stomped below 100. Pass-on-new. */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');

const ROOT = path.join(__dirname, '..');
const { runBatch, scanFolder } = require(path.join(ROOT, 'src/encoder/pipeline'));
const { runQueue } = require(path.join(ROOT, 'src/main/queue-runner'));

const SHORT = '/Users/macmini1/Downloads/CompressorTest/Source/Project A/C0224.mov';  // ~11s → finishes fast
const LONG = '/Users/macmini1/Downloads/CompressorTest/gate/FAQs.mov';                // ~240s → still running
const DEST = path.join(os.tmpdir(), 'skinnyvideo-fileprog-out');

const PASS = [], FAIL = [];
const check = (c, l) => { (c ? PASS : FAIL).push(l); console.log((c ? 'PASS' : 'FAIL') + ': ' + l); };

let win, queueRunning = false, stopRequested = false, liveBatches = null;
const rtm = new Map(); const rt = (id) => { if (!rtm.has(id)) rtm.set(id, {}); return rtm.get(id); };
let browseQ = [[SHORT, LONG]], bc = 0;
const send = (ch, p) => { if (win && !win.isDestroyed()) win.webContents.send(ch, p); };

ipcMain.handle('app-version', async () => '2.2.4-test');
ipcMain.handle('scan-files', async (_e, paths) => {
  const v = []; let ig = 0, ts = 0;
  for (const p of paths) { const s = await scanFolder(p); v.push(...s.videos); ig += s.ignored || 0; ts += s.totalSize || 0; }
  return { rootKind: 'files', root: paths[0], videos: v, ignored: ig, totalSize: ts };
});
ipcMain.handle('scan-source', async (_e, p) => scanFolder(p));
ipcMain.handle('browse-source-files', async () => browseQ[bc++] || []);
ipcMain.handle('choose-destination', async () => DEST);
ipcMain.handle('stat-path', async (_e, p) => { try { const s = await fsp.stat(p); return { isFile: s.isFile(), isDirectory: s.isDirectory() }; } catch { return null; } });
['save-last-src', 'add-reclaimed', 'delete-orphans', 'open-path', 'reveal-path', 'reset-drive', 'reveal-in-finder', 'pause-batch', 'resume-batch'].forEach((c) => ipcMain.handle(c, async () => ({ ok: true })));
ipcMain.handle('get-lifetime-drives', async () => []);
ipcMain.handle('free-space', async () => ({ free: 9e15 }));
ipcMain.handle('check-engine', async () => ({ ok: true }));
ipcMain.handle('set-batch-skips', async (_e, { batchId, skipped }) => { rt(batchId).skips = new Set(skipped || []); return { ok: true }; });
ipcMain.handle('start-queue', async (_e, batches) => {
  if (queueRunning) return { ok: false }; queueRunning = true; stopRequested = false; liveBatches = batches;
  try { await runQueue(batches, { send, isStopRequested: () => stopRequested, rt }); }
  finally { liveBatches = null; queueRunning = false; send('queue-finished', { totals: { processed: 0, reclaimed: 0 }, stopped: stopRequested }); }
  return { ok: true };
});
ipcMain.handle('enqueue-batch', async () => ({ ok: true, absorbed: false }));
ipcMain.handle('stop-queue', async () => { stopRequested = true; return { ok: true }; });
ipcMain.handle('cancel-batch', async (_e, id) => { const s = rt(id); s.cancelled = true; if (s.child) { try { s.child.kill('SIGTERM'); } catch {} setTimeout(() => { try { s.child.kill('SIGKILL'); } catch {} }, 500); } return { ok: true }; });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// read every file row's status + bar width (raw, not computed) + bar computed color
const readRows = (run) => run(`(() => {
  const root = document.querySelector('#queue .qbatch');
  const fl = root && root.querySelector('.qbatch-files');
  if (!fl) return [];
  return [...fl.querySelectorAll('.qrow')].map((r) => {
    const i = r.querySelector('.status .progressbar > i');
    const st = [...r.classList].find(c => c.startsWith('status-'));
    return { fpath: r.dataset.fpath, status: st, width: i ? (i.style.width || '0%') : 'no-bar',
             color: i ? getComputedStyle(i).backgroundColor : '' };
  });
})()`);
const pctNum = (w) => { const n = parseFloat(w); return Number.isFinite(n) ? n : NaN; };

app.whenReady().then(async () => {
  fs.rmSync(DEST, { recursive: true, force: true }); fs.mkdirSync(DEST, { recursive: true });
  win = new BrowserWindow({ width: 1100, height: 1000, show: false, backgroundColor: '#0c0e12',
    webPreferences: { preload: path.join(ROOT, 'src/main/preload.js'), contextIsolation: true, sandbox: false } });
  const run = (js) => win.webContents.executeJavaScript(js);
  await win.loadFile(path.join(ROOT, 'src/renderer/index.html'));
  await wait(400);

  // resolve --green to rgb via a probe (compare resolved rgb, not the hex string)
  const greenRgb = await run(`(() => { const e=document.createElement('span'); document.body.appendChild(e); e.style.color='var(--green)'; const c=getComputedStyle(e).color; e.remove(); return c; })()`);

  // seed one 2-file batch (short then long) via the real add flow
  await run(`document.getElementById('choose-dest').click(); true;`); await wait(150);
  await run(`document.getElementById('dz-browse').click(); true;`); await wait(800);
  await run(`document.getElementById('add-to-queue').click(); true;`); await wait(300);
  const nFiles = await run(`(queue && queue[0] ? queue[0].files.length : 0)`);
  check(nFiles === 2, `multi-file batch seeded (got ${nFiles} files)`);

  await run(`document.getElementById('start').click(); true;`);

  /* Phase 1 — sample WHILE one file is done and a later file is running.
     Collect the running row's widths over time + the done row's width/color. */
  const runningWidths = [];
  const doneWidths = [];
  let doneColor = '', sawSplit = false, sampled = 0;
  for (let i = 0; i < 90 && sampled < 10; i++) {
    await wait(400);
    const rows = await readRows(run);
    const done = rows.find((r) => r.status === 'status-done');
    const running = rows.find((r) => r.status === 'status-running');
    if (done && running) {
      sawSplit = true; sampled++;
      runningWidths.push(pctNum(running.width));
      doneWidths.push(pctNum(done.width));
      doneColor = done.color;
    } else if (sawSplit) {
      break;   // moved past the done+running window
    }
  }
  check(sawSplit, `reached the done+running window (sampled ${sampled}x)`);

  // (a) RUNNING file's bar climbs PAST 0 — a later sample strictly greater than an earlier one
  const maxRun = Math.max(0, ...runningWidths.filter(Number.isFinite));
  const climbed = runningWidths.some((w, i) => Number.isFinite(w) && runningWidths.slice(0, i).some((p) => Number.isFinite(p) && w > p + 0.01));
  check(maxRun > 0 && climbed,
    `(a) RUNNING file's bar climbs past 0 (max=${maxRun.toFixed(1)}%, widths=[${runningWidths.map(w=>Number.isFinite(w)?w.toFixed(1):'?').join(',')}])`);

  // (c) EARLIER done file's bar STAYS at 100% across every sample (no stomp)
  const doneAll100 = doneWidths.length > 0 && doneWidths.every((w) => Math.abs(w - 100) < 0.5);
  check(doneAll100,
    `(c) earlier DONE file's bar stays 100% while a later file encodes (widths=[${doneWidths.map(w=>Number.isFinite(w)?w.toFixed(1):'?').join(',')}])`);

  // (b) the DONE file's bar is EXACTLY 100% and GREEN
  check(doneWidths.length > 0 && Math.abs(doneWidths[doneWidths.length - 1] - 100) < 0.5,
    `(b) DONE file's bar is exactly 100% (last=${doneWidths[doneWidths.length-1]})`);
  check(doneColor === greenRgb,
    `(b) DONE file's bar is green (got ${doneColor}, want ${greenRgb})`);

  // stop the long encode + reap
  await run(`window.api.stopQueue && window.api.stopQueue(); true;`).catch(() => {});
  try { for (const [, s] of rtm) { s.cancelled = true; if (s.child) s.child.kill('SIGKILL'); } } catch {}
  await wait(500);

  console.log('\nPASS:', PASS.length, 'FAIL:', FAIL.length);
  app.exit(FAIL.length ? 1 : 0);
}).catch((e) => { console.error('TEST ERROR', e); app.exit(2); });
