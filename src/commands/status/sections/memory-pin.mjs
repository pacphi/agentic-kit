// #45 aftermath: a CLAUDE_FLOW_DB_PATH pin aimed at a dead or foreign path makes
// every memory op target the wrong DB ("Database not initialized" with a healthy
// DB in-repo). Warn-only — the pin may be deliberate; sync never touches it.
import path from 'node:path';
import { dbPathPinStatus } from '../../../lib/natives.mjs';
import { row } from '../row.mjs';

export default {
  id: 'memory-pin',
  async collect({ cwd }) {
    const rows = [];
    try {
      const pin = dbPathPinStatus({
        settingsLocalFile: path.join(cwd, '.claude', 'settings.local.json'),
        projectRoot: cwd,
      });
      if (pin?.warn) {
        rows.push(row('memory-pin', 'warn',
          `CLAUDE_FLOW_DB_PATH pins ${pin.pinned} (${pin.reason})`,
          'repoint it in .claude/settings.local.json env, or remove the pin'));
      }
    } catch { /* pin check is best-effort — never blocks status */ }
    return rows;
  },
};
