// ADR-0058 §7: every row carries state + meaning + action, never a bare label.
// Evidence comes from the cache; `ak status --refresh` re-probes first. The
// projection itself (Claude env conflicts, policy state, missing hosts) is
// shared with Task 10's dashboard through rufloComponentsPayload — this
// section never re-implements it (controller ruling 3).
import { installedVersion } from '../../../lib/versions.mjs';
import { row } from '../row.mjs';
import * as paths from '../../../lib/paths.mjs';
import { rufloComponentsPayload } from '../../../lib/ruflo-components/snapshot.mjs';
import { collectEvidence, writeEvidenceCache } from '../../../lib/ruflo-components/evidence.mjs';
import { rufloComponentsEvidenceFile } from '../../../lib/ruflo-components/apply.mjs';

const FIXABLE = new Set(['not-applied', 'drifted', 'needs-ruflo', 'blocked']);
const LEVEL = (id) => (id === 'active' || id === 'user-managed' ? 'ok' : id === 'unknown' ? 'info' : 'warn');
// encryptionAtRest is permanently classified 'not-applied' (ADR-0059, not yet
// implemented — see snapshot.mjs's hardcoded branch) regardless of managed
// intent or evidence. `reconcileRufloComponents` has no reconcile step for
// it, so a `fix` here would be a false promise ak sync cannot honor, and
// would perpetually re-enter the sync step's `when` gate for every project —
// spawning real evidence probes on every sync even when every OTHER
// component is opted out. Excluded from FIXABLE until ADR-0059 ships one.
const NEVER_FIXABLE = new Set(['encryptionAtRest']);

export function rufloComponentRows(snapshot) {
  const rows = [row('ruflo-components', snapshot.summary.active === snapshot.summary.total ? 'ok' : 'info',
    `ruflo components: ${snapshot.summary.active} of ${snapshot.summary.total} active (ruflo ${snapshot.rufloVersion ?? 'not installed'})`)];
  for (const c of snapshot.components) {
    const text = `${c.label} — ${c.state.label}: ${c.state.meaning}${c.state.action ? ` ${c.state.action}` : ''}`;
    const fixable = FIXABLE.has(c.state.id) && !NEVER_FIXABLE.has(c.id);
    rows.push(row('ruflo-components', LEVEL(c.state.id), text,
      fixable ? `sync applies ${c.label} (${c.state.action || 'reconcile'})` : null));
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
    const projectRoot = paths.repoRoot(cwd);
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
