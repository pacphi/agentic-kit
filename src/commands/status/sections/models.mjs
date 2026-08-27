// Cache-only model lifecycle summary. Discovery and network access belong
// exclusively to `ak models refresh`.
import { latestSnapshot, readModelStore, summarizeModelHealth } from '../../../lib/model-inventory/index.mjs';
import { row } from '../row.mjs';

export default {
  id: 'models',
  async collect() {
    const rows = [];
    try {
      const snapshot = latestSnapshot(readModelStore());
      if (!snapshot) rows.push(row('models', 'info', 'no local model inventory yet; run `ak models refresh` explicitly'));
      else {
        const health = summarizeModelHealth(snapshot);
        rows.push(row('models', health.level, health.message, health.fix));
      }
    } catch (error) {
      rows.push(row('models', 'warn', `model inventory unavailable: ${error.message}; run \`ak models refresh\` explicitly`));
    }
    return rows;
  },
};
