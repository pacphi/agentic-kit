// Ruflo's memory backup and distillation, observed from what Ruflo itself
// writes. ak supplements Ruflo here and never runs either job (audit 2026-09-26
// addendum: "ak facilitates and monitors; it does not run parallel copies").
//
// Sources (Ruflo 3.45.0, @claude-flow/cli dist/src):
// - the daemon's `backup` worker (24 h interval, keeps 7) writes
//   <root>/.claude-flow/metrics/backup.json {timestamp, backedUp, error|skipped}
//   (services/worker-daemon.js runBackupWorker). Its first run is 10 min after
//   the daemon starts, or later if the last backup is under 24 h old
//   (scheduleWorker), and the daemon ends at its 12 h TTL: in practice one
//   backup per daemon start, at most daily;
// - every backup, daemon or `ruflo memory backup`, lands as
//   <db dir>/backups/memory-<ISO>.db (services/memory-backup.js); the manual
//   command writes no metrics file, so the newest snapshot counts too;
// - the daemon's `consolidate` worker (ADR-174 distillation, every 30 min)
//   writes <root>/.claude-flow/metrics/consolidation.json
//   {timestamp, distillationEnabled, error?, corrupt?}.
// Both workers hard-code <root>/.swarm/memory.db (memory-distillation.js
// defaultMemoryDbPath), so neither covers agentdb-memory.db, the MCP store.
// A manual backup of it (`ruflo memory backup --db .swarm/agentdb-memory.db
// --dir .swarm/backups/agentdb`, verified in a sandbox on 3.45.0) needs its own
// folder: rotation keeps the newest N of every memory-*.db in the destination.
// Read-only and bounded: two small JSON files and two directory listings.
import fs from 'node:fs';
import path from 'node:path';
import * as paths from './paths.mjs';

/** Twice the backup worker's 24 h interval. */
export const BACKUP_STALE_MS = 48 * 60 * 60 * 1000;
const MAX_METRIC_BYTES = 1024 * 1024;
const SNAPSHOT = /^memory-.*\.db$/;

const oneLine = (text) => String(text).replace(/\s+/g, ' ').trim().slice(0, 160);

function readMetric(file) {
  try {
    if (fs.statSync(file).size > MAX_METRIC_BYTES) return null;
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!value || typeof value !== 'object') return null;
    const at = Date.parse(value.timestamp);
    return Number.isFinite(at) ? { ...value, at } : null;
  } catch {
    return null;
  }
}

/** Newest Ruflo snapshot (memory-<ISO>.db) directly inside `dir`, by mtime. */
function newestSnapshotAt(dir) {
  let newest = null;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const entry of entries) {
    if (!entry.isFile() || !SNAPSHOT.test(entry.name)) continue;
    try {
      const at = fs.statSync(path.join(dir, entry.name)).mtimeMs;
      if (newest === null || at > newest) newest = at;
    } catch { /* vanished between listing and stat */ }
  }
  return newest;
}

export function memoryMaintenanceStatus(root, { now = Date.now() } = {}) {
  const metrics = path.join(paths.projectClaudeFlowDir(root), 'metrics');
  const backups = path.join(root, '.swarm', 'backups');
  const record = readMetric(path.join(metrics, 'backup.json'));
  const good = [record?.backedUp === true ? record.at : null, newestSnapshotAt(backups)]
    .filter((at) => Number.isFinite(at));
  const lastAt = good.length ? Math.max(...good) : null;
  // A skip because memory.db did not exist yet is not a failed backup, and a
  // failure older than the last good backup is history.
  const failed = record && record.backedUp !== true && record.skipped !== 'no-db'
    && (lastAt === null || record.at > lastAt)
    ? { at: record.at, reason: oneLine(record.error ?? record.skipped ?? 'no reason recorded') }
    : null;
  const distill = readMetric(path.join(metrics, 'consolidation.json'));
  const mcpAt = newestSnapshotAt(path.join(backups, 'agentdb'));
  return {
    backup: {
      lastAt,
      ageMs: lastAt === null ? null : Math.max(0, now - lastAt),
      stale: lastAt === null || now - lastAt > BACKUP_STALE_MS,
      failed,
    },
    distillation: distill && {
      ageMs: Math.max(0, now - distill.at),
      enabled: distill.distillationEnabled !== false,
      failed: distill.error ? oneLine(distill.error)
        : distill.corrupt === true ? `memory.db reported corrupt${distill.skipped ? ` (${oneLine(distill.skipped)})` : ''}` : null,
    },
    mcpStoreBackup: mcpAt === null ? null : { ageMs: Math.max(0, now - mcpAt) },
  };
}
