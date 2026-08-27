// self (the kit's own version — prerelease installs track the `next` tag)
import { selfDrift } from '../../../lib/versions.mjs';
import { row } from '../row.mjs';

export default {
  id: 'self',
  async collect({ pkgRoot }) {
    const rows = [];
    try {
      const s = await selfDrift({ pkgRoot });
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
