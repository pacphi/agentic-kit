// Embedded SQLite via node:sqlite (Node >=22) — replaces every external
// `sqlite3` binary call from the shell kit (memory verification, WAL
// checkpoint, statusline QE metrics).
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';

function classify(error, stage) {
  const errcode = Number(error?.errcode);
  const code = typeof error?.code === 'string' ? error.code : null;
  const message = String(error?.message ?? 'SQLite operation failed').replace(/\s+/g, ' ').slice(0, 200);
  let kind = stage === 'close' ? 'close' : 'io';
  if (code === 'ENOENT') kind = 'absent';
  else if (errcode === 5 || errcode === 6 || /\b(?:busy|locked)\b/i.test(message)) kind = 'busy';
  else if (errcode === 11 || errcode === 26 || /malformed|not a database/i.test(message)) kind = 'corrupt';
  else if (stage === 'query' && (errcode === 1 || /^SQLITE_ERROR$/.test(code ?? ''))) kind = 'query';
  return { kind, stage, errcode: Number.isFinite(errcode) ? errcode : null, code, message };
}

/** Run `fn` against a SQLite connection without erasing why it failed.
 * Returns `{ok:true,value}` or `{ok:false,error:{kind,stage,...}}`. */
export function withDb(file, fn, { readonly = true, Database = DatabaseSync } = {}) {
  if (readonly && !fs.existsSync(file)) {
    return { ok: false, error: { kind: 'absent', stage: 'open', errcode: null, code: 'ENOENT', message: 'database file is absent' } };
  }
  let db;
  let result;
  try {
    db = new Database(file, { readOnly: readonly });
    try { result = { ok: true, value: fn(db) }; }
    catch (error) { result = { ok: false, error: classify(error, 'query') }; }
  } catch (error) {
    result = { ok: false, error: classify(error, 'open') };
  } finally {
    if (db) {
      try { db.close(); }
      catch (error) {
        if (result?.ok) result = { ok: false, error: classify(error, 'close') };
      }
    }
  }
  return result;
}

export const scalar = (file, sql, fallback = null) => {
  const result = withDb(file, (db) => Object.values(db.prepare(sql).get() ?? {})[0] ?? fallback);
  return result.ok ? result.value : fallback;
};

export const checkpoint = (file) => {
  const result = withDb(file, (db) => {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE);'); return true;
  }, { readonly: false });
  return result.ok;
};
