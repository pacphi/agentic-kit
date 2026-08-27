// Fail-closed admission gate for externally-sourced host-adapter manifests
// (Adapter Contract Dossier). admitAdapters walks cfg.hostAdapters and, for
// each entry, validates the manifest, verifies its declared contract is one
// this version supports, and checks a canonicalized content hash against an
// injected consent store — never prompting interactively itself. Per-entry
// isolation: one bad adapter is refused in place and never affects any other
// entry or the built-in registries (try/caught per entry, in admitOne AND as
// a belt-and-suspenders net in admitAdapters).
import { HOST_REGISTRY } from './registries.mjs';
import { validateAdapterManifest } from './manifest.mjs';
import {
  baseDirForSource, hashAdapterContent, hashManifest,
} from './integrity.mjs';

export { baseDirForSource, canonicalizeManifest, hashAdapterContent, hashManifest } from './integrity.mjs';

export const SUPPORTED_CONTRACT = 1;


const builtinIds = () => new Set(HOST_REGISTRY.map((host) => host.id));

// ── admitOne decomposition ───────────────────────────────────────────────
// admitOne is a sequential fail-closed pipeline (ADR-0028/0029): each stage
// below either refuses the entry with its own {admitted:false, reason,
// detail} shape (unchanged strings — tests assert them) or hands the next
// stage what it computed. Splitting it into small, single-purpose functions
// keeps every stage's own complexity — and admitOne's own — low, without
// altering the per-entry isolation or any failure's reason/detail wording.

/** Shape-check the cfg.hostAdapters entry itself, before any I/O. */
function validateEntryShape(entry) {
  const name = entry?.name;
  if (typeof name !== 'string' || !name) {
    return { name: name ?? '(unknown)', admitted: false, reason: 'invalid-entry', detail: 'cfg.hostAdapters entry requires a name' };
  }
  if (typeof entry.source !== 'string' || !entry.source) {
    return { name, admitted: false, reason: 'invalid-entry', detail: 'cfg.hostAdapters entry requires a source' };
  }
  return null;
}

async function readEntryManifest(name, source, readManifest) {
  try {
    return { ok: true, raw: await readManifest(source) };
  } catch (error) {
    return { ok: false, failure: { name, admitted: false, reason: 'manifest-unreadable', detail: error?.message ?? String(error) } };
  }
}

/** cfg's own pinned contract (if declared) disagreeing with the manifest's
 * self-declared contract is a distinct failure from "unsupported version" —
 * it means the operator pinned to a manifest that changed underneath them. */
function checkContractPin(name, entry, raw) {
  if (entry.contract !== undefined && raw?.contract !== undefined && entry.contract !== raw.contract) {
    return {
      name, admitted: false, reason: 'contract-mismatch',
      detail: `cfg declares contract ${entry.contract}, manifest declares ${raw.contract}`,
    };
  }
  return null;
}

function parseEntryManifest(name, raw) {
  try {
    return { ok: true, manifest: validateAdapterManifest(raw) };
  } catch (error) {
    return { ok: false, failure: { name, admitted: false, reason: error?.reason ?? 'manifest-invalid', detail: error?.message ?? String(error) } };
  }
}

function checkHostIdentity(name, manifest, builtins) {
  if (manifest.contract !== SUPPORTED_CONTRACT) {
    return { name, admitted: false, reason: 'contract-version', detail: `unsupported contract ${manifest.contract}` };
  }
  if (manifest.host.id !== name) {
    return { name, admitted: false, reason: 'name-mismatch', detail: `cfg entry '${name}' does not match manifest host id '${manifest.host.id}'` };
  }
  if (builtins.has(manifest.host.id)) {
    return { name, admitted: false, reason: 'builtin-shadow', detail: `'${manifest.host.id}' is a built-in host id` };
  }
  return null;
}

function computeEntryIntegrity(name, manifest, source) {
  try {
    return { ok: true, integrity: hashAdapterContent(manifest, { baseDir: baseDirForSource(source) }) };
  } catch (error) {
    return { ok: false, failure: { name, admitted: false, reason: error?.reason ?? 'hook-integrity', detail: error?.message ?? String(error) } };
  }
}

/** Consent gate: the adapter's content hash must be BOTH recorded and
 * trusted at exactly that hash. */
function checkConsent(name, hash, consent) {
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
    return { name, admitted: false, reason: 'consent-stale', detail: `adapter content hash ${hash} does not match consented ${recorded}` };
  }
  return null;
}

async function admitOne(entry, { readManifest, consent, builtins }) {
  const shapeFailure = validateEntryShape(entry);
  if (shapeFailure) return shapeFailure;
  const { name } = entry;

  const manifestRead = await readEntryManifest(name, entry.source, readManifest);
  if (!manifestRead.ok) return manifestRead.failure;
  const { raw } = manifestRead;

  const contractPinFailure = checkContractPin(name, entry, raw);
  if (contractPinFailure) return contractPinFailure;

  const manifestParsed = parseEntryManifest(name, raw);
  if (!manifestParsed.ok) return manifestParsed.failure;
  const { manifest } = manifestParsed;

  const identityFailure = checkHostIdentity(name, manifest, builtins);
  if (identityFailure) return identityFailure;

  const integrityComputed = computeEntryIntegrity(name, manifest, entry.source);
  if (!integrityComputed.ok) return integrityComputed.failure;
  const { integrity } = integrityComputed;
  const { hash } = integrity;

  const consentFailure = checkConsent(name, hash, consent);
  if (consentFailure) return consentFailure;

  return { name, admitted: true, entry: manifest.host, manifest, integrity, contentHash: hash };
}

/**
 * @param {{ cfg: any, readManifest: (source: string) => Promise<any>,
 *   consent: { recordedHashFor(name: string): string|null, isTrusted(name: string, hash: string): boolean } }} args
 * @returns {Promise<Array<{name:string, admitted:boolean, reason?:string, detail?:string, entry?:any, manifest?:any, integrity?:any, contentHash?:string}>>}
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

// ── bootstrapHostAdapters decomposition ──────────────────────────────────
// Each helper below is one guarded, non-fatal stage of the bootstrap
// sequence (ADR-0031 §1/P2/P3) — extracted verbatim from the orchestrator's
// body so the orchestrator itself just sequences them, and each stage's own
// (independently small) complexity stays with the stage. `warnings` is a
// shared, mutated-in-place array throughout, matching the pre-decomposition
// code's own accumulation pattern.

/** The AQE provider bridge is an exact snapshot of THIS bootstrap pass —
 * cleared before every flag-on early return as well as before rebuilding,
 * so removing the final adapter or losing access to the consent store
 * never leaves a provider from a prior in-process bootstrap live. */
async function resetAqeProviderBridge() {
  try {
    const bridge = await import('./aqe-provider.mjs');
    bridge.resetAdmittedAqeProviders();
    return bridge;
  } catch {
    return null;
  }
}

/**
 * Resolve the consent store this bootstrap pass will use: the caller's
 * injection (tests) or a dynamic import of the sibling consent.mjs.
 * Returns `{ok:true, consentStore}` on success, or `{ok:false, result}`
 * carrying bootstrapHostAdapters' own early-return shape (every entry
 * warned 'consent-unavailable') when consent.mjs itself can't be loaded —
 * never fatal.
 */
async function resolveConsentStore(consent, entries) {
  if (consent) return { ok: true, consentStore: consent };
  try {
    // Sibling-owned module (consent.mjs); dynamic so this file loads even
    // before it lands, and so tests never pay for it unless they choose to.
    // consent.mjs exports recordedHashFor/isTrusted as plain named
    // functions (no wrapper object) — the module namespace itself already
    // satisfies {recordedHashFor(name), isTrusted(name,hash)}; the
    // consentStore/default fallbacks are just tolerance for a future
    // reshape, not the shape it ships today.
    const mod = /** @type {any} */ (await import('./consent.mjs'));
    return { ok: true, consentStore: mod.consentStore ?? mod.default ?? mod };
  } catch (error) {
    const warnings = entries.map((raw) => ({
      name: raw?.name ?? '(unknown)', reason: 'consent-unavailable', detail: error?.message ?? String(error),
    }));
    return { ok: false, result: { active: true, admitted: [], warnings } };
  }
}

/**
 * Keystone (ADR-0031 §1): build the per-host granted-capability lookup
 * BEFORE applying the overlay, so an earned canBePrimary/commandStatusline
 * is live in effectiveHostRegistry() from process start. Guarded and
 * non-fatal — one host's grant lookup failing must never block another
 * host's, or the admission result itself.
 *
 * CRITICAL: the hash passed to grantedCapabilitiesFor is the content
 * identity produced by admission, not a manifest-only fallback. It pins
 * both the validated manifest and any declared hook bytes, so a file edit
 * cannot leave a capability grant live under the old content hash.
 */
async function buildGrantsByName(admitted, warnings) {
  try {
    const { grantedCapabilitiesFor } = await import('./grants.mjs');
    // Object.create(null), not {} (F-6): admitted host ids come from
    // consented adapter names, which are attacker-influenceable in
    // principle — a plain object literal's prototype chain would make
    // 'constructor' a live (if inert) key collision. No inherited
    // properties at all closes that off entirely; admitted.mjs's own
    // Object.hasOwn guard on the read side is the belt to this suspenders.
    const grantsByName = Object.create(null);
    for (const result of admitted) {
      try {
        grantsByName[result.name] = grantedCapabilitiesFor(result.name, result.contentHash ?? hashManifest(result.manifest));
      } catch (error) {
        warnings.push({ name: result.name, reason: 'grant-lookup-failed', detail: error?.message ?? String(error) });
      }
    }
    return { grantsByName, grantedCapabilitiesForCurrentHash: grantedCapabilitiesFor };
  } catch {
    // grants.mjs unavailable — proceed ungranted (manifest-floor
    // capabilities only), exactly like the flag-off path. Never fatal.
    return { grantsByName: undefined, grantedCapabilitiesForCurrentHash: undefined };
  }
}

/**
 * AQE ADR-127 / issue #628: a manifest's aqe.provider block is only a
 * candidate. It becomes a live trampoline target after ALL local gates:
 * admission, explicit host enablement, and a hash-current aqeProvider
 * grant. The dedicated registry keeps this non-boolean identity out of
 * applyAdmitted's deliberately narrow host-capability overlay. One bad
 * provider is isolated to one warning.
 */
async function registerAqeProviderCandidates({
  aqeProviderBridge, admitted, cfg, grantsByName, grantedCapabilitiesForCurrentHash, sourceByName, consentStore,
  currentConfig, warnings,
}) {
  if (!aqeProviderBridge) return;
  const aqeCandidates = admitted.filter((result) => (
    !!result.manifest?.aqe?.provider
    && cfg.integrations?.hosts?.[result.name] === true
    && grantsByName && Object.hasOwn(grantsByName, result.name)
    && grantsByName[result.name]?.aqeProvider === true
  ));
  for (const result of aqeCandidates) {
    try {
      aqeProviderBridge.registerAdmittedAqeProvider(result.manifest, {
        baseDir: baseDirForSource(sourceByName.get(result.name)),
        integrity: result.integrity,
        contentHash: result.contentHash,
        // Bootstrap admission is a snapshot; execution authority is not.
        // The hidden AQE trampoline may wait on stdin while another
        // process revokes consent/grant or disables the host. Re-read all
        // three gates after prompt collection and snapshot capture,
        // immediately before spawn. Any read/shape failure denies.
        authorize: async () => {
          try {
            const liveCfg = currentConfig
              ? await currentConfig()
              : (await import('../config.mjs')).loadKitConfig();
            if (liveCfg?.integrations?.hosts?.[result.name] !== true) return false;
            const liveHash = result.contentHash;
            if (consentStore.recordedHashFor(result.name) !== liveHash
              || !consentStore.isTrusted(result.name, liveHash)) return false;
            return grantedCapabilitiesForCurrentHash(result.name, liveHash)?.aqeProvider === true;
          } catch {
            return false;
          }
        },
      });
    } catch (error) {
      warnings.push({
        name: result.name,
        reason: error?.reason ?? 'aqe-provider-registration-failed',
        detail: error?.message ?? String(error),
      });
    }
  }
}

/**
 * P2 (ADR-0031): an admitted manifest declaring both an execution block and
 * host.capabilities.canRouteActivities gets its execution adapter derived
 * and registered here, so `ak run` can route to it. Same guarded,
 * non-fatal posture as the rest of bootstrap: one adapter's registration
 * failure never blocks the others or the admission result.
 */
async function registerExecutionCandidates(admitted, sourceByName, warnings) {
  const executionCandidates = admitted.filter((result) => (
    result.manifest?.execution && result.entry?.capabilities?.canRouteActivities === true
  ));
  if (!executionCandidates.length) return;
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
        registerAdmittedExecution(result.manifest, {
          baseDir: baseDirForSource(sourceByName.get(result.name)), integrity: result.integrity,
        });
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

/**
 * P3 (ADR-0031): an admitted manifest declaring a lifecycle block gets its
 * derived lifecycle adapter registered here, so it appears in
 * hostsWithLifecycle() and setup/sync/uninstall's lifecycle loops can drive
 * it (gated per-run by lifecycleExecutionEnabled — registration alone
 * never runs a hook). Same guarded, non-fatal posture as the
 * execution-registration stage above: one adapter's registration failure
 * never blocks the others or the admission result. F-1 (same as execution):
 * baseDir anchors a relative lifecycle hook command to the adapter's own
 * directory — without it, a relative command would resolve against the
 * OPERATOR's cwd, arbitrary-code-execution with the consent hash unchanged.
 * Unlike execution (one hook, all-or-nothing), lifecycle has five
 * independently-optional verbs, so an unanchorable one is refused per-verb
 * (buildAdmittedLifecycleAdapter never wires it to spawn) rather than
 * failing the whole registration — the other, anchored/PATH-binary verbs
 * still register and work.
 */
async function registerLifecycleCandidates(admitted, sourceByName, warnings) {
  const lifecycleCandidates = admitted.filter((result) => !!result.manifest?.lifecycle);
  if (!lifecycleCandidates.length) return;
  try {
    const { registerAdmittedLifecycle } = await import('./lifecycle-registry.mjs');
    for (const result of lifecycleCandidates) {
      try {
        const baseDir = baseDirForSource(sourceByName.get(result.name));
        const adapter = registerAdmittedLifecycle(result.manifest, { baseDir, integrity: result.integrity });
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
 *   consent?: { recordedHashFor(name: string): string|null, isTrusted(name: string, hash: string): boolean },
 *   currentConfig?:()=>any|Promise<any> }} [args]
 */
export async function bootstrapHostAdapters({
  cfg, env = process.env, readManifest = defaultReadManifest, consent, currentConfig,
} = {}) {
  if (env?.AK_EXPERIMENTAL_HOST_ADAPTERS !== '1') return { active: false, admitted: [], warnings: [] };

  const aqeProviderBridge = await resetAqeProviderBridge();

  const entries = Array.isArray(cfg?.hostAdapters) ? cfg.hostAdapters : [];
  if (entries.length === 0) return { active: false, admitted: [], warnings: [] };

  const consentResolution = await resolveConsentStore(consent, entries);
  if (!consentResolution.ok) return consentResolution.result;
  const { consentStore } = consentResolution;

  const results = await admitAdapters({ cfg, readManifest, consent: consentStore });
  const admitted = results.filter((result) => result.admitted);
  const warnings = results.filter((result) => !result.admitted)
    .map(({ name, reason, detail }) => ({ name, reason, detail }));

  if (admitted.length) {
    const { applyAdmitted } = await import('./admitted.mjs');
    const { grantsByName, grantedCapabilitiesForCurrentHash } = await buildGrantsByName(admitted, warnings);
    applyAdmitted(admitted, { grantsByName });

    // name -> the cfg entry's own declared source, for F-1's baseDir
    // derivation below (admitted results carry the validated manifest, not
    // the raw cfg entry that named where it came from). Shared by every
    // registration stage below — one map, not a second copy — so a caller
    // correcting F-1 in one place can't drift from the others.
    const sourceByName = new Map(entries.map((entry) => [entry?.name, entry?.source]));

    await registerAqeProviderCandidates({
      aqeProviderBridge, admitted, cfg, grantsByName, grantedCapabilitiesForCurrentHash, sourceByName, consentStore,
      currentConfig, warnings,
    });
    await registerExecutionCandidates(admitted, sourceByName, warnings);
    await registerLifecycleCandidates(admitted, sourceByName, warnings);
  }

  return { active: true, admitted, warnings };
}
