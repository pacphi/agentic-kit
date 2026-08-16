// Hash-pinned capability-grant store (ADR-0031 §1, §2, §4). A JSON map of
// adapter name -> record under the kit config dir, mirroring adapter-consent's
// edit-invalidation model: a capability is earned by passing a conformance
// tier and GRANTED by the maintainer at a specific manifest hash, never
// self-declared in the adapter's own manifest (the permanent safety invariant
// this store exists to keep honest — see admission.mjs's schema allow-list).
// Change the manifest and the hash changes, so every prior tier result and
// every granted capability is void until re-earned at the new hash.
//
// No interactive prompting lives here — grants are RECORDED elsewhere (a
// future `ak host adapters trust` / `ak host adapters grant` command). This
// module is the programmatic seam those commands call.
//
// INVARIANT for callers wiring capabilities into runtime behaviour:
// grantedCapabilitiesFor() is the ONLY reader that may feed a capability
// decision. grantsFor() and gatedTiersFor() are reporting/inspection
// surfaces — grantsFor() can return a record pinned to a stale hash (flagged
// `stale: true` when a currentHash is supplied) precisely so a status
// display CAN show stale evidence as stale, not hide it. Reading
// grantsFor(name).capabilities directly to decide what a host may do would
// reintroduce the exact bug grantedCapabilitiesFor's hash pin exists to
// prevent.
import fs from 'node:fs';
import path from 'node:path';
import { configDir } from '../paths.mjs';

/** The five conformance tiers, in graduation order (ADR-0031 §2). */
export const CONFORMANCE_TIERS = Object.freeze([
  'admission', 'session-driving', 'activity-routing', 'primary-eligible', 'statusline',
]);

/** The only capabilities `ak` can grant. `session-driving` and
 * `activity-routing` gate capabilities a manifest may already express
 * (canDriveSession, canRouteActivities) — their tier records are evidence,
 * not grants, so they have no entry here. `aqeProvider` is never grantable by
 * `ak` at all (upstream-owned enumeration, ADR-0031 §4) and MUST NOT appear
 * in this map. */
export const TIER_GRANTS = Object.freeze({
  'primary-eligible': 'canBePrimary',
  statusline: 'commandStatusline',
});

export const adapterGrantsPath = () => path.join(configDir(), 'adapter-grants.json');

function readStore(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Atomic tmp+rename write at 0600, matching consent.mjs and the rest of the
 * kit's user-owned config writes. */
function writeStore(file, store) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  let renamed = false;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
    renamed = true;
  } finally {
    if (!renamed) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* cleanup must not mask the write error */ }
    }
  }
  try { fs.chmodSync(file, 0o600); } catch { /* best-effort on platforms without POSIX perms */ }
}

const GATED_BY_RE = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)?#[1-9][0-9]*$/;

function isValidTier(tier) {
  return typeof tier === 'string' && CONFORMANCE_TIERS.includes(tier);
}

function requireName(name, fnName) {
  if (typeof name !== 'string' || !name) throw new TypeError(`${fnName} requires an adapter name`);
}

function requireHash(hash, fnName) {
  if (typeof hash !== 'string' || !hash) throw new TypeError(`${fnName} requires a hash`);
}

function validRecord(value) {
  return !!value && typeof value === 'object'
    && typeof value.hash === 'string' && value.hash.length > 0
    && !!value.tiers && typeof value.tiers === 'object' && !Array.isArray(value.tiers);
}

/** The record for `name` at exactly `hash`, own-property only (Object.hasOwn,
 * never `in` — a store containing 'constructor' or '__proto__' must not read
 * as a record via the prototype chain). A hash mismatch (or no record at all)
 * means "start fresh": the caller REPLACES the whole entry, since stale-hash
 * evidence and capabilities must never coexist with fresh-hash evidence. */
function freshRecordAt(store, name, hash) {
  const existing = Object.hasOwn(store, name) ? store[name] : null;
  if (existing && existing.hash === hash) return { ...existing, tiers: { ...existing.tiers } };
  return { hash, tiers: {} };
}

/** Record a passing conformance-tier result for `name` at `hash`. Evidence is
 * truncated at 2048 chars — bounded so a runaway harness output can never
 * blow up the store. For a grant-bearing tier (one of TIER_GRANTS' keys —
 * 'primary-eligible', 'statusline') non-empty evidence is REQUIRED: ADR-0031
 * §1 is "conformance evidence plus an explicit maintainer grant confers
 * [the capability]", so a grant must never trace back to an empty evidence
 * string. Evidence-only tiers ('admission', 'session-driving',
 * 'activity-routing') keep it optional. Recording at a hash different from
 * the stored record silently REPLACES the whole entry: prior tiers and any
 * granted capabilities are void (they were earned against a manifest that no
 * longer exists at this hash).
 * @param {string} name
 * @param {string} tier
 * @param {{hash?: string, evidence?: string}} details
 * @param {{file?: string}} [options]
 */
export function recordTierResult(name, tier, { hash, evidence } = {}, { file = adapterGrantsPath() } = {}) {
  requireName(name, 'recordTierResult');
  requireHash(hash, 'recordTierResult');
  if (!isValidTier(tier)) throw new TypeError(`recordTierResult requires a valid tier (one of ${CONFORMANCE_TIERS.join(', ')}), got: ${tier}`);
  if (Object.hasOwn(TIER_GRANTS, tier) && (typeof evidence !== 'string' || evidence.trim().length === 0)) {
    throw new TypeError(`recordTierResult requires non-empty evidence for grant-bearing tier '${tier}' (gates '${TIER_GRANTS[tier]}')`);
  }
  const store = readStore(file);
  const record = freshRecordAt(store, name, hash);
  record.tiers[tier] = {
    status: 'passed',
    recordedAt: new Date().toISOString(),
    evidence: typeof evidence === 'string' ? evidence.slice(0, 2048) : '',
  };
  store[name] = record;
  writeStore(file, store);
}

/** Record that `tier` cannot be met because the capability is upstream
 * (ADR-0031 §4) — gated, not failed. `gatedBy` pins the tracking issue, e.g.
 * 'agentic-qe#563' or 'ruvnet/ruflo#2962'. Same hash-replace semantics as
 * recordTierResult.
 * @param {string} name
 * @param {string} tier
 * @param {{hash?: string, gatedBy?: string}} details
 * @param {{file?: string}} [options]
 */
export function recordTierGate(name, tier, { hash, gatedBy } = {}, { file = adapterGrantsPath() } = {}) {
  requireName(name, 'recordTierGate');
  requireHash(hash, 'recordTierGate');
  if (!isValidTier(tier)) throw new TypeError(`recordTierGate requires a valid tier (one of ${CONFORMANCE_TIERS.join(', ')}), got: ${tier}`);
  if (typeof gatedBy !== 'string' || !GATED_BY_RE.test(gatedBy)) {
    throw new TypeError(`recordTierGate requires gatedBy in '<repo>#<NNN>' form (e.g. 'agentic-qe#563'), got: ${gatedBy}`);
  }
  const store = readStore(file);
  const record = freshRecordAt(store, name, hash);
  record.tiers[tier] = { status: 'gated', recordedAt: new Date().toISOString(), gatedBy };
  store[name] = record;
  writeStore(file, store);
}

/** Grant `capability` to `name` — the maintainer's act that turns conformance
 * evidence into an actual capability (ADR-0031 §1). Refuses unless the tier
 * that gates `capability` is recorded 'passed' AT THE SAME hash: evidence
 * plus an explicit grant confers capability, never a grant on its own, and
 * never evidence recorded against a manifest that has since changed.
 * @param {string} name
 * @param {string} capability
 * @param {{hash?: string}} details
 * @param {{file?: string}} [options]
 */
export function grantCapability(name, capability, { hash } = {}, { file = adapterGrantsPath() } = {}) {
  requireName(name, 'grantCapability');
  requireHash(hash, 'grantCapability');
  const tier = Object.entries(TIER_GRANTS).find(([, cap]) => cap === capability)?.[0];
  if (!tier) {
    throw new TypeError(`grantCapability: '${capability}' is not a grantable capability (must be one of ${Object.values(TIER_GRANTS).join(', ')})`);
  }
  const store = readStore(file);
  const existing = Object.hasOwn(store, name) ? store[name] : null;
  const tierEntry = existing && existing.hash === hash ? existing.tiers?.[tier] : undefined;
  if (!tierEntry || tierEntry.status !== 'passed') {
    throw new Error(`grantCapability: '${name}' has no passed '${tier}' tier recorded at hash ${hash}`);
  }
  const record = { ...existing, tiers: { ...existing.tiers }, capabilities: { ...(existing.capabilities ?? {}) } };
  record.capabilities[capability] = true;
  record.grantedAt = new Date().toISOString();
  store[name] = record;
  writeStore(file, store);
}

/** Remove the whole record for `name` — every tier result, gate, and granted
 * capability. Returns whether an entry existed (Object.hasOwn semantics: a
 * prototype-chain name like 'constructor' never reads as existing). */
export function revokeGrants(name, { file = adapterGrantsPath() } = {}) {
  if (typeof name !== 'string' || !name) return false;
  const store = readStore(file);
  if (!Object.hasOwn(store, name)) return false;
  delete store[name];
  writeStore(file, store);
  return true;
}

/** The raw validated record for `name`, or null — missing, corrupt, or
 * malformed all collapse to null. Never throws. THIS IS A REPORTING SURFACE,
 * NOT A CAPABILITY READER — see the module-header invariant; runtime
 * capability decisions must go through grantedCapabilitiesFor().
 *
 * `currentHash` is optional and only changes what gets ANNOTATED, never what
 * gets returned or hidden: omitted, the raw record comes back with no
 * `stale` field at all (a caller not doing hash-aware reporting shouldn't
 * have to reason about it). Supplied, the record comes back with `stale:
 * true`/`false` so a status display can show stale evidence as stale
 * (rather than silently dropping it) while still being unambiguous about
 * whether it's current.
 * @param {string} name
 * @param {{file?: string, currentHash?: string}} [options]
 * @returns {any}
 */
export function grantsFor(name, { file = adapterGrantsPath(), currentHash } = {}) {
  if (typeof name !== 'string' || !name) return null;
  try {
    const store = readStore(file);
    const entry = Object.hasOwn(store, name) ? store[name] : null;
    if (!validRecord(entry)) return null;
    if (currentHash === undefined) return entry;
    return { ...entry, stale: entry.hash !== currentHash };
  } catch {
    return null;
  }
}

/** The granted capabilities for `name`, but ONLY when the record's pinned
 * hash matches `currentHash` — a manifest edit silently voids every grant
 * until re-earned, exactly consent's pin model. {} on any mismatch, missing
 * record, or read failure. Never throws. This is the ONLY reader capability-
 * wiring code may consume — see the module-header invariant. */
export function grantedCapabilitiesFor(name, currentHash, { file = adapterGrantsPath() } = {}) {
  try {
    const record = grantsFor(name, { file });
    if (!record || record.hash !== currentHash) return {};
    return record.capabilities && typeof record.capabilities === 'object' && !Array.isArray(record.capabilities)
      ? { ...record.capabilities }
      : {};
  } catch {
    return {};
  }
}

/** The tiers currently marked 'gated' for `name` — what it's waiting on
 * upstream. [] on missing/corrupt/no-gated-tiers. Never throws.
 * `currentHash` is optional; when supplied and it mismatches the record's
 * pinned hash, returns [] — a changed manifest voids its gated-tier records
 * exactly as it voids grants (they describe a manifest that no longer
 * exists at this hash), so a hash-aware caller must never surface them as
 * live open requests. Omitted, returns every gated tier regardless of hash
 * (the same raw-reporting behaviour as grantsFor with no currentHash).
 * @param {string} name
 * @param {{file?: string, currentHash?: string}} [options]
 * @returns {Array<{tier: string, gatedBy: string, recordedAt: string}>}
 */
export function gatedTiersFor(name, { file = adapterGrantsPath(), currentHash } = {}) {
  try {
    const record = grantsFor(name, { file });
    if (!record) return [];
    if (currentHash !== undefined && record.hash !== currentHash) return [];
    const out = [];
    for (const [tier, entry] of Object.entries(record.tiers)) {
      if (entry && entry.status === 'gated') out.push({ tier, gatedBy: entry.gatedBy, recordedAt: entry.recordedAt });
    }
    return out;
  } catch {
    return [];
  }
}
