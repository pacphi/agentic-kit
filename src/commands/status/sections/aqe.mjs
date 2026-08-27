// aqe / RVF (project scope)
import fs from 'node:fs';
import * as paths from '../../../lib/paths.mjs';
import { scanRvf } from '../../../lib/rvf.mjs';
import { row } from '../row.mjs';

export default {
  id: 'aqe',
  async collect({ cwd }) {
    const aqeDir = paths.projectAqeDir(cwd);
    if (!fs.existsSync(aqeDir)) {
      return [row('aqe', 'info', 'agentic-qe not initialized in this project')];
    }
    const findings = scanRvf(aqeDir);
    if (findings.length) {
      // Oversized = the #495 runaway-append mode, the one RVF failure aqe's own
      // self-healing (>= 3.12.3) doesn't cover and the kit can see from the
      // filesystem. Everything lock-shaped is aqe's job now — see src/lib/rvf.mjs.
      return [row('aqe', 'fail',
        `${findings.length} oversized RVF store(s) (runaway append) — quarantine before they eat the disk`,
        'sync quarantines them (aqe rebuilds the store)')];
    }
    return [row('aqe', 'ok', 'agentic-qe initialized here; RVF store healthy')];
  },
};
