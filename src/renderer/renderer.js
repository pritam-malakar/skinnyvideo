const dropzone = document.getElementById('dropzone');
const dropStatus = document.getElementById('drop-status');
const destPathEl = document.getElementById('dest-path');
const chooseDestBtn = document.getElementById('choose-dest');
const tierInputs = document.querySelectorAll('input[name="tier"]');
const dryRunCb = document.getElementById('dry-run');
const addBtn = document.getElementById('add-to-queue');
const queueEl = document.getElementById('queue');
const queueCountEl = document.getElementById('queue-count');
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

let current = {
  src: null,
  srcName: null,
  videoCount: 0,
  ignoredCount: 0,
  scanned: false,
  dest: null,
  destAutoFromSrc: true
};
let queue = [];
let nextId = 1;
let lastRun = null;

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
  dropStatus.textContent = text;
  dropStatus.classList.remove('hidden');
  dropStatus.style.color = ({
    cyan: 'var(--cyan)',
    green: 'var(--green)',
    amber: 'var(--amber)',
    red: 'var(--red)',
    muted: 'var(--muted)'
  })[kind] || 'var(--cyan)';
}

function clearDropStatus() {
  dropStatus.textContent = '';
  dropStatus.classList.add('hidden');
}

function updateAddState() {
  const ready = current.src && current.dest && current.scanned && current.videoCount > 0;
  addBtn.disabled = !ready;
  chooseDestBtn.disabled = !current.src;
}

function clearDrop() {
  current = { src: null, srcName: null, videoCount: 0, ignoredCount: 0, scanned: false, dest: null, destAutoFromSrc: true };
  destPathEl.textContent = 'No destination chosen';
  destPathEl.classList.add('placeholder');
  clearDropStatus();
  updateAddState();
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
    setDropStatus('Could not read dropped path. Try again.', 'red');
    return;
  }
  current.src = p;
  current.srcName = p.split('/').pop();
  current.scanned = false;
  setDropStatus(`${current.srcName} — scanning…`, 'cyan');
  updateAddState();

  try {
    const scan = await window.api.scanSource(p);
    current.videoCount = scan.videos.length;
    current.ignoredCount = scan.ignored;
    current.scanned = true;
    const ignoredPart = scan.ignored > 0 ? ` (${scan.ignored} non-video items ignored)` : '';
    setDropStatus(`${current.srcName} — ${scan.videos.length} video file${scan.videos.length === 1 ? '' : 's'} found${ignoredPart}`, scan.videos.length > 0 ? 'green' : 'amber');
  } catch (e) {
    setDropStatus(`Scan failed: ${e.message}`, 'red');
    current.scanned = false;
  }
  updateAddState();
});

chooseDestBtn.addEventListener('click', async () => {
  if (!current.src) return;
  const parent = current.src.replace(/\/[^/]*$/, '');
  const chosen = await window.api.chooseDestination(parent);
  if (chosen) {
    current.dest = chosen;
    current.destAutoFromSrc = false;
    destPathEl.textContent = chosen;
    destPathEl.classList.remove('placeholder');
    updateAddState();
  }
});

tierInputs.forEach((inp) => {
  inp.addEventListener('change', () => {
    document.querySelectorAll('.tier').forEach((t) => t.classList.remove('selected'));
    const wrap = inp.closest('.tier');
    if (wrap) wrap.classList.add('selected');
  });
});

addBtn.addEventListener('click', () => {
  if (addBtn.disabled) return;
  const tier = document.querySelector('input[name="tier"]:checked').value;
  const dry = dryRunCb.checked;
  const item = {
    id: nextId++,
    src: current.src,
    srcName: current.srcName,
    dest: current.dest,
    tier,
    dryRun: dry,
    videoCount: current.videoCount,
    status: 'Waiting'
  };
  queue.push(item);
  renderQueue();
  clearDrop();
});

function renderQueue() {
  queueEl.innerHTML = '';
  queue.forEach((item, idx) => {
    const li = document.createElement('li');
    li.className = 'queue-item';
    li.draggable = item.status === 'Waiting';
    li.dataset.id = item.id;

    const bar = document.createElement('div');
    bar.className = `queue-tier-bar queue-tier-${item.tier}`;
    li.appendChild(bar);

    const info = document.createElement('div');
    info.className = 'queue-info';
    const src = document.createElement('div');
    src.className = 'queue-src';
    src.textContent = item.srcName;
    const meta = document.createElement('div');
    meta.className = 'queue-meta';
    meta.textContent = `${item.videoCount} video${item.videoCount === 1 ? '' : 's'} → ${item.dest}`;
    info.appendChild(src);
    info.appendChild(meta);
    li.appendChild(info);

    const tierLabel = document.createElement('div');
    tierLabel.className = `queue-tier-label ${item.tier}`;
    const tierName = item.tier === 'regular' ? 'Regular' : (item.tier === 'preserve' ? 'Preserve' : 'Compress AF');
    tierLabel.textContent = tierName + (item.dryRun ? ' (dry)' : '');
    li.appendChild(tierLabel);

    const status = document.createElement('div');
    status.className = 'queue-status';
    const cls = item.status === 'Running' ? 'running' :
                (item.status.startsWith('Done') ? 'done' :
                 (item.status === 'Failed' ? 'failed' : ''));
    if (cls) status.classList.add(cls);
    status.textContent = item.status;
    li.appendChild(status);

    if (item.status === 'Waiting') {
      const rm = document.createElement('button');
      rm.className = 'queue-remove';
      rm.textContent = '×';
      rm.title = 'Remove from queue';
      rm.addEventListener('click', (e) => {
        e.stopPropagation();
        queue = queue.filter((x) => x.id !== item.id);
        renderQueue();
      });
      li.appendChild(rm);
    } else {
      const spacer = document.createElement('div');
      li.appendChild(spacer);
    }

    li.addEventListener('dragstart', (e) => {
      if (item.status !== 'Waiting') { e.preventDefault(); return; }
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
      if (queue[di].status !== 'Waiting' || queue[ti].status !== 'Waiting') return;
      const [moved] = queue.splice(di, 1);
      queue.splice(ti, 0, moved);
      renderQueue();
    });

    queueEl.appendChild(li);
  });

  const waiting = queue.filter((q) => q.status === 'Waiting').length;
  queueCountEl.textContent = queue.length === 0 ? 'empty' :
    `${queue.length} batch${queue.length === 1 ? '' : 'es'} (${waiting} waiting)`;
  startBtn.disabled = waiting === 0;
}

startBtn.addEventListener('click', async () => {
  const toRun = queue.filter((q) => q.status === 'Waiting');
  if (toRun.length === 0) return;
  summaryCard.classList.add('hidden');
  progressCard.classList.remove('hidden');
  startBtn.classList.add('hidden');
  stopBtn.classList.remove('hidden');
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

let currentBatchId = null;
let currentBatchStart = 0;
let perFileTimes = [];

window.api.onBatchStatus(({ id, status, result }) => {
  const item = queue.find((q) => q.id === id);
  if (item) {
    item.status = status;
    if (result) item.lastResult = result;
    renderQueue();
  }
  if (status === 'Running') {
    currentBatchId = id;
    currentBatchStart = Date.now();
    perFileTimes = [];
    progressBatch.textContent = `Running: ${item ? item.srcName : ''}`;
  }
});

let lastIndex = 0;
let lastFileStartTs = 0;
window.api.onProgress((d) => {
  if (d.type === 'file-start') {
    currentFileEl.textContent = d.basename;
    lastIndex = d.index;
    lastFileStartTs = Date.now();
    progressCounts.textContent = `File ${d.index} of ${d.total}`;
  } else if (d.type === 'file-progress') {
    const overall = ((d.index - 1) + d.fileProgress) / d.total;
    progressFill.style.width = `${(overall * 100).toFixed(1)}%`;
  } else if (d.type === 'file-done') {
    const overall = d.index / d.total;
    progressFill.style.width = `${(overall * 100).toFixed(1)}%`;
    statCompleted.textContent = String(d.processed + d.alreadyDone);
    statFailed.textContent = String(d.failed);
    if (d.failed > 0) statFailed.classList.add('has-failures');
    reclaimedEl.textContent = humanBytes(d.reclaimed);

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
    currentFileEl.textContent = `[dry run] ${d.videos} videos, ${d.ignored} ignored`;
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

  const lines = [];
  if (stopped) lines.push(`<div class="muted">Stopped by user.</div>`);
  lines.push(`<div>Processed: <strong>${totals.processed}</strong> file${totals.processed === 1 ? '' : 's'} across ${queue.filter((q) => q.status.startsWith('Done')).length} batch${queue.filter((q) => q.status.startsWith('Done')).length === 1 ? '' : 'es'}.</div>`);
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

renderQueue();
updateAddState();
