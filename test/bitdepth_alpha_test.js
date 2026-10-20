/* 3.3.0 Item 2 — 12-bit and alpha.

   ARGS (pure buildArgs, both tiers, primary + fallback):
     yuva444p12le → Main10 (VT: -profile:v main10 -pix_fmt p010le; x265:
                    -pix_fmt yuv420p10le) and -vf format=yuv444p12le (alpha
                    dropped, same subsampling and depth)
     yuv422p10le  → Main10, no -vf (unchanged)
     yuv420p12le  → Main10 (was: no -pix_fmt → x265 wrote 12-bit Rext)
     yuva420p     → 8-bit, -vf format=yuv420p (x265 used to exit 211)
   NOTE (fake child, real runBatch): an alpha source logs
     `NOTE <src> alpha channel discarded` and carries a row NOTE.
   REAL (bundled ffmpeg): a synthetic ProRes 4444 with alpha (decodes as
     yuva444p12le, like the real yellow-car clip) encodes in BOTH tiers, with
     the NOTE line, to a 10-bit 4:2:0 HEVC Main 10 output.

   FAIL-ON-OLD (3.2.2): is10Bit() matched only "10" formats, so 12-bit sources
   got no Main10 args, and nothing removed alpha (x265 exit 211).
   Run: node test/bitdepth_alpha_test.js */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const realSpawn = require('child_process').spawn;

// spawn spy, OFF unless `fake` is set — the REAL section uses the real binary.
const cp = require('child_process');
let fake = null;
cp.spawn = function (cmd, args, opts) {
  if (!fake) return realSpawn(cmd, args, opts);
  const c = new EventEmitter();
  c.stdout = new PassThrough(); c.stderr = new PassThrough();
  let closed = false;
  const close = (code) => { if (closed) return; closed = true; c.emit('exit', code, null); setTimeout(() => { c.stdout.end(); c.stderr.end(); c.emit('close', code, null); }, 10); };
  c.kill = () => { close(255); return true; };
  const file = args[args.length - 1];
  if (/ffprobe$/.test(cmd)) {
    const frames = args.some((a) => String(a).startsWith('frame='));
    setTimeout(() => {
      c.stdout.write(JSON.stringify(frames ? { frames: [{}] } : { streams: [{ index: 0, codec_type: 'video', codec_name: 'prores', pix_fmt: fake.pix, width: 1920, height: 1080, duration: '20' }], format: { duration: '20.0', size: '100' } }));
      close(0);
    }, 5);
    return c;
  }
  if (args.includes('-version')) { setTimeout(() => { c.stdout.write('ffmpeg version fake\n'); close(0); }, 5); return c; }
  fake.args.push(args);
  fs.writeFileSync(file, 'encoded');
  setTimeout(() => close(0), 30);
  return c;
};

const ROOT = path.join(__dirname, '..');
const P = require(path.join(ROOT, 'src/encoder/pipeline'));

const PASS = [], FAIL = [];
const check = (c, l) => { (c ? PASS : FAIL).push(l); console.log((c ? 'PASS' : 'FAIL') + ': ' + l); };
const SB = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sv-bitalpha-')));
const walk = (d, out = []) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p, out); else out.push(p); } return out; };

const argsFor = (pix, tier, fb) => (fb ? P.buildFallbackArgs : P.buildArgs)({ input: '/in/c.mov', tmpOut: '/out/c.tmp.mp4', tier, videoStream: { pix_fmt: pix }, audioStreams: [] }).join(' ');
const vfOf = (a) => { const m = / -vf (\S+)/.exec(a); return m ? m[1] : null; };

(async () => {
  try {
    // ── ARGS ──
    const CASES = [
      { pix: 'yuva444p12le', main10: true, vf: 'format=yuv444p12le' },
      { pix: 'yuv422p10le', main10: true, vf: null },
      { pix: 'yuv420p12le', main10: true, vf: null },
      { pix: 'yuva420p', main10: false, vf: 'format=yuv420p' }
    ];
    for (const c of CASES) {
      const vt = argsFor(c.pix, 'regular'), x = argsFor(c.pix, 'preserve'), fb = argsFor(c.pix, 'preserve', true);
      check(c.main10 ? / -profile:v main10 -pix_fmt p010le /.test(vt) : !/ -pix_fmt /.test(vt),
        `${c.pix} Make It Fast: ${c.main10 ? 'Main 10 (main10 / p010le)' : '8-bit, no -pix_fmt'} (${vt})`);
      check(c.main10 ? / -pix_fmt yuv420p10le /.test(x) && / -pix_fmt yuv420p10le /.test(fb) : !/ -pix_fmt /.test(x),
        `${c.pix} Slow But Better + fallback: ${c.main10 ? 'Main 10 (yuv420p10le)' : '8-bit, no -pix_fmt'} (${x})`);
      check(vfOf(vt) === c.vf && vfOf(x) === c.vf && vfOf(fb) === c.vf, `${c.pix}: -vf ${c.vf || '(none)'} in both tiers and the fallback (got ${vfOf(vt)} / ${vfOf(x)} / ${vfOf(fb)})`);
    }
    const stamped = P.buildArgs({ input: 'i', tmpOut: 'o.mp4', tier: 'preserve', videoStream: { pix_fmt: 'yuva444p12le' }, audioStreams: [], colorStamp: { color_trc: 'bt709' } }).join(' ');
    check(/ -vf setparams=color_trc=bt709,format=yuv444p12le /.test(stamped), `colour stamp and alpha drop share one -vf (${vfOf(stamped)})`);
    const dc8 = P.buildArgs({ input: 'i', tmpOut: 'o.mp4', settings: { ...P.tierDefaults('preserve'), downconvert8: true }, videoStream: { pix_fmt: 'yuv420p12le' }, audioStreams: [] }).join(' ');
    check(/ -pix_fmt yuv420p /.test(dc8), `10-bit → 8-bit (Nerd Mode) applies to 12-bit sources too (${dc8})`);

    // ── NOTE via the real runBatch (fake child) ──
    {
      const src = path.join(SB, 'note', 'Card'), dest = path.join(SB, 'note', 'Out');
      fs.mkdirSync(src, { recursive: true }); fs.mkdirSync(dest, { recursive: true });
      fs.writeFileSync(path.join(src, 'car.mov'), Buffer.alloc(4096, 1));
      fake = { pix: 'yuva444p12le', args: [] };
      const ev = [];
      const res = await P.runBatch({ src, dest, tier: 'preserve', kind: 'folder' }, {}, (e) => ev.push(e));
      fake = null;
      const log = fs.readFileSync(walk(dest).find((f) => f.endsWith('compress.log')), 'utf8');
      const done = ev.find((e) => e.type === 'file-done');
      check(/^NOTE .*car\.mov alpha channel discarded$/m.test(log), 'NOTE: log has `NOTE <src> alpha channel discarded`');
      check(done && done.outcome === 'ok' && Array.isArray(done.notes) && done.notes.some((n) => /Alpha/.test(n)), `NOTE: file OK and row NOTE carried (${done && JSON.stringify(done.notes)})`);
      check(res.processed === 1, `NOTE: processed (${res.processed})`);
    }

    // ── REAL: synthetic ProRes 4444 + alpha, both tiers ──
    if (!P.ffmpegStatus(P.getBinaries()).ok) { console.log('SKIP REAL: bundled ffmpeg missing'); }
    else {
      for (const tier of ['regular', 'preserve']) {
        const src = path.join(SB, 'real_' + tier, 'Card'), dest = path.join(SB, 'real_' + tier, 'Out');
        fs.mkdirSync(src, { recursive: true }); fs.mkdirSync(dest, { recursive: true });
        const clip = path.join(src, 'alpha4444.mov');
        const r = require('child_process').spawnSync(P.getBinaries().ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
          'testsrc2=s=320x240:r=25:d=2,format=yuva444p10le', '-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le', clip], { encoding: 'utf8' });
        if (r.status !== 0) throw new Error('fixture: ' + r.stderr);
        const srcPix = (await P.ffprobeJson(clip)).streams[0].pix_fmt;
        const ev = [];
        const res = await P.runBatch({ src, dest, tier, kind: 'folder' }, {}, (e) => ev.push(e));
        const files = walk(dest);
        const log = fs.readFileSync(files.find((f) => f.endsWith('compress.log')), 'utf8');
        const out = files.find((f) => f.endsWith('alpha4444.mp4'));
        const os_ = out ? (await P.ffprobeJson(out)).streams.find((s) => s.codec_type === 'video') : null;
        check(srcPix === 'yuva444p12le', `REAL ${tier}: fixture decodes as yuva444p12le like the real clip (${srcPix})`);
        check(res.processed === 1 && !!out, `REAL ${tier}: ProRes 4444 + alpha encodes (processed ${res.processed}, failed ${res.failed})`);
        check(/^NOTE .*alpha4444\.mov alpha channel discarded$/m.test(log), `REAL ${tier}: NOTE line logged`);
        check(os_ && os_.pix_fmt === 'yuv420p10le' && os_.profile === 'Main 10', `REAL ${tier}: output is 10-bit Main 10 (${os_ && os_.pix_fmt} ${os_ && os_.profile})`);
      }
    }
  } catch (e) {
    console.error(e);
    FAIL.push('unexpected throw: ' + (e && e.message));
  }
  try { fs.rmSync(SB, { recursive: true, force: true }); } catch {}
  console.log(`\n[bitdepth-alpha] PASS: ${PASS.length} FAIL: ${FAIL.length}`);
  process.exit(FAIL.length ? 1 : 0);
})();
