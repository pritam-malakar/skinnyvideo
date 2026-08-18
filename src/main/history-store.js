/* ─── History ledger (v2.10.0) ────────────────────────────────────────────
   One entry per completed REAL run. Extracted from main's IPC wrapper so the
   cap, the ordering and the shape guard can be exercised by tests against the
   REAL code path (same pattern as ./reveal and ./queue-runner). main.js owns
   the `add-reclaimed` / `get-history` IPC registration; this owns the rules.

   DIVISION OF LABOUR: the renderer owns the two POLICY gates — dry runs never
   call at all (maybeCreditBatch's frozen batch.dryRun check) and neither does
   a batch with zero done files. Main owns only the SHAPE guard below, so a
   malformed payload can never put junk in prefs.json. */

const HISTORY_CAP = 50;

/* Coerce one renderer-supplied entry into the stored shape, or null if it
   isn't a real run. `at` is stamped by the caller (main), never trusted from
   the renderer — same as the lifetime ledger's lastUsed. */
function sanitizeHistoryEntry(h, at) {
  if (!h || typeof h !== 'object') return null;
  const files = Math.max(0, Math.floor(Number(h.files) || 0));
  if (files === 0) return null;          // same skip rule as the drive ledger
  const num = (v) => {
    const n = Math.floor(Number(v) || 0);
    return n > 0 ? n : 0;
  };
  const name = (typeof h.name === 'string' && h.name.trim())
    ? h.name.trim().slice(0, 200)
    : 'Untitled';
  /* Tier is the INTERNAL key. Display labels live in the renderer's
     TIER_LABEL and must never be baked into the store — a stored label would
     freeze today's wording into every past run. */
  const tier = (h.tier === 'regular' || h.tier === 'preserve') ? h.tier : 'regular';
  return {
    at,
    name,
    tier,
    files,
    failed: num(h.failed),
    skipped: num(h.skipped),
    before: num(h.before),
    after: num(h.after),
    reclaimed: num(h.reclaimed),
    /* Degenerate runs (all-skipped, stage failure) carry no run folder. Store
       null rather than inventing a path; the UI drops the Reveal button. */
    runDir: (typeof h.runDir === 'string' && h.runDir) ? h.runDir : null
  };
}

/* Prepend to store.history, newest first, capped at HISTORY_CAP on EVERY
   append so the array can never drift past the cap however it got there.
   Array.isArray guard matches the outputRoots / pendingDests pattern in main:
   a store whose `history` is missing or the wrong type is treated as empty,
   never trusted and never thrown on. Returns the stored entry, or null when
   nothing was appended. */
function appendHistoryEntry(store, rawEntry, at) {
  const entry = sanitizeHistoryEntry(rawEntry, at);
  if (!entry) return null;
  const list = Array.isArray(store.history) ? store.history : [];
  list.unshift(entry);
  store.history = list.slice(0, HISTORY_CAP);
  return entry;
}

/* Read side — same defensive guard, so a corrupt/missing key reads empty. */
function readHistory(store) {
  return Array.isArray(store.history) ? store.history : [];
}

module.exports = { HISTORY_CAP, sanitizeHistoryEntry, appendHistoryEntry, readHistory };
