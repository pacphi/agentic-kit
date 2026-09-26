// Project memory may legitimately have two stores: the compatibility/sql.js
// memory.db and the native bridge's plaintext agentdb-memory.db sibling.
// Presence cannot establish the active writer or CLI/MCP routing; which
// interface reads which file is stated only for an observed Ruflo release and
// platform (ruflo-memory-contract.mjs). The isolated `ak x verify memory`
// proof does not prove access to an existing corpus.
//
// The canonical store is `<root>/.swarm` for the root every ak launch contract
// pins (memoryProjectRoot: the repository root, else the folder), so a status
// run from a subfolder reports the same store the hosts use. Size, WAL, the
// largest namespace and its expiry come from a read-only query; stray stores
// (project-memory.mjs findStrayMemoryStores) are information only, never a
// warning or a sync fix: ak leaves them in place, and a warning with no way to
// resolve it would stay amber forever (#237/#238 comments, audit N4).
import path from 'node:path';
import { findStrayMemoryStores, projectMemoryStatus } from '../../../lib/project-memory.mjs';
import { memoryProjectRoot } from '../../../lib/ruflo-memory.mjs';
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

function storeMessage(store) {
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
    + `AQE resolves a relative AQE_MEMORY_PATH against the folder a command or hook ran in (this project's is ./.agentic-qe); ${reportOnly(s)}`],
];

function strayRows(root) {
  const { strays, complete, visited } = findStrayMemoryStores(root);
  const rows = [];
  for (const [kind, message] of STRAY_ROWS) {
    const matching = strays.filter((stray) => stray.kind === kind);
    if (matching.length) rows.push(row('memory', 'info', message(matching)));
  }
  if (!complete) rows.push(row('memory', 'info', `stray-store search stopped after ${visited} folders; deeper folders were not checked`));
  return rows;
}

export default {
  id: 'memory',
  async collect({ cwd, rufloVersion = installedRoutingVersion(), platform = process.platform }) {
    const rows = [];
    try {
      const root = memoryProjectRoot(cwd);
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
      }
      rows.push(...strayRows(root));
    } catch (e) {
      rows.push(row('memory', 'warn', `project memory check unavailable: ${e.message}`));
    }
    return rows;
  },
};
