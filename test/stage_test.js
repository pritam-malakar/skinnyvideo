// Unit test for file-list staging (src/encoder/stage.js).
// v2.1.14 PER-FILE ISOLATION (BUG 2): present sources stage fine; a missing
// source is RECORDED in `missing` (not thrown) and the rest still stage — so
// main encodes what it can and fails only the missing file, never the batch.
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const { stageFileList } = require('../src/encoder/stage');

const PASS = [], FAIL = [];
const check = (c, l) => { (c ? PASS : FAIL).push(l); console.log((c ? 'PASS' : 'FAIL') + ': ' + l); };

(async () => {
  const sandbox = await fsp.mkdtemp(path.join(os.tmpdir(), 'skinnyvideo-stage-'));
  const a = path.join(sandbox, 'a.mov'), b = path.join(sandbox, 'b.mov');
  await fsp.writeFile(a, 'AAA'); await fsp.writeFile(b, 'BBB');

  // Present sources → staged OK, map back to originals.
  const staged = await stageFileList(7, [a, b]);
  check(fs.existsSync(staged.stageDir), 'stageDir created');
  const names = fs.readdirSync(staged.stageDir).sort();
  check(names.length === 2, 'both files staged');
  const origs = [...staged.stageMap.values()].sort();
  check(JSON.stringify(origs) === JSON.stringify([a, b].sort()), 'stageMap maps temp → original');
  // hardlinks share content
  check(fs.readFileSync(path.join(staged.stageDir, 'a.mov'), 'utf8') === 'AAA', 'staged content matches');
  await fsp.rm(staged.tmpRoot, { recursive: true, force: true });

  // Duplicate basenames → renamed, both staged, both mapped.
  const sub = path.join(sandbox, 'sub'); await fsp.mkdir(sub);
  const a2 = path.join(sub, 'a.mov'); await fsp.writeFile(a2, 'A2');
  const dup = await stageFileList(8, [a, a2]);
  check(fs.readdirSync(dup.stageDir).length === 2, 'duplicate basenames both staged (renamed)');
  check(dup.stageMap.size === 2 && [...dup.stageMap.values()].includes(a) && [...dup.stageMap.values()].includes(a2),
    'both duplicate-basename originals mapped');
  await fsp.rm(dup.tmpRoot, { recursive: true, force: true });

  // PER-FILE ISOLATION: one missing source among present ones → the present
  // ones still stage; the missing one is reported in `missing`; NO throw.
  const gone = path.join(sandbox, 'gone.mov');
  const mixed = await stageFileList(9, [a, gone, b]);
  check(Array.isArray(mixed.missing) && mixed.missing.length === 1 && mixed.missing[0] === gone,
    'missing source recorded in `missing` (not thrown)');
  check(fs.readdirSync(mixed.stageDir).length === 2, 'the two present sources still staged around the missing one');
  check(mixed.stageMap.size === 2 && [...mixed.stageMap.values()].includes(a) && [...mixed.stageMap.values()].includes(b),
    'staged map covers exactly the present sources');
  await fsp.rm(mixed.tmpRoot, { recursive: true, force: true });

  // ALL sources missing → empty stage, every source listed in `missing`, no throw.
  const allGone = await stageFileList(10, [path.join(sandbox, 'x.mov'), path.join(sandbox, 'y.mov')]);
  check(allGone.missing.length === 2 && allGone.stageMap.size === 0 && fs.readdirSync(allGone.stageDir).length === 0,
    'all-missing → empty stage + both in `missing`, still no throw');
  await fsp.rm(allGone.tmpRoot, { recursive: true, force: true });

  await fsp.rm(sandbox, { recursive: true, force: true });
  console.log('\nPASS:', PASS.length, 'FAIL:', FAIL.length);
  if (FAIL.length) { for (const l of FAIL) console.log(' - ' + l); process.exit(1); }
})().catch((e) => { console.error('TEST ERROR:', e); process.exit(2); });
