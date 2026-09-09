// Bound native-to-JS materialization before any JSON bodies are selected.
// SQLite octet_length can inspect stored byte lengths without materializing
// long TEXT/BLOB bodies. Include ids and metadata too, not only JSON payloads.
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_ROWS = 100_000;
const limit = (value, ceiling) => Number.isSafeInteger(value) && value > 0
  ? Math.min(value, ceiling) : ceiling;

export function sessionAcquisitionCoverage(db, id, { maxSessionBytes, maxSessionRows }) {
  const byteLimit = limit(maxSessionBytes, MAX_BYTES);
  const rowLimit = limit(maxSessionRows, MAX_ROWS);
  const totals = db.prepare(`
    SELECT COALESCE(SUM(bytes), 0) AS bytes, COALESCE(SUM(rows), 0) AS rows, MAX(latest) AS latest FROM (
      SELECT COALESCE(SUM(octet_length(id) + COALESCE(octet_length(parent_id), 0)
        + COALESCE(octet_length(directory), 0) + COALESCE(octet_length(title), 0)), 0) AS bytes,
        COUNT(*) AS rows, MAX(CASE WHEN typeof(time_created) IN ('integer', 'real')
          THEN time_created END) AS latest FROM session WHERE id = ?
      UNION ALL
      SELECT COALESCE(SUM(octet_length(id) + octet_length(data) + 8), 0), COUNT(*),
        MAX(CASE WHEN typeof(time_created) IN ('integer', 'real') THEN time_created END)
        FROM message WHERE session_id = ?
      UNION ALL
      SELECT COALESCE(SUM(octet_length(p.message_id) + octet_length(p.data)), 0), COUNT(*), NULL
        FROM part p JOIN message m ON m.id = p.message_id WHERE m.session_id = ?
    )
  `).get(id, id, id);
  const reason = totals.bytes > byteLimit ? 'session-byte-limit'
    : totals.rows > rowLimit ? 'session-row-limit' : null;
  return {
    complete: reason === null, truncated: reason !== null, reason,
    latestMessageAt: totals.latest, sourceBytes: totals.bytes, sourceRows: totals.rows, byteLimit, rowLimit,
  };
}
