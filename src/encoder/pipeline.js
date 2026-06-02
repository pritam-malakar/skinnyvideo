const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { spawn } = require('child_process');
let _electronApp = null;
try { _electronApp = require('electron').app; } catch {}

const VIDEO_EXTS = new Set([
  '.mp4', '.mov', '.m4v', '.mkv', '.avi', '.mts', '.m2ts',
  '.mpg', '.mpeg', '.wmv', '.flv', '.webm', '.mxf',
  '.prores', '.dnxhd', '.avchd', '.3gp', '.3g2', '.ts', '.vob', '.ogv'
]);

const TIER_CONSTANTS = {
  regular:  { qv: 62 },
  preserve: { crf: 20, preset: 'medium' }
};

function getBinaries() {
  let base;
  if (_electronApp && _electronApp.isPackaged) {
    base = path.join(process.resourcesPath, 'bin');
  } else {
    base = path.join(__dirname, '..', '..', 'resources', 'bin');
  }
  return {
    ffmpeg: path.join(base, 'ffmpeg'),
    ffprobe: path.join(base, 'ffprobe')
  };
}

/* BUG 3 — anti-hang on a vanished destination.
   STALL_TIMEOUT_MS: if an encoder emits NOTHING (no stdout/stderr) for this
   long, we treat it as wedged. ffmpeg with -stats prints a progress line on
   a sub-second cadence while it's alive, so total silence this long means it
   is blocked — classically on a write() to a destination volume that was
   ejected/unmounted mid-run. We kill it and resolve immediately so a child
   stuck in uninterruptible I/O can never hang the queue.
   REACH_TIMEOUT_MS caps the destination-writability probe so a stale mount
   can't hang that check either. */
const STALL_TIMEOUT_MS = 60000;
const REACH_TIMEOUT_MS = 3000;
// Hard cap on a single ffprobe — it emits all output at once at the end, so a
// wedged probe (source on a vanished volume) is caught by the same watchdog.
const PROBE_TIMEOUT_MS = 15000;

/* Resolve a promise but never wait longer than `ms`; on timeout resolve to
   `fallbackVal`. Used to bound fs probes that could otherwise hang on a dead
   mount. */
function withTimeout(promise, ms, fallbackVal) {
  return new Promise((resolve) => {
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; resolve(fallbackVal); } }, ms);
    promise.then(
      (v) => { if (!done) { done = true; clearTimeout(t); resolve(v); } },
      () => { if (!done) { done = true; clearTimeout(t); resolve(fallbackVal); } }
    );
  });
}

/* True only if `dir` is writable right now. Bounded by REACH_TIMEOUT_MS so a
   stale/half-dead mount returns false fast instead of blocking. */
async function isDestWritable(dir) {
  if (!dir || typeof dir !== 'string') return false;
  return withTimeout(
    fsp.access(dir, fs.constants.W_OK).then(() => true, () => false),
    REACH_TIMEOUT_MS,
    false
  );
}

/* BUG B — true only if `file` still exists and is readable right now. Bounded
   by REACH_TIMEOUT_MS so a source that was deleted/moved (fast ENOENT) OR sits
   on a volume that vanished (would otherwise block on I/O) both return false
   quickly instead of hanging the encode. */
async function isSourceReadable(file) {
  if (!file || typeof file !== 'string') return false;
  return withTimeout(
    fsp.access(file, fs.constants.R_OK).then(() => true, () => false),
    REACH_TIMEOUT_MS,
    false
  );
}

function runCmd(cmd, args, { onStderr, onStdout, signal, onSpawn, stallTimeoutMs, isPaused, isCancelled } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    if (onSpawn) { try { onSpawn(child); } catch {} }
    let stdout = '';
    let stderr = '';
    let settled = false;
    let stallTimer = null;
    let cancelPoll = null;
    const clearStall = () => { if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; } };
    const clearCancel = () => { if (cancelPoll) { clearInterval(cancelPoll); cancelPoll = null; } };
    const finish = (val) => { if (settled) return; settled = true; clearStall(); clearCancel(); resolve(val); };
    const fail = (err) => { if (settled) return; settled = true; clearStall(); clearCancel(); reject(err); };
    /* BUG C — cancel must ALWAYS terminate. Poll the cancel flag; the moment
       it's set, kill the child (SIGTERM then a bounded SIGKILL) and resolve
       IMMEDIATELY. We do not wait for 'close' — a child wedged in
       uninterruptible I/O (e.g. a vanished source/dest volume) may never
       close, so resolving on the flag is what unsticks the queue. The OS reaps
       the lingering process when its I/O finally errors. */
    if (isCancelled) {
      cancelPoll = setInterval(() => {
        if (!isCancelled()) return;
        try { child.kill('SIGTERM'); } catch {}
        setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 800);
        finish({ code: -1, stdout, stderr, child, cancelled: true });
      }, 150);
    }
    /* (Re)arm the inactivity watchdog. Any output cancels and restarts it, so
       it only fires after a full window of true silence. */
    function armStall() {
      if (!stallTimeoutMs) return;
      clearStall();
      stallTimer = setTimeout(() => {
        // A paused encode (SIGSTOP) legitimately emits nothing — never kill
        // it; just keep watching until it resumes.
        if (isPaused && isPaused()) { armStall(); return; }
        try { child.kill('SIGTERM'); } catch {}
        setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 1500);
        // Resolve NOW regardless of whether 'close' ever arrives.
        finish({ code: -1, stdout, stderr, child, stalled: true });
      }, stallTimeoutMs);
    }
    child.stdout.on('data', (d) => {
      const s = d.toString();
      stdout += s;
      armStall();
      if (onStdout) onStdout(s);
    });
    child.stderr.on('data', (d) => {
      const s = d.toString();
      stderr += s;
      armStall();
      if (onStderr) onStderr(s);
    });
    child.on('error', fail);
    child.on('close', (code) => finish({ code, stdout, stderr, child }));
    if (signal) {
      signal.attach(() => { try { child.kill('SIGTERM'); } catch {} });
    }
    armStall();   // start watching at spawn — covers a dest that's already dead
  });
}

async function ffprobeJson(file) {
  const { ffprobe } = getBinaries();
  const args = ['-v', 'quiet', '-print_format', 'json', '-show_streams', '-show_format', file];
  // BUG B: bound the probe so a source on a vanished volume can't hang it.
  const { code, stdout } = await runCmd(ffprobe, args, { stallTimeoutMs: PROBE_TIMEOUT_MS });
  if (code !== 0) return null;
  try { return JSON.parse(stdout); } catch { return null; }
}

function pickVideoStream(streams) {
  if (!streams) return null;
  for (const s of streams) {
    if (s.codec_type !== 'video') continue;
    if (s.disposition && s.disposition.attached_pic === 1) continue;
    const c = (s.codec_name || '').toLowerCase();
    if (c === 'mjpeg' || c === 'png' || c === 'gif' || c === 'bmp') continue;
    return s;
  }
  return null;
}

function pickAudioStream(streams) {
  if (!streams) return null;
  return streams.find((s) => s.codec_type === 'audio') || null;
}

async function isVideoFile(file) {
  const ext = path.extname(file).toLowerCase();
  if (!VIDEO_EXTS.has(ext)) return false;
  const probe = await ffprobeJson(file);
  if (!probe) return false;
  return !!pickVideoStream(probe.streams);
}

async function walkAll(dir, out) {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walkAll(full, out);
    else if (e.isFile()) out.push(full);
  }
}

async function gatherInputs(srcPath) {
  const stat = await fsp.stat(srcPath);
  const out = [];
  if (stat.isFile()) {
    out.push(srcPath);
    return { rootKind: 'file', root: srcPath, files: out };
  }
  await walkAll(srcPath, out);
  return { rootKind: 'dir', root: srcPath, files: out };
}

async function scanFolder(srcPath) {
  const { rootKind, root, files } = await gatherInputs(srcPath);
  const videos = [];
  let ignored = 0;
  for (const f of files) {
    const ext = path.extname(f).toLowerCase();
    if (!VIDEO_EXTS.has(ext)) { ignored++; continue; }
    const probe = await ffprobeJson(f);
    if (!probe) { ignored++; continue; }
    const vs = pickVideoStream(probe.streams);
    if (!vs) { ignored++; continue; }
    videos.push({
      file: f,
      size: Number(probe.format?.size || 0),
      codec: vs.codec_name,
      width: vs.width,
      height: vs.height,
      pix_fmt: vs.pix_fmt,
      duration: Number(probe.format?.duration || 0)
    });
  }
  return { rootKind, root, videos, ignored, totalSize: videos.reduce((a, v) => a + v.size, 0) };
}

function tsRunFolder(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `Compressed_${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}`;
}

function relativeFromRoot(rootKind, root, file) {
  if (rootKind === 'file') return path.basename(file);
  const rel = path.relative(path.dirname(root), file);
  return rel;
}

function destForInput(runDir, rootKind, root, inputFile) {
  const rel = relativeFromRoot(rootKind, root, inputFile);
  const parsed = path.parse(rel);
  const dir = path.join(runDir, parsed.dir);
  const finalName = parsed.name + '.mp4';
  return {
    finalPath: path.join(dir, finalName),
    tmpPath: path.join(dir, parsed.name + '.tmp.mp4'),
    dir
  };
}

function humanBytes(n) {
  if (!Number.isFinite(n)) return '0 B';
  const sign = n < 0 ? '-' : '';
  n = Math.abs(n);
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return sign + n.toFixed(n >= 10 || i === 0 ? 0 : 1) + ' ' + units[i];
}

function is10Bit(pixFmt) {
  if (!pixFmt) return false;
  return /10le|10be|p010|p210|p410/.test(pixFmt);
}

function shortEdge(w, h) {
  if (!w || !h) return null;
  return Math.min(w, h);
}

function buildArgs({ input, tmpOut, tier, videoStream, audioStream }) {
  const args = ['-y', '-nostdin', '-hide_banner', '-loglevel', 'error', '-stats', '-i', input];
  const tenBit = is10Bit(videoStream?.pix_fmt);

  const colorArgs = [];
  if (videoStream?.color_primaries && videoStream.color_primaries !== 'unknown')
    colorArgs.push('-color_primaries', videoStream.color_primaries);
  if (videoStream?.color_transfer && videoStream.color_transfer !== 'unknown')
    colorArgs.push('-color_trc', videoStream.color_transfer);
  if (videoStream?.color_space && videoStream.color_space !== 'unknown')
    colorArgs.push('-colorspace', videoStream.color_space);
  if (videoStream?.color_range && videoStream.color_range !== 'unknown')
    colorArgs.push('-color_range', videoStream.color_range);

  if (tier === 'regular') {
    args.push('-c:v', 'hevc_videotoolbox', '-q:v', String(TIER_CONSTANTS.regular.qv), '-tag:v', 'hvc1');
    if (tenBit) args.push('-profile:v', 'main10', '-pix_fmt', 'p010le');
  } else if (tier === 'preserve') {
    args.push('-c:v', 'libx265', '-crf', String(TIER_CONSTANTS.preserve.crf),
      '-preset', TIER_CONSTANTS.preserve.preset, '-tag:v', 'hvc1');
    if (tenBit) args.push('-pix_fmt', 'yuv420p10le');
  }

  args.push(...colorArgs);

  if (audioStream) {
    const aCodec = (audioStream.codec_name || '').toLowerCase();
    if (aCodec.startsWith('pcm_')) {
      args.push('-c:a', 'aac', '-b:a', '320k');
    } else {
      args.push('-c:a', 'copy');
    }
  } else {
    args.push('-an');
  }

  args.push('-map_metadata', '0', '-movflags', 'use_metadata_tags+faststart');
  args.push(tmpOut);
  return args;
}

function buildFallbackArgs({ input, tmpOut, tier, videoStream, audioStream }) {
  const args = ['-y', '-nostdin', '-hide_banner', '-loglevel', 'error', '-stats', '-i', input];
  const tenBit = is10Bit(videoStream?.pix_fmt);
  args.push('-c:v', 'libx265', '-crf', '22', '-preset', 'medium', '-tag:v', 'hvc1');
  if (tenBit) args.push('-pix_fmt', 'yuv420p10le');

  const colorArgs = [];
  if (videoStream?.color_primaries && videoStream.color_primaries !== 'unknown')
    colorArgs.push('-color_primaries', videoStream.color_primaries);
  if (videoStream?.color_transfer && videoStream.color_transfer !== 'unknown')
    colorArgs.push('-color_trc', videoStream.color_transfer);
  if (videoStream?.color_space && videoStream.color_space !== 'unknown')
    colorArgs.push('-colorspace', videoStream.color_space);
  args.push(...colorArgs);

  if (audioStream) {
    const aCodec = (audioStream.codec_name || '').toLowerCase();
    if (aCodec.startsWith('pcm_')) args.push('-c:a', 'aac', '-b:a', '320k');
    else args.push('-c:a', 'copy');
  } else {
    args.push('-an');
  }
  args.push('-map_metadata', '0', '-movflags', 'use_metadata_tags+faststart');
  args.push(tmpOut);
  return args;
}

function parseFFmpegTime(stderr) {
  const m = /time=(\d+):(\d+):(\d+\.\d+)/.exec(stderr);
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

async function ensureDir(d) { await fsp.mkdir(d, { recursive: true }); }

async function copyToFailed(runDir, rootKind, root, file) {
  const failedDir = path.join(runDir, '_FAILED');
  const rel = relativeFromRoot(rootKind, root, file);
  const dest = path.join(failedDir, rel);
  await ensureDir(path.dirname(dest));
  await fsp.copyFile(file, dest, fs.constants.COPYFILE_EXCL).catch(async (e) => {
    if (e.code === 'EEXIST') return;
    throw e;
  });
}

async function setMtimeFromSource(src, dst) {
  try {
    const s = await fsp.stat(src);
    await fsp.utimes(dst, s.atime, s.mtime);
  } catch {}
}

class StopSignal {
  constructor(shouldStopFn) { this.shouldStopFn = shouldStopFn; this._cbs = []; }
  attach(cb) { this._cbs.push(cb); }
  poll() {
    if (this.shouldStopFn && this.shouldStopFn()) {
      for (const cb of this._cbs) cb();
      this._cbs = [];
      return true;
    }
    return false;
  }
}

async function runBatch(batch, controlOrFn, onProgress) {
  // controlOrFn may be a legacy shouldStopFn function, or a control object:
  //   { shouldStop(), isCancelled(), onSpawn(child) }
  const ctl = typeof controlOrFn === 'function'
    ? { shouldStop: controlOrFn, isCancelled: () => false, onSpawn: null }
    : (controlOrFn || {});
  const shouldStop  = ctl.shouldStop  || (() => false);
  const isCancelled = ctl.isCancelled || (() => false);
  const onSpawn     = ctl.onSpawn     || null;
  const isPaused    = ctl.isPaused    || (() => false);

  const { src, dest, tier } = batch;
  const runDir = path.join(dest, tsRunFolder());

  /* BUG 3 — fail fast if the destination is unreachable before we write a
     single byte (drive never mounted / already ejected). Bail with a
     destLost result instead of hanging on mkdir to a dead path. */
  if (!(await isDestWritable(dest))) {
    return {
      runDir, logPath: null,
      processed: 0, failed: 0, failedCopied: 0, failedNoCopy: 0, failedDestLost: 0,
      alreadyDone: 0, skippedNonVideo: 0, reclaimed: 0, totalFiles: 0,
      destLost: true
    };
  }
  await ensureDir(runDir);

  const logPath = path.join(runDir, 'compress.log');
  const logStream = fs.createWriteStream(logPath, { flags: 'a' });
  // If the drive vanishes mid-run, log writes error asynchronously — swallow
  // so an unhandled 'error' can't crash the process.
  logStream.on('error', () => {});
  const log = (line) => { try { logStream.write(line + '\n'); } catch {} };
  log(`# Squeeze run started ${new Date().toISOString()}`);
  log(`# Source: ${src}`);
  log(`# Destination: ${runDir}`);
  log(`# Tier: ${tier}`);

  const scan = await scanFolder(src);
  log(`# Found ${scan.videos.length} video file(s); ${scan.ignored} ignored (non-video)`);

  const totalFiles = scan.videos.length;
  let done = 0;
  let processed = 0;
  let failed = 0;
  let failedCopied = 0;     // failed, but original preserved to _FAILED/
  let failedNoCopy = 0;     // failed AND original unreadable/missing — no copy made
  let failedDestLost = 0;   // failed because the destination drive went away
  let destLost = false;     // sticky once the destination is confirmed gone
  let alreadyDone = 0;
  let reclaimed = 0;
  const startTs = Date.now();

  const { ffmpeg } = getBinaries();

  /* Record an ordinary file failure (corrupt/undecodable, or a stuck encode
     on a HEALTHY dest): try to preserve the source to _FAILED/ and classify
     whether that copy actually landed. Mutates the closure counters. */
  async function recordPlainFailure(v, i) {
    failed++; done++;
    let copied = false;
    /* Only attempt the _FAILED/ copy if the source is still readable —
       otherwise the copy would block on the same vanished-source I/O (BUG B). */
    if (await isSourceReadable(v.file)) {
      try {
        await copyToFailed(runDir, scan.rootKind, scan.root, v.file);
        copied = true;
      } catch (e) {
        log(`FAILED-COPY-ERROR ${v.file} :: ${e.message}`);
      }
    }
    if (copied) {
      failedCopied++;
      log(`FAIL ${v.file} (copied to _FAILED)`);
    } else {
      failedNoCopy++;
      log(`FAIL ${v.file} (original could not be read — may have been moved or deleted during the run; no _FAILED copy made)`);
    }
    onProgress && onProgress({
      type: 'file-done', index: i + 1, total: totalFiles,
      file: v.file, basename: path.basename(v.file),
      reclaimed, processed, failed, alreadyDone,
      elapsedMs: Date.now() - startTs, outcome: 'fail',
      failKind: copied ? 'copied' : 'nocopy'
    });
  }

  /* BUG B — source vanished (deleted/moved/volume gone) before or during its
     encode. Fail this file fast with a clear "source missing" message — no
     output, no _FAILED/ copy possible — and let the queue CONTINUE. Reuses the
     no-copy bucket so the run summary reads "couldn't be read — may have been
     moved or deleted during the run." */
  function recordSourceMissing(v, i) {
    failed++; failedNoCopy++; done++;
    log(`SOURCE-MISSING ${v.file} (source could not be read — may have been moved or deleted during the run; skipped, no _FAILED copy)`);
    onProgress && onProgress({
      type: 'file-done', index: i + 1, total: totalFiles,
      file: v.file, basename: path.basename(v.file),
      reclaimed, processed, failed, alreadyDone,
      elapsedMs: Date.now() - startTs, outcome: 'fail',
      failKind: 'source-missing'
    });
  }

  /* Record a destination-lost failure: the drive is gone, so no output and no
     _FAILED/ copy are possible. Sets destLost so the batch loop stops. */
  function recordDestLost(v, i) {
    destLost = true; failed++; failedDestLost++; done++;
    log(`DEST-LOST ${v.file} (destination drive became unavailable; no output and no _FAILED copy made)`);
    onProgress && onProgress({
      type: 'file-done', index: i + 1, total: totalFiles,
      file: v.file, basename: path.basename(v.file),
      reclaimed, processed, failed, alreadyDone,
      elapsedMs: Date.now() - startTs, outcome: 'fail',
      failKind: 'dest-lost'
    });
  }

  for (let i = 0; i < scan.videos.length; i++) {
    if (shouldStop() || isCancelled()) {
      log(`# Stopped by user after ${done} of ${totalFiles}`);
      break;
    }
    const v = scan.videos[i];
    const { finalPath, tmpPath, dir } = destForInput(runDir, scan.rootKind, scan.root, v.file);
    /* BUG 3: is the destination still reachable? If it vanished, fail this
       file fast and stop the batch — every remaining file would fail the same
       way, and we must not block on a dead path. */
    if (!(await isDestWritable(runDir))) { recordDestLost(v, i); break; }
    await ensureDir(dir);

    onProgress && onProgress({
      type: 'file-start',
      index: i + 1,
      total: totalFiles,
      file: v.file,
      basename: path.basename(v.file)
    });

    if (fs.existsSync(finalPath)) {
      alreadyDone++;
      done++;
      let existedSize = 0;
      try { existedSize = (await fsp.stat(finalPath)).size; } catch {}
      log(`SKIP-EXISTS  ${v.file} (already present in destination)`);
      onProgress && onProgress({
        type: 'file-done',
        index: i + 1,
        total: totalFiles,
        file: v.file,
        basename: path.basename(v.file),
        outBytes: existedSize,
        reclaimed,
        processed,
        failed,
        alreadyDone,
        elapsedMs: Date.now() - startTs,
        outcome: 'skip-exists'
      });
      continue;
    }

    /* BUG B: is the source still there/readable? If it was deleted/moved (fast
       ENOENT) or its volume vanished (would block on I/O), fail THIS file fast
       — before we probe or spawn ffmpeg, both of which would otherwise wedge —
       and continue the queue. */
    if (!(await isSourceReadable(v.file))) { recordSourceMissing(v, i); continue; }

    try { await fsp.unlink(tmpPath); } catch {}

    const probe = await ffprobeJson(v.file);
    const vs = pickVideoStream(probe?.streams);
    const as = pickAudioStream(probe?.streams);
    const durationSec = Number(probe?.format?.duration || 0) || v.duration || 0;

    const args = buildArgs({ input: v.file, tmpOut: tmpPath, tier, videoStream: vs, audioStream: as });

    let stderrBuf = '';
    const result = await runCmd(ffmpeg, args, {
      signal: null,
      onSpawn,
      stallTimeoutMs: STALL_TIMEOUT_MS,
      isPaused,
      isCancelled,
      onStderr: (chunk) => {
        stderrBuf += chunk;
        if (stderrBuf.length > 20000) stderrBuf = stderrBuf.slice(-10000);
        const t = parseFFmpegTime(chunk);
        if (t != null && durationSec > 0) {
          onProgress && onProgress({
            type: 'file-progress',
            index: i + 1,
            total: totalFiles,
            fileProgress: Math.max(0, Math.min(1, t / durationSec))
          });
        }
      }
    });

    /* BUG C — cancel wins over everything. runCmd resolves immediately when the
       cancel flag is set (it doesn't wait for a wedged child to close), so the
       moment we're back here on a cancel we clean up, emit 'cancelled', and
       break. No fallback, no _FAILED/ copy (which could itself wedge). */
    if (isCancelled()) {
      try { await fsp.unlink(tmpPath); } catch {}
      log(`CANCELLED ${v.file} (operator cancel — primary encoder terminated)`);
      onProgress && onProgress({
        type: 'file-done',
        index: i + 1,
        total: totalFiles,
        file: v.file,
        basename: path.basename(v.file),
        reclaimed,
        processed,
        failed,
        alreadyDone,
        elapsedMs: Date.now() - startTs,
        outcome: 'cancelled'
      });
      break;
    }

    /* BUG 3/B: the primary encode produced no output for the whole stall window
       — a wedged child, usually a vanished destination OR source. Clean up,
       then classify WITHOUT blocking (no fallback — a second encode would stall
       too; copy only if the source is still readable). */
    if (result.stalled) {
      try { await fsp.unlink(tmpPath); } catch {}
      log(`STALL ${v.file} (primary encoder produced no output for ${Math.round(STALL_TIMEOUT_MS / 1000)}s; terminated)`);
      if (!(await isDestWritable(runDir))) { recordDestLost(v, i); break; }
      if (!(await isSourceReadable(v.file))) { recordSourceMissing(v, i); continue; }
      await recordPlainFailure(v, i);   // stalled but src+dest fine — genuine stuck encode
      continue;
    }

    let success = result.code === 0 && fs.existsSync(tmpPath);
    let usedFallback = false;

    if (!success) {
      try { await fsp.unlink(tmpPath); } catch {}
      log(`PRIMARY-FAIL ${v.file} :: code=${result.code} :: ${stderrBuf.trim().split('\n').slice(-3).join(' | ')}`);

      /* Same cancel-honoring rule before kicking off the fallback. */
      if (isCancelled()) {
        log(`CANCELLED ${v.file} (no fallback — cancelled during primary)`);
        onProgress && onProgress({
          type: 'file-done',
          index: i + 1, total: totalFiles,
          reclaimed, processed, failed, alreadyDone,
          elapsedMs: Date.now() - startTs,
          outcome: 'cancelled'
        });
        break;
      }

      const fallbackArgs = buildFallbackArgs({ input: v.file, tmpOut: tmpPath, tier, videoStream: vs, audioStream: as });
      let stderrBuf2 = '';
      const r2 = await runCmd(ffmpeg, fallbackArgs, {
        onSpawn,
        stallTimeoutMs: STALL_TIMEOUT_MS,
        isPaused,
        isCancelled,
        onStderr: (chunk) => {
          stderrBuf2 += chunk;
          if (stderrBuf2.length > 20000) stderrBuf2 = stderrBuf2.slice(-10000);
          const t = parseFFmpegTime(chunk);
          if (t != null && durationSec > 0) {
            onProgress && onProgress({
              type: 'file-progress',
              index: i + 1,
              total: totalFiles,
              fileProgress: Math.max(0, Math.min(1, t / durationSec))
            });
          }
        }
      });

      /* Cancel wins (runCmd resolved immediately on the flag). */
      if (isCancelled()) {
        try { await fsp.unlink(tmpPath); } catch {}
        log(`CANCELLED ${v.file} (operator cancel — fallback encoder terminated)`);
        onProgress && onProgress({
          type: 'file-done',
          index: i + 1, total: totalFiles,
          file: v.file, basename: path.basename(v.file),
          reclaimed, processed, failed, alreadyDone,
          elapsedMs: Date.now() - startTs,
          outcome: 'cancelled'
        });
        break;
      }
      /* BUG 3/B: fallback stalled too — vanished dest OR source. */
      if (r2.stalled) {
        try { await fsp.unlink(tmpPath); } catch {}
        log(`STALL ${v.file} (fallback encoder produced no output for ${Math.round(STALL_TIMEOUT_MS / 1000)}s; terminated)`);
        if (!(await isDestWritable(runDir))) { recordDestLost(v, i); break; }
        if (!(await isSourceReadable(v.file))) { recordSourceMissing(v, i); continue; }
        await recordPlainFailure(v, i);
        continue;
      }
      success = r2.code === 0 && fs.existsSync(tmpPath);
      usedFallback = success;
      if (!success) {
        try { await fsp.unlink(tmpPath); } catch {}
        log(`FALLBACK-FAIL ${v.file} :: code=${r2.code} :: ${stderrBuf2.trim().split('\n').slice(-3).join(' | ')}`);
      }
    }

    if (success) {
      await fsp.rename(tmpPath, finalPath);
      await setMtimeFromSource(v.file, finalPath);
      const outStat = await fsp.stat(finalPath);
      const saved = v.size - outStat.size;
      reclaimed += saved;
      processed++;
      done++;
      log(`OK${usedFallback ? '-FALLBACK' : ''} ${v.file} -> ${finalPath} :: in=${humanBytes(v.size)} out=${humanBytes(outStat.size)} saved=${humanBytes(saved)}`);
      onProgress && onProgress({
        type: 'file-done',
        index: i + 1,
        total: totalFiles,
        file: v.file,
        basename: path.basename(v.file),
        // BUG A: the real encoded output size — the renderer assigns it directly
        // to this file's row instead of reverse-engineering it from a delta.
        outBytes: outStat.size,
        inBytes: v.size,
        reclaimed,
        processed,
        failed,
        alreadyDone,
        elapsedMs: Date.now() - startTs,
        outcome: usedFallback ? 'ok-fallback' : 'ok'
      });
    } else {
      /* Preserve the original next to the run for forensics. Correct for a
         file that is PRESENT but corrupt/undecodable. If the source itself
         is gone (moved/deleted/unreadable mid-run) the copy throws and NO
         _FAILED/ copy exists — recordPlainFailure classifies which, so the
         log and the UI never promise a copy that isn't there. */
      await recordPlainFailure(v, i);
    }
  }

  log(`# Run finished ${new Date().toISOString()}`);
  log(`# Totals: processed=${processed} failed=${failed} (copied-to-_FAILED=${failedCopied}, source-unreadable=${failedNoCopy}, dest-lost=${failedDestLost}) already-done=${alreadyDone} ignored-non-video=${scan.ignored} reclaimed=${humanBytes(reclaimed)}`);
  if (destLost) log(`# Destination became unavailable during the run — remaining files were not attempted. Originals untouched.`);
  logStream.end();

  return {
    runDir,
    logPath,
    processed,
    failed,
    failedCopied,
    failedNoCopy,
    failedDestLost,
    destLost,
    alreadyDone,
    skippedNonVideo: scan.ignored,
    reclaimed,
    totalFiles
  };
}

async function dryRunBatch(batch, onProgress) {
  const { src, tier } = batch;
  const scan = await scanFolder(src);
  let estReclaim = 0;
  const ratios = { regular: 0.45, preserve: 0.55 };
  const r = ratios[tier] ?? 0.45;
  for (const v of scan.videos) {
    estReclaim += Math.max(0, v.size - v.size * r);
  }
  const codecs = {};
  for (const v of scan.videos) { codecs[v.codec] = (codecs[v.codec] || 0) + 1; }
  onProgress && onProgress({ type: 'dry-summary', videos: scan.videos.length, ignored: scan.ignored, estReclaim, codecs });
  return {
    runDir: null,
    logPath: null,
    processed: 0,
    failed: 0,
    failedCopied: 0,
    failedNoCopy: 0,
    failedDestLost: 0,
    destLost: false,
    alreadyDone: 0,
    skippedNonVideo: scan.ignored,
    reclaimed: 0,
    totalFiles: scan.videos.length,
    dry: true,
    estReclaim,
    codecs
  };
}

module.exports = {
  getBinaries,
  scanFolder,
  runBatch,
  dryRunBatch,
  isVideoFile,
  humanBytes,
  copyToFailed,
  runCmd,
  isDestWritable,
  isSourceReadable,
  VIDEO_EXTS,
  TIER_CONSTANTS
};
