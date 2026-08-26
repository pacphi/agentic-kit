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
const AQE_PROVIDER_TYPE_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const AQE_BUILTIN_OR_RESERVED_TYPES = new Set([
  'anthropic', 'claude-code', 'claude', 'codex', 'openai', 'gemini',
  'openrouter', 'azure-openai', 'bedrock', 'cognitum', 'ollama', 'onnx',
]);
const AQE_BILLING_MODES = Object.freeze(['subscription', 'metered-api', 'metered-capped', 'local']);
const MAX_AQE_PROVIDER_MODELS = 128;
const MAX_AQE_MODEL_BYTES = 256;
const MAX_AQE_DISPLAY_NAME_BYTES = 128;
const MAX_AQE_PROVIDER_CONCURRENCY = 64;
const MAX_AQE_PROVIDER_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const AQE_BRIDGE_ENV = new Set(['PATH', 'HOME', 'XDG_CONFIG_HOME', 'APPDATA', 'AK_EXPERIMENTAL_HOST_ADAPTERS']);
const ENV_CODE_INJECTION = new Set([
  'NODE_OPTIONS', 'BASH_ENV', 'ENV', 'PYTHONPATH', 'PYTHONHOME', 'RUBYOPT',
  'PERL5OPT', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES',
]);

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

function hasUnsafeControl(value) {
  return [...value].some((character) => {
    const code = character.codePointAt(0);
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f)
      || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
  });
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
  'name', 'version', 'contract', 'host', 'detection', 'driving', 'lifecycle', 'trust', 'execution', 'aqe',
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
    assertNoUnknownKeys(entry.hook, ['command', 'timeoutMs', 'files'], `lifecycle.${verb}.hook`);
    try {
      assertStringArray(entry.hook.command, `lifecycle.${verb}.hook.command`, { allowEmpty: false });
    } catch (error) {
      throw new ManifestRejected('invalid-lifecycle-hook', error.message);
    }
    if (entry.hook.timeoutMs !== undefined
      && (!Number.isInteger(entry.hook.timeoutMs) || entry.hook.timeoutMs <= 0)) {
      throw new ManifestRejected('invalid-lifecycle-hook', `lifecycle.${verb}.hook.timeoutMs must be a positive integer`);
    }
    validateHookFiles(entry.hook.files, `lifecycle.${verb}.hook.files`, 'invalid-lifecycle-hook');
  }
  return structuredClone(value);
}

// execution.run.hook is the single subprocess `ak run` spawns to drive an
// admitted host as a worker (P2, ADR-0031). Same hook shape and validation
// discipline as a lifecycle verb's hook, but there is exactly one verb
// ('run'), never a caller-named one, so the allowlists are inlined rather
// than looped like validateManifestLifecycle's verb map.
function validateExecution(value) {
  assertRecord(value, 'execution');
  assertNoUnknownKeys(value, ['run'], 'execution');
  assertRecord(value.run, 'execution.run');
  assertNoUnknownKeys(value.run, ['hook'], 'execution.run');
  assertRecord(value.run.hook, 'execution.run.hook');
  assertNoUnknownKeys(value.run.hook, ['command', 'timeoutMs', 'files'], 'execution.run.hook');
  try {
    assertStringArray(value.run.hook.command, 'execution.run.hook.command', { allowEmpty: false });
  } catch (error) {
    throw new ManifestRejected('invalid-execution', error.message);
  }
  if (value.run.hook.timeoutMs !== undefined
    && (!Number.isInteger(value.run.hook.timeoutMs) || value.run.hook.timeoutMs <= 0)) {
    throw new ManifestRejected('invalid-execution', 'execution.run.hook.timeoutMs must be a positive integer');
  }
  validateHookFiles(value.run.hook.files, 'execution.run.hook.files', 'invalid-execution');
  return structuredClone(value);
}

function validateEnvNames(value, field) {
  if (value === undefined) return undefined;
  try {
    assertStringArray(value, field);
  } catch (error) {
    throw new ManifestRejected('invalid-aqe-provider', error.message);
  }
  const invalid = value.find((name) => !ENV_NAME_RE.test(name));
  if (invalid !== undefined) {
    throw new ManifestRejected('invalid-aqe-provider', `${field} contains invalid environment name '${invalid}'`);
  }
  const canonical = value.map((name) => name.toUpperCase());
  if (new Set(canonical).size !== canonical.length) {
    throw new ManifestRejected(
      'invalid-aqe-provider',
      `${field} contains names that collide on case-insensitive environments`,
    );
  }
  return [...value];
}

/** Validate candidate data; host.id fixes identity and grants activation. */
function validateAqe(value, host, driving, execution) {
  assertRecord(value, 'aqe');
  assertNoUnknownKeys(value, ['provider'], 'aqe');
  assertRecord(value.provider, 'aqe.provider');
  assertNoUnknownKeys(value.provider, [
    'hook', 'billingMode', 'models', 'defaultModel', 'maxConcurrency', 'stripEnv', 'displayName',
  ], 'aqe.provider');

  const type = host.id;
  if (!AQE_PROVIDER_TYPE_RE.test(type)) {
    throw new ManifestRejected(
      'invalid-aqe-provider-type',
      `host.id '${type}' must match ${AQE_PROVIDER_TYPE_RE.source} to be an AQE provider identity`,
    );
  }
  if (AQE_BUILTIN_OR_RESERVED_TYPES.has(type)) {
    throw new ManifestRejected('aqe-provider-collision', `host.id '${type}' is built in or reserved by agentic-qe`);
  }
  if (!driving.surfaces.includes('cli-subprocess')) {
    throw new ManifestRejected('aqe-provider-surface', 'manifest.aqe requires driving.surfaces to include cli-subprocess');
  }
  if (host.capabilities.canRouteActivities !== true || !execution?.run?.hook) {
    throw new ManifestRejected(
      'aqe-provider-routing',
      'manifest.aqe requires host.capabilities.canRouteActivities:true and manifest.execution.run.hook',
    );
  }

  const provider = value.provider;
  assertRecord(provider.hook, 'aqe.provider.hook');
  assertNoUnknownKeys(provider.hook, ['command', 'timeoutMs', 'files', 'passEnv'], 'aqe.provider.hook');
  try {
    assertStringArray(provider.hook.command, 'aqe.provider.hook.command', { allowEmpty: false });
  } catch (error) {
    throw new ManifestRejected('invalid-aqe-provider', error.message);
  }
  if (provider.hook.timeoutMs !== undefined
    && (!Number.isInteger(provider.hook.timeoutMs) || provider.hook.timeoutMs <= 0
      || provider.hook.timeoutMs > MAX_AQE_PROVIDER_TIMEOUT_MS)) {
    throw new ManifestRejected(
      'invalid-aqe-provider',
      `aqe.provider.hook.timeoutMs must be a positive integer <= ${MAX_AQE_PROVIDER_TIMEOUT_MS}`,
    );
  }
  validateHookFiles(provider.hook.files, 'aqe.provider.hook.files', 'invalid-aqe-provider');
  const passEnv = validateEnvNames(provider.hook.passEnv, 'aqe.provider.hook.passEnv');
  const stripEnv = validateEnvNames(provider.stripEnv, 'aqe.provider.stripEnv');
  const unsafePass = passEnv?.find((name) => {
    const canonical = name.toUpperCase();
    return AQE_BRIDGE_ENV.has(canonical)
      || ENV_CODE_INJECTION.has(canonical) || canonical.startsWith('AK_AQE_');
  });
  if (unsafePass) {
    throw new ManifestRejected('invalid-aqe-provider', `aqe.provider.hook.passEnv may not forward bridge/runtime variable '${unsafePass}'`);
  }
  const unsafeStrip = stripEnv?.find((name) => AQE_BRIDGE_ENV.has(name.toUpperCase()));
  if (unsafeStrip) {
    throw new ManifestRejected('invalid-aqe-provider', `aqe.provider.stripEnv may not remove bridge runtime variable '${unsafeStrip}'`);
  }
  const stripped = new Set(stripEnv?.map((name) => name.toUpperCase()));
  const conflict = passEnv?.find((name) => stripped.has(name.toUpperCase()));
  if (conflict) {
    throw new ManifestRejected('invalid-aqe-provider', `environment '${conflict}' cannot appear in both passEnv and stripEnv`);
  }

  if (provider.billingMode !== undefined && !AQE_BILLING_MODES.includes(provider.billingMode)) {
    throw new ManifestRejected(
      'invalid-aqe-provider',
      `aqe.provider.billingMode must be one of ${AQE_BILLING_MODES.join(', ')}`,
    );
  }
  let models = ['default'];
  if (provider.models !== undefined) {
    try {
      assertStringArray(provider.models, 'aqe.provider.models', { allowEmpty: false });
    } catch (error) {
      throw new ManifestRejected('invalid-aqe-provider', error.message);
    }
    if (provider.models.length > MAX_AQE_PROVIDER_MODELS) {
      throw new ManifestRejected(
        'invalid-aqe-provider',
        `aqe.provider.models may contain at most ${MAX_AQE_PROVIDER_MODELS} entries`,
      );
    }
    const oversized = provider.models.find((model) => Buffer.byteLength(model, 'utf8') > MAX_AQE_MODEL_BYTES);
    if (oversized !== undefined) {
      throw new ManifestRejected(
        'invalid-aqe-provider',
        `aqe.provider.models entries may be at most ${MAX_AQE_MODEL_BYTES} UTF-8 bytes`,
      );
    }
    models = [...provider.models];
  }
  const defaultModel = provider.defaultModel ?? models[0];
  if (provider.defaultModel !== undefined) {
    if (typeof provider.defaultModel !== 'string' || !provider.defaultModel) {
      throw new ManifestRejected('invalid-aqe-provider', 'aqe.provider.defaultModel must be a non-empty string');
    }
    if (!models.includes(provider.defaultModel)) {
      throw new ManifestRejected('invalid-aqe-provider', 'aqe.provider.defaultModel must be present in aqe.provider.models');
    }
  }
  if (provider.maxConcurrency !== undefined
    && (!Number.isInteger(provider.maxConcurrency) || provider.maxConcurrency <= 0
      || provider.maxConcurrency > MAX_AQE_PROVIDER_CONCURRENCY)) {
    throw new ManifestRejected(
      'invalid-aqe-provider',
      `aqe.provider.maxConcurrency must be a positive integer <= ${MAX_AQE_PROVIDER_CONCURRENCY}`,
    );
  }
  if (provider.displayName !== undefined
    && (typeof provider.displayName !== 'string' || !provider.displayName.trim()
      || Buffer.byteLength(provider.displayName, 'utf8') > MAX_AQE_DISPLAY_NAME_BYTES
      || hasUnsafeControl(provider.displayName))) {
    throw new ManifestRejected(
      'invalid-aqe-provider',
      `aqe.provider.displayName must be non-empty, control-free, and <= ${MAX_AQE_DISPLAY_NAME_BYTES} UTF-8 bytes`,
    );
  }

  return {
    provider: {
      hook: {
        command: [...provider.hook.command],
        ...(provider.hook.timeoutMs === undefined ? {} : { timeoutMs: provider.hook.timeoutMs }),
        ...(provider.hook.files === undefined ? {} : { files: [...provider.hook.files] }),
        ...(passEnv === undefined ? {} : { passEnv }),
      },
      ...(provider.billingMode === undefined ? {} : { billingMode: provider.billingMode }),
      models,
      defaultModel,
      ...(provider.maxConcurrency === undefined ? {} : { maxConcurrency: provider.maxConcurrency }),
      ...(stripEnv === undefined ? {} : { stripEnv }),
      ...(provider.displayName === undefined ? {} : { displayName: provider.displayName }),
    },
  };
}

/** Hook file inventories are portable paths relative to the manifest's own
 * directory. Content is hashed later, once admission has resolved that
 * directory; schema validation keeps absolute/traversal paths out of the
 * contract before they can reach filesystem code. */
function validateHookFiles(value, field, reason) {
  if (value === undefined) return;
  try {
    assertStringArray(value, field, { allowEmpty: false });
  } catch (error) {
    throw new ManifestRejected(reason, error.message);
  }
  const normalized = value.map((file) => file.replaceAll('\\', '/'));
  const invalid = normalized.find((file) => {
    const parts = file.split('/');
    return file.startsWith('/') || /^[A-Za-z]:\//.test(file) || file.includes('\0')
      || parts.includes('..') || file === '.' || file === './';
  });
  if (invalid !== undefined) {
    throw new ManifestRejected(reason, `${field} entry '${value[normalized.indexOf(invalid)]}' must be a relative path without traversal`);
  }
  const canonical = normalized.map((file) => file.replace(/^\.\//, ''));
  if (new Set(canonical).size !== canonical.length) {
    throw new ManifestRejected(reason, `${field} contains duplicate paths after normalization`);
  }
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
  // P2 structural coupling (ADR-0031): an execution hook on a host that
  // cannot route activities is a contradiction the schema refuses outright,
  // never silently ignores. The converse — routable, no execution block — is
  // legal and degrades honestly at run time (cli_unavailable).
  if (value.execution !== undefined && host.capabilities.canRouteActivities !== true) {
    throw new ManifestRejected('execution-not-routable', 'manifest.execution requires host.capabilities.canRouteActivities: true');
  }

  const detection = validateDetection(value.detection);
  const driving = validateDriving(value.driving);
  const lifecycle = value.lifecycle === undefined ? undefined : validateManifestLifecycle(value.lifecycle);
  const trust = validateManifestTrust(value.trust);
  const execution = value.execution === undefined ? undefined : validateExecution(value.execution);
  const aqe = value.aqe === undefined ? undefined : validateAqe(value.aqe, host, driving, execution);

  return immutable({
    name: value.name,
    version: value.version,
    contract: value.contract,
    host,
    detection,
    driving,
    ...(lifecycle === undefined ? {} : { lifecycle }),
    // execution rides in the same validated-output object hashManifest
    // (admission.mjs) canonicalizes and hashes, so declaring/editing an
    // execution block changes consent's covered hash automatically — no
    // separate hashing path to keep in sync.
    ...(execution === undefined ? {} : { execution }),
    ...(aqe === undefined ? {} : { aqe }),
    trust,
  });
}
