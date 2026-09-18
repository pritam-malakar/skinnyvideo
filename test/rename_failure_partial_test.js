/* A final rename that fails must not lose the partial.
   REAL main.js + preload + renderer + IPC + pipeline. The run folder is made
   read-only while the encoder is writing, so pipeline's
   `fsp.rename(tmpPath, finalPath)` throws: the batch fails, the .tmp.mp4 is
   still on disk, and it must STILL be recorded in prefs.pendingPartials so the
   next launch offers to clean it up.

   FAIL-ON-OLD: the end-of-run prune dropped every path this run recorded,
   whether or not it was gone from disk, so the leftover became invisible to
   orphan recovery.
   Run: ./node_modules/.bin/electron test/rename_failure_partial_test.js */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const FFMPEG = path.join(ROOT, 'resources/bin/ffmpeg');
const { findOrphanPartials } = require(path.join(ROOT, 'src/encoder/orphans'));

const PASS = [], FAIL = [];
const check = (c, l) => { (c ? PASS : FAIL).push(l); console.log((c ? 'PASS' : 'FAIL') + ': ' + l); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const SB = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sv-renamefail-')));
const UD = path.join(SB, 'userData');
app.setPath('userData', UD);
const SRC = path.join(SB, 'Card'); const DEST = path.join(SB, 'Out');
fs.mkdirSync(SRC); fs.mkdirSync(DEST);
const CLIP = path.join(SRC, 'clip.mov');
{
  // Long enough (1080p, 10 s, re-encoded with x265) that the run folder can be
  // locked while the encoder is still writing the partial.
  const r = spawnSync(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30:duration=10',
    '-c:v', 'h264_videotoolbox', '-b:v', '20M', '-pix_fmt', 'yuv420p', CLIP]);
  if (r.status !== 0) throw new Error('fixture encode failed: ' + r.stderr);
}
const prefs = () => { try { return JSON.parse(fs.readFileSync(path.join(UD, 'prefs.json'), 'utf8')); } catch { return {}; } };
const locked = [];
function finish() {
  for (const d of locked) { try { fs.chmodSync(d, 0o755); } catch {} }
  try { fs.rmSync(SB, { recursive: true, force: true }); } catch {}
  console.log(`\n[rename-failure] PASS: ${PASS.length} FAIL: ${FAIL.length}`);
  app.exit(FAIL.length ? 1 : 0);
}
app.on('window-all-closed', () => {});

require(path.join(ROOT, 'src/main/main.js'));

app.whenReady().then(async () => {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) { check(false, 'main.js created a window'); return finish(); }
  if (win.webContents.isLoading()) await new Promise((r) => win.webContents.once('did-finish-load', r));
  const js = (code) => win.webContents.executeJavaScript(code, true);

  await js(`stageFiles(${JSON.stringify([CLIP])}); true`);
  for (let i = 0; i < 300 && !(await js('!!current.scanned')); i++) await wait(100);
  await js(`(() => { document.querySelector('input[name="tier"][value="preserve"]').click();
    current.dest = ${JSON.stringify(DEST)}; destPathEl.textContent = current.dest;
    destPathEl.classList.remove('placeholder'); updateAddState(); addCurrentToQueue();
    document.getElementById('start').click(); return true; })()`);

  /* Wait for the recorded partial to appear, then take write permission away
     from the folder it must be renamed inside. */
  let tmp = null;
  for (let i = 0; i < 600 && !tmp; i++) {
    const rec = prefs().pendingPartials || [];
    tmp = rec.find((p) => { try { return fs.statSync(p).size > 0; } catch { return false; } }) || null;
    if (!tmp) await wait(100);
  }
  check(!!tmp, `the pipeline recorded a partial while encoding (${tmp ? path.basename(tmp) : 'none'})`);
  if (!tmp) return finish();
  const dir = path.dirname(tmp);
  fs.chmodSync(dir, 0o500);          // r-x: the rename below cannot succeed
  locked.push(dir);
  check((fs.statSync(dir).mode & 0o200) === 0, `the run folder is read-only before the rename (${path.basename(dir)})`);

  let b = null;
  for (let i = 0; i < 1200; i++) {
    b = await js(`(() => { const x = queue[queue.length - 1]; return x ? { status: x.status, processed: x.processed, failed: x.failed, err: x.lastResult && x.lastResult.error } : null; })()`);
    if (b && ['done', 'failed', 'cancelled'].includes(b.status)) break;
    await wait(250);
  }
  check(b && b.status === 'failed' && b.processed === 0, `the batch fails when the rename throws (${JSON.stringify(b)})`);
  check(/EACCES|EPERM|permission/i.test(String(b && b.err)), `the failure is the rename's own error (${b && b.err})`);
  check(fs.existsSync(tmp), 'the .tmp.mp4 is still on disk');
  check(!fs.existsSync(tmp.replace(/\.tmp(_\d+)?\.mp4$/, '.mp4')), 'no final .mp4 was produced');

  await wait(1500);   // let the run's teardown write prefs
  const rec = prefs().pendingPartials || [];
  check(rec.includes(tmp), `the partial is STILL recorded after the run ends (${JSON.stringify(rec.map((p) => path.basename(p)))})`);

  /* Exactly the call main makes on the next launch. */
  const offered = (await findOrphanPartials(rec, [DEST])).map((o) => o.path);
  check(offered.includes(tmp), `next launch would offer it for cleanup (${offered.map((p) => path.basename(p)).join(', ') || 'none'})`);

  /* And the counterpart: a partial that IS gone leaves the set. */
  fs.chmodSync(dir, 0o755);
  fs.unlinkSync(tmp);
  const stillThere = (await findOrphanPartials(prefs().pendingPartials || [], [DEST])).map((o) => o.path);
  check(!stillThere.includes(tmp), 'once the file is gone it is no longer offered');
  finish();
});
