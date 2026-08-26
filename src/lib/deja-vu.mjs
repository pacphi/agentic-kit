// deja-vu v0.19 is an independently evolving CLI. This module is the narrow
// anti-corruption boundary between its machine output/commands and ak's
// lifecycle. Only bounded enums, counts, and validated versions leave it;
// upstream paths, errors, policy text, peer names, and transcript metadata do
// not become integration facts.
import fs from 'node:fs';
import path from 'node:path';

export const DEJA_VU_PACKAGE = '@vshulcz/deja-vu';
export const DEJA_VU_MIN_VERSION = '0.19.0';
export const DEJA_VU_BIN = 'deja';
export const DEJA_VU_DOCTOR_SCHEMA_VERSION = 2;

export const DEJA_VU_TARGETS = Object.freeze({
  claude: Object.freeze({ mcp: 'claude-code', auto: 'claude-auto' }),
  codex: Object.freeze({ mcp: 'codex', auto: 'codex-auto' }),
  opencode: Object.freeze({ mcp: 'opencode', auto: 'opencode-auto' }),
});

const REQUIRED_TARGETS = Object.freeze(Object.values(DEJA_VU_TARGETS)
  .flatMap(({ mcp, auto }) => [mcp, auto]));
/** @type {ReadonlySet<string>} */
const REQUIRED_TARGET_SET = new Set(REQUIRED_TARGETS);
const STORE_STATES = Object.freeze([
  'ok', 'missing', 'unreadable', 'parsed-zero', 'denied',
  'needs-sqlite3', 'needs-zstd', 'unplugged',
]);
const INDEX_STATES = Object.freeze(['missing', 'ok', 'stale', 'stale-readonly']);
const MCP_STATES = Object.freeze(['config-missing', 'not-wired', 'wired']);
const SQLITE_STATES = Object.freeze(['missing', 'ok']);
const VERSION_STATES = Object.freeze([
  'ok', 'update-available', 'ahead', 'dev', 'offline', 'unknown',
]);
const POLICY_STATES = Object.freeze(['default', 'active', 'unreadable']);
const SYNC_STATES = Object.freeze(['ok', 'unreadable']);
const VERSION_VALUE = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const MAX_JSON_BYTES = 1024 * 1024;

/**
 * @typedef {object} RawDoctorEnvelope
 * @property {number} schema_version
 * @property {Array<{name:string,state:string,files:number,indexed_sessions:number,partial?:boolean,unchecked?:boolean}>} stores
 * @property {{state:string,stale_stores:number}} index
 * @property {Array<{name:string,state:string}>} mcp
 * @property {{state:string}} sqlite3
 * @property {{state:string,current:string}} version
 * @property {{state:string,indexed_sessions:number,activations:Record<string,{withheld:number}>}} policy
 * @property {{state:string,peers:Array<{host:string,sessions_from_there:number,last_error?:string,stamped_ahead?:boolean}>}} sync
 */

/** @returns {string[]} Kit's explicit target allowlist, never upstream's full list. */
export function requiredDejaVuTargets() {
  return [...REQUIRED_TARGETS];
}

/** @param {unknown} value @returns {value is Record<string, any>} */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function degraded(reason, facts = null) {
  return deepFreeze({ state: 'degraded', reason, facts });
}

function normalizeState(value, allowed, unsupported) {
  if (allowed.includes(value)) return value;
  unsupported.found = true;
  return 'unknown';
}

/** @param {Record<string, any>} raw @returns {raw is RawDoctorEnvelope} */
function validDoctorShape(raw) {
  if (!Array.isArray(raw.stores)
    || !isRecord(raw.index)
    || !Array.isArray(raw.mcp)
    || !isRecord(raw.sqlite3)
    || !isRecord(raw.version)
    || !isRecord(raw.policy)
    || !isRecord(raw.policy.activations)
    || !isRecord(raw.sync)
    || !Array.isArray(raw.sync.peers)) return false;
  if (typeof raw.index.state !== 'string' || !nonNegativeInteger(raw.index.stale_stores)
    || typeof raw.sqlite3.state !== 'string'
    || typeof raw.version.state !== 'string' || typeof raw.version.current !== 'string'
    || !VERSION_VALUE.test(raw.version.current)
    || typeof raw.policy.state !== 'string' || !nonNegativeInteger(raw.policy.indexed_sessions)
    || typeof raw.sync.state !== 'string') return false;
  for (const activation of ['search', 'mcp', 'auto']) {
    const value = raw.policy.activations[activation];
    if (!isRecord(value) || !nonNegativeInteger(value.withheld)) return false;
  }
  for (const store of raw.stores) {
    if (!isRecord(store) || typeof store.name !== 'string' || typeof store.state !== 'string'
      || !nonNegativeInteger(store.files) || !nonNegativeInteger(store.indexed_sessions)
      || (store.partial !== undefined && typeof store.partial !== 'boolean')
      || (store.unchecked !== undefined && typeof store.unchecked !== 'boolean')) return false;
  }
  for (const entry of raw.mcp) {
    if (!isRecord(entry) || typeof entry.name !== 'string' || typeof entry.state !== 'string') {
      return false;
    }
  }
  for (const peer of raw.sync.peers) {
    if (!isRecord(peer) || typeof peer.host !== 'string'
      || !nonNegativeInteger(peer.sessions_from_there)
      || (peer.last_error !== undefined && typeof peer.last_error !== 'string')
      || (peer.stamped_ahead !== undefined && typeof peer.stamped_ahead !== 'boolean')) return false;
  }
  return true;
}

/**
 * Parse `deja doctor --json --offline`. The return value is non-throwing and
 * contains no upstream path, error, peer, policy-rule, or transcript string.
 * Unknown enum values are converted to the controlled value `unknown` and
 * mark the compatible envelope degraded instead of echoing the new value.
 * @param {unknown} input
 */
export function parseDejaVuDoctor(input) {
  let raw = input;
  if (typeof input === 'string') {
    if (Buffer.byteLength(input, 'utf8') > MAX_JSON_BYTES) return degraded('json-too-large');
    try { raw = JSON.parse(input); } catch { return degraded('json-malformed'); }
  }
  if (!isRecord(raw)) return degraded('envelope-invalid');
  if (!Object.hasOwn(raw, 'schema_version')) return degraded('schema-missing');
  if (raw.schema_version !== DEJA_VU_DOCTOR_SCHEMA_VERSION) {
    return degraded('schema-unsupported');
  }
  if (!validDoctorShape(raw)) return degraded('shape-invalid');

  const unsupported = { found: false };
  const storeStates = Object.fromEntries([...STORE_STATES, 'unknown'].map((state) => [state, 0]));
  let partial = 0;
  let unchecked = 0;
  for (const store of raw.stores) {
    const state = normalizeState(store.state, STORE_STATES, unsupported);
    storeStates[state]++;
    if (store.partial === true) partial++;
    if (store.unchecked === true) unchecked++;
  }

  const targets = Object.fromEntries(REQUIRED_TARGETS.map((target) => [target, 'unknown']));
  let unknownTargets = 0;
  for (const entry of raw.mcp) {
    const state = normalizeState(entry.state, MCP_STATES, unsupported);
    if (Object.hasOwn(targets, entry.name)) targets[entry.name] = state;
    else unknownTargets++;
  }

  const facts = {
    schemaVersion: DEJA_VU_DOCTOR_SCHEMA_VERSION,
    stores: { total: raw.stores.length, states: storeStates, partial, unchecked },
    index: {
      state: normalizeState(raw.index.state, INDEX_STATES, unsupported),
      staleStores: raw.index.stale_stores,
    },
    mcp: { targets, unknownTargets },
    sqlite3: { state: normalizeState(raw.sqlite3.state, SQLITE_STATES, unsupported) },
    version: {
      state: normalizeState(raw.version.state, VERSION_STATES, unsupported),
      current: raw.version.current,
    },
    policy: {
      state: normalizeState(raw.policy.state, POLICY_STATES, unsupported),
      indexedSessions: raw.policy.indexed_sessions,
      withheld: Object.fromEntries(['search', 'mcp', 'auto']
        .map((name) => [name, raw.policy.activations[name].withheld])),
    },
    sync: {
      state: normalizeState(raw.sync.state, SYNC_STATES, unsupported),
      peerCount: raw.sync.peers.length,
      peersWithErrors: raw.sync.peers.filter((peer) => peer.last_error !== undefined).length,
      peersAhead: raw.sync.peers.filter((peer) => peer.stamped_ahead === true).length,
    },
  };
  return unsupported.found
    ? degraded('value-unsupported', facts)
    : deepFreeze({ state: 'ok', reason: null, facts });
}

/**
 * Extract only the Kit-required names from the dedicated `targets:` help
 * block. Mentions in examples or prose do not count as capabilities.
 * @param {unknown} output
 */
export function parseDejaVuInstallHelp(output) {
  const found = new Set();
  if (typeof output === 'string') {
    const lines = output.split(/\r?\n/);
    const start = lines.findIndex((line) => /^\s*targets:\s*$/i.test(line));
    for (let i = start + 1; start >= 0 && i < lines.length; i++) {
      const line = lines[i];
      if (!/^\s+/.test(line)) break;
      const value = line.trim();
      if (!value) break;
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*(?:,\s*[a-z0-9]+(?:-[a-z0-9]+)*)*,?$/.test(value)) break;
      for (const target of value.split(',').map((part) => part.trim()).filter(Boolean)) {
        if (REQUIRED_TARGET_SET.has(target)) found.add(target);
      }
    }
  }
  const requiredTargets = [...REQUIRED_TARGETS];
  const missingTargets = requiredTargets.filter((target) => !found.has(target));
  return deepFreeze({ supported: missingTargets.length === 0, requiredTargets, missingTargets });
}

function dejaVuTarget(host, mode) {
  const target = DEJA_VU_TARGETS[host]?.[mode];
  if (!target) throw new TypeError('unsupported deja-vu host or mode');
  return target;
}

/** @param {string} host @param {string} mode */
export function buildDejaVuInstallCommand(host, mode) {
  return deepFreeze({
    command: DEJA_VU_BIN,
    args: ['install', dejaVuTarget(host, mode), '--no-guidance', '--no-index'],
  });
}

/** @param {string} host @param {string} mode */
export function buildDejaVuUninstallCommand(host, mode) {
  return deepFreeze({ command: DEJA_VU_BIN, args: ['uninstall', dejaVuTarget(host, mode)] });
}

function within(candidate, root, pathImpl) {
  const rel = pathImpl.relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${pathImpl.sep}`) && !pathImpl.isAbsolute(rel));
}

function overlaps(left, right, pathImpl) {
  return within(left, right, pathImpl) || within(right, left, pathImpl);
}

function canonicalPath(candidate, pathImpl, realpathFn) {
  let cursor = pathImpl.resolve(candidate);
  const tail = [];
  for (;;) {
    try {
      return pathImpl.join(realpathFn(cursor), ...tail);
    } catch {
      const parent = pathImpl.dirname(cursor);
      if (parent === cursor) return pathImpl.resolve(candidate);
      tail.unshift(pathImpl.basename(cursor));
      cursor = parent;
    }
  }
}

/**
 * Validate the derived index location before a destructive operation. The
 * default allow-root deliberately follows deja-vu, not XDG_CACHE_HOME.
 * Rejections return controlled reason codes and never echo the candidate.
 * @param {unknown} candidate
 * @param {{homeDir?:string,allowedRoots?:string[],sourceRoots?:string[],configRoots?:string[],pathImpl?:typeof path,realpathFn?:(value:string)=>string}} options
 */
export function validateDejaVuIndexPath(candidate, options = {}) {
  const pathImpl = options.pathImpl ?? path;
  const realpathFn = options.realpathFn ?? fs.realpathSync.native;
  const reject = (reason) => deepFreeze({ ok: false, reason });
  if (typeof candidate !== 'string' || candidate.includes('\0')) return reject('path-invalid');
  if (typeof options.homeDir !== 'string' || !pathImpl.isAbsolute(options.homeDir)
    || !pathImpl.isAbsolute(candidate)) return reject('path-not-absolute');
  const home = canonicalPath(options.homeDir, pathImpl, realpathFn);
  const indexPath = canonicalPath(candidate, pathImpl, realpathFn);
  if (pathImpl.basename(indexPath) !== 'index.db') return reject('path-not-index');

  const requestedRoots = options.allowedRoots ?? [pathImpl.join(options.homeDir, '.cache', 'deja')];
  if (!Array.isArray(requestedRoots) || requestedRoots.length === 0
    || requestedRoots.some((root) => typeof root !== 'string' || !pathImpl.isAbsolute(root))) {
    return reject('allow-root-invalid');
  }
  const allowedRoots = requestedRoots.map((root) => canonicalPath(root, pathImpl, realpathFn));
  const volumeRoot = pathImpl.parse(indexPath).root;
  if (allowedRoots.some((root) => root === volumeRoot || root === home || within(home, root, pathImpl))) {
    return reject('allow-root-too-broad');
  }
  if (!allowedRoots.some((root) => within(indexPath, root, pathImpl) && indexPath !== root)) {
    return reject('path-outside-allow-root');
  }

  const defaultForbidden = [
    pathImpl.join(options.homeDir, '.config', 'deja'),
    pathImpl.join(options.homeDir, '.claude'),
    pathImpl.join(options.homeDir, '.codex'),
    pathImpl.join(options.homeDir, '.config', 'opencode'),
  ];
  const extraForbidden = [...(options.sourceRoots ?? []), ...(options.configRoots ?? [])];
  const forbidden = [...defaultForbidden, ...extraForbidden]
    .filter((root) => typeof root === 'string' && pathImpl.isAbsolute(root))
    .map((root) => canonicalPath(root, pathImpl, realpathFn));
  if (forbidden.some((root) => overlaps(indexPath, root, pathImpl))) {
    return reject('path-overlaps-protected-root');
  }
  return deepFreeze({ ok: true, path: indexPath });
}
