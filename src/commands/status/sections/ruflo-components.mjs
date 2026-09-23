// ADR-0058 §7: every row carries state + meaning + action, never a bare label.
// Evidence comes from the cache; `ak status --refresh` re-probes first. The
// projection itself (Claude env conflicts, policy state, missing hosts) is
// shared with Task 10's dashboard through rufloComponentsPayload — this
// section never re-implements it (controller ruling 3).
import { installedVersion } from '../../../lib/versions.mjs';
import { row } from '../row.mjs';
import { rufloComponentsPayload } from '../../../lib/ruflo-components/snapshot.mjs';
import { collectEvidence, writeEvidenceCache } from '../../../lib/ruflo-components/evidence.mjs';
import { rufloComponentsEvidenceFile, rufloProjectRoot } from '../../../lib/ruflo-components/apply.mjs';

const FIXABLE = new Set(['not-applied', 'drifted', 'needs-ruflo', 'blocked']);
// 'blocked' reaches 'fail' (not 'warn') — controller ruling: a component ak
// could not apply must count toward ak sync's post-heal convergence check
// (`remaining = after.filter(r => r.level === 'fail' ...)` in sync.mjs), or a
// blocked component would let `ak sync` claim "converged" while it stayed broken.
const LEVEL = (id) => {
  if (id === 'active' || id === 'user-managed') return 'ok';
  if (id === 'unknown' || id === 'not-managed-yet') return 'info';
  if (id === 'blocked') return 'fail';
  return 'warn';
};

/** Each row carries its component state id (`state`), so sync can filter on it rather
 *  than on free text. 'not-managed-yet' (encryption, ADR-0059) is info with no fix: ak
 *  sync has nothing to apply for it. */
export function rufloComponentRows(snapshot) {
  const rows = [row('ruflo-components', snapshot.summary.active === snapshot.summary.total ? 'ok' : 'info',
    `ruflo components: ${snapshot.summary.active} of ${snapshot.summary.total} active (ruflo ${snapshot.rufloVersion ?? 'not installed'})`)];
  for (const c of snapshot.components) {
    const text = `${c.label} — ${c.state.label}: ${c.state.meaning}${c.state.action ? ` ${c.state.action}` : ''}`;
    rows.push({
      ...row('ruflo-components', LEVEL(c.state.id), text,
        FIXABLE.has(c.state.id) ? `sync applies ${c.label} (${c.state.action || 'reconcile'})` : null),
      state: c.state.id,
    });
  }
  return rows;
}

export function formatComponentResults(snapshot) {
  return snapshot.components.map((c) => `  ${c.label.padEnd(30)} ${c.state.label.padEnd(24)} ${c.state.meaning}`);
}

export default {
  id: 'ruflo-components',
  async collect({ cfg, cwd, refresh = false }) {
    const rufloVersion = installedVersion('ruflo');
    if (!rufloVersion) return [row('ruflo-components', 'info', 'ruflo components: ruflo not installed; nothing managed')];
    const projectRoot = rufloProjectRoot(cwd);
    const evidenceFile = rufloComponentsEvidenceFile();
    if (refresh) {
      const evidence = await collectEvidence({
        projectRoot, cfg, rufloVersion, cwd,
      });
      writeEvidenceCache(evidenceFile, evidence);
    }
    const snapshot = rufloComponentsPayload({
      cfg, rufloVersion, projectRoot, evidenceFile,
    });
    return rufloComponentRows(snapshot);
  },
};
