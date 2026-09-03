import { createHash, randomBytes } from 'node:crypto';

import { requestRejection } from './request-security.mjs';

export const MAINTENANCE_MUTATION_ROUTES = Object.freeze(new Set([
  '/api/maintenance/plans',
  '/api/maintenance/apply',
  '/api/maintenance/undo',
]));

export const MAX_MAINTENANCE_BODY_BYTES = 64 * 1024;
const PUBLIC_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const CAPABILITY = /^[A-Za-z0-9_-]{43}$/;

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

function requireConfirmation(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 160
    && !Array.from(value).some((character) => {
      const point = character.codePointAt(0);
      return point <= 31 || point === 127;
    });
}

function planBody(value) {
  if (!exactKeys(value, ['findingIds']) || !Array.isArray(value.findingIds)
      || value.findingIds.length < 1 || value.findingIds.length > 100
      || new Set(value.findingIds).size !== value.findingIds.length
      || value.findingIds.some((id) => !validId(id))) {
    throw new TypeError('invalid maintenance plan request');
  }
  return { findingIds: [...value.findingIds] };
}

function confirmedBody(value, label) {
  if (!exactKeys(value, ['capability', 'confirm', 'typedPhrase'])
      || !CAPABILITY.test(value?.capability ?? '') || value.confirm !== true
      || (value.typedPhrase != null && !requireConfirmation(value.typedPhrase))) {
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

/** Read a bounded JSON request without ever passing partial or surplus input
 * downstream. The stream is drained after rejection so the loopback server
 * can still send its small, generic error response. */
export function readMaintenanceJson(req, { maxBytes = MAX_MAINTENANCE_BODY_BYTES } = {}) {
  const type = String(req.headers?.['content-type'] || '').toLowerCase();
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/.test(type)) {
    return Promise.reject(Object.assign(new TypeError('content type must be application/json'), { statusCode: 415 }));
  }
  const declared = String(req.headers?.['content-length'] || '');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
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
    if (!sessionToken || !['apply', 'undo'].includes(verb) || !plainObject(authority)) {
      throw new TypeError('invalid maintenance capability authority');
    }
    prune();
    const capability = random();
    if (!CAPABILITY.test(capability)) throw new Error('maintenance capability source is invalid');
    const key = sha256(capability);
    if (entries.has(key)) throw new Error('maintenance capability collision');
    entries.set(key, {
      sessionDigest: sha256(sessionToken), verb, authority, expiresAt: Math.min(expiresAt, now() + ttlMs),
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
