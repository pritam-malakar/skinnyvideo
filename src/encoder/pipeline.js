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

/* ─── ffmpeg/ffprobe resolution — ONE path, no fallback ──────────────────
   The encoder is fully self-contained: Squeeze only EVER runs the ffmpeg it
   ships in its own bundle. There is deliberately NO PATH lookup, no system
   ffmpeg, no ffmpeg-static, no env override, no hardcoded /usr or /opt path —
   any of those would let a different (possibly broken/missing) binary run, and
   "resolves a binary some other way per machine" was the whole failure class
   this guards against. resolveBinDir has exactly two branches and both point
   inside the app:
     • packaged → <Squeeze.app>/Contents/Resources/bin
     • dev      → <repo>/resources/bin
   Both are absolute and 'bin'-suffixed; neither can yield a bare name or a
   system path. Pure (no electron/process refs) so it is unit-testable. */
function resolveBinDir(isPackaged, resourcesPath, dirname) {
  return isPackaged
    ? path.join(resourcesPath, 'bin')
    : path.join(dirname, '..', '..', 'resources', 'bin');
}

function getBinaries() {
  const isPackaged = !!(_electronApp && _electronApp.isPackaged);
  const base = resolveBinDir(isPackaged, process.resourcesPath, __dirname);
  return {
    ffmpeg: path.join(base, 'ffmpeg'),
    ffprobe: path.join(base, 'ffprobe')
  };
}

/* Plain-language wording for a non-technical operator when the bundled engine
   is absent. Shown at startup and as the run-block reason — never a stack
   trace, never an ffmpeg path. */
const ENGINE_MISSING_MESSAGE = "Squeeze's video engine is missing — please reinstall the app.";

/* Hard gate: the bundled ffmpeg AND ffprobe must exist and be executable.
   Returns {ok:true, ffmpeg, ffprobe} or {ok:false, missing, reason, …}. NEVER
   falls back to another binary — a false result means the run must be blocked,
   not retried elsewhere. Synchronous fs.accessSync(X_OK) is the ground-truth
   executable check (existsSync alone would pass a non-executable file). */
function ffmpegStatus(bins) {
  const b = bins || getBinaries();
  for (const key of ['ffmpeg', 'ffprobe']) {
    try {
      fs.accessSync(b[key], fs.constants.X_OK);
    } catch {
      return { ok: false, ffmpeg: b.ffmpeg, ffprobe: b.ffprobe, missing: key,
        reason: `${key} missing or not executable at ${b[key]}`,
        message: ENGINE_MISSING_MESSAGE };
    }
  }
  return { ok: true, ffmpeg: b.ffmpeg, ffprobe: b.ffprobe };
}

/* Provenance for the run-log header: the first line of `ffmpeg -version`
   (e.g. "ffmpeg version 8.1 …"). Bounded so a wedged binary can't hang the
   header. Returns 'unknown' on any failure rather than throwing. */
async function ffmpegVersionLine(ffmpegPath) {
  try {
    const r = await runCmd(ffmpegPath, ['-hide_banner', '-version'], { stallTimeoutMs: 5000 });
    return ((r && r.stdout) || '').split('\n')[0].trim() || 'unknown';
  } catch { return 'unknown'; }
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
    /* NOTE: there is deliberately NO mid-encode "source readability" poll. A
       STARTED encode holds the input open, so moving/deleting the original
       does not break it (the file's data survives via the open fd, just like
       the file-list hardlink). We let it finish. A source whose whole VOLUME
       ejects mid-encode blocks the encoder → the inactivity watchdog below
       catches that. A NOT-yet-started file whose source is gone is caught by
       the pre-encode isSourceReadable() check in runBatch (folder mode). */
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
    if (e.isDirectory()) { await walkAll(full, out); continue; }
    if (e.isFile()) { out.push(full); continue; }
    /* A staged file-list entry can be a SYMLINK to the original source — that is
       how staging stays zero-copy when the source FS can't hardlink (e.g. an SMB
       share; see stage.js). A symlink dirent reports isFile()===false, so resolve
       it with stat() (follows the link) and treat the target as a file/dir. A
       dangling link (original vanished after staging) is skipped here and handled
       as source-missing downstream by the pre-encode readable guard. */
    if (e.isSymbolicLink()) {
      try {
        const st = await fsp.stat(full);
        if (st.isDirectory()) await walkAll(full, out);
        else if (st.isFile()) out.push(full);
      } catch { /* dangling symlink — skip; downstream guard reports it */ }
    }
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
    /* BUG 1 (v2.1.15): source size is the REAL byte count from fsp.stat() of
       the actual file — NOT ffprobe's format.size (container-reported, can
       differ from disk). Every downstream number (row size, batch/run totals,
       reclaimed, lifetime) derives from this, so it must match disk exactly. */
    let realSize;
    try { realSize = (await fsp.stat(f)).size; }
    catch { realSize = Number(probe.format?.size || 0); }
    videos.push({
      file: f,
      size: realSize,
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
  // Base 1000 (decimal MB/GB) so displayed sizes match macOS Finder + disk.
  while (n >= 1000 && i < units.length - 1) { n /= 1000; i++; }
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

/* ─── Color-tag vocabulary bridge ──────────────────────────────────
   ffprobe reports color values using av_color_*_name() DISPLAY names; the
   encoder's -color_primaries/-color_trc/-colorspace/-color_range options
   accept a DIFFERENT (overlapping) constant vocabulary. Passing a display
   name the option table doesn't know — e.g. probe "bt470m" where the option
   spells it "gamma22" — makes avcodec_open2 reject the options with EINVAL
   ("Error applying encoder options: Invalid argument", exit 234) and kills
   the encode on BOTH encoders. So every probe value is mapped where the two
   vocabularies are known to diverge, then validated against the constants
   the BUNDLED binary actually accepts (dumped from resources/bin/ffmpeg
   -h full — not a generic reference). A value that survives neither is
   DROPPED: a missing cosmetic color tag is invisible; a rejected one is a
   dead job. */
const COLOR_OPT_ACCEPTED = {
  color_primaries: new Set(['bt2020', 'bt470bg', 'bt470m', 'bt709', 'ebu3213',
    'film', 'jedec-p22', 'smpte170m', 'smpte240m', 'smpte428', 'smpte428_1',
    'smpte431', 'smpte432']),
  color_trc: new Set(['arib-std-b67', 'bt1361', 'bt1361e', 'bt2020-10',
    'bt2020-12', 'bt2020_10bit', 'bt2020_12bit', 'bt709', 'gamma22', 'gamma28',
    'iec61966-2-1', 'iec61966-2-4', 'iec61966_2_1', 'iec61966_2_4', 'linear',
    'log', 'log100', 'log316', 'log_sqrt', 'smpte170m', 'smpte2084',
    'smpte240m', 'smpte428', 'smpte428_1']),
  colorspace: new Set(['bt2020_cl', 'bt2020_ncl', 'bt2020c', 'bt2020nc',
    'bt470bg', 'bt709', 'chroma-derived-c', 'chroma-derived-nc', 'fcc',
    'ictcp', 'ipt-c2', 'rgb', 'smpte170m', 'smpte2085', 'smpte240m', 'ycgco',
    'ycgco-re', 'ycgco-ro', 'ycocg']),
  color_range: new Set(['full', 'jpeg', 'limited', 'mpeg', 'pc', 'tv'])
};
/* Probe display name → option constant, where the tables diverge. */
const COLOR_NAME_TO_OPT = {
  color_trc: { bt470m: 'gamma22', bt470bg: 'gamma28' },
  colorspace: { gbr: 'rgb' }
};
function encoderColorValue(opt, probeName) {
  if (!probeName || probeName === 'unknown') return null;
  const mapped = (COLOR_NAME_TO_OPT[opt] && COLOR_NAME_TO_OPT[opt][probeName]) || probeName;
  return COLOR_OPT_ACCEPTED[opt].has(mapped) ? mapped : null;
}

/* ─── Color carry (v2.2.6): faithful pass-through of DECLARED color ──
   ffmpeg 8 encoders take output color from decoded FRAME metadata; sources
   that declare color only in the CONTAINER (e.g. a QuickTime colr atom
   tagging gamma 2.2, standard on graded NLE exports) reach the encoder with
   untagged frames and come out color_transfer=unknown — a silent gamma shift
   in strict players. Bridge: stamp the container-declared value onto the
   frames with the metadata-only `setparams` filter (zero pixel transform; it
   uses the same display-name vocabulary ffprobe reports, so no translation).
   MINIMAL INTERVENTION, load-bearing: stamp ONLY fields where the frames are
   unknown AND the stream declares a value — frames already tagged are NEVER
   overwritten, and a fully-tagged source gets NO -vf at all (args identical
   to before). Untagged-everywhere stays untagged: we never invent color.
   Values are validated against the bundled binary's setparams table
   (ffmpeg -h filter=setparams) so a weird probe name can't crash the filter
   graph the way bt470m crashed the encoder options. */
const SETPARAMS_ACCEPTED = {
  color_primaries: new Set(['bt709', 'bt470m', 'bt470bg', 'smpte170m',
    'smpte240m', 'film', 'bt2020', 'smpte428', 'smpte431', 'smpte432',
    'jedec-p22', 'ebu3213', 'vgamut']),
  color_trc: new Set(['bt709', 'bt470m', 'bt470bg', 'smpte170m', 'smpte240m',
    'linear', 'log100', 'log316', 'iec61966-2-4', 'bt1361e', 'iec61966-2-1',
    'bt2020-10', 'bt2020-12', 'smpte2084', 'smpte428', 'arib-std-b67', 'vlog']),
  colorspace: new Set(['gbr', 'bt709', 'fcc', 'bt470bg', 'smpte170m',
    'smpte240m', 'ycgco', 'ycgco-re', 'ycgco-ro', 'bt2020nc', 'bt2020c',
    'smpte2085', 'chroma-derived-nc', 'chroma-derived-c', 'ictcp', 'ipt-c2']),
  range: new Set(['limited', 'tv', 'mpeg', 'full', 'pc', 'jpeg'])
};
const knownColor = (v) => !!v && v !== 'unknown' && v !== 'unspecified' && v !== 'reserved';

/* First-frame color metadata + side data = what the encoder will actually
   see (the bitstream truth), vs the stream-level declaration ffprobeJson
   already returns (which folds in container atoms). */
async function ffprobeFrameColor(file) {
  const { ffprobe } = getBinaries();
  const args = ['-v', 'error', '-select_streams', 'v:0', '-read_intervals', '%+#1',
    '-show_entries', 'frame=color_primaries,color_transfer,color_space,color_range:frame_side_data=side_data_type',
    '-print_format', 'json', file];
  const { code, stdout } = await runCmd(ffprobe, args, { stallTimeoutMs: PROBE_TIMEOUT_MS });
  if (code !== 0) return null;
  try { return (JSON.parse(stdout).frames || [])[0] || null; } catch { return null; }
}

/* Per-field: frame value wins where present (never overwrite bitstream-
   declared color); stream-declared value fills the gap. Returns null when
   nothing needs stamping — the no-op path MUST stay byte-identical. */
function resolveColorStamp(frameColor, videoStream) {
  const fields = [
    ['color_primaries', 'color_primaries', 'color_primaries'],
    ['color_trc', 'color_transfer', 'color_transfer'],
    ['colorspace', 'color_space', 'color_space'],
    ['range', 'color_range', 'color_range']
  ]; // [setparams key, frame key, stream key]
  const stamp = {};
  for (const [sp, fk, sk] of fields) {
    const f = frameColor ? frameColor[fk] : null;
    const s = videoStream ? videoStream[sk] : null;
    if (!knownColor(f) && knownColor(s) && SETPARAMS_ACCEPTED[sp].has(s)) stamp[sp] = s;
  }
  return Object.keys(stamp).length ? stamp : null;
}

function setparamsArg(stamp) {
  return 'setparams=' + Object.keys(stamp).map((k) => `${k}=${stamp[k]}`).join(':');
}

/* HDR metadata a re-encode does NOT carry (mastering display, content light,
   Dolby Vision). Transfer/primaries TAGS carry fine; this is the brightness/
   volume metadata layered on top. Detection only — preservation is a
   deferred, separate task — but the operator must SEE the drop, so runBatch
   logs it, the file-done event carries it, and the UI surfaces it. */
function detectDroppedHdrMeta(probeStreams, frameColor) {
  const labels = new Set();
  const scan = (sdl) => {
    for (const sd of sdl || []) {
      const t = String(sd.side_data_type || '');
      if (/Mastering display/i.test(t)) labels.add('mastering display');
      if (/Content light/i.test(t)) labels.add('content light level');
      if (/DOVI|Dolby Vision/i.test(t)) labels.add('Dolby Vision');
    }
  };
  for (const st of probeStreams || []) {
    if (st.codec_type === 'video') scan(st.side_data_list);
  }
  scan(frameColor ? frameColor.side_data_list : null);
  return [...labels];
}
function buildColorArgs(videoStream, { withRange }) {
  const colorArgs = [];
  const prim = encoderColorValue('color_primaries', videoStream?.color_primaries);
  if (prim) colorArgs.push('-color_primaries', prim);
  const trc = encoderColorValue('color_trc', videoStream?.color_transfer);
  if (trc) colorArgs.push('-color_trc', trc);
  const csp = encoderColorValue('colorspace', videoStream?.color_space);
  if (csp) colorArgs.push('-colorspace', csp);
  if (withRange) {
    const range = encoderColorValue('color_range', videoStream?.color_range);
    if (range) colorArgs.push('-color_range', range);
  }
  return colorArgs;
}

function buildArgs({ input, tmpOut, tier, videoStream, audioStream, dropColorTags, colorStamp }) {
  const args = ['-y', '-nostdin', '-hide_banner', '-loglevel', 'error', '-stats', '-i', input];
  const tenBit = is10Bit(videoStream?.pix_fmt);

  /* Color carry: stamp container-declared color onto untagged frames.
     colorStamp is null for fully-tagged (and fully-untagged) sources — in
     which case NO -vf is injected and the args are identical to before. */
  if (colorStamp && !dropColorTags) args.push('-vf', setparamsArg(colorStamp));

  const colorArgs = dropColorTags ? [] : buildColorArgs(videoStream, { withRange: true });

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

function buildFallbackArgs({ input, tmpOut, tier, videoStream, audioStream, dropColorTags, colorStamp }) {
  const args = ['-y', '-nostdin', '-hide_banner', '-loglevel', 'error', '-stats', '-i', input];
  const tenBit = is10Bit(videoStream?.pix_fmt);
  if (colorStamp && !dropColorTags) args.push('-vf', setparamsArg(colorStamp));
  args.push('-c:v', 'libx265', '-crf', '22', '-preset', 'medium', '-tag:v', 'hvc1');
  if (tenBit) args.push('-pix_fmt', 'yuv420p10le');

  args.push(...(dropColorTags ? [] : buildColorArgs(videoStream, { withRange: false })));

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

  /* NO SILENT FALLBACK: verify the bundled engine before doing anything. If the
     bundled ffmpeg/ffprobe is missing or not executable we FAIL the batch with
     the plain-language reason and NEVER spawn — there is no other binary to try.
     (main also pre-flights this before the run even starts; this is the
     last-resort guarantee that a spawn can't happen with no engine.) */
  const bins = getBinaries();
  const engine = ffmpegStatus(bins);
  if (!engine.ok) {
    return {
      runDir: null, logPath: null,
      processed: 0, failed: 0, failedCopied: 0, failedNoCopy: 0, failedDestLost: 0,
      alreadyDone: 0, skippedNonVideo: 0, reclaimed: 0, totalFiles: 0,
      destLost: false, engineMissing: true, error: engine.message, reason: engine.reason
    };
  }

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
  /* Provenance — which engine actually ran. The absolute bundled path proves no
     PATH/system ffmpeg slipped in; the version line lets a per-machine failure
     be diagnosed from the log alone (mini vs Studio). */
  log(`# ffmpeg: ${bins.ffmpeg}`);
  log(`# ffmpeg version: ${await ffmpegVersionLine(bins.ffmpeg)}`);

  const scan = await scanFolder(src);
  /* BUG 2 (v2.1.15): drop user-skipped sources AT RUN TIME. batch.skip carries
     the live set of skipped ORIGINAL paths (set by main at this batch's turn).
     For a folder batch scan.videos[].file IS the original path, so this is the
     authoritative exclusion. For a staged file-list batch the skipped sources
     were already removed from fileSources before staging → harmless no-op. */
  if (Array.isArray(batch.skip) && batch.skip.length) {
    const sk = new Set(batch.skip);
    const before = scan.videos.length;
    scan.videos = scan.videos.filter((v) => !sk.has(v.file));
    if (scan.videos.length !== before) log(`# Skipped ${before - scan.videos.length} file(s) by user request`);
  }
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
  let hdrMetaDropped = 0;   // files whose HDR side data (mastering/CLL/DV) can't survive re-encode
  const startTs = Date.now();

  const ffmpeg = bins.ffmpeg;   // resolved + verified above (single bundled engine)

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

    /* Pre-encode source check (NOT-YET-STARTED files only). This file hasn't
       opened yet, so if its source is already gone/unreadable we fail it fast
       — before probing or spawning ffmpeg, which would otherwise error slowly
       (deleted) or block (vanished volume). Scope, stated honestly:
         • FOLDER batches — v.file is the ORIGINAL path, so this catches a file
           deleted/moved or a volume ejected after the run's scan but before
           this file's turn.
         • FILE-LIST batches — v.file is the staged TEMP hardlink/copy, which is
           insulated from the original moving, so this is effectively a no-op
           there (the whole batch was staged up front).
       Files that are ALREADY encoding are intentionally NOT re-checked — a
       started encode holds its input open and finishes regardless (see runCmd:
       no source poll); a vanished volume mid-encode is caught by the stall
       watchdog. */
    if (!(await isSourceReadable(v.file))) { recordSourceMissing(v, i); continue; }

    try { await fsp.unlink(tmpPath); } catch {}

    const probe = await ffprobeJson(v.file);
    const vs = pickVideoStream(probe?.streams);
    const as = pickAudioStream(probe?.streams);
    const durationSec = Number(probe?.format?.duration || 0) || v.duration || 0;

    /* Color carry: compare bitstream truth (first frame) against the
       stream-level declaration; stamp only the gap. HDR side data that a
       re-encode can't carry is detected here so the drop is VISIBLE. */
    const frameColor = await ffprobeFrameColor(v.file);
    const colorStamp = resolveColorStamp(frameColor, vs);
    if (colorStamp) {
      log(`COLOR-STAMP ${v.file} :: ${setparamsArg(colorStamp).slice('setparams='.length)} (declared by source but missing on frames — carried onto output)`);
    }
    const hdrMeta = detectDroppedHdrMeta(probe?.streams, frameColor);
    if (hdrMeta.length) {
      hdrMetaDropped++;
      log(`HDR-METADATA ${v.file} :: ${hdrMeta.join(', ')} — re-encoding does not carry this metadata (color tags are preserved; HDR brightness metadata is dropped)`);
    }

    const args = buildArgs({ input: v.file, tmpOut: tmpPath, tier, videoStream: vs, audioStream: as, colorStamp });

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
    let usedColorStrip = false;

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

      /* If the primary failed BECAUSE the source vanished, don't start a
         fallback that would re-block on the same missing input. */
      if (!(await isSourceReadable(v.file))) {
        try { await fsp.unlink(tmpPath); } catch {}
        recordSourceMissing(v, i);
        continue;
      }

      /* BACKSTOP for the color-tag vocabulary gap: "Error applying encoder
         options" + EINVAL means the option VOCABULARY was rejected (in
         practice a color tag the whitelist above didn't anticipate), not a
         media problem — so retry this file ONCE on the SAME encoder with all
         color tags stripped before falling back. A cosmetic tag is never
         worth a dead job. */
      const optRejected = /Error applying encoder options|Error applying option .* to filter 'setparams'/.test(stderrBuf);
      if (optRejected) {
        const bareArgs = buildArgs({ input: v.file, tmpOut: tmpPath, tier, videoStream: vs, audioStream: as, dropColorTags: true });
        let stderrBuf3 = '';
        const r3 = await runCmd(ffmpeg, bareArgs, {
          onSpawn,
          stallTimeoutMs: STALL_TIMEOUT_MS,
          isPaused,
          isCancelled,
          onStderr: (chunk) => {
            stderrBuf3 += chunk;
            if (stderrBuf3.length > 20000) stderrBuf3 = stderrBuf3.slice(-10000);
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
        if (isCancelled()) {
          try { await fsp.unlink(tmpPath); } catch {}
          log(`CANCELLED ${v.file} (operator cancel — no-color retry terminated)`);
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
        if (r3.stalled) {
          try { await fsp.unlink(tmpPath); } catch {}
          log(`STALL ${v.file} (no-color retry produced no output for ${Math.round(STALL_TIMEOUT_MS / 1000)}s; terminated)`);
          if (!(await isDestWritable(runDir))) { recordDestLost(v, i); break; }
          if (!(await isSourceReadable(v.file))) { recordSourceMissing(v, i); continue; }
          await recordPlainFailure(v, i);
          continue;
        }
        success = r3.code === 0 && fs.existsSync(tmpPath);
        if (success) {
          usedColorStrip = true;
          log(`RETRY-OK ${v.file} (encoder rejected a color tag; re-encoded without color tags)`);
        } else {
          try { await fsp.unlink(tmpPath); } catch {}
          log(`RETRY-FAIL ${v.file} :: code=${r3.code} :: ${stderrBuf3.trim().split('\n').slice(-3).join(' | ')}`);
        }
      }

      if (!success) {
      /* The fallback inherits dropColorTags when the primary's options were
         rejected — its color args share the same vocabulary, so re-sending
         them would fail identically. */
      const fallbackArgs = buildFallbackArgs({ input: v.file, tmpOut: tmpPath, tier, videoStream: vs, audioStream: as, dropColorTags: optRejected, colorStamp });
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
    }

    if (success) {
      await fsp.rename(tmpPath, finalPath);
      await setMtimeFromSource(v.file, finalPath);
      const outStat = await fsp.stat(finalPath);
      const saved = v.size - outStat.size;
      reclaimed += saved;
      processed++;
      done++;
      log(`OK${usedFallback ? '-FALLBACK' : usedColorStrip ? '-NOCOLOR' : ''} ${v.file} -> ${finalPath} :: in=${humanBytes(v.size)} out=${humanBytes(outStat.size)} saved=${humanBytes(saved)}`);
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
        outcome: usedFallback ? 'ok-fallback' : 'ok',
        // HDR side data the re-encode could not carry — surfaced on the row.
        hdrMeta: hdrMeta.length ? hdrMeta : undefined
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
  if (hdrMetaDropped > 0) log(`# HDR: ${hdrMetaDropped} file(s) carried HDR metadata (mastering display / content light / Dolby Vision) that re-encoding drops — color tags preserved, HDR brightness metadata not carried`);
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
    totalFiles,
    hdrMetaDropped
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
  resolveBinDir,
  ffmpegStatus,
  ffmpegVersionLine,
  ENGINE_MISSING_MESSAGE,
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
  TIER_CONSTANTS,
  buildArgs,
  buildFallbackArgs,
  buildColorArgs,
  encoderColorValue,
  COLOR_OPT_ACCEPTED,
  COLOR_NAME_TO_OPT,
  ffprobeFrameColor,
  resolveColorStamp,
  setparamsArg,
  detectDroppedHdrMeta,
  SETPARAMS_ACCEPTED
};
