/* Multi-item drops: every video the scan finds must be staged and encoded.
   REAL main.js + preload + renderer + IPC + pipeline, hermetic userData.

   FAIL-ON-OLD: stageFiles kept only the dropped paths that were themselves
   videos (`paths.filter((p) => videoPaths.has(p))`), so a dropped FOLDER was
   discarded — the count said 4 while 2 were encoded (folder + loose files), or
   none at all and Add stayed disabled (two folders).
   Run: ./node_modules/.bin/electron test/drop_multi_source_test.js */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const FFMPEG = path.join(ROOT, 'resources/bin/ffmpeg');
const PASS = [], FAIL = [];
const check = (c, l) => { (c ? PASS : FAIL).push(l); console.log((c ? 'PASS' : 'FAIL') + ': ' + l); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const SB = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sv-dropmulti-')));
app.setPath('userData', path.join(SB, 'userData'));

const clip = (p) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const r = spawnSync(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30:duration=1',
    '-c:v', 'h264_videotoolbox', '-pix_fmt', 'yuv420p', p]);
  if (r.status !== 0) throw new Error('fixture encode failed: ' + r.stderr);
  return p;
};

/* Shape 1: two folders, 2 clips each, one of them nested in a subfolder.
   Shape 2: one folder (2 clips) + two loose files. */
const A = path.join(SB, 'CardA'), B = path.join(SB, 'CardB'), C = path.join(SB, 'CardC');
const clips1 = [clip(path.join(A, 'A1.mov')), clip(path.join(A, 'A2.mov')),
  clip(path.join(B, 'B1.mov')), clip(path.join(B, 'Sub', 'B2.mov'))];
const clips2 = [clip(path.join(C, 'C1.mov')), clip(path.join(C, 'C2.mov')),
  clip(path.join(SB, 'Loose1.mov')), clip(path.join(SB, 'Loose2.mov'))];
fs.writeFileSync(path.join(A, 'notes.txt'), 'not a video');   // must never be staged

require(path.join(ROOT, 'src/main/main.js'));

function finish() {
  try { fs.rmSync(SB, { recursive: true, force: true }); } catch {}
  console.log(`\n[drop-multi] PASS: ${PASS.length} FAIL: ${FAIL.length}`);
  app.exit(FAIL.length ? 1 : 0);
}
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) { check(false, 'main.js created a window'); return finish(); }
  if (win.webContents.isLoading()) await new Promise((r) => win.webContents.once('did-finish-load', r));
  const js = (code) => win.webContents.executeJavaScript(code, true);

  for (const [label, dropped, expected] of [
    ['two folders (one with a subfolder)', [A, B], clips1],
    ['one folder + two loose files', [C, path.join(SB, 'Loose1.mov'), path.join(SB, 'Loose2.mov')], clips2],
  ]) {
    const dest = fs.mkdtempSync(path.join(SB, 'out-'));
    await js(`(() => { clearDrop(); return true; })()`);
    /* The drop handler's own branch for multi-item drops, given the paths
       webUtils.getPathForFile returns for the dropped items. */
    await js(`stageFiles(${JSON.stringify(dropped)}); true`);
    for (let i = 0; i < 300 && !(await js('!!current.scanned')); i++) await wait(100);

    const staged = (await js('current.fileSources')).slice().sort();
    const rows = await js('current.files.length');
    const count = await js('current.videoCount');
    check(count === expected.length && rows === expected.length,
      `[${label}] the drop counts ${expected.length} videos (count=${count}, rows=${rows})`);
    check(JSON.stringify(staged) === JSON.stringify(expected.slice().sort()),
      `[${label}] every scanned video is staged (${staged.length}: ${staged.map((p) => path.basename(p)).join(', ')})`);
    check(!staged.some((p) => p.endsWith('.txt')), `[${label}] the non-video in the folder is not staged`);
    // Run it: the destination dialog is the only thing stubbed.
    await js(`(() => { current.dest = ${JSON.stringify(dest)}; destPathEl.textContent = current.dest;
      destPathEl.classList.remove('placeholder'); updateAddState(); return true; })()`);
    check(!(await js('!!document.getElementById("add-to-queue").disabled')),
      `[${label}] with a destination chosen, Add is enabled`);
    await js(`(() => { addCurrentToQueue(); document.getElementById('start').click(); return true; })()`);
    let b = null;
    for (let i = 0; i < 1200; i++) {
      b = await js(`(() => { const x = queue[queue.length - 1]; return x ? { status: x.status, processed: x.processed, failed: x.failed } : null; })()`);
      if (b && (b.status === 'done' || b.status === 'failed' || b.status === 'cancelled')) break;
      await wait(250);
    }
    const outs = [];
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith('.mp4')) outs.push(path.basename(p)); } };
    walk(dest);
    check(b && b.status === 'done' && b.processed === expected.length && b.failed === 0,
      `[${label}] the run processed all ${expected.length} (${JSON.stringify(b)})`);
    check(outs.length === expected.length,
      `[${label}] ${expected.length} .mp4 files written (${outs.sort().join(', ')})`);
    await js(`(() => { const d = document.getElementById('dismiss-summary'); if (d) d.click(); return true; })()`);
    await wait(300);
  }
  finish();
});
