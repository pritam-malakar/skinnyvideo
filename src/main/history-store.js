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

/* How a row's `name` is to be rendered:
     'files'  — a multi-file drop; the row appends "+ (files - 1) more"
     'folder' — a dropped folder; renders verbatim
     'custom' — the operator renamed the batch inline; renders verbatim */
const KINDS = new Set(['files', 'folder', 'custom']);

/* Entries written before v3.0.2 have no `kind` and carry the suffix baked
   into `name` ("C0038.mov + 12 more"). Strip it and mark them 'files'; the
   suffix's number is DISCARDED rather than trusted, because it is the very
   number that was wrong — the row re-derives it from `files`. A pre-3.0.2
   name with no suffix was a folder drop or a rename, and 'folder' renders
   both verbatim, which is what they did before. Pure function over one
   entry; applied on read so no migration pass has to rewrite prefs.json. */
const BAKED_SUFFIX = / \+ \d+ more$/;
function migrateHistoryEntry(entry) {
  if (!entry || typeof entry !== 'object') return entry;
  if (KINDS.has(entry.kind)) return entry;
  const name = typeof entry.name === 'string' ? entry.name : '';
  return BAKED_SUFFIX.test(name)
    ? { ...entry, name: name.replace(BAKED_SUFFIX, ''), kind: 'files' }
    : { ...entry, kind: 'folder' };
}

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
  /* v3.0.2 — `name` is the BARE name (first filename, folder name, or the
     operator's rename) and `kind` says how to render it. The "+ N more"
     suffix is NOT stored: it is derived at render time from `files`, the one
     count in this record, so the row can never say "+ 12 more · 12 videos"
     the way a baked string could. Unknown kinds fall back to 'folder', which
     renders verbatim — the safe direction, since a wrong verbatim name is
     merely unhelpful while a wrong count is a lie. */
  const kind = KINDS.has(h.kind) ? h.kind : 'folder';
  return {
    at,
    name,
    kind,
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

/* Read side — same defensive guard, so a corrupt/missing key reads empty.
   Every entry goes through migrateHistoryEntry on the way out, so a store
   written by any earlier version renders correctly with no user action and
   without rewriting prefs.json on load. */
function readHistory(store) {
  return Array.isArray(store.history) ? store.history.map(migrateHistoryEntry) : [];
}

module.exports = {
  HISTORY_CAP, KINDS, sanitizeHistoryEntry, appendHistoryEntry, readHistory, migrateHistoryEntry
};
