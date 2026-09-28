// Shared evidence envelope for all evidence types (live checks, ruflo-components, etc.)
// One JSON file per kind/id under `<stateBase>/agentic-kit/evidence/`.
// Each record carries metadata (checkedAt, inputsKey, source) and a generic result payload.
// An inputsKey invalidates the record when configuration changes; ageMs marks it stale.
//
// This module establishes a NEW filesystem naming convention for evidence: kind/sanitized-id.json.
// Existing evidence stores (live-check-evidence.mjs, ruflo-components/evidence.mjs) use different
// patterns; this convention is introduced here for generic evidence storage to safely handle
// arbitrary id values (e.g., scoped package names like @claude-flow/memory contain forward slashes).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as paths from './paths.mjs';
import { writePrivateFileAtomic } from './file-write.mjs';

/** @typedef {{
 *   version: 1,
 *   kind: string,
 *   id: string,
 *   source: string,
 *   checkedAt: string,      // ISO
 *   inputsKey: string,
 *   inputs: object,
 *   result: object,
 * }} EvidenceRecord */

export const evidenceDir = paths.evidenceDir;

/** Sanitize id for filesystem use by replacing unsafe characters (/, \, :, NUL) with underscores.
 * This is the filesystem naming convention established by this module for arbitrary id values.
 * @param {string} id
 * @returns {string}
 */
function sanitizeId(id) {
  return String(id ?? '').replace(/[/\\:\0]/g, '_');
}

/**
 * Path to the evidence file for a given kind/id.
 * Format: <evidenceDir>/<kind>/<sanitized-id>.json
 * The sanitizeId convention replaces /, \, :, NUL with _ to ensure safe filesystem naming.
 * @param {string} kind
 * @param {string} id
 * @returns {string}
 */
export function evidenceFile(kind, id) {
  const sanitized = sanitizeId(id);
  return path.join(evidenceDir(), kind, `${sanitized}.json`);
}

/**
 * Key-order-independent JSON hash of inputs for change detection.
 * Generalizes the stable/digest pattern from live-check-evidence.mjs.
 * @param {unknown} parts
 * @returns {string} 16-char hex digest
 */
export function stableInputsKey(parts) {
  function stable(value) {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.keys(value).sort().map((k) => [k, stable(value[k])]));
    }
    return value ?? null;
  }
  const normalized = stable(parts);
  return crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex').slice(0, 16);
}

/**
 * Human-readable age description. Generalizes formatLiveCheckAge from live-check-evidence.mjs.
 * @param {number} ms milliseconds
 * @returns {string} e.g. "just now", "5m ago", "2h ago", "3d ago"
 */
export function describeAge(ms) {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * Write an evidence record atomically. Returns false on any write failure.
 * @param {string} kind
 * @param {string} id
 * @param {{source: string, inputsKey: string, inputs: object, result: object}} evidence
 * @param {{now?: number}} [options]
 * @returns {boolean}
 */
export function writeEvidence(kind, id, { source, inputsKey, inputs, result }, { now } = {}) {
  const checkedAt = new Date(now ?? Date.now()).toISOString();
  const record = {
    version: 1,
    kind,
    id,
    source,
    checkedAt,
    inputsKey,
    inputs,
    result,
  };
  try {
    writePrivateFileAtomic(evidenceFile(kind, id), `${JSON.stringify(record)}\n`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read an evidence record. Returns null if missing or unreadable.
 * Computes ageMs, stale, and invalidated fields based on options.
 * @param {string} kind
 * @param {string} id
 * @param {{inputsKey?: string, maxAgeMs?: number, now?: number}} [options]
 * @returns {null | (EvidenceRecord & {ageMs: number, stale: boolean, invalidated: boolean})}
 */
export function readEvidence(kind, id, { inputsKey, maxAgeMs, now } = {}) {
  let record;
  try {
    record = JSON.parse(fs.readFileSync(evidenceFile(kind, id), 'utf8'));
  } catch {
    return null;
  }

  // Validate record structure
  if (!record || typeof record !== 'object' || record.version !== 1) return null;
  if (typeof record.checkedAt !== 'string') return null;

  const checkedAtMs = Date.parse(record.checkedAt);
  if (!Number.isFinite(checkedAtMs)) return null;

  const nowMs = now ?? Date.now();
  const ageMs = Math.max(0, nowMs - checkedAtMs);

  return {
    version: record.version,
    kind: record.kind,
    id: record.id,
    source: record.source,
    checkedAt: record.checkedAt,
    inputsKey: record.inputsKey,
    inputs: record.inputs,
    result: record.result,
    ageMs,
    stale: maxAgeMs != null && ageMs > maxAgeMs,
    invalidated: inputsKey != null && record.inputsKey !== inputsKey,
  };
}
