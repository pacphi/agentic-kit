// Embedded SQLite via node:sqlite (Node >=22) — replaces every external
// `sqlite3` binary call from the shell kit (memory verification, WAL
// checkpoint, statusline QE metrics).
import { DatabaseSync } from 'node:sqlite';

/** Run fn against a readonly connection; returns fn's result or fallback on
 *  any error (missing file, locked, missing table). */
export function withDb(file, fn, fallback = null, { readonly = true } = {}) {
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: readonly });
    return fn(db);
  } catch {
    return fallback;
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

export const scalar = (file, sql, fallback = null) =>
  withDb(file, (db) => Object.values(db.prepare(sql).get() ?? {})[0] ?? fallback, fallback);

export const checkpoint = (file) =>
  withDb(file, (db) => { db.exec('PRAGMA wal_checkpoint(TRUNCATE);'); return true; }, false, { readonly: false });
