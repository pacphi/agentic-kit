// Built-in execution adapters. Importing this registry has no side effects:
// processes are only created when the runner selects an adapter for a worker.
import { OPENCODE_EXECUTION_ADAPTER } from './opencode.mjs';
import { CLAUDE_EXECUTION_ADAPTER } from './claude.mjs';
import { CODEX_EXECUTION_ADAPTER } from './codex.mjs';
import { routableHostIds } from '../adapters/index.mjs';
import { admittedExecutionAdapterFor } from './admitted.mjs';

export const EXECUTION_ADAPTERS = Object.freeze(new Map([
  ['claude', CLAUDE_EXECUTION_ADAPTER],
  ['codex', CODEX_EXECUTION_ADAPTER],
  ['opencode', OPENCODE_EXECUTION_ADAPTER],
]));

// Construction invariant (#88, amended W1-B per ADR-0019's cli_unavailable
// degradation precedent): only the built-in -> registry direction throws now.
// A built-in execution adapter wired for a host the registry no longer marks
// routable is an in-tree wiring mistake — that still throws loudly at import,
// exactly like before. The reverse used to throw too (a registry host marked
// routable with no built-in adapter), but that meant any future host flipped
// to canRouteActivities:true ahead of its adapter landing would brick this
// module's import for every consumer of `ak run` — the merge-seam gap this
// wave exists to open. That direction is no longer a construction error:
// executionAdapterFor() below returns null for it, and the runner degrades
// just that one worker with cli_unavailable instead of crashing the run
// (src/lib/execution/runner.mjs's adapterFor already had this fallback for
// wholly-unknown hosts — a routable-but-unadapted host now takes the same
// path, never a new one).
export function assertBuiltinAdaptersRoutable(routableIds = routableHostIds()) {
  const routable = routableIds instanceof Set ? routableIds : new Set(routableIds);
  const stray = [...EXECUTION_ADAPTERS.keys()].filter((id) => !routable.has(id));
  if (stray.length) {
    throw new Error(`execution adapters out of sync with routable hosts: `
      + `adapter(s) for non-routable host(s): ${stray.join(', ')}`);
  }
}

assertBuiltinAdaptersRoutable();

/** Merge seam (W1-B): resolve one host's execution adapter without exposing
 *  the underlying Map. Built-ins resolve here today; a later wave admits
 *  externally-registered adapters into this same lookup. Returns null for a
 *  host with no adapter wired yet — never throws, so callers can degrade a
 *  single worker instead of failing an entire run. */
export function executionAdapterFor(hostId) {
  if (EXECUTION_ADAPTERS.has(hostId)) return EXECUTION_ADAPTERS.get(hostId);
  // P2 (ADR-0031): an admitted external host whose manifest declared an
  // execution block gets its adapter derived and registered at bootstrap
  // (admission.mjs) into execution/admitted.mjs's overlay. A routable host
  // with no execution block (or nothing admitted at all) still returns null
  // here — the runner's existing cli_unavailable degradation, unchanged.
  return admittedExecutionAdapterFor(hostId);
}
