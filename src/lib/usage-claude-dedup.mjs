// Reconcile cached, per-file Claude message claims only after discovery. A
// cached session is always the transcript's own observation; no scan order or
// earlier cache write gets to decide which copied message owns the charge.
const COMPONENTS = ['input', 'output', 'cacheRead', 'cacheWrite', 'cacheWrite1h'];
const total = (claim) => COMPONENTS.reduce((n, key) => n + (claim.usage[key] ?? 0), 0);
const punchKey = (ms) => {
  const d = new Date(ms);
  return `${(d.getDay() + 6) % 7}-${d.getHours()}`;
};

function compareClaims(a, b) {
  const attribution = (item) => JSON.stringify([item.rec.id, item.rec.project,
    item.rec.worktree, item.rec.start, item.rec.end, item.rec.title, item.rec.sessionOrigin]);
  return total(b.claim) - total(a.claim)
    || (b.claim.at ?? 0) - (a.claim.at ?? 0)
    || attribution(a).localeCompare(attribution(b))
    || a.claim.model.localeCompare(b.claim.model)
    || a.claim.day.localeCompare(b.claim.day);
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
    list.sort(compareClaims);
    const winner = list[0];
    // Progressive snapshots can be split across copied files. Their
    // component-wise maxima are the complete observed usage, charged once to
    // the deterministic winner. The 1h tier cannot exceed total writes.
    const richest = Object.fromEntries(COMPONENTS.map((key) =>
      [key, list.reduce((max, { claim }) => Math.max(max, claim.usage[key] ?? 0), 0)]));
    richest.cacheWrite1h = Math.min(richest.cacheWrite1h, richest.cacheWrite);
    for (const item of list) alter(item.rec, item.claim, -1);
    alter(winner.rec, winner.claim, 1, richest);
  }
  return copies;
}
