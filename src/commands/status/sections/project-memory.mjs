// Project memory may legitimately have two stores: the compatibility/sql.js
// memory.db and the native bridge's plaintext agentdb-memory.db sibling.
// Presence cannot establish the active writer or CLI/MCP routing; which
// interface reads which file is stated only for an observed Ruflo release and
// platform (ruflo-memory-contract.mjs). The isolated `ak x verify memory`
// proof does not prove access to an existing corpus.
//
// The canonical store is `<root>/.swarm` for the root every ak launch contract
// pins (rufloMemoryLocation: the repository root, else the folder), so a status
// run from a subfolder reports the same store the hosts use. Outside any usable
// folder, one row names the user-level store the hosts' launcher uses instead. Size, WAL, the
// largest namespace and its expiry come from a read-only query; stray stores
// (project-memory.mjs findStrayMemoryStores) are information only, never a
// warning or a sync fix: ak leaves them in place, and a warning with no way to
// resolve it would stay amber forever (#237/#238 comments, audit N4). The
// exception is a stray AQE store with a memory.db: `ak x aqe-store merge`
// resolves it, so it is a warning with that command as a hand fix.
//
// Backup and distillation ages come from what Ruflo's daemon workers and
// `ruflo memory backup` write (memory-maintenance.mjs). A backup older than
// 48 h, or none, warns only when no daemon runs for this project to take the
// next one; a failed attempt always warns. Distillation age alone never warns:
// the daemon ends itself on its TTL, so that would be amber forever. Both jobs
// cover memory.db only, so an agentdb-memory.db gets an information row with
// the manual backup command (upstream gap).
import fs from 'node:fs';
import path from 'node:path';
import { projectDaemonAlive } from '../../../lib/daemons.mjs';
import { formatLiveCheckAge as ago } from '../../../lib/live-check-evidence.mjs';
import { memoryMaintenanceStatus } from '../../../lib/memory-maintenance.mjs';
import { findStrayMemoryStores, projectMemoryStatus } from '../../../lib/project-memory.mjs';
import { findProbeRows } from '../../../lib/memory-probe-cleanup.mjs';
import * as paths from '../../../lib/paths.mjs';
import { rufloMemoryLocation } from '../../../lib/ruflo-memory.mjs';
import { MEMORY_ROOT_PIN, MEMORY_ROOT_UPSTREAM, rufloMemoryRedirect } from '../../../lib/ruflo-memory-config.mjs';
import { installedRoutingVersion, twoStoreMessage } from '../../../lib/ruflo-memory-contract.mjs';
import { projectSetupHint } from '../../../lib/setup-scope.mjs';
import { row } from '../row.mjs';

export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)} KB`;
  return `${Math.round(n)} B`;
}

function expiryClause(top) {
  if (top.expiring === null) return '';
  if (top.expiring === 0) return ', no expiry set';
  if (top.expiring === top.entries) return ', all set to expire';
  return `, ${top.expiring} set to expire`;
}

export function storeMessage(store) {
  const name = path.basename(store.file);
  const size = `${formatBytes(store.sizeBytes)}, WAL ${formatBytes(store.walBytes)}`;
  if (!store.table) return `${name}: no memory table yet (${size}); Ruflo adds it on the first write`;
  const top = store.top
    ? `; top namespace "${store.top.namespace}" ${Math.round((store.top.entries / store.entries) * 100)}%${expiryClause(store.top)}`
    : '';
  return `${name}: ${store.entries} active entr${store.entries === 1 ? 'y' : 'ies'} observed (${size}${top}); `
    + 'backend, writer and existing-corpus routing unverified';
}

const LIST_LIMIT = 5;
const listed = (strays) => {
  const names = strays.slice(0, LIST_LIMIT).map((stray) => stray.path);
  return strays.length > LIST_LIMIT ? `${names.join(', ')} and ${strays.length - LIST_LIMIT} more` : names.join(', ');
};
const sized = (strays) => formatBytes(strays.reduce((sum, stray) => sum + (stray.sizeBytes ?? 0), 0));
const them = (strays) => (strays.length === 1 ? 'it' : 'them');
const reportOnly = (strays) => `ak reports ${them(strays)} only and leaves ${them(strays)} in place`;

// One row per owner, so the reader sees who made each stray, not a file list.
/** @type {Array<[string, (strays: Array<{path: string, sizeBytes: number|null}>) => string]>} */
const STRAY_ROWS = [
  ['ruflo', (s) => `${s.length} stray Ruflo store${s.length === 1 ? '' : 's'} outside the canonical .swarm: ${listed(s)} (${sized(s)} with WAL); `
    + `a Ruflo command ran with that folder as its working directory, and this project's hosts do not read ${them(s)}; ${reportOnly(s)}`],
  ['agentdb-cli', (s) => `stray store ${listed(s)} (${sized(s)}): the AgentDB CLI's default file in the working directory, not a Ruflo project store; ${reportOnly(s)}`],
  ['agentdb-rvf', (s) => `stray store ${listed(s)} (${sized(s)}): AgentDB's RVF backend default in the working directory; ${reportOnly(s)}`],
  ['ruvector', (s) => `stray store ${listed(s)} (${sized(s)}): RuVector's default store in the working directory; ${reportOnly(s)}`],
  ['aqe', (s) => `${s.length} stray AQE store${s.length === 1 ? '' : 's'} below the project root: ${listed(s)}; `
    + `AQE made ${them(s)} when a command, hook or MCP server started in that folder without ak's pin to the project root `
    + `(ak sync pins AQE_PROJECT_ROOT, AQE_MEMORY_PATH and AQE_STORAGE_PATH); ${aqeOutcome(s)}`],
];

// A stray AQE folder with a memory.db holds learning the hosts never read, and
// `ak x aqe-store merge` resolves it: a hand fix, not a sync step (B5-D2). A
// folder without memory.db has nothing to merge and stays information.
const mergeable = (strays) => strays.some((stray) => fs.existsSync(path.join(stray.file, 'memory.db')));
const aqeOutcome = (strays) => (mergeable(strays)
  ? '`ak x aqe-store merge` moves their patterns and experiences into the project store and archives the folders'
  : reportOnly(strays));

function strayRows(root) {
  const { strays, complete, visited } = findStrayMemoryStores(root);
  const rows = [];
  for (const [kind, message] of STRAY_ROWS) {
    const matching = strays.filter((stray) => stray.kind === kind);
    if (!matching.length) continue;
    if (kind === 'aqe' && mergeable(matching)) {
      rows.push(row('memory', 'warn', message(matching), 'ak x aqe-store merge --dry-run', { repair: 'manual' }));
    } else rows.push(row('memory', 'info', message(matching)));
  }
  if (!complete) rows.push(row('memory', 'info', `stray-store search stopped after ${visited} folders; deeper folders were not checked`));
  return rows;
}

// A Ruflo JSON configuration whose memory path points away from a populated
// .swarm store (ruvnet/ruflo#3193: a command that persists Ruflo settings can
// create one from defaults). CLI calls under ak's pin still reach .swarm, but
// the MCP store and any unpinned `ruflo` command follow the configuration.
// Manual: ak never edits a configuration it did not write.
function orphanedStoreRow(root, memory) {
  const setting = rufloMemoryRedirect(root);
  if (!setting) return null;
  const populated = memory.stores.filter((store) => store.present && store.readable && store.entries > 0);
  if (!populated.length) return null;
  const entries = populated.reduce((sum, store) => sum + store.entries, 0);
  const files = populated.map((store) => path.basename(store.file)).join(', ');
  return row('memory', 'warn', `${setting.name} sets ${setting.key} to "${setting.value}", which points Ruflo memory away from `
    + `the ${entries} entr${entries === 1 ? 'y' : 'ies'} in .swarm (${files}): Ruflo's MCP store and any \`ruflo\` command run here `
    + `without ak's pin look there instead (${MEMORY_ROOT_UPSTREAM})`,
  `set ${setting.key} to "${MEMORY_ROOT_PIN}" in ${setting.name}, or remove the key`, { repair: 'manual' });
}

function backupRow({ lastAt, ageMs, stale, failed }, daemon, now) {
  const last = lastAt === null ? null : `last memory.db backup ${ago(ageMs)}`;
  if (failed) {
    return row('memory', 'warn', `last memory.db backup attempt failed ${ago(now - failed.at)}: ${failed.reason}`
      + (lastAt === null ? '' : `; the last good one was ${ago(ageMs)}`));
  }
  if (!stale) return row('memory', 'info', `${last} (Ruflo's daemon backs it up at most daily; \`ruflo memory backup\` on demand)`);
  if (daemon) {
    return row('memory', 'info', `${last ?? 'no memory.db backup recorded yet'}; this project's daemon is running and takes the next one`);
  }
  return row('memory', 'warn', `${last ?? 'no memory.db backup recorded'}; Ruflo backs it up at most daily and only while this project's `
    + 'daemon runs, and none is running',
  'from the project root, start the daemon with `ruflo daemon start` or run `ruflo memory backup`', { repair: 'manual' });
}

function distillRow(distillation, daemon) {
  const idle = daemon ? '' : '; no daemon is running for this project';
  if (!distillation) return row('memory', 'info', `no daemon distillation recorded for memory.db yet${idle}`);
  const age = ago(distillation.ageMs);
  if (distillation.failed) return row('memory', 'warn', `last daemon distillation ${age} failed: ${distillation.failed}`);
  if (!distillation.enabled) return row('memory', 'info', `daemon distillation is off (RUFLO_DAEMON_NO_DISTILL); last recorded ${age}`);
  return row('memory', 'info', `last daemon distillation ${age} (every 30 min while this project's daemon runs${idle})`);
}

function maintenanceRows(root, memory, now) {
  const present = (kind) => memory.stores.find((store) => store.kind === kind && store.present);
  const status = memoryMaintenanceStatus(root, { now });
  const daemon = projectDaemonAlive(root);
  const rows = [];
  if (present('sqljs')) rows.push(backupRow(status.backup, daemon, now), distillRow(status.distillation, daemon));
  const native = present('native-agentdb');
  if (native) {
    rows.push(row('memory', 'info', `Ruflo's backup and distillation cover memory.db only; agentdb-memory.db `
      + `(${formatBytes((native.sizeBytes ?? 0) + (native.walBytes ?? 0))} with WAL, the MCP store) gets neither (upstream gap)`
      + (status.mcpStoreBackup
        ? `; last manual backup in .swarm/backups/agentdb ${ago(status.mcpStoreBackup.ageMs)}`
        : '. Back it up from the project root with `ruflo memory backup --db .swarm/agentdb-memory.db --dir .swarm/backups/agentdb`')));
  }
  return rows;
}

/** ak's old setup probe rows in `dir`'s stores that ak has not cleaned yet
 *  (decision B3-D2): one warn row that `ak sync` repairs, or none. An
 *  unreadable store is already reported by the store rows. */
export function probeRowsRow(dir, cfg) {
  const cleaned = cfg?.cleanups?.setupProbeRows ?? {};
  const stores = findProbeRows(dir).filter((store) => !store.error && !Object.hasOwn(cleaned, store.file));
  const count = stores.reduce((sum, store) => sum + store.rows.length, 0);
  if (!count) return null;
  const perFile = stores.map((store) => `${path.basename(store.file)} ${store.rows.length}`).join(', ');
  return row('memory', 'warn', `${count} old ak setup probe row${count === 1 ? '' : 's'} in ${dir} (${perFile}; `
    + 'Ruflo\'s own delete leaves the AgentDB mirror, ruvnet/ruflo#3450)', 'sync backs up the store and removes exactly those rows');
}

// Outside any usable folder (the filesystem root, the home folder, a temporary
// root, a tool's own folder) there is no project store to describe, and
// walking such a folder for strays would be slow and meaningless: name the
// store the hosts' launcher uses from here instead (user-memory.mjs reports it).
const launcherRow = (location) => row('memory', 'info', `no project here: this folder is ${location.reason}, so Claude Code's and `
  + `Codex's Ruflo launcher (\`ak x ruflo-mcp\`) uses the user-level store ${location.dir} instead of creating .swarm here`);

export default {
  id: 'memory',
  async collect({
    cwd, cfg, rufloVersion = installedRoutingVersion(), platform = process.platform, now = Date.now(), home = paths.home,
  }) {
    const rows = [];
    try {
      const location = rufloMemoryLocation(cwd, { home });
      if (location.kind === 'user') return [launcherRow(location)];
      const root = location.root;
      const memory = projectMemoryStatus(root);
      if (!memory.active) {
        rows.push(row('memory', 'info', `no project memory store yet (${projectSetupHint(cwd, 'initialize')})`));
      } else {
        rows.push(row('memory', 'info', `canonical project store: ${path.join(root, '.swarm')} (where ak points every host's Ruflo memory)`));
        for (const store of memory.stores.filter((candidate) => candidate.present)) {
          rows.push(row('memory', store.readable ? 'info' : 'warn', store.readable
            ? storeMessage(store)
            : `${path.basename(store.file)} store is unreadable (${store.file}); existing-corpus access unverified`));
        }
        if (memory.secondary) rows.push(row('memory', 'warn', twoStoreMessage(rufloVersion, platform)));
        const orphaned = orphanedStoreRow(root, memory);
        if (orphaned) rows.push(orphaned);
        rows.push(...maintenanceRows(root, memory, now));
        const probes = probeRowsRow(location.dir, cfg);
        if (probes) rows.push(probes);
      }
      rows.push(...strayRows(root));
    } catch (e) {
      rows.push(row('memory', 'warn', `project memory check unavailable: ${e.message}`));
    }
    return rows;
  },
};
