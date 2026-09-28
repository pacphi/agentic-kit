// natives (better-sqlite3 in agentdb locations + aqe)
import { describeInstallEdit, editLabel, groupInstallEdits, installEditStatus, RUFLO_PIN_NOTE } from '../../../lib/install-edits.mjs';
import { nativesStatus, rufloRuntimeNatives } from '../../../lib/natives.mjs';
import { rufloRoot as defaultRufloRoot } from '../../../lib/paths.mjs';
import { installedVersion } from '../../../lib/versions.mjs';
import { row } from '../row.mjs';

/** What ak changed inside another tool's install (install-edits.mjs; audit
 *  Addendum 2, problem 3). Applied edits in Ruflo's tree are the native SQLite
 *  pin Ruflo itself intends (ruvnet/ruflo#2219); anything else is named by its
 *  package. Superseded receipts (the file no longer holds ak's value) are
 *  information that nothing is left to restore; the next heal forgets them.
 *  All rows are information: nothing here is for sync or a human to fix. */
export function installEditRows(edits, { rufloRoot = null } = {}) {
  const rows = [];
  const { ruflo, elsewhere, superseded } = groupInstallEdits(edits, { rufloRoot });
  const list = (group) => group.map((edit) => describeInstallEdit(edit, { rufloRoot })).join('; ');
  const restores = (group) => `\`ak uninstall\` restores the original value${group.length === 1 ? '' : 's'}`;
  if (ruflo.length) rows.push(row('natives', 'info', `${RUFLO_PIN_NOTE} inside Ruflo's install: ${list(ruflo)}. ${restores(ruflo)}`));
  if (elsewhere.length) {
    rows.push(row('natives', 'info', `ak changed better-sqlite3 in another tool's install so its native binding could be installed: `
      + `${list(elsewhere)}. ${restores(elsewhere)}`));
  }
  if (superseded.length) {
    rows.push(row('natives', 'info', `ak's earlier edit${superseded.length === 1 ? ' is' : 's are'} no longer there `
      + `(${superseded.map((edit) => editLabel(edit, { rufloRoot })).join(', ')}; the package was upgraded or reinstalled): nothing to restore`));
  }
  return rows;
}

/** Receipt rows for this machine's installs; never fails the section. */
function receiptRows() {
  let root = null;
  try { root = defaultRufloRoot(); } catch { /* no npm global root: label by folder */ }
  try { return installEditRows(installEditStatus(), { rufloRoot: root }); } catch { return []; }
}

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

/** The one row about the agentdb copies Ruflo bundles: missing, on the WASM
 *  fallback, or native. It is the only status row about agentdb since ak
 *  retired its standalone install, so the dashboard's About card joins it by
 *  the phrase "agentdb location" every variant carries (client/about.mjs
 *  ABOUT_JOIN; tests/kit/about-agentdb-join.test.mjs holds the two together).
 *  @param {Array<{ native: boolean }>} locations
 *  @param {boolean} rufloInstalled */
export function agentdbLocationRow(locations, rufloInstalled) {
  const bad = locations.filter((l) => !l.native);
  if (locations.length === 0) {
    // Sync installs a MISSING ruflo through its versions row; no step can
    // put agentdb back inside a ruflo that is present without it.
    return rufloInstalled
      ? row('natives', 'warn', 'no agentdb locations found under global ruflo (its bundled agentdb is missing)',
        'reinstall ruflo: npm install -g ruflo@latest, then ak sync', { repair: 'manual' })
      : row('natives', 'warn', 'no agentdb locations found: ruflo is not installed globally (the versions row installs it)');
  }
  if (bad.length) {
    return row('natives', 'fail',
      `${bad.length}/${locations.length} agentdb location(s) on WASM fallback (data-loss writes)`,
      'sync installs native better-sqlite3');
  }
  return row('natives', 'ok', `native better-sqlite3 in ${locations.length} agentdb location(s)`);
}

export default {
  id: 'natives',
  async collect({ refresh = false } = {}) {
    const rows = [];
    try {
      const n = nativesStatus();
      rows.push(agentdbLocationRow(n.locations, n.locations.length > 0 || !!installedVersion('ruflo')));
      if (n.aqe && !n.aqe.native) {
        rows.push(row('natives', 'fail', 'agentic-qe better-sqlite3 not native', 'sync repairs it'));
      }
      // #45: the agentdb copies above are NOT what `npx ruflo memory` loads — probe
      // the binding as resolved from ruflo's own memory runtime (@claude-flow/memory
      // + /cli), or the row reads ✓ while memory store runs on the WASM fallback.
      rows.push(...runtimeNativeRows(await rufloRuntimeNatives({ refresh })));
      rows.push(...receiptRows());
    } catch (e) {
      rows.push(row('natives', 'warn', `native check unavailable: ${e.message}`));
    }
    return rows;
  },
};

