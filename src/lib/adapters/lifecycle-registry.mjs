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
import { validateLifecycleAdapter, LIFECYCLE_OPERATIONS, lifecycleResult } from './lifecycle.mjs';
import { HOST_REGISTRY } from './registries.mjs';
import { effectiveHostRegistry } from './admitted.mjs';
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
 * @param {any} adapter — shape enforced by validateLifecycleAdapter, not the type system
 * @param {{ hostRegistry?: ReadonlyArray<{id: string}> }} [opts]
 * @returns {any}
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
 * @returns {any|null}|null}
 */
export function lifecycleAdapterFor(hostId) {
  return LIFECYCLE_ADAPTERS.get(hostId) ?? null;
}

/**
 * Host ids with a registered lifecycle adapter, in effectiveHostRegistry
 * order (HOST_REGISTRY plus any admitted externals — not Map-insertion
 * order) so callers get a deterministic, registry-driven iteration order.
 * With nothing admitted, effectiveHostRegistry() === HOST_REGISTRY (same
 * reference), so this is unchanged from the built-ins-only behavior.
 * @returns {string[]}
 */
export function hostsWithLifecycle() {
  return effectiveHostRegistry().filter((host) => LIFECYCLE_ADAPTERS.has(host.id)).map((host) => host.id);
}

/**
 * Host ids with a registered lifecycle adapter, restricted to BUILT-IN hosts
 * (LIFECYCLE_ADAPTERS keys intersected with HOST_REGISTRY — never an
 * admitted external, even after applyAdmitted). setup.mjs/sync.mjs/
 * uninstall.mjs's lifecycle loops destructure an opencode-SHAPED result
 * (stack.oc/.plugin/.agents/.skill, ret.undo/.artifacts) — those loop bodies
 * are not generic across hosts yet. Today that's unreachable dead code,
 * because registerAdmittedLifecycle is never called in production — but it
 * is ARMED: the moment something wires an admitted external's lifecycle
 * adapter in (registerAdmittedLifecycle exists for exactly that), a
 * non-opencode-shaped host would enter hostsWithLifecycle() and crash one of
 * those command loops on the first opencode-specific destructure. Command
 * loops use this function instead until external lifecycle EXECUTION and a
 * shape-agnostic loop body graduate together, in a later wave.
 * hostsWithLifecycle() above stays for pure registry queries, unaffected.
 * @returns {string[]}
 */
export function builtinHostsWithLifecycle() {
  return HOST_REGISTRY.filter((host) => LIFECYCLE_ADAPTERS.has(host.id)).map((host) => host.id);
}

// ── admitted (external) lifecycle adapters ─────────────────────────────────
// A derived adapter never runs third-party code in-process: each declared
// verb is a thin wrapper that shells out through the sibling's hook runner
// (runAdapterHook({hook, hostId, verb, timeoutMs, env}) -> {ok, stdout,
// exitCode, detail}) and interprets stdout as the JSON payload for that verb
// (e.g. a detect hook prints `{"observed": {...}}`) — the declarative-
// manifest + subprocess-hooks contract the dossier settled on. A verb the
// manifest never declared gets an honest no-op: it never ran, so nothing
// changed.

function parseHookPayload(result) {
  if (!result || typeof result.stdout !== 'string') return null;
  try {
    const parsed = JSON.parse(result.stdout);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function hookFailureResult(verb, result) {
  const detail = result?.detail || (result?.stdout || '').trim() || `hook exited ${result?.exitCode ?? 'unknown'}`;
  if (verb === 'detect' || verb === 'verify') return { observed: null, error: detail };
  if (verb === 'plan') return { changed: false, operations: [], error: detail };
  return lifecycleResult({ ok: false, changed: false, errors: [detail] });
}

/**
 * Build a five-verb lifecycle adapter for an admitted manifest. Declared
 * verbs (manifest.lifecycle[verb]) run through the hook runner; undeclared
 * verbs are honest no-ops satisfying validateLifecycleAdapter's function-per-
 * verb contract without fabricating a result. `runHook` is injectable —
 * defaults to a dynamic import of ./hook-runner.mjs (the sibling module),
 * fetched lazily so this factory (and this whole file) loads cleanly even
 * before that module exists, and so tests never pay for the import unless
 * they omit the injection on purpose.
 * @param {any} manifest — validateAdapterManifest's return shape
 * @param {{ runHook?: (args: any) => Promise<{ok:boolean, stdout:string, exitCode:number}> }} [opts]
 */
export function buildAdmittedLifecycleAdapter(manifest, { runHook } = {}) {
  const hostId = manifest.host.id;
  const declared = manifest.lifecycle ?? {};
  const adapter = { id: hostId };
  for (const verb of LIFECYCLE_OPERATIONS) {
    const hookEntry = declared[verb]?.hook;
    if (!hookEntry) {
      adapter[verb] = async () => lifecycleResult({ ok: true, changed: false, facts: null });
      continue;
    }
    adapter[verb] = async (context = {}) => {
      const run = runHook ?? (await import('./hook-runner.mjs')).runAdapterHook;
      const result = await run({
        hook: hookEntry, hostId, verb, timeoutMs: hookEntry.timeoutMs, env: context.env,
      });
      if (!result?.ok) return hookFailureResult(verb, result);
      const payload = parseHookPayload(result);
      if (payload === null) return hookFailureResult(verb, result);
      return verb === 'apply' || verb === 'undo' ? lifecycleResult(payload) : payload;
    };
  }
  return adapter;
}

/**
 * Register an admitted external manifest's derived lifecycle adapter. Unlike
 * registerBuiltinLifecycle, this checks the host id against
 * effectiveHostRegistry() (built-ins + admitted) rather than HOST_REGISTRY —
 * an admitted-but-not-yet-overlaid host id would otherwise never pass the
 * built-ins-only check.
 *
 * Not called anywhere in production yet: registering an external host here
 * makes it appear in hostsWithLifecycle() (registry-query, all hosts), but
 * setup.mjs/sync.mjs/uninstall.mjs deliberately read builtinHostsWithLifecycle()
 * instead, which stays built-ins-only. External lifecycle EXECUTION and a
 * shape-agnostic command-loop body (today's loops assume the opencode result
 * shape) graduate together, in a later wave — wiring a real caller for this
 * function ahead of that loop-body rewrite would crash setup/sync/uninstall
 * the moment a non-opencode-shaped host is admitted.
 * @param {any} manifest
 * @param {{ runHook?: (args: any) => Promise<any> }} [opts]
 */
export function registerAdmittedLifecycle(manifest, { runHook } = {}) {
  const hostId = manifest.host.id;
  if (!effectiveHostRegistry().some((host) => host.id === hostId)) {
    throw new TypeError(`lifecycle registry: unknown host id '${hostId}' — not present in effectiveHostRegistry`);
  }
  const adapter = buildAdmittedLifecycleAdapter(manifest, { runHook });
  validateLifecycleAdapter(adapter);
  LIFECYCLE_ADAPTERS.set(hostId, adapter);
  return adapter;
}
