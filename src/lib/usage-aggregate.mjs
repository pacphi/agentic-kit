// usage-aggregate.mjs — pure arithmetic over ALREADY-PARSED session records:
// interval math, secret masking, and the two shapes usage-index.mjs hands its
// consumers (the batch Aggregate from `aggregate()`, and the single-session
// `/api/session` payload from `sessionPayload()`). No file I/O, no caching —
// that stays in usage-index.mjs. No wire-format knowledge either — that lives
// in telemetry-records.mjs and usage-parsers.mjs. This module answers "what
// do these already-decoded records add up to", nothing about how they got
// decoded.
//
// Zero imports from sibling usage-* modules by design: usage-parsers.mjs
// imports `toMs`/`maskSecrets` FROM here, so this file must not import back
// from it (or from usage-index.mjs) to keep that a one-way dependency.

/** Milliseconds from an epoch number, Date, or ISO string; NaN when unusable.
 *  Exported only for usage-parsers.mjs's own timestamp parsing — not part of
 *  this module's documented public surface. */
export function toMs(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'string') return Date.parse(v);
  return NaN;
}

/**
 * Total seconds covered by a set of intervals, counting overlap ONCE.
 * Accepts `[start, end]` tuples or `{ start, end }` objects; each bound may be
 * an epoch number, a Date, or an ISO string. Degenerate or unparseable
 * intervals are dropped rather than throwing. Pure — exported for test.
 */
export function mergeIntervals(intervals) {
  if (!Array.isArray(intervals)) return 0;
  const spans = [];
  for (const iv of intervals) {
    if (!iv) continue;
    const start = toMs(Array.isArray(iv) ? iv[0] : iv.start);
    const end = toMs(Array.isArray(iv) ? iv[1] : iv.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    spans.push([start, end]);
  }
  if (!spans.length) return 0;
  spans.sort((a, b) => a[0] - b[0]);
  let total = 0;
  let [curStart, curEnd] = spans[0];
  for (let i = 1; i < spans.length; i++) {
    const [s, e] = spans[i];
    if (s <= curEnd) {           // overlapping OR exactly touching → extend
      if (e > curEnd) curEnd = e;
    } else {
      total += curEnd - curStart;
      curStart = s; curEnd = e;
    }
  }
  total += curEnd - curStart;
  return Math.round(total / 1000);
}

/** Largest single transcript readSession will pull into memory. The corpus's
 *  biggest real file is ~18 MB; JSON expansion runs ~5x, so 64 MB caps the
 *  spike near 320 MB instead of unbounded. Above this the session reads as
 *  unavailable rather than risking the panel's process. Lives here (not
 *  usage-index.mjs) only incidentally — see MAX_TURN_CHARS below for the one
 *  that matters to this module. */
export const MAX_TURN_CHARS = 40_000;

// Each replacement keeps the human-readable prefix and drops the payload. The
// replacement text cannot re-match its own pattern (the '…' is outside every
// character class), which is what makes masking idempotent.
/** @type {[RegExp, string][]} */
// Order matters. PEM blocks are matched WHOLE and first: a later pattern that
// nibbled at the base64 body would leave the armour behind, which reads as
// "masked" on screen while the key material is still visible.
const SECRET_PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    '-----BEGIN PRIVATE KEY----- …redacted -----END PRIVATE KEY-----'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/g, '-----BEGIN PRIVATE KEY----- …redacted'],
  [/\bsk-[A-Za-z0-9_-]{12,}/g, 'sk-…redacted'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, 'ghp_…redacted'],
  [/\bAKIA[0-9A-Z]{12,}/g, 'AKIA…redacted'],
  [/\bwhsec_[A-Za-z0-9_-]{16,}/g, 'whsec_…redacted'],
  [/\bASIA[0-9A-Z]{12,}/g, 'ASIA…redacted'],          // STS temporary credential
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, 'github_pat_…redacted'],
  [/\bglpat-[A-Za-z0-9_-]{16,}/g, 'glpat-…redacted'],
  [/\bhf_[A-Za-z0-9]{20,}/g, 'hf_…redacted'],
  [/\bpypi-[A-Za-z0-9_-]{16,}/g, 'pypi-…redacted'],
  [/\b(?:sk|rk)_live_[A-Za-z0-9]{16,}/g, 'sk_live_…redacted'],
  [/\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g, 'SG.…redacted'],
  [/\bnpm_[A-Za-z0-9]{30,}/g, 'npm_…redacted'],
  [/\bxox[baprse]-[A-Za-z0-9-]{10,}/g, 'xox…redacted'],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, 'AIza…redacted'],
  // Slack incoming-webhook URLs are bearer credentials in URL form.
  [/https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]+/g,
    'https://hooks.slack.com/services/…redacted'],
  // JWT — three base64url segments. Masked whole; the payload is the sensitive part.
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, 'eyJ…redacted'],
  // Inline credentials in a URI (postgres://user:pass@host, https://u:p@h). The
  // USERNAME is deliberately preserved — it is usually needed to identify which
  // system leaked, and it is not the secret.
  [/\b([a-z][a-z0-9+.-]*):\/\/([^\s:@/]+):[^\s@/]+@/g, '$1://$2:…redacted@'],
  [/\b(Basic)\s+[A-Za-z0-9+/]{16,}={0,2}/g, '$1 …redacted'],
  // Case-insensitive on the SCHEME only — `BEARER`/`bearer`/`Bearer` all appear
  // in the wild. The token body stays case-sensitive, so this cannot widen into
  // prose the way an /i on the assignment rule would.
  [/\b([Bb]earer|BEARER)\s+[A-Za-z0-9._~+/=-]{16,}/g, '$1 …redacted'],
  // Context-carried secrets: SCREAMING_CASE assignments whose NAME says secret.
  // Deliberately case-SENSITIVE: with /i this matches prose like
  // "tokens used = 10028979467", and these transcripts discuss token counts
  // constantly. Uppercase-only tracks the actual env-var convention instead.
  [/\b([A-Z][A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE_KEY)[A-Z0-9_]*)(\s*[:=]\s*)("?)[^\s"']{8,}\3/g,
    '$1$2$3…redacted$3'],
  // Quoted JSON/JS object key whose name says secret — "apiKey": "…", 'client_secret': '…'.
  // Case-insensitive is safe here: the quote delimiters are a shape prose never
  // has, so this cannot widen into "tokens used" the way the assignment rule's
  // /i would (that rule stays case-sensitive above for exactly that reason).
  [/(["'][A-Za-z0-9_-]*(?:secret|token|password|passwd|api_?key|private_?key)[A-Za-z0-9_-]*["']\s*:\s*)(["'])[^"']{8,}\2/gi,
    '$1$2…redacted$2'],
  // Line-anchored YAML/TOML/ini assignment — api_key = …, password: … — with no
  // quoting required. Anchored to line-start-through-key-through-:/= so it
  // cannot match a key phrase floating mid-sentence ("tokens used = 10028979467"
  // fails: "used" — not a secret-shaped word — sits directly before "=").
  [/^([ \t]*[A-Za-z0-9_-]*(?:secret|token|password|passwd|api_?key|private_?key)[A-Za-z0-9_-]*[ \t]*[:=][ \t]*)(["']?)[^\s"']{8,}\2/gim,
    '$1$2…redacted$2'],
];

// NOT masked, deliberately: a bare 40-char base64-ish AWS secret with no prefix
// and no assignment context. It is indistinguishable from a hash, a checksum, or
// a base64 blob in ordinary prose, and masking it would corrupt real transcript
// content. It is caught when it appears as AWS_SECRET_ACCESS_KEY=… above.

/**
 * Mask secret-shaped strings in transcript text (ADR-0009 §8). Idempotent, and
 * a no-op on ordinary prose. Pure — exported for test.
 */
export function maskSecrets(text) {
  if (text === null || text === undefined) return '';
  let out = typeof text === 'string' ? text : String(text);
  for (const [re, sub] of SECRET_PATTERNS) out = out.replace(re, sub);
  return out;
}

/**
 * Split the historical transcript-source `provider` field into an explicit host
 * and independently evidenced inference provider. The legacy field used
 * `claude`/`codex` to mean transcript host; those values therefore cannot prove
 * Anthropic/OpenAI provider identity.
 */
export function normalizeSessionIdentity(record = {}) {
  const legacyHost = !record.host && ['claude', 'codex'].includes(record.provider)
    ? record.provider : null;
  const host = record.host ?? legacyHost ?? null;
  const provider = legacyHost ? null : (record.provider ?? null);
  return {
    ...record,
    host,
    provider,
    model: record.model ?? null,
    providerProvenance: provider ? (record.providerProvenance ?? 'unknown') : 'unknown',
  };
}

const round = (n, p = 6) => Math.round(n * 10 ** p) / 10 ** p;

/** Sum a record's per-model usage rows into one API-equivalent cost. Rows with
 *  an observed transcript cost (opencode) use it — same preference as aggregate. */
function sessionCost(rec, deps) {
  let cost = 0;
  for (const row of rec.usage ?? []) {
    cost += row.costObserved != null ? row.costObserved : (deps.costOf({
      model: row.model, provider: rec.provider,
      input: row.input, output: row.output, cacheRead: row.cacheRead, cacheWrite: row.cacheWrite,
    }) || 0);
  }
  return round(cost);
}

// ── aggregation ─────────────────────────────────────────────────────────────

// Buckets are keyed by transcript-derived strings (model ids, project names), so
// a session naming itself `__proto__` would hit Object.prototype's setter: the
// bucket never becomes an own property and vanishes from JSON.stringify, silently
// losing that model's spend. Callers build these maps with Object.create(null);
// this guard keeps the invariant local even if one forgets.
function bucket(map, key) {
  if (!Object.prototype.hasOwnProperty.call(map, key)) {
    map[key] = {
      sessions: 0, responses: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
      tokens: 0, cost: 0,
      // `minutes` and `confidence` are NOT decoration. Three consumers read them
      // and every one of them silently rendered a zero before they existed:
      // project rows showed "0m", every category showed "confidence 0.00" (which
      // ADR-0009 §5 requires be DISPLAYED — a constant 0.00 is worse than
      // omitting it), and high-volume-automation printed "0.0 minutes each"
      // while its evidence asserted "short duration" — a duration claim it never
      // measured, i.e. fabricated evidence under ADR-0009 §6 rule 1.
      minutes: 0,
      confidence: 0,   // session-weighted mean, finalised by sealBuckets()
    };
  }
  return map[key];
}

function addTo(b, s) {
  b.sessions++; b.responses += s.responses;
  b.input += s.input; b.output += s.output;
  b.cacheRead += s.cacheRead; b.cacheWrite += s.cacheWrite;
  b.tokens += s.tokens; b.cost += s.cost;
  b.minutes += Number(s.minutes) || 0;
  // Accumulated as a SUM here and divided by `sessions` in sealBuckets, so the
  // result is a true mean rather than a running average that drifts with order.
  b.confidence += Number(s.confidence) || 0;
}

/** Turn accumulated confidence sums into means. Must run after every addTo. */
function sealBuckets(...maps) {
  for (const map of maps) {
    for (const k of Object.keys(map)) {
      const b = map[k];
      b.confidence = b.sessions ? round(b.confidence / b.sessions, 3) : 0;
      b.minutes = round(b.minutes, 2);
    }
  }
}

/** Price one usage row (observed opencode cost wins over the pricing table —
 *  `day` prices it at the rate in effect WHEN THOSE TOKENS WERE SPENT, not
 *  today's) and fold it into a session's running sums plus the shared
 *  byDay/byModel buckets. Mutates `acc` and `activeDays`. */
function foldSessionUsageRow(row, rec, deps, acc, byDay, byModel, activeDays) {
  const rowCost = row.costObserved != null ? row.costObserved : (deps.costOf({
    model: row.model, provider: rec.provider, day: row.day,
    input: row.input, output: row.output, cacheRead: row.cacheRead, cacheWrite: row.cacheWrite,
  }) || 0);
  acc.input += row.input; acc.output += row.output;
  acc.cacheRead += row.cacheRead; acc.cacheWrite += row.cacheWrite;
  acc.cost += rowCost;

  const rowTokens = row.input + row.output + row.cacheRead + row.cacheWrite;
  if (!byDay[row.day]) byDay[row.day] = { tokens: 0, cost: 0, sessions: 0, sessionsActive: 0 };
  byDay[row.day].tokens += rowTokens;
  byDay[row.day].cost = round(byDay[row.day].cost + rowCost);
  activeDays.add(row.day);

  const m = bucket(byModel, row.model);
  m.responses += row.responses; m.input += row.input; m.output += row.output;
  m.cacheRead += row.cacheRead; m.cacheWrite += row.cacheWrite;
  m.tokens += rowTokens; m.cost = round(m.cost + rowCost);
}

/** Fold every usage row of one record; returns `{input, output, cacheRead,
 *  cacheWrite, cost, firstDay}` for buildSessionRow. `firstDay` is the day
 *  this session's tokens FIRST landed on — always a key of byDay, which keeps
 *  sum(byDay.sessions) === totals.sessions (a session's start day is not
 *  usable: it can open at 23:58 and only bill after midnight). */
function foldSessionUsageRows(rec, deps, byDay, byModel) {
  const acc = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  let firstDay = null;
  const activeDays = new Set();
  for (const row of rec.usage) {
    if (firstDay === null || row.day < firstDay) firstDay = row.day;
    foldSessionUsageRow(row, rec, deps, acc, byDay, byModel, activeDays);
  }
  for (const day of activeDays) byDay[day].sessionsActive++;
  return { ...acc, firstDay };
}

/** One aggregate session row from a parsed record, its folded usage sums,
 *  and its classifier verdict. */
function buildSessionRow(rec, usage, verdict) {
  const { input, output, cacheRead, cacheWrite, cost, firstDay } = usage;
  return {
    id: rec.id, host: rec.host ?? rec.provider,
    provider: rec.inferenceProvider ?? null,
    transcriptProvider: rec.provider,
    providerProvenance: rec.providerProvenance ?? 'unknown',
    title: rec.title, project: rec.project,
    worktree: rec.worktree ?? null,
    start: new Date(rec.start ?? rec.end).toISOString(),
    minutes: Math.round(((rec.end - (rec.start ?? rec.end)) / 60_000) * 10) / 10,
    prompts: rec.prompts, responses: rec.responses, exceptions: rec.exceptions,
    sidechain: rec.sidechain, threadSource: rec.threadSource,
    models: rec.models.slice(),
    input, output, cacheRead, cacheWrite,
    tokens: input + output + cacheRead + cacheWrite,
    cost: round(cost),
    tools: { ...rec.tools },
    category: verdict.category ?? 'Unclassified',
    confidence: verdict.confidence ?? 0,
    basis: verdict.basis ?? 'no signal',
    skill: rec.skill, plugin: rec.plugin,
    // Codex-only detail (v6); zero / null on Claude sessions and on v5-cached
    // records (the schema bump re-derives those).
    reasoningOutput: rec.reasoningOutput ?? 0,
    rateLimits: rec.rateLimits ?? null,
    _span: [rec.start ?? rec.end, rec.end],
    // Pre-v2 cache entries have no `active`; fall back to the whole span so a
    // stale record degrades to the old figure instead of vanishing.
    _active: Array.isArray(rec.active) && rec.active.length ? rec.active : [[rec.start ?? rec.end, rec.end]],
    _punchcard: rec.punchcard,
    _day: firstDay,
  };
}

/** Records → aggregate session rows, folding usage into the shared byDay/
 *  byModel buckets as a side effect. */
function buildSessionRows(records, { cutoff, deps, byDay, byModel }) {
  const sessions = [];
  for (const rec of records) {
    if (!rec || !rec.responses) continue;                 // no assistant turn → not a session
    if (rec.end === null || rec.end < cutoff) continue;    // outside the window
    const usage = foldSessionUsageRows(rec, deps, byDay, byModel);
    const verdict = deps.classify({
      title: rec.title, skill: rec.skill, plugin: rec.plugin,
      tools: rec.tools, prompts: rec.prompts, responses: rec.responses,
    }) ?? {};
    sessions.push(buildSessionRow(rec, usage, verdict));
  }
  return sessions;
}

/** A session counts once under each model it used — the token and cost
 *  columns already partition cleanly, session counts cannot. */
function foldSessionByModel(byModel, s) {
  for (const model of s.models) {
    const b = bucket(byModel, model);
    b.sessions++;
    b.minutes += Number(s.minutes) || 0;
    b.confidence += Number(s.confidence) || 0;
  }
}

function foldSessionIntoTree(tree, s) {
  if (!tree.has(s.project)) tree.set(s.project, { project: s.project, sessions: 0, cost: 0, tokens: 0, minutes: 0, cats: new Map(), rows: [] });
  const node = tree.get(s.project);
  node.sessions++; node.cost = round(node.cost + s.cost); node.tokens += s.tokens;
  node.minutes = Math.round((node.minutes + s.minutes) * 10) / 10;
  const cat = node.cats.get(s.category) ?? { category: s.category, sessions: 0, cost: 0 };
  cat.sessions++; cat.cost = round(cat.cost + s.cost);
  node.cats.set(s.category, cat);
  node.rows.push(s);
}

/** Second pass over the (now sorted) session rows: totals, the by-host/
 *  provider/project/category/model buckets, the punchcard, and the project
 *  tree. `byModel` is the SAME object buildSessionRows already populated
 *  from usage rows — this pass adds its session/minutes/confidence fields. */
function foldSessionTotals(sessions, byDay, byModel) {
  const totals = {
    sessions: sessions.length, responses: 0, exceptions: 0, input: 0, output: 0,
    cacheRead: 0, cacheWrite: 0, tokens: 0, cost: 0,
    spanMinutes: 0, spanUnionSeconds: 0, engagedSeconds: 0,
  };
  const byHost = Object.create(null), byProvider = Object.create(null);
  const byProject = Object.create(null);
  const byCategory = Object.create(null), punchcard = Object.create(null);
  const tree = new Map();
  let spanMs = 0;

  for (const s of sessions) {
    totals.responses += s.responses; totals.exceptions += s.exceptions;
    totals.input += s.input; totals.output += s.output;
    totals.cacheRead += s.cacheRead; totals.cacheWrite += s.cacheWrite;
    totals.tokens += s.tokens; totals.cost += s.cost;
    spanMs += s._span[1] - s._span[0];

    addTo(bucket(byHost, s.host ?? 'unknown'), s);
    addTo(bucket(byProvider, s.provider ?? 'unknown'), s);
    addTo(bucket(byProject, s.project), s);
    addTo(bucket(byCategory, s.category), s);
    foldSessionByModel(byModel, s);
    if (s._day && byDay[s._day]) byDay[s._day].sessions++;
    for (const [k, n] of Object.entries(s._punchcard)) punchcard[k] = (punchcard[k] ?? 0) + n;
    foldSessionIntoTree(tree, s);
  }

  return { totals, byHost, byProvider, byProject, byCategory, punchcard, tree, spanMs };
}

function buildProjectTree(tree) {
  return [...tree.values()]
    .map((n) => ({
      project: n.project, sessions: n.sessions, cost: n.cost, tokens: n.tokens, minutes: n.minutes,
      categories: [...n.cats.values()].sort((a, b) => b.cost - a.cost || b.sessions - a.sessions),
      rows: n.rows,
    }))
    .sort((a, b) => b.cost - a.cost || b.tokens - a.tokens);
}

/** Local rate-limit history: every Codex rollout embeds live quota snapshots
 *  in its token_count events, so a utilization time series is reconstructable
 *  retroactively with ZERO network — one point per session (its last
 *  snapshot), oldest first. Claude has no local analogue (its quota arrives
 *  via the statusline push — see quota.mjs), hence codex-prefixed. */
function buildCodexRateLimits(sessions) {
  return sessions
    .filter((s) => s.host === 'codex' && s.rateLimits && Number.isFinite(s.rateLimits.at))
    .map((s) => s.rateLimits)
    .sort((x, y) => x.at - y.at);
}

/** Turn cached per-file records into the Aggregate the UI and detectors read. */
export function aggregate(records, { days, now, cutoff, deps }) {
  // Null-prototype: these are keyed by transcript-derived strings (day, model id,
  // provider, project, category), so `__proto__` as a key must be an ordinary
  // bucket, not a prototype write that silently discards the data.
  const byDay = Object.create(null);
  const byModel = Object.create(null);

  const sessions = buildSessionRows(records, { cutoff, deps, byDay, byModel });
  sessions.sort((a, b) => b.cost - a.cost || Date.parse(b.start) - Date.parse(a.start));

  const { totals, byHost, byProvider, byProject, byCategory, punchcard, tree, spanMs } =
    foldSessionTotals(sessions, byDay, byModel);

  totals.cost = round(totals.cost);
  // Three tiers, each honest about a different thing:
  //   engagedSeconds   — union of ACTIVE intervals: time actually worked
  //   spanUnionSeconds — union of whole spans: wall-clock with a session open
  //   spanMinutes      — sum of spans: the double-counting figure, kept as the
  //                      clearly-labelled secondary the ADR asks the UI to show
  sealBuckets(byHost, byProvider, byProject, byCategory, byModel);

  totals.spanMinutes = Math.round((spanMs / 60_000) * 10) / 10;
  totals.spanUnionSeconds = mergeIntervals(sessions.map((s) => s._span));
  totals.engagedSeconds = mergeIntervals(sessions.flatMap((s) => s._active));

  const projectTree = buildProjectTree(tree);
  for (const s of sessions) { delete s._span; delete s._active; delete s._punchcard; delete s._day; }
  const codexRateLimits = buildCodexRateLimits(sessions);

  const agg = {
    generatedAt: new Date(now).toISOString(),
    windowDays: days,
    pricesAsOf: deps.pricesAsOf ?? null,
    totals, byDay, byModel, byHost, byProvider,
    byProject, byCategory,
    punchcard, projectTree, sessions, codexRateLimits, insights: [],
  };
  agg.insights = deps.detectInsights(agg) ?? [];
  return agg;
}

/**
 * Overlay Codex's SQLite thread ledger onto parsed session records. Pure —
 * returns copies where anything changes, never mutates a (possibly cached)
 * record. Two corrections, both attribution-only:
 *   - a session whose rollout carried no `thread_source` is backfilled from
 *     the ledger's `threads.thread_source` (or marked `subagent` when a
 *     spawn edge names it as a child);
 *   - a session the ledger says is a subagent has its token usage STRIPPED,
 *     mirroring the parse-time exclusion: its rollout replays the parent's
 *     entire token history, so keeping the tokens double-counts the parent
 *     (ccusage/ccusage#950). The record itself stays visible/auditable.
 * Exported for test.
 */
export function applyCodexLedger(records, ledger) {
  if (!ledger || !(ledger.threads instanceof Map)) return records;
  return records.map((rec) => {
    if (!rec || rec.provider !== 'codex') return rec;
    const t = ledger.threads.get(rec.id);
    const fromEdges = ledger.parents instanceof Map && ledger.parents.has(rec.id) ? 'subagent' : null;
    const source = rec.threadSource ?? t?.threadSource ?? fromEdges;
    if (source === rec.threadSource && (source !== 'subagent' || !rec.usage.length)) return rec;
    const out = { ...rec, threadSource: source };
    if (source === 'subagent' && out.usage.length) out.usage = [];
    return out;
  });
}

/** The /api/session payload for any parsed record (claude, codex, opencode):
 *  meta with pricer-backed cost, and secret-masked, truncation-signalled turns. */
export function sessionPayload(rec, turns, deps) {
  const usage = (rec.usage ?? []).reduce((a, row) => ({
    input: a.input + row.input, output: a.output + row.output,
    cacheRead: a.cacheRead + row.cacheRead, cacheWrite: a.cacheWrite + row.cacheWrite,
  }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

  return {
    meta: {
      id: rec.id, host: rec.host ?? rec.provider,
      provider: rec.inferenceProvider ?? null,
      transcriptProvider: rec.provider,
      providerProvenance: rec.providerProvenance ?? 'unknown',
      title: rec.title, project: rec.project,
      worktree: rec.worktree ?? null,
      start: rec.start === null ? null : new Date(rec.start).toISOString(),
      end: rec.end === null ? null : new Date(rec.end).toISOString(),
      minutes: rec.start === null ? 0 : Math.round(((rec.end - rec.start) / 60_000) * 10) / 10,
      prompts: rec.prompts, responses: rec.responses, exceptions: rec.exceptions,
      sidechain: rec.sidechain, threadSource: rec.threadSource,
      models: rec.models.slice(), tools: { ...rec.tools },
      skill: rec.skill, plugin: rec.plugin,
      // Priced here from the same per-model rows aggregate() uses, rather than
      // left undefined: the transcript header rendered a hardcoded "$0.00" on a
      // panel whose whole subject is cost. `.filter(Boolean)` could not drop it
      // because fmtUsd(undefined) is the truthy string "$0.00".
      cost: sessionCost(rec, deps),
      ...usage, tokens: usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
    },
    // ADR-0009 §8: truncation is the other way content is withheld, and it used
    // to be silent — `truncated` was set and the renderer ignored it, so an
    // abridged turn read as a complete one. Both keys are emitted only when the
    // slice actually fired, so the field's *presence* is the signal and a whole
    // turn cannot be misread as an abridged one. `originalChars` is measured
    // after `maskSecrets`, so it describes loss due to truncation alone — it is
    // not a raw-file length, and must not be rendered as one.
    turns: (turns ?? []).map((t) => {
      const text = maskSecrets(t.text);
      const originalChars = text.length;
      if (originalChars <= MAX_TURN_CHARS) return { ...t, text };
      return {
        ...t,
        text: `${text.slice(0, MAX_TURN_CHARS)}\n…[truncated]`,
        truncated: true,
        originalChars,
      };
    }),
  };
}
