const dropzone = document.getElementById('dropzone');
const dropStatus = document.getElementById('drop-status');
const dropStatusPath = document.getElementById('drop-status-path');
const dropStatusCount = document.getElementById('drop-status-count');
const dropStatusExtra = document.getElementById('drop-status-extra');
const dropClearBtn = document.getElementById('drop-clear');
const destPathEl = document.getElementById('dest-path');
const chooseDestBtn = document.getElementById('choose-dest');
const tierInputs = document.querySelectorAll('input[name="tier"]');
const dryRunBtn = document.getElementById('dry-run');
const safetyBar = document.getElementById('safety-bar');
const safetyModeEl = document.getElementById('safety-mode');
const safetySubEl = document.getElementById('safety-sub');
const dryStateEl = document.getElementById('dry-state');
const dzStepsEl = document.getElementById('dz-steps');
const outputRow = document.querySelector('.output-row');
const tierHead = document.getElementById('tier-head');
const tiersEl = document.querySelector('.tiers');
const dzTitle = document.getElementById('dz-title');
const dzBrowseBtn = document.getElementById('dz-browse');
const dzBrowseTextBtn = document.getElementById('dz-browse-text');
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
const statEta = document.getElementById('stat-eta');
const finalizingNoteEl = document.getElementById('finalizing-note');
const appVersionEl = document.getElementById('app-version');
const lifetimeSection = document.getElementById('lifetime-section');
const lifetimeList = document.getElementById('lifetime-list');
const lifetimeTotal = document.getElementById('lifetime-total');

/* ───── Pass 4 motion: visual-haptic helpers ─────
   renderQueue() rebuilds the whole queue DOM on structural changes, so one-shot
   animations are gated by id Sets to fire exactly once (not every rebuild).
   All CSS motion is behind @media (no-preference); _motionOK() mirrors that for
   the JS/WAAPI paths. Durations/easings are read from the :root tokens. */
const _enteredBatches = new Set();   // batch.id  → entered (settle + stagger)
const _bloomedFiles = new Set();     // batchId|path → done-bloom shown
const _shakenFiles = new Set();      // batchId|path → fail-shake shown
const _rootStyle = getComputedStyle(document.documentElement);
const _motionOK = () => window.matchMedia('(prefers-reduced-motion: no-preference)').matches;
const _durBase = () => parseFloat(_rootStyle.getPropertyValue('--dur-base')) || 240;
const _easeSettle = () => _rootStyle.getPropertyValue('--ease-settle').trim() || 'ease';

const DEST_PLACEHOLDER = 'Choose a folder — a run subfolder is created automatically';
// Maps pipeline tier id → CSS class + display label
const TIER_CSS = { regular: 'regular', preserve: 'archival' };
const TIER_LABEL = { regular: 'Make It Fast', preserve: 'Slow But Better' };
/* Tier names render from this ONE constant everywhere — the cards' .name
   nodes are stamped here at boot (keyed by data-tier), so the queue chips,
   the Pro settings panel, and the cards can never drift apart. */
document.querySelectorAll('.tier[data-tier]').forEach((card) => {
  const nameEl = card.querySelector('.name');
  if (nameEl && TIER_LABEL[card.dataset.tier]) nameEl.textContent = TIER_LABEL[card.dataset.tier];
});

/* Staging area = the batch currently being composed. Tier and dryRun are
   sticky on the UI controls; on Add they get FROZEN into the batch and the
   tier UI resets to the default (RECOMMENDED / "Make It Fast"). */
let current = {
  src: null,           // folder path for 'folder' kind; null for 'files' kind
  srcName: null,       // display name in dropzone + batch header
  kind: 'folder',      // 'folder' (validated folder-scan path) | 'files' (file-list branch)
  fileSources: [],     // original picked/dropped file paths — used by 'files' kind only
  videoCount: 0,
  ignoredCount: 0,
  totalSize: 0,
  scanned: false,
  dest: null,
  files: []            // [{path, name, size}] — frozen into the batch on Add
};
let queue = [];           // ordered list of batches
let nextId = 1;
let lastRun = null;
let currentBatchId = null;
let perFileTimes = [];
let lastFileStartTs = 0;
let hasCompletedRun = false;     // P7: first-time vs subsequent drops
let batchPrevReclaimed = 0;      // delta tracker for per-file output size
let runActive = false;           // true while a queue run is in progress (gates the flow's Start cue)
let editingBatchId = null;       // batch id whose name is being inline-renamed (null = none)

/* ───── FIX 2: always-on whole-queue ETA (per-tier throughput model) ─────
   Throughput is modelled PER TIER in bytes-of-source per millisecond, because
   x265 ("preserve") is far slower than VideoToolbox HEVC ("regular"). Seeded
   with rough rates so a number can show almost immediately, then refined live
   by an EWMA as files report progress and complete. The remaining-time sum is
   computed from queue state every tick, so it's continuous and present for the
   whole run — and pause-safe (it uses progress, not wall-clock, so a paused
   file's estimate simply freezes). */
const TIER_SEED_BPMS = {
  regular:  16 * 1024 * 1024 / 1000,   // ~16 MB/s of source (HW HEVC, fast)
  preserve: 2  * 1024 * 1024 / 1000    // ~2 MB/s of source  (x265 medium, slow)
};
let tierBpms = { ...TIER_SEED_BPMS };
let etaHasSignal = false;        // have we observed ANY live throughput yet?
let etaTimer = null;             // 1s ticker that keeps the ETA/bar alive
const EWMA_DONE = 0.4;           // weight for a completed-file measurement
const EWMA_PROG = 0.15;          // weight for a mid-file progress measurement

function bpmsFor(tier) {
  const v = tierBpms[tier];
  return (Number.isFinite(v) && v > 0) ? v : TIER_SEED_BPMS.regular;
}
/* Fold a fresh throughput sample (bytes/ms) into the tier's EWMA. Caps upward
   jumps so one fast sample can't make the ETA lurch down then back up. */
function refineBpms(tier, instBpms, alpha) {
  if (!(instBpms > 0) || !Number.isFinite(instBpms)) return;
  const prev = bpmsFor(tier);
  const sample = Math.min(instBpms, prev * 8);
  tierBpms[tier] = alpha * sample + (1 - alpha) * prev;
  etaHasSignal = true;
}
function resetEtaModel() {
  tierBpms = { ...TIER_SEED_BPMS };
  etaHasSignal = false;
}

/* ───── Finalizing state (the honest "writing to disk" window) ─────
   At 100% ffmpeg goes quiet while it flushes the container (slow over SMB).
   The renderer used to freeze on the last % and a fabricated "~10s left".
   Instead we show an indeterminate bar + a plain note:
     · active+!confirmed → instant heuristic: running file pinned ≳99% and no
       fresh progress for ~2 ticks (covers the ~60s before main confirms).
     · active+confirmed  → main's write-aware watchdog confirmed bytes are
       still landing on disk (type:'finalizing' IPC).
   Cleared on file-start / file-done / queue end. */
let finalizing = { active: false, confirmed: false };
let lastFileProgressTs = 0;     // when the last file-progress arrived
let lastFileProgressVal = 0;    // its fraction (0..1)

function applyFinalizingUI() {
  if (progressCard) progressCard.classList.toggle('finalizing', finalizing.active);
  if (finalizingNoteEl) {
    if (finalizing.active) {
      finalizingNoteEl.textContent = finalizing.confirmed
        ? 'Writing to disk — please don’t quit'
        : 'Finishing up…';
      finalizingNoteEl.hidden = false;
    } else {
      finalizingNoteEl.hidden = true;
      finalizingNoteEl.textContent = '';
    }
  }
  /* Mirror onto the running batch's bars (overall row + the active file row) so
     they read indeterminate too. Applied imperatively because no progress
     events arrive during the flush to trigger a re-render. */
  const batch = queue.find((q) => q.id === currentBatchId);
  if (!batch) return;
  const root = queueEl ? queueEl.querySelector(`[data-id="${batch.id}"]`) : null;
  if (!root) return;
  const obar = root.querySelector('.qbatch-status .progressbar');
  if (obar) obar.classList.toggle('indeterminate', finalizing.active);
  const idx = Number.isFinite(batch.runningFileIdx) ? batch.runningFileIdx : -1;
  if (idx >= 0 && batch.files[idx]) {
    const filesList = root.querySelector('.qbatch-files');
    const targetPath = batch.files[idx].path;
    const fileRow = filesList
      ? [...filesList.querySelectorAll('.qrow')].find((r) => r.dataset.fpath === targetPath)
      : null;
    const fbar = fileRow ? fileRow.querySelector('.status .progressbar') : null;
    if (fbar) fbar.classList.toggle('indeterminate', finalizing.active);
  }
}

function setFinalizing(active, confirmed) {
  finalizing.active = !!active;
  finalizing.confirmed = !!confirmed;
  applyFinalizingUI();
}

/* Instant heuristic, evaluated each ETA tick. Never overrides a confirmed
   signal (which only main can clear, via file-done). */
function maybeInferFinalizing() {
  if (!runActive || finalizing.confirmed) return;
  const stale = lastFileProgressTs > 0 && (Date.now() - lastFileProgressTs) >= 2000;
  const nearDone = lastFileProgressVal >= 0.99;
  const want = stale && nearDone;
  if (want !== finalizing.active) setFinalizing(want, false);
}

/* Whole-queue work accounting (by SOURCE SIZE), used by BOTH the overall
   progress bar (FIX 3) and the ETA (FIX 2) so they always agree. Terminal
   files (done/existed/failed/cancelled) count as fully-worked; the running
   file counts its fraction; queued files contribute their full remaining
   time. Operator-skipped files are not part of the run's work. */
function computeQueueWork() {
  let totalBytes = 0, doneBytes = 0, remainMs = 0, hasRemaining = false;
  // Whole-queue counters OBSERVED from per-file state (not consumed from the
  // event stream) — so the progress-card Completed/Reclaimed match the sum of
  // finished work across ALL batches, and agree with the bar/ETA above.
  let completed = 0, failedCount = 0, reclaimedBytes = 0;
  for (const b of queue) {
    const bpms = bpmsFor(b.tier);
    for (const f of b.files) {
      if (f.status === 'skipped') continue;
      const size = (Number.isFinite(f.size) && f.size > 0) ? f.size : 0;
      totalBytes += size;
      if (f.status === 'done' || f.status === 'existed' || f.status === 'failed' || f.status === 'cancelled') {
        doneBytes += size;
      } else if (f.status === 'running') {
        const prog = Math.max(0, Math.min(1, (f.progress || 0) / 100));
        doneBytes += size * prog;
        remainMs += (size * (1 - prog)) / bpms;
        hasRemaining = true;
      } else { // queued
        remainMs += size / bpms;
        hasRemaining = true;
      }
      if (f.status === 'done' || f.status === 'existed') {
        completed++;
        if (Number.isFinite(f.outputSize) && Number.isFinite(f.size) && f.size > f.outputSize) {
          reclaimedBytes += f.size - f.outputSize;
        }
      } else if (f.status === 'failed') {
        failedCount++;
      }
    }
  }
  return { totalBytes, doneBytes, remainMs, hasRemaining, completed, failedCount, reclaimedBytes };
}

/* Whole-queue file position + the file currently encoding, for the progress
   card TEXT ("Running: <file>" / "File X of Y"). Reads the SAME `queue` per-file
   state the bar's computeQueueWork does, so the counter and the bar tell one
   story: skipped files are excluded from the total (mirrors computeQueueWork's
   `continue`), and the position/name are whole-queue, never per-batch. */
function computeQueueFileText() {
  let total = 0, terminal = 0, runningName = '', runningBatchName = '', running = false;
  for (const b of queue) {
    for (const f of b.files) {
      if (f.status === 'skipped') continue;
      total++;
      if (f.status === 'running') { runningName = f.name; runningBatchName = b.srcName || ''; running = true; }
      else if (f.status === 'done' || f.status === 'existed' || f.status === 'failed' || f.status === 'cancelled') terminal++;
    }
  }
  // The running file is the (terminal + 1)-th non-skipped file queue-wide; in a
  // between-files gap fall back to the completed count so X never regresses.
  const index = running ? terminal + 1 : terminal;
  return { index, total, runningName, runningBatchName, running };
}

/* Paint the overall bar, the ETA strip, AND the whole-queue stat counters from
   current queue state. Pure observation — it reads per-file state, never
   consumes or mutates the progress events (FIX: keeps the throughput model from
   intercepting the file-done state). */
function updateOverallProgressEta() {
  const w = computeQueueWork();
  if (progressFill) {
    const frac = w.totalBytes > 0 ? Math.max(0, Math.min(1, w.doneBytes / w.totalBytes)) : 0;
    progressFill.style.width = `${(frac * 100).toFixed(1)}%`;
  }
  // Whole-queue counters (match the sum of finished batches, not the current one).
  if (statCompleted) statCompleted.textContent = String(w.completed);
  if (statFailed) {
    statFailed.textContent = String(w.failedCount);
    statFailed.classList.toggle('has-failures', w.failedCount > 0);
  }
  if (reclaimedEl) reclaimedEl.textContent = humanBytes(w.reclaimedBytes);

  /* Whole-queue card TEXT — same `queue` source as the bar above, so the header
     names the currently-encoding BATCH (its job name) and "File X of Y" counts
     across ALL non-skipped files in ALL batches. The file basename lives on the
     #current-file sub-line. GRACEFUL FALLBACK: a single loose-file drop labels
     the batch with the file's own basename (fileListDisplayName), so if the
     batch name is empty or just echoes the running file, show the file here
     instead of stacking the same basename twice. */
  const t = computeQueueFileText();
  if (progressBatch && t.running) {
    const label = (t.runningBatchName && t.runningBatchName !== t.runningName) ? t.runningBatchName : t.runningName;
    progressBatch.textContent = `Running: ${label}`;
  }
  if (progressCounts && t.total > 0 && t.index > 0) progressCounts.textContent = `File ${t.index} of ${t.total}`;

  // Re-evaluate the "finishing up" heuristic each tick (running file pinned
  // ≳99% with no fresh progress) before deciding what the ETA strip shows.
  maybeInferFinalizing();

  if (!w.hasRemaining) { hideEta(); return; }
  /* During the flush window the time-left is meaningless — the note carries
     the state. No fabricated countdown. */
  if (finalizing.active) { hideEta(); return; }
  if (!etaHasSignal) { showEta('Estimating…'); return; }
  // Honest estimate only — when there's none (remainMs ≤ 0), hide rather than
  // invent a floor.
  const eta = fmtEta(w.remainMs);
  if (eta) showEta(eta); else hideEta();
}

/* A file row in a settled state — done/failed/cancelled/already-present/
   operator-skipped. Used to resolve file-done events to the right row and to
   reconcile leftovers when a batch reaches a terminal status (BUG A). */
const TERMINAL_FILE_STATUSES = new Set(['done', 'failed', 'cancelled', 'existed', 'skipped']);
function isTerminalFileStatus(s) { return TERMINAL_FILE_STATUSES.has(s); }

/* BUG A — once a batch reaches a terminal status, make sure NO file row is
   left mid-flight, so the batch pill always agrees with its file rows. A row
   still 'running' when the batch finished actually completed (its file-done
   just didn't resolve) → done; a row never started (e.g. its source was
   removed before the run scanned it) → failed. On cancel, all leftovers →
   cancelled. */
function reconcileBatchFiles(item) {
  const kind = item.status; // 'done' | 'failed' | 'cancelled'
  for (const f of item.files) {
    if (isTerminalFileStatus(f.status)) continue;
    if (kind === 'cancelled') f.status = 'cancelled';
    else if (kind === 'failed') f.status = 'failed';
    else f.status = (f.status === 'running') ? 'done' : 'failed';
    f.progress = 100;
  }
}

function humanBytes(n) {
  if (!Number.isFinite(n)) return '0 B';
  const sign = n < 0 ? '-' : '';
  n = Math.abs(n);
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  // Base 1000 (decimal) so displayed sizes match macOS Finder + the real bytes.
  while (n >= 1000 && i < units.length - 1) { n /= 1000; i++; }
  return sign + n.toFixed(n >= 10 || i === 0 ? 0 : 1) + ' ' + units[i];
}

/* ───── Generic modal ─────
   A promise-returning decision dialog used by the disk-space pre-flight
   and the orphaned-partial recovery prompt. Resolves to an action's
   `value`, or null when dismissed (backdrop click / Esc / ✕) — dismissal
   is always the safe no-op. Only one modal at a time. `body` is trusted
   HTML built by callers (no user-controlled markup is interpolated raw —
   paths go through escapeHtml). */
let activeModal = null;
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
const MODAL_ICONS = {
  warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.6 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.6a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/></svg>',
  info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8h.01M11 12h1v4h1"/></svg>'
};
function showModal({ title, body, tone = 'warn', actions = [] }) {
  if (activeModal) { activeModal.cleanup(null); }
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    const card = document.createElement('div');
    card.className = `modal-card tone-${tone}`;
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');

    const head = document.createElement('div');
    head.className = 'modal-head';
    head.innerHTML =
      `<div class="modal-icon">${MODAL_ICONS[tone] || MODAL_ICONS.warn}</div>`
      + `<div class="modal-title">${escapeHtml(title)}</div>`;
    card.appendChild(head);

    const bodyEl = document.createElement('div');
    bodyEl.className = 'modal-body';
    bodyEl.innerHTML = body;
    card.appendChild(bodyEl);

    const actionsEl = document.createElement('div');
    actionsEl.className = 'modal-actions';
    actions.forEach((a) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn' + (a.kind === 'primary' ? ' cta' : a.kind === 'ghost' ? ' ghost' : '');
      btn.textContent = a.label;
      btn.addEventListener('click', () => cleanup(a.value));
      actionsEl.appendChild(btn);
    });
    card.appendChild(actionsEl);
    backdrop.appendChild(card);

    function onKey(e) { if (e.key === 'Escape') cleanup(null); }
    function onBackdrop(e) { if (e.target === backdrop) cleanup(null); }
    function cleanup(val) {
      if (activeModal !== handle) return;
      document.removeEventListener('keydown', onKey, true);
      backdrop.removeEventListener('mousedown', onBackdrop);
      backdrop.remove();
      activeModal = null;
      resolve(val);
    }
    const handle = { cleanup };
    activeModal = handle;
    document.addEventListener('keydown', onKey, true);
    backdrop.addEventListener('mousedown', onBackdrop);
    document.body.appendChild(backdrop);
    // Focus the primary (last) action for keyboard users.
    const primary = actionsEl.querySelector('.btn.cta') || actionsEl.lastElementChild;
    if (primary) primary.focus();
  });
}

/* ───── Pro Mode ─────
   Session-only state: defaults to Simple on EVERY launch, never persisted.
   Flipping mid-run is safe by construction — every batch freezes its settings
   snapshot at enqueue time (addCurrentToQueue), so the toggle only affects
   batches added AFTER the flip. */
let proMode = false;
const modeSimpleBtn = document.getElementById('mode-simple');
const modeProBtn = document.getElementById('mode-pro');
function setProMode(on) {
  proMode = !!on;
  if (modeSimpleBtn) {
    modeSimpleBtn.classList.toggle('active', !proMode);
    modeSimpleBtn.setAttribute('aria-pressed', String(!proMode));
  }
  if (modeProBtn) {
    modeProBtn.classList.toggle('active', proMode);
    modeProBtn.setAttribute('aria-pressed', String(proMode));
  }
  /* The room changes: body.pro-mode crossfades the violet atmosphere overlay
     in and the cool base bloom down (CSS-only, reduced-motion gated). The
     class only ADDS rules — Simple appearance is the untouched base. */
  document.body.classList.toggle('pro-mode', proMode);
  /* Flip-on: silently arm the currently-checked tier (session memory or
     defaults) so armed.tier always equals the checked tier in Pro Mode.
     No sheet — sheets open ONLY on explicit card clicks. */
  if (proMode) {
    const checked = document.querySelector('input[name="tier"]:checked');
    armTier(checked ? checked.value : 'regular');
  } else {
    updateArmedChips();   // chips are a Pro-only signal
  }
}
if (modeSimpleBtn) modeSimpleBtn.addEventListener('click', () => setProMode(false));
if (modeProBtn) modeProBtn.addEventListener('click', () => setProMode(true));

/* ───── Theme toggle (reskin v3e) ─────
   Session-only, same precedent as the Nerd toggle: html[data-theme] is seeded
   from the system appearance at startup and live-follows appearance changes
   UNTIL the operator clicks a segment — then the manual choice holds for this
   session. Never persisted (no prefs, no localStorage); every launch follows
   the system again. Purely presentational: only the data-theme attribute and
   the segments' own active state change. */
const themeLightBtn = document.getElementById('theme-light');
const themeDarkBtn = document.getElementById('theme-dark');
const themeMedia = window.matchMedia('(prefers-color-scheme: dark)');
let themeOverridden = false;   // manual click → stop following the system
function applyTheme(dark) {
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  if (themeLightBtn) {
    themeLightBtn.classList.toggle('active', !dark);
    themeLightBtn.setAttribute('aria-pressed', String(!dark));
  }
  if (themeDarkBtn) {
    themeDarkBtn.classList.toggle('active', dark);
    themeDarkBtn.setAttribute('aria-pressed', String(dark));
  }
}
applyTheme(themeMedia.matches);
themeMedia.addEventListener('change', (e) => { if (!themeOverridden) applyTheme(e.matches); });
if (themeLightBtn) themeLightBtn.addEventListener('click', () => { themeOverridden = true; applyTheme(false); });
if (themeDarkBtn) themeDarkBtn.addEventListener('click', () => { themeOverridden = true; applyTheme(true); });

/* Last-CONFIRMED sheet values per tier — session memory only (plain variable,
   never written to disk; relaunch returns to pure defaults). */
const sessionSheetMemory = {};

/* ARMED settings — the values the NEXT batch will freeze at enqueue (Pro
   Mode). Session-only. INVARIANT: in Pro Mode armed.tier ALWAYS equals the
   checked tier radio, however selection changed (card click + confirm,
   keyboard arrow on the radio group, post-enqueue reset, toggle flip-on).
   Sheet Confirm arms explicitly; every other selection path silently arms
   that tier's session-memory values (or defaults) — never auto-opens a
   sheet. */
let armed = { tier: 'regular', settings: null };

const X265_PRESETS = ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow'];

/* Tier-keyed control manifests — SLIDERS ONLY. The sheet edits exactly the
   fields that already exist in tierDefaults: regular → qv; preserve → crf +
   preset. The VT quality scale is 1–100 and is labeled "Quality" (it is NOT
   CRF). Slider positions are mapped to resolved values via toValue/toPos so
   RIGHT always means "better quality" (CRF runs inverted: right = LOWER crf)
   and the preset slider snaps to the nine valid x265 names. */
const SHEET_MANIFESTS = {
  regular: [
    /* max 85 (v2.2.8): the VT bitrate curve goes vertical past 85 — higher
       values can out-bit the source. Engine clamps at the arg builder too. */
    { key: 'qv', label: 'Quality', min: 1, max: 85,
      ends: ['Smaller file', 'Better quality'],
      toValue: (p) => p, toPos: (v) => v, fmt: (v) => String(v) }
  ],
  preserve: [
    { key: 'crf', label: 'CRF', min: 0, max: 51,
      ends: ['Smaller file', 'Better quality'],
      toValue: (p) => 51 - p, toPos: (v) => 51 - v, fmt: (v) => String(v) },
    { key: 'preset', label: 'Preset', min: 0, max: 8, ticks: true,
      ends: ['Faster encode', 'Smaller file, slower'],
      toValue: (p) => X265_PRESETS[p], toPos: (v) => Math.max(0, X265_PRESETS.indexOf(v)), fmt: (v) => String(v) }
  ]
};
const clampPos = (v, min, max, fallback) => {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

/* Resolve a tier's armed settings: defaults overlaid with the session's
   last-armed values for that tier (sessionSheetMemory, in-memory only). */
function resolveArmSettings(tier) {
  const defaults = (tierDefaultsCache && tierDefaultsCache[tier]) || {};
  return { ...defaults, ...(sessionSheetMemory[tier] || {}) };
}

/* Arm a tier and re-render the settings panel. With the persistent panel
   there is no confirm step: arming IS the live state, and Add batch is the
   commit point (enqueue-time freeze). The armed.tier === checked-tier
   invariant holds BY CONSTRUCTION: every selection path fires the radio
   change handler below, which arms the newly selected tier. */
function armTier(tier, settings) {
  armed = { tier, settings: settings || resolveArmSettings(tier) };
  renderProPanel();
  updateArmedChips();
}

/* SINGLE source of truth for "is the staged batch actionable" — has scanned
   video files AND an output location. The whole Nerd panel (empty prompt,
   slider rows, Modified badge, downconvert checkbox) gates on this ONE read so
   the empty-state and the armed-value display can never contradict on screen
   (the desync that let "Drop files…" coexist with a stale qv:85 + Modified).
   Equals the v2.2.8 file+location gate. */
function panelReady() {
  const hasSource = current.kind === 'files' ? current.fileSources.length > 0 : !!current.src;
  return hasSource && current.scanned && current.videoCount > 0 && !!current.dest;
}

/* "Modified" chip on the tier cards: visible on the armed tier's card, in Pro
   Mode only, when the armed settings differ from that tier's defaults — AND only
   once the batch is actionable (panelReady), so a persisted off-default value
   never shows Modified over an empty panel. Keyed by data-armed-chip. */
function updateArmedChips() {
  const ready = panelReady();
  document.querySelectorAll('.armed-chip').forEach((chip) => {
    const tier = chip.dataset.armedChip;
    const defaults = (tierDefaultsCache && tierDefaultsCache[tier]) || null;
    const show = proMode && ready && armed.tier === tier && !!armed.settings && !!defaults
      && JSON.stringify(armed.settings) !== JSON.stringify(defaults);
    chip.hidden = !show;
  });
}

/* ───── Pro Mode: persistent settings PANEL ─────
   Always visible in Pro Mode (body.pro-mode gates the CSS), directly below
   the tier cards. Shows the SELECTED tier's sliders; switching tier re-renders
   from that tier's session memory or defaults. Moving a slider arms the value
   LIVE (armed.settings + sessionSheetMemory) — no Confirm, no Cancel.
   Tier name chip comes from TIER_LABEL, the same constant the rest of the UI
   renders — never retyped. All lookups keyed (data-key / ids). */
const proPanelEl = document.getElementById('pro-panel');
const proPanelBody = document.getElementById('pro-panel-body');
const proPanelChip = document.getElementById('pro-panel-chip');
const proPanelReset = document.getElementById('pro-panel-reset');
const proPanelEmpty = document.getElementById('pro-panel-empty');
const proDownconvert = document.getElementById('pro-downconvert');
const proDownconvertInput = document.getElementById('pro-downconvert-input');

/* Mirror of pipeline.is10Bit — the renderer can't require the main-process
   module, so the regex is duplicated (kept in sync deliberately). Used ONLY to
   decide whether to SHOW the downconvert checkbox; the encoder re-probes each
   file and makes the real per-file decision. */
function is10BitPix(pixFmt) { return /10le|10be|p010|p210|p410/.test(pixFmt || ''); }
function batchHas10Bit() {
  return !!(current.files && current.files.some((f) => is10BitPix(f.pix_fmt)));
}
/* The "Downconvert 10-bit to 8-bit" checkbox shows ONLY in Nerd mode AND only
   when the staged batch actually contains a 10-bit file — never a dead control
   on an all-8-bit batch. Reflects the armed flag. On an 8-bit source the flag
   is a no-op in buildArgs, so a stale-armed value left hidden is harmless. */
function syncDownconvertUI() {
  if (!proDownconvert || !proDownconvertInput) return;
  // Same single `ready` gate as the rest of the panel: the checkbox only shows
  // once the batch is actionable AND it has a 10-bit file — never desyncs from
  // the empty-state, and never a dead control on an all-8-bit batch.
  proDownconvert.hidden = !(proMode && panelReady() && batchHas10Bit());
  proDownconvertInput.checked = !!(armed.settings && armed.settings.downconvert8);
}
/* Toggle → tier session memory + armed.settings (rides the same delta path as
   the sliders). Re-render keeps the modified-state / Reset affordance in sync. */
function onDownconvertToggle() {
  const tier = armed.tier;
  const next = { ...(sessionSheetMemory[tier] || {}) };
  if (proDownconvertInput.checked) next.downconvert8 = true; else delete next.downconvert8;
  sessionSheetMemory[tier] = next;
  armed = { tier, settings: resolveArmSettings(tier) };
  renderProPanel();      // refresh readouts + modified state; re-syncs the checkbox
  updateArmedChips();
}
if (proDownconvertInput) proDownconvertInput.addEventListener('change', onDownconvertToggle);

function renderProPanel() {
  if (!proPanelEl || !proPanelBody) return;
  const tier = armed.tier;
  const defaults = (tierDefaultsCache && tierDefaultsCache[tier]) || {};
  const manifest = SHEET_MANIFESTS[tier] || [];
  const values = armed.settings || defaults;

  proPanelEl.classList.remove('tier-regular', 'tier-preserve');
  proPanelEl.classList.add(`tier-${tier}`);
  if (proPanelChip) proPanelChip.textContent = TIER_LABEL[tier] || tier;

  proPanelBody.textContent = '';
  const inputs = new Map();   // key -> slider element (keyed, never positional)
  const readValue = (m) => m.toValue(clampPos(inputs.get(m.key).value, m.min, m.max, m.toPos(defaults[m.key])));
  const refresh = () => {
    for (const m of manifest) {
      const valEl = proPanelBody.querySelector(`.sheet-label .val[data-key="${m.key}"]`);
      if (valEl) {
        valEl.textContent = m.fmt(readValue(m));
        /* Readout cue: this chip alone signals ITS value's modified-ness —
           tier accent when off-default, neutral at default. */
        valEl.classList.toggle('mod', readValue(m) !== defaults[m.key]);
      }
    }
    /* downconvert8 (a non-slider boolean knob) also counts as "modified" so the
       Reset affordance appears when only the checkbox is changed. */
    const modified = manifest.some((m) => readValue(m) !== defaults[m.key])
      || !!(armed.settings && armed.settings.downconvert8);
    proPanelEl.classList.toggle('modified', modified);
  };
  /* LIVE arming: every slider move updates the armed settings AND the
     session memory for this tier (panel re-renders from memory on return).
     The tier-independent downconvert8 boolean is preserved across slider
     commits (it isn't in the manifest). */
  const commitLive = () => {
    const edited = {};
    for (const m of manifest) edited[m.key] = readValue(m);
    if (sessionSheetMemory[tier] && sessionSheetMemory[tier].downconvert8) edited.downconvert8 = true;
    sessionSheetMemory[tier] = { ...edited };
    armed = { tier, settings: { ...defaults, ...edited } };
    refresh();
    updateArmedChips();
  };

  for (const m of manifest) {
    const row = document.createElement('div');
    row.className = 'sheet-row';
    const label = document.createElement('div');
    label.className = 'sheet-label';
    /* Quiet raw value (number / preset name) — pros want it visible; the
       run-summary stamp references it. */
    label.innerHTML = `<span>${escapeHtml(m.label)}`
      + ` <span class="def-mark">(default ${escapeHtml(String(defaults[m.key]))})</span></span>`
      + `<span class="val" data-key="${m.key}"></span>`;
    row.appendChild(label);

    const input = document.createElement('input');
    input.type = 'range';              // sliders ONLY — stepped, snapping
    input.min = String(m.min); input.max = String(m.max); input.step = '1';
    input.value = String(clampPos(m.toPos(values[m.key]), m.min, m.max, m.toPos(defaults[m.key])));
    input.dataset.key = m.key;
    input.addEventListener('input', commitLive);
    input.addEventListener('change', commitLive);
    inputs.set(m.key, input);

    /* Default position visibly marked on the track. */
    const wrap = document.createElement('div');
    wrap.className = 'slider-wrap';
    /* Stepped sliders show their snap points as tick marks at rest. */
    if (m.ticks) {
      for (let pos = m.min; pos <= m.max; pos++) {
        const tick = document.createElement('span');
        tick.className = 'slider-tick';
        tick.style.left = `${((pos - m.min) / (m.max - m.min)) * 100}%`;
        wrap.appendChild(tick);
      }
    }
    const notch = document.createElement('span');
    notch.className = 'slider-notch';
    const defPct = ((m.toPos(defaults[m.key]) - m.min) / (m.max - m.min)) * 100;
    notch.style.left = `${defPct}%`;
    wrap.appendChild(notch);
    wrap.appendChild(input);
    row.appendChild(wrap);

    /* Semantic endpoints — right ALWAYS means better quality (or, for the
       preset axis, smaller/slower). */
    const ends = document.createElement('div');
    ends.className = 'slider-ends';
    ends.innerHTML = `<span>${escapeHtml(m.ends[0])}</span><span>${escapeHtml(m.ends[1])}</span>`;
    row.appendChild(ends);
    proPanelBody.appendChild(row);
  }
  refresh();
  updateProPanelDisabled();   // ONE pass: .disabled + empty copy + syncDownconvertUI
}

if (proPanelReset) proPanelReset.addEventListener('click', () => {
  /* One-click Reset: back to pure tier defaults — clears this tier's session
     memory so the defaults stick across tier switches too. */
  delete sessionSheetMemory[armed.tier];
  armTier(armed.tier);
});

/* Every tier selection path (card click, keyboard arrows, programmatic
   selection, post-enqueue reset) fires this change handler — arming the newly
   selected tier keeps armed.tier === checked tier by construction. Never
   opens anything: the panel is already on screen. */
tierInputs.forEach((inp) => {
  inp.addEventListener('change', () => {
    if (proMode) armTier(inp.value);
  });
});


/* ───── Non-blocking transient notice ─────
   A brief, auto-dismissing toast for informational failures (e.g. a file row
   whose original has moved). Deliberately NOT a modal: no backdrop, no focus
   trap, never blocks the operator. One notice at a time; a new message resets
   the dismissal timer. */
let noticeTimer = null;
function showNotice(text) {
  let el = document.getElementById('app-notice');
  if (!el) {
    el = document.createElement('div');
    el.id = 'app-notice';
    el.className = 'app-notice';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.classList.add('show');
  if (noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => el.classList.remove('show'), 3600);
}

// ----- Row action popover ---------------------------------------
let activeRowMenu = null;
/* The menu is a document.body child positioned once from the trigger's
   viewport rect; the real scroller is .app, so on scroll the trigger moves out
   from under the (unmoved) menu. Repositioning isn't wanted — dismiss instead,
   mirroring the click/Esc close below. Listener added on open, removed on close. */
const appScroller = document.querySelector('.app');
function closeRowMenu() {
  if (activeRowMenu) { activeRowMenu.remove(); activeRowMenu = null; }
  if (appScroller) appScroller.removeEventListener('scroll', closeRowMenu);
}
function openRowMenu(anchorEl, item) {
  closeRowMenu();
  const menu = document.createElement('div');
  menu.className = 'row-menu';
  menu.setAttribute('role', 'menu');

  function addAction(label, iconSvg, onClick, danger) {
    const btn = document.createElement('button');
    if (danger) btn.classList.add('danger');
    btn.setAttribute('role', 'menuitem');
    btn.innerHTML = `${iconSvg}<span>${label}</span>`;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeRowMenu();
      onClick();
    });
    menu.appendChild(btn);
  }

  if (item.status === 'running') {
    addAction(
      'Pause',
      '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>',
      () => window.api.pauseBatch(item.id)
    );
  } else if (item.status === 'paused') {
    addAction(
      'Resume',
      '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4v16l13-8L7 4Z"/></svg>',
      () => window.api.resumeBatch(item.id)
    );
  }
  const sep = document.createElement('div');
  sep.className = 'sep';
  menu.appendChild(sep);
  addAction(
    'Stop',
    '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="1.5"/></svg>',
    () => window.api.cancelBatch(item.id),
    true
  );

  document.body.appendChild(menu);
  // Position below the anchor, right-aligned to it
  const rect = anchorEl.getBoundingClientRect();
  const menuW = menu.offsetWidth;
  let left = rect.right - menuW;
  if (left < 8) left = 8;
  let top = rect.bottom + 6;
  // Flip up if it would overflow window
  const menuH = menu.offsetHeight;
  if (top + menuH > window.innerHeight - 8) {
    top = rect.top - menuH - 6;
  }
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;

  activeRowMenu = menu;
  // Close on .app scroll: the fixed one-time position goes stale otherwise.
  if (appScroller) appScroller.addEventListener('scroll', closeRowMenu);
}
document.addEventListener('click', (e) => {
  if (activeRowMenu && !activeRowMenu.contains(e.target)) closeRowMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeRowMenu();
});

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

/* Honest "~Xm left" formatter — rounds upward to avoid false-precise
   countdowns: sub-minute snaps to 10-second buckets, sub-hour to whole
   minutes, then 5-minute buckets in hours. */
function fmtEta(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const s = Math.ceil(ms / 1000);
  if (s < 60) return `~${Math.max(10, Math.ceil(s / 10) * 10)}s left`;
  const m = Math.ceil(s / 60);
  if (m < 60) return `~${m}m left`;
  const h = Math.floor(m / 60);
  const rm = Math.ceil((m % 60) / 5) * 5;
  return rm === 0 ? `~${h}h left` : `~${h}h ${rm}m left`;
}

/* ETA card is shown only when there's a real estimate; hidden state lets
   the stats grid collapse from 5 cards to 4 cleanly. */
function showEta(text) {
  if (!currentEtaEl || !statEta) return;
  currentEtaEl.textContent = text;
  statEta.classList.remove('hidden');
}
function hideEta() {
  if (!currentEtaEl || !statEta) return;
  currentEtaEl.textContent = '—';
  statEta.classList.add('hidden');
}


/* Item 2: end-of-run tally, built from queue file state. Every file lands
   in exactly one bucket. "skipped" folds operator-skips and already-present
   outputs; "cancelled" only appears if the operator stopped a file in
   flight. done is the lone green (success); failed red; rest neutral. */
function summaryCountsHtml() {
  let done = 0, failed = 0, skipped = 0, cancelled = 0;
  for (const b of queue) {
    for (const f of b.files) {
      if (f.status === 'done') done++;
      else if (f.status === 'failed') failed++;
      else if (f.status === 'skipped' || f.status === 'existed') skipped++;
      else if (f.status === 'cancelled') cancelled++;
    }
  }
  const seg = (n, label, cls) =>
    `<span class="seg ${n > 0 ? cls : 'c-zero'}"><span class="num">${n}</span>`
    + `<span class="lbl">${label}</span></span>`;
  let html = seg(done, 'done', 'c-done')
    + `<span class="vsep">·</span>` + seg(failed, 'failed', 'c-failed')
    + `<span class="vsep">·</span>` + seg(skipped, 'skipped', 'c-skip');
  if (cancelled > 0) {
    html += `<span class="vsep">·</span>` + seg(cancelled, 'cancelled', 'c-skip');
  }
  return `<div class="summary-counts">${html}</div>`;
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

/* Two-step staging: Add becomes enabled once we have a scanned source with
   at least one video AND a destination. Source = folder path (folder kind)
   OR a non-empty fileSources list (files kind). */
function updateAddState() {
  if (!addBtn) return;
  const hasSource = current.kind === 'files'
    ? current.fileSources.length > 0
    : !!current.src;
  const ready = hasSource && current.scanned && current.videoCount > 0 && current.dest;
  addBtn.disabled = !ready;
  updateFlowState();
  updateProPanelDisabled();
}

/* Pro panel gating: disabled (dimmed, sliders inert, Reset hidden, one quiet
   prompt line) until the batch is ACTIONABLE — staged video files AND an output
   location. Matches the "Add batch" / tierReachable condition so settings are
   never live before the batch can exist (the panel is a DOM sibling after the
   tier cards, so the tier step's `inert` lock can't cover it). VISUAL +
   INTERACTION ONLY — armed values and session memory persist; tier switching
   still re-renders the displayed tier while disabled. Mode-agnostic: a batch
   needs file+location in both Simple and Pro Mode, so this never wrongly locks
   Pro Mode. */
function updateProPanelDisabled() {
  if (!proPanelEl) return;
  const hasSource = current.kind === 'files'
    ? current.fileSources.length > 0
    : !!current.src;
  const hasFiles = hasSource && current.scanned && current.videoCount > 0;
  const ready = hasFiles && !!current.dest;
  proPanelEl.classList.toggle('disabled', !ready);
  // Gate every panel input — the sliders AND the downconvert checkbox. (The tier
  // radios live outside the panel, so this only touches panel controls.)
  proPanelEl.querySelectorAll('input').forEach((i) => { i.disabled = !ready; });
  /* Disabled-state prompt names what's actually missing: files first, then the
     location once files are staged. */
  if (proPanelEmpty) {
    proPanelEmpty.textContent = !hasFiles
      ? 'Drop files to configure this batch'
      : 'Pick an output location to configure this batch';
  }
  // Staging changed → the batch's 10-bit-ness may have changed → re-evaluate the
  // downconvert checkbox visibility.
  syncDownconvertUI();
}

/* ───── Guided progressive-disclosure flow (hard-gated) ─────
   Computes the single REQUIRED next action and the reachable state of each
   step, then paints:
     • .step-dim + `inert` on steps not yet reached — they read as "coming
       next" but are genuinely non-interactive. The sequence is ENFORCED
       (drop → Output → tier → Add → Start); no skipping ahead, no expert
       exception. The drop zone never locks (always the way back to start).
     • .next-action (orange "act here" cue + pulse) on EXACTLY ONE control.
   Orange means ONLY "your next action, act here" — nowhere else.
   Priority of the single cue:
     compose a batch (Select location → Add) outranks Start; once staging is
     empty and a batch is queued, Start becomes the cue. */
function updateFlowState() {
  const staging  = !!(current.scanned && current.videoCount > 0);
  const hasDest  = !!current.dest;
  const runnable = queue.some(
    (q) => q.status === 'queued' && q.files.some((f) => f.status !== 'skipped')
  );
  const startVisible = startBtn && !startBtn.classList.contains('hidden') && !runActive;

  // The one orange cue.
  let next = null; // 'location' | 'add' | 'start'
  if (staging && !hasDest)      next = 'location';
  else if (staging && hasDest)  next = 'add';
  else if (!staging && runnable && startVisible) next = 'start';

  // Reachability → dim + HARD LOCK. Output + safety bar are the "config" step
  // (unlock once files are detected); tier unlocks once a location is chosen.
  // A locked step is dimmed (.step-dim) AND non-interactive (`inert` — no
  // pointer, no keyboard focus, out of the a11y tree). The sequence is enforced:
  // no skipping ahead. The drop zone is never locked. Add and Start lock via
  // their own :disabled state.
  const outputReachable = staging;
  const tierReachable   = staging && hasDest;
  const lockStep = (el, reachable) => {
    if (!el) return;
    el.classList.toggle('step-dim', !reachable);
    el.toggleAttribute('inert', !reachable);
  };
  lockStep(outputRow, outputReachable);
  lockStep(safetyBar, outputReachable);
  lockStep(tierHead,  tierReachable);
  lockStep(tiersEl,   tierReachable);

  // Exactly one orange cue.
  if (chooseDestBtn) chooseDestBtn.classList.toggle('next-action', next === 'location');
  if (addBtn)        addBtn.classList.toggle('next-action', next === 'add');
  if (startBtn)      startBtn.classList.toggle('next-action', next === 'start');

  // Output control label: required "Select location" until a location exists,
  // then the resting "Change" (no ellipsis, ever).
  if (chooseDestBtn) chooseDestBtn.textContent = hasDest ? 'Change' : 'Select location';
}

function resetStagingTier() {
  /* Per spec: tier resets to the RECOMMENDED default ("Make It Fast") after
     each Add — so each new batch starts from the safe default. */
  const reg = document.querySelector('input[name="tier"][value="regular"]');
  if (!reg) return;
  reg.checked = true;
  document.querySelectorAll('.tier').forEach((t) => t.classList.remove('selected'));
  const wrap = reg.closest('.tier');
  if (wrap) wrap.classList.add('selected');
  /* Pro Mode: the reset re-arms the recommended tier's session-memory values
     (or defaults) SILENTLY — sheets open only on explicit card clicks. */
  if (proMode) armTier('regular');
}

function updateTierHint() {
  /* Tier is OPTIONAL — "Make It Fast" is already selected by default. Once the
     tier step is live (files staged), say so softly so the zero-thinking
     default isn't contradicted and no tier action is forced. */
  if (current.scanned && current.videoCount > 0) {
    tierHintEl.textContent = 'Recommended already selected — change only if you want';
  } else {
    tierHintEl.textContent = 'Applies to all files in this batch';
  }
}

function clearDrop({ resetTier = true } = {}) {
  const stickyDest = current.dest;
  current = {
    src: null, srcName: null,
    kind: 'folder', fileSources: [],
    videoCount: 0, ignoredCount: 0, totalSize: 0,
    scanned: false,
    dest: stickyDest,
    files: []
  };
  if (!stickyDest) {
    destPathEl.textContent = DEST_PLACEHOLDER;
    destPathEl.classList.add('placeholder');
  }
  flipDropzoneHeight(() => {
    clearDropStatus();
    dropzone.classList.remove('has-source');
  });
  if (resetTier) resetStagingTier();
  updateAddState();
  updateTierHint();
  updateIdleCopy();
}

/* P7: dz-title copy reflects the screen's coherent state.
   Fresh: "Drop a folder or files to begin". After a completed run:
   "Drop another folder or files". */
function updateIdleCopy() {
  if (!dzTitle) return;
  /* Reskin (mockup v3e): the fresh-state headline is the mockup's two-line
     hero. The after-run copy keeps its established wording (mockup doesn't
     show that state). Purely presentational — same element, same states. */
  dzTitle.innerHTML = hasCompletedRun
    ? 'Drop <em>another folder or files</em>'
    : 'Drop footage.<br><em>Squeeze the file size.</em>';
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
  const items = Array.from(ev.dataTransfer.files || []);
  if (!items.length) return;
  const paths = items.map((it) => window.api.pathForFile(it)).filter(Boolean);
  if (!paths.length) {
    dropStatusPath.textContent = 'Could not read dropped path. Try again.';
    dropStatusPath.style.color = 'var(--red)';
    dropStatus.classList.remove('hidden');
    return;
  }
  /* Routing rule:
       - Exactly one path AND it's a directory → existing folder workflow
         (untouched: scanSource → scanFolder).
       - Anything else (1 file, multiple files, multiple folders, mix) →
         file-list branch (scan-files), which keeps folder behavior
         entirely off this path. */
  if (paths.length === 1) {
    const stat = await window.api.statPath(paths[0]);
    if (stat && stat.isDirectory) {
      await stageSource(paths[0]);
      return;
    }
  }
  await stageFiles(paths);
  /* Two-step staging: do NOT auto-add. Operator confirms tier + clicks Add. */
});

chooseDestBtn.addEventListener('click', async () => {
  /* Dest can be picked at any time (before or after drop) — sticky across
     drops. Default anchor: folder src parent → first picked file's parent
     → current dest (returning user). */
  let parent = null;
  if (current.src) parent = current.src.replace(/\/[^/]*$/, '');
  else if (current.fileSources && current.fileSources.length > 0)
    parent = current.fileSources[0].replace(/\/[^/]*$/, '');
  else parent = current.dest || null;
  const chosen = await window.api.chooseDestination(parent);
  if (chosen) {
    current.dest = chosen;
    destPathEl.textContent = chosen;
    destPathEl.classList.remove('placeholder');
    updateAddState();
  }
});

/* Drop-zone icon (and the small "click to browse" text) opens the native
   FILE picker (multi-select). macOS can't pick folders + files in the same
   dialog, so the browse button is files-only; folders still arrive via
   drag-drop. defaultPath cascades through the persisted lastSrc → output
   parent → ~ in the main process. */
async function browseAndStage() {
  const suggested = current.dest || null;
  const chosen = await window.api.browseSourceFiles(suggested);
  if (!chosen || !chosen.length) return;
  await stageFiles(chosen);
}
if (dzBrowseBtn) dzBrowseBtn.addEventListener('click', browseAndStage);
if (dzBrowseTextBtn) dzBrowseTextBtn.addEventListener('click', browseAndStage);

/* Clear the staged file without an Add-then-remove round-trip. Uses the SAME
   reset Add runs post-commit (clearDrop with resetTier) — discards the staged
   file + tier/settings, KEEPS the sticky dest, and never touches the queue or
   any active run. stopPropagation so the click never reaches the dropzone. */
if (dropClearBtn) dropClearBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  clearDrop({ resetTier: true });
});

/* Display name for a file-list batch shown in the dropzone + queue header.
   Single file: just its basename. Many: "first.mov + N more". */
function fileListDisplayName(paths) {
  if (!paths.length) return 'Selected files';
  const first = paths[0].split('/').pop();
  if (paths.length === 1) return first;
  return `${first} + ${paths.length - 1} more`;
}

/* Item 3: a scan failure in plain words, with the raw technical text tucked
   behind a "Details" disclosure (collapsed by default). The main UI never
   shows codes or stack text on its face. */
function showScanError(raw) {
  dropStatus.classList.remove('hidden');
  dropStatusPath.textContent = 'Couldn’t read that — the file may be damaged or in a format Squeeze can’t open.';
  dropStatusPath.style.color = 'var(--red)';
  dropStatusCount.textContent = '';
  dropStatusExtra.innerHTML = raw
    ? `<details class="dz-error-details"><summary>Details</summary><div class="raw">${escapeHtml(raw)}</div></details>`
    : '';
}

/* Shared scan/stage path used by both drag-drop and browse — FOLDER kind.
   Unchanged from the validated folder workflow. */
/* B.3 (1)+(2): the dropzone swaps its tall prompt (.dz-inner) for the compact loaded row
   (#drop-status) and back; that one-frame resize lurched the whole page (drop, and again on
   Add via clearDrop). FLIP it: snapshot the height, apply the swap, measure the new natural
   height, then transition height old->new so the content below GLIDES. Reduced-motion →
   apply instantly. Inline style is CSP-clean (style-src 'unsafe-inline'); .dropzone
   overflow:hidden clips during the tween. Pairs with `#drop-status.hidden{transition:none}`
   so the post-mutate measurement isn't polluted by drop-status' lingering fade-out. */
let _dzFlipCleanup = null;
function flipDropzoneHeight(mutate) {
  /* Always fully reset any in-flight flip FIRST (timer + listeners + inline geometry), so a
     new flip — or the reduced-motion path below — can never stack on or strand a prior one. */
  if (_dzFlipCleanup) _dzFlipCleanup();
  if (!_motionOK()) {
    mutate();
    // No tween under reduced motion: guarantee nothing inline is stranded from a mid-flight flip.
    dropzone.style.height = ''; dropzone.style.transition = ''; dropzone.style.overflow = '';
    return;
  }
  const h0 = dropzone.getBoundingClientRect().height;
  mutate();
  /* B.5: measure the target with transitions OFF so .dropzone's stylesheet `padding .2s`
     (has-source changes padding 28->22px) is SNAPPED to its final value first. Otherwise h1
     is read mid-padding-tween (old 28px) → tween lands 12px too tall → a one-frame pop when
     transitionend clears the inline height. transition:none makes h1 == true natural auto. */
  dropzone.style.transition = 'none';
  dropzone.style.height = 'auto';
  const h1 = dropzone.getBoundingClientRect().height;
  if (Math.abs(h1 - h0) < 1) { dropzone.style.height = ''; dropzone.style.transition = ''; return; }
  dropzone.style.height = h0 + 'px';
  void dropzone.offsetHeight;                        // commit the start height (still transition:none)
  dropzone.style.transition = 'height .3s var(--ease-out-quint)';   // quint: decelerates and LANDS, no end-crawl
  dropzone.style.height = h1 + 'px';

  /* Cleanup is IDEMPOTENT (done-guard) and reachable from THREE racers — whichever lands
     first wins, the rest no-op: (a) transitionend on success, (b) transitioncancel if the
     tween is interrupted, (c) a 360ms timeout fallback in case the event never arrives at
     all (the backdrop-filter compositor stall that left the dropzone stuck-collapsed). */
  let done = false, timer = null;
  const onEvent = (e) => { if (e.target === dropzone && e.propertyName === 'height') cleanup(); };
  const cleanup = () => {
    if (done) return;
    done = true;
    if (timer) { clearTimeout(timer); timer = null; }
    dropzone.removeEventListener('transitionend', onEvent);
    dropzone.removeEventListener('transitioncancel', onEvent);
    dropzone.style.height = ''; dropzone.style.transition = ''; dropzone.style.overflow = '';
    if (_dzFlipCleanup === cleanup) _dzFlipCleanup = null;
  };
  _dzFlipCleanup = cleanup;
  dropzone.addEventListener('transitionend', onEvent);
  dropzone.addEventListener('transitioncancel', onEvent);
  timer = setTimeout(cleanup, 360);                  // .30s tween + margin
}

async function stageSource(p) {
  current.src = p;
  current.srcName = p.split('/').pop();
  current.kind = 'folder';
  current.fileSources = [];
  current.scanned = false;
  current.files = [];
  dropStatusPath.textContent = p;
  dropStatusPath.style.color = 'var(--cyan)';
  dropStatusCount.textContent = 'scanning…';
  dropStatusExtra.textContent = '';
  /* Swap to the loaded row NOW (not at scan end) so the dropzone makes ONE clean
     glide instead of grow-while-scanning then collapse. */
  flipDropzoneHeight(() => {
    dropStatus.classList.remove('hidden');
    dropzone.classList.add('has-source');
  });
  updateAddState();
  /* Staging identity captured BEFORE the await. clearDrop reassigns `current` to
     a NEW object on Add; if that happens while this scan is in flight, the late
     result must NOT mutate the reset `current` or re-enable a reset panel. */
  const token = current;
  try {
    const scan = await window.api.scanSource(p);
    if (current !== token) return;   // reassigned mid-scan → drop this stale result
    current.videoCount = scan.videos.length;
    current.ignoredCount = scan.ignored;
    current.totalSize = scan.totalSize || scan.videos.reduce((a, v) => a + (v.size || 0), 0);
    current.files = scan.videos.map((v) => ({
      path: v.file, name: v.file.split('/').pop(), size: v.size || 0, pix_fmt: v.pix_fmt
    }));
    current.scanned = true;
    dropStatusPath.textContent = p;
    dropStatusPath.style.color = '';
    dropStatusCount.textContent = `${scan.videos.length} video${scan.videos.length === 1 ? '' : 's'}`;
    const parts = [];
    if (current.totalSize > 0) parts.push(`${humanBytes(current.totalSize)} total`);
    if (scan.ignored > 0) parts.push(`${scan.ignored} ignored`);
    dropStatusExtra.textContent = parts.join(' · ') || '—';
    window.api.saveLastSrc(p);
  } catch (e) {
    if (current !== token) return;
    showScanError(e && e.message);
    current.scanned = false;
    flipDropzoneHeight(() => dropzone.classList.remove('has-source'));   // restore prompt
  }
  updateAddState();
  updateTierHint();
}

/* Separate scan/stage branch for FILES kind (multi-select picker, or a
   drag-drop carrying loose files). No folder rescan happens — pipeline.js
   sees these via a temp symlink dir at run time. */
async function stageFiles(paths) {
  current.src = null;
  current.kind = 'files';
  current.fileSources = paths.slice();
  current.srcName = fileListDisplayName(paths);
  current.scanned = false;
  current.files = [];
  dropStatusPath.textContent = current.srcName;
  dropStatusPath.style.color = 'var(--cyan)';
  dropStatusCount.textContent = 'scanning…';
  dropStatusExtra.textContent = '';
  flipDropzoneHeight(() => {
    dropStatus.classList.remove('hidden');
    dropzone.classList.add('has-source');
  });
  updateAddState();
  /* See stageSource: bail if `current` was reassigned (Add reset) during the await. */
  const token = current;
  try {
    const scan = await window.api.scanFiles(paths);
    if (current !== token) return;   // reassigned mid-scan → drop this stale result
    current.videoCount = scan.videos.length;
    current.ignoredCount = scan.ignored;
    current.totalSize = scan.totalSize || scan.videos.reduce((a, v) => a + (v.size || 0), 0);
    current.files = scan.videos.map((v) => ({
      path: v.file, name: v.file.split('/').pop(), size: v.size || 0, pix_fmt: v.pix_fmt
    }));
    /* Restrict fileSources to those that probed as real videos so the
       symlink stage on the main side doesn't waste links on non-videos. */
    const videoPaths = new Set(scan.videos.map((v) => v.file));
    current.fileSources = paths.filter((p) => videoPaths.has(p));
    current.scanned = true;
    dropStatusPath.textContent = current.srcName;
    dropStatusPath.style.color = '';
    dropStatusCount.textContent = `${scan.videos.length} video${scan.videos.length === 1 ? '' : 's'}`;
    const parts = [];
    if (current.totalSize > 0) parts.push(`${humanBytes(current.totalSize)} total`);
    if (scan.ignored > 0) parts.push(`${scan.ignored} ignored`);
    dropStatusExtra.textContent = parts.join(' · ') || '—';
    if (paths[0]) window.api.saveLastSrc(paths[0]);
  } catch (e) {
    if (current !== token) return;
    showScanError(e && e.message);
    current.scanned = false;
    flipDropzoneHeight(() => dropzone.classList.remove('has-source'));   // restore prompt
  }
  updateAddState();
  updateTierHint();
}

// Tier selection — keep the underlying radio working
tierInputs.forEach((inp) => {
  inp.addEventListener('change', () => {
    const prevSel = document.querySelector('.tier.selected');
    document.querySelectorAll('.tier').forEach((t) => t.classList.remove('selected'));
    const wrap = inp.closest('.tier');
    if (wrap) wrap.classList.add('selected');
    /* Pattern 2: select-and-settle on the chosen card; the deselected card
       exhales. WAAPI one-shot, reduced-motion gated. */
    if (_motionOK()) {
      const d = _durBase(), e = _easeSettle();
      if (wrap) wrap.animate(
        [{ transform: 'scale(.97)' }, { transform: 'scale(1.012)' }, { transform: 'scale(1)' }],
        { duration: d, easing: e }
      );
      if (prevSel && prevSel !== wrap) prevSel.animate(
        [{ transform: 'scale(1)' }, { transform: 'scale(.98)' }, { transform: 'scale(1)' }],
        { duration: d, easing: e }
      );
    }
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

// P2 Preview/Writes toggle — updates the safety bar mode + label + sub copy.
dryRunBtn.addEventListener('click', () => {
  const on = dryRunBtn.getAttribute('aria-pressed') === 'true';
  const next = !on;
  dryRunBtn.setAttribute('aria-pressed', next ? 'true' : 'false');
  safetyBar.setAttribute('data-mode', next ? 'preview' : 'write');
  safetyModeEl.textContent = next ? 'Preview only' : 'Writes files';
  safetySubEl.textContent = next
    ? 'No files will be written — videos are scanned and totals reported only'
    : 'Encoded videos will be saved to the output folder';
  // Make the toggle's own on/off state explicit (text paired with the switch
  // position, never colour alone) so the active mode is unmistakable.
  if (dryStateEl) dryStateEl.textContent = next ? 'On' : 'Off';
});

/* Pro Mode foundation: per-tier encode defaults, fetched once from main at
   startup (single source of truth: pipeline.js tierDefaults). Today, with no
   Pro Mode UI, a batch's settings are ALWAYS its tier's defaults. If the
   cache hasn't loaded yet (or the channel is absent in a test harness) the
   payload carries no settings and the engine resolves the same defaults
   itself — identical args either way. */
let tierDefaultsCache = null;
window.api.getTierDefaults?.().then((d) => {
  tierDefaultsCache = d;
  /* If Pro Mode was flipped on before this resolved, the panel rendered
     against an empty defaults object — re-arm so it shows real values. */
  if (proMode) armTier(armed.tier);
}).catch(() => {});

/* The minimal batch shape main needs to RUN a batch — used by BOTH the Start
   payload and a mid-run enqueue, so the two paths can never drift. Display-only
   fields (srcName, rename label) are deliberately omitted: they cannot affect
   output paths or staging dirs. */
function batchToPayload(b) {
  return {
    id: b.id, src: b.src, dest: b.dest, tier: b.tier, dryRun: b.dryRun,
    kind: b.kind,
    /* Fully-resolved encode settings — FROZEN on the batch at enqueue time
       (Pro sheet result, or tier defaults in Simple mode). The payload-time
       cache read is only the fallback for batches created before the boot
       fetch resolved. Queue and engine carry this field blindly; the arg
       builder reads ONLY this for encode parameters. */
    settings: b.settings || (tierDefaultsCache && tierDefaultsCache[b.tier]) || undefined,
    fileSources: b.kind === 'files' ? (b.fileSources || []) : [],
    skipped: b.files.filter((f) => f.status === 'skipped').map((f) => f.path)
  };
}

/* Commit the staging area as a new batch. Tier is FROZEN at this moment.
   Subsequent tier changes affect only the next batch (or the editable
   batches on the queue header). */
function addCurrentToQueue() {
  if (addBtn.disabled) return;
  const tier = document.querySelector('input[name="tier"]:checked').value;
  const dry = dryRunBtn.getAttribute('aria-pressed') === 'true';

  /* Settings are FROZEN here, at enqueue time, for EVERY batch — Simple mode
     freezes the tier defaults; Pro Mode freezes the ARMED settings (confirmed
     on the tier card's sheet, or silently armed defaults/session memory).
     A later mode flip or sheet edit can never touch an already-queued batch.
     No sheet opens here — the sheet trigger is the tier card click. */
  const settings = (proMode && armed.tier === tier && armed.settings)
    ? armed.settings
    : ((tierDefaultsCache && tierDefaultsCache[tier]) || undefined);

  const batch = {
    id: nextId++,
    src: current.src,
    srcName: current.srcName,
    kind: current.kind,                       // 'folder' | 'files' — frozen
    fileSources: current.fileSources.slice(), // frozen for 'files' kind
    dest: current.dest,
    tier,                   // frozen
    settings,               // frozen — resolved at enqueue time (see above)
    dryRun: dry,
    videoCount: current.videoCount,
    totalSize: current.totalSize || 0,
    files: current.files.map((f) => ({
      path: f.path,
      name: f.name,
      size: f.size,
      status: 'queued',     // queued | running | done | failed | skipped
      outputSize: null
    })),
    status: 'queued',       // batch-level
    progress: 0,
    processed: 0,
    failed: 0,
    skipped: 0,
    reclaimed: 0,
    lastResult: null
  };
  queue.push(batch);
  /* OPTION A: if a run is LIVE, fold this batch into it so the queue keeps
     draining with NO second Start press. main absorbs it into the array its loop
     is iterating; if the run has already ended it reports absorbed:false and the
     batch simply waits Queued for the next Start (a fresh run, its own summary). */
  if (runActive) {
    try { window.api.enqueueBatch(batchToPayload(batch)); } catch { /* runs on next Start */ }
  }
  /* A: a fresh queued batch means there is runnable work again. If the
     "Run complete" panel is up from a previous run, retire it and bring
     back the Start action bar. */
  if (summaryCard && !summaryCard.classList.contains('hidden')) {
    summaryCard.classList.add('hidden');
    document.querySelector('.actions').classList.remove('hidden');
  }
  renderQueue();
  clearDrop({ resetTier: true });   // tier returns to RECOMMENDED for next batch
}
if (addBtn) addBtn.addEventListener('click', addCurrentToQueue);

/* ───── Batch group builder ─────
   Each top-level <li class="qbatch"> contains:
     - a header with: name + meta + tier control + status pill + remove
     - an inner <ul class="qbatch-files"> with one <li class="qrow"> per file
   Locking rule: tier toggle + Remove are interactive only while the batch
   is in 'queued' state. Once it starts running or finishes (done/failed/
   cancelled), edit controls hide. */

const PILL_LABEL = {
  queued: 'Queued', running: 'Running', paused: 'Paused',
  done: 'Done', failed: 'Failed', cancelled: 'Cancelled', cancelling: 'Cancelling…',
  skipped: 'Skipped',    // operator-skipped via the ✕ on the row
  existed: 'Existing'    // pipeline resumability: output already present
};

/* Inline batch rename. Replaces the name node with a text field; Enter or
   blur commits (whitespace trimmed; empty/whitespace-only rejected → previous
   name kept), Esc cancels. While editing, renderQueue() is suppressed so a
   mid-run progress repaint can't clobber the input; endRename repaints once. */
function beginRenameBatch(batch, nameEl) {
  if (editingBatchId != null) return;     // one rename at a time
  editingBatchId = batch.id;
  const prev = batch.srcName;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'qbatch-name-edit';
  input.value = prev;
  input.setAttribute('aria-label', 'Batch name');
  let settled = false;
  const finish = (commit) => {
    if (settled) return;
    settled = true;
    if (commit) {
      const trimmed = input.value.trim();
      if (trimmed) batch.srcName = trimmed;   // reject empty/whitespace → keep prev
    }
    editingBatchId = null;
    renderQueue();                            // single fresh repaint
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();                      // don't trip global Esc handlers
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
  nameEl.replaceWith(input);
  input.focus();
  input.select();
}

function buildBatchGroup(batch, idx) {
  const li = document.createElement('li');
  /* Tier modifier on the ROOT (mirrors the .tierchip below) so the file tray
     can hang off a tier-colored spine (--spine). qbatch--regular / --archival. */
  const cls = TIER_CSS[batch.tier] || 'regular';
  li.className = `qbatch qbatch--${cls} status-${batch.status}`;
  li.dataset.id = batch.id;
  li.draggable = batch.status === 'queued';

  /* Pattern 7/8: animate enter + stagger rows only the FIRST time this batch.id
     is rendered (renderQueue rebuilds wholesale; the Set prevents replay). */
  const isNewBatch = !_enteredBatches.has(batch.id);
  if (isNewBatch) { _enteredBatches.add(batch.id); li.classList.add('batch-enter'); }

  // ─── Header ───
  const head = document.createElement('div');
  head.className = 'qbatch-head';

  // Batch index + name + meta
  const info = document.createElement('div');
  info.className = 'qbatch-info';
  const seq = document.createElement('div');
  seq.className = 'qbatch-seq';
  seq.textContent = String(idx + 1).padStart(2, '0');
  info.appendChild(seq);
  const text = document.createElement('div');
  text.className = 'qbatch-text';
  const name = document.createElement('div');
  name.className = 'qbatch-name';
  name.textContent = batch.srcName + (batch.dryRun ? '  (preview)' : '');
  /* Double-click the BATCH name → inline rename. Purely cosmetic: srcName is a
     display label only — it is NOT sent to main (the start-queue payload omits
     it) and never feeds an on-disk path (output is dest/Compressed_<ts>/;
     staging dirs are id-based: "Selected files (<id>)"). So renaming — even a
     running batch — is label-only and cannot alter output paths, staging dirs,
     or encode behavior. In-session only (no persistence; run history deferred). */
  name.title = 'Double-click to rename';
  name.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    beginRenameBatch(batch, name);
  });
  const meta = document.createElement('div');
  meta.className = 'qbatch-meta';
  const sizeStr = batch.totalSize > 0 ? ` · ${humanBytes(batch.totalSize)}` : '';
  meta.textContent = `${batch.videoCount} file${batch.videoCount === 1 ? '' : 's'}${sizeStr}`;
  text.appendChild(name);
  text.appendChild(meta);
  info.appendChild(text);
  head.appendChild(info);

  /* Fix 3: tier is frozen at Add. The header shows a single locked accent
     chip — no toggle. To "edit" a batch's tier the operator removes it
     and re-adds with the desired tier selected in staging. */
  const tierCtl = document.createElement('div');
  tierCtl.className = 'qbatch-tier';
  const chip = document.createElement('span');
  chip.className = `tierchip ${cls}`;
  chip.innerHTML = `<span class="dot"></span>${TIER_LABEL[batch.tier] || batch.tier}`;
  tierCtl.appendChild(chip);
  head.appendChild(tierCtl);

  // Status pill + progress bar (batch-level)
  const statusWrap = document.createElement('div');
  statusWrap.className = `qbatch-status status ${batch.status}`;
  const pill = document.createElement('span');
  pill.className = 'pill';
  pill.innerHTML = `<span class="dot"></span>${PILL_LABEL[batch.status] || batch.status}`;
  const pbar = document.createElement('div');
  pbar.className = 'progressbar';
  const pbi = document.createElement('i');
  let pct;
  if (batch.status === 'done') pct = 100;
  else if (batch.status === 'failed' || batch.status === 'cancelled') pct = Math.max(8, batch.progress);
  else pct = batch.progress;
  pbi.style.width = `${pct}%`;
  pbar.appendChild(pbi);
  statusWrap.appendChild(pill);
  statusWrap.appendChild(pbar);
  head.appendChild(statusWrap);

  /* Actions — Remove ✕ for removable batches (queued OR completed: done /
     failed / cancelled), the ⋯ menu while running/paused, else empty.
     Removing a completed batch ONLY clears it from this queue view: it
     filters the in-memory list and re-renders. No file is touched (outputs
     and originals stay on disk) and lifetime-reclaimed totals — already
     persisted to prefs when the batch finished — are unaffected. */
  const REMOVABLE = new Set(['queued', 'done', 'failed', 'cancelled']);
  const actionsCell = document.createElement('div');
  actionsCell.className = 'qbatch-actions';
  if (REMOVABLE.has(batch.status)) {
    const rm = document.createElement('button');
    rm.className = 'qbatch-remove qbatch-remove--x';
    rm.title = batch.status === 'queued' ? 'Remove batch' : 'Remove from list';
    rm.setAttribute('aria-label', rm.title);
    rm.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px;"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    rm.addEventListener('click', (e) => {
      e.stopPropagation();
      // View-only removal — never deletes outputs/originals, never re-credits
      // or decrements lifetime stats.
      /* PHANTOM FREEZE: a QUEUED batch must also be tombstoned main-side —
         during a live run it still sits in liveBatches, and without this the
         engine encodes it invisibly (no row, Start hidden → looks frozen).
         Fire-and-forget, like enqueueBatch; harmless with no run live (Start
         rebuilds its payload from this queue array). Completed statuses
         (done/failed/cancelled) stay view-only. */
      if (batch.status === 'queued') window.api.removeBatch(batch.id);
      queue = queue.filter((x) => x.id !== batch.id);
      renderQueue();
    });
    actionsCell.appendChild(rm);
  } else if (batch.status === 'running' || batch.status === 'paused') {
    const more = document.createElement('button');
    more.className = 'qbatch-remove';
    more.title = 'Actions';
    more.setAttribute('aria-label', more.title);
    more.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" style="width:14px;height:14px;"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>';
    more.addEventListener('click', (e) => {
      e.stopPropagation();
      openRowMenu(more, batch);
    });
    actionsCell.appendChild(more);
  }
  head.appendChild(actionsCell);

  li.appendChild(head);

  // ─── File tray (recessed, spined) ───
  const filesUl = document.createElement('ul');
  filesUl.className = 'qbatch-files';

  /* Quiet column-label strip INSIDE this batch's tray, above its rows (v2.2.3).
     Sits on the tray fill (transparent over --bg-1), inside the spine, indented
     to the file-row origin with the SAME grid — so it reads as a sub-label of
     the tray, not a stacked table head. No hard borders: the tray's own top
     hairline is the only divider. */
  const filesHead = document.createElement('li');
  filesHead.className = 'qfile-head';
  filesHead.setAttribute('aria-hidden', 'true');
  filesHead.innerHTML =
    '<div></div>'
    + '<div>File</div>'
    + '<div>Source size</div>'
    + '<div>Status</div>'
    + '<div style="text-align:right;">Output</div>'
    + '<div></div>';   // trailing skip cell
  filesUl.appendChild(filesHead);

  batch.files.forEach((file, i) => {
    filesUl.appendChild(buildFileRow(file, i, batch.id, isNewBatch, batch.status));
  });
  li.appendChild(filesUl);

  // Drag-and-drop reordering between queued batches
  li.addEventListener('dragstart', (e) => {
    if (batch.status !== 'queued') { e.preventDefault(); return; }
    li.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(batch.id));
  });
  li.addEventListener('dragend', () => li.classList.remove('dragging'));
  li.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; });
  li.addEventListener('drop', (e) => {
    e.preventDefault();
    const draggedId = Number(e.dataTransfer.getData('text/plain'));
    const targetId = batch.id;
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

function buildFileRow(file, i, batchId, entering, batchStatus) {
  const li = document.createElement('li');
  li.className = `qrow status-${file.status}`;
  li.dataset.fpath = file.path;

  /* Pattern 5/6/8: one-shot motions, gated so they fire once per transition
     across renderQueue rebuilds. CSS no-ops them all under reduced-motion. */
  const fkey = batchId + '|' + file.path;
  if (file.status === 'done' && !_bloomedFiles.has(fkey)) {
    _bloomedFiles.add(fkey); li.classList.add('bloom-done');
  } else if (file.status === 'failed' && !_shakenFiles.has(fkey)) {
    _shakenFiles.add(fkey); li.classList.add('shake-fail');
  }
  if (entering) {
    li.classList.add('row-enter');
    li.style.setProperty('--enter-delay', (Math.min(i, 10) * 40) + 'ms');
  }

  // # in batch
  const seq = document.createElement('div');
  seq.className = 'seq';
  seq.textContent = String(i + 1).padStart(2, '0');
  li.appendChild(seq);

  // File label
  const fileCol = document.createElement('div');
  fileCol.className = 'file';
  const glyph = document.createElement('div');
  glyph.className = 'glyph';
  glyph.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" style="width:13px;height:13px;"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4M3 12h18"/></svg>';
  const fileMeta = document.createElement('div');
  fileMeta.className = 'meta';
  const fname = document.createElement('div');
  fname.className = 'name revealable';
  fname.textContent = file.name;
  fname.title = 'Reveal original in Finder';
  /* Click the file NAME (not the batch name) → reveal the ORIGINAL source in
     Finder. file.path is the original source path for BOTH batch kinds: a
     folder batch's scan and a file-list batch's scan both store v.file (the
     original). The run-time temp hardlink (squeeze-fl-XXXX/Selected files…)
     never lands in file.path — progress events are mapped back to originals —
     so we always reveal the original, never the temp link. The main side
     stat-gates: a moved/deleted original returns {ok:false} and we surface a
     non-blocking notice instead of opening the wrong/no window. */
  fname.addEventListener('click', async (e) => {
    e.stopPropagation();
    try {
      const res = await window.api.revealInFinder(file.path);
      if (!res || !res.ok) showNotice('This file may have moved or been deleted.');
    } catch {
      showNotice('This file may have moved or been deleted.');
    }
  });
  fileMeta.appendChild(fname);
  fileCol.appendChild(glyph);
  fileCol.appendChild(fileMeta);
  li.appendChild(fileCol);

  // Source size
  const sizeCol = document.createElement('div');
  sizeCol.className = 'mono';
  sizeCol.textContent = file.size > 0 ? humanBytes(file.size) : '—';
  li.appendChild(sizeCol);

  // Status pill + per-file progress bar (D)
  const statusCol = document.createElement('div');
  statusCol.className = `status ${file.status}`;
  const pill = document.createElement('span');
  pill.className = 'pill';
  pill.innerHTML = `<span class="dot"></span>${PILL_LABEL[file.status] || file.status}`;
  statusCol.appendChild(pill);
  /* HDR deferral made visible: this source carried HDR metadata (mastering
     display / content light / Dolby Vision) that a re-encode cannot carry.
     Color tags ARE preserved; the brightness metadata is dropped. */
  if (file.status === 'done' && Array.isArray(file.hdrMeta) && file.hdrMeta.length) {
    const hdr = document.createElement('span');
    hdr.className = 'hdr-chip';
    hdr.textContent = 'HDR';
    hdr.title = `This file carried extra HDR metadata (${file.hdrMeta.join(', ')}) that re-encoding doesn’t keep. The output is still valid HDR — color and transfer tags are preserved; only this metadata was dropped. Keep the original if you need it for color grading or mastered delivery.`;
    statusCol.appendChild(hdr);
  }
  // Bar omitted for skipped — there's nothing to show.
  if (file.status !== 'skipped') {
    const fbar = document.createElement('div');
    fbar.className = 'progressbar';
    const fbi = document.createElement('i');
    let fpct;
    if (file.status === 'done' || file.status === 'existed') fpct = 100;
    else if (file.status === 'failed') fpct = Math.max(8, file.progress || 0);
    else fpct = file.progress || 0;
    fbi.style.width = `${fpct}%`;
    fbar.appendChild(fbi);
    statusCol.appendChild(fbar);
  }
  li.appendChild(statusCol);

  // Output column — unchanged shape, just text per state.
  const outCol = document.createElement('div');
  outCol.className = 'mono';
  outCol.style.textAlign = 'right';
  if (file.status === 'done' && Number.isFinite(file.outputSize) && file.outputSize > 0) {
    outCol.textContent = humanBytes(file.outputSize);
    outCol.classList.add('green');
  } else if (file.status === 'existed') {
    outCol.textContent = 'existing';
    outCol.classList.add('muted');
  } else if (file.status === 'failed') {
    outCol.textContent = '—';
    outCol.classList.add('red');
  } else {
    outCol.textContent = '—';
    outCol.classList.add('muted');
  }
  li.appendChild(outCol);

  /* C: trailing skip control AFTER the output cell — a 6th column.
     v2.8.0 LIVE SKIP: the pipeline consults the skip set at every file
     boundary, so a skip works on ANY not-yet-started file — including rows
     of the RUNNING batch. The row currently encoding never gets the control
     (its status is 'running'; Stop/cancel own that case). A skipped row can
     be UN-skipped (toggle back) while it can still take effect: always on a
     waiting batch; on a running batch only if it was skipped mid-run
     (skippedLive) and the pipeline hasn't passed its slot (skipFinal).
     Renders an empty cell when not actionable, so the grid stays aligned. */
  const skipCell = document.createElement('div');
  skipCell.className = 'qrow-skip';
  const batchLive = batchStatus === 'running' || batchStatus === 'paused';
  const canSkip = file.status === 'queued' && (batchStatus === 'queued' || batchLive);
  const canUnskip = file.status === 'skipped' && !file.skipFinal
    && (batchStatus === 'queued' || (batchLive && file.skippedLive));
  if (canSkip || canUnskip) {
    const sk = document.createElement('button');
    sk.type = 'button';
    sk.className = 'qrow-skip-btn';
    sk.title = canSkip ? 'Skip this file' : 'Restore this file';
    sk.setAttribute('aria-label', sk.title);
    sk.innerHTML = canSkip
      ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:12px;height:12px;"><path d="M6 6l12 12M18 6L6 18"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:12px;height:12px;"><path d="M3 12h13a5 5 0 0 1 0 10h-3M3 12l4-4M3 12l4 4"/></svg>';
    sk.addEventListener('click', (e) => {
      e.stopPropagation();
      if (file.status === 'queued') {
        file.status = 'skipped';
        /* Mid-run skips are only PROVISIONALLY terminal (the pipeline may
           have already passed this file's boundary — the lost-race rule
           resolves that); mark them so un-skip stays offered and a real
           file-start can reclaim the row. */
        file.skippedLive = batchLive;
      } else if (file.status === 'skipped' && !file.skipFinal) {
        file.status = 'queued';
        file.skippedLive = false;
      } else {
        return;
      }
      /* BUG 2 (v2.1.15): push this batch's live skipped set to main so a skip
         toggled AFTER Start is honored — for a batch not yet at its turn (the
         turn-boundary filter) AND, v2.8.0, for the running batch (the
         pipeline's per-file isSkipped read). Un-skip converges the same way. */
      try {
        const b = queue.find((q) => q.id === batchId);
        if (b) window.api.setBatchSkips(batchId, b.files.filter((f) => f.status === 'skipped').map((f) => f.path));
      } catch {}
      renderQueue();
    });
    skipCell.appendChild(sk);
  }
  li.appendChild(skipCell);

  return li;
}

/* First-run teaching hint lives in the empty state only. CSS already hides
   the whole drop prompt once a source is staged (.dropzone.has-source); this
   additionally retires the hint the moment there's queue content or a run has
   finished — so it never reappears over the "Drop another…" prompt. */
function updateOnboarding() {
  if (!dzStepsEl) return;
  const showHint = queue.length === 0 && !hasCompletedRun;
  dzStepsEl.classList.toggle('hidden', !showHint);
}

function renderQueue() {
  // An inline batch rename owns the DOM until it commits/cancels — a wholesale
  // rebuild here would destroy the focused input mid-edit. endRename repaints.
  if (editingBatchId != null) return;
  updateOnboarding();
  queueEl.innerHTML = '';
  queue.forEach((batch, idx) => queueEl.appendChild(buildBatchGroup(batch, idx)));

  const totalBatches = queue.length;
  const totalFiles = queue.reduce((a, b) => a + (b.videoCount || 0), 0);
  const done = queue.filter((q) => q.status === 'done').length;
  const running = queue.filter((q) => q.status === 'running').length;
  const queued = queue.filter((q) => q.status === 'queued').length;
  const paused = queue.filter((q) => q.status === 'paused').length;
  const failed = queue.filter((q) => q.status === 'failed').length;

  queueHeadingEl.textContent = totalFiles > 0
    ? `Queue · ${totalBatches} batch${totalBatches === 1 ? '' : 'es'} · ${totalFiles} file${totalFiles === 1 ? '' : 's'}`
    : `Queue · ${totalBatches}`;
  /* P5: section-head hint reads live state; hidden when summary panel
     is the source of truth. */
  queueCountEl.innerHTML = `${done} done · ${running} running · ${queued} waiting`
    + (failed > 0 ? ` · <span class="red">${failed} failed</span>` : '');

  const qfoot = document.getElementById('qfoot');
  const summaryVisible = summaryCard && !summaryCard.classList.contains('hidden');
  if (totalBatches === 0 || summaryVisible) {
    qfoot.classList.add('hidden');
    queueCountEl.classList.toggle('hidden', summaryVisible);
  } else {
    qfoot.classList.remove('hidden');
    queueCountEl.classList.remove('hidden');
    const srcSum = queue.reduce((a, q) => a + (q.totalSize || 0), 0);
    const recSum = queue.reduce((a, q) => a + (q.reclaimed || 0), 0);
    qfootSource.textContent = srcSum > 0 ? humanBytes(srcSum) : '—';
    /* P5: "Reclaimed · —" placeholder is noise; only show when there's
       a real value to report. Failure callout only when failed > 0. */
    const reclWrap = document.getElementById('qfoot-reclaimed-wrap');
    if (recSum > 0) {
      qfootReclaimed.textContent = '↓ ' + humanBytes(recSum);
      reclWrap.classList.remove('hidden');
    } else {
      reclWrap.classList.add('hidden');
    }
    const failWrap = document.getElementById('qfoot-failed-wrap');
    if (failed > 0) {
      qfootFailed.innerHTML = `<span class="danger">${failed} failure${failed === 1 ? '' : 's'} need${failed === 1 ? 's' : ''} review</span>`;
      failWrap.classList.remove('hidden');
    } else {
      failWrap.classList.add('hidden');
    }
  }

  /* Start is enabled iff the queue has at least one RUNNABLE batch (queued
     with ≥1 non-skipped file) and no run is in progress. Tied to queue
     state — not the staging area. */
  const runnableQueued = queue.filter(
    (q) => q.status === 'queued' && q.files.some((f) => f.status !== 'skipped')
  ).length;
  startBtn.disabled = (runnableQueued === 0) || (running > 0);
  updateTlTag({ running, paused, failed });
  updateFlowState();
}

/* Status pill — shown only when something is actually happening.
   Priority: running > paused > failed. Hidden when idle. */
function updateTlTag({ running, paused, failed }) {
  if (!tlTag) return;
  tlTag.classList.remove('running', 'paused', 'failed');
  if (running > 0) {
    tlTag.classList.add('running');
    tlTag.textContent = running === 1 ? 'Running' : `Running · ${running}`;
    tlTag.classList.remove('hidden');
  } else if (paused > 0) {
    tlTag.classList.add('paused');
    tlTag.textContent = paused === 1 ? 'Paused' : `Paused · ${paused}`;
    tlTag.classList.remove('hidden');
  } else if (failed > 0) {
    tlTag.classList.add('failed');
    tlTag.textContent = failed === 1 ? 'Failure' : `${failed} failures`;
    tlTag.classList.remove('hidden');
  } else {
    tlTag.classList.add('hidden');
    tlTag.textContent = '';
  }

  /* Top activity line: the cyan shimmer means "encoding now". A paused queue
     must STOP moving and read static amber (the established paused token — see
     .tl-tag.paused / .qbatch-status.paused). Bound to the REAL pause state: a
     batch is 'paused' only after main SIGSTOPs its encode and emits 'Paused',
     so paused>0 here is the same state that stopped the encoder. On resume the
     batch returns to 'running' (paused→0) and the shimmer comes back. The
     .active class (run in progress) is owned by start/finish — we only toggle
     the paused modifier on top of it. */
}

/* Drive label for plain-language disk messages: a /Volumes/<name>/… path
   belongs to that named volume; anything else is the startup disk. Mirrors
   the main process's driveKeyForPath rule, kept loose for display only. */
function driveLabelForDest(dest) {
  if (typeof dest === 'string') {
    const m = /^\/Volumes\/([^/]+)/.exec(dest);
    if (m) return m[1];
  }
  return 'your startup disk';
}

/* Disk-space pre-flight: per destination drive, compare the run's total
   SOURCE bytes against free space. Source size is a conservative ceiling
   (compressed copies are smaller), so this errs toward warning. Returns a
   list of shortages; empty = clear to run. Fails OPEN: a dest whose free
   space can't be read (drive unplugged, etc.) is never treated as short. */
async function computeDiskShortages(toRun) {
  const byDest = new Map();
  for (const b of toRun) {
    if (b.dryRun || !b.dest) continue;           // dry runs write nothing
    const need = b.files.reduce(
      (a, f) => a + (f.status !== 'skipped' && Number.isFinite(f.size) && f.size > 0 ? f.size : 0),
      0
    );
    byDest.set(b.dest, (byDest.get(b.dest) || 0) + need);
  }
  const shortages = [];
  for (const [dest, need] of byDest) {
    if (need <= 0) continue;
    let free = null;
    try { const r = await window.api.freeSpace(dest); free = r ? r.free : null; } catch { free = null; }
    if (Number.isFinite(free) && free < need) shortages.push({ dest, need, free });
  }
  return shortages;
}

function diskShortageModal(shortages) {
  const lines = shortages.map((s) =>
    `<li>The videos add up to <span class="num-warn">${humanBytes(s.need)}</span>, but `
    + `<strong>${escapeHtml(driveLabelForDest(s.dest))}</strong> has only `
    + `<span class="num-warn">${humanBytes(s.free)}</span> free.</li>`
  ).join('');
  const body =
    `<div>There may not be enough room to save the compressed copies:</div>`
    + `<ul>${lines}</ul>`
    + `<div class="fine">Compressed copies are usually smaller than the originals, so they may still `
    + `fit — but Squeeze can’t promise it. Either way, your original files are never touched.</div>`;
  return showModal({
    title: 'This drive may be too full',
    tone: 'warn',
    body,
    actions: [
      { label: 'Continue anyway', kind: 'ghost', value: 'continue' },
      { label: 'Choose another location', kind: 'primary', value: 'relocate' }
    ]
  });
}

startBtn.addEventListener('click', async () => {
  /* Every queued batch runs — INCLUDING an all-skipped one. (Previously an
     all-skipped batch was filtered out here and then sat stuck "Queued" forever,
     since main never gave it a terminal status — a real "queue halts after a
     skip" cause.) main marks an all-skipped batch Done and the loop advances. */
  const toRun = queue.filter((q) => q.status === 'queued');
  if (toRun.length === 0) return;

  /* Engine pre-flight FIRST — before any UI flips to "running" and before a
     single ffmpeg is spawned. If the bundled engine is missing, block the run
     with the plain-language message and abort (the safe default). No fallback
     to any other binary ever happens. */
  try {
    const eng = await window.api.checkEngine();
    if (!eng || !eng.ok) {
      await showModal({
        title: 'Squeeze',
        tone: 'warn',
        body: `<p>${escapeHtml((eng && eng.message) || "Squeeze's video engine is missing — please reinstall the app.")}</p>`,
        actions: [{ label: 'OK', value: true, kind: 'primary' }]
      });
      return;                                 // do NOT start the run
    }
  } catch {
    await showModal({
      title: 'Squeeze', tone: 'warn',
      body: `<p>Squeeze's video engine is missing — please reinstall the app.</p>`,
      actions: [{ label: 'OK', value: true, kind: 'primary' }]
    });
    return;
  }

  /* Disk pre-flight, with a relocate→recheck loop. Dismissing the warning
     (Esc / backdrop) aborts the start — the safe default. */
  while (true) {
    const shortages = await computeDiskShortages(toRun);
    if (shortages.length === 0) break;
    const choice = await diskShortageModal(shortages);
    if (choice === 'continue') break;
    if (choice === 'relocate') {
      const parent = current.dest || (toRun[0] && toRun[0].dest) || null;
      const newDest = await window.api.chooseDestination(parent);
      if (!newDest) return;                 // relocate cancelled → don't start
      for (const b of toRun) b.dest = newDest;
      current.dest = newDest;
      destPathEl.textContent = newDest;
      destPathEl.classList.remove('placeholder');
      renderQueue();
      continue;                             // re-check the new drive
    }
    return;                                 // dismissed → abort safely
  }

  summaryCard.classList.add('hidden');
  progressCard.classList.remove('hidden');
  startBtn.classList.add('hidden');
  stopBtn.classList.remove('hidden');
  runActive = true;
  updateFlowState();   // run in progress → clear the orange cue
  /* FIX 2: throughput model starts now. Show a calm "Estimating…" until the
     first live signal, then a continuous whole-queue countdown. A 1s ticker
     keeps the ETA/bar alive even between encoder progress events. */
  resetEtaModel();
  resetProgressUI();
  updateOverallProgressEta();      // paints "Estimating…" + 0% bar immediately
  if (etaTimer) clearInterval(etaTimer);
  etaTimer = setInterval(updateOverallProgressEta, 1000);
  /* Skip handling lives in ONE place: main, at each batch's turn. The payload
     carries the FULL file list + the skipped ORIGINAL paths (frozen seed); main
     also takes live `set-batch-skips` updates so a skip toggled after Start is
     honored too. A file-list batch sends its full fileSources (so main can
     short-circuit an all-skipped one to a clean Done); a folder batch sends
     kind:'folder' + skipped, and runBatch drops the skipped originals at scan.
     No pre-filtering / kind-conversion here — that's what let an all-skipped
     batch fall through the cracks and stall. */
  const payload = toRun.map(batchToPayload);
  await window.api.startQueue(payload);
});

stopBtn.addEventListener('click', async () => {
  stopBtn.disabled = true;
  stopBtn.textContent = 'Stopping after current file…';
  await window.api.stopQueue();
});

function resetProgressUI() {
  progressFill.style.width = '0%';
  lastFileProgressTs = 0; lastFileProgressVal = 0;
  setFinalizing(false, false);
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

  // Map main-process status strings → queue row status
  if (status === 'Running') {
    // From either initial start or post-resume — treat as running.
    const wasPaused = item.status === 'paused';
    item.status = 'running';
    if (!wasPaused) {
      item.progress = 0;
      currentBatchId = id;
      perFileTimes = [];
      batchPrevReclaimed = 0;
      // The "Running:" header is painted whole-queue by updateOverallProgressEta
      // from the currently-encoding batch's name — not pinned to this batch here.
    }
  } else if (status === 'Paused') {
    item.status = 'paused';
  } else if (status === 'Cancelling') {
    item.status = 'cancelling';
  } else if (status === 'Cancelled') {
    item.status = 'cancelled';
    if (result) {
      item.lastResult = result;
      item.processed = result.processed || 0;
      item.failed = result.failed || 0;
      item.reclaimed = result.reclaimed || 0;
    }
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
  /* BUG A: once terminal, reconcile leftover file rows so the pill and the
     per-file rows always agree (no batch DONE over a row stuck RUNNING). */
  if (item.status === 'done' || item.status === 'failed' || item.status === 'cancelled') {
    reconcileBatchFiles(item);
  }
  /* Terminal states are credited to the lifetime tracker. dryRun is the
     batch's FROZEN flag (snapshotted at Add), not the live toggle, so a
     mid-queue toggle of the safety bar can't poison the counters. */
  maybeCreditBatch(item);
  renderQueue();
});

window.api.onProgress((d) => {
  const batch = queue.find((q) => q.id === currentBatchId);

  if (d.type === 'file-start') {
    currentFileEl.textContent = d.basename;
    lastFileStartTs = Date.now();
    // New file → not finalizing; reset the staleness trackers.
    lastFileProgressTs = 0; lastFileProgressVal = 0;
    setFinalizing(false, false);
    // "File X of Y" is painted whole-queue by updateOverallProgressEta (called
    // below, after this file's row flips to running) — not per-batch d.index/d.total.
    if (batch) {
      batch.progress = ((d.index - 1) / d.total) * 100;
      /* BUG A — resolve THIS file by exact source path first (main now maps
         file-list temp paths back to originals), then by basename among
         not-yet-terminal rows. Mark ONLY this file running. We deliberately do
         NOT mark "earlier" files done: the pipeline's processing order can
         differ from the row order (file-list temp readdir), and that defensive
         loop was marking files done with no output size, so their own
         file-done could no longer land. Every file gets its own start/done. */
      /* v2.8.0 LOST-RACE RULE — the pipeline is ground truth. A skip clicked
         in the same window the pipeline passed that file's boundary check
         lost the race: the file IS encoding. A row that is skipped only
         PROVISIONALLY (skippedLive && !skipFinal) is reclaimed by a real
         file-start for its exact path: flip back to queued (the normal
         resolution below then marks it running), prune it from the skips
         set and re-push so main's state converges. Scoped EXCLUSIVELY to
         skippedLive && !skipFinal — skipFinal rows and every other terminal
         row keep the v2.7.1 guards verbatim. */
      const ri = batch.files.findIndex(
        (f) => f.path === d.file && f.status === 'skipped' && f.skippedLive && !f.skipFinal
      );
      if (ri >= 0) {
        const rf = batch.files[ri];
        rf.status = 'queued';
        rf.skippedLive = false;
        try {
          window.api.setBatchSkips(batch.id, batch.files.filter((f) => f.status === 'skipped').map((f) => f.path));
        } catch {}
      }
      /* v2.7.1: the exact-path match carries the SAME terminal guard as the
         basename fallback — a row already settled (e.g. skipped) must never
         be flipped back to running by a stray engine event. */
      let fi = batch.files.findIndex((f) => f.path === d.file && !isTerminalFileStatus(f.status));
      if (fi < 0) fi = batch.files.findIndex(
        (f) => f.name === d.basename && !isTerminalFileStatus(f.status)
      );
      if (fi >= 0) {
        batch.files[fi].status = 'running';
        batch.files[fi].progress = 0;
        batch.runningFileIdx = fi;
      }
      renderQueue();
    }
    updateOverallProgressEta();   // FIX 2/3: refresh whole-queue bar + ETA
  } else if (d.type === 'file-progress') {
    // Fresh encoder progress → record for the finalizing heuristic. A live
    // sample means still encoding, so drop any unconfirmed "finishing up".
    lastFileProgressTs = Date.now();
    lastFileProgressVal = d.fileProgress;
    if (finalizing.active && !finalizing.confirmed) setFinalizing(false, false);
    const overall = ((d.index - 1) + d.fileProgress) / d.total;   // per-BATCH progress
    if (batch) {
      batch.progress = overall * 100;
      const root = queueEl.querySelector(`[data-id="${batch.id}"]`);
      const bar = root ? root.querySelector('.qbatch-status .progressbar > i') : null;
      if (bar) bar.style.width = `${batch.progress.toFixed(1)}%`;
      /* D: per-file progress bar — inline update, no full re-render. */
      const idx = Number.isFinite(batch.runningFileIdx) ? batch.runningFileIdx : -1;
      if (idx >= 0 && batch.files[idx]) {
        batch.files[idx].progress = Math.max(0, Math.min(100, d.fileProgress * 100));
        if (root) {
          const filesList = root.querySelector('.qbatch-files');
          /* Key the row by its own data-fpath, NOT children[idx]: the tray's
             first child is the .qfile-head label strip (v2.2.3), so a raw child
             index is off by one — it wrote the running file's % onto the strip
             (file 0) or the previous done row (file k>0). Match the active
             file's path among the .qrow rows: index-free, strip-agnostic, and
             scoped to this batch so the path is unique. */
          const targetPath = batch.files[idx].path;
          const fileRow = filesList
            ? [...filesList.querySelectorAll('.qrow')].find((r) => r.dataset.fpath === targetPath)
            : null;
          const fbar = fileRow ? fileRow.querySelector('.status .progressbar > i') : null;
          if (fbar) fbar.style.width = `${batch.files[idx].progress.toFixed(1)}%`;
        }
        /* FIX 2: refine this tier's throughput from the file's live rate
           (skip the noisy first/last few %). */
        const sz = batch.files[idx].size;
        if (sz > 0 && lastFileStartTs > 0 && d.fileProgress > 0.1 && d.fileProgress < 0.98) {
          const elapsed = Date.now() - lastFileStartTs;
          if (elapsed > 0) refineBpms(batch.tier, (sz * d.fileProgress) / elapsed, EWMA_PROG);
        }
      }
    }
    updateOverallProgressEta();   // FIX 3: whole-queue bar + FIX 2: ETA
  } else if (d.type === 'finalizing') {
    /* Confirmed by main's finalization detector: the encode reached ~100% but
       the process is still alive flushing the container (slow SMB moov write).
       Upgrade to the explicit "don't quit" state and hold the indeterminate bar. */
    setFinalizing(true, true);
  } else if (d.type === 'file-done') {
    // File fully written → leave any finalizing state.
    lastFileProgressTs = 0; lastFileProgressVal = 0;
    setFinalizing(false, false);
    const overall = d.index / d.total;   // per-BATCH progress (for this batch's row bar)
    if (batch) {
      batchPrevReclaimed = d.reclaimed || 0;
      batch.progress = overall * 100;
      batch.reclaimed = d.reclaimed || batch.reclaimed;
      batch.processed = (d.processed || 0);
      batch.skipped = d.alreadyDone || 0;
      batch.failed = d.failed || 0;

      /* v2.8.0 LIVE SKIP — the pipeline honored a mid-run skip at this file's
         boundary. May settle a row only FROM queued|skipped TO skipped (the
         common case is a no-op: the click already marked it). Stamps
         skipFinal: the slot has passed, so un-skip retires. Every other
         terminal row keeps the v2.7.1 guards below untouched. */
      if (d.outcome === 'skip-user') {
        const sf = batch.files.find(
          (f) => f.path === d.file && (f.status === 'skipped' || f.status === 'queued')
        );
        if (sf) {
          sf.status = 'skipped';
          sf.skipFinal = true;
          sf.outputSize = null;
        }
        batch.runningFileIdx = -1;
        renderQueue();
        updateOverallProgressEta();
        return;
      }

      /* BUG A — resolve which file this completion belongs to by EXACT source
         path first (main maps file-list temp paths back to originals, so this
         is reliable regardless of processing order or duplicate basenames),
         then the running index from file-start, then a basename match among
         not-yet-terminal rows. Then assign the REAL output size the pipeline
         sent (d.outBytes). Order-independent → every done file gets its size. */
      /* v2.7.1: exact-path match guarded like the basename fallback below —
         a terminal row (skipped/cancelled/…) is never overwritten to Done
         with an output size by an event for a file the engine encoded
         against a stale staged list. */
      let ti = d.file ? batch.files.findIndex((f) => f.path === d.file && !isTerminalFileStatus(f.status)) : -1;
      if (ti < 0 && Number.isFinite(batch.runningFileIdx) && batch.files[batch.runningFileIdx]
          && !isTerminalFileStatus(batch.files[batch.runningFileIdx].status)) {
        ti = batch.runningFileIdx;
      }
      if (ti < 0 && d.basename) ti = batch.files.findIndex(
        (f) => f.name === d.basename && !isTerminalFileStatus(f.status)
      );
      if (ti >= 0 && batch.files[ti]) {
        const f = batch.files[ti];
        const realOut = Number.isFinite(d.outBytes) && d.outBytes >= 0 ? d.outBytes : null;
        if (d.outcome === 'fail') {
          f.status = 'failed';
          f.outputSize = null;
        } else if (d.outcome === 'cancelled') {
          f.status = 'cancelled';
          f.outputSize = null;
        } else if (d.outcome === 'skip-exists') {
          /* Resumability: output already present. Show its real size. */
          f.status = 'existed';
          f.outputSize = realOut;
        } else {
          f.status = 'done';
          f.outputSize = realOut;
          /* HDR side data (mastering display / content light / Dolby Vision)
             that re-encoding can't carry — surfaced as a chip on the row. */
          if (Array.isArray(d.hdrMeta) && d.hdrMeta.length) f.hdrMeta = d.hdrMeta;
          /* FIX 2: a completed encode is the most reliable throughput sample —
             refine this tier's model from in-bytes ÷ this file's encode time. */
          const inBytes = Number.isFinite(d.inBytes) && d.inBytes > 0 ? d.inBytes : f.size;
          const encodeMs = lastFileStartTs > 0 ? (Date.now() - lastFileStartTs) : 0;
          if (inBytes > 0 && encodeMs > 0) refineBpms(batch.tier, inBytes / encodeMs, EWMA_DONE);
        }
        f.progress = 100;
      }
      batch.runningFileIdx = -1;
      renderQueue();
    }

    updateOverallProgressEta();   // FIX 3: whole-queue bar + FIX 2: ETA (continuous)
  } else if (d.type === 'dry-summary') {
    currentFileEl.textContent = `[dry run] ${d.videos} videos · ${d.ignored} ignored`;
    progressCounts.textContent = `Est. reclaim: ${humanBytes(d.estReclaim)}`;
    statCompleted.textContent = String(d.videos);
    statIgnored.textContent = String(d.ignored);
  }
});

window.api.onQueueFinished(({ totals, stopped }) => {
  runActive = false;   // run over → flow can re-cue Start if work remains
  if (etaTimer) { clearInterval(etaTimer); etaTimer = null; }
  setFinalizing(false, false);   // run over → drop any finalizing state
  progressCard.classList.add('hidden');
  stopBtn.classList.add('hidden');
  stopBtn.disabled = false;
  stopBtn.textContent = 'Stop after current file';
  startBtn.classList.remove('hidden');
  // tl-tag state will be updated by the next renderQueue() call based on
  // remaining failed batches; if there are none it hides.

  /* P5: one core sentence, not five. Sub-counts only when non-zero. */
  const lines = [];
  /* Item 2: the headline tally — every file accounted for, in plain words.
     Counted from queue file state (renderer is authoritative; operator
     skips never reach the pipeline totals). done=success, failed, skipped
     folds operator-skips + already-present, cancelled shown only if any. */
  lines.push(summaryCountsHtml());
  if (stopped) lines.push(`<div class="muted">Stopped by user — one file at a time, never mid-file.</div>`);
  const doneBatches = queue.filter((q) => q.status === 'done').length;
  lines.push(
    `<div class="reclaimed-line">Reclaimed <strong>${humanBytes(totals.reclaimed)}</strong> across `
    + `<strong>${totals.processed}</strong> file${totals.processed === 1 ? '' : 's'} `
    + `in ${doneBatches} batch${doneBatches === 1 ? '' : 'es'}.</div>`
  );
  const sub = [];
  if (totals.alreadyDone > 0) sub.push(`${totals.alreadyDone} already done`);
  if (totals.skippedNonVideo > 0) sub.push(`${totals.skippedNonVideo} non-video ignored`);
  if (sub.length) lines.push(`<div class="muted">${sub.join(' · ')}</div>`);
  /* HDR deferral, surfaced (not just logged): the operator must see when an
     HDR source's mastering metadata didn't survive the re-encode. */
  if (totals.hdrMetaDropped > 0) {
    const n = totals.hdrMetaDropped;
    const isAre = n === 1 ? 'output is' : 'outputs are';
    const itThem = n === 1 ? 'it' : 'them';
    lines.push(
      `<div class="hdr-note">${n} file${n === 1 ? '' : 's'} carried extra HDR metadata that re-encoding doesn’t keep. `
      + `The ${isAre} still valid HDR — color and transfer tags are preserved; only this metadata was dropped. `
      + `Keep the original${n === 1 ? '' : 's'} if you need ${itThem} for color grading or mastered delivery.</div>`
    );
  }
  /* Item 3: failures stay plain — no exit codes or ffmpeg text here. The
     technical detail lives one click away in the run log (Show log).
     Wording is conditional on whether the _FAILED/ copy was actually
     written: we only promise a copy when one exists. A file whose original
     couldn't be read (moved/deleted mid-run) has no copy — say so, and
     never point at _FAILED/ for it. */
  if (totals.failed > 0) {
    const copied = totals.failedCopied || 0;
    const noCopy = totals.failedNoCopy || 0;
    const destLost = totals.failedDestLost || 0;
    const plural = (n) => (n === 1 ? '' : 's');

    /* BUG 3: destination drive vanished — a destination problem, never a
       source one. Say so plainly and never blame the original or point at
       _FAILED/ (which lived on the drive that disappeared). */
    if (destLost > 0 || totals.destLost) {
      lines.push(
        `<div class="failed-line">The destination drive became unavailable during the run`
        + `${destLost > 0 ? `, so ${destLost} file${plural(destLost)} couldn’t be saved` : ''}. `
        + `Your original files are untouched. Open “Show log” for details.</div>`
      );
    }

    /* Ordinary failures: corrupt/undecodable (preserved to _FAILED/) vs
       source unreadable (no copy possible). Wording only ever promises a
       _FAILED/ copy that actually exists. */
    const ordinary = copied + noCopy;
    if (ordinary > 0) {
      if (noCopy === 0) {
        lines.push(`<div class="failed-line">${copied} file${plural(copied)} couldn’t be compressed and ${copied === 1 ? 'was' : 'were'} skipped. A copy of each is in <code>_FAILED/</code> for you to check. Open “Show log” for details.</div>`);
      } else if (copied === 0) {
        lines.push(`<div class="failed-line">${noCopy} file${plural(noCopy)} couldn’t be read — the original${plural(noCopy)} may have been moved or deleted during the run, so no copy was saved. Open “Show log” for details.</div>`);
      } else {
        lines.push(
          `<div class="failed-line">${copied} file${plural(copied)} couldn’t be compressed and ${copied === 1 ? 'was' : 'were'} skipped — a copy of each is in <code>_FAILED/</code>. `
          + `${noCopy} other${plural(noCopy)} couldn’t be read at all (the original${plural(noCopy)} may have been moved or deleted during the run), so no copy was saved. Open “Show log” for details.</div>`
        );
      }
    }

    /* Fallback for an inconsistent breakdown (legacy result): never go silent
       about failures. */
    if (ordinary === 0 && destLost === 0 && !totals.destLost) {
      const f = totals.failed;
      lines.push(`<div class="failed-line">${f} file${plural(f)} couldn’t be processed and ${f === 1 ? 'was' : 'were'} skipped. Open “Show log” for details.</div>`);
    }
  }
  /* Item 4: the trust promise, restated on every run summary. */
  lines.push(
    `<div class="summary-trust">`
    + `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>`
    + `Your original files were not changed — Squeeze only wrote new compressed copies.</div>`
  );
  summaryBody.innerHTML = lines.join('');

  const lastDone = [...queue].reverse().find((q) => q.lastResult);
  lastRun = lastDone ? lastDone.lastResult : null;
  showLogBtn.disabled = !lastRun || !lastRun.logPath;
  revealOutputBtn.disabled = !lastRun || !lastRun.runDir;

  /* A: "Run complete" only when nothing is left to run. If the operator
     added new batches mid-run, those sit at 'queued' — keep Start visible
     and don't open the summary panel. */
  const stillRunnable = queue.some(
    (q) => (q.status === 'queued' && q.files.some((f) => f.status !== 'skipped'))
        || q.status === 'running'
  );
  if (stillRunnable) {
    document.querySelector('.actions').classList.remove('hidden');
    summaryCard.classList.add('hidden');
  } else {
    document.querySelector('.actions').classList.add('hidden');
    summaryCard.classList.remove('hidden');
  }
  /* E: ETA visible only during the run. */
  hideEta();
  // P7: any further drops are "another folder" — flip the idle copy.
  if (totals.processed > 0 || totals.failed > 0 || queue.some((q) => q.status === 'done' || q.status === 'failed')) {
    hasCompletedRun = true;
    updateIdleCopy();
  }
  // P5: queue-count hint + qfoot are now hidden by renderQueue under the
  // summary panel, so summary is the single source of truth for totals.
  renderQueue();
});

showLogBtn.addEventListener('click', () => {
  if (lastRun && lastRun.logPath) window.api.openPath(lastRun.logPath);
});
revealOutputBtn.addEventListener('click', () => {
  if (lastRun && lastRun.runDir) window.api.revealPath(lastRun.runDir);
});
dismissSummaryBtn.addEventListener('click', () => {
  summaryCard.classList.add('hidden');
  document.querySelector('.actions').classList.remove('hidden');
  /* P5: bring back the queue-count hint + qfoot now that the panel is gone. */
  renderQueue();
});

/* ─────────── Lifetime reclaimed ─────────── */
const TERMINAL_STATUSES = new Set(['done', 'failed', 'cancelled']);

/* Credit a batch's contribution to the persistent per-drive ledger.
   Idempotent via batch.creditedToLifetime. The two required guards:
     1. batch.dryRun (frozen at Add) → skip entirely.
     2. Only files with status==='done' contribute. Failed / cancelled /
        skipped / still-running files contribute nothing. */
function maybeCreditBatch(batch) {
  if (!batch || batch.creditedToLifetime) return;
  if (!TERMINAL_STATUSES.has(batch.status)) return;
  batch.creditedToLifetime = true;       // mark even if dry-run / no-op
  if (batch.dryRun) return;
  if (!batch.dest) return;

  let addedBytes = 0;
  let filesAdded = 0;
  for (const f of batch.files) {
    if (f.status !== 'done') continue;
    filesAdded += 1;
    if (Number.isFinite(f.outputSize) && Number.isFinite(f.size)) {
      const delta = f.size - f.outputSize;
      if (delta > 0) addedBytes += delta;
      // negative delta (output bigger than source) contributes 0
    }
  }
  if (filesAdded === 0) return;
  window.api.addReclaimed({
    dest: batch.dest,
    addedBytes,
    filesAdded
  }).then(refreshLifetime).catch(() => { /* non-fatal */ });
}

async function refreshLifetime() {
  let drives = [];
  try { drives = await window.api.getLifetimeDrives(); } catch { drives = []; }
  renderLifetime(drives);
}

function fmtSince(ts) {
  if (!Number.isFinite(ts)) return '—';
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

const DRIVE_ICON_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">'
  + '<rect x="3" y="6" width="18" height="12" rx="2"/>'
  + '<path d="M3 12h18"/>'
  + '<circle cx="7" cy="15" r="1.2" fill="currentColor"/>'
  + '</svg>';

function renderLifetime(drives) {
  if (!lifetimeSection || !lifetimeList) return;
  lifetimeList.innerHTML = '';

  // Hide section when no row has anything to show.
  const visible = drives.filter((d) => d.totalReclaimed > 0 || d.filesProcessed > 0);
  if (visible.length === 0) {
    lifetimeSection.classList.add('hidden');
    if (lifetimeTotal) lifetimeTotal.textContent = '';
    return;
  }
  lifetimeSection.classList.remove('hidden');

  const total = visible.reduce((a, d) => a + (d.totalReclaimed || 0), 0);
  if (lifetimeTotal) {
    lifetimeTotal.textContent = total > 0
      ? `${humanBytes(total)} total · ${visible.length} drive${visible.length === 1 ? '' : 's'}`
      : '';
  }

  for (const d of visible) {
    const li = document.createElement('li');
    li.className = 'lt-row';
    li.dataset.key = d.driveKey;

    const icon = document.createElement('div');
    icon.className = 'lt-icon';
    icon.innerHTML = DRIVE_ICON_SVG;
    li.appendChild(icon);

    const info = document.createElement('div');
    info.className = 'lt-info';
    const label = document.createElement('div');
    label.className = 'lt-label';
    label.textContent = d.label;
    label.title = d.driveKey;
    const meta = document.createElement('div');
    meta.className = 'lt-meta';
    const filesPart = `${d.filesProcessed} file${d.filesProcessed === 1 ? '' : 's'}`;
    const runsPart  = `${d.runsCount} run${d.runsCount === 1 ? '' : 's'}`;
    const sincePart = `since ${fmtSince(d.firstSeen)}`;
    meta.textContent = `${filesPart} · ${runsPart} · ${sincePart}`;
    info.appendChild(label);
    info.appendChild(meta);
    li.appendChild(info);

    const amt = document.createElement('div');
    amt.className = 'lt-amount';
    amt.textContent = humanBytes(d.totalReclaimed);
    li.appendChild(amt);

    /* Reset wipes a long-term total and is irreversible, so it gets an
       explicit confirmation modal. Cancel, Esc, or backdrop all abort;
       the reset only proceeds on a deliberate confirm. */
    const reset = document.createElement('button');
    reset.className = 'lt-reset';
    reset.type = 'button';
    reset.textContent = 'Reset';
    reset.addEventListener('click', async (e) => {
      e.stopPropagation();
      const ok = await showModal({
        title: 'Reset lifetime reclaimed stats?',
        body: `<p>This clears the saved lifetime total for <strong>${escapeHtml(d.label)}</strong>. This can’t be undone.</p>`,
        tone: 'warn',
        actions: [
          { label: 'Cancel', value: false, kind: 'ghost' },
          { label: 'Reset stats', value: true, kind: 'primary' },
        ],
      });
      if (!ok) return;
      try { await window.api.resetDrive(d.driveKey); } catch {}
      await refreshLifetime();
    });
    li.appendChild(reset);

    lifetimeList.appendChild(li);
  }
}

clearDrop();
renderQueue();
refreshLifetime();

/* Item 6: orphaned-partial recovery. On launch the main process scans the
   last interrupted run's destination(s) for leftover ".tmp.mp4" partials —
   unplayable, partly-written files from a crash/quit mid-encode. Offer to
   delete them. Only those temp files are ever removed; originals and
   finished outputs are untouched. Dismissing keeps everything. */
window.api.onOrphansFound(async ({ orphans } = {}) => {
  if (!orphans || !orphans.length) return;
  const n = orphans.length;
  const totalBytes = orphans.reduce((a, o) => a + (Number.isFinite(o.size) ? o.size : 0), 0);
  const body =
    `<div>Squeeze found <strong>${n}</strong> unfinished file${n === 1 ? '' : 's'} left over from `
    + `one or more interrupted runs (about <strong>${humanBytes(totalBytes)}</strong> in total). `
    + `${n === 1 ? 'It’s' : 'They’re'} incomplete and can’t be played.</div>`
    + `<div class="fine">Deleting ${n === 1 ? 'it' : 'them'} only removes the leftover, partly-written `
    + `file${n === 1 ? '' : 's'}. Your original videos and any finished compressed files are not affected.</div>`;
  const choice = await showModal({
    title: 'Clean up unfinished files?',
    tone: 'info',
    body,
    actions: [
      { label: 'Keep for now', kind: 'ghost', value: 'keep' },
      { label: n === 1 ? 'Delete file' : 'Delete files', kind: 'primary', value: 'delete' }
    ]
  });
  if (choice === 'delete') {
    try { await window.api.deleteOrphans(orphans.map((o) => o.path)); } catch { /* non-fatal */ }
  }
});

/* Version label — single source of truth. main.js returns app.getVersion()
   which reads CFBundleShortVersionString in the packaged .app and falls
   through to package.json in dev. Bumping package.json is the only edit. */
(async () => {
  try {
    const v = await window.api.getAppVersion();
    if (appVersionEl && v) appVersionEl.textContent = 'v' + v;
  } catch { /* leave blank if IPC fails */ }
})();
