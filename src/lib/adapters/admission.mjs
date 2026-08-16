// Fail-closed admission gate for externally-sourced host-adapter manifests
// (Adapter Contract Dossier). admitAdapters walks cfg.hostAdapters and, for
// each entry, validates the manifest, verifies its declared contract is one
// this version supports, and checks a canonicalized content hash against an
// injected consent store — never prompting interactively itself. Per-entry
// isolation: one bad adapter is refused in place and never affects any other
// entry or the built-in registries (try/caught per entry, in admitOne AND as
// a belt-and-suspenders net in admitAdapters).
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { HOST_REGISTRY } from './registries.mjs';
import { validateAdapterManifest } from './manifest.mjs';

export const SUPPORTED_CONTRACT = 1;

/** The adapter's own directory (F-1, ADR-0031): where its execution/lifecycle
 *  hooks resolve a relative command FROM, never the operator's process.cwd()
 *  when `ak run` was invoked. A file-sourced manifest anchors to its own
 *  directory — `fs.realpathSync` so a symlinked manifest can't relocate that
 *  pin out from under consent. An npm/https source has no persistent local
 *  bundle (resolved, hashed, and discarded per admission pass — sources.mjs)
 *  so there is nothing to anchor to: `null`. buildAdmittedExecutionAdapter
 *  (execution/admitted.mjs) then refuses a relative hook command outright
 *  for a `null` baseDir rather than guessing a cwd. An unreadable/vanished
 *  file source also resolves to `null` — the same honest refusal, not a
 *  silent fallback to process.cwd(). */
function baseDirForSource(source) {
  if (typeof source !== 'string' || !source
    || source.startsWith('https://') || source.startsWith('http://') || source.startsWith('npm:')) {
    return null;
  }
  try {
    return path.dirname(fs.realpathSync(source));
  } catch {
    return null;
  }
}

/** Deterministic, key-sorted JSON — same stable-stringify shape used
 *  elsewhere in this codebase (e.g. opencode.mjs's deepEqual) so two manifests
 *  that differ only in key order or incidental whitespace hash identically.
 *  The sort comparator is a plain code-unit compare, NOT localeCompare: with
 *  localeCompare, key order (and therefore the hash) could shift across
 *  locales (e.g. en_US vs sv_SE collation), so a CI runner or container with
 *  a different locale than where consent was recorded could see a bogus
 *  consent-stale refusal for a manifest that never actually changed. */
export function canonicalizeManifest(value) {
  return JSON.stringify(value, (_key, val) => (
    val && typeof val === 'object' && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : val
  ));
}

export function hashManifest(value) {
  return createHash('sha256').update(canonicalizeManifest(value)).digest('hex');
}

const builtinIds = () => new Set(HOST_REGISTRY.map((host) => host.id));

async function admitOne(entry, { readManifest, consent, builtins }) {
  const name = entry?.name;
  if (typeof name !== 'string' || !name) {
    return { name: name ?? '(unknown)', admitted: false, reason: 'invalid-entry', detail: 'cfg.hostAdapters entry requires a name' };
  }
  if (typeof entry.source !== 'string' || !entry.source) {
    return { name, admitted: false, reason: 'invalid-entry', detail: 'cfg.hostAdapters entry requires a source' };
  }

  let raw;
  try {
    raw = await readManifest(entry.source);
  } catch (error) {
    return { name, admitted: false, reason: 'manifest-unreadable', detail: error?.message ?? String(error) };
  }

  // cfg's own pinned contract (if declared) disagreeing with the manifest's
  // self-declared contract is a distinct failure from "unsupported version" —
  // it means the operator pinned to a manifest that changed underneath them.
  if (entry.contract !== undefined && raw?.contract !== undefined && entry.contract !== raw.contract) {
    return {
      name, admitted: false, reason: 'contract-mismatch',
      detail: `cfg declares contract ${entry.contract}, manifest declares ${raw.contract}`,
    };
  }

  let manifest;
  try {
    manifest = validateAdapterManifest(raw);
  } catch (error) {
    return { name, admitted: false, reason: error?.reason ?? 'manifest-invalid', detail: error?.message ?? String(error) };
  }

  if (manifest.contract !== SUPPORTED_CONTRACT) {
    return { name, admitted: false, reason: 'contract-version', detail: `unsupported contract ${manifest.contract}` };
  }

  if (manifest.host.id !== name) {
    return { name, admitted: false, reason: 'name-mismatch', detail: `cfg entry '${name}' does not match manifest host id '${manifest.host.id}'` };
  }

  if (builtins.has(manifest.host.id)) {
    return { name, admitted: false, reason: 'builtin-shadow', detail: `'${manifest.host.id}' is a built-in host id` };
  }

  const hash = hashManifest(manifest);
  let recorded;
  try {
    recorded = consent.recordedHashFor(name);
  } catch (error) {
    return { name, admitted: false, reason: 'consent-error', detail: error?.message ?? String(error) };
  }
  if (recorded == null) {
    return { name, admitted: false, reason: 'consent-required', detail: `no recorded consent for '${name}'` };
  }

  let trusted;
  try {
    trusted = consent.isTrusted(name, hash);
  } catch (error) {
    return { name, admitted: false, reason: 'consent-error', detail: error?.message ?? String(error) };
  }
  if (!trusted || recorded !== hash) {
    return { name, admitted: false, reason: 'consent-stale', detail: `manifest hash ${hash} does not match consented ${recorded}` };
  }

  return { name, admitted: true, entry: manifest.host, manifest };
}

/**
 * @param {{ cfg: any, readManifest: (source: string) => Promise<any>,
 *   consent: { recordedHashFor(name: string): string|null, isTrusted(name: string, hash: string): boolean } }} args
 * @returns {Promise<Array<{name:string, admitted:boolean, reason?:string, detail?:string, entry?:any, manifest?:any}>>}
 */
export async function admitAdapters({ cfg, readManifest, consent }) {
  const entries = Array.isArray(cfg?.hostAdapters) ? cfg.hostAdapters : [];
  const builtins = builtinIds();
  const results = [];
  // Sequential, not Promise.all: entries are independent, but sequential
  // admission keeps refusal isolation trivial to reason about (and cfg's
  // adapter counts are small — this is not a hot loop).
  for (const entry of entries) {
    try {
      results.push(await admitOne(entry, { readManifest, consent, builtins }));
    } catch (error) {
      // Belt-and-suspenders: admitOne already catches every known failure
      // point, but an unforeseen throw must still isolate to this one entry.
      results.push({ name: entry?.name ?? '(unknown)', admitted: false, reason: 'admission-error', detail: error?.message ?? String(error) });
    }
  }
  return results;
}

async function defaultReadManifest(source) {
  // Lazy dynamic import — keeps bootstrapHostAdapters's flag-off zero-cost
  // property intact (no import happens unless a readManifest call actually
  // runs, which only happens during admission with the flag set and
  // adapters configured). Ordering is mandated by security review: resolve
  // -> validate -> hash -> consent. The resolver (sources.mjs) runs here,
  // BEFORE admitOne ever hashes the manifest, so consent pins the RESOLVED
  // bytes — a mutable remote source (an npm dist-tag moving, a URL's
  // content changing) invalidates consent automatically ('consent-stale')
  // on the next admission pass, rather than being silently re-trusted.
  const { resolveManifestSource } = await import('./sources.mjs');
  const { raw } = await resolveManifestSource(source);
  return raw;
}

/**
 * CLI bootstrap entry point — the only call site production code needs
 * (`bootstrapHostAdapters({cfg, env})`, wired from bin/agentic-kit.mjs).
 * Everything is guarded and non-fatal: with the flag unset or no configured
 * adapters, this returns immediately with zero side effects (no dynamic
 * import, no filesystem read, no admission work) — the flag-off no-op is
 * pinned by a test. `readManifest`/`consent` are optional injection points
 * for tests; production relies on the defaults (a plain fs+JSON.parse reader,
 * and a dynamic import of the sibling consent store in ./consent.mjs).
 * @param {{ cfg?: any, env?: NodeJS.ProcessEnv, readManifest?: (source: string) => Promise<any>,
 *   consent?: { recordedHashFor(name: string): string|null, isTrusted(name: string, hash: string): boolean } }} [args]
 */
export async function bootstrapHostAdapters({
  cfg, env = process.env, readManifest = defaultReadManifest, consent,
} = {}) {
  if (env?.AK_EXPERIMENTAL_HOST_ADAPTERS !== '1') return { active: false, admitted: [], warnings: [] };
  const entries = Array.isArray(cfg?.hostAdapters) ? cfg.hostAdapters : [];
  if (entries.length === 0) return { active: false, admitted: [], warnings: [] };

  let consentStore = consent;
  if (!consentStore) {
    try {
      // Sibling-owned module (consent.mjs); dynamic so this file loads even
      // before it lands, and so tests never pay for it unless they choose to.
      // consent.mjs exports recordedHashFor/isTrusted as plain named
      // functions (no wrapper object) — the module namespace itself already
      // satisfies {recordedHashFor(name), isTrusted(name,hash)}; the
      // consentStore/default fallbacks are just tolerance for a future
      // reshape, not the shape it ships today.
      // Cast to `any`: consent.mjs's real, current shape has neither
      // `consentStore` nor `default` — the fallback chain below is tolerance
      // for a future reshape (see the comment above), not today's actual
      // module namespace type, so a literal type there would just be wrong.
      const mod = /** @type {any} */ (await import('./consent.mjs'));
      consentStore = mod.consentStore ?? mod.default ?? mod;
    } catch (error) {
      const warnings = entries.map((raw) => ({
        name: raw?.name ?? '(unknown)', reason: 'consent-unavailable', detail: error?.message ?? String(error),
      }));
      return { active: true, admitted: [], warnings };
    }
  }

  const results = await admitAdapters({ cfg, readManifest, consent: consentStore });
  const admitted = results.filter((result) => result.admitted);
  const warnings = results.filter((result) => !result.admitted)
    .map(({ name, reason, detail }) => ({ name, reason, detail }));

  if (admitted.length) {
    const { applyAdmitted } = await import('./admitted.mjs');
    applyAdmitted(admitted);

    // name -> the cfg entry's own declared source, for F-1's baseDir
    // derivation below (admitted results carry the validated manifest, not
    // the raw cfg entry that named where it came from). Shared by both the
    // execution- and lifecycle-registration blocks below — one map, not a
    // second copy — so a caller correcting F-1 in one place can't drift from
    // the other.
    const sourceByName = new Map(entries.map((entry) => [entry?.name, entry?.source]));

    // P2 (ADR-0031): an admitted manifest declaring both an execution block
    // and host.capabilities.canRouteActivities gets its execution adapter
    // derived and registered here, so `ak run` can route to it. Same
    // guarded, non-fatal posture as the rest of bootstrap: one adapter's
    // registration failure never blocks the others or the admission result.
    const executionCandidates = admitted.filter((result) => (
      result.manifest?.execution && result.entry?.capabilities?.canRouteActivities === true
    ));
    if (executionCandidates.length) {
      try {
        const { registerAdmittedExecution } = await import('../execution/admitted.mjs');
        for (const result of executionCandidates) {
          // F-5 (ADR-0029 §2): a manifest that never declared the
          // cli-subprocess driving surface gets no cli-subprocess execution
          // adapter — refused with its own reason, before even attempting
          // registration (buildAdmittedExecutionAdapter re-checks this too,
          // defence-in-depth for any caller that bypasses this filter).
          if (!result.manifest?.driving?.surfaces?.includes('cli-subprocess')) {
            warnings.push({
              name: result.name, reason: 'surface-unsupported',
              detail: `'${result.name}' declares an execution block but not driving.surfaces including 'cli-subprocess'`,
            });
            continue;
          }
          try {
            registerAdmittedExecution(result.manifest, { baseDir: baseDirForSource(sourceByName.get(result.name)) });
          } catch (error) {
            warnings.push({ name: result.name, reason: error?.reason ?? 'execution-registration-failed', detail: error?.message ?? String(error) });
          }
        }
      } catch (error) {
        for (const result of executionCandidates) {
          warnings.push({ name: result.name, reason: 'execution-registration-failed', detail: error?.message ?? String(error) });
        }
      }
    }

    // P3 (ADR-0031): an admitted manifest declaring a lifecycle block gets its
    // derived lifecycle adapter registered here, so it appears in
    // hostsWithLifecycle() and setup/sync/uninstall's lifecycle loops can
    // drive it (gated per-run by lifecycleExecutionEnabled — registration
    // alone never runs a hook). Same guarded, non-fatal posture as the
    // execution-registration block above: one adapter's registration failure
    // never blocks the others or the admission result. F-1 (same as
    // execution above): baseDir anchors a relative lifecycle hook command to
    // the adapter's own directory — without it, a relative command would
    // resolve against the OPERATOR's cwd, arbitrary-code-execution with the
    // consent hash unchanged. Unlike execution (one hook, all-or-nothing),
    // lifecycle has five independently-optional verbs, so an unanchorable
    // one is refused per-verb (buildAdmittedLifecycleAdapter never wires it
    // to spawn) rather than failing the whole registration — the other,
    // anchored/PATH-binary verbs still register and work.
    const lifecycleCandidates = admitted.filter((result) => !!result.manifest?.lifecycle);
    if (lifecycleCandidates.length) {
      try {
        const { registerAdmittedLifecycle } = await import('./lifecycle-registry.mjs');
        for (const result of lifecycleCandidates) {
          try {
            const baseDir = baseDirForSource(sourceByName.get(result.name));
            const adapter = registerAdmittedLifecycle(result.manifest, { baseDir });
            if (adapter.unanchoredVerbs.length) {
              warnings.push({
                name: result.name, reason: 'lifecycle-unanchored',
                detail: `'${result.name}' lifecycle hook(s) refused (relative command, no anchored adapter `
                  + `base directory): ${adapter.unanchoredVerbs.join(', ')}`,
              });
            }
          } catch (error) {
            warnings.push({ name: result.name, reason: error?.reason ?? 'lifecycle-registration-failed', detail: error?.message ?? String(error) });
          }
        }
      } catch (error) {
        for (const result of lifecycleCandidates) {
          warnings.push({ name: result.name, reason: 'lifecycle-registration-failed', detail: error?.message ?? String(error) });
        }
      }
    }
  }

  return { active: true, admitted, warnings };
}
