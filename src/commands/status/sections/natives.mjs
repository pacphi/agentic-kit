// natives (better-sqlite3 in agentdb locations + aqe)
import { nativesStatus, rufloRuntimeNatives } from '../../../lib/natives.mjs';
import { row } from '../row.mjs';

export default {
  id: 'natives',
  async collect() {
    const rows = [];
    try {
      const n = nativesStatus();
      const bad = n.locations.filter((l) => !l.native);
      if (n.locations.length === 0) {
        rows.push(row('natives', 'warn', 'no agentdb locations found under global ruflo', 'setup/sync installs ruflo'));
      } else if (bad.length) {
        rows.push(row('natives', 'fail',
          `${bad.length}/${n.locations.length} agentdb location(s) on WASM fallback (data-loss writes)`,
          'sync installs native better-sqlite3'));
      } else {
        rows.push(row('natives', 'ok', `native better-sqlite3 in ${n.locations.length} agentdb location(s)`));
      }
      if (n.aqe && !n.aqe.native) {
        rows.push(row('natives', 'fail', 'agentic-qe better-sqlite3 not native', 'sync repairs it'));
      }
      // #45: the agentdb copies above are NOT what `npx ruflo memory` loads — probe
      // the binding as resolved from ruflo's own memory runtime (@claude-flow/memory
      // + /cli), or the row reads ✓ while memory store runs on the WASM fallback.
      const rt = await rufloRuntimeNatives();
      if (rt.installed && rt.contexts.length) {
        const wasm = rt.contexts.filter((c) => !c.ok);
        if (wasm.length) {
          rows.push(row('natives', 'fail',
            `ruflo memory runtime on WASM fallback (${wasm.map((c) => `@claude-flow/${c.context}`).join(', ')}) — memory and orchestration may degrade`,
            'sync builds the native binding'));
        } else {
          rows.push(row('natives', 'ok', `ruflo memory runtime native (${rt.contexts.map((c) => c.context).join(', ')})`));
        }
      }
    } catch (e) {
      rows.push(row('natives', 'warn', `native check unavailable: ${e.message}`));
    }
    return rows;
  },
};
