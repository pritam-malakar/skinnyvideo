const path = require('path');

/* ─── Output naming ─────────────────────────────────────────────────────
   ONE rule set for every place SkinnyVideo picks a file name: staging a
   file-list batch (stage.js), naming each encode's output (pipeline.js) and
   lifting outputs into the flat run folder (flatten.js). Pure — no fs.

   assignStems(paths, taken) → Map(path → stem). Callers add the extension.
     1. The plain stem ("C0001") when nobody has it yet.
     2. Same folder, same stem, different extension (C0001.MP4 + C0001.MOV):
        the first keeps the plain stem, later ones get "_<ext>" (C0001_mov).
        ".mp4" sources go first, then the rest in sorted extension order.
     3. Stem already taken (by an EARLIER folder, or by `taken`): that
        folder's group gets its parent folder name as a prefix — B_C0001.
     4. Still taken: numeric suffix _2, _3, …
   Folders are walked in sorted path order, so the result never depends on
   readdir or drop order. Matching is case-insensitive (APFS default).
   `taken` holds lower-cased stems and is updated in place, so a caller can
   seed it with names already on disk. */

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const extRank = (ext) => (ext.toLowerCase() === '.mp4' ? 0 : 1);

/* '' when nothing usable is left (e.g. "🎬", "/") — callers then skip the prefix. */
function safeFolderName(name) {
  return name.normalize('NFC')
    .replace(/[^\p{L}\p{M}\p{N} ._-]/gu, '_')
    .replace(/^[. _]+|[. _]+$/g, '');   // no hidden (leading-dot) or padded names
}

function assignStems(paths, taken = new Set()) {
  const items = paths.map((p) => {
    const ext = path.extname(p);
    return { p, dir: path.dirname(p), ext, stem: path.basename(p, ext) };
  }).sort((a, b) => cmp(a.dir, b.dir)
    || extRank(a.ext) - extRank(b.ext)
    || cmp(a.ext.toLowerCase(), b.ext.toLowerCase())
    || cmp(a.p, b.p));

  const groupPrefix = new Map();   // dir + stem → '' | 'Parent_'
  const out = new Map();
  for (const { p, dir, ext, stem } of items) {
    const key = `${dir}\0${stem.toLowerCase()}`;
    let name;
    if (!groupPrefix.has(key)) {
      const parent = taken.has(stem.toLowerCase()) ? safeFolderName(path.basename(dir)) : '';
      groupPrefix.set(key, parent ? `${parent}_` : '');
      name = groupPrefix.get(key) + stem;
    } else {
      name = `${groupPrefix.get(key)}${stem}_${ext.slice(1).toLowerCase()}`;
    }
    const base = name;
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base}_${n}`;
    taken.add(name.toLowerCase());
    out.set(p, name);
  }
  return out;
}

module.exports = { assignStems, safeFolderName };
