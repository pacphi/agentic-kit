// self (the kit's own version — prerelease installs track the `next` tag)
import { selfDrift } from '../../../lib/versions.mjs';
import { row } from '../row.mjs';

export default {
  id: 'self',
  // A self drift the caller already holds (versionEvidence: ak sync's
  // cache-only read when --skip names self, ADR-0063) is used as given.
  async collect({ pkgRoot, refresh = false, versionEvidence }) {
    const rows = [];
    try {
      const s = versionEvidence?.self ?? await selfDrift({ pkgRoot, force: refresh });
      if (s.outdated) {
        rows.push(row('self', 'warn',
          `kit ${s.installed} installed, ${s.latest} available (${s.tag} tag)`,
          'sync self-updates the kit (runs last)'));
      } else if (s.installed) {
        rows.push(row('self', 'ok', `kit ${s.installed}${s.latest ? ' (latest)' : ''}`));
      }
    } catch (e) {
      rows.push(row('self', 'warn', `kit version check unavailable: ${e.message}`));
    }
    return rows;
  },
};
