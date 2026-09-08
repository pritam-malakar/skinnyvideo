'use strict';
/* ─── Build descriptor: which build am I actually looking at? ──────────────
   app.getVersion() reads package.json in dev and CFBundleShortVersionString
   when packaged. Right after a release those are the SAME string, so the
   footer badge could not distinguish a `npm start` instance from the copy in
   /Applications — and a stale instance is an easy way to "verify" a fix that
   isn't running.

   So: dev builds get "<version>-dev.<short sha>", packaged builds get the
   version untouched. The packaged badge must stay byte-identical to what it
   has always shown; nothing here may run in a packaged build beyond the
   `packaged` early return.

   HEAD is read from the filesystem, never by shelling out to git — spawning a
   process at startup to print seven characters is not worth the latency, and a
   packaged build has no git anyway. Everything is wrapped so a missing,
   partial, or exotic .git degrades to "<version>-dev" rather than throwing on
   the launch path.

   Pure and dependency-injected (version / packaged / gitDir all passed in) so
   the packaged branch is testable from a dev process, where app.isPackaged is
   really false and cannot be forced. */
const fs = require('fs');
const path = require('path');

const SHORT_LEN = 7;
const FULL_SHA = /^[0-9a-f]{40}$/i;

const readTrimmed = (p) => fs.readFileSync(p, 'utf8').trim();

/* `.git` is normally a directory, but in a worktree or submodule it is a FILE
   holding "gitdir: <path>". Resolve that so `npm start` from a worktree still
   reports a hash instead of silently falling back. */
function resolveGitDir(gitDir) {
  let st;
  try { st = fs.statSync(gitDir); } catch { return null; }
  if (st.isDirectory()) return gitDir;
  if (!st.isFile()) return null;
  const m = /^gitdir:\s*(.+)$/m.exec(readTrimmed(gitDir));
  if (!m) return null;
  const target = m[1].trim();
  return path.isAbsolute(target) ? target : path.resolve(path.dirname(gitDir), target);
}

/* HEAD is either a raw sha (detached) or "ref: refs/heads/<branch>". For a
   symbolic ref the LOOSE file wins over packed-refs: packed-refs is a snapshot
   from the last `git gc`/`git pack-refs` and goes stale the moment a commit
   lands, so consulting it first would report an old hash on a current tree. */
function readGitShortHash(gitDir) {
  try {
    const dir = resolveGitDir(gitDir);
    if (!dir) return null;

    const head = readTrimmed(path.join(dir, 'HEAD'));
    if (FULL_SHA.test(head)) return head.slice(0, SHORT_LEN);

    const m = /^ref:\s*(.+)$/.exec(head);
    if (!m) return null;
    const ref = m[1].trim();

    try {
      const loose = readTrimmed(path.join(dir, ref));
      if (FULL_SHA.test(loose)) return loose.slice(0, SHORT_LEN);
    } catch { /* no loose ref — fall through to packed-refs */ }

    for (const line of readTrimmed(path.join(dir, 'packed-refs')).split('\n')) {
      if (!line || line[0] === '#' || line[0] === '^') continue;
      const sp = line.indexOf(' ');
      if (sp < 0) continue;
      if (line.slice(sp + 1).trim() !== ref) continue;
      const sha = line.slice(0, sp);
      return FULL_SHA.test(sha) ? sha.slice(0, SHORT_LEN) : null;
    }
    return null;
  } catch {
    return null;
  }
}

/* The badge string. Packaged → the version verbatim, no filesystem touched. */
function buildDescriptor({ version, packaged, gitDir }) {
  if (packaged) return version;
  const hash = readGitShortHash(gitDir);
  return hash ? `${version}-dev.${hash}` : `${version}-dev`;
}

module.exports = { buildDescriptor, readGitShortHash, SHORT_LEN };
