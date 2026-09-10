import { inspectHostAlignment } from '../../../lib/host-alignment.mjs';
import { row } from '../row.mjs';

export default {
  id: 'host-alignment',
  collect({ cwd }) {
    const report = inspectHostAlignment({ projectRoots: [cwd] });
    return report.findings.map(finding => row('host-alignment', finding.level,
      `${finding.host}/${finding.scope}: ${finding.message} (${finding.file})`,
      finding.level === 'fail' ? 'run: ak host align --apply (or add --all-projects to review the project census)' : null));
  },
};
