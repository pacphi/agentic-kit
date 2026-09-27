// daemons
//
// Ruflo's memory backup (at most daily, first about 10 min after start) and
// distillation (every 30 min) run only as workers inside a project's daemon,
// and the daemon ends itself (12 h TTL; 30 min with no worker activity;
// worker-daemon.js:38-40, 3.46.1). So "none running" is not "ok" for a project
// with a memory.db: nothing backs it up. That row is information, never a sync
// fix: starting a long-lived process is a human decision. With Ruflo's
// start-on-use on, the next `ruflo` command in the project starts it
// (daemon-autostart.js ensureDaemonRunning, 3.46.1); when it is off, the row
// names the setting and the start command.
//
// A live daemon can still skip both jobs: it defers a worker while CPU load or
// free memory is past its threshold, and on macOS the free-memory reading is
// skewed low (ruvnet/ruflo#2935). The deferral row reads the daemon log
// (memory-maintenance.mjs pendingDeferral) and is dropped once the worker's
// own metrics file is newer.
//
// In a Ruflo repository, the drift row compares the project with what ak
// manages for this Ruflo (ruflo-daemon-config.mjs): the flat keys in
// .claude-flow/config.json and start-on-use in .claude/settings.json. Read
// only; `ak sync` applies them.
import fs from 'node:fs';
import { loadKitConfig } from '../../../lib/config.mjs';
import {
  listDaemons as listRufloDaemons, projectDaemonAlive, rufloAutostartOff, staleDaemons,
} from '../../../lib/daemons.mjs';
import { formatLiveCheckAge as ago } from '../../../lib/live-check-evidence.mjs';
import { pendingDeferral } from '../../../lib/memory-maintenance.mjs';
import * as paths from '../../../lib/paths.mjs';
import { rufloProjectRoot } from '../../../lib/ruflo-components/apply.mjs';
import { daemonDrift } from '../../../lib/ruflo-daemon-config.mjs';
import { memoryProjectRoot } from '../../../lib/ruflo-memory.mjs';
import { installedRoutingVersion } from '../../../lib/ruflo-memory-contract.mjs';
import { installedVersion } from '../../../lib/versions.mjs';
import { row } from '../row.mjs';

function projectRoot(cwd) {
  try { return memoryProjectRoot(cwd); } catch { return null; }
}

function ownDaemonMissing(root, env, running) {
  if (!root || !fs.existsSync(paths.projectMemoryDb(root)) || projectDaemonAlive(root)) return null;
  const others = running ? `${running} running, none` : 'none running';
  const off = rufloAutostartOff(root, env);
  if (!off) {
    return `${others} for this project yet; Ruflo starts it on the next \`ruflo\` command here `
      + '(its memory backup and distillation run only inside it)';
  }
  const whoWrote = off.startsWith('.claude/settings.json') ? ' (ruflo init writes it)' : '';
  return `${others} for this project: Ruflo's memory backup and `
    + 'distillation run only inside its daemon; start one with `ruflo daemon start`'
    + `. Ruflo's start-on-use is off: ${off}${whoWrote}`;
}

const JOB = { consolidate: 'distillation', backup: 'backup' };
const THRESHOLD_KEY = (reason) => (/^CPU load/.test(reason)
  ? 'daemon.resourceThresholds.maxCpuLoad' : 'daemon.resourceThresholds.minFreeMemoryPercent');

/** A warning when this project's live daemon deferred backup or distillation
 *  and the job has not run since. */
function deferralRow(root, { cwd, now, platform }) {
  if (!root || !projectDaemonAlive(root)) return null;
  const deferred = pendingDeferral(root, { now });
  if (!deferred) return null;
  const macMemory = platform === 'darwin' && /^Memory too low/.test(deferred.reason);
  const message = `Ruflo's daemon is running but deferred ${JOB[deferred.worker]} ${ago(deferred.ageMs)}: ${deferred.reason}`
    + (macMemory ? ' (macOS free-memory gate, ruvnet/ruflo#2935)' : '');
  // Sync manages daemon settings only in a Ruflo repository (applyRufloDaemon).
  return macMemory && rufloProjectRoot(cwd)
    ? row('daemons', 'warn', message, "sync sets Ruflo's macOS memory threshold")
    : row('daemons', 'warn', message, `lower "${THRESHOLD_KEY(deferred.reason)}" (a flat key) in .claude-flow/config.json, `
      + 'then restart the daemon with `ruflo daemon stop` and `ruflo daemon start`', { repair: 'manual' });
}

function driftRow(cwd, { loadConfig, rufloVersion, platform }) {
  const root = rufloProjectRoot(cwd);
  if (!root) return null;
  const parts = daemonDrift(root, { cfg: loadConfig(), rufloVersion, platform });
  return parts && row('daemons', 'warn', `ak-managed daemon settings differ from what Ruflo ${rufloVersion ?? '(version unknown)'} `
    + `needs: ${parts.join('; ')}`, "sync applies ak's Ruflo daemon settings");
}

export default {
  id: 'daemons',
  async collect({
    cwd, listDaemons = listRufloDaemons, env = process.env, now = Date.now(), platform = process.platform,
    loadConfig = loadKitConfig, rufloVersion = installedRoutingVersion() ?? installedVersion('ruflo'),
  }) {
    const rows = [];
    try {
      const daemons = await listDaemons({ cwd });
      const stale = staleDaemons(daemons);
      const root = projectRoot(cwd);
      const missing = stale.length ? null : ownDaemonMissing(root, env, daemons.length);
      if (stale.length) {
        rows.push(row('daemons', 'warn',
          `${daemons.length} running, ${stale.length} stale (orphaned or past TTL)`, 'sync reaps stale daemons'));
      } else if (missing) {
        rows.push(row('daemons', 'info', missing));
      } else {
        rows.push(row('daemons', 'ok',
          daemons.length ? `${daemons.length} running (one per active project is expected)` : 'none running'));
      }
      const deferral = deferralRow(root, { cwd, now, platform });
      if (deferral) rows.push(deferral);
      const drift = driftRow(cwd, { loadConfig, rufloVersion, platform });
      if (drift) rows.push(drift);
    } catch (e) {
      rows.push(row('daemons', 'warn', `daemon check unavailable: ${e.message}`));
    }
    return rows;
  },
};
