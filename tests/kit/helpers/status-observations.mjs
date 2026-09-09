import assert from 'node:assert/strict';

// Collection timestamps legitimately change between read-only inspections.
// Normalize only those fields: source cache dates and every semantic field
// remain part of golden/equivalence assertions.
export function normalizeStatusObservations(rows) {
  return rows.map(row => {
    if (!row.contextReport) return row;
    const report = structuredClone(row.contextReport);
    const normalize = record => {
      assert.equal(typeof record.observedAt, 'string');
      assert.ok(Number.isFinite(Date.parse(record.observedAt)), 'inspection timestamp must be valid');
      record.observedAt = '<inspection-time>';
    };
    normalize(report);
    for (const host of report.hosts) normalize(host);
    return { ...row, contextReport: report };
  });
}
