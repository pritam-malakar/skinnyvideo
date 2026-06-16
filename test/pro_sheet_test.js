/* Pro Mode UX guard — persistent inline settings panel, live arming,
   slider-only controls, mode visual identity.
   Real renderer + real preload + real IPC shape + real stage.js + real
   pipeline encodes + the REAL src/main/queue-runner.js loop. start-queue /
   enqueue-batch / get-tier-defaults handlers MIRROR main.js.

   The panel REPLACED the modal sheet (UX revision): in Pro Mode a glass
   settings panel below the tier cards is ALWAYS visible, showing the selected
   tier's sliders. Sliding arms values LIVE (armed.settings + session memory);
   there is no Confirm/Cancel — Add batch is the commit point. NO modal sheet
   may ever appear; every mode asserts that.

   MODE=untouched  (default) DECISIVE: Pro Mode with untouched sliders →
                   payload settings byte-identical to a Simple batch of the
                   same tier. Panel visible in Pro, absent in Simple. Panel
                   tier chip shows the REAL tier name — the same string the
                   tier card renders (single TIER_LABEL constant).
   MODE=override   select preserve, slide crf 18 + preset ultrafast (armed
                   LIVE, no confirm); modified indicator + card chip; values
                   survive a tier round-trip (session memory); Reset returns
                   to defaults; payload + compress.log stamp mandatory; live
                   ps argv as warn-only bonus.
   MODE=mixed      simple + overridden-pro + simple in ONE run — each batch
                   frozen snapshot, exactly one stamp.
   MODE=midflip    toggle flip mid-run changes nothing for enqueued batches.
   MODE=invariant  armed.tier === checked tier across: flip-on, card click,
                   keyboard change, post-enqueue reset, simple→pro round trip.
   MODE=sliders    direction semantics: CRF slider max-right → crf 0 in the
                   payload (batchToPayload ground truth); Quality max-right →
                   qv 100; preset stepped slider yields ONLY the nine valid
                   x265 names across every step.
   MODE=visual     body.pro-mode toggles; panel display none↔block;
                   #pro-atmosphere computed opacity 0→1 and body::before
                   1→0.35; semantic color tokens identical in both modes;
                   clean revert.

   Run:  MODE=<mode> ./node_modules/.bin/electron test/pro_sheet_test.js
   Skips cleanly if the fixture clip or bundled ffmpeg is missing. */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const { scanFolder, getBinaries, tierDefaults } = require(path.join(ROOT, 'src/encoder/pipeline'));
const { runQueue } = require(path.join(ROOT, 'src/main/queue-runner'));

const MODE = process.env.MODE || 'untouched';
const SMALL_CLIP = '/Users/macmini1/Downloads/CompressorTest/Source/Project A/C0224.mov';
const DEST = path.join(os.tmpdir(), `squeeze-prosheet-out-${MODE}`);
const SRCDIR = path.join(os.tmpdir(), `squeeze-prosheet-src-${MODE}`);
const X265_PRESETS = ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow'];

const PASS = [], FAIL = [];
const check = (c, l) => { (c ? PASS : FAIL).push(l); console.log((c ? 'PASS' : 'FAIL') + ': ' + l); };
const warn = (l) => console.log('WARN: ' + l);

let win;
let BATCH_FILES = [];
let browseCall = 0;
let queueRunning = false, stopRequested = false, liveBatches = null;
let lastFinished = null, finishedCount = 0;
const batchStatuses = [];
const payloads = [];   // every batch payload main received (Start + mid-run)
const rtm = new Map();
const rt = (id) => { if (!rtm.has(id)) rtm.set(id, {}); return rtm.get(id); };
const send = (ch, p) => {
  if (ch === 'batch-status') batchStatuses.push(p);
  if (ch === 'queue-finished') { lastFinished = p; finishedCount++; }
  if (win && !win.isDestroyed()) win.webContents.send(ch, p);
};

// ---- IPC: real handlers; only native dialogs stubbed ----
ipcMain.handle('app-version', async () => '2.2.7-test');
ipcMain.handle('scan-files', async (_e, paths) => {
  const videos = []; let ignored = 0, totalSize = 0;
  for (const p of paths) { const s = await scanFolder(p); videos.push(...s.videos); ignored += s.ignored || 0; totalSize += s.totalSize || 0; }
  return { rootKind: 'files', root: paths[0], videos, ignored, totalSize };
});
ipcMain.handle('scan-source', async (_e, p) => scanFolder(p));
ipcMain.handle('browse-source-files', async () => BATCH_FILES[browseCall++] || []);
ipcMain.handle('choose-destination', async () => DEST);
ipcMain.handle('stat-path', async (_e, p) => { try { const s = await fsp.stat(p); return { isFile: s.isFile(), isDirectory: s.isDirectory() }; } catch { return null; } });
ipcMain.handle('save-last-src', async () => {});
ipcMain.handle('get-lifetime-drives', async () => []);
ipcMain.handle('add-reclaimed', async () => null);
ipcMain.handle('free-space', async () => ({ free: 9e15 }));
ipcMain.handle('delete-orphans', async () => ({ deleted: 0 }));
['open-path', 'reveal-path', 'reset-drive', 'reveal-in-finder'].forEach((ch) => ipcMain.handle(ch, async () => ({ ok: true })));
ipcMain.handle('check-engine', async () => ({ ok: true }));
ipcMain.handle('get-tier-defaults', async () => ({ regular: tierDefaults('regular'), preserve: tierDefaults('preserve') }));
ipcMain.handle('set-batch-skips', async (_e, { batchId, skipped }) => { rt(batchId).skips = new Set(Array.isArray(skipped) ? skipped : []); return { ok: true }; });
ipcMain.handle('remove-batch', async (_e, batchId) => { rt(batchId).removed = true; return { ok: true }; });
ipcMain.handle('pause-batch', async () => ({ ok: true }));
ipcMain.handle('resume-batch', async () => ({ ok: true }));
ipcMain.handle('cancel-batch', async () => ({ ok: true }));
ipcMain.handle('stop-queue', async () => { stopRequested = true; return { ok: true }; });

// ---- start-queue / enqueue-batch — MIRROR main.js ----
ipcMain.handle('start-queue', async (_evt, batches) => {
  if (queueRunning) return { ok: false, error: 'Already running' };
  for (const b of batches) payloads.push(b);
  queueRunning = true; stopRequested = false; liveBatches = batches;
  let totals;
  try {
    totals = await runQueue(batches, { send, isStopRequested: () => stopRequested, rt });
  } finally {
    liveBatches = null; queueRunning = false;
    send('queue-finished', { totals: totals || { processed: 0, failed: 0 }, stopped: stopRequested });
  }
  return { ok: true };
});
ipcMain.handle('enqueue-batch', async (_e, batch) => {
  if (!queueRunning || !liveBatches || !batch) return { ok: true, absorbed: false };
  payloads.push(batch);
  liveBatches.push(batch);
  return { ok: true, absorbed: true };
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  if (!fs.existsSync(SMALL_CLIP) || !fs.existsSync(getBinaries().ffmpeg)) {
    console.log('(skipped — fixture clip or bundled ffmpeg not present)'); app.quit(); return;
  }
  await fsp.rm(DEST, { recursive: true, force: true });
  await fsp.rm(SRCDIR, { recursive: true, force: true });
  await fsp.mkdir(DEST, { recursive: true });
  await fsp.mkdir(SRCDIR, { recursive: true });
  const mk = async (n) => { const p = path.join(SRCDIR, n); await fsp.copyFile(SMALL_CLIP, p); return p; };

  win = new BrowserWindow({ width: 1100, height: 1000, show: false, backgroundColor: '#0c0e12',
    webPreferences: { preload: path.join(ROOT, 'src/main/preload.js'), contextIsolation: true, sandbox: false } });
  const errs = [];
  win.webContents.on('console-message', (_e, lvl, m) => { if (/error|is not defined|undefined/i.test(m)) errs.push(m); });
  await win.loadFile(path.join(ROOT, 'src/renderer/index.html'));
  const run = (js) => win.webContents.executeJavaScript(js);
  await wait(400);

  const outFiles = () => fs.existsSync(DEST)
    ? fs.readdirSync(DEST, { recursive: true }).filter((f) => /\.mp4$/i.test(f)).map((f) => path.basename(f))
    : [];
  const allLogs = () => fs.existsSync(DEST)
    ? fs.readdirSync(DEST, { recursive: true })
        .filter((f) => path.basename(f) === 'compress.log')
        .map((f) => ({ file: f, text: fs.readFileSync(path.join(DEST, f), 'utf8') }))
    : [];
  const stampLogs = () => allLogs().filter((l) => /# Settings overrides:/.test(l.text));
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  const setMode = async (pro) => { await run(`document.getElementById('${pro ? 'mode-pro' : 'mode-simple'}').click(); true;`); await wait(150); };
  const cardClick = async (tier) => { await run(`document.querySelector('.tier[data-tier="${tier}"]').click(); true;`); await wait(200); };
  const kbTier = async (tier) => {   // keyboard-path selection: change WITHOUT click
    await run(`(() => {
      const r = document.querySelector('input[name="tier"][value="${tier}"]');
      r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`); await wait(150);
  };
  const browse = async () => { await run(`document.getElementById('dz-browse').click(); true;`); await wait(900); };
  const clickAdd = async () => { await run(`document.getElementById('add-to-queue').click(); true;`); await wait(350); };
  const panelVisible = () => run(`getComputedStyle(document.getElementById('pro-panel')).display !== 'none'`);
  const modalPresent = () => run(`!!document.querySelector('.modal-backdrop')`);
  const panelChipText = () => run(`document.getElementById('pro-panel-chip').textContent`);
  const cardName = (tier) => run(`document.querySelector('.tier[data-tier="${tier}"] .name').textContent`);
  const sliderSet = async (key, pos) => {
    await run(`(() => {
      const i = document.querySelector('#pro-panel input[type="range"][data-key="${key}"]');
      i.value = ${JSON.stringify(String(pos))};
      i.dispatchEvent(new Event('input')); i.dispatchEvent(new Event('change'));
      return true;
    })()`);
  };
  const sliderVal = (key) => run(`document.querySelector('#pro-panel input[type="range"][data-key="${key}"]').value`);
  const displayedVal = (key) => run(`document.querySelector('#pro-panel .sheet-label .val[data-key="${key}"]').textContent`);
  const panelModified = () => run(`document.getElementById('pro-panel').classList.contains('modified')`);
  const panelReset = async () => { await run(`document.getElementById('pro-panel-reset').click(); true;`); await wait(150); };
  const armedState = () => run(`({ tier: armed.tier, settings: armed.settings })`);
  const checkedTier = () => run(`document.querySelector('input[name="tier"]:checked').value`);
  const finishRun = async (steps = 150) => { for (let k = 0; k < steps && !lastFinished; k++) await wait(700); };

  if (MODE === 'untouched') {
    BATCH_FILES = [[await mk('s1.mov')], [await mk('p1.mov')]];
    // Simple batch S — today's flow: no panel, no modal.
    check(await panelVisible() === false, 'Simple mode: settings panel not shown');
    await cardClick('regular');
    check(await modalPresent() === false, 'Simple mode: card click opens nothing');
    await browse();
    await run(`document.getElementById('choose-dest').click(); true;`); await wait(300);
    await clickAdd();
    // Pro: panel appears, sliders untouched.
    await setMode(true);
    check(await panelVisible() === true, 'Pro mode: settings panel persistently visible');
    check(await modalPresent() === false, 'no modal sheet exists in the new flow');
    /* Staging is empty (previous Add cleared it) → panel renders DISABLED. */
    const dis = await run(`(() => {
      const panel = document.getElementById('pro-panel');
      const slider = document.querySelector('#pro-panel input[type="range"]');
      return {
        cls: panel.classList.contains('disabled'),
        opacity: getComputedStyle(panel).opacity,
        sliderDisabled: slider ? slider.disabled : null,
        bodyPe: getComputedStyle(document.getElementById('pro-panel-body')).pointerEvents,
        emptyShown: getComputedStyle(document.getElementById('pro-panel-empty')).display !== 'none',
        resetShown: getComputedStyle(document.getElementById('pro-panel-reset')).display !== 'none'
      };
    })()`);
    check(dis.cls === true && dis.opacity === '0.5' && dis.sliderDisabled === true && dis.bodyPe === 'none',
      `panel disabled while staging empty (opacity ${dis.opacity}, pointer-events ${dis.bodyPe})`);
    check(dis.emptyShown === true && dis.resetShown === false,
      '"Drop files to configure this batch" line shown; Reset hidden while disabled');
    const subWhileDisabled = await run(`getComputedStyle(document.getElementById('pro-panel-sub')).display === 'none'`);
    check(subWhileDisabled === true, 'panel subtitle hidden while disabled (never both messages at once)');
    const chip = await panelChipText();
    const name = await cardName('regular');
    check(chip === name && chip === 'Who Cares…',
      `panel chip shows the REAL tier name from the shared constant (got "${chip}")`);
    check(await panelModified() === false, 'untouched panel shows no modified indicator');
    await browse();                        // files land → panel enables LIVE
    const ena = await run(`(() => {
      const panel = document.getElementById('pro-panel');
      const slider = document.querySelector('#pro-panel input[type="range"]');
      return {
        cls: panel.classList.contains('disabled'),
        sliderDisabled: slider ? slider.disabled : null,
        emptyShown: getComputedStyle(document.getElementById('pro-panel-empty')).display !== 'none'
      };
    })()`);
    check(ena.cls === false && ena.sliderDisabled === false && ena.emptyShown === false,
      'panel enabled live once files staged');
    await clickAdd();
    const qlen = await run(`queue.length`);
    check(qlen === 2, `both batches enqueued (got ${qlen})`);
    await run(`document.getElementById('start').click(); true;`);
    await finishRun();
    const [pS, pP] = payloads;
    console.log('  RESULT', JSON.stringify({ settingsS: pS && pS.settings, settingsP: pP && pP.settings, outs: outFiles() }));
    check(!!pS && !!pP && !!pS.settings && same(pS.settings, pP.settings),
      'DECISIVE: untouched-Pro payload settings byte-identical to Simple same-tier');
    check(same(pS.settings, tierDefaults(pS.tier)), 'both equal the tier defaults');
    check(stampLogs().length === 0, 'no "# Settings overrides" stamp in any run log');
    check(outFiles().some((f) => /s1/.test(f)) && outFiles().some((f) => /p1/.test(f)), 'both batches encoded');
  } else if (MODE === 'override') {
    BATCH_FILES = [[await mk('o1.mov')]];
    await setMode(true);
    await browse();                        // stage files FIRST — panel enables
    await run(`document.getElementById('choose-dest').click(); true;`); await wait(300);
    await cardClick('preserve');           // plain selection — panel re-renders
    check((await panelChipText()) === 'Probably Need It Later', 'panel switched to the preserve tier');
    const resetShownDef = await run(`getComputedStyle(document.getElementById('pro-panel-reset')).display !== 'none'`);
    check(resetShownDef === false, 'Reset hidden while values equal defaults');
    check(await modalPresent() === false, 'no modal on tier selection');
    await sliderSet('crf', 51 - 18);       // inverted axis: pos 33 → crf 18
    await sliderSet('preset', 0);          // ultrafast
    check((await displayedVal('crf')) === '18' && (await displayedVal('preset')) === 'ultrafast',
      'sliders display raw values (crf 18, ultrafast)');
    /* Readout direction cue: modified chips take the tier accent; the chip
       text color matches the tier chip (var(--accent)) when off-default. */
    const valAccent = await run(`(() => {
      const v = document.querySelector('#pro-panel .sheet-label .val[data-key="crf"]');
      const chip = document.getElementById('pro-panel-chip');
      return { mod: v.classList.contains('mod'), color: getComputedStyle(v).color, accent: getComputedStyle(chip).color };
    })()`);
    check(valAccent.mod === true && valAccent.color === valAccent.accent,
      'modified readout chip picks up the tier accent');
    check(await panelModified() === true, 'modified indicator shown after edits');
    const resetShownMod = await run(`getComputedStyle(document.getElementById('pro-panel-reset')).display !== 'none'`);
    check(resetShownMod === true, 'Reset visible when modified (its presence is the modified signal)');
    const armedLive = await armedState();
    check(armedLive.settings.crf === 18 && armedLive.settings.preset === 'ultrafast',
      'sliding armed the values LIVE (no confirm step)');
    const chipShown = await run(`!document.querySelector('[data-armed-chip="preserve"]').hidden`);
    check(chipShown === true, 'armed-modified chip visible on the tier card');
    /* Card heights NEVER change: chip rides the badge row. Both cards equal,
       and the modified card's height matches its unmodified twin. */
    const hts = await run(`(() => {
      const h = (t) => getComputedStyle(document.querySelector('.tier[data-tier="' + t + '"]')).height;
      return { reg: h('regular'), pre: h('preserve') };
    })()`);
    check(hts.reg === hts.pre, `card heights identical with the chip shown (${hts.reg} vs ${hts.pre})`);

    /* Session memory: values survive a tier round-trip; Reset returns to
       pure defaults. */
    await cardClick('regular');
    await cardClick('preserve');
    check((await sliderVal('crf')) === String(51 - 18) && (await displayedVal('preset')) === 'ultrafast',
      'tier round-trip re-rendered the panel from session memory');
    await panelReset();
    check((await displayedVal('crf')) === '20' && (await displayedVal('preset')) === 'medium' && (await panelModified()) === false,
      'one-click Reset returns the panel to defaults');
    const valNeutral = await run(`(() => {
      const v = document.querySelector('#pro-panel .sheet-label .val[data-key="crf"]');
      return { mod: v.classList.contains('mod'), color: getComputedStyle(v).color };
    })()`);
    check(valNeutral.mod === false, 'readout chip returns to neutral at defaults');
    // Re-apply the overrides for the actual run.
    await sliderSet('crf', 51 - 18);
    await sliderSet('preset', 0);
    await clickAdd();
    await run(`document.getElementById('start').click(); true;`);
    // BONUS (warn-only): catch the live ffmpeg argv via ps while it encodes.
    let liveArgvSeen = false;
    for (let k = 0; k < 200 && !lastFinished; k++) {
      if (!liveArgvSeen) {
        try {
          const ps = execSync('ps -axo command', { encoding: 'utf8' });
          if (ps.split('\n').some((l) => /ffmpeg/.test(l) && /-crf 18/.test(l) && /-preset ultrafast/.test(l))) liveArgvSeen = true;
        } catch {}
      }
      await wait(250);
    }
    await finishRun();
    const p = payloads[0];
    console.log('  RESULT', JSON.stringify({ settings: p && p.settings, liveArgvSeen, stamps: stampLogs().map((l) => l.text.match(/# Settings overrides:.*$/m)[0]) }));
    check(!!p && !!p.settings && p.settings.crf === 18 && p.settings.preset === 'ultrafast' && p.settings.vcodec === 'libx265',
      'MANDATORY: payload settings carry the armed overrides (crf=18 preset=ultrafast on libx265)');
    const stamps = stampLogs();
    check(stamps.length === 1 && /# Settings overrides: crf=18 preset=ultrafast/.test(stamps[0].text),
      'MANDATORY: compress.log records "# Settings overrides: crf=18 preset=ultrafast"');
    if (liveArgvSeen) check(true, 'BONUS: live ffmpeg argv contained -crf 18 -preset ultrafast');
    else warn('live argv not caught in the ps polling window (timing) — bonus check skipped, not a failure');
    check(outFiles().some((f) => /o1/.test(f)), 'overridden batch encoded');
  } else if (MODE === 'mixed') {
    BATCH_FILES = [[await mk('a1.mov')], [await mk('b1.mov')], [await mk('c1.mov')]];
    // A: simple, regular (default tier).
    await browse();
    await run(`document.getElementById('choose-dest').click(); true;`); await wait(300);
    await clickAdd();
    // B: pro, preserve, overridden live on the panel.
    await setMode(true);
    await browse();                        // stage first — panel enabled for the edits
    await cardClick('preserve');
    await sliderSet('crf', 51 - 18);
    await sliderSet('preset', 0);
    await clickAdd();
    // C: simple again, regular (post-enqueue reset already re-selected it).
    await setMode(false);
    check(await panelVisible() === false, 'panel gone the moment Simple returns');
    await browse();
    await clickAdd();
    const qlen = await run(`queue.length`);
    check(qlen === 3, `three batches enqueued (got ${qlen})`);
    await run(`document.getElementById('start').click(); true;`);
    await finishRun(250);
    const [pA, pB, pC] = payloads;
    console.log('  RESULT', JSON.stringify({ a: pA && pA.settings, b: pB && pB.settings, c: pC && pC.settings, outs: outFiles() }));
    check(!!pA && same(pA.settings, tierDefaults('regular')), 'batch A (simple) froze regular defaults');
    check(!!pB && pB.settings && pB.settings.crf === 18 && pB.settings.preset === 'ultrafast', 'batch B (pro) froze its armed overrides');
    check(!!pC && same(pC.settings, tierDefaults('regular')), 'batch C (simple, post-pro) froze regular defaults');
    const stamps = stampLogs();
    check(stamps.length === 1 && /crf=18 preset=ultrafast/.test(stamps[0].text),
      'exactly ONE overrides stamp across the run — on the pro batch\'s log');
    const outs = outFiles();
    check(outs.some((f) => /a1/.test(f)) && outs.some((f) => /b1/.test(f)) && outs.some((f) => /c1/.test(f)),
      'all three batches encoded with their own snapshots');
    check(finishedCount === 1, `single run (got ${finishedCount})`);
  } else if (MODE === 'midflip') {
    BATCH_FILES = [[await mk('a1.mov'), await mk('a2.mov')], [await mk('b1.mov')]];
    await browse();
    await run(`document.getElementById('choose-dest').click(); true;`); await wait(300);
    await clickAdd();
    await browse();
    await clickAdd();
    const qlen = await run(`queue.length`);
    check(qlen === 2, `two simple batches enqueued (got ${qlen})`);
    await run(`document.getElementById('start').click(); true;`);
    await wait(400);                  // A encoding
    await setMode(true);              // FLIP mid-run
    check(await panelVisible() === true && await modalPresent() === false,
      'mid-run flip shows the panel, never a modal');
    await finishRun();
    const [pA, pB] = payloads;
    console.log('  RESULT', JSON.stringify({ a: pA && pA.settings, b: pB && pB.settings, outs: outFiles() }));
    check(!!pA && !!pB && same(pA.settings, tierDefaults(pA.tier)) && same(pB.settings, tierDefaults(pB.tier)),
      'both already-enqueued batches kept their frozen default snapshots through the flip');
    check(stampLogs().length === 0, 'no overrides stamp appeared from the flip');
    const outs = outFiles();
    check(outs.some((f) => /a1/.test(f)) && outs.some((f) => /a2/.test(f)) && outs.some((f) => /b1/.test(f)),
      'all files encoded normally after the mid-run flip');
    check(finishedCount === 1, `single uninterrupted run (got ${finishedCount})`);
  } else if (MODE === 'invariant') {
    /* armed.tier ALWAYS equals the checked tier in Pro Mode — now by
       construction (every selection path fires the change handler, which
       arms). No encodes — state machine only. */
    BATCH_FILES = [[await mk('i1.mov')]];
    const agree = async (label) => {
      const a = await armedState(); const t = await checkedTier();
      check(a.tier === t, `${label}: armed.tier (${a.tier}) === checked (${t})`);
      return a;
    };
    await setMode(true);
    const a0 = await agree('toggle flip-on');
    check(same(a0.settings, tierDefaults('regular')), 'flip-on armed regular defaults');
    // Card click: plain selection, panel re-renders, armed follows.
    await cardClick('preserve');
    await agree('card click');
    check(await modalPresent() === false, 'card click opened nothing');
    // Keyboard change (radio change with NO click): armed follows.
    await kbTier('regular');
    const a3 = await agree('keyboard change');
    check(same(a3.settings, tierDefaults('regular')), 'keyboard change armed defaults (no session memory yet)');
    // Post-enqueue reset.
    await kbTier('preserve');
    await browse();
    await run(`document.getElementById('choose-dest').click(); true;`); await wait(300);
    await clickAdd();                  // enqueue → resetStagingTier → regular
    const a4 = await agree('post-enqueue reset');
    check(a4.tier === 'regular', 'reset re-armed the recommended tier');
    // Simple → Pro round trip with preserve checked.
    await kbTier('preserve');
    await setMode(false);
    await setMode(true);
    await agree('simple→pro round trip');
  } else if (MODE === 'sliders') {
    /* Direction semantics + stepped preset validity. No encodes — the payload
       ground truth is batchToPayload over the frozen queue entry. */
    BATCH_FILES = [[await mk('d1.mov')]];
    await setMode(true);
    await browse();                        // stage first — panel enabled
    await run(`document.getElementById('choose-dest').click(); true;`); await wait(300);
    await cardClick('preserve');
    // CRF max-right must be the LOWEST crf (0): right = better quality.
    await sliderSet('crf', 51);
    check((await displayedVal('crf')) === '0', 'CRF slider at max-right displays crf 0');
    // Preset stepped slider: every step yields one of the nine valid names.
    const seen = [];
    for (let pos = 0; pos <= 8; pos++) {
      await sliderSet('preset', pos);
      seen.push(await displayedVal('preset'));
    }
    console.log('  preset sweep:', JSON.stringify(seen));
    const tickCount = await run(`document.querySelectorAll('#pro-panel input[data-key="preset"]').length
      ? document.querySelector('#pro-panel input[data-key="preset"]').closest('.slider-wrap').querySelectorAll('.slider-tick').length : -1`);
    check(tickCount === 9, `preset track renders 9 visible tick marks (got ${tickCount})`);
    check(seen.length === 9 && seen.every((n) => X265_PRESETS.includes(n)) && new Set(seen).size === 9,
      'preset slider yields exactly the nine valid x265 names, in step order');
    check(seen[0] === 'ultrafast' && seen[8] === 'veryslow', 'preset axis runs ultrafast → veryslow (faster → smaller/slower)');
    await sliderSet('crf', 51);        // re-assert after the sweep
    await sliderSet('preset', 8);      // veryslow
    await clickAdd();
    const payload = await run(`batchToPayload(queue.find((b) => b.tier === 'preserve'))`);
    console.log('  RESULT', JSON.stringify({ settings: payload && payload.settings }));
    check(!!payload && payload.settings.crf === 0, 'PAYLOAD ground truth: max-right CRF slider → crf 0 (lowest)');
    check(payload.settings.preset === 'veryslow' && X265_PRESETS.includes(payload.settings.preset),
      'payload preset is a valid x265 name from the stepped slider');
    /* Armed/session values SURVIVE the disabled period: the Add cleared the
       staging tray (panel disabled again), but preserve's memory is intact. */
    const disNow = await run(`document.getElementById('pro-panel').classList.contains('disabled')`);
    check(disNow === true, 'panel disabled again after Add cleared staging');
    await cardClick('preserve');
    check((await displayedVal('crf')) === '0' && (await displayedVal('preset')) === 'veryslow',
      'armed/session values survived the disabled period (visual-only gating)');
    // Quality direction on the regular tier: max-right → qv 85 (the v2.2.8
    // ceiling — the slider's max IS the clamp; values above can't exist).
    await cardClick('regular');
    const qvMax = await run(`document.querySelector('#pro-panel input[data-key="qv"]').max`);
    check(qvMax === '85', `Quality slider max is 85 (got ${qvMax})`);
    await sliderSet('qv', 100);        // attempts beyond max clamp natively
    check((await displayedVal('qv')) === '85', 'Quality slider at max-right displays 85 (the ceiling)');
    const armedNow = await armedState();
    check(armedNow.settings.qv === 85, 'armed qv follows the slider direction live, capped at the ceiling');
  } else if (MODE === 'visual') {
    /* Mode visual identity — computed-style ground truth, additive only. */
    const probe = () => run(`(() => {
      const cs = getComputedStyle(document.getElementById('pro-atmosphere'));
      const before = getComputedStyle(document.body, '::before');
      const root = getComputedStyle(document.documentElement);
      return {
        proClass: document.body.classList.contains('pro-mode'),
        atmoOpacity: cs.opacity,
        bloomOpacity: before.opacity,
        panelShown: getComputedStyle(document.getElementById('pro-panel')).display !== 'none',
        tokens: ['--operational', '--good', '--red', '--amber', '--orange', '--tier-fast', '--tier-arch']
          .map((t) => root.getPropertyValue(t).trim()).join('|')
      };
    })()`);
    const simple1 = await probe();
    check(simple1.proClass === false && simple1.atmoOpacity === '0' && simple1.bloomOpacity === '1',
      `Simple baseline: no pro-mode class, overlay 0, base bloom 1 (got ${simple1.atmoOpacity}/${simple1.bloomOpacity})`);
    check(simple1.panelShown === false, 'settings panel absent in Normal mode');
    const proChipGone = await run(`document.querySelector('.pro-chip') === null`);
    check(proChipGone === true, 'PRO wordmark chip removed from the DOM');
    await setMode(true);
    await wait(900);                   // crossfade .6s — settle
    const pro = await probe();
    check(pro.proClass === true, 'body.pro-mode set on flip');
    check(pro.atmoOpacity === '1' && Math.abs(Number(pro.bloomOpacity) - 0.15) < 0.01,
      `Nerd atmosphere: overlay 1, base bloom .15 (got ${pro.atmoOpacity}/${pro.bloomOpacity})`);
    check(pro.panelShown === true, 'settings panel present in Nerd mode');
    /* Display rename: toggle reads Normal | Nerd (ids/plumbing unchanged). */
    const segs = await run(`({ a: document.getElementById('mode-simple').textContent, b: document.getElementById('mode-pro').textContent })`);
    check(segs.a === 'Normal' && segs.b === 'Nerd', `toggle segments read Normal | Nerd (got "${segs.a}" | "${segs.b}")`);
    check(pro.tokens === simple1.tokens, 'semantic + tier accent tokens IDENTICAL in both modes');
    await setMode(false);
    await wait(900);
    const simple2 = await probe();
    check(simple2.proClass === false && simple2.atmoOpacity === '0' && simple2.bloomOpacity === '1'
      && simple2.panelShown === false,
      'clean revert to the Simple baseline');
    check(simple2.tokens === simple1.tokens, 'tokens unchanged after the round trip');
    /* Hint placement: header pro-hint REMOVED; the panel carries a subtitle.
       Normal mode's original header hint untouched. */
    const hintNormal = await run(`getComputedStyle(document.getElementById('tier-hint')).display !== 'none'`);
    const headerProHintGone = await run(`document.getElementById('tier-hint-pro') === null`);
    check(hintNormal === true && headerProHintGone === true,
      'Normal mode keeps its header hint; the old header pro-hint is gone from the DOM');
    await setMode(true); await wait(200);
    const hintNerd = await run(`({
      headerHint: getComputedStyle(document.getElementById('tier-hint')).display,
      sub: getComputedStyle(document.getElementById('pro-panel-sub')).display,
      subText: document.getElementById('pro-panel-sub').textContent,
      disabled: document.getElementById('pro-panel').classList.contains('disabled')
    })`);
    check(hintNerd.headerHint === 'none' && /next batch/i.test(hintNerd.subText)
      && ((hintNerd.sub !== 'none') === !hintNerd.disabled),
      'Nerd mode: header hint hidden; panel subtitle carries the copy (hidden only while disabled)');
    /* Stage a batch so the panel is READY: the slider rows are only RENDERED
       (not suppressed) once the batch is actionable — the disabled panel hides
       them now (empty-state vs armed-display are mutually exclusive). The grid/
       width layout is meaningful only in this rendered state. */
    BATCH_FILES = [[await mk('v1.mov')]];
    await browse();
    await run(`document.getElementById('choose-dest').click(); true;`); await wait(300);
    await cardClick('preserve');       // two clusters needed for the gap probe
    const gaps = await run(`(() => {
      const body = document.getElementById('pro-panel-body');
      const intra = parseFloat(getComputedStyle(document.querySelector('#pro-panel .sheet-label')).marginBottom);
      const inter = parseFloat(getComputedStyle(body).rowGap);   // grid gap IS the inter-cluster gap
      const grid = getComputedStyle(body).display === 'grid';
      return { intra, inter, grid };
    })()`);
    check(gaps.grid === true, 'cluster container is a grid (column-ready for future knobs)');
    check(gaps.inter !== null && gaps.inter >= gaps.intra * 2,
      `inter-cluster gap (${gaps.inter}px) >= 2x intra-cluster gap (${gaps.intra}px)`);
    /* Width cap REVERTED: clusters track the panel's full content width. */
    const widths = await run(`(() => {
      const panel = document.getElementById('pro-panel');
      const row = document.querySelector('#pro-panel .sheet-row');
      const cs = getComputedStyle(panel);
      const content = panel.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      return { row: row.offsetWidth, content };
    })()`);
    check(Math.abs(widths.row - widths.content) < 4,
      `cluster width tracks panel content width (row ${widths.row}px vs content ${widths.content}px)`);
    /* Endpoint captions take the tier accent — same computed color as the
       tier chip (which renders var(--accent)), different per tier. */
    const endColor = () => run(`getComputedStyle(document.querySelector('#pro-panel .slider-ends span')).color`);
    const chipColor = () => run(`getComputedStyle(document.getElementById('pro-panel-chip')).color`);
    const preserveEnds = await endColor(); const preserveChip = await chipColor();
    check(preserveEnds === preserveChip, `preserve endpoint captions use the tier accent (${preserveEnds})`);
    await cardClick('regular');
    const regularEnds = await endColor(); const regularChip = await chipColor();
    check(regularEnds === regularChip, `regular endpoint captions use the tier accent (${regularEnds})`);
    check(regularEnds !== preserveEnds, 'caption accent differs between tiers (cobalt vs iris)');
    await setMode(false); await wait(200);
  }

  check(errs.length === 0, 'no renderer console errors: ' + (errs[0] || 'none'));
  await fsp.rm(SRCDIR, { recursive: true, force: true });
  console.log('\n[' + MODE + '] PASS:', PASS.length, 'FAIL:', FAIL.length);
  if (FAIL.length) for (const l of FAIL) console.log(' - ' + l);
  app.exit(FAIL.length ? 1 : 0);
}).catch((e) => {
  /* A thrown await (e.g. a selector missing in executeJavaScript) must FAIL
     the test, never hang the suite with a live Electron waiting forever. */
  console.log('FATAL: ' + (e && e.stack || e));
  app.exit(1);
});
app.on('window-all-closed', () => app.quit());
