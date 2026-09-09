import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';

import {
  CURATED_VIEWS, DISPOSITION_KINDS, FACETS, GUIDANCE_LANES, RECONCILE_OUTCOMES, SCOPE_LENSES, SHELLS,
  SORT_ORDERS, isOpaqueId,
} from '../maintenance/management/model.mjs';
import { requestRejection } from './request-security.mjs';

/** v1 compatibility routes (documented in docs/MAINTENANCE.md). */
export const MAINTENANCE_MUTATION_ROUTES = Object.freeze(new Set([
  '/api/maintenance/plans',
  '/api/maintenance/apply',
  '/api/maintenance/undo',
]));

const V2 = '/api/maintenance/v2';
const PLACEMENT_ID = 'plc_[A-Za-z0-9_-]{16,64}';
const GUIDANCE_ID = 'gid_[A-Za-z0-9_-]{16,64}';
const RECEIPT_ID = 'mnt-[A-Za-z0-9._-]{1,120}';

/** Every ADR-0048 v2 route, each with an exact pattern. Path parameters must
 *  satisfy the opaque-id grammar (`plc_`/`gid_`) or the receipt-id grammar. */
export const MAINTENANCE_V2_ROUTES = Object.freeze([
  { name: 'inventory', method: 'GET', pattern: new RegExp(`^${V2}/inventory$`) },
  { name: 'placement', method: 'GET', pattern: new RegExp(`^${V2}/placements/(${PLACEMENT_ID})$`), params: ['placementId'] },
  { name: 'reveal', method: 'POST', pattern: new RegExp(`^${V2}/placements/reveal$`) },
  { name: 'guidance', method: 'GET', pattern: new RegExp(`^${V2}/guidance$`) },
  { name: 'procedure', method: 'GET', pattern: new RegExp(`^${V2}/procedures/(${GUIDANCE_ID})$`), params: ['guidanceId'] },
  { name: 'checklist', method: 'POST', pattern: new RegExp(`^${V2}/procedures/checklist$`) },
  { name: 'discovery', method: 'GET', pattern: new RegExp(`^${V2}/discovery$`) },
  { name: 'discoveryPreview', method: 'POST', pattern: new RegExp(`^${V2}/discovery/preview$`) },
  { name: 'discoverySources', method: 'POST', pattern: new RegExp(`^${V2}/discovery/sources$`) },
  { name: 'discoverySourcesRemove', method: 'POST', pattern: new RegExp(`^${V2}/discovery/sources/remove$`) },
  { name: 'discoveryAutomatic', method: 'POST', pattern: new RegExp(`^${V2}/discovery/automatic$`) },
  { name: 'discoveryExclusions', method: 'POST', pattern: new RegExp(`^${V2}/discovery/exclusions$`) },
  { name: 'discoveryExclusionsRemove', method: 'POST', pattern: new RegExp(`^${V2}/discovery/exclusions/remove$`) },
  { name: 'scans', method: 'GET', pattern: new RegExp(`^${V2}/scans$`) },
  { name: 'scanControl', method: 'POST', pattern: new RegExp(`^${V2}/scans$`) },
  { name: 'activity', method: 'GET', pattern: new RegExp(`^${V2}/activity$`) },
  { name: 'receipt', method: 'GET', pattern: new RegExp(`^${V2}/receipts/(${RECEIPT_ID})$`), params: ['receiptId'] },
  { name: 'receiptExport', method: 'POST', pattern: new RegExp(`^${V2}/receipts/export$`) },
  { name: 'dispositions', method: 'POST', pattern: new RegExp(`^${V2}/dispositions$`) },
  { name: 'audit', method: 'POST', pattern: new RegExp(`^${V2}/audit$`) },
  { name: 'reconcilePreview', method: 'POST', pattern: new RegExp(`^${V2}/reconcile/preview$`) },
  { name: 'reconcile', method: 'POST', pattern: new RegExp(`^${V2}/reconcile$`) },
  { name: 'plans', method: 'POST', pattern: new RegExp(`^${V2}/plans$`) },
  { name: 'apply', method: 'POST', pattern: new RegExp(`^${V2}/apply$`) },
  { name: 'undo', method: 'POST', pattern: new RegExp(`^${V2}/undo$`) },
  { name: 'recipesRefresh', method: 'POST', pattern: new RegExp(`^${V2}/recipes/refresh$`) },
  { name: 'recipesAccept', method: 'POST', pattern: new RegExp(`^${V2}/recipes/accept$`) },
  { name: 'recipesWithdraw', method: 'POST', pattern: new RegExp(`^${V2}/recipes/withdraw$`) },
  { name: 'preferences', method: 'GET', pattern: new RegExp(`^${V2}/preferences$`) },
  { name: 'savePreferences', method: 'POST', pattern: new RegExp(`^${V2}/preferences$`) },
].map((route) => Object.freeze({ params: [], ...route })));

/** Exact v2 POST paths. Every v2 mutation route is parameter-free by design so
 *  the server's allowlist stays an O(1) exact-string check. */
export const MAINTENANCE_V2_MUTATION_ROUTES = Object.freeze(new Set(
  MAINTENANCE_V2_ROUTES.filter((route) => route.method === 'POST').map((route) => route.pattern.source
    .replace(/^\^/, '').replace(/\$$/, '').replace(/\\\//g, '/')),
));

export function isMaintenanceMutationRoute(url) {
  return MAINTENANCE_MUTATION_ROUTES.has(url) || MAINTENANCE_V2_MUTATION_ROUTES.has(url);
}

/** Match one v2 route by method and exact path. Returns `{ name, params }` or null. */
export function matchMaintenanceV2Route(method, pathname) {
  for (const route of MAINTENANCE_V2_ROUTES) {
    if (route.method !== method) continue;
    const match = route.pattern.exec(pathname);
    if (!match) continue;
    const params = Object.fromEntries(route.params.map((name, index) => [name, match[index + 1]]));
    return { name: route.name, params };
  }
  return null;
}

export const MAX_MAINTENANCE_BODY_BYTES = 64 * 1024;
const PUBLIC_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const CAPABILITY = /^[A-Za-z0-9_-]{43}$/;
const TOKEN = /^[A-Za-z0-9._:-]{1,64}$/;
const AUTOMATIC_SOURCE_ID = /^[a-z][a-z0-9-]{1,63}$/;
const RECEIPT = new RegExp(`^${RECEIPT_ID}$`);
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const MAX_UNTIL_DAYS = 365;
const MAX_QUERY_FACET_VALUES = 32;

/** Evidence labels often prefix an absolute path with a useful surface and
 *  category. Both the v1 evidence projection and every v2 projection fail
 *  closed at the first local path; URLs are not local paths. */
export const MAINTENANCE_LOCAL_PATH = /(^|[\s"'([{=:])(?:file:\/\/\/?|~[\\/]|[A-Za-z]:[\\/]|\\\\|\/(?!\/))/u;

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value, allowed) {
  return plainObject(value) && Object.keys(value).every((key) => allowed.includes(key));
}

function validId(value) {
  return typeof value === 'string' && PUBLIC_ID.test(value);
}

function hasControlCharacter(value) {
  return Array.from(value).some((character) => {
    const point = character.codePointAt(0);
    return point <= 31 || point === 127;
  });
}

function requireConfirmation(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 160 && !hasControlCharacter(value);
}

function invalid(message) {
  return Object.assign(new TypeError(message), { statusCode: 400 });
}

// ── v1 bodies (unchanged compatibility contract) ───────────────────────────

function planBody(value) {
  if (!exactKeys(value, ['findingIds']) || !Array.isArray(value.findingIds)
      || value.findingIds.length < 1 || value.findingIds.length > 100
      || new Set(value.findingIds).size !== value.findingIds.length
      || value.findingIds.some((id) => !validId(id))) {
    throw new TypeError('invalid maintenance plan request');
  }
  return { findingIds: [...value.findingIds] };
}

function confirmedBody(value, label, { phraseRequired = false } = {}) {
  if (!exactKeys(value, ['capability', 'confirm', 'typedPhrase'])
      || !CAPABILITY.test(value?.capability ?? '') || value.confirm !== true
      || (value.typedPhrase != null && !requireConfirmation(value.typedPhrase))
      || (phraseRequired && value.typedPhrase == null)) {
    throw new TypeError(`invalid maintenance ${label} request`);
  }
  return {
    capability: value.capability,
    confirm: true,
    ...(value.typedPhrase == null ? {} : { typedPhrase: value.typedPhrase }),
  };
}

function undoBody(value) {
  if (value?.preview !== true) return confirmedBody(value, 'undo');
  if (!exactKeys(value, ['receiptId', 'preview']) || !validId(value.receiptId)) {
    throw new TypeError('invalid maintenance undo preview request');
  }
  return { receiptId: value.receiptId, preview: true };
}

/** Mutation requests are stricter than read-only dashboard requests. Browsers
 * must prove the exact same origin; CLI clients can supply these headers
 * explicitly rather than receiving a weaker ambient-authority path. */
export function maintenanceMutationRejection(headers = {}) {
  const common = requestRejection(headers);
  if (common) return common;
  const host = String(headers.host || '').toLowerCase();
  if (String(headers['sec-fetch-site'] || '').toLowerCase() !== 'same-origin') {
    return 'forbidden (maintenance mutation requires same-origin fetch metadata)';
  }
  let origin;
  try { origin = new URL(String(headers.origin || '')); } catch {
    return 'forbidden (maintenance mutation requires an exact Origin)';
  }
  if (origin.protocol !== 'http:' || origin.host.toLowerCase() !== host || origin.pathname !== '/') {
    return 'forbidden (foreign Origin)';
  }
  return null;
}

export function validateMaintenanceBody(route, value) {
  if (route === '/api/maintenance/plans') return planBody(value);
  if (route === '/api/maintenance/apply') return confirmedBody(value, 'apply');
  if (route === '/api/maintenance/undo') return undoBody(value);
  throw new TypeError('unsupported maintenance mutation route');
}

// ── v2 field checkers ──────────────────────────────────────────────────────
// Each checker returns the normalized value or throws a 400 TypeError. The
// browser may only ever send opaque identifiers, closed enum values, booleans,
// bounded tokens, and (on the two Discovery routes only) a user-typed root.

const check = {
  opaque: (prefix) => (value, field) => {
    if (!isOpaqueId(value, prefix)) throw invalid(`${field} must be an opaque ${prefix} id`);
    return value;
  },
  receiptId: () => (value, field) => {
    if (typeof value !== 'string' || !RECEIPT.test(value)) throw invalid(`${field} must be a receipt id`);
    return value;
  },
  literalTrue: () => (value, field) => {
    if (value !== true) throw invalid(`${field} must be true`);
    return true;
  },
  bool: () => (value, field) => {
    if (typeof value !== 'boolean') throw invalid(`${field} must be a boolean`);
    return value;
  },
  oneOf: (values) => (value, field) => {
    if (!values.includes(value)) throw invalid(`${field} must be one of ${values.join(', ')}`);
    return value;
  },
  token: (max = 64) => (value, field) => {
    if (typeof value !== 'string' || value.length > max || !TOKEN.test(value)) throw invalid(`${field} must be a bounded token`);
    return value;
  },
  publicId: () => (value, field) => {
    if (!validId(value) || value.length > 120) throw invalid(`${field} must be a public id`);
    return value;
  },
  phrase: () => (value, field) => {
    if (!requireConfirmation(value)) throw invalid(`${field} must be a short confirmation phrase`);
    return value;
  },
  absolutePath: () => (value, field) => {
    if (typeof value !== 'string' || value.length === 0 || value.length > 1024 || hasControlCharacter(value)
        || !(path.posix.isAbsolute(value) || path.win32.isAbsolute(value))
        || value.split(/[\\/]/u).some((segment) => segment === '..')) {
      throw invalid(`${field} must be an absolute, traversal-free path`);
    }
    return value;
  },
  sourceRef: () => (value, field) => {
    if (typeof value !== 'string' || !(isOpaqueId(value, 'src') || AUTOMATIC_SOURCE_ID.test(value))) {
      throw invalid(`${field} must name a discovery source`);
    }
    return value;
  },
  automaticId: () => (value, field) => {
    if (typeof value !== 'string' || !AUTOMATIC_SOURCE_ID.test(value)) throw invalid(`${field} must name an automatic source`);
    return value;
  },
  isoAhead: (days) => (value, field, { now }) => {
    const at = typeof value === 'string' && ISO_TIMESTAMP.test(value) ? Date.parse(value) : Number.NaN;
    const current = now();
    if (!Number.isFinite(at) || at <= current || at > current + days * 86_400_000) {
      throw invalid(`${field} must be an ISO timestamp within ${days} days`);
    }
    return value;
  },
  receiptIds: (max) => (value, field) => {
    if (!Array.isArray(value) || value.length < 1 || value.length > max || new Set(value).size !== value.length
        || value.some((id) => typeof id !== 'string' || !RECEIPT.test(id))) {
      throw invalid(`${field} must list 1..${max} unique receipt ids`);
    }
    return [...value];
  },
};

function required(checker) { return { required: true, checker }; }
function optional(checker) { return { required: false, checker }; }

/** Build an exact-shape validator: no surplus keys, required keys present,
 *  every value normalized by its checker, then an optional cross-field rule. */
function shape(label, fields, after = null) {
  const allowed = Object.keys(fields);
  return (value, ctx) => {
    if (!exactKeys(value, allowed)) throw invalid(`invalid maintenance ${label} request`);
    const out = {};
    for (const [field, spec] of Object.entries(fields)) {
      if (!(field in value)) {
        if (spec.required) throw invalid(`invalid maintenance ${label} request: ${field} is required`);
        continue;
      }
      out[field] = spec.checker(value[field], field, ctx);
    }
    if (after) after(out, label);
    return out;
  };
}

function facetSelection(value, field) {
  if (!plainObject(value)) throw invalid(`${field} must be an object`);
  const out = {};
  for (const [facet, values] of Object.entries(value)) {
    if (!FACETS.includes(facet) || !Array.isArray(values) || values.length > MAX_QUERY_FACET_VALUES
        || new Set(values).size !== values.length) {
      throw invalid(`${field}.${facet} is not a valid facet selection`);
    }
    out[facet] = values.map((entry) => check.token(64)(entry, `${field}.${facet}`));
  }
  return out;
}

function searchText(value, field) {
  if (typeof value !== 'string' || value.length > 200 || hasControlCharacter(value) || MAINTENANCE_LOCAL_PATH.test(value)) {
    throw invalid(`${field} must be a short, path-free search`);
  }
  return value;
}

const lastViewBody = shape('preferences.lastView', {
  scope: optional(check.oneOf(SCOPE_LENSES)),
  view: optional(check.oneOf(CURATED_VIEWS)),
  sort: optional(check.oneOf(SORT_ORDERS)),
  facets: optional(facetSelection),
  search: optional(searchText),
});

function shellMap(value, field) {
  if (!plainObject(value) || Object.keys(value).length > 64) throw invalid(`${field} must map environments to shells`);
  const out = {};
  for (const [environmentId, shell] of Object.entries(value)) {
    check.opaque('env')(environmentId, `${field} key`);
    out[environmentId] = check.oneOf(SHELLS)(shell, `${field}.${environmentId}`);
  }
  return out;
}

function retentionInteger(value, field) {
  if (value !== null && (!Number.isInteger(value) || value < 1 || value > 100_000)) {
    throw invalid(`${field} must be a positive integer or null`);
  }
  return value;
}

const retentionBody = shape('preferences.retention', {
  maxSummaries: optional(retentionInteger),
  maxAgeDays: optional(retentionInteger),
});

const V2_BODIES = Object.freeze({
  reveal: shape('reveal', { placementId: required(check.opaque('plc')) }),
  checklist: shape('checklist', {
    guidanceId: required(check.opaque('gid')), stepId: required(check.token(64)), done: required(check.bool()),
  }),
  discoveryPreview: shape('discovery preview', {
    kind: required(check.oneOf(['exact-project', 'collection-root'])), root: required(check.absolutePath()),
  }),
  discoverySources: shape('discovery source', {
    previewId: required(check.opaque('prv')), confirm: required(check.literalTrue()),
  }),
  discoverySourcesRemove: shape('discovery source removal', {
    sourceId: required(check.sourceRef()), confirm: required(check.bool()),
  }),
  discoveryAutomatic: shape('automatic source', {
    sourceId: required(check.automaticId()), enabled: required(check.bool()),
  }),
  discoveryExclusions: shape('discovery exclusion', {
    path: required(check.absolutePath()), recursive: required(check.bool()),
  }),
  discoveryExclusionsRemove: shape('discovery exclusion removal', { exclusionId: required(check.opaque('exc')) }),
  scanControl: shape('scan control', {
    action: required(check.oneOf(['start', 'pause', 'resume', 'stop'])),
    sourceId: optional(check.sourceRef()), confirm: optional(check.bool()),
  }, (body, label) => {
    if (body.action !== 'start' && !body.sourceId) throw invalid(`invalid maintenance ${label} request: sourceId is required`);
    if (body.action !== 'stop' && 'confirm' in body) throw invalid(`invalid maintenance ${label} request: confirm applies to stop only`);
  }),
  receiptExport: shape('receipt export', {
    receiptId: required(check.receiptId()), includeLocalPaths: required(check.bool()),
    acknowledgedWarning: optional(check.bool()),
  }, (body, label) => {
    if (body.includeLocalPaths === true && body.acknowledgedWarning !== true) {
      throw invalid(`invalid maintenance ${label} request: including local paths requires an acknowledged warning`);
    }
    body.acknowledgedWarning = body.acknowledgedWarning === true;
  }),
  dispositions: shape('disposition', {
    guidanceId: required(check.opaque('gid')), kind: required(check.oneOf(DISPOSITION_KINDS)),
    until: optional(check.isoAhead(MAX_UNTIL_DAYS)), confirm: required(check.literalTrue()),
  }, (body, label) => {
    if ((body.kind === 'snoozed') !== ('until' in body)) {
      throw invalid(`invalid maintenance ${label} request: until accompanies snoozed dispositions only`);
    }
  }),
  audit: shape('interruption audit', { receiptIds: required(check.receiptIds(20)) }),
  reconcilePreview: shape('reconcile preview', {
    receiptId: required(check.receiptId()), outcome: required(check.oneOf(RECONCILE_OUTCOMES)),
  }),
  reconcile: (value) => confirmedBody(value, 'reconcile', { phraseRequired: true }),
  plans: shape('plan', { placementId: required(check.opaque('plc')), guidanceId: required(check.opaque('gid')) }),
  apply: (value) => confirmedBody(value, 'apply'),
  undo: undoBody,
  recipesRefresh: shape('recipe refresh', { confirm: required(check.literalTrue()) }),
  recipesAccept: shape('recipe acceptance', {
    recipeId: required(check.publicId()), recipeVersion: required(check.token(40)), confirm: required(check.literalTrue()),
  }),
  recipesWithdraw: shape('recipe withdrawal', {
    recipeId: required(check.publicId()), recipeVersion: optional(check.token(40)), confirm: required(check.literalTrue()),
  }),
  savePreferences: shape('preferences', {
    lastView: optional(lastViewBody), preferredShellByEnvironment: optional(shellMap), retention: optional(retentionBody),
  }, (body, label) => {
    if (!Object.keys(body).length) throw invalid(`invalid maintenance ${label} request: nothing to save`);
  }),
});

/** Validate one v2 mutation body by route name (see `matchMaintenanceV2Route`).
 *  `now` bounds time-typed fields such as a snooze expiry.
 * @param {string} name
 * @param {any} value
 * @param {{ now?: () => number }} [options] */
export function validateMaintenanceV2Body(name, value, { now = Date.now } = {}) {
  const validator = V2_BODIES[name];
  if (!validator) throw new TypeError('unsupported maintenance mutation route');
  return validator(value, { now });
}

// ── v2 query grammar ───────────────────────────────────────────────────────

const V2_QUERIES = Object.freeze({
  inventory: {
    facets: true,
    presentation: check.oneOf(['flat', 'focus']),
    includeWorktrees: (value, field) => {
      if (!['true', 'false'].includes(value)) throw invalid(`${field} must be true or false`);
      return value === 'true';
    },
    scope: check.oneOf(SCOPE_LENSES), view: check.oneOf(CURATED_VIEWS), sort: check.oneOf(SORT_ORDERS),
    search: searchText,
    cursor: (value, field) => {
      if (typeof value !== 'string' || value.length > 512 || !/^[A-Za-z0-9_=-]+$/.test(value)) throw invalid(`${field} must be an opaque cursor`);
      return value;
    },
    limit: (value, field) => {
      if (!/^\d{1,3}$/.test(value) || Number(value) < 1 || Number(value) > 200) throw invalid(`${field} must be 1..200`);
      return Number(value);
    },
  },
  guidance: { lane: check.oneOf(GUIDANCE_LANES) },
  procedure: { shell: check.oneOf(SHELLS) },
});

function facetParam(key, values, grammar, facets) {
  const facet = key.slice('facet.'.length);
  if (!grammar.facets || !FACETS.includes(facet)) throw invalid(`unsupported query parameter ${key}`);
  if (values.length > MAX_QUERY_FACET_VALUES || new Set(values).size !== values.length) {
    throw invalid(`${key} carries too many or duplicate values`);
  }
  facets[facet] = values.map((value) => check.token(64)(value, key));
}

/** Validate a v2 GET query by route name. Unknown and duplicate parameters
 *  are rejected; `facet.<name>` may repeat with distinct bounded tokens. Any
 *  value shaped like a local path is refused (MNT-PRV-004).
 * @param {string} name
 * @param {URLSearchParams} searchParams */
export function validateMaintenanceV2Query(name, searchParams) {
  const grammar = V2_QUERIES[name] ?? {};
  const out = {};
  const facets = {};
  for (const key of new Set(searchParams.keys())) {
    const values = searchParams.getAll(key);
    if (values.some((value) => MAINTENANCE_LOCAL_PATH.test(value))) throw invalid(`${key} must not carry a local path`);
    if (key.startsWith('facet.')) {
      facetParam(key, values, grammar, facets);
      continue;
    }
    const checker = key === 'facets' ? null : grammar[key];
    if (typeof checker !== 'function') throw invalid(`unsupported query parameter ${key}`);
    if (values.length !== 1) throw invalid(`duplicate query parameter ${key}`);
    out[key] = checker(values[0], key);
  }
  if (grammar.facets) out.facets = facets;
  return out;
}

/** Read a bounded JSON request without ever passing partial or surplus input
 * downstream. The stream is drained after rejection so the loopback server
 * can still send its small, generic error response. */
export function readMaintenanceJson(req, { maxBytes = MAX_MAINTENANCE_BODY_BYTES } = {}) {
  const type = String(req.headers?.['content-type'] || '').toLowerCase();
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/.test(type)) {
    req.resume?.();
    return Promise.reject(Object.assign(new TypeError('content type must be application/json'), { statusCode: 415 }));
  }
  const declared = String(req.headers?.['content-length'] || '');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
    req.resume?.();
    return Promise.reject(Object.assign(new TypeError('maintenance request body is too large'), { statusCode: 413 }));
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.resume?.();
      reject(error);
    };
    const onData = (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        fail(Object.assign(new TypeError('maintenance request body is too large'), { statusCode: 413 }));
      } else chunks.push(chunk);
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!plainObject(parsed)) throw new TypeError('maintenance request body must be an object');
        resolve(parsed);
      } catch (error) {
        reject(Object.assign(new TypeError('invalid maintenance JSON request'), {
          statusCode: 400, cause: error,
        }));
      }
    };
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', fail);
  });
}

const CAPABILITY_VERBS = Object.freeze(['apply', 'undo', 'reconcile']);

/** In-memory, one-use mutation authorities. Only the digest is retained as a
 * lookup key; capability material never enters a URL, DOM node or receipt. */
export function createMaintenanceCapabilityStore({
  now = Date.now,
  random = () => randomBytes(32).toString('base64url'),
  ttlMs = 5 * 60_000,
} = {}) {
  const entries = new Map();
  const prune = () => {
    const time = now();
    for (const [key, entry] of entries) if (entry.expiresAt <= time) entries.delete(key);
  };
  const mint = ({ sessionToken, verb, authority, expiresAt = now() + ttlMs }) => {
    if (!sessionToken || !CAPABILITY_VERBS.includes(verb) || !plainObject(authority)) {
      throw new TypeError('invalid maintenance capability authority');
    }
    prune();
    const current = now();
    const deadline = Math.min(Number(expiresAt), current + ttlMs);
    if (!Number.isFinite(deadline) || deadline <= current) {
      throw new Error('maintenance capability expiry is invalid');
    }
    const capability = random();
    if (!CAPABILITY.test(capability)) throw new Error('maintenance capability source is invalid');
    const key = sha256(capability);
    if (entries.has(key)) throw new Error('maintenance capability collision');
    entries.set(key, {
      sessionDigest: sha256(sessionToken), verb, authority, expiresAt: deadline,
    });
    return capability;
  };
  const consume = ({ capability, sessionToken, verb }) => {
    if (!CAPABILITY.test(capability ?? '')) throw new Error('maintenance capability is invalid');
    prune();
    const key = sha256(capability);
    const entry = entries.get(key);
    if (!entry || entry.sessionDigest !== sha256(sessionToken) || entry.verb !== verb) {
      throw new Error('maintenance capability is absent, expired, or belongs to another action');
    }
    // Delete before any asynchronous provider work begins. A refused or
    // ambiguous native outcome cannot be replayed with the same authority.
    entries.delete(key);
    return entry.authority;
  };
  return Object.freeze({ mint, consume, size: () => { prune(); return entries.size; } });
}
