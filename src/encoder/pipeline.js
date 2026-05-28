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
  regular:    { qv: 62 },
  preserve:   { crf: 20, preset: 'medium' },
  aggressive: { qv: 42 }
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

function runCmd(cmd, args, { onStderr, onStdout, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      const s = d.toString();
      stdout += s;
      if (onStdout) onStdout(s);
    });
    child.stderr.on('data', (d) => {
      const s = d.toString();
      stderr += s;
      if (onStderr) onStderr(s);
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr, child }));
    if (signal) {
      signal.attach(() => { try { child.kill('SIGTERM'); } catch {} });
    }
  });
}

async function ffprobeJson(file) {
  const { ffprobe } = getBinaries();
  const args = ['-v', 'quiet', '-print_format', 'json', '-show_streams', '-show_format', file];
  const { code, stdout } = await runCmd(ffprobe, args);
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
  } else if (tier === 'aggressive') {
    args.push('-c:v', 'hevc_videotoolbox', '-q:v', String(TIER_CONSTANTS.aggressive.qv), '-tag:v', 'hvc1');
    if (tenBit) args.push('-profile:v', 'main10', '-pix_fmt', 'p010le');
    const se = shortEdge(videoStream?.width, videoStream?.height);
    if (se && se > 1080) {
      args.push('-vf', "scale='if(gt(iw,ih),-2,1080)':'if(gt(iw,ih),1080,-2)':force_original_aspect_ratio=decrease");
    }
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

  if (tier === 'aggressive') {
    const se = shortEdge(videoStream?.width, videoStream?.height);
    if (se && se > 1080) {
      args.push('-vf', "scale='if(gt(iw,ih),-2,1080)':'if(gt(iw,ih),1080,-2)':force_original_aspect_ratio=decrease");
    }
  }

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

async function runBatch(batch, shouldStopFn, onProgress) {
  const { src, dest, tier } = batch;
  const runDir = path.join(dest, tsRunFolder());
  await ensureDir(runDir);

  const logPath = path.join(runDir, 'compress.log');
  const logStream = fs.createWriteStream(logPath, { flags: 'a' });
  const log = (line) => logStream.write(line + '\n');
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
  let alreadyDone = 0;
  let reclaimed = 0;
  const startTs = Date.now();

  const { ffmpeg } = getBinaries();

  for (let i = 0; i < scan.videos.length; i++) {
    if (shouldStopFn && shouldStopFn()) {
      log(`# Stopped by user after ${done} of ${totalFiles}`);
      break;
    }
    const v = scan.videos[i];
    const { finalPath, tmpPath, dir } = destForInput(runDir, scan.rootKind, scan.root, v.file);
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
      log(`SKIP-EXISTS  ${v.file} (already present in destination)`);
      onProgress && onProgress({
        type: 'file-done',
        index: i + 1,
        total: totalFiles,
        reclaimed,
        processed,
        failed,
        alreadyDone,
        elapsedMs: Date.now() - startTs,
        outcome: 'skip-exists'
      });
      continue;
    }

    try { await fsp.unlink(tmpPath); } catch {}

    const probe = await ffprobeJson(v.file);
    const vs = pickVideoStream(probe?.streams);
    const as = pickAudioStream(probe?.streams);
    const durationSec = Number(probe?.format?.duration || 0) || v.duration || 0;

    const args = buildArgs({ input: v.file, tmpOut: tmpPath, tier, videoStream: vs, audioStream: as });

    const stop = new StopSignal(shouldStopFn);
    let stderrBuf = '';
    const result = await runCmd(ffmpeg, args, {
      signal: null,
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

    let success = result.code === 0 && fs.existsSync(tmpPath);
    let usedFallback = false;

    if (!success) {
      try { await fsp.unlink(tmpPath); } catch {}
      log(`PRIMARY-FAIL ${v.file} :: code=${result.code} :: ${stderrBuf.trim().split('\n').slice(-3).join(' | ')}`);

      const fallbackArgs = buildFallbackArgs({ input: v.file, tmpOut: tmpPath, tier, videoStream: vs, audioStream: as });
      let stderrBuf2 = '';
      const r2 = await runCmd(ffmpeg, fallbackArgs, {
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
        reclaimed,
        processed,
        failed,
        alreadyDone,
        elapsedMs: Date.now() - startTs,
        outcome: usedFallback ? 'ok-fallback' : 'ok'
      });
    } else {
      failed++;
      done++;
      try { await copyToFailed(runDir, scan.rootKind, scan.root, v.file); } catch (e) {
        log(`FAILED-COPY-ERROR ${v.file} :: ${e.message}`);
      }
      log(`FAIL ${v.file} (copied to _FAILED)`);
      onProgress && onProgress({
        type: 'file-done',
        index: i + 1,
        total: totalFiles,
        reclaimed,
        processed,
        failed,
        alreadyDone,
        elapsedMs: Date.now() - startTs,
        outcome: 'fail'
      });
    }
  }

  log(`# Run finished ${new Date().toISOString()}`);
  log(`# Totals: processed=${processed} failed=${failed} already-done=${alreadyDone} ignored-non-video=${scan.ignored} reclaimed=${humanBytes(reclaimed)}`);
  logStream.end();

  return {
    runDir,
    logPath,
    processed,
    failed,
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
  const ratios = { regular: 0.45, preserve: 0.55, aggressive: 0.15 };
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
  VIDEO_EXTS,
  TIER_CONSTANTS
};
