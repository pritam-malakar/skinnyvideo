/* 3.3.0 Item 4 — the launch prompt offers Keep only for complete leftovers.
   REAL renderer + REAL preload; main's 'orphans-found' message is sent by hand
   with what main now sends (classifyPartials output), and the IPC calls the
   buttons make are recorded.

   MIXED     one complete + one incomplete leftover → first a "Keep finished
             file?" prompt with Keep + Delete; Keep → recover-orphans([complete]).
             Then the 3.2.2 cleanup prompt for the incomplete one ("incomplete",
             Delete only — no Keep-as-finished) → delete-orphans([incomplete]).
   INCOMPLETE-ONLY → only the 3.2.2 prompt; no recover call is possible.

   G1 (3.3.1) a delete-only leftover says why: "incomplete", "recorded by an older
             version of SkinnyVideo", or "its run folder is missing" (and counts when mixed).

   FAIL-ON-OLD (3.2.2): one prompt for everything, Delete only. G1 on 3.3.1's
   first build: every delete-only leftover was called "incomplete".
   Run: ./node_modules/.bin/electron test/orphan_prompt_test.js */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PASS = [], FAIL = [];
const check = (c, l) => { (c ? PASS : FAIL).push(l); console.log((c ? 'PASS' : 'FAIL') + ': ' + l); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const calls = [];
ipcMain.handle('app-version', async () => '3.3.0-test');
ipcMain.handle('check-engine', async () => ({ ok: true }));
ipcMain.handle('get-tier-defaults', async () => ({ regular: { vcodec: 'hevc_videotoolbox', qv: 62 }, preserve: { vcodec: 'libx265', crf: 18, preset: 'medium' } }));
ipcMain.handle('get-lifetime-drives', async () => []);
ipcMain.handle('delete-orphans', async (_e, p) => { calls.push(['delete', p]); return { deleted: p.length }; });
ipcMain.handle('recover-orphans', async (_e, p) => { calls.push(['recover', p]); return { recovered: p.length }; });
['save-last-src', 'add-reclaimed', 'open-path', 'reveal-path', 'reset-drive', 'free-space', 'stat-path'].forEach((c) => ipcMain.handle(c, async () => ({ ok: true })));

const W = '/out/Compressed_2026-10-20_0500/Card/whole.tmp.mp4', C = '/out/Compressed_2026-10-20_0500/Card/cut.tmp.mp4';

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1100, height: 900, show: false,
    webPreferences: { preload: path.join(ROOT, 'src/main/preload.js'), contextIsolation: true, sandbox: true } });
  const run = (js) => win.webContents.executeJavaScript(js);
  await win.loadFile(path.join(ROOT, 'src/renderer/index.html'));
  await wait(400);
  const modal = () => run(`(() => { const c = document.querySelector('.modal-card'); if (!c) return null;
    return { title: c.querySelector('.modal-title').textContent, body: c.querySelector('.modal-body').textContent,
             buttons: [...c.querySelectorAll('.modal-actions button')].map((b) => b.textContent) }; })()`);
  const click = (label) => run(`(() => { const b = [...document.querySelectorAll('.modal-actions button')].find((x) => x.textContent === ${JSON.stringify(label)}); if (b) b.click(); return !!b; })()`);

  // ── MIXED ──
  win.webContents.send('orphans-found', { orphans: [
    { path: W, size: 5_000_000, complete: true, final: W.replace('.tmp', ''), source: '/src/whole.mov' },
    { path: C, size: 1_000_000, complete: false, final: C.replace('.tmp', ''), source: '/src/cut.mov' }] });
  await wait(300);
  let m = await modal();
  check(m && /finished/i.test(m.title) && m.buttons.includes('Keep') && m.buttons.some((b) => /^Delete/.test(b)),
    `MIXED: first prompt offers Keep + Delete for the complete file (${JSON.stringify(m)})`);
  check(m && /1<\/?\w*>? ?file|1 file/.test(m.body.replace(/\s+/g, ' ')) || (m && m.body.includes('1')), 'MIXED: first prompt counts only the complete file');
  await click('Keep'); await wait(300);
  check(calls.length === 1 && calls[0][0] === 'recover' && JSON.stringify(calls[0][1]) === JSON.stringify([W]), `MIXED: Keep → recover-orphans([complete]) (${JSON.stringify(calls)})`);
  m = await modal();
  check(m && /incomplete/.test(m.body) && !m.buttons.includes('Keep') && m.buttons.some((b) => /^Delete/.test(b)),
    `MIXED: then the 3.2.2 prompt — "incomplete", Delete, no Keep-as-finished (${JSON.stringify(m)})`);
  await click(m.buttons.find((b) => /^Delete/.test(b))); await wait(300);
  check(calls.length === 2 && calls[1][0] === 'delete' && JSON.stringify(calls[1][1]) === JSON.stringify([C]), `MIXED: Delete → delete-orphans([incomplete]) only (${JSON.stringify(calls)})`);

  // ── INCOMPLETE-ONLY ──
  calls.length = 0;
  win.webContents.send('orphans-found', { orphans: [{ path: C, size: 1_000_000, complete: false }] });
  await wait(300);
  m = await modal();
  check(m && /incomplete/.test(m.body) && !m.buttons.includes('Keep'), `INCOMPLETE-ONLY: only the 3.2.2 prompt (${JSON.stringify(m)})`);
  await run(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); true`); await wait(200);
  check(calls.length === 0, 'INCOMPLETE-ONLY: dismissing deletes and recovers nothing');

  // ── 3.3.1 G1: a delete-only prompt says WHY (main's classifyPartials `reason`) ──
  const promptFor = async (orphans) => {
    calls.length = 0;
    win.webContents.send('orphans-found', { orphans });
    await wait(300);
    const mm = await modal();
    await run(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); true`); await wait(200);
    return mm;
  };
  const O = '/out/Compressed_2026-10-20_0500/Card/old.tmp.mp4', G = '/out/Compressed_2026-10-20_0600/Card/gone.tmp.mp4';
  m = await promptFor([{ path: C, size: 1_000_000, complete: false, reason: 'incomplete' }]);
  check(m && m.body.includes('It’s incomplete.') && !/older version|run folder/.test(m.body) && m.title === 'Clean up unfinished files?',
    `G1 INCOMPLETE: "It’s incomplete." (${JSON.stringify(m)})`);
  m = await promptFor([{ path: O, size: 1_000_000, complete: false, reason: 'older-version' }]);
  check(m && m.body.includes('It can’t be kept: it was recorded by an older version of SkinnyVideo.') && !/incomplete/.test(m.body) && !m.buttons.includes('Keep'),
    `G1 OLDER-VERSION: "It can’t be kept: it was recorded by an older version of SkinnyVideo." (${JSON.stringify(m)})`);
  m = await promptFor([{ path: G, size: 1_000_000, complete: false, reason: 'run-folder-missing' }]);
  check(m && m.body.includes('It can’t be kept: its run folder is missing.') && !/incomplete/.test(m.body) && !m.buttons.includes('Keep'),
    `G1 RUN-FOLDER-MISSING: "It can’t be kept: its run folder is missing." (${JSON.stringify(m)})`);
  m = await promptFor([{ path: C, size: 1, complete: false, reason: 'incomplete' }, { path: O, size: 1, complete: false, reason: 'older-version' },
    { path: G, size: 1, complete: false, reason: 'run-folder-missing' }, { path: G + '2', size: 1, complete: false, reason: 'run-folder-missing' }]);
  check(m && m.body.includes('1 is incomplete. 1 can’t be kept: it was recorded by an older version of SkinnyVideo. 2 can’t be kept: their run folders are missing.'),
    `G1 MIXED: one sentence per reason, with counts (${JSON.stringify(m)})`);
  check(calls.length === 0, 'G1: dismissing deletes nothing');

  console.log(`\n[orphan-prompt] PASS: ${PASS.length} FAIL: ${FAIL.length}`);
  app.exit(FAIL.length ? 1 : 0);
});
