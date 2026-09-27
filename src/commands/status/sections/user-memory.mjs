// Ruflo memory outside any project (audit 2026-09-26 Addendum 2, problem 2).
// Codex's launcher (`ak x ruflo-mcp`) sends a session started at the
// filesystem root, the home folder, a temporary root or inside a tool's own
// folder to ONE user-level store (paths.userMemoryDir). This section reports
// that store when it exists, and the stray stores such sessions left before:
// `~/.swarm` and `~/.codex/.chatgpt-projects/*/.swarm`. Everything here is
// information only: ak never moves, merges or deletes a store.
import * as paths from '../../../lib/paths.mjs';
import { findUserStrayStores, memoryDirStatus } from '../../../lib/project-memory.mjs';
import { homeRelative } from '../../../lib/ruflo-memory.mjs';
import { formatBytes, storeMessage } from './project-memory.mjs';
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
    + `Ruflo ran with those folders as its working directory; Codex's launcher now uses ${homeRelative(userDir, home)} there instead. `
    + `ak reports ${them} only and leaves ${them} in place`
    + (found.complete ? '' : '; only the first 500 Codex project folders were checked'));
}

export default {
  id: 'user-memory',
  async collect({ home = paths.home, env = process.env } = {}) {
    const rows = [];
    try {
      const dir = paths.userMemoryDir(home);
      for (const store of memoryDirStatus(dir).stores.filter((candidate) => candidate.present)) {
        rows.push(row('memory', 'info', store.readable
          ? `user-level store ${dir} (Codex's Ruflo launcher outside projects): ${storeMessage(store)}`
          : `user-level store ${store.file} is unreadable; existing-corpus access unverified`));
      }
      const found = findUserStrayStores({ home, codexHome: env.CODEX_HOME || undefined });
      const stray = strayRow(found, home, dir);
      if (stray) rows.push(stray);
    } catch (e) {
      rows.push(row('memory', 'warn', `user-level memory check unavailable: ${e.message}`));
    }
    return rows;
  },
};
