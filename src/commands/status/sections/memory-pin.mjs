// #45 aftermath: a CLAUDE_FLOW_DB_PATH pin aimed at a dead or foreign path makes
// every memory op target the wrong DB ("Database not initialized" with a healthy
// DB in-repo). Warn-only — the pin may be deliberate; sync never touches it.
//
// B5-D1 (retired, agentic-qe#735): released agentic-qe (>=3.14.5) resolves its project
// root, memory database and storage folder from a subfolder on its own, so ak no longer
// writes the AQE pin (AQE_PROJECT_ROOT, AQE_MEMORY_PATH, AQE_STORAGE_PATH). A pin an older
// ak wrote is released only when that is safe (ADR-0062); while it is kept, one row says why.
import path from 'node:path';
import { dbPathPinStatus } from '../../../lib/natives.mjs';
import { aqePinHold, AQE_PIN_FIX_VERSION } from '../../../lib/aqe-project-pin.mjs';
import { row } from '../row.mjs';

const HOLD_FIX = {
  strays: 'ak x aqe-store merge --dry-run (or remove the stray folders), then run ak sync to release the pin',
  'scan-incomplete': 'run ak sync from the project root; the pin stays until every folder below it can be scanned',
};
const holdFix = (reason) => HOLD_FIX[reason]
  ?? `update agentic-qe to ${AQE_PIN_FIX_VERSION} or later, then run ak sync to release the pin`;

/** One row while a pin ak wrote earlier is kept: why, and what releases it. */
export function aqePinHoldRows(cwd, options) {
  const hold = aqePinHold(cwd, options);
  if (!hold) return [];
  return [row('aqe-pin', 'warn', `AQE pin kept in ${hold.root}: ${hold.detail}`, holdFix(hold.reason), { repair: 'manual' })];
}

export default {
  id: 'memory-pin',
  async collect({ cwd, aqePin }) {
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
    try { rows.push(...aqePinHoldRows(cwd, aqePin)); } catch { /* best-effort, like the pin check above */ }
    return rows;
  },
};
