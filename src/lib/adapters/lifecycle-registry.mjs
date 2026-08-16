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
import path from 'node:path';
import { validateLifecycleAdapter, LIFECYCLE_OPERATIONS, lifecycleResult } from './lifecycle.mjs';
import { HOST_REGISTRY } from './registries.mjs';
import { effectiveHostRegistry } from './admitted.mjs';
import { OPENCODE_LIFECYCLE_ADAPTER } from '../opencode.mjs';

const LIFECYCLE_ADAPTERS = new Map();
// F7 (Wave C security review — prioritized for P4's paired-overlay-reset
// integration, mirroring execution/admitted.mjs's own resetAllAdmitted
// pairing): tracks which LIFECYCLE_ADAPTERS keys came from
// registerAdmittedLifecycle (never a built-in) so resetAdmittedLifecycle()
// below can clear exactly those without disturbing 'opencode' (or any other
// built-in registered via registerBuiltinLifecycle).
const ADMITTED_LIFECYCLE_IDS = new Set();

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
 * admitted external, even after applyAdmitted). Kept as a pure, built-ins-
 * only registry query — e.g. for an install-hint lookup that only makes
 * sense against HOSTS' own package metadata.
 *
 * setup.mjs/sync.mjs/uninstall.mjs no longer use this to pick their loop's
 * iteration source (ADR-0031 P3): their lifecycle loops used to destructure
 * an opencode-SHAPED result (stack.oc/.plugin/.agents/.skill,
 * ret.undo/.artifacts) directly, which would have crashed the moment a
 * non-opencode-shaped admitted host entered the loop. That crash risk is
 * exactly what lifecycle-render.mjs's shape-dispatching renderer removes —
 * the command loops now iterate hostsWithLifecycle() (built-ins + admitted)
 * and render through renderApplyReport/renderUndoReport instead of raw
 * destructuring, gated per-host by lifecycleExecutionEnabled() below.
 * @returns {string[]}
 */
export function builtinHostsWithLifecycle() {
  return HOST_REGISTRY.filter((host) => LIFECYCLE_ADAPTERS.has(host.id)).map((host) => host.id);
}

/**
 * True when hostId is one of HOST_REGISTRY's own entries (never an admitted
 * external, even after applyAdmitted). Used by lifecycleExecutionEnabled and
 * detectionBinFor to tell a built-in from an admitted host without a command
 * reaching into registries.mjs directly.
 * @param {string} hostId
 * @returns {boolean}
 */
export function isBuiltinHost(hostId) {
  return HOST_REGISTRY.some((host) => host.id === hostId);
}

const EXPERIMENTAL_HOST_ADAPTERS_FLAG = 'AK_EXPERIMENTAL_HOST_ADAPTERS';

/**
 * Whether setup/sync/uninstall should actually exercise hostId's lifecycle
 * adapter this run (ADR-0031 P3). A BUILT-IN host is gated only by cfg's own
 * enablement — unchanged from before this wave. An ADMITTED external host
 * needs BOTH: explicit cfg enablement (opt-in exactly like opencode — there
 * is no pick-UI for external hosts yet, so enablement is operator-set in
 * kit.json) AND the experimental flag. Neither condition is ever inferred or
 * set here — this function only reads, never auto-enables anything.
 * @param {string} hostId
 * @param {any} cfg
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
export function lifecycleExecutionEnabled(hostId, cfg, env = process.env) {
  if (!cfg?.integrations?.hosts?.[hostId]) return false;
  if (isBuiltinHost(hostId)) return true;
  return env?.[EXPERIMENTAL_HOST_ADAPTERS_FLAG] === '1';
}

/**
 * The binary name a command loop should probe for hostId's CLI presence
 * before exercising its lifecycle adapter (mirrors the built-in convention
 * `have(hostId)` — a built-in's host id IS its binary name). An admitted
 * host's binary name is whatever its manifest declared
 * (manifest.detection.bin, always present on a validated manifest) —
 * buildAdmittedLifecycleAdapter stashes it on the registered adapter as
 * `.detectionBin` so this never needs a second store keyed by host id.
 * @param {string} hostId
 * @returns {string}
 */
export function detectionBinFor(hostId) {
  if (isBuiltinHost(hostId)) return hostId;
  return lifecycleAdapterFor(hostId)?.detectionBin ?? hostId;
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

// F4 (Wave C security review — the un-applied Wave B R-1 twin): `result.stdout`
// is the MERGED stdout+stderr (hook-runner.mjs's mergeCapture) — any stderr
// output (a deprecation warning, interpreter noise) breaks JSON.parse even
// when the hook fully succeeded, so a genuinely successful apply/undo would
// misreport as failed. `result.stdoutText` is the UNMERGED stdout only
// (hook-runner.mjs's boundedText(stdoutCaptured), the same field execution's
// own R-1 fix reads) — reading it here is the lifecycle-side twin of that
// fix, never applied to this file until now.
function parseHookPayload(result) {
  if (!result || typeof result.stdoutText !== 'string') return null;
  try {
    const parsed = JSON.parse(result.stdoutText);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// Minimal UTF-8-safe truncation (mirrors execution/handoff.mjs's own
// truncateUtf8 — that copy is canonical; not exported there, so this is a
// local twin) so a failure detail bounded from raw hook stdout can never
// promote an unbounded blob into lifecycle-render.mjs's print path (which
// feeds F3's own control-char stripping, but a huge string is still a
// separate flooding/DoS-adjacent concern worth bounding at the source).
function truncateUtf8(value, maxBytes) {
  const bytes = (v) => Buffer.byteLength(v, 'utf8');
  if (bytes(value) <= maxBytes) return value;
  if (maxBytes <= 3) return '.'.repeat(Math.max(0, maxBytes));
  let out = '';
  for (const char of value) {
    if (bytes(`${out}${char}…`) > maxBytes) break;
    out += char;
  }
  return `${out}…`;
}

function hookFailureResult(verb, result) {
  const detail = result?.detail
    || truncateUtf8((result?.stdoutText || '').trim(), 240)
    || `hook exited ${result?.exitCode ?? 'unknown'}`;
  if (verb === 'detect' || verb === 'verify') return { observed: null, error: detail };
  if (verb === 'plan') return { changed: false, operations: [], error: detail };
  return lifecycleResult({ ok: false, changed: false, errors: [detail] });
}

// F-1 (mirrors execution/admitted.mjs's own F-1 — that copy is canonical;
// this is a minimal, lifecycle-scoped replica since the check isn't exported
// there): a relative lifecycle hook command resolves against whatever `cwd`
// the child spawns with. With no anchored adapter base directory (a remote
// npm/https source has no persistent local bundle), that would fall back to
// the OPERATOR's process.cwd() — arbitrary-code-execution by planting a
// same-named file, with the consent hash unchanged. A bare interpreter/
// binary name found through PATH (node, hermes) is unaffected by cwd and
// stays legal; only a path-separator-bearing or script-looking bare token is
// refused. Not shared as an import (yet) — a later refactor can hoist this
// into a common module once a second caller needs it; for now the small
// duplication keeps this file independent of execution/admitted.mjs.
// F9 (Windows parity): exe/bat/cmd/com/ps1 included alongside the script
// extensions — Windows' CreateProcess searches the CURRENT DIRECTORY before
// PATH for a bare relative executable name, so a null baseDir with e.g.
// `hook.bat` is exactly as exploitable there as a relative `.mjs` is on
// POSIX and must be refused the same way.
const SCRIPT_LIKE_RE = /\.(?:mjs|cjs|js|ts|py|rb|sh|pl|exe|bat|cmd|com|ps1)$/i;

function looksRelative(token) {
  if (typeof token !== 'string' || !token) return false;
  if (path.isAbsolute(token)) return false;
  if (token.includes('/') || token.includes('\\')) return true;
  return SCRIPT_LIKE_RE.test(token);
}

function commandIsUnanchorable(command) {
  const [argv0, ...args] = command;
  if (looksRelative(argv0)) return true;
  return args.some((arg) => looksRelative(arg));
}

/** Honest refusal for a declared verb whose hook command is relative with no
 *  adapter base directory to anchor it — the hook subprocess is NEVER
 *  spawned for this verb (see commandIsUnanchorable above), so this can only
 *  ever be a refusal, never a fabricated success. Shaped exactly like
 *  hookFailureResult so callers (lifecycle-render.mjs's generic summary,
 *  runLifecycle) treat it identically to any other honest per-verb failure. */
function unanchoredResult(verb, hostId, command) {
  const detail = `'${hostId}' declares a relative lifecycle.${verb}.hook.command `
    + `(${JSON.stringify(command)}) with no anchored adapter base directory (a remote npm/https `
    + 'source has no persistent local bundle) — use an absolute path or a PATH binary';
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
 * they omit the injection on purpose. `baseDir` (F-1) is the adapter's own
 * directory — derived by the caller (admission.mjs) from the manifest's
 * `source` at registration time, `null` for a source with no persistent
 * local bundle (npm/https) — never process.cwd(). A verb whose hook.command
 * is relative and has no baseDir to anchor it is NEVER wired to spawn —
 * `adapter.unanchoredVerbs` names every verb refused this way, so a caller
 * (registerAdmittedLifecycle's bootstrap caller) can surface it as a warning
 * without needing to re-derive the check itself.
 * @param {any} manifest — validateAdapterManifest's return shape
 * @param {{ runHook?: (args: any) => Promise<{ok:boolean, stdout:string, exitCode:number}>,
 *   baseDir?: string|null }} [opts]
 */
export function buildAdmittedLifecycleAdapter(manifest, { runHook, baseDir = null } = {}) {
  const hostId = manifest.host.id;
  const declared = manifest.lifecycle ?? {};
  // Stashed alongside the verb functions (validateLifecycleAdapter only
  // requires id + the five verbs — extra own-properties are untouched) so
  // detectionBinFor(hostId) can find the manifest's own CLI binary name
  // without a second store keyed by host id.
  const adapter = { id: hostId, detectionBin: manifest.detection?.bin ?? hostId, unanchoredVerbs: [] };
  for (const verb of LIFECYCLE_OPERATIONS) {
    const hookEntry = declared[verb]?.hook;
    if (!hookEntry) {
      adapter[verb] = async () => lifecycleResult({ ok: true, changed: false, facts: null });
      continue;
    }
    if (baseDir == null && commandIsUnanchorable(hookEntry.command)) {
      adapter.unanchoredVerbs.push(verb);
      adapter[verb] = async () => unanchoredResult(verb, hostId, hookEntry.command);
      continue;
    }
    adapter[verb] = async (context = {}) => {
      const run = runHook ?? (await import('./hook-runner.mjs')).runAdapterHook;
      const result = await run({
        hook: hookEntry, hostId, verb, timeoutMs: hookEntry.timeoutMs, env: context.env,
        // F-1: anchor a relative command to the adapter's own directory when
        // one was declared; with no baseDir, the check above already proved
        // this command has no relative component a cwd could redirect (bare
        // PATH binaries only), so omitting cwd (Node's own default — inherit
        // ak's process.cwd()) is safe and never reopens the arbitrary-code-
        // execution vector this exists to close.
        ...(baseDir == null ? {} : { cwd: baseDir }),
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
 * Called from admission.mjs's bootstrapHostAdapters (ADR-0031 P3), as a
 * sibling to the execution-registration block: any admitted manifest
 * declaring a lifecycle block gets its adapter registered here so it appears
 * in hostsWithLifecycle(). Registration alone never runs a hook — a
 * registered admitted host is only actually EXERCISED by setup/sync/
 * uninstall's loops once lifecycleExecutionEnabled() also passes (the
 * experimental flag AND explicit cfg enablement) for that run. `baseDir`
 * (F-1) is threaded straight through to buildAdmittedLifecycleAdapter — the
 * caller derives it from the manifest's own source the same way the
 * execution-registration block does (baseDirForSource).
 * @param {any} manifest
 * @param {{ runHook?: (args: any) => Promise<any>, baseDir?: string|null }} [opts]
 */
export function registerAdmittedLifecycle(manifest, { runHook, baseDir = null } = {}) {
  const hostId = manifest.host.id;
  if (!effectiveHostRegistry().some((host) => host.id === hostId)) {
    throw new TypeError(`lifecycle registry: unknown host id '${hostId}' — not present in effectiveHostRegistry`);
  }
  const adapter = buildAdmittedLifecycleAdapter(manifest, { runHook, baseDir });
  validateLifecycleAdapter(adapter);
  LIFECYCLE_ADAPTERS.set(hostId, adapter);
  ADMITTED_LIFECYCLE_IDS.add(hostId);
  return adapter;
}

/**
 * Clear every ADMITTED lifecycle registration (never a built-in — 'opencode'
 * and any other registerBuiltinLifecycle entry survive untouched). Pairs
 * with adapters/admitted.mjs's resetAdmitted() and execution/admitted.mjs's
 * resetAdmittedExecution() the same way execution/admitted.mjs's own
 * resetAllAdmitted() pairs those two: a test (or a future paired-reset
 * helper) that resets the host overlay without also resetting this one would
 * otherwise leave a stale, unreachable-but-still-registered lifecycle
 * adapter behind for a host id that effectiveHostRegistry() no longer knows
 * about.
 */
export function resetAdmittedLifecycle() {
  for (const hostId of ADMITTED_LIFECYCLE_IDS) LIFECYCLE_ADAPTERS.delete(hostId);
  ADMITTED_LIFECYCLE_IDS.clear();
}
