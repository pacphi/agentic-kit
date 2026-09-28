// #45 aftermath: a CLAUDE_FLOW_DB_PATH pin aimed at a dead or foreign path makes
// every memory op target the wrong DB ("Database not initialized" with a healthy
// DB in-repo). Warn-only — the pin may be deliberate; sync never touches it.
//
// B5-D1: the AQE pin (aqe-project-pin.mjs), read from the repository root. A missing
// or stale receipted pin is a sync repair; a value ak does not own (including a pin
// copied from another checkout) is a hand fix naming the file, never a sync repair
// (audit decision 13).
import path from 'node:path';
import { dbPathPinStatus } from '../../../lib/natives.mjs';
import { reconcileAqePin } from '../../../lib/aqe-project-pin.mjs';
import { row } from '../row.mjs';

const KEYS = 'AQE_PROJECT_ROOT, AQE_MEMORY_PATH and AQE_STORAGE_PATH';
const files = (findings) => [...new Set(findings.map((f) => f.where ?? f.file))].join(', ');

/** @param {any} cfg @param {string} cwd */
export function aqePinRows(cfg, cwd) {
  const pin = reconcileAqePin(cfg, cwd, { dryRun: true });
  if (!pin.root || !pin.active) return [];
  const rows = [];
  // A tracked file's pending change is a release, which its hand-fix row below covers.
  const drift = pin.findings.filter((f) => f.changed && f.status !== 'tracked');
  // A file can have keys to write and a preserved key at once: it shows in both rows.
  const held = pin.findings.filter((f) => f.status === 'conflict' || f.conflicts.length);
  if (drift.length) {
    const stale = drift.find((f) => f.foreignRoot && !f.conflicts.length);
    rows.push(row('aqe-pin', 'warn', stale
      ? `AQE pin in ${stale.where ?? stale.file} names another root (${stale.foreignRoot}); AQE would use that checkout's store`
      : `AQE is not pinned to this project's root in ${files(drift)}: a command, hook or MCP server started in a subfolder creates its own .agentic-qe there`,
    `pin ${KEYS} to ${pin.root}`));
  }
  const foreign = held.filter((f) => f.foreignRoot);
  if (foreign.length) {
    rows.push(row('aqe-pin', 'warn', `AQE pin in ${files(foreign)} names another root (${foreign[0].foreignRoot}), `
      + 'likely copied from another checkout; ak preserves values it did not write',
    `remove ${KEYS} from ${files(foreign)}, then re-run ak sync in this checkout`, { repair: 'manual' }));
  }
  const tracked = pin.findings.filter((f) => f.status === 'tracked');
  const trackedFiles = [...new Set(tracked.map((f) => f.file))].join(', ');
  if (tracked.length) {
    rows.push(row('aqe-pin', 'warn', `AQE is not pinned in ${trackedFiles}: tracked by git, and a committed absolute path `
      + 'would point teammates\' AQE at a path that does not exist on their machines; an AQE server or command those files start from a subfolder can still create its own .agentic-qe there',
    `keep ${trackedFiles} out of git (git rm --cached, then .gitignore) and re-run ak sync, or start sessions from ${pin.root}; `
      + '.claude/settings.local.json stays pinned for Claude Code', { repair: 'manual' }));
  }
  const other = held.filter((f) => !f.foreignRoot && f.status !== 'tracked');
  if (other.length) {
    const reasons = other.flatMap((f) => (f.reason ? [f.reason] : f.conflicts.map((c) => c.reason)));
    rows.push(row('aqe-pin', 'warn', `ak preserved AQE pin values it does not own in ${files(other)} (${reasons.join('; ')})`,
      `reconcile ${KEYS} in ${files(other)} by hand; ak never edits values it did not write`, { repair: 'manual' }));
  }
  return rows;
}

export default {
  id: 'memory-pin',
  async collect({ cwd, cfg = /** @type {any} */ ({}) }) {
    const rows = [];
    try {
      const pin = dbPathPinStatus({
        settingsLocalFile: path.join(cwd, '.claude', 'settings.local.json'),
        projectRoot: cwd,
      });
      if (pin?.warn) {
        rows.push(row('memory-pin', 'warn',
          `CLAUDE_FLOW_DB_PATH pins ${pin.pinned} (${pin.reason})`,
          'repoint it in .claude/settings.local.json env, or remove the pin', { repair: 'manual' }));
      }
    } catch { /* pin check is best-effort — never blocks status */ }
    try { rows.push(...aqePinRows(cfg, cwd)); } catch { /* best-effort, like the pin check above */ }
    return rows;
  },
};
