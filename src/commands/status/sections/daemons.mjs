// daemons
import { listDaemons, staleDaemons } from '../../../lib/daemons.mjs';
import { row } from '../row.mjs';

export default {
  id: 'daemons',
  async collect({ cwd }) {
    const rows = [];
    try {
      const daemons = await listDaemons({ cwd });
      const stale = staleDaemons(daemons);
      if (stale.length) {
        rows.push(row('daemons', 'warn',
          `${daemons.length} running, ${stale.length} stale (orphaned or past TTL)`, 'sync reaps stale daemons'));
      } else {
        rows.push(row('daemons', 'ok',
          daemons.length ? `${daemons.length} running (one per active project is expected)` : 'none running'));
      }
    } catch (e) {
      rows.push(row('daemons', 'warn', `daemon check unavailable: ${e.message}`));
    }
    return rows;
  },
};
