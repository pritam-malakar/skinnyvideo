// Unit test for file-list staging (src/encoder/stage.js) — FIX 1's detection:
// present sources stage fine; a missing source THROWS (so main can fail the
// batch cleanly and continue the queue instead of hanging on Running).
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const { stageFileList } = require('../src/encoder/stage');

const PASS = [], FAIL = [];
const check = (c, l) => { (c ? PASS : FAIL).push(l); console.log((c ? 'PASS' : 'FAIL') + ': ' + l); };

(async () => {
  const sandbox = await fsp.mkdtemp(path.join(os.tmpdir(), 'squeeze-stage-'));
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

  // A MISSING source → throws (this is what main catches to fail the batch).
  let threw = false, tmpLeak = false;
  const before = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('squeeze-fl-')).length;
  try {
    await stageFileList(9, [a, path.join(sandbox, 'gone.mov')]);
  } catch (e) {
    threw = true;
    check(e && (e.code === 'ENOENT' || /ENOENT|no such file/i.test(e.message)), 'throws ENOENT for the missing source');
  }
  check(threw, 'missing source makes stageFileList throw (caller fails batch cleanly)');
  const after = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('squeeze-fl-')).length;
  check(after <= before, 'temp dir self-cleaned on failure (no leak)');

  await fsp.rm(sandbox, { recursive: true, force: true });
  console.log('\nPASS:', PASS.length, 'FAIL:', FAIL.length);
  if (FAIL.length) { for (const l of FAIL) console.log(' - ' + l); process.exit(1); }
})().catch((e) => { console.error('TEST ERROR:', e); process.exit(2); });
