// One-time cleanup of ak's old setup probe rows (maintainer decision B3-D2).
//
// `ak setup` proves a memory write by storing `_setup/verify-<pid>-<ms>` with
// content `setup-verify` in namespace `_setup`, then deleting it
// (setup.mjs verifyProjectMemoryWrite). Earlier versions stopped at the first
// store that held the row, and Ruflo mirrors the write into
// agentdb-memory.db; its own `memory delete` only tombstones memory.db and
// leaves the mirror active (ruvnet/ruflo#3450, reproduced on 3.46.1). Rows
// from those runs are still in users' stores.
//
// This module finds exactly those rows (namespace, key pattern and content all
// match) in a store folder's memory.db and agentdb-memory.db, backs each
// affected file up with `VACUUM INTO`, deletes the matched ids and nothing
// else, and writes a receipt. No table references memory_entries in either
// 3.46.1 schema (no foreign key, no trigger), so a row delete leaves the
// AgentDB tables consistent. `cleaned` (kit.json cleanups.setupProbeRows)
// records each file once, so a store is cleaned at most once.
import fs from 'node:fs';
import path from 'node:path';
import { withDb } from './sqlite.mjs';

export const PROBE = Object.freeze({ namespace: '_setup', key: /^_setup\/verify-\d+-\d+$/, content: 'setup-verify' });
export const PROBE_STORE_FILES = Object.freeze(['memory.db', 'agentdb-memory.db']);

const BUSY_TIMEOUT_MS = 5000;

function matchingRows(db) {
  const table = db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'memory_entries'").get();
  if (table?.found !== 1) return [];
  return db.prepare("SELECT id, key, content, status FROM memory_entries WHERE namespace = ? AND key LIKE '\\_setup/verify-%' ESCAPE '\\'")
    .all(PROBE.namespace)
    .filter((row) => PROBE.key.test(String(row.key)) && row.content === PROBE.content)
    .map(({ id, key, status }) => ({ id: String(id), key: String(key), status: status == null ? null : String(status) }));
}

/** Read-only: ak's probe rows in `dir`'s two stores, any status. A store that
 *  holds none is left out; an unreadable one is listed with `error` (it may
 *  hold rows, so it is never reported as clean).
 *  @param {string} dir
 *  @returns {Array<{ file: string, rows: Array<{ id: string, key: string, status: string|null }>, error?: string }>} */
export function findProbeRows(dir) {
  const found = [];
  for (const name of PROBE_STORE_FILES) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) continue;
    const result = withDb(file, matchingRows);
    if (!result.ok) found.push({ file, rows: [], error: result.error.kind });
    else if (result.value.length) found.push({ file, rows: result.value });
  }
  return found;
}

const stampOf = (now) => new Date(now).toISOString().replace(/[:.]/g, '-');
const sqlString = (value) => `'${String(value).replaceAll("'", "''")}'`;

function cleanStore(file, ids, backup) {
  return withDb(file, (db) => {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`);
    db.exec(`VACUUM INTO ${sqlString(backup)};`);
    const placeholders = ids.map(() => '?').join(', ');
    const deleted = db.prepare(`DELETE FROM memory_entries WHERE id IN (${placeholders})`).run(...ids).changes;
    db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    return Number(deleted);
  }, { readonly: false });
}

/**
 * Back up, then delete exactly the matched probe rows in each folder's stores.
 * `cleaned` maps a store file to the time it was cleaned; those files are
 * skipped, and each file cleaned now is added to it. With `dryRun` nothing is
 * written and the plan comes back as the receipt. Returns `{ receipt }`, with
 * `receipt: null` when there was nothing to clean (no receipt file is written).
 * @param {string[]} dirs
 * @param {{ dryRun?: boolean, backupRoot: string, receiptDir: string, now?: number, cleaned?: Record<string, string> }} options
 */
export function cleanupProbeRows(dirs, { dryRun = false, backupRoot, receiptDir, now = Date.now(), cleaned = {} }) {
  const at = new Date(now).toISOString();
  const stamp = stampOf(now);
  const stores = [];
  for (const dir of [...new Set(dirs)]) {
    for (const store of findProbeRows(dir)) {
      if (Object.hasOwn(cleaned, store.file)) continue;
      if (store.error) { stores.push({ file: store.file, backup: null, deleted: [], error: store.error }); continue; }
      // `.swarm` → `swarm-memory.db`: a visible name beside the user store's `memory-memory.db`.
      const backup = path.join(backupRoot, stamp, `${path.basename(dir).replace(/^\.+/, '')}-${path.basename(store.file)}`);
      const ids = store.rows.map((row) => row.id);
      if (dryRun) { stores.push({ file: store.file, backup, deleted: store.rows.map((row) => row.key) }); continue; }
      fs.mkdirSync(path.dirname(backup), { recursive: true });
      const result = cleanStore(store.file, ids, backup);
      if (!result.ok) { stores.push({ file: store.file, backup: null, deleted: [], error: result.error.kind }); continue; }
      stores.push({ file: store.file, backup, deleted: store.rows.map((row) => row.key) });
      cleaned[store.file] = at;
    }
  }
  if (!stores.length) return { receipt: null };
  const receipt = { at, dryRun, stores };
  if (!dryRun) {
    fs.mkdirSync(receiptDir, { recursive: true });
    const file = path.join(receiptDir, `${stamp}.json`);
    fs.writeFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`);
    receipt.file = file;
  }
  return { receipt };
}
