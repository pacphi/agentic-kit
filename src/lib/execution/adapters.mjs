// Built-in execution adapters. Importing this registry has no side effects:
// processes are only created when the runner selects an adapter for a worker.
import { OPENCODE_EXECUTION_ADAPTER } from './opencode.mjs';
import { CLAUDE_EXECUTION_ADAPTER } from './claude.mjs';
import { CODEX_EXECUTION_ADAPTER } from './codex.mjs';
import { routableHostIds } from '../adapters/index.mjs';

export const EXECUTION_ADAPTERS = Object.freeze(new Map([
  ['claude', CLAUDE_EXECUTION_ADAPTER],
  ['codex', CODEX_EXECUTION_ADAPTER],
  ['opencode', OPENCODE_EXECUTION_ADAPTER],
]));

// Construction invariant (#88, architecture leg): every routable host needs an
// execution adapter, and every adapter needs a routable host — enforced at
// import, exactly like the capability registries' own construction check. A
// host flipped to canRouteActivities without an adapter (or an adapter added
// for an unroutable host) would otherwise load cleanly and fail only at
// runtime with cli_unavailable on every worker — issue #71's trap.
{
  const routable = new Set(routableHostIds());
  const adapted = new Set(EXECUTION_ADAPTERS.keys());
  const missing = [...routable].filter((id) => !adapted.has(id));
  const stray = [...adapted].filter((id) => !routable.has(id));
  if (missing.length || stray.length) {
    throw new Error(`execution adapters out of sync with routable hosts: `
      + `${missing.length ? `no adapter for routable host(s): ${missing.join(', ')}. ` : ''}`
      + `${stray.length ? `adapter(s) for non-routable host(s): ${stray.join(', ')}` : ''}`.trim());
  }
}
