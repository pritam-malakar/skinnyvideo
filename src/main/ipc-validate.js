'use strict';
/* ─── IPC payload validation ────────────────────────────────────────────────
   The renderer is a trust boundary. Batches arriving on 'start-queue' and
   'enqueue-batch' must match batchToPayload (renderer.js) exactly, or the
   call is refused with a plain message. Pure — no electron — so it is
   unit-testable in plain node. Each validator returns null when valid, else
   the reason string. */

const BATCH_KEYS = new Set(['id', 'src', 'dest', 'tier', 'dryRun', 'kind', 'settings', 'fileSources', 'skipped']);
const isStr = (v) => typeof v === 'string' && v.length > 0;
const isStrArray = (v) => Array.isArray(v) && v.every(isStr);
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function validateBatch(b, tiers) {
  if (!isPlainObject(b)) return 'batch must be an object';
  for (const k of Object.keys(b)) if (!BATCH_KEYS.has(k)) return `unexpected field "${k}"`;
  // ids are the renderer's session counter (nextId++), so a positive integer.
  if (!Number.isInteger(b.id) || b.id < 1) return 'id must be a positive integer';
  if (b.kind !== 'folder' && b.kind !== 'files') return 'kind must be "folder" or "files"';
  // A file-list batch has no single source folder: the renderer sends src null.
  if (b.kind === 'folder' ? !isStr(b.src) : !(b.src === null || isStr(b.src))) {
    return b.kind === 'folder' ? 'src must be a non-empty string' : 'src must be null or a non-empty string';
  }
  if (!isStr(b.dest)) return 'dest must be a non-empty string';
  if (!tiers.includes(b.tier)) return `tier must be one of ${tiers.join(', ')}`;
  if (typeof b.dryRun !== 'boolean') return 'dryRun must be a boolean';
  if (b.settings !== undefined && !isPlainObject(b.settings)) return 'settings must be an object when present';
  if (!isStrArray(b.fileSources)) return 'fileSources must be an array of non-empty strings';
  if (!isStrArray(b.skipped)) return 'skipped must be an array of non-empty strings';
  return null;
}

function validateBatchList(list, tiers) {
  if (!Array.isArray(list)) return 'batches must be an array';
  for (let i = 0; i < list.length; i++) {
    const why = validateBatch(list[i], tiers);
    if (why) return `batch ${i}: ${why}`;
  }
  return null;
}

module.exports = { validateBatch, validateBatchList };
