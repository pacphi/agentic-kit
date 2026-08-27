// qe-court (ADR-124): read-only awareness. agentic-qe >=3.13.3 owns config
// validation and ships a valid default; ak reports existing project state
// but never rewrites the skill's config.
import * as paths from '../../../lib/paths.mjs';
import { qeCourtShipped, readQeCourtConfig, validateCourtConfig, qeCourtReadiness } from '../../../lib/qeCourt.mjs';
import { row } from '../row.mjs';

export default {
  id: 'qe-court',
  async collect({ cwd }) {
    if (!qeCourtShipped()) return [];
    const qcRoot = paths.repoRoot(cwd);
    const qc = qcRoot ? readQeCourtConfig(qcRoot) : null;
    if (!qc) return [];
    const violations = validateCourtConfig(qc);
    if (violations.length) {
      return [row('qe-court', 'warn',
        `qe-court panel invalid: ${violations.join(', ')} — regenerate with agentic-qe >=3.13.3 or choose different defense/jury vendors`)];
    }
    const readiness = qeCourtReadiness(qcRoot);
    if (readiness.ready) {
      return [row('qe-court', 'ok', 'qe-court routing and consumer artifacts are ready; provider-seat readiness still requires a live proof')];
    }
    return [row('qe-court', 'warn',
      `qe-court routing config passes the local anti-collusion check, but executability is not proven (${readiness.artifactIssues.join('; ')})`)];
  },
};
