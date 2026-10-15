/* v3.2.2 — run summary scope + the Stopped batch, on the REAL GUI path:
   real main.js (start-queue / stop-queue / pause-batch handlers, runQueue,
   pipeline, bundled ffmpeg) + real preload + real renderer. Hermetic userData.

   RUN 1   batch A = a1, a2, a3 (a3 deleted before Start → fails at staging).
   RUN 2   batch B = b1, b2, with A still in the queue. The summary must
           describe run 2 only: 2 done, 0 failed, "across 2 files in 1 batch".
           FAIL-ON-OLD: summaryCountsHtml and doneBatches walked the whole
           queue → "4 done · 1 failed … in 2 batches".
   RUN 3   batch S = s1 (long), s2. Pause s1 mid-encode, then Stop after
           current file. s1 must finish, the batch ends "Stopped" (orange), s2
           reads "Not started" and is counted under its own label — never
           failed. A pause asked for after Stop is refused.
           FAIL-ON-OLD: stop never resumed the SIGSTOPped encoder — the run
           hung; and a stopped batch ended Done with s2 marked failed.
   Run: ./node_modules/.bin/electron test/run_summary_test.js */
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

const SB = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sv-runsummary-')));
app.setPath('userData', path.join(SB, 'userData'));

const clip = (p, size = '320x240', secs = 1) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const r = spawnSync(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=30:duration=${secs}`,
    '-c:v', 'h264_videotoolbox', '-pix_fmt', 'yuv420p', p]);
  if (r.status !== 0) throw new Error('fixture encode failed: ' + r.stderr);
  return p;
};

function finish() {
  try { fs.rmSync(SB, { recursive: true, force: true }); } catch {}
  console.log(`\n[run-summary] PASS: ${PASS.length} FAIL: ${FAIL.length}`);
  app.exit(FAIL.length ? 1 : 0);
}
app.on('window-all-closed', () => {});

if (!fs.existsSync(FFMPEG)) { console.log('SKIP: bundled ffmpeg missing'); app.whenReady().then(() => app.exit(0)); }
else {
  const A = [clip(path.join(SB, 'A', 'a1.mov')), clip(path.join(SB, 'A', 'a2.mov')), clip(path.join(SB, 'A', 'a3.mov'))];
  const B = [clip(path.join(SB, 'B', 'b1.mov')), clip(path.join(SB, 'B', 'b2.mov'))];
  const S = [clip(path.join(SB, 'S', 's1.mov'), '1920x1080', 30), clip(path.join(SB, 'S', 's2.mov'))];
  const DEST = path.join(SB, 'Out'); fs.mkdirSync(DEST);

  require(path.join(ROOT, 'src/main/main.js'));

  app.whenReady().then(async () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) { check(false, 'main.js created a window'); return finish(); }
    if (win.webContents.isLoading()) await new Promise((r) => win.webContents.once('did-finish-load', r));
    const js = (code) => win.webContents.executeJavaScript(code, true);
    await wait(300);

    const add = async (paths) => {
      await js(`(() => { clearDrop(); return true; })()`);
      await js(`stageFiles(${JSON.stringify(paths)}); true`);
      for (let i = 0; i < 300 && !(await js('!!current.scanned')); i++) await wait(100);
      await js(`(() => { current.dest = ${JSON.stringify(DEST)}; destPathEl.textContent = current.dest;
        destPathEl.classList.remove('placeholder'); updateAddState(); addCurrentToQueue(); return true; })()`);
    };
    const runToEnd = async (ms, during) => {
      await js(`document.getElementById('start').click(); true`);
      for (let i = 0; i < 100 && !(await js('runActive')); i++) await wait(50);
      if (during) await during();
      const end = Date.now() + ms;
      while (Date.now() < end && (await js('runActive'))) await wait(150);
      return !(await js('runActive'));
    };
    const summary = () => js(`(() => {
      const segs = {}; for (const s of summaryBody.querySelectorAll('.summary-counts .seg'))
        segs[s.querySelector('.lbl').textContent] = Number(s.querySelector('.num').textContent);
      const r = summaryBody.querySelector('.reclaimed-line');
      return { segs, reclaimed: r ? r.textContent : '' };
    })()`);

    // ── RUN 1: A, with a3 gone before Start ──
    await add(A);
    fs.unlinkSync(A[2]);
    check(await runToEnd(60000), 'run 1 finished');
    const s1 = await summary();
    console.log('  run 1 summary', JSON.stringify(s1));
    check(s1.segs.done === 2 && s1.segs.failed === 1, `run 1: 2 done, 1 failed (${JSON.stringify(s1.segs)})`);

    // ── RUN 2: B, with A still in the queue ──
    await js(`document.getElementById('dismiss-summary').click(); true`);
    await add(B);
    check(await js('queue.length') === 2, 'batch A is still in the queue for run 2');
    check(await runToEnd(60000), 'run 2 finished');
    const s2 = await summary();
    console.log('  run 2 summary', JSON.stringify(s2));
    check(s2.segs.done === 2, `run 2 counts 2 done, not A's too (got ${s2.segs.done})`);
    check(s2.segs.failed === 0, `run 2 does not count A's failed file (got ${s2.segs.failed})`);
    check(/across 2 files in 1 batch\./.test(s2.reclaimed), `run 2: "across 2 files in 1 batch" (got "${s2.reclaimed.trim()}")`);

    // ── RUN 3: S — pause mid-encode, then Stop after current file ──
    await js(`document.getElementById('dismiss-summary').click(); true`);
    await add(S);
    const sId = await js('queue[queue.length - 1].id');
    let pauseOk = null, latePause = null;
    const ended = await runToEnd(30000, async () => {
      for (let i = 0; i < 400; i++) {
        if (await js(`(queue.find((b) => b.id === ${sId}).files[0].progress || 0) > 0`)) break;
        await wait(25);
      }
      pauseOk = await js(`window.api.pauseBatch(${sId})`);
      await wait(400);
      await js(`document.getElementById('stop').click(); true`);
      await wait(100);
      latePause = await js(`window.api.pauseBatch(${sId})`);   // must not re-freeze a stopping run
    });
    check(pauseOk && pauseOk.ok === true, `s1 paused mid-encode (${JSON.stringify(pauseOk)})`);
    check(ended, 'Stop while paused: the run ended (no hang)');
    check(latePause && latePause.ok === false, `a pause requested after Stop is refused (${JSON.stringify(latePause)})`);
    const st = await js(`(() => { const b = queue.find((x) => x.id === ${sId});
      const pill = document.querySelector('.qbatch[data-id="${sId}"] .qbatch-status .pill');
      const rows = [...document.querySelectorAll('.qbatch[data-id="${sId}"] .qrow')].map((r) => r.querySelector('.status .pill').textContent.trim());
      return { status: b.status, files: b.files.map((f) => f.status), pill: pill && pill.textContent.trim(),
        pillBg: pill && getComputedStyle(pill).backgroundColor, rows }; })()`);
    console.log('  run 3 batch', JSON.stringify(st));
    const outs = fs.readdirSync(DEST, { recursive: true }).filter((f) => /s1\.mp4$/.test(f));
    check(outs.length === 1, `s1 finished and was written (${outs})`);
    check(st.status === 'stopped' && st.pill === 'Stopped', `batch ends "Stopped" (status ${st.status}, pill ${st.pill})`);
    check(st.pillBg === 'rgb(255, 170, 94)', `Stopped pill is the Stop orange (${st.pillBg})`);
    check(st.files[0] === 'done' && st.files[1] === 'notstarted' && st.rows[1] === 'Not started',
      `s1 done, s2 "Not started" (files ${JSON.stringify(st.files)}, rows ${JSON.stringify(st.rows)})`);
    const s3 = await summary();
    console.log('  run 3 summary', JSON.stringify(s3));
    check(s3.segs.done === 1 && s3.segs.failed === 0 && s3.segs['not started'] === 1,
      `run 3 summary: 1 done, 0 failed, 1 not started (${JSON.stringify(s3.segs)})`);

    /* Cleanup prompt wording: a leftover .tmp.mp4 is "incomplete" — a SIGTERM'd
       encoder can leave a playable truncated file, so never "can't be played". */
    win.webContents.send('orphans-found', { orphans: [{ path: path.join(DEST, 'x.tmp.mp4'), size: 1000 }] });
    await wait(400);
    const prompt = await js(`document.body.innerText`);
    check(/incomplete\./.test(prompt) && !/can.t be played/.test(prompt),
      'cleanup prompt calls leftovers "incomplete", never "can\'t be played"');
    finish();
  }).catch((e) => { console.error(e); FAIL.push('unexpected throw: ' + e.message); finish(); });
}
