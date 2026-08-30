// usage-aggregate.mjs — pure arithmetic over ALREADY-PARSED session records:
// interval math, secret masking, and the two shapes usage-index.mjs hands its
// consumers (the batch Aggregate from `aggregate()`, and the single-session
// `/api/session` payload from `sessionPayload()`). No file I/O, no caching —
// that stays in usage-index.mjs. No wire-format knowledge either — that lives
// in telemetry-records.mjs and usage-parsers.mjs. This module answers "what
// do these already-decoded records add up to", nothing about how they got
// decoded.
//
// The dependency rule, stated precisely because this file used to claim zero
// sibling imports: usage-parsers.mjs imports `toMs`/`maskSecrets` FROM here, so
// this file must never import back from it (or from usage-index.mjs). The three
// modules it does import — usage-provenance, usage-prompt-patterns,
// usage-prompt-vocabulary — are LEAVES: each has zero imports of its own, so
// none of them can close a cycle through here. They are pure arithmetic over
// already-decoded fingerprints, which is exactly this module's own subject.
import { PROVENANCE_TAGS } from './usage-provenance.mjs';
import {
  crossSessionClusters, exactRepeatGroups, nearDupClusters, reAskPairs,
} from './usage-prompt-patterns.mjs';
import { labelFor } from './usage-prompt-vocabulary.mjs';

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

// ── prompt fingerprints: taps, shapes, and the operator's own baseline ──────

/** Tokens at or below which a typed prompt reads as a supervision TAP — "yes",
 *  "go ahead", "lgtm ship it" — rather than an instruction (spec §3.1). Named
 *  so the detector, the CLI and the view all quote ONE number. What it does not
 *  model: whether the tap was necessary. Some taps are legitimate approvals. */
export const TAP_MAX_TOKENS = 4;

/** How far back the personal baseline looks, and how many days with at least
 *  one typed prompt it needs before it will claim a normal. Under the floor the
 *  baseline is `null` and the detector falls back to an absolute threshold: an
 *  invented personal normal is worse than admitting there isn't one yet. */
export const BASELINE_TRAILING_DAYS = 90;
export const BASELINE_MIN_ACTIVE_DAYS = 30;

/** The provenance gate every figure in the Prompts view sits behind (spec
 *  §2.1): agent deliveries, adapter templates and control records all reach
 *  kind 'prompt', and counting them would report the operator as having asked
 *  for work nobody typed. */
const isTypedFP = (fp) => fp?.p === 'human';
/** ...and short enough to be a tap. `t` is the honest token count including
 *  repeats, so this is a length question, never a similarity one. */
const isTapFP = (fp) => (Number(fp?.t) || 0) <= TAP_MAX_TOKENS;

/** The day a record's tokens FIRST billed on — the attribution `byDay.sessions`
 *  and `byDay.exceptions` already use, and (for want of any per-fingerprint
 *  timestamp) the one the prompt series uses too. `null` when the record never
 *  billed: no day to attribute to, so it contributes to nothing. */
function firstBilledDay(rec) {
  let first = null;
  for (const row of rec.usage ?? []) if (first === null || row.day < first) first = row.day;
  return first;
}

/**
 * The v16 prompt-fingerprint projection for one record: what the operator
 * typed, how much of it was a tap, and the raw material the per-host figures
 * need (typed lengths, question count, persona-opener count).
 *
 * `typedPrompts`/`tapPrompts` are `null` — not 0 — when the record carries no
 * fingerprint layer at all. "Nothing was measured" and "measured nothing" are
 * different claims, and only the second supports a headless reading of the
 * session.
 *
 * `personaOpeners` counts only TYPED persona openers. The shape flag itself is
 * provenance-blind (a tool's own template still carries `o`), but the coaching
 * move it feeds — lift the role text into a managed library — is about what the
 * operator retypes by hand; a tool's template is already a managed artifact.
 */
function v16Projection(rec) {
  const fps = rec.promptFPs;
  if (!Array.isArray(fps)) {
    return { typedPrompts: null, tapPrompts: null, _typedTokens: [], _questions: 0, _personas: 0 };
  }
  const out = { typedPrompts: 0, tapPrompts: 0, _typedTokens: [], _questions: 0, _personas: 0 };
  for (const fp of fps) {
    if (!isTypedFP(fp)) continue;
    out.typedPrompts++;
    if (isTapFP(fp)) out.tapPrompts++;
    out._typedTokens.push(Number(fp.t) || 0);
    if (fp.q === 1) out._questions++;
    if (fp.o === 1) out._personas++;
  }
  return out;
}

/** One host's running prompt bucket. Same null-prototype reasoning as
 *  `bucket()`: the key is a transcript-derived host name. */
function promptHostBucket(map, key) {
  if (!Object.prototype.hasOwnProperty.call(map, key)) {
    map[key] = { typed: 0, taps: 0, questions: 0, personaOpeners: 0, typedTokens: [] };
  }
  return map[key];
}

/** One day's prompt row and the per-host row inside it, both created on first
 *  touch. Unlike `byDay` (billed days only) a key here means "a session
 *  attributed to this day carried the fingerprint layer" — so a zero is a
 *  measurement, not a missing day. */
function promptDayRows(byDay, day, host) {
  const d = (byDay[day] ??= { typed: 0, taps: 0, byHost: Object.create(null) });
  const h = (d.byHost[host] ??= { typed: 0, taps: 0 });
  return [d, h];
}

/** Fold one session row's already-projected prompt counts into the window
 *  totals, the per-host buckets and the per-day series. Pure summation — the
 *  fingerprint rules live in v16Projection and are not restated here. */
function foldSessionPrompts(s, totals, promptsByHost, promptStatsByDay) {
  if (s.typedPrompts === null) return;          // no fingerprint layer: absent, not zero
  const host = s.host ?? 'unknown';
  const h = promptHostBucket(promptsByHost, host);
  totals.typedPrompts += s.typedPrompts;
  totals.tapCount += s.tapPrompts;
  h.typed += s.typedPrompts; h.taps += s.tapPrompts;
  h.questions += s._questions; h.personaOpeners += s._personas;
  for (const t of s._typedTokens) h.typedTokens.push(t);
  if (!s._day) return;
  const [d, dh] = promptDayRows(promptStatsByDay, s._day, host);
  d.typed += s.typedPrompts; d.taps += s.tapPrompts;
  dh.typed += s.typedPrompts; dh.taps += s.tapPrompts;
}

/** Turn the running per-host buckets into the published shape. Every share is
 *  `null` rather than 0 when its denominator is empty, and `p90TypedTokens`
 *  likewise: a host with no typed prompt has no length to report. */
function sealPromptHosts(map) {
  for (const host of Object.keys(map)) {
    const b = map[host];
    map[host] = {
      typed: b.typed,
      taps: b.taps,
      tapShare: b.typed ? round(b.taps / b.typed) : null,
      p90TypedTokens: percentile(b.typedTokens, 0.9),
      personaOpeners: b.personaOpeners,
      questionShare: b.typed ? round(b.questions / b.typed) : null,
    };
  }
}

/**
 * The operator's own tap-share normal, per host: the p75 of the DAILY tap
 * shares over the BASELINE_TRAILING_DAYS immediately before the displayed
 * window. Deliberately excludes the displayed window — that is what the
 * baseline is compared against, and a window that fed its own threshold could
 * never look unusual.
 *
 * Pure, and computed from `records` rather than from the window's session rows,
 * because those are filtered at the display cutoff. It therefore only sees the
 * history the caller's `lookbackDays` actually pulled in; a host with no
 * trailing record simply has no entry, which reads the same as `null` to a
 * detector and is the honest shape for "never measured".
 *
 * Under BASELINE_MIN_ACTIVE_DAYS days of history the value is `null`: a p75
 * over a handful of days is a number, not a normal.
 */
function buildPromptBaselines(records, { days, now }) {
  const startDay = localDay(now - (days + BASELINE_TRAILING_DAYS) * DAY_MS);
  const endDay = localDay(now - days * DAY_MS);
  const perHost = Object.create(null);
  for (const rec of records) {
    if (!rec || !Array.isArray(rec.promptFPs)) continue;
    const day = firstBilledDay(rec);
    if (day === null || day < startDay || day >= endDay) continue;
    const byDay = (perHost[rec.host ?? rec.provider ?? 'unknown'] ??= Object.create(null));
    const row = (byDay[day] ??= { typed: 0, taps: 0 });
    for (const fp of rec.promptFPs) {
      if (!isTypedFP(fp)) continue;
      row.typed++;
      if (isTapFP(fp)) row.taps++;
    }
  }
  const out = Object.create(null);
  for (const host of Object.keys(perHost)) {
    const shares = Object.values(perHost[host])
      .filter((r) => r.typed > 0)
      .map((r) => r.taps / r.typed);
    out[host] = {
      tapShareP75_trailing90d:
        shares.length >= BASELINE_MIN_ACTIVE_DAYS ? percentile(shares, 0.75) : null,
    };
  }
  return out;
}

// ── promptPatterns: the opt-in repetition projection ───────────────────────
// Spec §3.2 panel 3 and §3.3's CLI. Built HERE, beside buildPromptBaselines,
// because this is the layer that already reads `records` — and built only when
// a caller asks (`prompts: true`), exactly as `previous` is.
//
// RAW FINGERPRINTS NEVER GET A PUBLIC ACCESSOR. The fingerprint layer is 2.8 MB
// on the reference corpus, so shipping it would put it on every dashboard poll,
// and it would put decoration semantics in every consumer. Only this projection
// ships: aggregates, plus a capped list of session ids per cluster so a view can
// link to the existing masked session surface. No prompt text exists here to
// leak, which the tests pin structurally.

/** The clustering threshold the Prompts view ships at (spec §3.2 panel 3),
 *  looser than the pattern library's own 0.8 default on purpose: phrasing
 *  variance is the signal. Eleven wordings of one request outrank eleven
 *  identical ones, because eleven wordings prove there is no canonical form to
 *  point at; precision comes from the type filter, not from tightening this. */
export const PROMPT_CLUSTER_JACCARD = 0.6;

/** Re-asks keep the research's tighter 0.8 (findings §5.1). A re-ask is "that
 *  didn't work, so I said it again", which is a claim about near sameness; the
 *  looser threshold above would count an ordinary follow-up as a repeat. */
export const PROMPT_REASK_JACCARD = 0.8;

/** Session ids attached to a cluster so a view can link to the masked
 *  `GET /api/session/:id` surface. A LINK AFFORDANCE, not a session list —
 *  three is enough to click through and few enough that the projection cannot
 *  become a membership dump. */
const CLUSTER_SAMPLE_SESSIONS = 3;

/**
 * One stored fingerprint, decorated with WHERE it happened — the input shape
 * usage-prompt-patterns.mjs documents. THIS IS THE ONLY PLACE THE DECORATION
 * SEMANTICS LIVE; a second copy in a consumer is how the two surfaces drift.
 *
 * `q` and `o` are ALWAYS SET as booleans, and that is load-bearing twice over.
 * The scan path stores them as the number 1 and OMITS them when false
 * (usage-parsers.promptShape), while the clustering library reads `m.q === true`
 * / `m.q === false` and treats an absent flag as "nobody classified this". Passed
 * through raw, `1 !== true` made every cluster report `unknown`; and even mapped
 * for truthiness, a never-written `false` left the `instruction` class
 * unreachable, so an instruction cluster was indistinguishable from an
 * unclassified one and three of the four seed patterns could never match.
 *
 * AN ABSENT FLAG THEREFORE MEANS "MEASURED, AND NOT THAT SHAPE" — not
 * "unclassified". That reading is only sound because the parser decides both
 * flags for every fingerprint it writes and the index cache is schema-gated, so
 * every record reaching here was written by a parser that made both decisions.
 *
 * @param {{h: string, t: number, th: string[], p?: string, q?: 1, o?: 1}} fp
 * @param {{id: string, host?: string, provider?: string}} rec the record the
 *   fingerprint was stored on
 * @param {string|null} day its first-billed day (promptStatsByDay's convention)
 */
function decoratePromptFP(fp, rec, day) {
  return {
    ...fp,
    q: fp.q === 1,
    o: fp.o === 1,
    sessionId: rec.id,
    day,
    host: rec.host ?? rec.provider ?? 'unknown',
  };
}

/** Every in-window fingerprint, decorated. The record gate matches
 *  buildSessionRows' (no assistant turn is not a session; `end < cutoff` is
 *  outside the window) so this projection and the window's own totals are taken
 *  over one population. */
function windowFingerprints(records, cutoff) {
  const out = [];
  for (const rec of records) {
    if (!rec?.responses || !Array.isArray(rec.promptFPs)) continue;
    if (rec.end == null || rec.end < cutoff) continue;
    const day = firstBilledDay(rec);
    for (const fp of rec.promptFPs) out.push(decoratePromptFP(fp, rec, day));
  }
  return out;
}

/** A cluster reduced to its published row. Sets become counts, except `hosts`,
 *  which stays a sorted name list because a host chip is what a reader acts on
 *  and the host set is small, closed and already public in `byHost`. */
function promptClusterRow(cluster) {
  const label = labelFor(cluster, {});
  return {
    key: cluster.key,
    // RULING B (final-triage item 2): `descriptor` rides along only for a
    // characterized row (the full "Recurring N-token X · N sessions · N
    // hosts" string) — a curated/seeded/enriched `name` already IS the whole
    // thing, so there is no second string to publish. Left off rather than
    // set to `undefined` so a consumer's `'descriptor' in label` reads true
    // only when there is something there.
    label: {
      name: label.name, source: label.source,
      ...(typeof label.descriptor === 'string' ? { descriptor: label.descriptor } : {}),
    },
    class: cluster.class,
    count: cluster.size,
    sessions: cluster.sessions.size,
    days: cluster.days.size,
    hosts: [...cluster.hosts],
    medianTokens: cluster.tokens.median,
    sampleSessionIds: [...cluster.sessions].slice(0, CLUSTER_SAMPLE_SESSIONS),
  };
}

/** Counts per provenance tag over the WHOLE fingerprinted population — the
 *  denominator every typed figure sits behind (spec §2.1). Every tag in the
 *  vocabulary gets a row, including ones this corpus never produced: a missing
 *  tag is evidence about the corpus, not a row to drop. */
function promptProvenance(fps) {
  const counts = Object.create(null);
  for (const tag of PROVENANCE_TAGS) counts[tag] = 0;
  let unrecognized = 0;
  for (const fp of fps) {
    if (Object.hasOwn(counts, fp.p)) counts[fp.p]++;
    else unrecognized++;
  }
  return unrecognized ? { ...counts, unrecognized } : { ...counts };
}

/** Typed taps grouped by TOKEN LENGTH. No text exists at this layer, so "the
 *  top taps" can only be a length distribution — which is the honest shape of
 *  the question here; a verbatim table needs a transcript re-read. */
function promptTapLengths(typed) {
  const byLen = new Map();
  for (const fp of typed) {
    if (!isTapFP(fp)) continue;
    const t = Number(fp.t) || 0;
    const row = byLen.get(t)
      ?? { tokens: t, prompts: 0, sessions: new Set(), days: new Set(), hosts: new Set() };
    row.prompts++;
    if (fp.sessionId) row.sessions.add(fp.sessionId);
    if (fp.day) row.days.add(fp.day);
    if (fp.host) row.hosts.add(fp.host);
    byLen.set(t, row);
  }
  return [...byLen.values()]
    .sort((a, b) => b.prompts - a.prompts || a.tokens - b.tokens)
    .map((r) => ({
      tokens: r.tokens, prompts: r.prompts,
      sessions: r.sessions.size, days: r.days.size, hosts: [...r.hosts].sort(),
    }));
}

/**
 * The published repetition projection: which requests recur, which were asked
 * twice in one sitting, and which are typed identically over and over.
 *
 * Ordering is deterministic throughout — the clustering library sorts by size
 * then key, `exactRepeatGroups` by count then hash, and every Set it hands back
 * iterates sorted — so a rescan over an unchanged corpus reproduces this object
 * byte for byte, which is what the evidence-hash contract (spec §6.3) rests on.
 *
 * `labelFor` is applied with an EMPTY label store HERE — every name below
 * resolves to a seed pattern or to `characterize`, never a persisted one, and
 * each row says which via `label.source`. That is not a v1 limitation left
 * unfixed: `usage-prompt-vocabulary.mjs`'s `labelFor` store branch depends on
 * nothing but a cluster's `key`, so re-checking the REAL persisted store
 * (W5, spec §6.3 enrichment) against these already-published rows afterward —
 * see that module's `withStoreLabel`, applied by `ak usage prompts`/the
 * dashboard — is exactly equivalent to having threaded it through from here.
 * Doing it post-hoc keeps this function, and `aggregate()`'s signature, free
 * of a disk read.
 */
function buildPromptPatterns(records, { cutoff, now }) {
  const fps = windowFingerprints(records, cutoff);
  const typed = fps.filter(isTypedFP);
  const clusters = crossSessionClusters(nearDupClusters(typed, { jaccard: PROMPT_CLUSTER_JACCARD }));
  const reAsks = reAskPairs(typed, { jaccard: PROMPT_REASK_JACCARD });
  return {
    corpus: { fingerprints: fps.length, typed: typed.length },
    provenance: promptProvenance(fps),
    tapLengths: promptTapLengths(typed),
    clusters: clusters.map(promptClusterRow),
    reAsks: {
      pairCount: reAsks.pairs.length,
      sessionCount: reAsks.sessions,
      gapHist: { ...reAsks.gaps },
    },
    exactRepeats: exactRepeatGroups(typed).map((g) => ({
      key: g.h, count: g.count, tokens: g.t,
      sessions: g.sessions.size, days: g.days.size, hosts: [...g.hosts],
    })),
    computedAt: new Date(now).toISOString(),
  };
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
      tokens: 0, cost: 0, cacheRead: 0, sessions: 0, sessionsActive: 0, exceptions: 0,
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
  // Kept alongside `tokens` so the day's cache share is readable without
  // re-deriving it from the session rows.
  d.cacheRead += row.cacheRead;
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
  const activeDays = new Set();
  for (const row of rec.usage) {
    acc.cacheSaved += cacheSavedFor(row, rec, deps, rates);
    foldSessionUsageRow(row, rec, deps, acc, byDay, byModel, activeDays);
  }
  for (const day of activeDays) byDay[day].sessionsActive++;
  return { ...acc, firstDay: firstBilledDay(rec) };
}

/**
 * The v11 posture, rhythm and context-window facts a session recorded (ADR-0038)
 * — every one a straight null-safe copy off the record. Carried on the row
 * rather than folded away because each is a per-session fact the transcript
 * actually observed, and the window's histograms have to be traceable back to
 * the sessions that built them. `mode`/`modeRaw`/`latHist`/`ctx*` stay
 * honest-absent (null) when nothing observed them; a zero there would read as a
 * measurement. `modeRaw` rides beside the normalized `mode` because the
 * taxonomy is a judgment call, and a reader checking it needs the evidence it
 * was made from. Split out of buildSessionRow to keep that projection under the
 * repo's complexity ceiling.
 */
function v11Projection(rec) {
  return {
    mode: rec.mode ?? null,
    modeRaw: rec.modeRaw ?? null,
    latHist: Array.isArray(rec.latHist) ? rec.latHist.slice() : null,
    latCount: rec.latCount ?? 0,
    lenSeconds: rec.lenSeconds ?? 0,
    ctxWindow: rec.ctxWindow ?? null,
    ctxLastTokens: rec.ctxLastTokens ?? null,
    aborts: rec.aborts ?? 0,
  };
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
    ...v11Projection(rec),
    // v16: what this session's operator actually typed. The underscore-prefixed
    // members are working material for the window fold (per-host lengths and
    // shape counts) and are stripped alongside `_span` once it is done.
    ...v16Projection(rec),
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
    // v16. `humanPrompts` above is main-thread PROMPT COUNTS; these two are the
    // narrower fingerprint-derived figures — turns whose provenance says a
    // person typed them, and the short ones among those. They are different
    // denominators on purpose and neither replaces the other.
    typedPrompts: 0, tapCount: 0,
  };
  const byHost = Object.create(null), byProvider = Object.create(null);
  const byMode = Object.create(null);
  const bySource = Object.create(null), byTool = Object.create(null);
  const byProject = Object.create(null);
  const byCategory = Object.create(null), punchcard = Object.create(null);
  const promptsByHost = Object.create(null), promptStatsByDay = Object.create(null);
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
    addTo(bucket(bySource, source), s);
    addTo(bucket(byProject, s.project), s);
    addTo(bucket(byCategory, s.category), s);
    foldSessionByModel(byModel, s);
    // Exceptions ride the SAME first-billed-day attribution as the session
    // count, so the reliability trend and the session trend are drawn from one
    // convention. A session that never billed has no day to attribute to and
    // contributes to neither — the same silence, not a different one.
    if (s._day && byDay[s._day]) {
      byDay[s._day].sessions++;
      byDay[s._day].exceptions += s.exceptions;
    }
    foldSessionPrompts(s, totals, promptsByHost, promptStatsByDay);
    for (const [k, n] of Object.entries(s._punchcard)) punchcard[k] = (punchcard[k] ?? 0) + n;
    for (const [k, n] of Object.entries(s.tools)) byTool[k] = (byTool[k] ?? 0) + n;
    foldSessionIntoTree(tree, s);
  }
  sealPromptHosts(promptsByHost);

  return {
    totals, byHost, byProvider, byMode, bySource, byTool,
    byProject, byCategory, punchcard, promptsByHost, promptStatsByDay,
    tree, spanMs, pricedCosts,
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
  // Null, not 0, when nothing was typed: a window with no typed prompt has no
  // tap share to report, and "0% of your prompts were taps" is a claim the
  // absence of data does not support.
  totals.tapShare = totals.typedPrompts ? round(totals.tapCount / totals.typedPrompts) : null;
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
 *  nothing".
 *
 *  `prompts: true` is the same pattern for the repetition projection
 *  (`agg.promptPatterns`, see buildPromptPatterns): opt-in because clustering
 *  the corpus costs real time on every scan and no default consumer needs it,
 *  and `null` rather than an empty projection when it was not asked for. Any
 *  caller adding an option here must also fold it into usage-index.mjs's
 *  `scanKey` — it decides both the single-flight identity and readIndex's memo,
 *  so an unfolded option lets a `{prompts:true}` caller be served an answer
 *  built without it. */
export function aggregate(records, { days, now, cutoff, deps, previous = false, prompts = false }) {
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
  const { totals, byHost, byProvider, byMode, bySource, byTool,
    byProject, byCategory, punchcard, promptsByHost, promptStatsByDay, tree } = folded;

  sealBuckets(byHost, byProvider, byProject, byCategory, byModel,
    byMode, bySource);
  finishTotals(totals, sessions, folded);
  const engagedByDay = buildEngagedByDay(sessions);
  const rhythm = buildRhythm(sessions);

  const projectTree = buildProjectTree(tree);
  for (const s of sessions) {
    delete s._span; delete s._active; delete s._punchcard; delete s._day; delete s._priced;
    delete s._typedTokens; delete s._questions; delete s._personas;
  }
  const codexRateLimits = buildCodexRateLimits(sessions);

  const agg = {
    generatedAt: new Date(now).toISOString(),
    windowDays: days,
    pricesAsOf: deps.pricesAsOf ?? null,
    totals, byDay, engagedByDay, byModel, byHost, byProvider,
    byMode, bySource, byTool,
    byProject, byCategory,
    // v16 prompt layer. `promptStatsByDay` is a SIBLING of byDay for the same
    // reason engagedByDay is: byDay's keys are billed days, and a prompt series
    // keyed on them would have to invent zero-token rows or drop real prompts.
    // `promptBaselines` reads `records` rather than `sessions` — it is about the
    // history BEFORE this window, which the display cutoff has already filtered
    // out of the rows.
    promptsByHost, promptStatsByDay,
    promptBaselines: buildPromptBaselines(records, { days, now }),
    // The repetition projection reads the DISPLAY window (`cutoff`), unlike
    // promptBaselines above, which deliberately reads the trailing window
    // BEFORE it. Same records, two different questions.
    promptPatterns: prompts ? buildPromptPatterns(records, { cutoff, now }) : null,
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
 *     (ccusage/ccusage#950). `reasoningOutput` goes with them — it is read
 *     off the SAME cumulative token_count snapshot (finalizeCodexUsage) and
 *     carries the same inflation, and leaving it made the session detail
 *     render a replayed "reasoning 412K (in out)" beside an output total the
 *     strip had just zeroed. The record itself stays visible/auditable.
 * Exported for test.
 */
export function applyCodexLedger(records, ledger) {
  if (!ledger || !(ledger.threads instanceof Map)) return records;
  return records.map((rec) => {
    if (!rec || rec.provider !== 'codex') return rec;
    const t = ledger.threads.get(rec.id);
    const fromEdges = ledger.parents instanceof Map && ledger.parents.has(rec.id) ? 'subagent' : null;
    const source = rec.threadSource ?? t?.threadSource ?? fromEdges;
    const stripped = !rec.usage.length && !rec.reasoningOutput;
    if (source === rec.threadSource && (source !== 'subagent' || stripped)) return rec;
    const out = { ...rec, threadSource: source };
    if (source === 'subagent') { out.usage = []; out.reasoningOutput = 0; }
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
