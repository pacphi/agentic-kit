// daemons
//
// Ruflo's memory backup (at most daily, first about 10 min after start) and
// distillation (every 30 min) run only as workers inside a project's daemon,
// and the daemon ends itself (12 h TTL; 30 min with no worker activity;
// worker-daemon.js, 3.45.0). So "none running" is not "ok" for a project
// with a memory.db: nothing backs it up. That row is information with the start
// command in its message, never a sync fix: starting a long-lived process is a
// human decision. When Ruflo's start-on-use is off, the row names the setting.
import fs from 'node:fs';
import {
  listDaemons as listRufloDaemons, projectDaemonAlive, rufloAutostartOff, staleDaemons,
} from '../../../lib/daemons.mjs';
import * as paths from '../../../lib/paths.mjs';
import { memoryProjectRoot } from '../../../lib/ruflo-memory.mjs';
import { row } from '../row.mjs';

function ownDaemonMissing(cwd, env, running) {
  let root;
  try { root = memoryProjectRoot(cwd); } catch { return null; }
  if (!fs.existsSync(paths.projectMemoryDb(root)) || projectDaemonAlive(root)) return null;
  const off = rufloAutostartOff(root, env);
  const whoWrote = off?.startsWith('.claude/settings.json') ? ' (ruflo init writes it and ak setup keeps it)' : '';
  return `${running ? `${running} running, none` : 'none running'} for this project: Ruflo's memory backup and `
    + 'distillation run only inside its daemon; start one with `ruflo daemon start`'
    + (off ? `. Ruflo's start-on-use is off: ${off}${whoWrote}` : '');
}

export default {
  id: 'daemons',
  async collect({ cwd, listDaemons = listRufloDaemons, env = process.env }) {
    const rows = [];
    try {
      const daemons = await listDaemons({ cwd });
      const stale = staleDaemons(daemons);
      const missing = stale.length ? null : ownDaemonMissing(cwd, env, daemons.length);
      if (stale.length) {
        rows.push(row('daemons', 'warn',
          `${daemons.length} running, ${stale.length} stale (orphaned or past TTL)`, 'sync reaps stale daemons'));
      } else if (missing) {
        rows.push(row('daemons', 'info', missing));
      } else {
        rows.push(row('daemons', 'ok',
          daemons.length ? `${daemons.length} running (one per active project is expected)` : 'none running'));
      }
    } catch (e) {
      rows.push(row('daemons', 'warn', `daemon check unavailable: ${e.message}`));
    }
    return rows;
  },
};
