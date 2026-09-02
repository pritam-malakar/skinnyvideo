/* Repo regression (v2.2.2): QUEUE HIERARCHY PASS — batch vs file legibility.
   Runs on the REAL GUI render path (loads src/renderer/index.html with the real
   preload, drives the real add flow → real buildBatchGroup/renderQueue), seeds
   TWO batches of DIFFERENT tiers (regular=cobalt, archival=iris violet), and
   asserts against real computed DOM (getComputedStyle), not "a thing renders":

     (a) each .qbatch carries a tier modifier matching its .tierchip;
     (b) .qbatch-files has margin-left 24px, border-left 2px solid, and
         border-left-color === the RESOLVED rgb of --tier-fast / --tier-arch
         (compared against a probe element, not a hex string);
     (c) no global .queue-head; exactly one quiet .qfile-head strip per batch,
         INSIDE its tray (child of .qbatch-files), over --bg-1, indent 40px;
     (d) .qrow .status .pill border + background are transparent (de-weighted),
         WHILE .qbatch-status .pill retains its border + background.

   Designed fail-on-old / pass-on-new. Captures default-width AND fullscreen-width
   PNGs of a queue with one cobalt + one violet batch (multiple files each). */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const OUT = '/tmp/skinnyvideo-queue-hierarchy';
const PASS = [], FAIL = [];
const check = (c, l) => { (c ? PASS : FAIL).push(l); console.log((c ? 'PASS' : 'FAIL') + ': ' + l); };

// ---- stub IPC: enough to stage + add two multi-file batches, no encodes ----
const THREE = ['/fake/clipA.mov', '/fake/clipB.mov', '/fake/clipC.mov'];
ipcMain.handle('app-version', async () => '2.2.2-test');
ipcMain.handle('browse-source-files', async () => THREE.slice());
ipcMain.handle('scan-files', async () => ({
  rootKind: 'files', root: '/fake', ignored: 0, totalSize: 3 * 1234567,
  videos: THREE.map((f, i) => ({ file: f, basename: f.split('/').pop(), size: 1234567 + i * 1000 }))
}));
ipcMain.handle('choose-destination', async () => '/tmp/skinnyvideo-verify-out');
ipcMain.handle('stat-path', async () => ({ isFile: false, isDirectory: true }));
ipcMain.handle('check-engine', async () => ({ ok: true }));   // locked: Start pre-flight stub
ipcMain.handle('save-last-src', async () => {});
ipcMain.handle('get-lifetime-drives', async () => []);
ipcMain.handle('add-reclaimed', async () => null);
ipcMain.handle('free-space', async () => ({ free: 9e15 }));
ipcMain.handle('delete-orphans', async () => ({ deleted: 0 }));
['open-path','reveal-path','reset-drive','scan-source','pause-batch','resume-batch',
 'cancel-batch','stop-queue','start-queue','set-batch-skips','enqueue-batch']
  .forEach((ch) => ipcMain.handle(ch, async () => ({ ok: true })));

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const win = new BrowserWindow({ width: 1280, height: 900, show: false, backgroundColor: '#0c0e12',
    webPreferences: { preload: path.join(ROOT, 'src/main/preload.js'), contextIsolation: true, sandbox: false } });
  const errs = [];
  win.webContents.on('console-message', (_e, lvl, m) => { if (/error|is not defined|undefined/i.test(m)) errs.push(m); });
  await win.loadFile(path.join(ROOT, 'src/renderer/index.html'));
  const run = (js) => win.webContents.executeJavaScript(js);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  await wait(400);

  // ---- empty queue: no header strips of any kind (v2.2.3: no global head;
  //      per-batch strips only exist once a batch renders) ----
  const emptyHead = await run(`(() => ({
    queue: document.querySelectorAll('.queue-head').length,
    qfile: document.querySelectorAll('.qfile-head').length
  }))()`);
  check(emptyHead.queue === 0, `no global .queue-head exists (got ${emptyHead.queue})`);
  check(emptyHead.qfile === 0, `no .qfile-head on the empty queue (got ${emptyHead.qfile})`);

  // ---- seed two batches of DIFFERENT tiers via the real add flow ----
  await run(`document.getElementById('choose-dest').click(); true;`); await wait(250);
  const addBatch = async (tierValue) => {
    await run(`document.getElementById('dz-browse').click(); true;`); await wait(450);
    await run(`(() => { const r = document.querySelector('input[name="tier"][value="${tierValue}"]');
                        r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); })(); true;`);
    await wait(80);
    await run(`document.getElementById('add-to-queue').click(); true;`); await wait(300);
  };
  await addBatch('regular');    // batch 1 → cobalt
  await addBatch('preserve');   // batch 2 → iris violet

  // ---- resolve --tier-fast / --tier-arch / --card-2 to rgb via a probe (fix 6) ----
  const probe = await run(`(() => {
    const e = document.createElement('span'); document.body.appendChild(e);
    e.style.color = 'var(--tier-fast)'; const fast = getComputedStyle(e).color;
    e.style.color = 'var(--tier-arch)'; const arch = getComputedStyle(e).color;
    e.style.color = 'var(--card-2)';   const card2 = getComputedStyle(e).color;
    e.remove(); return { fast, arch, card2 };
  })()`);
  check(/^rgb/.test(probe.fast) && /^rgb/.test(probe.arch),
    `tier tokens resolve to rgb (fast=${probe.fast}, arch=${probe.arch})`);

  // ---- (c) headers: NO global strip; exactly one quiet label strip per batch,
  //      INSIDE its tray (a direct child of .qbatch-files), over the --bg-1 fill,
  //      same grid as .qrow, content indented to 40px, no own background ----
  const heads = await run(`(() => {
    const norm = (s) => s.replace(/\\s+/g, ' ').trim();
    const batches = [...document.querySelectorAll('#queue .qbatch')];
    const strips = batches.map((b) => {
      const tray = b.querySelector('.qbatch-files');
      const strip = b.querySelector('.qfile-head');
      const row = b.querySelector('.qbatch-files .qrow');
      const sc = strip && getComputedStyle(strip);
      const rc = row && getComputedStyle(row);
      return {
        perBatchCount: b.querySelectorAll('.qfile-head').length,
        insideTray: !!(strip && tray && strip.parentElement === tray),  // child of the tray
        firstChildOfTray: !!(tray && tray.firstElementChild === strip),  // above the rows
        bg: sc && sc.backgroundColor,
        gridMatchesRow: !!(sc && rc && sc.gridTemplateColumns === rc.gridTemplateColumns),
        padLeft: sc && sc.paddingLeft,
        trayPadLeft: tray && getComputedStyle(tray).paddingLeft
      };
    });
    return { qfile: document.querySelectorAll('.qfile-head').length,
             queue: document.querySelectorAll('.queue-head').length,
             batches: batches.length, strips };
  })()`);
  check(heads.batches === 2, `two batches rendered (got ${heads.batches})`);
  check(heads.queue === 0, `zero global .queue-head (got ${heads.queue})`);
  check(heads.qfile === 2, `exactly one .qfile-head per batch (got ${heads.qfile} across 2 batches)`);
  heads.strips.forEach((s, i) => {
    check(s.perBatchCount === 1, `batch ${i + 1}: exactly one label strip (got ${s.perBatchCount})`);
    check(s.insideTray && s.firstChildOfTray, `batch ${i + 1}: strip is first child INSIDE .qbatch-files tray`);
    check(s.bg === 'rgba(0, 0, 0, 0)', `batch ${i + 1}: strip has no own background — sits on tray fill (got ${s.bg})`);
    check(s.gridMatchesRow, `batch ${i + 1}: strip grid-template-columns matches .qrow`);
    /* Reskin v3e: the strip carries no own left padding — the content origin
       is the tray's 22px padding-left, clear of the 3px spine at left:9px. */
    check(s.padLeft === '0px' && s.trayPadLeft === '22px',
      `batch ${i + 1}: strip pad-left 0 on tray pad-left 22px → content origin 22px (got ${s.padLeft} / ${s.trayPadLeft})`);
  });

  // ---- (a)+(b) per-batch tier modifier + spined tray, by computed style.
  //      Reskin v3e ground truth: the tray is a FULL-WIDTH recessed card-2
  //      surface (margin-left 0); the spine is a ::before pseudo — 3px wide,
  //      absolute at left:9px, border-radius 2px, painted the batch's frozen
  //      tier color (--spine). Swapped tiers must fail the color checks. ----
  const batches = await run(`(() => {
    const norm = (s) => s.replace(/\\s+/g, '');
    return [...document.querySelectorAll('#queue .qbatch')].map((b) => {
      const files = b.querySelector('.qbatch-files');
      const chip = b.querySelector('.tierchip');
      const cs = getComputedStyle(files);
      const sp = getComputedStyle(files, '::before');
      return {
        regular: b.classList.contains('qbatch--regular'),
        archival: b.classList.contains('qbatch--archival'),
        chipRegular: chip.classList.contains('regular'),
        chipArchival: chip.classList.contains('archival'),
        marginLeft: cs.marginLeft,
        trayBg: norm(cs.backgroundColor),
        spineW: sp.width,
        spinePos: sp.position,
        spineLeft: sp.left,
        spineRadius: sp.borderRadius,
        spineColor: norm(sp.backgroundColor)
      };
    });
  })()`);
  const reg = batches.find((b) => b.regular);
  const arc = batches.find((b) => b.archival);
  const norm = (s) => s.replace(/\s+/g, '');

  check(!!reg && reg.chipRegular && !reg.archival,
    'regular batch: root has qbatch--regular, matches its .tierchip.regular');
  check(!!arc && arc.chipArchival && !arc.regular,
    'archival batch: root has qbatch--archival, matches its .tierchip.archival');

  for (const [b, label, want] of [[reg, 'regular', probe.fast], [arc, 'archival', probe.arch]]) {
    if (!b) { check(false, `${label} batch present`); continue; }
    check(b.marginLeft === '0px' && b.trayBg === norm(probe.card2),
      `${label} tray full-width recessed card-2 (margin-left ${b.marginLeft}, bg ${b.trayBg})`);
    check(b.spineW === '3px', `${label} spine ::before width 3px (got ${b.spineW})`);
    check(b.spinePos === 'absolute' && b.spineLeft === '9px' && b.spineRadius === '2px',
      `${label} spine ::before inset at left 9px, radius 2px (got ${b.spinePos}/${b.spineLeft}/${b.spineRadius})`);
    check(b.spineColor === norm(want),
      `${label} spine ::before color === resolved tier token (got ${b.spineColor}, want ${norm(want)})`);
  }

  // ---- (d) reskin v3e pill language: BOTH levels are solid borderless pills
  //      (file row = card-2 in its queued state); batch > file hierarchy is
  //      carried by a measurable type step (batch name 19px vs file name 15px) ----
  const pills = await run(`(() => {
    const norm = (s) => s.replace(/\\s+/g, '');
    const fp = document.querySelector('.qrow .status.queued .pill');
    const bp = document.querySelector('.qbatch-status .pill');
    const bn = document.querySelector('.qbatch-name');
    const fn = document.querySelector('.qrow .file .name');
    const fc = getComputedStyle(fp), bc = getComputedStyle(bp);
    return {
      file:  { bw: fc.borderTopWidth, bg: norm(fc.backgroundColor) },
      batch: { bw: bc.borderTopWidth, bg: norm(bc.backgroundColor) },
      batchNameSize: getComputedStyle(bn).fontSize,
      fileNameSize: getComputedStyle(fn).fontSize
    };
  })()`);
  check(pills.file.bw === '0px' && pills.file.bg === norm(probe.card2),
    `file-row queued pill is a solid borderless card-2 pill (border ${pills.file.bw}, bg ${pills.file.bg})`);
  check(pills.batch.bw === '0px' && pills.batch.bg === norm(probe.card2)
      && pills.batchNameSize === '19px' && pills.fileNameSize === '15px',
    `batch pill same solid language; hierarchy via type step 19px > 15px (got ${pills.batchNameSize}/${pills.fileNameSize})`);

  // ---- captures: default + fullscreen width, queue scrolled into view so
  //      both batches (cobalt + violet) + their per-tray label strips show ----
  const shoot = async (w, name) => {
    win.setContentSize(w, 1000); await wait(250);
    await run(`document.querySelector('#queue .qbatch').scrollIntoView({ block: 'start' }); true;`);
    await wait(250);
    const img = await win.webContents.capturePage();
    const p = path.join(OUT, name);
    fs.writeFileSync(p, img.toPNG());
    console.log('  shot:', p);
  };
  await shoot(1280, 'queue-default-1280.png');
  await shoot(1728, 'queue-fullscreen-1728.png');

  // ---- numeric alignment: EACH batch's .qfile-head cells vs that batch's own
  //      first .qrow cells, both widths (~1px) ----
  const measureAlign = async (w) => {
    win.setContentSize(w, 900); await wait(300);
    return run(`(() => {
      return [...document.querySelectorAll('#queue .qbatch')].map((b) => {
        const head = [...b.querySelector('.qfile-head').children].map((c) => c.getBoundingClientRect().left);
        const row = [...b.querySelector('.qbatch-files .qrow').children].map((c) => c.getBoundingClientRect().left);
        const dx = head.map((h, i) => Math.abs(h - row[i]));
        return { dx, max: Math.max(...dx) };
      });
    })()`);
  };
  for (const w of [1280, 1728]) {
    const per = await measureAlign(w);
    per.forEach((a, i) => {
      check(a.max <= 1.5, `batch ${i + 1}: strip↔column alignment within ~1px at ${w}w (max Δ ${a.max.toFixed(2)}px; [${a.dx.map((d) => d.toFixed(1)).join(', ')}])`);
    });
  }

  check(errs.length === 0, `no renderer console errors (got ${errs.length}${errs.length ? ': ' + errs[0] : ''})`);

  console.log('\nPASS:', PASS.length, 'FAIL:', FAIL.length);
  app.exit(FAIL.length ? 1 : 0);
}).catch((e) => { console.error(e); app.exit(2); });
