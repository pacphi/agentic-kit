// footprint/snapshot.mjs — persistence for the deep-tier FootprintSnapshot.
//
// ONE file, ~/.config/agentic-kit/footprint-snapshot.json, written through the
// kit's existing backup-first atomic helper. This is the machine-footprint
// context's SOLE write (ADR-0025 §6, machine-footprint invariant 4): everything
// else in the domain is read-only measurement.
//
// Two rules shape every function here:
//   * Absence is not zero. A missing, unreadable, unparseable, or
//     wrong-schema file degrades to "never measured" WITH a reason
//     (ADR-0023 / invariant 2). No caller can ever receive a fabricated 0 from
//     this module, because a failed read carries `sections: null` — there is
//     no numeric field to misread.
//   * The runtime census is never persisted (invariant 5). It is structurally
//     impossible to write one here: `writeSnapshot` serializes only the section
//     keys in SNAPSHOT_SECTIONS, so a caller that hands over a census by
//     mistake silently drops it rather than replaying a stale process table as
//     liveness. That allow-list is the enforcement — adding a deep section
//     means adding it below, and `runtime` may never be one of them.
import fs from 'node:fs';
import path from 'node:path';
import { configDir } from '../paths.mjs';
import { writeFileWithBackup } from '../file-write.mjs';
import { CARRIED_FORWARD, MEASURED } from './walk.mjs';

/** Bump when a section's persisted SHAPE changes incompatibly. A snapshot
 *  written by a different version is not migrated and not guessed at — it
 *  reads as never-measured with an explicit reason, and the next deep scan
 *  replaces it. */
export const SNAPSHOT_SCHEMA_VERSION = 6;

/** The deep-tier sections, in collection order. This list is also the write
 *  filter — see the header note on the runtime census. A section absent from a
 *  previously written snapshot reads as never-measured rather than empty, so
 *  extending this list does not invalidate snapshots taken before it. */
export const SNAPSHOT_SECTIONS = Object.freeze([
  'install', 'storage', 'catalog', 'projects', 'consumers',
]);

/** How old a deep scan gets before the UI nudges for a rescan. Deliberately a
 *  nudge and not a trigger: ADR-0025's freshness policy is manual-rescan-only,
 *  so nothing in this module ever starts a scan on its own. */
export const SNAPSHOT_STALE_AFTER_MS = 7 * 86_400_000;

export function snapshotPath() {
  return path.join(configDir(), 'footprint-snapshot.json');
}

/**
 * @typedef {{
 *   present: boolean, asOf: number|null, writtenAt: string|null,
 *   schemaVersion: number|null, completeness: object|null,
 *   sections: object|null, reason: string|null, file: string,
 * }} PersistedSnapshot
 */

/** The one honest shape for "there is no deep measurement to show". */
function neverMeasured(file, reason) {
  return {
    present: false,
    asOf: null,
    writtenAt: null,
    schemaVersion: null,
    completeness: null,
    sections: null,
    reason,
    file,
  };
}

/**
 * Read the persisted deep snapshot.
 *
 * Never throws and never returns zeros: every failure path lands on
 * neverMeasured() with the reason that produced it, so the panel can say
 * "not measured yet — ENOENT" instead of painting an empty machine.
 *
 * @param {{ file?: string, fsImpl?: typeof fs }} [options]
 * @returns {PersistedSnapshot}
 */
export function readSnapshot({ file = snapshotPath(), fsImpl = fs } = {}) {
  let raw;
  try {
    raw = fsImpl.readFileSync(file, 'utf8');
  } catch (error) {
    return neverMeasured(file, error?.code === 'ENOENT'
      ? 'no deep scan has been run on this machine'
      : `snapshot unreadable: ${error?.code || 'io'}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return neverMeasured(file, 'snapshot file is not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return neverMeasured(file, 'snapshot file is not an object');
  }
  if (parsed.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
    return neverMeasured(file,
      `snapshot schema ${String(parsed.schemaVersion)} is not readable by this build`);
  }
  // A snapshot without a usable asOf cannot honour invariant 3 (every deep
  // figure carries the moment it was measured), so it is not usable at all.
  if (!Number.isFinite(parsed.asOf)) {
    return neverMeasured(file, 'snapshot carries no measurement time');
  }
  const sections = parsed.sections;
  if (!sections || typeof sections !== 'object' || Array.isArray(sections)) {
    return neverMeasured(file, 'snapshot carries no sections');
  }

  return {
    present: true,
    asOf: parsed.asOf,
    writtenAt: typeof parsed.writtenAt === 'string' ? parsed.writtenAt : null,
    schemaVersion: parsed.schemaVersion,
    completeness: parsed.completeness ?? null,
    // Missing sections stay missing (undefined), never {}: an absent section is
    // "this scan did not produce one", which the reader must be able to see.
    sections: Object.fromEntries(
      SNAPSHOT_SECTIONS
        .filter((key) => sections[key] != null)
        .map((key) => [key, sections[key]]),
    ),
    reason: null,
    file,
  };
}

/**
 * Per-section completeness, derived from what the collectors themselves
 * reported. Kept beside the data (rather than recomputed on read) so a
 * carried-forward figure can still say "this section was partial when
 * measured" months later.
 *
 * @param {object} sections
 * @returns {{ complete: boolean, sections: Record<string, object>, missing: string[] }}
 */
export function summarizeCompleteness(sections = {}) {
  const per = {};
  const missing = [];
  for (const key of SNAPSHOT_SECTIONS) {
    const section = sections?.[key];
    if (section == null) {
      missing.push(key);
      per[key] = { measured: false, complete: false, degraded: [], truncated: [] };
      continue;
    }
    per[key] = {
      measured: true,
      complete: section.complete !== false,
      degraded: Array.isArray(section.degraded) ? section.degraded : [],
      truncated: Array.isArray(section.truncated) ? section.truncated
        : (section.truncated ? [key] : []),
    };
  }
  return {
    complete: missing.length === 0 && Object.values(per).every((s) => s.complete),
    sections: per,
    missing,
  };
}

/**
 * Persist a deep-scan result.
 *
 * Fail-soft by contract: a snapshot that cannot be written is a degraded
 * *convenience* (the next open re-scans), never a failed scan — so this
 * returns an outcome instead of throwing, and the caller keeps the in-memory
 * result it just measured.
 *
 * @param {object} sections the deep sections named by SNAPSHOT_SECTIONS;
 *   anything else — the runtime census above all — is dropped
 * @param {{ file?: string, fsImpl?: typeof fs, now?: number, asOf?: number }} [options]
 * @returns {{ ok: boolean, file: string, asOf: number, error: string|null }}
 */
export function writeSnapshot(sections, {
  file = snapshotPath(), fsImpl = fs, now = Date.now(), asOf = null,
} = {}) {
  // Prefer the collectors' own asOf over wall-clock-at-write: the figures were
  // measured when the scan started, not when the file landed.
  const measuredAt = Number.isFinite(asOf) ? asOf
    : SNAPSHOT_SECTIONS.map((key) => sections?.[key]?.asOf).find(Number.isFinite) ?? now;
  const persisted = Object.fromEntries(
    SNAPSHOT_SECTIONS
      .filter((key) => sections?.[key] != null)
      .map((key) => [key, sections[key]]),
  );
  const body = {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    asOf: measuredAt,
    writtenAt: new Date(now).toISOString(),
    completeness: summarizeCompleteness(persisted),
    sections: persisted,
  };
  try {
    fsImpl.mkdirSync(path.dirname(file), { recursive: true });
    writeFileWithBackup(file, `${JSON.stringify(body)}\n`, { fsImpl });
    return { ok: true, file, asOf: measuredAt, error: null };
  } catch (error) {
    return { ok: false, file, asOf: measuredAt, error: String(error?.code || error?.message || error) };
  }
}

/** Does this look like a walk.mjs Measurement? Checked structurally rather than
 *  by class because the value crossed JSON on the way in. */
function isMeasurement(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && typeof value.status === 'string'
    && 'value' in value && 'reason' in value && 'asOf' in value && 'partial' in value;
}

/**
 * Re-stamp a persisted section tree as carried-forward.
 *
 * Invariant 3: data from a previous scan is never presented as current. A
 * `measured` figure read back off disk becomes `carried-forward` with THAT
 * scan's asOf, so a renderer cannot mistake it for something this request
 * measured. `unknown` stays unknown (a failed measurement does not improve by
 * being persisted) and an already carried-forward figure is left alone.
 *
 * Pure and recursive over plain JSON — the input has no cycles by construction.
 *
 * @param {*} value
 * @param {number} asOf the snapshot's own measurement time
 */
export function carryForward(value, asOf) {
  if (Array.isArray(value)) return value.map((item) => carryForward(item, asOf));
  if (!value || typeof value !== 'object') return value;
  if (isMeasurement(value)) {
    if (value.status !== MEASURED) return value;
    return { ...value, status: CARRIED_FORWARD, asOf };
  }
  const out = {};
  for (const [key, item] of Object.entries(value)) out[key] = carryForward(item, asOf);
  return out;
}

/**
 * Freshness facts for a read snapshot. `stale` drives the visible rescan nudge
 * and nothing else — no code path in this domain auto-scans on it.
 *
 * @param {PersistedSnapshot} snapshot
 * @param {{ now?: number, staleAfterMs?: number }} [options]
 */
export function snapshotFreshness(snapshot, {
  now = Date.now(), staleAfterMs = SNAPSHOT_STALE_AFTER_MS,
} = {}) {
  if (!snapshot?.present || !Number.isFinite(snapshot.asOf)) {
    return { measured: false, asOf: null, ageMs: null, stale: false, staleAfterMs };
  }
  const ageMs = Math.max(0, now - snapshot.asOf);
  return { measured: true, asOf: snapshot.asOf, ageMs, stale: ageMs > staleAfterMs, staleAfterMs };
}
