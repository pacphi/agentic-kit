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

/** Local calendar day, `YYYY-MM-DD`. Local because "what did I spend today" is
 *  a question about the user's clock, not UTC's. Restated from
 *  usage-parsers.mjs (which keys its usage rows on the same convention)
 *  because THAT module imports from THIS one — see the header note on the
 *  one-way dependency. */
function localDay(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ── histograms & percentiles ────────────────────────────────────────────────

/** Response-latency histogram edges, in seconds; the 6th bucket (index 5)
 *  catches everything over 60s. */
export const LAT_BUCKET_EDGES = [2, 5, 10, 30, 60];
/** Session-length histogram edges, in seconds; the 5th bucket (index 4)
 *  catches everything over 2h. */
export const LEN_BUCKET_EDGES = [300, 900, 2700, 7200];
// These are the SAME edges usage-parsers.mjs fills each session's `latHist` on,
// restated here for the one-way-import reason above. A test pins the two copies
// equal, so a change to either goes red rather than silently re-labelling every
// bucket in the panel.

/** First bucket `i` whose edge `v` does not exceed, else the overflow bucket. */
function bucketIndex(edges, v) {
  for (let i = 0; i < edges.length; i++) if (v <= edges[i]) return i;
  return edges.length;
}

/**
 * The `q`th percentile of a bucketed distribution, in the buckets' own unit.
 * Interpolates LINEARLY inside the bucket the percentile lands in: the samples'
 * exact values are gone, and a uniform spread across the bucket is the only
 * assumption the counts still support.
 *
 * Two deliberately honest edges:
 *   - an empty histogram is `null`, never 0 — "nothing was measured" and
 *     "measured zero" are different claims, and only one of them is true here;
 *   - the overflow bucket has no upper edge to interpolate towards, so it
 *     reports its FLOOR. That understates by an unknown amount rather than
 *     inventing a ceiling; read it as "at least this".
 * Pure — exported for test.
 */
export function percentileFromBuckets(counts, edges, q) {
  if (!Array.isArray(counts) || !Array.isArray(edges)) return null;
  const total = counts.reduce((a, n) => a + (Number(n) || 0), 0);
  if (total <= 0) return null;
  const target = total * q;
  let cum = 0;
  for (let i = 0; i < counts.length; i++) {
    const n = Number(counts[i]) || 0;
    if (n <= 0) continue;
    if (cum + n >= target) {
      const lo = i === 0 ? 0 : edges[i - 1];
      if (i >= edges.length) return round(lo, 2);
      return round(lo + (edges[i] - lo) * ((target - cum) / n), 2);
    }
    cum += n;
  }
  return round(edges[edges.length - 1], 2);   // unreachable but for float drift in `target`
}

/** Family names that appear INSIDE an Anthropic model id. Matched by
 *  containment rather than position because the id shape has moved over time
 *  (`claude-3-5-sonnet-…` puts the family last, `claude-opus-5-…` puts it
 *  second) and both spellings still show up in real transcripts. */
const CLAUDE_FAMILIES = ['opus', 'sonnet', 'haiku', 'fable', 'mythos'];

/**
 * Fold a model id to the coarse family a stacked chart can carry — `opus`,
 * `sonnet`, `gpt-5`, … An id this fold does not recognise is `'other'`: never a
 * guessed family, and never dropped, because its spend still has to land
 * somewhere. Pure — exported for test.
 */
export function modelFamily(id) {
  const s = typeof id === 'string' ? id.toLowerCase() : '';
  if (!s) return 'other';
  const tail = s.slice(s.lastIndexOf('/') + 1);   // openrouter/anthropic/claude-… → claude-…
  for (const f of CLAUDE_FAMILIES) if (tail.includes(f)) return f;
  const gpt = /gpt-(\d+)/.exec(tail);
  return gpt ? `gpt-${gpt[1]}` : 'other';
}

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

/** One day's row, created on first touch. `byDay`'s presence contract is
 *  BILLED DAYS ONLY: a key exists exactly when tokens landed on that day, which
 *  is what the insight detectors count active days from. Engaged time therefore
 *  lives in its own sibling map (see buildEngagedByDay) rather than here, where
 *  a day worked but never billed would have had to invent a zero-token row. */
function dayBucket(byDay, day) {
  if (!byDay[day]) {
    byDay[day] = {
      tokens: 0, cost: 0, sessions: 0, sessionsActive: 0,
      byMode: Object.create(null), byModelFamily: Object.create(null),
    };
  }
  return byDay[day];
}

/** Accumulate one cost into a keyed cost map, rounding as it goes (the same
 *  treatment byDay.cost gets, so the parts still add up to the whole). */
function addCost(map, key, v) {
  map[key] = round((map[key] ?? 0) + v);
}

/**
 * What the prompt cache saved per 1M cache-read tokens, asked of the injected
 * pricer as a DIFFERENCE rather than derived from a discount factor: price 1M
 * tokens as fresh input, price the same 1M as cache reads, and the gap is the
 * spend that was avoided. Nothing here knows what the cache multiplier is, so
 * this figure cannot drift out of step with pricing.mjs the way a hardcoded
 * "0.9 of the input rate" would the day that multiplier changes.
 *
 * Both probes carry the row's own model/provider/DAY, so the saving is priced
 * from the same table, at the same date, as the cost sitting beside it — a
 * savings number quoted at today's rate for August's tokens would be a
 * different claim than the one the panel makes everywhere else. Memoised per
 * (model, provider, day) because a window has few of those and many rows; the
 * key joins on \x1f (ASCII unit separator), which cannot occur in a model id,
 * provider or day — and unlike NUL does not make grep read this file as
 * binary and silently report no matches.
 */
function cacheSavingPerMillion(model, provider, day, deps, rates) {
  const key = `${model}\x1f${provider}\x1f${day}`;
  if (rates.has(key)) return rates.get(key);
  const base = { model, provider, day, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const asInput = deps.costOf({ ...base, input: 1e6 }) || 0;
  const asCacheRead = deps.costOf({ ...base, cacheRead: 1e6 }) || 0;
  const saved = asInput - asCacheRead;
  rates.set(key, saved);
  return saved;
}

/** What the prompt cache actually saved on one usage row: the per-million gap
 *  above, scaled to the tokens this row actually read from cache. */
function cacheSavedFor(row, rec, deps, rates) {
  if (!(row.cacheRead > 0)) return 0;
  return (cacheSavingPerMillion(row.model, rec.provider, row.day, deps, rates) * row.cacheRead) / 1e6;
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
  const d = dayBucket(byDay, row.day);
  d.tokens += rowTokens;
  d.cost = round(d.cost + rowCost);
  // Cost by posture and by model family, per day: the two stacked series the
  // day chart draws. Both live here rather than in the session pass because
  // only a usage ROW knows which day its dollars landed on.
  addCost(d.byMode, rec.mode ?? 'not-recorded', rowCost);
  addCost(d.byModelFamily, modelFamily(row.model), rowCost);
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
function foldSessionUsageRows(rec, deps, byDay, byModel, rates) {
  const acc = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, cacheSaved: 0 };
  let firstDay = null;
  const activeDays = new Set();
  for (const row of rec.usage) {
    if (firstDay === null || row.day < firstDay) firstDay = row.day;
    acc.cacheSaved += cacheSavedFor(row, rec, deps, rates);
    foldSessionUsageRow(row, rec, deps, acc, byDay, byModel, activeDays);
  }
  for (const day of activeDays) byDay[day].sessionsActive++;
  return { ...acc, firstDay };
}

/** One aggregate session row from a parsed record, its folded usage sums,
 *  and its classifier verdict. */
function buildSessionRow(rec, usage, verdict) {
  const { input, output, cacheRead, cacheWrite, cost, cacheSaved, firstDay } = usage;
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
    // What the cache avoided for THIS session, so the window total is
    // auditable a row at a time rather than only in aggregate.
    cacheSavedUsd: round(cacheSaved),
    tools: { ...rec.tools },
    category: verdict.category ?? 'Unclassified',
    confidence: verdict.confidence ?? 0,
    basis: verdict.basis ?? 'no signal',
    skill: rec.skill, plugin: rec.plugin,
    // Codex-only detail (v6); zero / null on Claude sessions and on v5-cached
    // records (the schema bump re-derives those).
    reasoningOutput: rec.reasoningOutput ?? 0,
    rateLimits: rec.rateLimits ?? null,
    // v11 posture and rhythm (ADR-0038). Carried on the row, not folded away,
    // because every one of them is a per-session fact the transcript actually
    // recorded — and the window's histograms have to be traceable back to the
    // sessions that built them. `mode` and `latHist` stay honest-absent (null)
    // when nothing observed them.
    mode: rec.mode ?? null,
    latHist: Array.isArray(rec.latHist) ? rec.latHist.slice() : null,
    latCount: rec.latCount ?? 0,
    lenSeconds: rec.lenSeconds ?? 0,
    aborts: rec.aborts ?? 0,
    _span: [rec.start ?? rec.end, rec.end],
    // Did this session carry ANY token evidence? A session with no usage rows
    // costs $0 structurally — nothing was measured — rather than because the
    // work was cheap. Codex subagent rollouts are the common case: their tokens
    // are stripped as a double-count (applyCodexLedger), leaving a real session
    // with an empty ledger. The cost distribution excludes them; see
    // finishTotals.
    _priced: (rec.usage?.length ?? 0) > 0,
    // Pre-v2 cache entries have no `active`; fall back to the whole span so a
    // stale record degrades to the old figure instead of vanishing.
    _active: Array.isArray(rec.active) && rec.active.length ? rec.active : [[rec.start ?? rec.end, rec.end]],
    _punchcard: rec.punchcard,
    _day: firstDay,
  };
}

/** Records → aggregate session rows, folding usage into the shared byDay/
 *  byModel buckets as a side effect. `endMs` is the EXCLUSIVE upper bound the
 *  previous-window pass needs; leaving it unset means "everything since
 *  cutoff", which is what the current window wants. Exclusive on purpose: a
 *  session ending exactly at the cutoff belongs to the current window, and
 *  must not also be counted in the one before it. */
function buildSessionRows(records, { cutoff, endMs = null, deps, byDay, byModel, rates }) {
  const sessions = [];
  for (const rec of records) {
    if (!rec || !rec.responses) continue;                 // no assistant turn → not a session
    if (rec.end === null || rec.end < cutoff) continue;    // outside the window
    if (endMs != null && rec.end >= endMs) continue;       // ... or after the window asked for
    const usage = foldSessionUsageRows(rec, deps, byDay, byModel, rates);
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

/** The bucket key for a session's INFERENCE provider — and only when that
 *  identity was actually observed. A transcript host (`claude`, `codex`) does
 *  not prove which vendor served the tokens, so an unobserved provenance keys
 *  to `'not-recorded'` even when a provider string is present: that string is
 *  an assumption, and spend is not bucketed under assumptions. The ungated
 *  `byProvider` map still exists beside this one for callers that want the
 *  string as-recorded. */
function providerKey(s) {
  return s.providerProvenance === 'observed' && s.provider ? s.provider : 'not-recorded';
}

/** Subagent work is either Claude's sidechain flag or Codex's ledger-backed
 *  thread source; both mean "not a session a human was driving". */
function sourceKey(s) {
  return s.sidechain || s.threadSource === 'subagent' ? 'subagent' : 'main';
}

/** Second pass over the (now sorted) session rows: totals, the by-host/
 *  provider/mode/source/project/category/model buckets, the tool tally, the
 *  punchcard, and the project tree. `byModel` is the SAME object
 *  buildSessionRows already populated from usage rows — this pass adds its
 *  session/minutes/confidence fields. */
function foldSessionTotals(sessions, byDay, byModel) {
  const totals = {
    sessions: sessions.length, prompts: 0, humanPrompts: 0, responses: 0,
    exceptions: 0, aborts: 0,
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, tokens: 0, cost: 0,
    cacheSavedUsd: 0, spanMinutes: 0, spanUnionSeconds: 0, engagedSeconds: 0,
  };
  const byHost = Object.create(null), byProvider = Object.create(null);
  const byMode = Object.create(null), byInferenceProvider = Object.create(null);
  const bySource = Object.create(null), byTool = Object.create(null);
  const byProject = Object.create(null);
  const byCategory = Object.create(null), punchcard = Object.create(null);
  const tree = new Map();
  const pricedCosts = [];
  let spanMs = 0;
  // Both source rows always exist: "no subagent sessions" is a fact worth
  // rendering as a zero, not a row the UI silently drops.
  bucket(bySource, 'main'); bucket(bySource, 'subagent');

  for (const s of sessions) {
    const source = sourceKey(s);
    totals.prompts += s.prompts; totals.responses += s.responses;
    // Only a MAIN-thread prompt is a human typing. A subagent's prompts are
    // written by the harness, so counting them would inflate every
    // per-prompt denominator with work nobody asked for by hand.
    if (source === 'main') totals.humanPrompts += s.prompts;
    totals.exceptions += s.exceptions; totals.aborts += Number(s.aborts) || 0;
    totals.input += s.input; totals.output += s.output;
    totals.cacheRead += s.cacheRead; totals.cacheWrite += s.cacheWrite;
    totals.tokens += s.tokens; totals.cost += s.cost;
    totals.cacheSavedUsd += Number(s.cacheSavedUsd) || 0;
    if (s._priced) pricedCosts.push(s.cost);
    spanMs += s._span[1] - s._span[0];

    addTo(bucket(byHost, s.host ?? 'unknown'), s);
    addTo(bucket(byProvider, s.provider ?? 'unknown'), s);
    // 'not-recorded' is a first-class key, not a display fallback: a transcript
    // that carried no mode evidence must not be folded into a real posture.
    addTo(bucket(byMode, s.mode ?? 'not-recorded'), s);
    addTo(bucket(byInferenceProvider, providerKey(s)), s);
    addTo(bucket(bySource, source), s);
    addTo(bucket(byProject, s.project), s);
    addTo(bucket(byCategory, s.category), s);
    foldSessionByModel(byModel, s);
    if (s._day && byDay[s._day]) byDay[s._day].sessions++;
    for (const [k, n] of Object.entries(s._punchcard)) punchcard[k] = (punchcard[k] ?? 0) + n;
    for (const [k, n] of Object.entries(s.tools)) byTool[k] = (byTool[k] ?? 0) + n;
    foldSessionIntoTree(tree, s);
  }

  return {
    totals, byHost, byProvider, byMode, byInferenceProvider, bySource, byTool,
    byProject, byCategory, punchcard, tree, spanMs, pricedCosts,
  };
}

/** Exact median of a numeric list — the mean of the two middles on an even
 *  count — and `null` when there is nothing to take a median of. Sorts a copy:
 *  the caller's array is the order sessions were folded in. */
function median(values) {
  if (!values.length) return null;
  const v = values.slice().sort((a, b) => a - b);
  const mid = v.length >> 1;
  return round(v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2);
}

/** Nearest-rank `q`th percentile of a numeric list, `null` when empty. Exact
 *  values (unlike percentileFromBuckets, which only has counts to work from),
 *  so no interpolation is needed or honest here. */
function percentile(values, q) {
  if (!values.length) return null;
  const v = values.slice().sort((a, b) => a - b);
  const i = Math.min(v.length - 1, Math.max(0, Math.ceil(q * v.length) - 1));
  return round(v[i]);
}

/**
 * The derived half of `totals`: the three time tiers, then the rates and the
 * median that only mean anything once every session has been folded. Split out
 * so the previous-window projection derives them the SAME way instead of a
 * second, drifting way.
 *
 * The three tiers, each honest about a different thing:
 *   engagedSeconds   — union of ACTIVE intervals: time actually worked
 *   spanUnionSeconds — union of whole spans: wall-clock with a session open
 *   spanMinutes      — sum of spans: the double-counting figure, kept as the
 *                      clearly-labelled secondary the ADR asks the UI to show
 *
 * A rate whose denominator is zero is `null`, never 0: no engaged time means
 * the rate was never measured, which is not the claim "zero per hour" makes.
 *
 * Two denominators are narrower than they look, deliberately:
 *   - both per-prompt figures divide by HUMAN prompts (main-thread only). A
 *     subagent's prompts are written by the harness, so counting them would
 *     report a person as typing work they never typed;
 *   - the cost median and P90 are taken over PRICED sessions only. A session
 *     with no usage rows is $0 structurally — no tokens were ever recorded for
 *     it (a stripped Codex subagent, or a session that never billed) — and
 *     letting those into the distribution reports "the typical session cost
 *     nothing" when the truth is "we did not measure the typical session".
 */
function finishTotals(totals, sessions, { spanMs, pricedCosts }) {
  totals.cost = round(totals.cost);
  totals.cacheSavedUsd = round(totals.cacheSavedUsd);
  totals.spanMinutes = Math.round((spanMs / 60_000) * 10) / 10;
  totals.spanUnionSeconds = mergeIntervals(sessions.map((s) => s._span));
  totals.engagedSeconds = mergeIntervals(sessions.flatMap((s) => s._active));

  const hours = totals.engagedSeconds / 3600;
  totals.humanPromptsPerHour = hours ? round(totals.humanPrompts / hours) : null;
  totals.responsesPerPrompt = totals.humanPrompts
    ? round(totals.responses / totals.humanPrompts) : null;
  totals.costPerEngagedHour = hours ? round(totals.cost / hours) : null;
  totals.costPerSessionMedian = median(pricedCosts);
  totals.costPerSessionP90 = percentile(pricedCosts, 0.9);
}

/** The window's response-latency and session-length distributions. Latency
 *  histograms are merged slot-wise from the ones the parsers recorded — a
 *  session that never observed a latency carries `null` and contributes
 *  nothing, because absent is not a row of zeroes — while lengths are bucketed
 *  here from each session's own engaged seconds. */
function buildRhythm(sessions) {
  const latHist = new Array(LAT_BUCKET_EDGES.length + 1).fill(0);
  const lenHist = new Array(LEN_BUCKET_EDGES.length + 1).fill(0);
  let latCount = 0;
  for (const s of sessions) {
    if (Array.isArray(s.latHist)) {
      for (let i = 0; i < latHist.length; i++) latHist[i] += Number(s.latHist[i]) || 0;
      latCount += Number(s.latCount) || 0;
    }
    lenHist[bucketIndex(LEN_BUCKET_EDGES, Number(s.lenSeconds) || 0)]++;
  }
  return {
    latHist,
    latCount,
    latP50: percentileFromBuckets(latHist, LAT_BUCKET_EDGES, 0.5),
    latP95: percentileFromBuckets(latHist, LAT_BUCKET_EDGES, 0.95),
    lenHist,
    lenMedianSeconds: percentileFromBuckets(lenHist, LEN_BUCKET_EDGES, 0.5),
    lenP90Seconds: percentileFromBuckets(lenHist, LEN_BUCKET_EDGES, 0.9),
  };
}

/** Start of the LOCAL day after `ms`. Derived through Date rather than by
 *  adding 24h so a DST transition lands on the real midnight. */
function nextLocalMidnight(ms) {
  const d = new Date(ms);
  d.setHours(24, 0, 0, 0);
  return d.getTime();
}

/** Cut one active interval at every local midnight it crosses and file each
 *  piece under the day it was actually worked, so a session running past
 *  midnight gives the next day its real minutes instead of handing all of them
 *  to the day it started on. Mutates `out`. */
function splitAtLocalMidnight(start, end, out) {
  let s = start;
  while (s < end) {
    const next = nextLocalMidnight(s);
    const e = next > s ? Math.min(end, next) : end;   // never fail to advance
    (out[localDay(s)] ??= []).push([s, e]);
    s = e;
  }
}

/**
 * Engaged seconds per LOCAL day: the UNION of that day's active intervals, so
 * two sessions worked in parallel spend the minute once — the rule
 * totals.engagedSeconds follows, applied a day at a time. Summing this map
 * therefore reproduces totals.engagedSeconds exactly.
 *
 * A SIBLING of byDay, not a field on it: engaged time is keyed by the days work
 * happened on, byDay by the days tokens BILLED on, and those sets genuinely
 * differ (a session that runs past midnight, a day spent reading). Folding one
 * into the other would have meant either inventing zero-token byDay rows or
 * dropping real worked time.
 */
function buildEngagedByDay(sessions) {
  const perDay = Object.create(null);
  for (const s of sessions) {
    for (const [a, b] of s._active) splitAtLocalMidnight(a, b, perDay);
  }
  const out = Object.create(null);
  for (const day of Object.keys(perDay)) out[day] = mergeIntervals(perDay[day]);
  return out;
}

const DAY_MS = 86_400_000;

/**
 * Totals + rhythm for the equal-length window immediately before the DISPLAYED
 * one — the baseline any "vs. previous period" delta is measured against.
 * Deliberately a projection rather than a second whole Aggregate: nothing
 * downstream compares project trees or punchcards across windows, and shipping
 * the full shape twice would double the payload for fields nobody reads.
 *
 * Both bounds come from `now` and `days` — the window the UI is SHOWING — and
 * never from `cutoff`. The caller widens `cutoff` (via `buildIndex`'s
 * `lookbackDays`) precisely so records older than the displayed window survive
 * to be aggregated here; deriving the comparison from that widened bound would
 * make the baseline silently stretch to whatever lookback the caller happened
 * to ask for, and a delta against an unknown-length window is not a delta.
 */
function previousWindow(records, { days, now, deps, rates }) {
  const windowStart = now - days * DAY_MS;
  const byDay = Object.create(null);
  const byModel = Object.create(null);
  const sessions = buildSessionRows(records, {
    cutoff: windowStart - days * DAY_MS, endMs: windowStart, deps, byDay, byModel, rates,
  });
  const folded = foldSessionTotals(sessions, byDay, byModel);
  finishTotals(folded.totals, sessions, folded);
  return { totals: folded.totals, rhythm: buildRhythm(sessions) };
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

/** Turn cached per-file records into the Aggregate the UI and detectors read.
 *  `previous: true` additionally projects the equal-length window before the
 *  DISPLAYED one — `[now − 2·days, now − days)`, derived from `now`/`days` and
 *  not from `cutoff` (see previousWindow). Left off, `agg.previous` is `null` —
 *  "not requested", which a zeroed totals object would misreport as "measured
 *  nothing". */
export function aggregate(records, { days, now, cutoff, deps, previous = false }) {
  // Null-prototype: these are keyed by transcript-derived strings (day, model id,
  // provider, project, category, tool name), so `__proto__` as a key must be an
  // ordinary bucket, not a prototype write that silently discards the data.
  const byDay = Object.create(null);
  const byModel = Object.create(null);
  // One pricing-probe memo for the whole run, shared with the previous window:
  // both price the same models on the same days, and the rates cannot move
  // between them.
  const rates = new Map();

  const sessions = buildSessionRows(records, { cutoff, deps, byDay, byModel, rates });
  sessions.sort((a, b) => b.cost - a.cost || Date.parse(b.start) - Date.parse(a.start));

  const folded = foldSessionTotals(sessions, byDay, byModel);
  const { totals, byHost, byProvider, byMode, byInferenceProvider, bySource, byTool,
    byProject, byCategory, punchcard, tree } = folded;

  sealBuckets(byHost, byProvider, byProject, byCategory, byModel,
    byMode, byInferenceProvider, bySource);
  finishTotals(totals, sessions, folded);
  const engagedByDay = buildEngagedByDay(sessions);
  const rhythm = buildRhythm(sessions);

  const projectTree = buildProjectTree(tree);
  for (const s of sessions) {
    delete s._span; delete s._active; delete s._punchcard; delete s._day; delete s._priced;
  }
  const codexRateLimits = buildCodexRateLimits(sessions);

  const agg = {
    generatedAt: new Date(now).toISOString(),
    windowDays: days,
    pricesAsOf: deps.pricesAsOf ?? null,
    totals, byDay, engagedByDay, byModel, byHost, byProvider,
    byMode, byInferenceProvider, bySource, byTool,
    byProject, byCategory,
    punchcard, projectTree, sessions, codexRateLimits, rhythm,
    previous: previous ? previousWindow(records, { days, now, deps, rates }) : null,
    insights: [],
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
