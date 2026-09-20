// aqe / RVF (project scope)
import fs from 'node:fs';
import * as paths from '../../../lib/paths.mjs';
import { scanRvf } from '../../../lib/rvf.mjs';
import { row } from '../row.mjs';
import { aqeEmbeddingConfiguration } from '../../../lib/aqe-readiness.mjs';
import { resolveAqeEmbedding } from '../../../lib/aqe-embedding-config.mjs';
import { inspectAqeEmbeddingProjections } from '../../../lib/aqe-embedding-projection.mjs';

export default {
  id: 'aqe',
  async collect({ cwd, cfg = /** @type {any} */ ({}) }) {
    const rows = [];
    if (cfg.aqe !== false) {
      const resolved = resolveAqeEmbedding(cfg);
      const backend = aqeEmbeddingConfiguration({ env: resolved.env });
      const projection = inspectAqeEmbeddingProjections(cfg, cwd);
      rows.push(row('aqe-embedding', projection.ok ? 'info' : 'warn',
        `${resolved.mode}; backend ${backend.status}; live model and corpus compatibility unverified${projection.ok ? '' : '; ' + projection.detail}`,
        projection.changed || !projection.ok ? 'reconcile owned AQE embedding projections' : null));
      if (resolved.mode === 'unmanaged' && backend.status === 'missing-backend') {
        rows.push(row('aqe-embedding', 'warn', 'semantic backend missing; choose one with ak x aqe-embedding configure'));
      }
    }
    const aqeDir = paths.projectAqeDir(cwd);
    if (!fs.existsSync(aqeDir)) {
      return [...rows, row('aqe', 'info', 'agentic-qe not initialized in this project')];
    }
    const findings = scanRvf(aqeDir);
    if (findings.length) {
      // Oversized = the #495 runaway-append mode, the one RVF failure aqe's own
      // self-healing (>= 3.12.3) doesn't cover and the kit can see from the
      // filesystem. Everything lock-shaped is aqe's job now — see src/lib/rvf.mjs.
      return [...rows, row('aqe', 'fail',
        `${findings.length} oversized RVF store(s) (runaway append) — quarantine before they eat the disk`,
        'sync quarantines them (aqe rebuilds the store)')];
    }
    return [...rows, row('aqe', 'info', 'agentic-qe initialized; no oversized RVF stores detected; runtime readiness unverified',
      'run: ak x verify aqe')];
  },
};
