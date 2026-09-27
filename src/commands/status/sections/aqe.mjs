// aqe / RVF (project scope)
import fs from 'node:fs';
import * as paths from '../../../lib/paths.mjs';
import { scanRvf } from '../../../lib/rvf.mjs';
import { row } from '../row.mjs';
import { aqeEmbeddingConfiguration } from '../../../lib/aqe-readiness.mjs';
import { resolveAqeEmbedding } from '../../../lib/aqe-embedding-config.mjs';
import { inspectAqeEmbeddingProjections } from '../../../lib/aqe-embedding-projection.mjs';
import {
  readLiveCheck, liveCheckInputsKey, describeLiveCheck, liveCheckLevel,
} from '../../../lib/live-check-evidence.mjs';

/** The embedding rows: configuration from disk, plus the last LIVE result that
 *  `ak sync` or `ak x verify aqe` remembered (status itself never probes).
 *  An entry the projection preserves as a conflict is a hand fix: sync never
 *  edits it, so offering it as a sync repair would fail every `ak sync`
 *  (audit decision 13). What sync owns (changes, missing registrations) stays
 *  a sync repair in its own row. */
export function embeddingRows(cfg, cwd, resolved, backend, projection, {
  evidence = readLiveCheck('aqe-embedding', { inputsKey: liveCheckInputsKey('aqe-embedding', { cfg, cwd }) }),
} = {}) {
  const conflicts = projection.findings?.filter((f) => f.status === 'conflict') ?? [];
  const syncOwned = projection.changed
    || (projection.findings ?? []).some((f) => f.status === 'missing-registration');
  const fix = syncOwned ? 'reconcile owned AQE embedding projections' : null;
  const projectionNote = projection.ok ? '' : '; ' + projection.detail;
  const main = !evidence
    ? row('aqe-embedding', projection.ok ? 'info' : 'warn',
      `${resolved.mode}; backend ${backend.status}; live model and corpus compatibility unverified${projectionNote}`, fix)
    : (() => {
      const evidenceLevel = liveCheckLevel(evidence);
      const level = !projection.ok ? 'warn' : evidenceLevel === 'ok' && fix ? 'info' : evidenceLevel;
      return row('aqe-embedding', level,
        `${resolved.mode}; backend ${backend.status}; ${describeLiveCheck(evidence, { recheck: 'ak x verify aqe' })}; corpus compatibility unverified${projectionNote}`,
        fix);
    })();
  if (conflicts.length === 0) return [main];
  const files = [...new Set(conflicts.map((f) => f.file))].join(', ');
  const handFix = `reconcile the AQE server entry in ${files} by hand; ak preserves it and never edits it`;
  if (!syncOwned) return [{ ...main, fix: handFix, repair: 'manual' }];
  return [main, row('aqe-embedding', 'warn', `ak preserved an AQE server entry it does not own in ${files}`, handFix, { repair: 'manual' })];
}

export default {
  id: 'aqe',
  async collect({ cwd, cfg = /** @type {any} */ ({}) }) {
    const rows = [];
    if (cfg.aqe !== false) {
      const resolved = resolveAqeEmbedding(cfg);
      const backend = aqeEmbeddingConfiguration({ env: resolved.env });
      const projection = inspectAqeEmbeddingProjections(cfg, cwd);
      rows.push(...embeddingRows(cfg, cwd, resolved, backend, projection));
      if (resolved.mode === 'unmanaged' && backend.status === 'missing-backend') {
        rows.push(row('aqe-embedding', 'warn', 'semantic backend missing',
          'ak x aqe-embedding configure (choose a backend)', { repair: 'manual' }));
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
    // A verification the user runs — sync has no step that performs it.
    return [...rows, row('aqe', 'info', 'agentic-qe initialized; no oversized RVF stores detected; runtime readiness unverified',
      'run: ak x verify aqe', { repair: 'manual' })];
  },
};
