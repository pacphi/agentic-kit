// Cache-only model lifecycle summary. Discovery and network access belong
// exclusively to `ak models refresh`.
import { latestSnapshot, readModelStore, summarizeModelHealth } from '../../../lib/model-inventory/index.mjs';
import { row } from '../row.mjs';

export default {
  id: 'models',
  // readStore is a test seam; status passes its shared context, which has none.
  async collect({ readStore = readModelStore } = {}) {
    const rows = [];
    try {
      const snapshot = latestSnapshot(readStore());
      if (!snapshot) rows.push(row('models', 'info', 'no local model inventory yet; run `ak models refresh` explicitly'));
      else {
        const health = summarizeModelHealth(snapshot);
        // Model lifecycle actions are explicit advisory commands; sync never
        // refreshes catalogs or applies model plans.
        rows.push(row('models', health.level, health.message, health.fix, { repair: 'manual' }));
      }
    } catch (error) {
      rows.push(row('models', 'warn', `model inventory unavailable: ${error.message}`, 'ak models refresh', { repair: 'manual' }));
    }
    return rows;
  },
};
