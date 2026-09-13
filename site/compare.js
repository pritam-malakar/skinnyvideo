// Original-vs-compressed comparison slider for the results section of index.html.
// Nothing but the poster loads until "Load comparison" is pressed. The compressed video is
// the master clock; the original preview (bottom layer, left of the handle) follows it.
(() => {
  'use strict';

  const root = document.querySelector('[data-compare]');
  if (!root) return;

  const $ = (sel) => root.querySelector(sel);
  const stage = $('.cmp-stage');
  const poster = $('.cmp-poster');
  const loadBtn = $('.cmp-load');
  const note = $('.cmp-note');
  const line = $('.cmp-line');
  const handle = $('.cmp-handle');
  const tags = root.querySelectorAll('.cmp-tag');
  const playBtn = $('.cmp-play');
  const zoomBtn = $('.cmp-zoom');
  const status = $('.cmp-status');

  const slave = $('.cmp-orig');
  const master = $('.cmp-comp');
  const videos = [slave, master];

  const HEVC_TYPES = ['video/mp4; codecs="hvc1.2.4.L153.B0"', 'video/mp4; codecs="hvc1.1.6.L153.B0"'];
  const MAX_DRIFT = 0.04; // seconds

  let split = 50;
  let loaded = false; // both videos reached canplaythrough
  let wantPlay = true; // the Play/Pause button's intent
  let inView = true;
  let oneToOne = false;
  let pan = null;
  const pos = { x: 50, y: 50 };
  const stalled = new Set();

  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
  const setStatus = (text) => { status.textContent = text; };

  function canPlayHevc() {
    const probe = document.createElement('video');
    return HEVC_TYPES.some((type) => {
      const answer = probe.canPlayType(type);
      return answer === 'probably' || answer === 'maybe';
    });
  }

  // Loading

  function bufferedFraction(v) {
    const d = v.duration;
    if (!Number.isFinite(d) || d <= 0) return 0;
    let t = 0;
    for (let i = 0; i < v.buffered.length; i++) t += v.buffered.end(i) - v.buffered.start(i);
    return clamp(t / d, 0, 1);
  }

  // Weighted by file size, so the figure tracks bytes rather than seconds.
  function showProgress() {
    if (loaded) return;
    let done = 0;
    let total = 0;
    for (const v of videos) {
      const mb = Number(v.dataset.mb) || 1;
      done += bufferedFraction(v) * mb;
      total += mb;
    }
    const text = `Loading… ${Math.round((done / total) * 100)}%`;
    loadBtn.textContent = text;
    setStatus(text);
  }

  function onLoadError() {
    if (loaded) return;
    loadBtn.hidden = true;
    note.textContent = "The comparison couldn't load. Download both files below to compare.";
    note.hidden = false;
    setStatus('Load failed');
  }

  function load() {
    if (!canPlayHevc()) {
      loadBtn.hidden = true;
      note.hidden = false;
      setStatus("This browser can't play HEVC");
      return;
    }
    loadBtn.disabled = true;
    const ready = new Set();
    for (const v of videos) {
      v.muted = true;
      v.addEventListener('canplaythrough', () => {
        ready.add(v);
        if (ready.size === videos.length && !loaded) begin();
      }, { once: true });
      v.addEventListener('progress', showProgress);
      v.addEventListener('loadedmetadata', showProgress);
      v.addEventListener('error', onLoadError, { once: true });
      v.preload = 'auto';
      v.src = v.dataset.src;
      v.load();
    }
    showProgress();
  }

  // Playback and sync

  function render() {
    playBtn.textContent = wantPlay ? 'Pause' : 'Play';
    if (stalled.size) setStatus('Buffering…');
    else setStatus(wantPlay ? 'Playing · drag the handle' : 'Paused · drag the handle');
  }

  function apply() {
    if (!loaded) return;
    const go = wantPlay && inView && stalled.size === 0;
    if (go && !slave.seeking && Math.abs(slave.currentTime - master.currentTime) > MAX_DRIFT) {
      slave.currentTime = master.currentTime;
    }
    for (const v of videos) {
      if (go) {
        // An ended slave waits for the master's `ended` rewind instead of restarting alone.
        if (v.paused && !v.ended) {
          v.play().catch((err) => {
            if (err && err.name === 'NotAllowedError') { wantPlay = false; apply(); }
          });
        }
      } else if (!v.paused) {
        v.pause();
      }
    }
    render();
  }

  const hasFrameCallback = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;

  function tick() {
    if (!slave.seeking && !master.seeking && Math.abs(slave.currentTime - master.currentTime) > MAX_DRIFT) {
      slave.currentTime = master.currentTime;
    }
    schedule();
  }

  function schedule() {
    if (hasFrameCallback) master.requestVideoFrameCallback(tick);
    else requestAnimationFrame(tick);
  }

  function begin() {
    loaded = true;
    for (const v of videos) {
      v.removeEventListener('progress', showProgress);
      v.removeEventListener('loadedmetadata', showProgress);
      v.addEventListener('waiting', () => {
        if (v.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) return;
        stalled.add(v);
        apply();
      });
      v.addEventListener('canplay', () => {
        if (stalled.delete(v)) apply();
      });
    }
    master.addEventListener('ended', () => {
      for (const v of videos) v.currentTime = 0;
      for (const v of videos) v.play().catch(() => {});
      render();
    });

    poster.hidden = true;
    line.hidden = false;
    handle.hidden = false;
    for (const t of tags) t.hidden = false;
    playBtn.disabled = false;
    zoomBtn.disabled = false;

    new IntersectionObserver((entries) => {
      inView = entries[entries.length - 1].isIntersecting;
      apply();
    }).observe(stage);

    schedule();
    apply();
  }

  // Split handle: pointer drag on the handle only, plus keyboard

  function setSplit(value) {
    split = clamp(value, 0, 100);
    const now = Math.round(split);
    stage.style.setProperty('--split', `${split}%`);
    handle.setAttribute('aria-valuenow', String(now));
    handle.setAttribute('aria-valuetext', `${now}% original, ${100 - now}% compressed`);
  }

  handle.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault(); // no text selection or native drag; focus manually instead
    handle.focus({ preventScroll: true });
    handle.setPointerCapture(e.pointerId);
  });

  handle.addEventListener('pointermove', (e) => {
    if (!handle.hasPointerCapture(e.pointerId)) return;
    const r = stage.getBoundingClientRect();
    setSplit(((e.clientX - r.left) / r.width) * 100);
  });

  handle.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 10 : 1;
    const keys = {
      ArrowLeft: -step, ArrowDown: -step, ArrowRight: step, ArrowUp: step,
    };
    let next;
    if (e.key in keys) next = Math.round(split) + keys[e.key];
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = 100;
    else return;
    e.preventDefault();
    setSplit(next);
  });

  // 1:1 pixels: object-fit:none with a shared object-position, panned by dragging the video

  function setPos() {
    stage.style.setProperty('--px', `${pos.x}%`);
    stage.style.setProperty('--py', `${pos.y}%`);
  }

  zoomBtn.addEventListener('click', () => {
    oneToOne = !oneToOne;
    pos.x = 50;
    pos.y = 50;
    setPos();
    stage.classList.toggle('is-1to1', oneToOne);
    zoomBtn.textContent = oneToOne ? 'Fit' : '1:1 pixels';
  });

  stage.addEventListener('pointerdown', (e) => {
    if (!oneToOne || !loaded || e.target.closest('.cmp-handle')) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    stage.setPointerCapture(e.pointerId);
    pan = { id: e.pointerId, x: e.clientX, y: e.clientY, px: pos.x, py: pos.y };
    stage.classList.add('is-panning');
  });

  stage.addEventListener('pointermove', (e) => {
    if (!pan || e.pointerId !== pan.id) return;
    const r = stage.getBoundingClientRect();
    // With object-fit:none, a percentage object-position never shows past the frame edge,
    // so clamping to 0–100% is the edge clamp. Spare = how far the frame overhangs the box.
    const spareX = master.videoWidth - r.width;
    const spareY = master.videoHeight - r.height;
    pos.x = spareX > 0 ? clamp(pan.px - ((e.clientX - pan.x) / spareX) * 100, 0, 100) : 50;
    pos.y = spareY > 0 ? clamp(pan.py - ((e.clientY - pan.y) / spareY) * 100, 0, 100) : 50;
    setPos();
  });

  const endPan = (e) => {
    if (!pan || e.pointerId !== pan.id) return;
    pan = null;
    stage.classList.remove('is-panning');
  };
  stage.addEventListener('pointerup', endPan);
  stage.addEventListener('pointercancel', endPan);
  stage.addEventListener('lostpointercapture', endPan);

  // Controls

  loadBtn.addEventListener('click', load);

  playBtn.addEventListener('click', () => {
    wantPlay = !wantPlay;
    apply();
  });

  // Checksums

  function selectText(el) {
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  for (const btn of root.querySelectorAll('.cmp-copy')) {
    const code = document.getElementById(btn.dataset.copy);
    const label = btn.getAttribute('aria-label');
    let timer;
    btn.addEventListener('click', async () => {
      let copied = false;
      try {
        await navigator.clipboard.writeText(code.textContent.trim());
        copied = true;
      } catch {
        selectText(code); // clipboard API unavailable: leave it selected for Cmd+C
      }
      btn.textContent = copied ? 'Copied' : 'Selected';
      btn.setAttribute('aria-label', copied ? 'Copied' : 'Checksum selected, press Command+C to copy');
      clearTimeout(timer);
      timer = setTimeout(() => {
        btn.textContent = 'Copy';
        btn.setAttribute('aria-label', label);
      }, 1800);
    });
  }
})();
