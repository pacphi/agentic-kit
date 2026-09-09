import { driftReport, releaseObservationLabel } from '../../../lib/versions.mjs';
import { row } from '../row.mjs';

export default {
  id: 'versions',
  async collect() {
    const rows = [];
    try {
      for (const r of await driftReport()) {
        if (!r.installed) {
          rows.push(row('versions', r.pkg === 'ruflo' ? 'fail' : 'warn',
            `${r.pkg} not installed globally`, 'setup installs it'));
        } else if (r.outdated) {
          rows.push(row('versions', 'warn',
            `${r.pkg} ${r.installed} installed, ${r.latest} available (${releaseObservationLabel(r)})`, 'sync upgrades + re-heals'));
        } else {
          rows.push(row('versions', r.latest ? 'ok' : 'info',
            `${r.pkg} ${r.installed}${r.latest ? ` (latest known; ${releaseObservationLabel(r)})` : ' (release metadata unavailable)'}`));
        }
      }
    } catch (e) {
      rows.push(row('versions', 'warn', `version check unavailable: ${e.message}`));
    }
    return rows;
  },
};
