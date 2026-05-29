const dropzone = document.getElementById('dropzone');
const dropStatus = document.getElementById('drop-status');
const dropStatusPath = document.getElementById('drop-status-path');
const dropStatusCount = document.getElementById('drop-status-count');
const dropStatusExtra = document.getElementById('drop-status-extra');
const destPathEl = document.getElementById('dest-path');
const chooseDestBtn = document.getElementById('choose-dest');
const tierInputs = document.querySelectorAll('input[name="tier"]');
const dryRunBtn = document.getElementById('dry-run');
const dryRunHint = document.getElementById('dry-run-hint');
const addBtn = document.getElementById('add-to-queue');
const queueEl = document.getElementById('queue');
const queueCountEl = document.getElementById('queue-count');
const queueHeadingEl = document.getElementById('queue-heading');
const qfootSource = document.getElementById('qfoot-source');
const qfootReclaimed = document.getElementById('qfoot-reclaimed');
const qfootFailed = document.getElementById('qfoot-failed');
const tierHintEl = document.getElementById('tier-hint');
const tlTag = document.getElementById('tl-tag');
const startBtn = document.getElementById('start');
const stopBtn = document.getElementById('stop');
const progressCard = document.getElementById('progress-card');
const progressFill = document.getElementById('progress-fill');
const progressBatch = document.getElementById('progress-batch');
const progressCounts = document.getElementById('progress-counts');
const currentFileEl = document.getElementById('current-file');
const currentEtaEl = document.getElementById('current-eta');
const reclaimedEl = document.getElementById('reclaimed');
const statCompleted = document.getElementById('stat-completed');
const statIgnored = document.getElementById('stat-ignored');
const statFailed = document.getElementById('stat-failed');
const summaryCard = document.getElementById('summary-card');
const summaryBody = document.getElementById('summary-body');
const showLogBtn = document.getElementById('show-log');
const revealOutputBtn = document.getElementById('reveal-output');
const dismissSummaryBtn = document.getElementById('dismiss-summary');
const topProgress = document.getElementById('top-progress');

const DEST_PLACEHOLDER = 'Choose a folder — a run subfolder is created automatically';
// Maps pipeline tier id → reference CSS class + display label
const TIER_CSS = { regular: 'regular', preserve: 'archival', aggressive: 'lossy' };
const TIER_LABEL = { regular: 'Regular', preserve: 'Archival', aggressive: 'Compress AF' };

let current = {
  src: null,
  srcName: null,
  videoCount: 0,
  ignoredCount: 0,
  totalSize: 0,
  scanned: false,
  dest: null
};
let queue = [];
let nextId = 1;
let lastRun = null;
let currentBatchId = null;
let perFileTimes = [];
let lastFileStartTs = 0;

function humanBytes(n) {
  if (!Number.isFinite(n)) return '0 B';
  const sign = n < 0 ? '-' : '';
  n = Math.abs(n);
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return sign + n.toFixed(n >= 10 || i === 0 ? 0 : 1) + ' ' + units[i];
}

function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${ss}s`;
  return `${ss}s`;
}

function setDropStatus(text, kind = 'cyan') {
  dropStatusPath.textContent = text;
  dropStatus.classList.remove('hidden');
  dropStatusPath.style.color = ({
    cyan: 'var(--cyan)',
    green: 'var(--green)',
    amber: 'var(--amber)',
    red: 'var(--red)',
    muted: 'var(--fg-3)'
  })[kind] || 'var(--cyan)';
}

function clearDropStatus() {
  dropStatus.classList.add('hidden');
  dropStatusPath.textContent = '';
  dropStatusCount.textContent = '0 files';
  dropStatusExtra.textContent = '';
}

function updateAddState() {
  const ready = current.src && current.dest && current.scanned && current.videoCount > 0;
  addBtn.disabled = !ready;
  chooseDestBtn.disabled = !current.src;
}

function updateTierHint() {
  if (current.scanned && current.videoCount > 0) {
    tierHintEl.textContent = `Applies to ${current.videoCount} file${current.videoCount === 1 ? '' : 's'} in this batch`;
  } else {
    tierHintEl.textContent = 'Applies to all files in this batch';
  }
}

function clearDrop() {
  current = { src: null, srcName: null, videoCount: 0, ignoredCount: 0, totalSize: 0, scanned: false, dest: null };
  destPathEl.textContent = DEST_PLACEHOLDER;
  destPathEl.classList.add('placeholder');
  clearDropStatus();
  updateAddState();
  updateTierHint();
}

['dragenter', 'dragover'].forEach((e) => {
  dropzone.addEventListener(e, (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    dropzone.classList.add('dragover');
  });
});
['dragleave', 'drop'].forEach((e) => {
  dropzone.addEventListener(e, (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    dropzone.classList.remove('dragover');
  });
});

dropzone.addEventListener('drop', async (ev) => {
  const files = Array.from(ev.dataTransfer.files || []);
  if (!files.length) return;
  const f = files[0];
  let p = window.api.pathForFile(f);
  if (!p) {
    dropStatusPath.textContent = 'Could not read dropped path. Try again.';
    dropStatusPath.style.color = 'var(--red)';
    dropStatus.classList.remove('hidden');
    return;
  }
  current.src = p;
  current.srcName = p.split('/').pop();
  current.scanned = false;
  dropStatus.classList.remove('hidden');
  dropStatusPath.textContent = p;
  dropStatusPath.style.color = 'var(--cyan)';
  dropStatusCount.textContent = 'scanning…';
  dropStatusExtra.textContent = '';
  updateAddState();

  try {
    const scan = await window.api.scanSource(p);
    current.videoCount = scan.videos.length;
    current.ignoredCount = scan.ignored;
    current.totalSize = scan.totalSize || scan.videos.reduce((a, v) => a + (v.size || 0), 0);
    current.scanned = true;
    dropStatusPath.textContent = p;
    dropStatusPath.style.color = scan.videos.length > 0 ? 'var(--cyan)' : 'var(--amber)';
    dropStatusCount.textContent = `${scan.videos.length} video${scan.videos.length === 1 ? '' : 's'}`;
    const parts = [];
    if (scan.ignored > 0) parts.push(`${scan.ignored} ignored`);
    if (current.totalSize > 0) parts.push(`${humanBytes(current.totalSize)} total`);
    dropStatusExtra.textContent = parts.join(' · ') || '—';
  } catch (e) {
    dropStatusPath.textContent = `Scan failed: ${e.message}`;
    dropStatusPath.style.color = 'var(--red)';
    current.scanned = false;
  }
  updateAddState();
  updateTierHint();
});

chooseDestBtn.addEventListener('click', async () => {
  if (!current.src) return;
  const parent = current.src.replace(/\/[^/]*$/, '');
  const chosen = await window.api.chooseDestination(parent);
  if (chosen) {
    current.dest = chosen;
    destPathEl.textContent = chosen;
    destPathEl.classList.remove('placeholder');
    updateAddState();
  }
});

// Tier selection — keep the underlying radio working
tierInputs.forEach((inp) => {
  inp.addEventListener('change', () => {
    document.querySelectorAll('.tier').forEach((t) => t.classList.remove('selected'));
    const wrap = inp.closest('.tier');
    if (wrap) wrap.classList.add('selected');
  });
});
// Tier card click anywhere → select
document.querySelectorAll('.tier').forEach((wrap) => {
  wrap.addEventListener('click', (e) => {
    const rad = wrap.querySelector('input[type="radio"]');
    if (rad && !rad.checked) {
      rad.checked = true;
      rad.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
});

// Dry-run toggle (button-style, no checkbox)
dryRunBtn.addEventListener('click', () => {
  const on = dryRunBtn.getAttribute('aria-pressed') === 'true';
  dryRunBtn.setAttribute('aria-pressed', on ? 'false' : 'true');
  dryRunHint.textContent = on ? 'writes files' : 'no files written';
});

addBtn.addEventListener('click', () => {
  if (addBtn.disabled) return;
  const tier = document.querySelector('input[name="tier"]:checked').value;
  const dry = dryRunBtn.getAttribute('aria-pressed') === 'true';
  const item = {
    id: nextId++,
    src: current.src,
    srcName: current.srcName,
    dest: current.dest,
    tier,
    dryRun: dry,
    videoCount: current.videoCount,
    totalSize: current.totalSize || 0,
    status: 'queued',          // queued | running | done | failed
    progress: 0,                // 0..100
    processed: 0,               // files done
    failed: 0,
    reclaimed: 0,
    lastResult: null
  };
  queue.push(item);
  renderQueue();
  clearDrop();
});

function buildQrow(item, idx) {
  const li = document.createElement('li');
  li.className = 'qrow';
  li.dataset.id = item.id;
  li.draggable = item.status === 'queued';

  // # column
  const seq = document.createElement('div');
  seq.className = 'seq';
  seq.textContent = String(idx + 1).padStart(2, '0');
  li.appendChild(seq);

  // File column
  const fileCol = document.createElement('div');
  fileCol.className = 'file';
  const glyph = document.createElement('div');
  glyph.className = 'glyph';
  glyph.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px;"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4M3 12h18"/></svg>';
  const fileMeta = document.createElement('div');
  fileMeta.className = 'meta';
  const fname = document.createElement('div');
  fname.className = 'name';
  fname.textContent = item.srcName + (item.dryRun ? '  (preview)' : '');
  fileMeta.appendChild(fname);
  fileCol.appendChild(glyph);
  fileCol.appendChild(fileMeta);
  li.appendChild(fileCol);

  // Source size column — show file count when total size isn't known
  const sizeCol = document.createElement('div');
  sizeCol.className = 'mono';
  if (item.totalSize > 0) sizeCol.textContent = humanBytes(item.totalSize);
  else {
    sizeCol.textContent = `${item.videoCount} file${item.videoCount === 1 ? '' : 's'}`;
    sizeCol.classList.add('muted');
  }
  li.appendChild(sizeCol);

  // Tier column
  const tierCol = document.createElement('div');
  const cls = TIER_CSS[item.tier] || 'regular';
  const chip = document.createElement('span');
  chip.className = `tierchip ${cls}`;
  chip.innerHTML = `<span class="dot"></span>${TIER_LABEL[item.tier] || item.tier}`;
  tierCol.appendChild(chip);
  li.appendChild(tierCol);

  // Status column
  const statusCol = document.createElement('div');
  statusCol.className = `status ${item.status}`;
  const pillLabel = { queued: 'Queued', running: 'Running', done: 'Done', failed: 'Failed' }[item.status] || item.status;
  const pill = document.createElement('span');
  pill.className = 'pill';
  pill.innerHTML = `<span class="dot"></span>${pillLabel}`;
  const pbar = document.createElement('div');
  pbar.className = 'progressbar';
  const pbi = document.createElement('i');
  const pct = item.status === 'done' ? 100 : (item.status === 'failed' ? Math.max(8, item.progress) : item.progress);
  pbi.style.width = `${pct}%`;
  pbar.appendChild(pbi);
  statusCol.appendChild(pill);
  statusCol.appendChild(pbar);
  li.appendChild(statusCol);

  // Output column
  const outCol = document.createElement('div');
  outCol.className = 'mono';
  outCol.style.textAlign = 'right';
  if (item.status === 'done' && item.reclaimed > 0) {
    outCol.textContent = '↓ ' + humanBytes(item.reclaimed);
    outCol.classList.add('green');
  } else if (item.status === 'failed') {
    outCol.textContent = '—';
    outCol.classList.add('red');
  } else {
    outCol.textContent = '—';
    outCol.classList.add('muted');
  }
  li.appendChild(outCol);

  // More button — used here as "remove" for queued items
  const more = document.createElement('button');
  more.className = 'more';
  more.title = item.status === 'queued' ? 'Remove from queue' : 'More';
  more.setAttribute('aria-label', more.title);
  if (item.status === 'queued') {
    more.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px;"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    more.addEventListener('click', (e) => {
      e.stopPropagation();
      queue = queue.filter((x) => x.id !== item.id);
      renderQueue();
    });
  } else {
    more.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" style="width:14px;height:14px;"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>';
  }
  li.appendChild(more);

  // Drag-and-drop reordering (only queued)
  li.addEventListener('dragstart', (e) => {
    if (item.status !== 'queued') { e.preventDefault(); return; }
    li.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(item.id));
  });
  li.addEventListener('dragend', () => li.classList.remove('dragging'));
  li.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; });
  li.addEventListener('drop', (e) => {
    e.preventDefault();
    const draggedId = Number(e.dataTransfer.getData('text/plain'));
    const targetId = item.id;
    if (draggedId === targetId) return;
    const di = queue.findIndex((x) => x.id === draggedId);
    const ti = queue.findIndex((x) => x.id === targetId);
    if (di < 0 || ti < 0) return;
    if (queue[di].status !== 'queued' || queue[ti].status !== 'queued') return;
    const [moved] = queue.splice(di, 1);
    queue.splice(ti, 0, moved);
    renderQueue();
  });

  return li;
}

function renderQueue() {
  queueEl.innerHTML = '';
  queue.forEach((item, idx) => queueEl.appendChild(buildQrow(item, idx)));

  const total = queue.length;
  const done = queue.filter((q) => q.status === 'done').length;
  const running = queue.filter((q) => q.status === 'running').length;
  const queued = queue.filter((q) => q.status === 'queued').length;
  const failed = queue.filter((q) => q.status === 'failed').length;

  queueHeadingEl.textContent = `Queue · ${total}`;
  queueCountEl.innerHTML = `${done} done · ${running} running · ${queued} waiting · ` +
    (failed > 0 ? `<span class="red">${failed} failed</span>` : `0 failed`);

  // foot totals
  const srcSum = queue.reduce((a, q) => a + (q.totalSize || 0), 0);
  const recSum = queue.reduce((a, q) => a + (q.reclaimed || 0), 0);
  qfootSource.textContent = srcSum > 0 ? humanBytes(srcSum) : '—';
  qfootReclaimed.textContent = recSum > 0 ? '↓ ' + humanBytes(recSum) : '—';
  if (failed > 0) {
    qfootFailed.innerHTML = `<span class="danger">${failed} failure${failed === 1 ? '' : 's'} need${failed === 1 ? 's' : ''} review</span>`;
  } else {
    qfootFailed.textContent = 'no failures';
  }

  startBtn.disabled = queued === 0;
}

startBtn.addEventListener('click', async () => {
  const toRun = queue.filter((q) => q.status === 'queued');
  if (toRun.length === 0) return;
  summaryCard.classList.add('hidden');
  progressCard.classList.remove('hidden');
  startBtn.classList.add('hidden');
  stopBtn.classList.remove('hidden');
  if (topProgress) topProgress.classList.add('active');
  if (tlTag) tlTag.textContent = 'Squeeze · running';
  resetProgressUI();
  await window.api.startQueue(toRun.map((b) => ({
    id: b.id,
    src: b.src,
    dest: b.dest,
    tier: b.tier,
    dryRun: b.dryRun
  })));
});

stopBtn.addEventListener('click', async () => {
  stopBtn.disabled = true;
  stopBtn.textContent = 'Stopping after current file…';
  if (tlTag) tlTag.textContent = 'Squeeze · stopping…';
  await window.api.stopQueue();
});

function resetProgressUI() {
  progressFill.style.width = '0%';
  progressBatch.textContent = '';
  progressCounts.textContent = '';
  currentFileEl.textContent = '';
  currentEtaEl.textContent = '';
  reclaimedEl.textContent = '0 B';
  statCompleted.textContent = '0';
  statIgnored.textContent = '0';
  statFailed.textContent = '0';
  statFailed.classList.remove('has-failures');
}

window.api.onBatchStatus(({ id, status, result }) => {
  const item = queue.find((q) => q.id === id);
  if (!item) return;

  // Map main-process status strings → our queue row status
  if (status === 'Running') {
    item.status = 'running';
    item.progress = 0;
    currentBatchId = id;
    perFileTimes = [];
    progressBatch.textContent = `Running: ${item.srcName}`;
  } else if (status === 'Done') {
    item.status = 'done';
    item.progress = 100;
    if (result) {
      item.lastResult = result;
      item.processed = result.processed || 0;
      item.failed = result.failed || 0;
      item.reclaimed = result.reclaimed || 0;
    }
  } else if (status && status.startsWith('Done')) {
    // "Done (with failures)"
    item.status = (result && result.processed > 0) ? 'done' : 'failed';
    item.progress = 100;
    if (result) {
      item.lastResult = result;
      item.processed = result.processed || 0;
      item.failed = result.failed || 0;
      item.reclaimed = result.reclaimed || 0;
    }
  } else if (status === 'Failed') {
    item.status = 'failed';
    if (result) item.lastResult = result;
  }
  renderQueue();
});

window.api.onProgress((d) => {
  if (d.type === 'file-start') {
    currentFileEl.textContent = d.basename;
    lastFileStartTs = Date.now();
    progressCounts.textContent = `File ${d.index} of ${d.total}`;
    // update batch row progress for fractional advance
    const item = queue.find((q) => q.id === currentBatchId);
    if (item) {
      item.progress = ((d.index - 1) / d.total) * 100;
      const row = queueEl.querySelector(`[data-id="${item.id}"] .progressbar > i`);
      if (row) row.style.width = `${item.progress.toFixed(1)}%`;
    }
  } else if (d.type === 'file-progress') {
    const overall = ((d.index - 1) + d.fileProgress) / d.total;
    progressFill.style.width = `${(overall * 100).toFixed(1)}%`;
    const item = queue.find((q) => q.id === currentBatchId);
    if (item) {
      item.progress = overall * 100;
      const row = queueEl.querySelector(`[data-id="${item.id}"] .progressbar > i`);
      if (row) row.style.width = `${item.progress.toFixed(1)}%`;
    }
  } else if (d.type === 'file-done') {
    const overall = d.index / d.total;
    progressFill.style.width = `${(overall * 100).toFixed(1)}%`;
    statCompleted.textContent = String(d.processed + d.alreadyDone);
    statFailed.textContent = String(d.failed);
    if (d.failed > 0) statFailed.classList.add('has-failures');
    reclaimedEl.textContent = humanBytes(d.reclaimed);

    const item = queue.find((q) => q.id === currentBatchId);
    if (item) {
      item.progress = overall * 100;
      item.reclaimed = d.reclaimed || item.reclaimed;
      item.processed = (d.processed || 0) + (d.alreadyDone || 0);
      item.failed = d.failed || 0;
      // update inline row without full rebuild for smoothness
      const row = queueEl.querySelector(`[data-id="${item.id}"]`);
      if (row) {
        const fill = row.querySelector('.progressbar > i');
        if (fill) fill.style.width = `${item.progress.toFixed(1)}%`;
      }
      // also refresh footer reclaim total
      const recSum = queue.reduce((a, q) => a + (q.reclaimed || 0), 0);
      qfootReclaimed.textContent = recSum > 0 ? '↓ ' + humanBytes(recSum) : '—';
    }

    if (lastFileStartTs > 0) {
      perFileTimes.push(Date.now() - lastFileStartTs);
      if (perFileTimes.length > 30) perFileTimes.shift();
    }
    if (perFileTimes.length >= 5 && d.index < d.total) {
      const avg = perFileTimes.reduce((a, b) => a + b, 0) / perFileTimes.length;
      const remaining = (d.total - d.index) * avg;
      currentEtaEl.textContent = `~${fmtDuration(remaining)} remaining`;
    }
  } else if (d.type === 'dry-summary') {
    currentFileEl.textContent = `[dry run] ${d.videos} videos · ${d.ignored} ignored`;
    progressCounts.textContent = `Est. reclaim: ${humanBytes(d.estReclaim)}`;
    statCompleted.textContent = String(d.videos);
    statIgnored.textContent = String(d.ignored);
  }
});

window.api.onQueueFinished(({ totals, stopped }) => {
  progressCard.classList.add('hidden');
  stopBtn.classList.add('hidden');
  stopBtn.disabled = false;
  stopBtn.textContent = 'Stop after current file';
  startBtn.classList.remove('hidden');
  if (topProgress) topProgress.classList.remove('active');
  if (tlTag) tlTag.textContent = stopped ? 'Squeeze · stopped' : 'Squeeze · idle';

  const lines = [];
  if (stopped) lines.push(`<div class="muted">Stopped by user.</div>`);
  const doneBatches = queue.filter((q) => q.status === 'done').length;
  lines.push(`<div>Processed <strong>${totals.processed}</strong> file${totals.processed === 1 ? '' : 's'} across ${doneBatches} batch${doneBatches === 1 ? '' : 'es'}.</div>`);
  if (totals.alreadyDone > 0) lines.push(`<div class="muted">Already done (skipped): ${totals.alreadyDone}</div>`);
  if (totals.skippedNonVideo > 0) lines.push(`<div class="muted">Ignored non-video items: ${totals.skippedNonVideo}</div>`);
  lines.push(`<div class="reclaimed-line">Reclaimed ${humanBytes(totals.reclaimed)} across ${totals.processed} file${totals.processed === 1 ? '' : 's'}.</div>`);
  if (totals.failed > 0) lines.push(`<div class="failed-line">Failed: ${totals.failed} (originals copied to _FAILED/ — sources untouched).</div>`);
  summaryBody.innerHTML = lines.join('');

  const lastDone = [...queue].reverse().find((q) => q.lastResult);
  lastRun = lastDone ? lastDone.lastResult : null;
  showLogBtn.disabled = !lastRun || !lastRun.logPath;
  revealOutputBtn.disabled = !lastRun || !lastRun.runDir;

  summaryCard.classList.remove('hidden');
});

showLogBtn.addEventListener('click', () => {
  if (lastRun && lastRun.logPath) window.api.openPath(lastRun.logPath);
});
revealOutputBtn.addEventListener('click', () => {
  if (lastRun && lastRun.runDir) window.api.revealPath(lastRun.runDir);
});
dismissSummaryBtn.addEventListener('click', () => {
  summaryCard.classList.add('hidden');
});

clearDrop();
renderQueue();
