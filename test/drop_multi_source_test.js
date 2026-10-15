/* Multi-item drops: every video the scan finds must be staged and encoded.
   REAL main.js + preload + renderer + IPC + pipeline, hermetic userData.

   FAIL-ON-OLD: stageFiles kept only the dropped paths that were themselves
   videos (`paths.filter((p) => videoPaths.has(p))`), so a dropped FOLDER was
   discarded — the count said 4 while 2 were encoded (folder + loose files), or
   none at all and Add stayed disabled (two folders).
   Run: ./node_modules/.bin/electron test/drop_multi_source_test.js */
const { app, BrowserWindow, dialog } = require('electron');
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

/* Browse (v3.2.2): the picker accepts folders too. D holds a nested clip and a
   SYMLINKED folder whose clip must stay out (walkAll skips linked dirs). */
const D = path.join(SB, 'CardD'), LINKED = path.join(SB, 'Elsewhere');
const clipsD = [clip(path.join(D, 'D1.mov')), clip(path.join(D, 'Sub', 'D2.mov'))];
clip(path.join(LINKED, 'X1.mov'));
fs.symlinkSync(LINKED, path.join(D, 'LinkDir'));
const loose3 = clip(path.join(SB, 'Loose3.mov'));
/* A card whose output folder lives inside it: an earlier run's output and a
   partial must be left out — and the staging line must say so. */
const E = path.join(SB, 'CardE');
clip(path.join(E, 'E1.mov'));
clip(path.join(E, 'Compressed_2026-10-15_0612', 'E1.mp4'));
fs.writeFileSync(path.join(E, 'Compressed_2026-10-15_0612', 'E2.tmp.mp4'), 'partial');
/* Only the native dialog is stubbed; main.js's real 'browse-source-files'
   handler builds the options and saves lastSrc. */
let pickNext = null; const dialogCalls = [];
dialog.showOpenDialog = async (_win, opts) => { dialogCalls.push(opts); return { canceled: false, filePaths: pickNext }; };

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

  /* ── Browse: one picker for folders and files, routed like a drop ──
     FAIL-ON-OLD: properties were ['openFile','multiSelections'] and every pick
     went through stageFiles, so a single picked folder became a file-list batch. */
  const browse = async (paths) => {
    await js(`(() => { clearDrop(); return true; })()`);
    pickNext = paths;
    await js(`document.getElementById('dz-browse').click(); true`);
    for (let i = 0; i < 300 && !(await js('!!current.scanned')); i++) await wait(100);
    return js(`({ kind: current.kind, src: current.src, sources: current.fileSources.slice().sort(), files: current.files.map((f) => f.path).sort() })`);
  };
  {
    const one = await browse([D]);
    const props = (dialogCalls[0] && dialogCalls[0].properties) || [];
    check(['openFile', 'openDirectory', 'multiSelections'].every((p) => props.includes(p)),
      `picker accepts files AND folders (properties ${JSON.stringify(props)})`);
    check(!!(dialogCalls[0] && dialogCalls[0].filters && dialogCalls[0].filters[0].name === 'Video files'), 'video filters kept');
    check(one.kind === 'folder' && one.src === D, `[folder pick] one folder goes through stageSource like a folder drop (kind ${one.kind})`);
    check(JSON.stringify(one.files) === JSON.stringify(clipsD.slice().sort()),
      `[folder pick] every clip in the folder, symlinked folder skipped (${one.files.map((p) => path.basename(p))})`);
    await browse([loose3]);
    check(dialogCalls[1] && dialogCalls[1].defaultPath === D, `lastSrc is the picked folder itself (next defaultPath ${dialogCalls[1] && dialogCalls[1].defaultPath})`);
    const mixed = await browse([D, loose3]);
    check(dialogCalls[2] && dialogCalls[2].defaultPath === SB, `lastSrc is dirname(first file) after a file pick (${dialogCalls[2] && dialogCalls[2].defaultPath})`);
    const want = [...clipsD, loose3].sort();
    check(mixed.kind === 'files' && JSON.stringify(mixed.sources) === JSON.stringify(want),
      `[folder + file pick] stageFiles stages every video in the folder plus the file, symlinked folder skipped (${mixed.kind}: ${mixed.sources.map((p) => path.basename(p))})`);
    const plainLine = await js('dropStatusCount.textContent');
    check(plainLine === '3 videos', `nothing skipped → no skip text on the staging line ("${plainLine}")`);
    /* Output folders inside the source: counted, never silent. Both routes. */
    await browse([E]);
    const folderLine = await js('dropStatusCount.textContent');
    check(folderLine === '1 video · 2 skipped inside SkinnyVideo output folders', `[folder] staging line counts skipped outputs ("${folderLine}")`);
    await browse([E, loose3]);
    const filesLine = await js('dropStatusCount.textContent');
    check(filesLine === '2 videos · 2 skipped inside SkinnyVideo output folders', `[files] staging line counts skipped outputs ("${filesLine}")`);
  }
  finish();
});
