#!/usr/bin/env node
/* ─────────────────────────────────────────────────────────────────────────
   Dev-environment safety net (install-time only).

   WHY: electron 33.4.11's installer (node_modules/electron/install.js) unzips
   the prebuilt framework with `extract-zip`, which silently fails under Node
   24 — it extracts a ~256 KB stub, never writes path.txt, and exits 0. The
   result is a broken `npm start` ("Electron failed to install correctly")
   even though the downloaded zip in the cache is perfectly valid.

   The project pins Node 22 (.nvmrc + engines) where extract-zip works, but
   that pin is advisory — npm only warns on a mismatch, and this machine's
   default shell Node is 24. So this postinstall makes a fresh `npm install`
   self-heal on ANY Node: if electron came out stubbed, re-extract the cached
   (or freshly downloaded) zip with the system `unzip` — exactly what
   install.js intended to produce — and write path.txt.

   SAFETY: macOS-only, install-time only. Touches nothing but
   node_modules/electron/dist and node_modules/electron/path.txt. Never reads
   or writes user files / originals / app code. A no-op when electron is
   already healthy (the Node-22 case). Never throws or exits non-zero, so it
   can never break `npm install`.
   ───────────────────────────────────────────────────────────────────────── */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const TAG = '[fix-electron]';
const log = (...a) => console.log(TAG, ...a);
const warn = (...a) => console.warn(TAG, ...a);

function isFile(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }
function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }

async function main() {
  // Only macOS is in scope for this project (and for this bug).
  if (process.platform !== 'darwin') return;

  const electronDir = path.resolve(__dirname, '..', 'node_modules', 'electron');
  if (!isDir(electronDir)) return; // electron not installed (e.g. --omit=dev) → nothing to do

  let version;
  try { version = require(path.join(electronDir, 'package.json')).version; }
  catch { return; }

  const platformPath = 'Electron.app/Contents/MacOS/Electron'; // darwin
  const distPath = path.join(electronDir, 'dist');
  const binPath = path.join(distPath, platformPath);
  const frameworkPath = path.join(distPath, 'Electron.app', 'Contents', 'Frameworks', 'Electron Framework.framework');
  const pathTxt = path.join(electronDir, 'path.txt');

  // Healthy install (e.g. extracted fine under Node 22) → fast no-op.
  if (isFile(binPath) && isDir(frameworkPath) && isFile(pathTxt)) return;

  log(`electron ${version} looks stubbed (missing framework/path.txt) — repairing with system unzip…`);

  const arch = process.arch; // arm64 on this machine
  const zip = await locateOrDownloadZip(version, 'darwin', arch);
  if (!zip) {
    warn('could not locate or download the electron zip; leaving install as-is.');
    warn('fix manually: nvm use 22 && rm -rf node_modules/electron && npm install');
    return;
  }

  try {
    fs.rmSync(distPath, { recursive: true, force: true });
    fs.mkdirSync(distPath, { recursive: true });
    execFileSync('unzip', ['-q', zip, '-d', distPath], { stdio: ['ignore', 'ignore', 'inherit'] });

    // install.js parity: if the zip carried electron.d.ts at the dist root,
    // lift it up to the package root.
    const srcTypeDef = path.join(distPath, 'electron.d.ts');
    if (isFile(srcTypeDef)) {
      try { fs.renameSync(srcTypeDef, path.join(electronDir, 'electron.d.ts')); } catch {}
    }

    // path.txt — written WITHOUT a trailing newline, exactly as install.js does
    // (its isInstalled() compares the contents byte-for-byte to platformPath).
    fs.writeFileSync(pathTxt, platformPath);
  } catch (e) {
    warn('re-extraction failed:', e && e.message);
    return;
  }

  if (isFile(binPath) && isDir(frameworkPath) && isFile(pathTxt)) {
    log('repaired OK — electron framework + path.txt in place.');
  } else {
    warn('repair did not produce a complete install; please run: nvm use 22 && rm -rf node_modules/electron && npm install');
  }
}

/* Find the cached prebuilt zip; if absent, download it via @electron/get (the
   same fetch electron's own installer uses — only its extract step is broken
   under Node 24). Returns an absolute zip path, or null. */
async function locateOrDownloadZip(version, platform, arch) {
  const zipName = `electron-v${version}-${platform}-${arch}.zip`;

  const cacheRoots = [
    process.env.electron_config_cache,
    process.env.ELECTRON_CACHE,
    path.join(os.homedir(), 'Library', 'Caches', 'electron')
  ].filter((d) => d && isDir(d));

  let best = null;
  let bestSize = -1;
  const visit = (dir, depth) => {
    if (depth > 3) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) visit(p, depth + 1);
      else if (e.isFile() && e.name === zipName) {
        let size = 0; try { size = fs.statSync(p).size; } catch {}
        if (size > bestSize) { best = p; bestSize = size; }
      }
    }
  };
  for (const root of [...new Set(cacheRoots)]) visit(root, 0);

  // A real darwin electron zip is ~100 MB; anything tiny is a corrupt cache —
  // ignore it so we fall through to a fresh download.
  if (best && bestSize > 50 * 1024 * 1024) return best;

  try {
    const { downloadArtifact } = require('@electron/get');
    log('zip not cached — downloading via @electron/get…');
    return await downloadArtifact({ version, artifactName: 'electron', platform, arch });
  } catch (e) {
    warn('@electron/get download failed:', e && e.message);
    return best || null; // last resort: whatever we found, even if small
  }
}

// Never let this script fail `npm install`.
main().catch((e) => { warn('unexpected error (ignored):', e && e.message); });
