// Reconcile cached, per-file Claude message claims only after discovery. A
// cached session is always the transcript's own observation; no scan order or
// earlier cache write gets to decide which copied message owns the charge.
const COMPONENTS = ['input', 'output', 'cacheRead', 'cacheWrite', 'cacheWrite1h'];
const nonnegative = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const total = (claim) => COMPONENTS.reduce((n, key) => n + (claim.usage[key] ?? 0), 0);
const compareText = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const punchKey = (ms) => {
  const d = new Date(ms);
  return `${(d.getDay() + 6) % 7}-${d.getHours()}`;
};

function compareClaims(a, b) {
  const attribution = (item) => JSON.stringify([item.rec.id, item.rec.project,
    item.rec.worktree, item.rec.start, item.rec.end, item.rec.title, item.rec.sessionOrigin,
    item.rec.sidechain, item.rec.threadSource, item.rec.parentSessionId,
    item.rec.inferenceProvider, item.rec.providerProvenance, item.rec.projectEvidence,
    item.rec.claudeSourceKey]);
  return total(b.claim) - total(a.claim)
    || (b.claim.at ?? 0) - (a.claim.at ?? 0)
    || compareText(attribution(a), attribution(b))
    || compareText(a.claim.model, b.claim.model)
    || compareText(a.claim.day, b.claim.day);
}

function validRow(row) {
  return !!row && typeof row.day === 'string' && typeof row.model === 'string'
    && Number.isSafeInteger(row.responses) && row.responses >= 0
    && COMPONENTS.every((key) => nonnegative(row[key] ?? 0))
    && (row.cacheWrite1h ?? 0) <= row.cacheWrite;
}

function validClaim(claim) {
  return !!claim && typeof claim === 'object'
    && typeof claim.identity === 'string' && /^[a-f0-9]{64}$/u.test(claim.identity)
    && Number.isSafeInteger(claim.at)
    && typeof claim.day === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(claim.day)
    && typeof claim.model === 'string' && !!claim.model && claim.model.length <= 100
    && !!claim.usage && typeof claim.usage === 'object'
    && COMPONENTS.every((key) => nonnegative(claim.usage[key]))
    && claim.usage.cacheWrite1h <= claim.usage.cacheWrite;
}

function sourceRows(rec) {
  const rows = new Map();
  for (const row of rec.usage) {
    if (!validRow(row)) return null;
    const rowKey = JSON.stringify([row.day, row.model]);
    if (rows.has(rowKey)) return null;
    rows.set(rowKey, row);
  }
  return rows;
}

function claimsFitRows(rec, rows) {
  const sums = new Map(), punches = new Map(), identities = new Set();
  for (const claim of rec.claudeMessages) {
    if (!validClaim(claim) || identities.has(claim.identity)) return false;
    identities.add(claim.identity);
    const rowKey = JSON.stringify([claim.day, claim.model]);
    if (!rows.has(rowKey)) return false;
    const sum = sums.get(rowKey) ?? Object.fromEntries([...COMPONENTS, 'responses'].map((key) => [key, 0]));
    for (const key of COMPONENTS) sum[key] += claim.usage[key];
    sum.responses++;
    sums.set(rowKey, sum);
    const pk = punchKey(claim.at);
    punches.set(pk, (punches.get(pk) ?? 0) + 1);
  }
  for (const [key, sum] of sums) {
    const row = rows.get(key);
    if (sum.responses > row.responses || COMPONENTS.some((field) => sum[field] > (row[field] ?? 0))) return false;
  }
  return [...punches].every(([key, count]) => Number.isSafeInteger(rec.punchcard[key]) && rec.punchcard[key] >= count);
}

/** A compatible cache must have enough internally consistent detail to
 * subtract its claims from the file's original usage rows. A bad cache is
 * reparsed from the source rather than passed into accounting. */
export function validClaudeMessageClaims(rec) {
  if (!rec || !Array.isArray(rec.claudeMessages) || !Array.isArray(rec.usage)
    || !Number.isSafeInteger(rec.responses) || rec.responses < rec.claudeMessages.length
    || !rec.punchcard || typeof rec.punchcard !== 'object') return false;
  const rows = sourceRows(rec);
  return !!rows
    && rec.usage.reduce((sum, row) => sum + row.responses, 0) === rec.responses
    && Object.values(rec.punchcard).reduce((sum, count) => sum + count, 0) === rec.responses
    && claimsFitRows(rec, rows);
}

function alter(rec, claim, factor, usage = claim.usage) {
  const row = rec.usage.find((r) => r.day === claim.day && r.model === claim.model);
  if (!row) return;
  for (const key of COMPONENTS) {
    if (key === 'cacheWrite1h' && !row.cacheWrite1h && !usage.cacheWrite1h) continue;
    row[key] = (row[key] ?? 0) + factor * (usage[key] ?? 0);
  }
  row.responses += factor;
  rec.accountedResponses += factor;
  const pk = punchKey(claim.at);
  rec.punchcard[pk] = (rec.punchcard[pk] ?? 0) + factor;
  if (rec.punchcard[pk] === 0) delete rec.punchcard[pk];
}

/** Return accounting copies. `responses` remains the file's original count;
 * `accountedResponses` is the globally unique count used by aggregate folds.
 * ID-less messages remain untouched, including equal-looking token vectors. */
export function reconcileClaudeMessages(records) {
  const copies = records.map((rec) => rec?.provider === 'claude'
    ? { ...rec, usage: rec.usage.map((row) => ({ ...row })),
      originalUsage: rec.usage, punchcard: { ...rec.punchcard }, accountedResponses: rec.responses }
    : rec);
  const groups = new Map();
  for (const rec of copies) {
    if (rec?.provider !== 'claude') continue;
    for (const claim of rec.claudeMessages ?? []) {
      if (typeof claim.identity !== 'string' || !claim.identity) continue;
      const list = groups.get(claim.identity) ?? [];
      list.push({ rec, claim });
      groups.set(claim.identity, list);
    }
  }
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    // The fixed acquisition pool decides charges for the displayed and
    // comparison windows. A deeper explicit lookback may reveal an older
    // copy, but that copy cannot steal or enlarge an eligible charge. If no
    // copy is eligible, reconcile the historical observations among themselves.
    const eligible = list.filter(({ rec }) => rec.claudeIdentityEligible === true);
    const owners = eligible.length ? eligible : list;
    owners.sort(compareClaims);
    const winner = owners[0];
    // Progressive snapshots can be split across copied files. Their
    // component-wise maxima are the complete observed usage, charged once to
    // the deterministic winner. The 1h tier cannot exceed total writes.
    const richest = Object.fromEntries(COMPONENTS.map((key) =>
      [key, owners.reduce((max, { claim }) => Math.max(max, claim.usage[key] ?? 0), 0)]));
    richest.cacheWrite1h = Math.min(richest.cacheWrite1h, richest.cacheWrite);
    for (const item of list) alter(item.rec, item.claim, -1);
    alter(winner.rec, winner.claim, 1, richest);
  }
  return copies;
}
