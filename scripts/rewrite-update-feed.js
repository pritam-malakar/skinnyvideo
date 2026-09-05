/* Repoint latest-mac.yml at the artifacts as they exist NOW.
 *
 * electron-builder writes latest-mac.yml during the build, recording each
 * artifact's size and sha512 at that moment. release.sh then notarizes and
 * STAPLES the dmg, which rewrites it — so the recorded dmg size and sha512
 * describe a file that no longer exists byte-for-byte, and electron-updater
 * would reject the download on its integrity check. This recomputes the dmg
 * entry (and its blockMapSize, since the blockmap is regenerated post-staple)
 * and writes it back in place.
 *
 * The zip is never rewritten, so its entry is only verified, not replaced: a
 * mismatch there means something unexpected touched it and is a hard error.
 *
 * Deliberately hand-rolled line editing rather than a YAML library — this
 * runs from a release script that must not depend on anything outside the
 * already-installed devDependencies, and the file is a flat, known shape.
 *
 * Usage: node scripts/rewrite-update-feed.js <latest-mac.yml> <dmg> <zip>
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const [ymlPath, dmgPath, zipPath] = process.argv.slice(2);
if (!ymlPath || !dmgPath || !zipPath) {
  console.error('usage: rewrite-update-feed.js <latest-mac.yml> <dmg> <zip>');
  process.exit(2);
}

const sha512b64 = (f) => crypto.createHash('sha512').update(fs.readFileSync(f)).digest('base64');
const sizeOf = (f) => fs.statSync(f).size;
const blockmapSizeOf = (f) => (fs.existsSync(f + '.blockmap') ? sizeOf(f + '.blockmap') : null);

const facts = {};
for (const f of [dmgPath, zipPath]) {
  facts[path.basename(f)] = { sha512: sha512b64(f), size: sizeOf(f), blockMapSize: blockmapSizeOf(f) };
}
const dmgName = path.basename(dmgPath);
const zipName = path.basename(zipPath);

const lines = fs.readFileSync(ymlPath, 'utf8').split('\n');

// Walk the `files:` list. Each entry opens with "  - url: <name>"; the keys that
// follow belong to it until the next entry or the end of the block.
let current = null;      // basename of the entry being scanned
let inFiles = false;
const changed = [];
const verified = [];

const setScalar = (i, key, value) => {
  const before = lines[i];
  lines[i] = lines[i].replace(new RegExp('(' + key + ':\\s*).*$'), '$1' + value);
  return lines[i] !== before;
};

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  if (/^files:\s*$/.test(line)) { inFiles = true; continue; }
  if (inFiles && /^\S/.test(line)) { inFiles = false; current = null; }

  if (inFiles) {
    const m = line.match(/^\s*-\s*url:\s*(.+?)\s*$/);
    if (m) { current = m[1]; continue; }
    if (!current || !facts[current]) continue;
    const f = facts[current];
    const isDmg = current === dmgName;

    for (const key of ['sha512', 'size', 'blockMapSize']) {
      const km = line.match(new RegExp('^\\s*' + key + ':\\s*(.*)$'));
      if (!km) continue;
      const have = km[1].trim();
      const want = String(f[key]);
      if (f[key] === null) continue;
      if (isDmg) {
        if (have !== want) { setScalar(i, key, want); changed.push(`${current} ${key}: ${have} → ${want}`); }
        else verified.push(`${current} ${key} already correct`);
      } else {
        if (have !== want) {
          console.error(`rewrite-update-feed: ${current} ${key} does not match the file on disk ` +
                        `(yml=${have}, disk=${want}). The zip is not rewritten by stapling, so this ` +
                        `is unexpected — refusing to continue.`);
          process.exit(1);
        }
        verified.push(`${current} ${key} verified`);
      }
    }
  }
}

// Top-level path/sha512 mirror whichever artifact electron-builder considers
// primary. If that is the dmg, it moved too.
const pathIdx = lines.findIndex((l) => /^path:\s*/.test(l));
if (pathIdx !== -1) {
  const primary = lines[pathIdx].replace(/^path:\s*/, '').trim();
  if (primary === dmgName) {
    const shaIdx = lines.findIndex((l, i) => i > pathIdx && /^sha512:\s*/.test(l));
    if (shaIdx !== -1) {
      const have = lines[shaIdx].replace(/^sha512:\s*/, '').trim();
      const want = facts[dmgName].sha512;
      if (have !== want) { setScalar(shaIdx, 'sha512', want); changed.push(`top-level sha512 (path=${primary}): updated`); }
    }
  } else {
    verified.push(`top-level path is ${primary} (not the dmg) — left alone`);
  }
}

fs.writeFileSync(ymlPath, lines.join('\n'));

for (const v of verified) console.log('  verified: ' + v);
for (const c of changed) console.log('  rewrote:  ' + c);
if (!changed.length) console.log('  (nothing needed rewriting)');
