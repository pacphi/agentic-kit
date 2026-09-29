// Read-only metadata observations for OpenCode stores that the V1 reader does
// not consume. The caller owns database selection, handle lifetime and root.
import fs from 'node:fs';
import path from 'node:path';

const MAX_ENTRIES = 256;
const MAX_DEPTH = 5;
const status = (value) => ({ status: value });

/** @param {import('node:sqlite').DatabaseSync | null} db */
function observeV2(db) {
  if (db == null) return status('not-observed');
  try {
    const schema = db.prepare("SELECT type FROM sqlite_master WHERE name = 'session_message' LIMIT 1").get();
    if (schema == null) return status('missing');
    if (schema.type !== 'table') return status('unknown');
    return status(db.prepare('SELECT 1 FROM session_message LIMIT 1').get() == null ? 'empty' : 'present');
  } catch {
    return status('unknown');
  }
}

/** @param {string} child @param {string} name @param {number} depth @param {number} maxDepth @param {Array<{directory: string, depth: number}>} pending */
function inspectLegacyEntry(child, name, depth, maxDepth, pending) {
  const info = fs.lstatSync(child);
  if (info.isSymbolicLink()) return 'incomplete';
  if (info.isFile() && name.toLowerCase().endsWith('.json')) return 'present';
  if (!info.isDirectory()) return 'continue';
  if (depth >= maxDepth) return 'incomplete';
  pending.push({ directory: child, depth: depth + 1 });
  return 'continue';
}

/** @param {string | null} root @param {number} maxEntries @param {number} maxDepth */
function observeLegacy(root, maxEntries, maxDepth) {
  if (root == null) return status('not-observed');
  if (typeof root !== 'string' || !path.isAbsolute(root)) return status('unknown');
  try {
    let info;
    try { info = fs.lstatSync(root); }
    catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return status('absent');
      return status('unknown');
    }
    if (!info.isDirectory()) return status('unknown');
    const pending = [{ directory: root, depth: 0 }];
    let entries = 0;
    let incomplete = false;
    while (pending.length) {
      const { directory, depth } = pending.shift();
      const handle = fs.opendirSync(directory);
      try {
        let entry;
        while ((entry = handle.readSync()) !== null) {
          if (++entries > maxEntries) return status('unknown');
          const child = path.join(directory, entry.name);
          const finding = inspectLegacyEntry(child, entry.name, depth, maxDepth, pending);
          if (finding === 'present') return status('present');
          if (finding === 'incomplete') incomplete = true;
        }
      } finally { handle.closeSync(); }
    }
    return status(incomplete ? 'unknown' : 'absent');
  } catch {
    return status('unknown');
  }
}

/**
 * Observe unsupported storage without reading message bodies or JSON content.
 * `db` must already be opened read-only by the caller. Null means unobserved.
 * Limits are clamped so caller mistakes cannot turn this into an unbounded walk.
 * @param {{db?: import('node:sqlite').DatabaseSync | null, legacyRoot?: string | null, maxEntries?: number, maxDepth?: number}} [options]
 * @returns {{v2: {status: string}, legacy: {status: string}, warnings: string[]}}
 */
export function observeOpencodeStorageCoverage({ db = null, legacyRoot = null, maxEntries = MAX_ENTRIES, maxDepth = MAX_DEPTH } = {}) {
  const entryLimit = Number.isInteger(maxEntries) && maxEntries > 0 ? Math.min(maxEntries, MAX_ENTRIES) : MAX_ENTRIES;
  const depthLimit = Number.isInteger(maxDepth) && maxDepth >= 0 ? Math.min(maxDepth, MAX_DEPTH) : MAX_DEPTH;
  const v2 = observeV2(db);
  const legacy = observeLegacy(legacyRoot, entryLimit, depthLimit);
  const warnings = [];
  if (v2.status === 'present') warnings.push('opencode-v2-session-message-present');
  if (v2.status === 'unknown') warnings.push('opencode-v2-observation-incomplete');
  if (legacy.status === 'present') warnings.push('opencode-legacy-json-present');
  if (legacy.status === 'unknown') warnings.push('opencode-legacy-observation-incomplete');
  return { v2, legacy, warnings };
}
