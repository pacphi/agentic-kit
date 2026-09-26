// natives (better-sqlite3 in agentdb locations + aqe)
import { nativesStatus, rufloRuntimeNatives } from '../../../lib/natives.mjs';
import { row } from '../row.mjs';

/** One row per ruflo memory-runtime context that is not native, from the load
 *  probe's state: `unavailable` provably falls back to WASM (fail), while
 *  `inconclusive` has no verdict (warn, nothing for sync to do). The fix names
 *  what sync's natives heal does: it builds a missing binding and, using this
 *  same load test, rebuilds a present one that will not load. */
export function runtimeNativeRows(rt) {
  if (!rt.installed || !rt.contexts.length) return [];
  const notNative = rt.contexts.filter((c) => c.state !== 'native');
  if (!notNative.length) {
    return [row('natives', 'ok', `ruflo memory runtime native (${rt.contexts.map((c) => c.context).join(', ')})`)];
  }
  return notNative.map((c) => {
    const where = `(@claude-flow/${c.context})`;
    const reason = c.reason || 'no diagnostic available';
    if (c.state !== 'unavailable') {
      return row('natives', 'warn',
        `ruflo memory runtime backend unverified ${where}: ${reason} — native or WASM fallback is unknown; re-run ak status`);
    }
    if (!c.bindingPresent) {
      return row('natives', 'fail',
        `ruflo memory runtime on WASM fallback ${where}: no native binding — ${reason}`,
        'sync builds the native binding');
    }
    return row('natives', 'fail',
      `ruflo memory runtime on WASM fallback ${where}: its native binding is present but will not load — ${reason}`,
      'sync rebuilds the native binding');
  });
}

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
      rows.push(...runtimeNativeRows(await rufloRuntimeNatives()));
    } catch (e) {
      rows.push(row('natives', 'warn', `native check unavailable: ${e.message}`));
    }
    return rows;
  },
};
