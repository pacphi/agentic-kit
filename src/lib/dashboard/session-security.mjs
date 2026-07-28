import os from 'node:os';
import path from 'node:path';

/** Transcript roots are used only for containment checks. */
export const TRANSCRIPT_ROOTS = [
  path.join(os.homedir(), '.claude', 'projects'),
  path.join(os.homedir(), '.codex', 'sessions'),
];

/** Decode and validate an opaque session identifier. */
export function parseSessionId(raw) {
  let id;
  try { id = decodeURIComponent(String(raw ?? '')); } catch { return null; }
  if (id !== String(raw ?? '') && /%[0-9a-f]{2}/i.test(id)) return null;
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(id)) return null;
  if (id === '.' || id === '..') return null;
  return id;
}

/** Require the identifier to resolve to a direct child of a transcript root. */
export function resolvesInsideRoot(root, id) {
  const base = path.resolve(root);
  const resolved = path.resolve(base, id);
  return resolved !== base
    && resolved.startsWith(base + path.sep)
    && path.dirname(resolved) === base;
}

/** Copy and mask every string field in each transcript turn. */
export function maskTurns(turns, maskFn) {
  if (typeof maskFn !== 'function') {
    throw new Error('no secret masker available — refusing to serve an unmasked transcript');
  }
  return (Array.isArray(turns) ? turns : []).map((turn) => maskObject(turn, maskFn));
}

/** Copy and mask every string field in transcript metadata. */
export function maskMeta(meta, maskFn) {
  if (typeof maskFn !== 'function') {
    throw new Error('no secret masker available — refusing to serve unmasked metadata');
  }
  return meta && typeof meta === 'object' ? maskObject(meta, maskFn) : null;
}

function maskObject(value, maskFn) {
  if (typeof value === 'string') return maskFn(value);
  if (Array.isArray(value)) return value.map((item) => maskObject(item, maskFn));
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) out[key] = maskObject(item, maskFn);
  return out;
}
