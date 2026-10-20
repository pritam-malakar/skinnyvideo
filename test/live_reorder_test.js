/* 3.3.1 Item 4 — reordering queued batches during a run changes what runs next.
   REAL main.js + REAL preload + REAL renderer + REAL queue-runner/pipeline;
   only the native folder dialog is stubbed and ffmpeg/ffprobe are a scripted
   fake child (spawn spy), so no VideoToolbox or real encode is needed.
   userData is a temp folder (set before main.js loads).

   LIVE      three queued folder batches A, B, C; Start; while A runs, drag C onto
             B (a real drop event on the queue rows) → the renderer shows A, C, B
             and main encodes A → C → B.
   IDLE      guard: the same drag before Start reorders the Start payload (passes
             on old code too).
   Main side: reorderPending moves only batches that have not started; a
   started or unknown id is never moved.

   FAIL-ON-OLD (3.3.0 / 399c3d2): the drop reordered the renderer's list only —
   displayed A, C, B, executed A → B → C.
   Run: ./node_modules/.bin/electron test/live_reorder_test.js */
const { app, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');

const ROOT = path.join(__dirname, '..');
const PASS = [], FAIL = [];
const check = (c, l) => { (c ? PASS : FAIL).push(l); console.log((c ? 'PASS' : 'FAIL') + ': ' + l); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const SB = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sv-reorder-')));
app.setPath('userData', path.join(SB, 'userData'));
fs.mkdirSync(path.join(SB, 'userData'), { recursive: true });
fs.writeFileSync(path.join(SB, 'userData', 'prefs.json'), JSON.stringify({ autoUpdateCheck: false }));
const OUT = path.join(SB, 'Out'); fs.mkdirSync(OUT);
const DIRS = ['CardA', 'CardB', 'CardC'].map((n) => { const d = path.join(SB, n); fs.mkdirSync(d); fs.writeFileSync(path.join(d, `${n}.mov`), 'x'); return d; });

/* spawn spy — installed before main.js (→ pipeline.js) is required. */
const cp = require('child_process');
const realSpawn = cp.spawn;
const encodes = [];   // source file of each encode, in spawn order
cp.spawn = function (cmd, args, opts) {
  if (!/resources\/bin\/ff(mpeg|probe)$/.test(cmd)) return realSpawn.call(this, cmd, args, opts);
  const c = new EventEmitter();
  c.stdout = new PassThrough(); c.stderr = new PassThrough();
  let closed = false;
  const close = (code) => { if (closed) return; closed = true; clearInterval(t); c.emit('exit', code, null); setTimeout(() => { c.stdout.end(); c.stderr.end(); c.emit('close', code, null); }, 10); };
  c.kill = (sig) => { if (sig !== 'SIGSTOP' && sig !== 'SIGCONT') close(255); return true; };
  let t = null;
  if (/ffprobe$/.test(cmd)) {
    const frames = args.some((a) => String(a).startsWith('frame='));
    setTimeout(() => { c.stdout.write(JSON.stringify(frames ? { frames: [{}] } : {
      streams: [{ codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, pix_fmt: 'yuv420p', duration: '2.0' }],
      format: { duration: '2.0', size: '100' } })); close(0); }, 5);
    return c;
  }
  if (args.includes('-version')) { setTimeout(() => { c.stdout.write('ffmpeg version fake\n'); close(0); }, 5); return c; }
  const out = args[args.length - 1];
  encodes.push(path.basename(args[args.indexOf('-i') + 1]));
  fs.writeFileSync(out, 'partial');
  let n = 0;
  t = setInterval(() => { n++; c.stderr.write(`frame=${n} time=00:00:0${Math.min(n, 2)}.00 speed=1x\r`); if (n >= 25) { fs.appendFileSync(out, 'done'); close(0); } }, 40);
  return c;
};

dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [OUT] });
require(path.join(ROOT, 'src/main/main.js'));
const { reorderPending } = require(path.join(ROOT, 'src/main/queue-runner'));

function finish() {
  try { fs.rmSync(SB, { recursive: true, force: true }); } catch {}
  console.log(`\n[live-reorder] PASS: ${PASS.length} FAIL: ${FAIL.length}`);
  app.exit(FAIL.length ? 1 : 0);
}
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  // ── main side, pure ──
  {
    const st = new Map([[1, { started: true }], [2, {}], [3, {}], [4, {}]]);
    const rt = (id) => st.get(id) || {};
    const bs = [1, 2, 3, 4].map((id) => ({ id }));
    if (typeof reorderPending === 'function') {
      reorderPending(bs, [4, 1, 3, 2, 99], rt);
      check(bs.map((b) => b.id).join() === '1,4,3,2', `reorderPending: only not-started batches move (${bs.map((b) => b.id)})`);
    } else check(false, 'reorderPending: exported by queue-runner');
  }

  const { BrowserWindow } = require('electron');
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) { check(false, 'main.js created a window'); return finish(); }
  if (win.webContents.isLoading()) await new Promise((r) => win.webContents.once('did-finish-load', r));
  const js = (code) => win.webContents.executeJavaScript(code, true);
  await wait(300);

  const stageAll = async () => {
    for (const d of DIRS) {
      await js(`stagePicked(${JSON.stringify([d])})`);
      for (let k = 0; k < 50 && !(await js('current.scanned')); k++) await wait(50);
      await js(`document.getElementById('choose-dest').click(); true`); await wait(200);
      await js(`document.getElementById('add-to-queue').click(); true`); await wait(250);
    }
    return js(`queue.filter((b) => b.status === 'queued').map((b) => b.id)`);
  };
  // A real drop of `fromId`'s row onto `toId`'s row, through the row's own listener.
  const drag = (fromId, toId) => js(`(() => {
    const dt = new DataTransfer(); dt.setData('text/plain', '${fromId}');
    const row = document.querySelector('.qbatch[data-id="${toId}"]');
    row.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    return true; })()`);
  const shown = () => js(`[...document.querySelectorAll('.qbatch')].map((li) => Number(li.dataset.id))`);
  const nameOf = (ids, all) => ids.map((id) => ['A', 'B', 'C'][all.indexOf(id)]).join('');

  // ── LIVE ──
  const ids = await stageAll();
  check(ids.length === 3, `three batches queued (${ids})`);
  await js(`document.getElementById('start').click(); true`);
  for (let k = 0; k < 100 && !(encodes.length >= 1); k++) await wait(30);
  const st1 = await js(`queue.find((b) => b.id === ${ids[0]}).status`);
  await drag(ids[2], ids[1]);
  await wait(100);
  const disp = await shown();
  check(st1 === 'running' && nameOf(disp, ids) === 'ACB', `LIVE: while A runs, the queue shows A, C, B (A ${st1}; shown ${nameOf(disp, ids)})`);
  for (let k = 0; k < 300 && encodes.length < 3; k++) await wait(50);
  await wait(500);
  const exec = encodes.map((f) => f.replace('.mov', '').replace('Card', '')).join('');
  check(exec === 'ACB', `LIVE: execution order A → C → B (got ${exec.split('').join(' → ')})`);
  check(exec === nameOf(await shown(), ids), `LIVE: displayed order equals executed order (shown ${nameOf(await shown(), ids)}, ran ${exec})`);

  // ── IDLE guard ──
  for (let k = 0; k < 100 && (await js('runActive')); k++) await wait(50);
  await js(`queue.length = 0; renderQueue(); true`);
  encodes.length = 0;
  const ids2 = await stageAll();
  await drag(ids2[2], ids2[1]);
  await wait(100);
  await js(`document.getElementById('start').click(); true`);
  for (let k = 0; k < 300 && encodes.length < 3; k++) await wait(50);
  await wait(300);
  const exec2 = encodes.map((f) => f.replace('.mov', '').replace('Card', '')).join('');
  check(exec2 === 'ACB', `IDLE: reorder before Start runs A → C → B (got ${exec2})`);

  finish();
});
