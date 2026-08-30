// usage-evidence-hash.mjs — a leaf module: evidence hashing only, no
// dependency on any other usage-coaching-* module (coaching cards, METRICS.md
// §22). Split out
// of usage-coaching.mjs (Fix round 3) to break the import cycle between the
// engine (usage-coaching.mjs) and the rules table (usage-coaching-rules.mjs)
// — both need `evidenceHash`, so it lives below both instead of inside
// either. usage-coaching.mjs re-exports `evidenceHash` unchanged, so this
// split is invisible to every existing import of it.
import { createHash } from 'node:crypto';

/** Sort every object's keys, recursively, so two callers who built the same
 *  evidence in a different field order still hash identically. Arrays keep
 *  their order — order is part of an array's meaning, unlike an object's key
 *  order, which is not. */
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key]);
    return out;
  }
  return value;
}

/**
 * A stable 16-hex-char sha256 over a canonical JSON serialization (sorted
 * keys, no whitespace) of `input`. Same inputs ⇒ same hash, on this process or
 * any other; any count change anywhere in `input` ⇒ a different hash — which
 * is the whole mechanism the ledger's staleness/decay logic rests on.
 *
 * @param {unknown} input
 * @returns {string}
 */
export function evidenceHash(input) {
  const json = JSON.stringify(canonicalize(input ?? {}));
  return createHash('sha256').update(json).digest('hex').slice(0, 16);
}
