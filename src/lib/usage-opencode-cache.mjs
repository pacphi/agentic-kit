import { createHash } from 'node:crypto';
import { withDb } from './sqlite.mjs';
import { sessionAcquisitionCoverage } from './usage-opencode-bounds.mjs';
import { availableOpencodeMetadata, hasOpencodeV2Rows } from './usage-opencode-observations.mjs';

/** Called only inside the parser/read-probe snapshot after the same session's
 * acquisition budget passes. Hash only observation inputs, never the entire DB
 * or user/assistant text. Each framed row goes straight into the hash; only its
 * digest survives. Part removal/rewrite can preserve every upstream timestamp. */
export function opencodeObservationFingerprint(db, id) {
  const hash = createHash('sha256');
  const add = row => { const json = JSON.stringify(row); hash.update(`${Buffer.byteLength(json)}:`).update(json); };
  const columns = ['id', ...availableOpencodeMetadata(db)];
  add(db.prepare(`SELECT ${columns.join(', ')} FROM session WHERE id = ?`).get(id) ?? null);
  add(hasOpencodeV2Rows(db, id));
  // Multi-path extraction keeps JSON type distinctions (true vs 1, null vs
  // strings) and excludes prompt bodies. Malformed rows retain a validity
  // marker so the parser can still salvage other rows in the same session.
  for (const row of db.prepare(`SELECT id, json_valid(data) AS valid,
    CASE WHEN json_valid(data) THEN json_extract(data,
      '$.role', '$.parentID', '$.summary', '$.finish', '$.error', '$.time.completed',
      '$.tokens', '$.cost', '$.providerID') END AS observation
    FROM message WHERE session_id = ? ORDER BY id`).iterate(id)) add(row);
  add('parts');
  for (const row of db.prepare(`SELECT p.message_id, p.data
    FROM part p JOIN message m ON m.id = p.message_id
    WHERE m.session_id = ? AND CASE WHEN json_valid(p.data)
      THEN json_extract(p.data, '$.type') IN ('compaction', 'step-finish') ELSE 0 END
    ORDER BY p.rowid`).iterate(id)) add(row);
  return hash.digest('hex');
}

/** A warm-cache probe has its own read transaction and the parser's per-session
 * byte/row ceilings. Failure or insufficient coverage cannot authorize reuse. */
export function readOpencodeObservationFingerprint({ dbFile, id, maxSessionBytes, maxSessionRows }) {
  const result = withDb(dbFile, db => {
    db.exec('BEGIN');
    if (!sessionAcquisitionCoverage(db, id, { maxSessionBytes, maxSessionRows }).complete) return null;
    return opencodeObservationFingerprint(db, id);
  });
  return result.ok ? result.value : null;
}

export function reusableOpencodeObservations(candidate, entry, limits) {
  if (candidate.provider !== 'opencode') return true;
  return typeof entry.observationFingerprint === 'string'
    && /^[a-f0-9]{64}$/.test(entry.observationFingerprint)
    && entry.observationFingerprint === readOpencodeObservationFingerprint({
      dbFile: candidate.dbFile, id: candidate.id,
      maxSessionBytes: limits.maxSessionBytes, maxSessionRows: limits.maxSessionRows,
    });
}
