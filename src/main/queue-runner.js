const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { runBatch, dryRunBatch } = require('../encoder/pipeline');
const { flattenRunDir } = require('../encoder/flatten');
const { stageFileList } = require('../encoder/stage');

/* The queue runner — extracted verbatim from main.js's start-queue handler so it
   can be exercised by tests against the REAL code (not a mirror). main.js owns
   the IPC wrapper, prefs/orphan bookkeeping, queueRunning flag, and the final
   'queue-finished' send; this owns the per-batch loop + auto-advance.

   deps:
     send(channel, payload)  — emit an IPC message to the renderer
     isStopRequested()       — true once the user asked to stop after current file
     rt(batchId)             — per-batch runtime state (skips, child, cancelled, …)
   Returns the accumulated totals. */
async function runQueue(batches, { send, isStopRequested, rt }) {
  const totals = { processed: 0, failed: 0, failedCopied: 0, failedNoCopy: 0, failedDestLost: 0, destLost: false, skippedNonVideo: 0, reclaimed: 0, alreadyDone: 0, hdrMetaDropped: 0 };

  /* OPTION A — DRAIN THE LIVE QUEUE: `batches` is a LIVE array. main appends
     mid-run drops to this same object (via 'enqueue-batch'), so the condition
     `i < batches.length` is RE-EVALUATED each turn and absorbs them in this same
     run. Do NOT cache `batches.length` into a const — that would re-freeze the
     queue and strand mid-run drops. The loop ends only when, AT a turn boundary,
     no further batch exists (or stop was requested) — that boundary is synchronous
     between awaits, so a drop either lands before it (drained) or after the run is
     already torn down (a fresh run). Pause parks the loop inside `await runBatch`
     on the SIGSTOP'd child, so no next batch is pulled until resume. */
  for (let i = 0; i < batches.length; i++) {
    if (isStopRequested()) break;
    const batch = batches[i];

    /* PHANTOM FREEZE: a queued batch the operator removed mid-run is
       tombstoned via the 'remove-batch' IPC (rt(id).removed). Skip it BEFORE
       any status/staging/encode — the renderer no longer has its row, so any
       work here would be invisible (the run would look frozen). Checked only
       at the turn boundary: a batch already running is never affected. */
    if (rt(batch.id).removed) continue;

    send('batch-status', { id: batch.id, status: 'Running' });

    const isDry = !!batch.dryRun;
    const state = rt(batch.id);
    state.child = null; state.paused = false; state.cancelled = false; state.resolved = false;

    const control = {
      shouldStop: () => isStopRequested(),
      isCancelled: () => state.cancelled,
      isPaused: () => state.paused,
      onSpawn: (child) => {
        state.child = child;
        if (state.cancelled) {
          try { child.kill('SIGTERM'); } catch {}
          setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 1200);
        }
      }
    };

    /* FIX 1 — AUTO-ADVANCE: a single batch's failure (for ANY reason) must never
       halt the queue. The whole per-batch body is wrapped: on any unexpected
       throw we fail THIS batch and the loop continues to the next. */
    try {

    /* BUG 2 (v2.1.15): AUTHORITATIVE skip filter at THIS batch's turn. rt().skips
       is kept live by the 'set-batch-skips' IPC; fall back to the payload's frozen
       skipped[] if no live update arrived. Skipped ORIGINAL paths are removed from
       fileSources before staging, and passed to runBatch as batch.skip for folder
       batches. TRUE BOUNDARY (v2.7.1): skips are honored only for batches NOT
       YET at their turn — this read happens exactly once, here; after staging,
       the running batch's list is fixed and a later skip toggle does NOT apply
       to it (the renderer no longer offers the control on a running batch's
       rows). A skip is NOT a terminal-state hazard: the skipped file is removed
       up front, so the batch simply finishes Done over its remaining files and
       the loop auto-advances exactly as a no-skip batch does. */
    const skipSet = (state.skips instanceof Set)
      ? state.skips
      : new Set(Array.isArray(batch.skipped) ? batch.skipped : []);
    const effSources = (Array.isArray(batch.fileSources) ? batch.fileSources : [])
      .filter((p) => !skipSet.has(p));
    batch.skip = [...skipSet];

    // All files in a file-list batch skipped → nothing to do; clean Done, advance.
    if (batch.kind === 'files' && (batch.fileSources || []).length > 0 && effSources.length === 0) {
      send('batch-status', { id: batch.id, status: 'Done', result: {
        runDir: null, processed: 0, failed: 0, failedCopied: 0, failedNoCopy: 0, failedDestLost: 0,
        destLost: false, alreadyDone: 0, skippedNonVideo: 0, reclaimed: 0, totalFiles: 0
      } });
      state.resolved = true; state.child = null;
      continue;
    }

    let runSrc = batch.src;
    let tmpCleanup = null;
    let stageMap = new Map();
    let stageMissing = [];
    let stageMethods = null;
    let stageError = null;
    if (batch.kind === 'files' && effSources.length > 0) {
      try {
        const staged = await stageFileList(batch.id, effSources);
        runSrc = staged.stageDir;
        tmpCleanup = staged.tmpRoot;
        stageMap = staged.stageMap;
        stageMissing = staged.missing || [];
        stageMethods = staged.methods || null;
      } catch (e) {
        stageError = e;
      }
    }

    if (stageError) {
      const n = Math.max(1, effSources.length);
      const result = {
        runDir: null, logPath: null,
        processed: 0, failed: n, failedCopied: 0, failedNoCopy: n, failedDestLost: 0,
        destLost: false, alreadyDone: 0, skippedNonVideo: 0, reclaimed: 0, totalFiles: n,
        sourceMissing: true, error: stageError && stageError.message
      };
      totals.failed += n;
      totals.failedNoCopy += n;
      send('batch-status', { id: batch.id, status: 'Failed', result });
      state.resolved = true;
      state.child = null;
      continue;   // queue continues to the next batch — never stuck on Running
    }

    const wrappedBatch = (runSrc === batch.src) ? batch : { ...batch, src: runSrc };

    /* Forward progress to the renderer, translating staged temp paths back to
       original source paths so file rows resolve by exact path (BUG A). */
    const forward = (progress) => {
      let p = progress;
      if (stageMap.size && p && typeof p.file === 'string' && stageMap.has(p.file)) {
        const orig = stageMap.get(p.file);
        p = { ...p, file: orig, basename: path.basename(orig) };
      }
      send('progress', { batchId: batch.id, ...p });
    };

    let result;
    try {
      result = isDry
        ? await dryRunBatch(wrappedBatch, forward)
        : await runBatch(wrappedBatch, control, forward);
    } catch (e) {
      result = {
        runDir: null, logPath: null,
        processed: 0, failed: 0, failedCopied: 0, failedNoCopy: 0, failedDestLost: 0,
        destLost: true, alreadyDone: 0, skippedNonVideo: 0, reclaimed: 0, totalFiles: 0,
        error: e && e.message
      };
    } finally {
      if (tmpCleanup) {
        try { await fsp.rm(tmpCleanup, { recursive: true, force: true }); } catch { /* non-fatal */ }
      }
    }

    /* Per-file staging isolation (v2.1.14 BUG 2): sources that could not be staged
       fail INDIVIDUALLY. Fold them in as source-missing failures + emit a per-file
       event so each missing row resolves to "failed" by exact path. */
    if (stageMissing.length) {
      result.failed = (result.failed || 0) + stageMissing.length;
      result.failedNoCopy = (result.failedNoCopy || 0) + stageMissing.length;
      result.totalFiles = (result.totalFiles || 0) + stageMissing.length;
      result.sourceMissing = true;
      const tot = result.totalFiles || stageMissing.length;
      for (const mp of stageMissing) {
        forward({
          type: 'file-done', index: tot, total: tot,
          file: mp, basename: path.basename(mp),
          outcome: 'fail', failKind: 'source-missing', outBytes: -1,
          processed: result.processed || 0, failed: result.failed || 0,
          alreadyDone: result.alreadyDone || 0
        });
      }
    }

    /* Flatten EVERYTHING into runDir (flat canonical layout). Non-fatal. */
    if (!isDry && result && result.runDir && fs.existsSync(result.runDir)) {
      try {
        const lifted = await flattenRunDir(result.runDir);
        try {
          if (stageMethods) {
            fs.appendFileSync(
              path.join(result.runDir, 'compress.log'),
              `# Staging: hardlinked=${stageMethods.linked} symlinked=${stageMethods.symlinked}`
              + ` copied=${stageMethods.copied} — symlinked = zero-copy stage of a source the`
              + ` temp FS can't hardlink (e.g. SMB); copied>0 means a full pre-encode copy occurred\n`
            );
          }
          fs.appendFileSync(
            path.join(result.runDir, 'compress.log'),
            `# Flatten: lifted=${lifted} — canonical layout is`
            + ` <chosen output>/Compressed_<run>/<files> (flat, no subfolders)\n`
          );
        } catch {}
      } catch (e) { /* non-fatal */ }
    }

    totals.processed += result.processed || 0;
    totals.failed += result.failed || 0;
    totals.failedCopied += result.failedCopied || 0;
    totals.failedNoCopy += result.failedNoCopy || 0;
    totals.failedDestLost += result.failedDestLost || 0;
    if (result.destLost) totals.destLost = true;
    totals.skippedNonVideo += result.skippedNonVideo || 0;
    totals.reclaimed += result.reclaimed || 0;
    totals.alreadyDone += result.alreadyDone || 0;
    totals.hdrMetaDropped += result.hdrMetaDropped || 0;

    let finalStatus;
    if (state.cancelled)                                 finalStatus = 'Cancelled';
    else if (result.destLost && (result.processed || 0) === 0) finalStatus = 'Failed';
    else if (result.failed > 0)                          finalStatus = 'Done (with failures)';
    else                                                 finalStatus = 'Done';

    send('batch-status', { id: batch.id, status: finalStatus, result });
    state.resolved = true;

    } catch (e) {
      /* FIX 1 backstop: any unexpected error in this batch must not halt the queue. */
      if (!state.resolved) {
        send('batch-status', {
          id: batch.id, status: 'Failed',
          result: { runDir: null, processed: 0, failed: 1, failedCopied: 0, failedNoCopy: 1, failedDestLost: 0, destLost: false, reclaimed: 0, error: e && e.message }
        });
        state.resolved = true;
      }
    }

    state.child = null;
    if (isStopRequested()) break;
  }

  return totals;
}

module.exports = { runQueue };
