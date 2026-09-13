// Original-vs-compressed comparison slider for the results section of index.html.
// Nothing but the poster loads until "Load comparison" is pressed. Both files are then
// fetched in full and played from memory (blob: URLs), so the progress figure is real
// bytes; if fetch is blocked (no CORS on the bucket) the R2 URLs are streamed directly.
// The compressed video is the master clock. The original preview (bottom layer, left of
// the handle) follows it by nudging playbackRate and only seeks on large drift.
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
  const SOFT_DRIFT = 0.02; // seconds; within this the slave plays at normal speed
  const HARD_DRIFT = 0.3; // seconds; beyond this, seek (cheap: the preview has a keyframe every second)
  const NUDGE = 0.05; // playbackRate offset that closes drift in between
  const MB = 1e6;

  let split = 50;
  let loaded = false; // both videos reached canplaythrough
  let looping = false; // rewinding both to 0 at the end of the clip
  let wantPlay = true; // the Play/Pause button's intent
  let inView = true;
  let oneToOne = false;
  let pan = null;
  const pos = { x: 50, y: 50 };
  const stalled = new Set();
  const objectUrls = [];

  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
  const setStatus = (text) => { status.textContent = text; };

  function setLoadText(text) {
    if (loadBtn.textContent !== text) loadBtn.textContent = text;
    if (status.textContent !== text) setStatus(text);
  }

  function canPlayHevc() {
    const probe = document.createElement('video');
    return HEVC_TYPES.some((type) => {
      const answer = probe.canPlayType(type);
      return answer === 'probably' || answer === 'maybe';
    });
  }

  // Loading

  // Downloads every file in full, reporting bytes received against Content-Length.
  // Rejects on any failure (including CORS) after aborting the other downloads.
  async function prefetch() {
    const controller = new AbortController();
    const got = videos.map(() => 0);
    const total = videos.map(() => null); // null until that response's headers arrive

    const showProgress = () => {
      if (total.includes(null)) return;
      const received = got.reduce((a, b) => a + b, 0);
      if (total.every((t) => t > 0)) {
        const size = total.reduce((a, b) => a + b, 0);
        setLoadText(`Loading… ${Math.floor((received / size) * 100)}% of ~${Math.round(size / MB)} MB`);
      } else {
        // No Content-Length on a response: count megabytes rather than invent a percentage.
        setLoadText(`Loading… ${Math.round(received / MB)} MB`);
      }
    };

    const download = async (v, i) => {
      const res = await fetch(v.dataset.src, { signal: controller.signal, credentials: 'omit' });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${v.dataset.src}`);
      total[i] = Number(res.headers.get('Content-Length')) || 0;
      showProgress();
      const reader = res.body.getReader();
      const chunks = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        got[i] += value.byteLength;
        showProgress();
      }
      return new Blob(chunks, { type: 'video/mp4' });
    };

    try {
      return await Promise.all(videos.map(download));
    } catch (err) {
      controller.abort(); // don't keep downloading the other file for nothing
      throw err;
    }
  }

  function onLoadError() {
    if (loaded) return;
    loadBtn.hidden = true;
    note.textContent = "The comparison couldn't load. Download both files below to compare.";
    note.hidden = false;
    setStatus('Load failed');
  }

  function attachSources(srcs) {
    let ready = 0;
    videos.forEach((v, i) => {
      v.muted = true;
      v.addEventListener('canplaythrough', () => {
        ready += 1;
        if (ready === videos.length && !loaded) begin();
      }, { once: true });
      v.addEventListener('error', onLoadError, { once: true });
      v.preload = 'auto';
      v.src = srcs[i];
      v.load();
    });
  }

  async function load() {
    if (!canPlayHevc()) {
      loadBtn.hidden = true;
      note.hidden = false;
      setStatus("This browser can't play HEVC");
      return;
    }
    loadBtn.disabled = true;
    setLoadText('Loading…');
    let blobs;
    try {
      blobs = await prefetch();
    } catch {
      // Blocked or failed: stream the files directly. The browser only buffers part of
      // them, so there is no honest percentage to show.
      setLoadText('Buffering…');
      attachSources(videos.map((v) => v.dataset.src));
      return;
    }
    const urls = blobs.map((blob) => URL.createObjectURL(blob));
    objectUrls.push(...urls);
    attachSources(urls);
  }

  window.addEventListener('pagehide', (e) => {
    if (e.persisted) return; // kept in the back/forward cache, where the videos still need them
    for (const url of objectUrls) URL.revokeObjectURL(url);
  });

  // Playback and sync

  function render() {
    playBtn.textContent = wantPlay ? 'Pause' : 'Play';
    if (stalled.size) setStatus('Buffering…');
    else setStatus(wantPlay ? 'Playing · drag the handle' : 'Paused · drag the handle');
  }

  function apply() {
    if (!loaded) return;
    const go = wantPlay && inView && stalled.size === 0 && !looping;
    if (go && !slave.seeking && Math.abs(slave.currentTime - master.currentTime) > HARD_DRIFT) {
      slave.currentTime = master.currentTime;
    }
    for (const v of videos) {
      if (go) {
        // An ended slave waits for the master's rewind instead of restarting alone.
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

  function setSlaveRate(rate) {
    if (slave.playbackRate !== rate) slave.playbackRate = rate;
  }

  // Small drift is closed by running the slave slightly fast or slow; seeking is kept for
  // drift a viewer would notice, since even a cheap seek briefly stalls the decoder.
  function tick() {
    if (loaded && !looping && !master.paused && !slave.seeking && !master.seeking) {
      const d = slave.currentTime - master.currentTime;
      const drift = Math.abs(d);
      if (drift > HARD_DRIFT) {
        setSlaveRate(1);
        slave.currentTime = master.currentTime;
      } else if (drift > SOFT_DRIFT) {
        setSlaveRate(d > 0 ? 1 - NUDGE : 1 + NUDGE); // slave ahead → slow down; behind → speed up
      } else {
        setSlaveRate(1);
      }
    }
    schedule();
  }

  function schedule() {
    if (hasFrameCallback) master.requestVideoFrameCallback(tick);
    else requestAnimationFrame(tick);
  }

  // No loop attribute: pause both, rewind both, and only play once both seeks have landed.
  async function restart() {
    looping = true;
    for (const v of videos) v.pause();
    await Promise.all(videos.map((v) => new Promise((resolve) => {
      v.addEventListener('seeked', resolve, { once: true });
      v.currentTime = 0;
    })));
    setSlaveRate(1);
    looping = false;
    apply();
  }

  function begin() {
    loaded = true;
    for (const v of videos) {
      v.addEventListener('waiting', () => {
        if (v.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) return;
        stalled.add(v);
        apply();
      });
      v.addEventListener('canplay', () => {
        if (stalled.delete(v)) apply();
      });
    }
    master.addEventListener('ended', restart);

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
