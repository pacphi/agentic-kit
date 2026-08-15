// Lifecycle adapter registry — host lifecycle (detect/plan/apply/verify/undo)
// reached by id lookup, never by a named import of a concrete host module.
//
// Lifecycle adapters carry FUNCTIONS (detect/plan/apply/verify/undo), so they
// cannot live in the structuredClone'd data registry (registries.mjs) — this
// module is the function-carrying sibling, keyed the same way (host id).
//
// Direction: this module imports the concrete OPENCODE_LIFECYCLE_ADAPTER from
// opencode.mjs and registers it here, rather than opencode.mjs importing this
// module and self-registering. opencode.mjs already imports from
// adapters/config.mjs today, but nothing under adapters/ imports opencode.mjs
// — so this is a new, one-way edge (adapters/* -> opencode.mjs) that never
// cycles back (opencode.mjs has no reason to import this module: callers
// reach it through lifecycleAdapterFor/hostsWithLifecycle instead).
import { validateLifecycleAdapter } from './lifecycle.mjs';
import { HOST_REGISTRY } from './registries.mjs';
import { OPENCODE_LIFECYCLE_ADAPTER } from '../opencode.mjs';

const LIFECYCLE_ADAPTERS = new Map();

/**
 * Register a built-in host's lifecycle adapter. Internal — called by this
 * module itself, once per built-in, at import time. There is no dynamic or
 * third-party host concept yet, so this is not a general-purpose plugin API.
 *
 * Throws when the host id isn't in HOST_REGISTRY or the adapter doesn't
 * satisfy validateLifecycleAdapter: a wiring bug in a built-in is a load-time
 * fault, not a runtime one. `hostRegistry` is overridable so this invariant
 * is unit-testable directly (a synthetic registry) without needing a
 * fresh-module import trick.
 * @param {string} hostId
 * @param {import('./lifecycle.mjs').LifecycleAdapter} adapter
 * @param {{ hostRegistry?: ReadonlyArray<{id: string}> }} [opts]
 * @returns {import('./lifecycle.mjs').LifecycleAdapter}
 */
export function registerBuiltinLifecycle(hostId, adapter, { hostRegistry = HOST_REGISTRY } = {}) {
  if (!hostRegistry.some((host) => host.id === hostId)) {
    throw new TypeError(`lifecycle registry: unknown host id '${hostId}' — not present in HOST_REGISTRY`);
  }
  validateLifecycleAdapter(adapter);
  LIFECYCLE_ADAPTERS.set(hostId, adapter);
  return adapter;
}

registerBuiltinLifecycle('opencode', OPENCODE_LIFECYCLE_ADAPTER);

/**
 * @param {string} hostId
 * @returns {import('./lifecycle.mjs').LifecycleAdapter|null}
 */
export function lifecycleAdapterFor(hostId) {
  return LIFECYCLE_ADAPTERS.get(hostId) ?? null;
}

/**
 * Host ids with a registered lifecycle adapter, in HOST_REGISTRY order (not
 * Map-insertion order) so callers get a deterministic, registry-driven
 * iteration order as more hosts gain lifecycle adapters.
 * @returns {string[]}
 */
export function hostsWithLifecycle() {
  return HOST_REGISTRY.filter((host) => LIFECYCLE_ADAPTERS.has(host.id)).map((host) => host.id);
}
