import { isLocalInferenceProvider } from './usage-local-provider.mjs';
// OpenCode v1.18.33: core/session/projector.ts accumulates step-finish usage,
// while opencode/session/processor.ts retains only the last step's message
// tokens. These counters are diagnostics, never an additional billing source.
export const OPENCODE_METADATA = ['version', 'time_compacting', 'cost', 'tokens_input',
  'tokens_output', 'tokens_reasoning', 'tokens_cache_read', 'tokens_cache_write'];

export function availableOpencodeMetadata(db) {
  const columns = new Set(db.prepare('PRAGMA table_info(session)').all().map(row => row.name));
  return OPENCODE_METADATA.filter(name => columns.has(name));
}

const finite = v => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const integer = v => Number.isSafeInteger(v) && v >= 0;
const parse = raw => { try { return JSON.parse(raw); } catch { return null; } };
const finished = data => typeof data?.finish === 'string' && data.finish.length > 0 && data.error == null;

function compactions(srow, messages, parts) {
  const requests = new Set(messages.filter(row => row.data?.role === 'user'
    && (parts.get(row.id) ?? []).some(part => part.type === 'compaction')).map(row => row.id));
  const completed = new Set();
  const failed = new Set();
  const pending = new Set();
  let orphaned = 0;
  for (const { data } of messages) {
    if (data?.role !== 'assistant' || data.summary !== true) continue;
    if (requests.has(data.parentID)) {
      if (finished(data)) completed.add(data.parentID);
      else if (data.error != null) failed.add(data.parentID);
      else pending.add(data.parentID);
    } else if (finished(data)) orphaned++;
  }
  const unresolved = [...requests].filter(id => !completed.has(id) && (!failed.has(id) || pending.has(id))).length;
  const lowerBound = completed.size;
  const incomplete = messages.some(row => !row.data || !['user', 'assistant'].includes(row.data.role));
  const inFlight = srow.time_compacting != null;
  return {
    compactions: lowerBound,
    compactionEvidence: { lowerBound, upperBound: incomplete || (inFlight && !unresolved)
      ? null : lowerBound + unresolved + orphaned },
    opencodeCompaction: { requests: requests.size, failed: [...failed].filter(id => !completed.has(id)).length,
      unresolved, orphaned, inFlight },
  };
}

function counters(data) {
  const t = data?.tokens;
  const values = [t?.input, t?.output, t?.reasoning, t?.cache?.read, t?.cache?.write];
  if (!values.every(integer) || !finite(data?.cost)) return null;
  // A nonzero total inconsistent with the verified additive convention is an
  // unsupported older provider basis, rather than a forced apparent mismatch.
  if (t.total != null && t.total !== 0 && (!integer(t.total) || t.total !== values.reduce((a, b) => a + b, 0))) return null;
  return [data.cost, ...values];
}
const same = (a, b) => a.every((n, i) => i === 0
  ? Math.abs(n - b[i]) <= 1e-9 * Math.max(1, n, b[i]) : n === b[i]);
const unknown = reason => ({ state: 'unknown', reason, basis: 'opencode-v1.18.33-single-step' });

function incompleteMessages(srow, messages, assistants) {
  return !assistants.length || srow.time_compacting != null || messages.some(row => !row.data
    || !['user', 'assistant'].includes(row.data.role)) || assistants.some(({ data }) => !finished(data)
    || !finite(data.time?.completed) || data.time.completed <= 0);
}

function reconciliation(srow, messages, parts, hasV2) {
  if (srow.version !== '1.18.33') return unknown('unsupported-version');
  if (hasV2 !== false) return unknown('unsupported-v2-scope');
  const session = [srow.cost, srow.tokens_input, srow.tokens_output, srow.tokens_reasoning,
    srow.tokens_cache_read, srow.tokens_cache_write];
  if (!finite(session[0]) || !session.slice(1).every(integer)) return unknown('invalid-session-counters');
  if (session.every(n => n === 0)) return unknown('unpopulated-session-counters');
  const assistants = messages.filter(row => row.data?.role === 'assistant');
  if (incompleteMessages(srow, messages, assistants)) return unknown('incomplete-messages');
  const sums = [0, 0, 0, 0, 0, 0];
  for (const { id, data } of assistants) {
    const usage = counters(data);
    if (!usage) return unknown('invalid-message-counters');
    if (usage.slice(1).every(n => n === 0)) return unknown('unreported-message-usage');
    if (data.cost === 0 && !isLocalInferenceProvider(data.providerID)) return unknown('untrusted-message-cost');
    const steps = (parts.get(id) ?? []).filter(part => part.type === 'step-finish');
    const step = steps.length === 1 ? counters(steps[0]) : null;
    if (!step || !same(usage, step)) return unknown('unproved-step-scope');
    for (let i = 0; i < sums.length; i++) sums[i] += usage[i];
  }
  // A user-owned step or unreadable part cannot be assigned to these messages.
  const assistantIds = new Set(assistants.map(row => row.id));
  for (const [id, rows] of parts) if (!assistantIds.has(id)
    && rows.some(row => row.type === 'step-finish')) return unknown('unproved-step-scope');
  if (!sums.every(finite) || !sums.slice(1).every(integer)) return unknown('invalid-message-counters');
  return { state: same(session, sums) ? 'matched' : 'mismatch', reason: null,
    basis: 'opencode-v1.18.33-single-step' };
}

export function hasOpencodeV2Rows(db, id) {
  const v2Table = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session_message'").get();
  if (!v2Table) return false;
  try { return !!db.prepare('SELECT 1 FROM session_message WHERE session_id = ? LIMIT 1').get(id); }
  catch { return null; } // unreadable scope is unknown, not an absent V2 stream
}

/** Metadata only: no raw message/parent identities, text, or charge values persist. */
export function opencodeObservations(db, srow, rows, parts) {
  const messages = rows.map(row => ({ id: row.id, data: parse(row.data) }));
  const hasV2 = hasOpencodeV2Rows(db, srow.id);
  return { ...compactions(srow, messages, parts),
    opencodeReconciliation: reconciliation(srow, messages, parts, hasV2) };
}

export function opencodeObservationProjection(rec) {
  const lower = Number.isSafeInteger(rec.compactions) && rec.compactions >= 0 ? rec.compactions : 0;
  const upper = rec.compactionEvidence?.upperBound;
  const valid = rec.compactionEvidence?.lowerBound === lower && (upper === null
    || (Number.isSafeInteger(upper) && upper >= lower));
  return { codexEffort: null, firstTokenMs: null, compactions: lower,
    compactionEvidence: { lowerBound: lower, upperBound: valid && rec.acquisitionCoverage?.complete !== false ? upper : null },
    opencodeReconciliation: rec.opencodeReconciliation ?? unknown('missing-observation'),
    opencodeCompaction: rec.opencodeCompaction ?? null };
}


/** Evidence can exist without a completed/billable response. Empty, fully
 * observed OpenCode sessions still have no compaction evidence to retain. */
export function hasOpencodeObservations(rec) {
  if (rec.host !== 'opencode' || rec.acquisitionCoverage?.complete === false) return false;
  const bounds = opencodeObservationProjection(rec).compactionEvidence;
  return bounds.lowerBound > 0
    || bounds.upperBound === null || bounds.upperBound > 0;
}


/** Refused acquisitions retain uncertainty without becoming ordinary zero-cost
 * session rows. Fold their bounds alone into the selected current/previous window. */
export function foldIncompleteOpencodeObservations(records, totals, cutoff, endMs = Infinity) {
  for (const rec of records) {
    if (rec?.host !== 'opencode' || rec.responses || rec.acquisitionCoverage?.complete !== false
      || !Number.isFinite(rec.end) || rec.end < cutoff || rec.end >= endMs) continue;
    const bounds = opencodeObservationProjection(rec).compactionEvidence;
    totals.compactions += bounds.lowerBound;
    totals.compactionEvidence.lowerBound += bounds.lowerBound;
    totals.compactionEvidence.upperBound = null;
  }
}
