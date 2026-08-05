// Project-memory observability. The native bridge keeps its plaintext store in
// agentdb-memory.db while the compatibility/sql.js surface remains memory.db.
// Both are legitimate; the native sibling is the active writer when present.
import fs from 'node:fs';
import * as paths from './paths.mjs';
import { withDb } from './sqlite.mjs';

function activityAt(file) {
  let latest = 0;
  for (const candidate of [file, `${file}-wal`]) {
    try { latest = Math.max(latest, fs.statSync(candidate).mtimeMs); } catch { /* absent */ }
  }
  return latest || null;
}

function inspectStore(file, kind) {
  if (!fs.existsSync(file)) {
    return { kind, file, present: false, readable: false, entries: null, activityAt: null };
  }
  const result = withDb(file, (db) => {
    const columns = db.prepare('PRAGMA table_info(memory_entries)').all().map((column) => column.name);
    if (!columns.length) return { readable: false, entries: null };
    const where = columns.includes('status') ? " WHERE status = 'active' OR status IS NULL" : '';
    const entries = db.prepare(`SELECT COUNT(*) AS n FROM memory_entries${where}`).get()?.n ?? 0;
    return { readable: true, entries: Number(entries) };
  });
  const observed = result.ok
    ? result.value
    : { readable: false, entries: null, reason: result.error.kind };
  return { kind, file, present: true, ...observed, activityAt: activityAt(file) };
}

export function projectMemoryStatus(root) {
  const sqljs = inspectStore(paths.projectMemoryDb(root), 'sqljs');
  const native = inspectStore(paths.projectAgentDbMemoryDb(root), 'native-agentdb');
  const active = native.present ? native : sqljs.present ? sqljs : null;
  const secondary = active === native && sqljs.present ? sqljs
    : active === sqljs && native.present ? native : null;
  return { active, secondary, stores: [sqljs, native] };
}

export function memoryEntryExists(file, namespace, key) {
  const result = withDb(file, (db) => {
    const row = db.prepare(
      'SELECT 1 AS found FROM memory_entries WHERE namespace = ? AND key = ? LIMIT 1',
    ).get(namespace, key);
    return row?.found === 1;
  });
  return result.ok ? result.value : false;
}

export function findMemoryEntry(root, namespace, key) {
  const status = projectMemoryStatus(root);
  return status.stores.find((store) => store.present
    && store.readable
    && memoryEntryExists(store.file, namespace, key)) ?? null;
}
