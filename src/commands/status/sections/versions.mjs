import { driftReport } from '../../../lib/versions.mjs';
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
            `${r.pkg} ${r.installed} installed, ${r.latest} available`, 'sync upgrades + re-heals'));
        } else {
          rows.push(row('versions', 'ok', `${r.pkg} ${r.installed}${r.latest ? ' (latest)' : ''}`));
        }
      }
    } catch (e) {
      rows.push(row('versions', 'warn', `version check unavailable: ${e.message}`));
    }
    return rows;
  },
};
