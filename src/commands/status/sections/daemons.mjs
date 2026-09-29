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
// only; `ak sync` applies them. A config.json ak cannot manage (unreadable, or
// the user's own value for a wanted key) is a manual row naming the key.
import fs from 'node:fs';
import path from 'node:path';
import { loadKitConfig } from '../../../lib/config.mjs';
import {
  listDaemons as listRufloDaemons, projectDaemonAlive, rufloAutostartOff, staleDaemons,
} from '../../../lib/daemons.mjs';
import { formatLiveCheckAge as ago } from '../../../lib/live-check-evidence.mjs';
import { pendingDeferral } from '../../../lib/memory-maintenance.mjs';
import * as paths from '../../../lib/paths.mjs';
import {
  DAEMON_CONFIG_RELATIVE, MEMORY_FLOOR_KEY, daemonConfigHeld, daemonDrift, rufloDaemonProjectRoot,
} from '../../../lib/ruflo-daemon-config.mjs';
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
 *  and the job has not run since. Sync sets the macOS threshold only in a
 *  Ruflo repository whose config.json ak can manage for that key; otherwise
 *  a sync would change nothing and only restart the daemon. */
function deferralRow(root, { now, platform, ruflo }) {
  if (!root || !projectDaemonAlive(root)) return null;
  const deferred = pendingDeferral(root, { now });
  if (!deferred) return null;
  const macMemory = platform === 'darwin' && /^Memory too low/.test(deferred.reason);
  const message = `Ruflo's daemon is running but deferred ${JOB[deferred.worker]} ${ago(deferred.ageMs)}: ${deferred.reason}`
    + (macMemory ? ' (macOS free-memory gate, ruvnet/ruflo#2935)' : '');
  // Sync manages daemon settings only in a Ruflo repository (applyRufloDaemon).
  const floorHeld = ruflo.held?.entries.some((e) => e.key === MEMORY_FLOOR_KEY);
  return macMemory && ruflo.root && !floorHeld
    ? row('daemons', 'warn', message, "sync sets Ruflo's macOS memory threshold")
    : row('daemons', 'warn', message, `lower "${THRESHOLD_KEY(deferred.reason)}" (a flat key) in .claude-flow/config.json, `
      + 'then restart the daemon with `ruflo daemon stop` and `ruflo daemon start`', { repair: 'manual' });
}

const RESTART = 'then restart the daemon with `ruflo daemon stop` and `ruflo daemon start`';
const flatKeys = (entries, pick) => entries.map((e) => `"${e.key}": ${JSON.stringify(pick(e))}`).join(', ');

/** A manual row for a config.json ak leaves alone (unreadable, or holding the
 *  user's own value for a key ak wants): sync would change nothing there. */
export function heldRow(held) {
  const file = DAEMON_CONFIG_RELATIVE.split(path.sep).join('/');
  const want = flatKeys(held.entries, (e) => e.want);
  if (held.reason === 'yaml-shadow') return row('daemons', 'warn',
    `${file} is not ak-managed: creating it would hide existing .claude-flow/config.yaml or config.yml daemon values`,
    `review the YAML daemon values and set ${want} in the active config yourself, ${RESTART}`, { repair: 'manual' });
  if (held.reason === 'higher-priority-json') return row('daemons', 'warn',
    `${file} is not ak-managed: Ruflo reads claude-flow.config.json first`,
    `review claude-flow.config.json and set ${want} there yourself, ${RESTART}`, { repair: 'manual' });
  if (held.reason === 'explicit-config') return row('daemons', 'warn',
    `${file} is not ak-managed: Ruflo currently reads CLAUDE_FLOW_CONFIG before YAML`,
    `review the CLAUDE_FLOW_CONFIG file and set ${want} there yourself, ${RESTART}`, { repair: 'manual' });
  return held.invalid
    ? row('daemons', 'warn', `${file} is not ak-managed: it is unreadable or not a JSON object, so ak leaves it untouched`,
      `fix ${file} so it is a JSON object holding ${want} (flat keys), ${RESTART}`, { repair: 'manual' })
    : row('daemons', 'warn', `${file} is not ak-managed: it holds your own ${flatKeys(held.entries, (e) => e.have)}, `
      + 'so ak leaves it as is', `set ${want} (flat keys) in ${file} yourself, ${RESTART}`, { repair: 'manual' });
}

/** The Ruflo repository around `cwd`, kit.json, and the keys its config.json
 *  keeps from ak (read once for the deferral and drift rows). */
function rufloContext(cwd, { loadConfig, rufloVersion, platform, env }) {
  const root = rufloDaemonProjectRoot(cwd);
  if (!root) return { root: null, cfg: null, held: null };
  const cfg = loadConfig();
  return { root, cfg, held: daemonConfigHeld(root, { cfg, rufloVersion, platform, env }) };
}

function driftRows({ root, cfg, held }, { rufloVersion, platform, env }) {
  if (!root) return [];
  const parts = daemonDrift(root, { cfg, rufloVersion, platform, env });
  return [held && heldRow(held), parts && row('daemons', 'warn', `ak-managed daemon settings differ from what Ruflo ${rufloVersion ?? '(version unknown)'} `
    + `needs: ${parts.join('; ')}`, "sync applies ak's Ruflo daemon settings")].filter(Boolean);
}

export default {
  id: 'daemons',
  async collect({
    cwd, listDaemons = listRufloDaemons, env = process.env, now = Date.now(), platform = process.platform,
    loadConfig = loadKitConfig, rufloVersion = installedRoutingVersion() ?? installedVersion('ruflo'),
    refresh = false, record = true, source = 'status',
  }) {
    const rows = [];
    try {
      const daemons = await listDaemons({
        cwd, refresh, record, source,
      });
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
      const ruflo = rufloContext(cwd, { loadConfig, rufloVersion, platform, env });
      const deferral = deferralRow(root, { now, platform, ruflo });
      if (deferral) rows.push(deferral);
      rows.push(...driftRows(ruflo, { rufloVersion, platform, env }));
    } catch (e) {
      rows.push(row('daemons', 'warn', `daemon check unavailable: ${e.message}`));
    }
    return rows;
  },
};
