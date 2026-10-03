// #45 aftermath: a CLAUDE_FLOW_DB_PATH pin aimed at a dead or foreign path makes
// every memory op target the wrong DB ("Database not initialized" with a healthy
// DB in-repo). Warn-only — the pin may be deliberate; sync never touches it.
//
// B5-D1 (retired, agentic-qe#735): status used to report the AQE pin
// (aqe-project-pin.mjs) here. Released agentic-qe (>=3.14.5) resolves its project
// root, memory database and storage folder from a subfolder on its own, so ak no
// longer pins or reports on AQE_PROJECT_ROOT, AQE_MEMORY_PATH and AQE_STORAGE_PATH.
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
          'repoint it in .claude/settings.local.json env, or remove the pin', { repair: 'manual' }));
      }
    } catch { /* pin check is best-effort — never blocks status */ }
    return rows;
  },
};
