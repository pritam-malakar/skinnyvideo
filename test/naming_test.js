// Output naming rules (src/encoder/naming.js). Pure — no fs, no electron.
const { assignStems } = require('../src/encoder/naming');

const FAIL = [];
function check(cond, label) { if (!cond) FAIL.push(label); console.log((cond ? 'PASS' : 'FAIL') + ': ' + label); }
const names = (paths, taken) => {
  const m = assignStems(paths, taken);
  return paths.map((p) => m.get(p));
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Same stem, different extension, same folder.
let got = names(['/s/A/C0001.MOV', '/s/A/C0001.MP4']);
check(eq(got, ['C0001_mov', 'C0001']), `same stem diff ext → C0001 + C0001_mov (got ${got})`);
got = names(['/s/A/C0001.MP4', '/s/A/C0001.MOV']);
check(eq(got, ['C0001', 'C0001_mov']), `…and input order does not matter (got ${got})`);

// Same filename, different folders.
got = names(['/s/B/C0001.MP4', '/s/A/C0001.MP4']);
check(eq(got, ['B_C0001', 'C0001']), `same name diff folders → C0001 + B_C0001 (got ${got})`);

// Both at once (the Part D fixture), plus B's own .MOV sibling.
got = names(['/s/A/C0001.MP4', '/s/B/C0001.MP4', '/s/A/C0001.MOV', '/s/C/C0002.MP4', '/s/B/C0001.MOV']);
check(eq(got, ['C0001', 'B_C0001', 'C0001_mov', 'C0002', 'B_C0001_mov']),
  `both at once (got ${got})`);

// Three-way collisions.
got = names(['/s/C/C0001.MP4', '/s/A/C0001.MP4', '/s/B/C0001.MP4']);
check(eq(got, ['C_C0001', 'C0001', 'B_C0001']), `three folders (got ${got})`);
got = names(['/s/A/C0001.MXF', '/s/A/C0001.MOV', '/s/A/C0001.MP4']);
check(eq(got, ['C0001_mxf', 'C0001_mov', 'C0001']), `three extensions (got ${got})`);
got = names(['/s/X/B/C0001.MP4', '/s/Y/B/C0001.MP4', '/s/A/C0001.MP4']);
check(eq(got, ['B_C0001', 'B_C0001_2', 'C0001']), `prefix still collides → numeric _2 (got ${got})`);

// Spaces, unicode, unsafe folder characters.
got = names(['/s/Día 2/Clip 01.mov', '/s/Día 1/Clip 01.mov']);
check(eq(got, ['Día 2_Clip 01', 'Clip 01']), `spaces + unicode kept (got ${got})`);
got = names(['/s/a:b*c/x.mp4', '/s/0/x.mp4']);
check(eq(got, ['a_b_c_x', 'x']), `unsafe folder chars sanitised (got ${got})`);
got = names(['/s/🎬/x.mp4'], new Set(['x']));
check(eq(got, ['x_2']), `folder name with nothing usable → no prefix, numeric _2 (got ${got})`);
got = names(['/s/.hidden/x.mp4'], new Set(['x']));
check(eq(got, ['hidden_x']), `prefix never makes a hidden file (got ${got})`);

// Case-insensitive, and seeded with names already on disk.
got = names(['/s/A/clip.mp4', '/s/B/CLIP.MP4']);
check(eq(got, ['clip', 'B_CLIP']), `case-insensitive collision (got ${got})`);
got = names(['/s/B/C0001.MP4'], new Set(['c0001']));
check(eq(got, ['B_C0001']), `seeded taken → prefixed (got ${got})`);

// Every name unique across a messy set.
const messy = ['/s/A/x.MP4', '/s/A/x.mov', '/s/B/x.mp4', '/s/B/x.MOV', '/s/A/x_mov.mp4', '/s/C/B_x.mp4'];
const all = names(messy).map((n) => n.toLowerCase());
check(new Set(all).size === messy.length, `no two sources share a name (got ${names(messy)})`);

console.log(FAIL.length ? `\n${FAIL.length} FAILED` : '\nALL PASS');
process.exit(FAIL.length ? 1 : 0);
