// v2.1.10 regressions — STARTED jobs are insulated from the original moving/
// being deleted, in BOTH input modes:
//   A) folder mode: the CURRENTLY-ENCODING file's source is deleted → the
//      encode finishes anyway (ffmpeg holds the input open).
//   B) folder mode: a NOT-YET-STARTED file's source is deleted while another
//      encodes → that file fast-fails source-missing (pre-check), others OK.
//   C) file-list mode: the ORIGINAL is deleted mid-encode → the staged hardlink
//      keeps the data, encode finishes.
// Needs the CompressorTest fixture + bundled ffmpeg.
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const { runBatch, getBinaries } = require('../src/encoder/pipeline');

const PASS = [], FAIL = [];
const check = (c, l) => { (c ? PASS : FAIL).push(l); console.log((c ? 'PASS' : 'FAIL') + ': ' + l); };
const header = (t) => console.log('\n==== ' + t + ' ====');
const SMALL_CLIP = '/Users/macmini1/Downloads/CompressorTest/Source/Project A/C0224.mov';

(async () => {
  if (!fs.existsSync(SMALL_CLIP) || !fs.existsSync(getBinaries().ffmpeg)) {
    console.log('(skipped — fixture clip or bundled ffmpeg not present)');
    return;
  }
  const sandbox = await fsp.mkdtemp(path.join(os.tmpdir(), 'skinnyvideo-v219-'));

  // ── A: folder mode, delete the encoding file's source mid-encode ──
  header('A: folder — currently-encoding source deleted → still finishes (open fd)');
  {
    const src = path.join(sandbox, 'A_src'); await fsp.mkdir(src, { recursive: true });
    const clip = path.join(src, 'rolling.mov'); await fsp.copyFile(SMALL_CLIP, clip);
    const dest = path.join(sandbox, 'A_out'); await fsp.mkdir(dest, { recursive: true });
    let deleted = false;
    const onProgress = (d) => {
      if (d.type === 'file-progress' && !deleted) { try { fs.unlinkSync(clip); deleted = true; } catch {} }
    };
    const t0 = Date.now();
    const res = await runBatch({ src, dest, tier: 'preserve' }, () => false, onProgress);
    console.log('  deleted=%s result=%j ms=%d', deleted, { processed: res.processed, failed: res.failed }, Date.now() - t0);
    check(deleted, 'original was deleted while encoding');
    check(res.processed === 1 && res.failed === 0, 'encode FINISHED despite the deletion (insulated by open fd)');
    check((Date.now() - t0) < 60000, 'no 60s stall');
  }

  // ── B: folder mode, delete a NOT-YET-STARTED file mid-run ──
  header('B: folder — not-yet-started source deleted → that file source-missing, other OK');
  {
    const src = path.join(sandbox, 'B_src'); await fsp.mkdir(src, { recursive: true });
    const a = path.join(src, 'A_first.mov'), b = path.join(src, 'B_second.mov');
    await fsp.copyFile(SMALL_CLIP, a); await fsp.copyFile(SMALL_CLIP, b);
    const dest = path.join(sandbox, 'B_out'); await fsp.mkdir(dest, { recursive: true });
    let killedOther = false;
    const onProgress = (d) => {
      // While the first file encodes, delete the OTHER (not-yet-started) file.
      if (d.type === 'file-start' && !killedOther) {
        const other = (d.basename && d.basename.startsWith('A')) ? b : a;
        try { fs.unlinkSync(other); killedOther = true; } catch {}
      }
    };
    const res = await runBatch({ src, dest, tier: 'regular' }, () => false, onProgress);
    console.log('  result=%j', { processed: res.processed, failed: res.failed, failedNoCopy: res.failedNoCopy });
    check(killedOther, 'deleted the not-yet-started file');
    check(res.processed === 1, 'the running file still processed');
    check(res.failed === 1 && res.failedNoCopy === 1, 'the deleted not-yet-started file → source-missing');
  }

  // ── C: file-list mode (hardlink) — delete the ORIGINAL mid-encode ──
  header('C: file-list — original deleted mid-encode → staged hardlink keeps it, finishes');
  {
    const orig = path.join(sandbox, 'C_original.mov'); await fsp.copyFile(SMALL_CLIP, orig);
    // Emulate main's staging: hardlink original into a temp "stage dir".
    const stageRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'skinnyvideo-fl-'));
    const stageDir = path.join(stageRoot, 'Selected files (1)'); await fsp.mkdir(stageDir, { recursive: true });
    const link = path.join(stageDir, 'C_original.mov'); await fsp.link(orig, link);
    const dest = path.join(sandbox, 'C_out'); await fsp.mkdir(dest, { recursive: true });
    let deletedOrig = false;
    const onProgress = (d) => {
      if (d.type === 'file-progress' && !deletedOrig) { try { fs.unlinkSync(orig); deletedOrig = true; } catch {} }
    };
    const res = await runBatch({ src: stageDir, dest, tier: 'preserve' }, () => false, onProgress);
    console.log('  deletedOriginal=%s result=%j', deletedOrig, { processed: res.processed, failed: res.failed });
    check(deletedOrig, 'deleted the ORIGINAL while the staged hardlink encoded');
    check(res.processed === 1 && res.failed === 0, 'encode FINISHED via the hardlink (file-list insulation)');
    await fsp.rm(stageRoot, { recursive: true, force: true });
  }

  await fsp.rm(sandbox, { recursive: true, force: true });
  console.log('\nPASS:', PASS.length, 'FAIL:', FAIL.length);
  if (FAIL.length) { for (const l of FAIL) console.log(' - ' + l); process.exit(1); }
})().catch((e) => { console.error('TEST ERROR:', e); process.exit(2); });
