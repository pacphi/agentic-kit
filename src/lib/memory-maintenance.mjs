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
// Read-only and bounded: two small JSON files, two directory listings and the
// last 64 KiB of the daemon log.
//
// Why a live daemon has not run a job (Ruflo 3.46.1): before each run the
// daemon checks CPU load and os.freemem() (worker-daemon.js:584-598) and, when
// either fails, logs `Worker <type> deferred: <reason>` (:1160) through log()
// (:1874-1881), which appends `[<ISO>] [INFO] <message>` to
// <root>/.claude-flow/logs/daemon.log. On macOS os.freemem() excludes the file
// cache, so the default 5% floor (:165) defers work on a busy machine
// (ruvnet/ruflo#2935, open). The log is append-only across daemons; every
// start logs `Daemon started (PID: …` (:828), so only later lines describe the
// daemon running now.
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

const LOG_TAIL_BYTES = 64 * 1024;
const DAEMON_STARTED = /^\[([^\]]+)\] \[INFO\] Daemon started \(PID: /;
const DEFERRED = /^\[([^\]]+)\] \[INFO\] Worker (backup|consolidate) deferred: (.+)$/;

/** The last LOG_TAIL_BYTES of `file` as lines (the first, likely partial, line dropped). */
function logTail(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const { size } = fs.fstatSync(fd);
    const length = Math.min(size, LOG_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    const lines = buffer.toString('utf8').split('\n');
    return size > length ? lines.slice(1) : lines;
  } catch {
    return [];
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** The newest resource deferral of the backup or distillation (`consolidate`)
 *  worker logged by the daemon running now, or null. A max-concurrent deferral
 *  is transient (the worker runs when a slot frees) and is not counted. */
export function lastWorkerDeferral(root, { now = Date.now() } = {}) {
  let found = null;
  for (const line of logTail(path.join(paths.projectClaudeFlowDir(root), 'logs', 'daemon.log'))) {
    if (DAEMON_STARTED.test(line)) { found = null; continue; }
    const match = DEFERRED.exec(line);
    if (!match || /^max concurrent/.test(match[3])) continue;
    const at = Date.parse(match[1]);
    if (Number.isFinite(at)) found = { worker: match[2], reason: oneLine(match[3]), at, ageMs: Math.max(0, now - at) };
  }
  return found;
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

/** lastWorkerDeferral, unless that job has run since (its metrics file is
 *  newer): the deferral a live daemon is still stuck on, or null. */
export function pendingDeferral(root, { now = Date.now() } = {}) {
  const deferred = lastWorkerDeferral(root, { now });
  if (!deferred) return null;
  const status = memoryMaintenanceStatus(root, { now });
  const lastRun = deferred.worker === 'backup' ? status.backup.lastAt
    : status.distillation && now - status.distillation.ageMs;
  return Number.isFinite(lastRun) && lastRun >= deferred.at ? null : deferred;
}
