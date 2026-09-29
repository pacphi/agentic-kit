// Ruflo memory outside any project (audit 2026-09-26 Addendum 2, problem 2).
// ak's launcher (`ak x ruflo-mcp`, used by Claude Code and Codex) sends a session started at the
// filesystem root, the home folder, a temporary root or inside a tool's own
// folder to ONE user-level store (paths.userMemoryDir). This section reports
// that store when it exists, and the stray stores such sessions left before:
// `~/.swarm` and `~/.codex/.chatgpt-projects/*/.swarm`. Everything here is
// information only: ak never moves, merges or deletes a store.
import fs from 'node:fs';
import path from 'node:path';
import * as paths from '../../../lib/paths.mjs';
import { findUserStrayStores, memoryDirStatus } from '../../../lib/project-memory.mjs';
import { homeRelative } from '../../../lib/ruflo-memory.mjs';
import { formatBytes, probeRowsRow, storeMessage } from './project-memory.mjs';
import { row } from '../row.mjs';

function strayRow(found, home, userDir) {
  const { strays } = found;
  if (!strays.length) return null;
  const parts = [];
  const atHome = strays.find((stray) => stray.where === 'home');
  if (atHome) parts.push(`${homeRelative(atHome.dir, home)} (${formatBytes(atHome.sizeBytes)} with WAL)`);
  const codex = strays.filter((stray) => stray.where === 'codex-projects');
  if (codex.length) {
    parts.push(`${codex.length} under ${homeRelative(found.projectsDir, home)} `
      + `(${formatBytes(codex.reduce((sum, stray) => sum + stray.sizeBytes, 0))} with WAL)`);
  }
  const count = (atHome ? 1 : 0) + codex.length;
  const them = count === 1 ? 'it' : 'them';
  return row('memory', 'info', `${count} stray Ruflo store${count === 1 ? '' : 's'} outside any project: ${parts.join(' and ')}. `
    + `Ruflo ran with those folders as its working directory; ak's launcher now uses ${homeRelative(userDir, home)} there instead. `
    + `ak reports ${them} only and leaves ${them} in place`
    + (found.complete ? '' : '; only the first 500 Codex project folders were checked'));
}

function homeAqeRow(home) {
  const dir = path.join(home, '.agentic-qe');
  let folder;
  try { folder = fs.lstatSync(dir); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  if (!folder.isDirectory()) return row('aqe', 'info', `AQE home path ${dir} is not a directory; contents unverified`);
  const db = path.join(dir, 'memory.db');
  let file;
  try { file = fs.lstatSync(db); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (!file?.isFile()) return row('aqe', 'info', `AQE home directory ${dir}: memory.db absent; contents and runtime health unverified`);
  let walBytes = 0;
  try {
    const wal = fs.lstatSync(`${db}-wal`);
    if (wal.isFile()) walBytes = wal.size;
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  return row('aqe', 'info', `AQE home directory ${dir}: memory.db present (${formatBytes(file.size + walBytes)} with WAL); contents and runtime health unverified`);
}

export default {
  id: 'user-memory',
  /** @param {{ home?: string, env?: NodeJS.ProcessEnv, cfg?: any }} [ctx] */
  async collect({ home = paths.home, env = process.env, cfg = undefined } = {}) {
    const rows = [];
    try {
      const dir = paths.userMemoryDir(home);
      for (const store of memoryDirStatus(dir).stores.filter((candidate) => candidate.present)) {
        rows.push(row('memory', 'info', store.readable
          ? `user-level store ${dir} (Claude Code's and Codex's Ruflo launcher outside projects): ${storeMessage(store)}`
          : `user-level store ${store.file} is unreadable; existing-corpus access unverified`));
      }
      const probes = probeRowsRow(dir, cfg);
      if (probes) rows.push(probes);
      const found = findUserStrayStores({ home, codexHome: env.CODEX_HOME || undefined });
      const stray = strayRow(found, home, dir);
      if (stray) rows.push(stray);
      const aqe = homeAqeRow(home);
      if (aqe) rows.push(aqe);
    } catch (e) {
      rows.push(row('memory', 'warn', `user-level memory check unavailable: ${e.message}`));
    }
    return rows;
  },
};
