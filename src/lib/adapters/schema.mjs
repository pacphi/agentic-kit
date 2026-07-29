const ID_RE = /^[a-z][a-z0-9-]*$/;

export const BILLING_TYPES = Object.freeze(['local', 'subscription', 'metered', 'unknown']);
export const PROVENANCE_TYPES = Object.freeze(['observed', 'configured', 'inferred', 'unknown']);
export const CREDENTIAL_KINDS = Object.freeze(['none', 'environment', 'host-login', 'unknown']);
export const OWNERSHIP_TYPES = Object.freeze(['agentic-kit', 'external', 'user', 'unknown']);

const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export function assertId(value, field = 'id') {
  if (typeof value !== 'string' || !ID_RE.test(value)) {
    throw new TypeError(`${field} must match ${ID_RE}`);
  }
  return value;
}

export function assertEnum(value, allowed, field) {
  if (!allowed.includes(value)) throw new TypeError(`${field} must be one of: ${allowed.join(', ')}`);
  return value;
}

export function assertStringArray(value, field, { allowEmpty = true } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)
    || value.some((entry) => typeof entry !== 'string' || entry.length === 0)) {
    throw new TypeError(`${field} must be an array of non-empty strings`);
  }
  if (new Set(value).size !== value.length) throw new TypeError(`${field} contains duplicates`);
  return value;
}

export function assertRecord(value, field) {
  if (!plain(value)) throw new TypeError(`${field} must be an object`);
  return value;
}

export function immutable(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) immutable(child);
  return Object.freeze(value);
}

export function registryFrom(entries, validate, kind) {
  if (!Array.isArray(entries)) throw new TypeError(`${kind} registry must be an array`);
  const out = {};
  for (const raw of entries) {
    const entry = validate(raw);
    if (out[entry.id]) throw new TypeError(`duplicate ${kind} id: ${entry.id}`);
    out[entry.id] = entry;
  }
  return immutable(out);
}
