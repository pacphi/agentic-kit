// npx (stale ruflo-family cache envs — `npx --prefer-offline` fallbacks in the
// statusline/hooks execute these verbatim, keeping retired defects alive)
import { scanNpxStale } from '../../../lib/npx.mjs';
import { row } from '../row.mjs';

export default {
  id: 'npx',
  async collect() {
    const rows = [];
    try {
      const stale = scanNpxStale();
      if (stale.length) {
        const what = stale.flatMap((e) => e.stale.map((s) => `${s.pkg}@${s.cached}`)).join(', ');
        rows.push(row('npx', 'warn',
          `${stale.length} stale npx env(s) serve outdated code (${what})`,
          'sync prunes them (npx re-fetches on demand)'));
      } else {
        rows.push(row('npx', 'ok', 'npx cache holds no stale ruflo-family envs'));
      }
    } catch (e) {
      rows.push(row('npx', 'warn', `npx cache check unavailable: ${e.message}`));
    }
    return rows;
  },
};
