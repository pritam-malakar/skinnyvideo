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
const OUT = '/tmp/squeeze-queue-hierarchy';
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
ipcMain.handle('choose-destination', async () => '/tmp/squeeze-verify-out');
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

  // ---- resolve --tier-fast / --tier-arch to rgb via a probe (fix 6) ----
  const probe = await run(`(() => {
    const e = document.createElement('span'); document.body.appendChild(e);
    e.style.color = 'var(--tier-fast)'; const fast = getComputedStyle(e).color;
    e.style.color = 'var(--tier-arch)'; const arch = getComputedStyle(e).color;
    e.remove(); return { fast, arch };
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
        padLeft: sc && sc.paddingLeft
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
    check(s.padLeft === '14px', `batch ${i + 1}: strip padding-left 14px → content origin 40px (got ${s.padLeft})`);
  });

  // ---- (a)+(b) per-batch tier modifier + spined tray, by computed style ----
  const batches = await run(`(() => {
    const norm = (s) => s.replace(/\\s+/g, '');
    return [...document.querySelectorAll('#queue .qbatch')].map((b) => {
      const files = b.querySelector('.qbatch-files');
      const chip = b.querySelector('.tierchip');
      const cs = getComputedStyle(files);
      return {
        regular: b.classList.contains('qbatch--regular'),
        archival: b.classList.contains('qbatch--archival'),
        chipRegular: chip.classList.contains('regular'),
        chipArchival: chip.classList.contains('archival'),
        marginLeft: cs.marginLeft,
        borderW: cs.borderLeftWidth,
        borderStyle: cs.borderLeftStyle,
        borderColor: norm(cs.borderLeftColor)
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
    check(b.marginLeft === '24px', `${label} .qbatch-files inset (margin-left ${b.marginLeft} === 24px)`);
    check(b.borderW === '2px', `${label} spine width 2px (got ${b.borderW})`);
    check(b.borderStyle === 'solid', `${label} spine style solid (got ${b.borderStyle})`);
    check(b.borderColor === norm(want),
      `${label} spine color === resolved tier token (got ${b.borderColor}, want ${norm(want)})`);
  }

  // ---- (d) file-row pill de-weighted; batch pill keeps its chrome ----
  const pills = await run(`(() => {
    const TRANSPARENT = 'rgba(0,0,0,0)';
    const fp = document.querySelector('.qrow .status .pill');
    const bp = document.querySelector('.qbatch-status .pill');
    const fc = getComputedStyle(fp), bc = getComputedStyle(bp);
    return {
      file: { bw: fc.borderTopWidth, bg: fc.backgroundColor },
      batch: { bw: bc.borderTopWidth, bg: bc.backgroundColor, transparent: TRANSPARENT }
    };
  })()`);
  check(pills.file.bw === '0px' && pills.file.bg === 'rgba(0, 0, 0, 0)',
    `file-row pill de-weighted: no border (${pills.file.bw}) + transparent bg (${pills.file.bg})`);
  check(pills.batch.bw !== '0px' && pills.batch.bg !== 'rgba(0, 0, 0, 0)',
    `batch pill keeps its chrome: border ${pills.batch.bw}, bg ${pills.batch.bg}`);

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
