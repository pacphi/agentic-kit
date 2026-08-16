// Adapter-manifest schema + validator (Adapter Contract Dossier: an external
// host adapter is DATA plus consented subprocess hooks — no third-party code
// ever runs in-process). validateAdapterManifest is the STRUCTURAL cap layer:
// an ineligible claim (canBePrimary, an aqeProvider binding, a command
// statusline, a path-traversal guidanceFile) must be INEXPRESSIBLE by a
// manifest that parses at all, not merely refused later at runtime. Every
// rejection carries a named `.reason` (ManifestRejected#reason) so admission.mjs
// and its tests can distinguish failure modes without parsing message text.
import {
  assertEnum, assertId, assertRecord, assertStringArray, immutable,
} from './schema.mjs';
import { validateHostAdapter, HOST_REGISTRY, PROJECTION_REGISTRY, OBSERVABILITY_REGISTRY } from './registries.mjs';
import { LIFECYCLE_OPERATIONS } from './lifecycle.mjs';

const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-.]+)?(?:\+[0-9A-Za-z-.]+)?$/;

export const DRIVING_SURFACES = Object.freeze(['cli-subprocess', 'acp', 'mcp']);

// manifest.trust has a lighter shape than host.trust ({ changes: [...] }, no
// approvalPolicy) — see the Wave 4 final report for why this is a local,
// manifest-scoped enum rather than an extension of registries.mjs's
// TRUST_CHANGE_KINDS: every entry in a manifest's trust.changes is, by
// construction, a third-party-adapter-sourced grant, so one kind suffices
// today and registries.mjs stays untouched.
export const MANIFEST_TRUST_KINDS = Object.freeze(['third-party-adapter']);
const MANIFEST_TRUST_SCOPES = Object.freeze(['project', 'user']);

export class ManifestRejected extends TypeError {
  constructor(reason, detail) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = 'ManifestRejected';
    this.reason = reason;
  }
}

// ── strict allowlists (Wave 4 security remediation, P0-A) ──────────────────
// Consent hashes the VALIDATED manifest (see hashManifest in admission.mjs),
// not the operator's raw file. Before this allowlist, an unrecognized
// TOP-LEVEL key was silently dropped (not rejected) before hashing — so
// hashManifest(manifest) and the operator's reviewed file could diverge in
// meaning while still hashing identically, and a recorded consent would
// cover content the operator never saw. Nested extras under host/
// host.install/host.legacy fared worse: those sub-validators structuredClone
// the ENTIRE input object (registries.mjs's validateHostAdapter has no
// allowlist of its own — built-ins must keep working through it unchanged),
// so an unrecognized nested key survived verbatim into the admitted host
// entry and effectiveHostRegistry(). That matters specifically for
// host.install (a future installHost() runs `npm install -g ${host.pkg}` —
// providers.mjs) and host.legacy (hosts.mjs/providers.mjs read enableEnv,
// aqeProvider, guidanceFile, etc. for real env/file wiring). These lists are
// exactly what those two downstream readers (registries.mjs's
// validateHostAdapter, src/lib/hosts.mjs, src/lib/providers.mjs) consume —
// widen them only alongside a new legitimate consumer, never speculatively.
const MANIFEST_ALLOWED_KEYS = Object.freeze([
  'name', 'version', 'contract', 'host', 'detection', 'driving', 'lifecycle', 'trust',
]);
// Everything validateHostAdapter itself reads (id, label, install,
// capabilities, trust, enabledByDefault, configProjection, observability)
// plus the two fields it structuredClones through untouched but that a real
// downstream reader consumes: `auth` (src/lib/hosts.mjs's HOST_ADAPTERS
// spreads host.auth for canDriveSession hosts) and `legacy` (this file's own
// structural caps below, plus hosts.mjs/providers.mjs).
const HOST_ALLOWED_KEYS = Object.freeze([
  'id', 'label', 'install', 'capabilities', 'auth', 'legacy', 'trust', 'configProjection', 'observability', 'enabledByDefault',
]);
// bin + externalInstallPolicy are validated by validateHostAdapter;
// npmPackage is read by providers.mjs (`HOSTS` -> `host.install.npmPackage`
// -> `npm install -g <pkg>`) but never checked there — allowlisted here so
// it round-trips for a BUILT-IN host, then explicitly forbidden below for an
// EXTERNAL one (an adapter must never name a package ak would install).
const HOST_INSTALL_ALLOWED_KEYS = Object.freeze(['bin', 'npmPackage', 'externalInstallPolicy']);
// The legacy fields real built-in hosts carry and real readers consume:
// guidanceFile/configFormat/statusline/aqeProvider/envMarkers (hosts.mjs's
// HOST_ADAPTERS) and enableEnv (providers.mjs's HOSTS/commandHosts).
const HOST_LEGACY_ALLOWED_KEYS = Object.freeze([
  'guidanceFile', 'configFormat', 'statusline', 'aqeProvider', 'envMarkers', 'enableEnv',
]);
// The canonical host-capability names, derived from a built-in entry so this
// can't drift from registries.mjs's private HOST_CAPABILITIES list.
const HOST_CAPABILITY_KEYS = Object.freeze(Object.keys(HOST_REGISTRY[0].capabilities));

/**
 * Reject any own key of `value` not in `allowed`, named ManifestRejected
 * ('unknown-field'). A non-plain-object `value` is left alone — the real
 * structural validator downstream reports that shape error with its own
 * (existing) reason, so this never masks e.g. "host must be an object".
 * @param {any} value
 * @param {readonly string[]} allowed
 * @param {string} field — dotted path under 'manifest', e.g. 'host.install'; '' for the root
 */
function assertNoUnknownKeys(value, allowed, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      const path = field ? `manifest.${field}` : 'manifest';
      throw new ManifestRejected('unknown-field', `${path} has unknown key '${key}'`);
    }
  }
}

// Built from the exported REGISTRY arrays (not the private *_MAP objects
// registries.mjs keeps internal) so this module needs no edit to
// registries.mjs to reuse the same referential-integrity checks built-ins get.
const projectionMap = Object.fromEntries(PROJECTION_REGISTRY.map((entry) => [entry.id, entry]));
const observabilityMap = Object.fromEntries(OBSERVABILITY_REGISTRY.map((entry) => [entry.id, entry]));

function validateDetection(value) {
  assertRecord(value, 'detection');
  assertNoUnknownKeys(value, ['bin', 'versionArgs', 'versionPattern'], 'detection');
  try {
    assertId(value.bin, 'detection.bin');
  } catch (error) {
    throw new ManifestRejected('invalid-detection', error.message);
  }
  if (value.versionArgs !== undefined) {
    try {
      assertStringArray(value.versionArgs, 'detection.versionArgs');
    } catch (error) {
      throw new ManifestRejected('invalid-detection', error.message);
    }
  }
  if (value.versionPattern !== undefined) {
    if (typeof value.versionPattern !== 'string' || !value.versionPattern) {
      throw new ManifestRejected('invalid-detection', 'detection.versionPattern must be a non-empty string');
    }
    try {
      new RegExp(value.versionPattern); // validity probe only, never used to match here
    } catch {
      throw new ManifestRejected('invalid-detection', 'detection.versionPattern must be a valid regular expression source');
    }
  }
  return structuredClone(value);
}

function validateDriving(value) {
  assertRecord(value, 'driving');
  assertNoUnknownKeys(value, ['surfaces'], 'driving');
  try {
    assertStringArray(value.surfaces, 'driving.surfaces', { allowEmpty: false });
  } catch (error) {
    throw new ManifestRejected('invalid-driving-surfaces', error.message);
  }
  for (const surface of value.surfaces) {
    if (!DRIVING_SURFACES.includes(surface)) {
      throw new ManifestRejected('invalid-driving-surfaces', `unknown driving surface: ${surface}`);
    }
  }
  return structuredClone(value);
}

function validateManifestLifecycle(value) {
  assertRecord(value, 'lifecycle');
  for (const [verb, entry] of Object.entries(value)) {
    if (!LIFECYCLE_OPERATIONS.includes(verb)) {
      throw new ManifestRejected('invalid-lifecycle-verb', `unknown lifecycle verb: ${verb}`);
    }
    assertRecord(entry, `lifecycle.${verb}`);
    assertNoUnknownKeys(entry, ['hook'], `lifecycle.${verb}`);
    assertRecord(entry.hook, `lifecycle.${verb}.hook`);
    assertNoUnknownKeys(entry.hook, ['command', 'timeoutMs'], `lifecycle.${verb}.hook`);
    try {
      assertStringArray(entry.hook.command, `lifecycle.${verb}.hook.command`, { allowEmpty: false });
    } catch (error) {
      throw new ManifestRejected('invalid-lifecycle-hook', error.message);
    }
    if (entry.hook.timeoutMs !== undefined
      && (!Number.isInteger(entry.hook.timeoutMs) || entry.hook.timeoutMs <= 0)) {
      throw new ManifestRejected('invalid-lifecycle-hook', `lifecycle.${verb}.hook.timeoutMs must be a positive integer`);
    }
  }
  return structuredClone(value);
}

function validateManifestTrust(value) {
  assertRecord(value, 'trust');
  assertNoUnknownKeys(value, ['changes'], 'trust');
  if (!Array.isArray(value.changes)) throw new ManifestRejected('invalid-trust', 'trust.changes must be an array');
  const ids = new Set();
  for (const [index, change] of value.changes.entries()) {
    const field = `trust.changes[${index}]`;
    // Unknown-key rejection stays OUTSIDE the catch so it keeps the uniform
    // 'unknown-field' reason every other sub-structure uses, rather than being
    // re-labeled 'invalid-trust'.
    if (change && typeof change === 'object' && !Array.isArray(change)) {
      assertNoUnknownKeys(change, ['id', 'kind', 'scope', 'owner', 'value', 'effect'], field);
    }
    try {
      assertRecord(change, field);
      assertId(change.id, `${field}.id`);
    } catch (error) {
      throw new ManifestRejected('invalid-trust', error.message);
    }
    if (ids.has(change.id)) throw new ManifestRejected('invalid-trust', `${field} duplicate id: ${change.id}`);
    ids.add(change.id);
    try {
      assertEnum(change.kind, MANIFEST_TRUST_KINDS, `${field}.kind`);
      assertEnum(change.scope, MANIFEST_TRUST_SCOPES, `${field}.scope`);
      for (const name of ['owner', 'value', 'effect']) {
        if (typeof change[name] !== 'string' || !change[name]) throw new TypeError(`${field}.${name} is required`);
      }
    } catch (error) {
      throw new ManifestRejected('invalid-trust', error.message);
    }
  }
  return structuredClone(value);
}

/**
 * Validate one adapter manifest document. Throws ManifestRejected (a named
 * `.reason`) on any structural or capability-cap violation; returns a frozen,
 * fully independent copy on success. `projections`/`observability` are
 * injectable for tests, defaulting to the real built-in registries.
 */
export function validateAdapterManifest(value, { projections = projectionMap, observability = observabilityMap } = {}) {
  assertRecord(value, 'manifest');
  assertNoUnknownKeys(value, MANIFEST_ALLOWED_KEYS, '');

  try {
    assertId(value.name, 'manifest.name');
  } catch (error) {
    throw new ManifestRejected('invalid-id', error.message);
  }

  if (typeof value.version !== 'string' || !SEMVER_RE.test(value.version)) {
    throw new ManifestRejected('invalid-version', 'manifest.version must be semver (e.g. 1.2.3)');
  }

  if (!Number.isInteger(value.contract) || value.contract < 1) {
    throw new ManifestRejected('invalid-contract', 'manifest.contract must be a positive integer');
  }

  // ── host-layer allowlist wrapper, BEFORE validateHostAdapter runs ──────
  // validateHostAdapter is shared with the built-in registry (registries.mjs)
  // and must keep structuredClone-ing whatever it's handed — so the
  // allowlisting happens here, at the manifest (external-adapter-only) layer,
  // never inside that shared validator.
  if (value.host && typeof value.host === 'object' && !Array.isArray(value.host)) {
    assertNoUnknownKeys(value.host, HOST_ALLOWED_KEYS, 'host');
    if (value.host.install && typeof value.host.install === 'object' && !Array.isArray(value.host.install)) {
      assertNoUnknownKeys(value.host.install, HOST_INSTALL_ALLOWED_KEYS, 'host.install');
      if (value.host.install.npmPackage != null) {
        throw new ManifestRejected('external-npm-package', 'external adapters may not declare host.install.npmPackage — detect-never-overwrite only');
      }
      try {
        assertId(value.host.install.bin, 'host.install.bin');
      } catch (error) {
        throw new ManifestRejected('invalid-install-bin', error.message);
      }
    }
    assertNoUnknownKeys(value.host.legacy, HOST_LEGACY_ALLOWED_KEYS, 'host.legacy');
    // Capability keys are allowlisted to the canonical set too, so a
    // differently-cased or extra key ('CanBePrimary', 'ADMIN') can't ride
    // along inert — the cap-bypass surface is provably closed, not merely
    // harmless because consumers happen to read the exact lowercase flag.
    assertNoUnknownKeys(value.host.capabilities, HOST_CAPABILITY_KEYS, 'host.capabilities');
  }

  let host;
  try {
    host = validateHostAdapter(value.host, { projections, observability });
  } catch (error) {
    throw new ManifestRejected('invalid-host', error.message);
  }

  // ── structural caps: these claims must be INEXPRESSIBLE, not merely
  // refused at runtime — an external manifest can never assert them true. ──
  if (host.capabilities.canBePrimary === true) {
    throw new ManifestRejected('cap-can-be-primary', 'external adapters may not claim host.capabilities.canBePrimary');
  }
  if (host.capabilities.commandStatusline === true) {
    throw new ManifestRejected('cap-command-statusline', 'external adapters may not claim host.capabilities.commandStatusline');
  }
  if (host.legacy != null && host.legacy.aqeProvider != null) {
    throw new ManifestRejected('cap-aqe-provider', 'external adapters may not claim host.legacy.aqeProvider');
  }
  // Wave-1 review's traversal finding, enforced at schema level: guidanceFile
  // must be an id-shaped slug, never a path (`../../etc/passwd` fails assertId).
  if (host.legacy != null && host.legacy.guidanceFile !== undefined) {
    try {
      assertId(host.legacy.guidanceFile, 'host.legacy.guidanceFile');
    } catch (error) {
      throw new ManifestRejected('invalid-guidance-file', error.message);
    }
  }

  const detection = validateDetection(value.detection);
  const driving = validateDriving(value.driving);
  const lifecycle = value.lifecycle === undefined ? undefined : validateManifestLifecycle(value.lifecycle);
  const trust = validateManifestTrust(value.trust);

  return immutable({
    name: value.name,
    version: value.version,
    contract: value.contract,
    host,
    detection,
    driving,
    ...(lifecycle === undefined ? {} : { lifecycle }),
    trust,
  });
}
