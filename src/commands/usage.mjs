// Explicit provider-account analytics refresh + offline cache status, plus an
// offline text scorecard (`score`) rendered from the SAME local-transcript
// aggregate `ak dashboard`'s Usage tab reads — no cost/token/percentile
// arithmetic is redone here; see the score section below for the boundary.
import fs from 'node:fs';
import path from 'node:path';
import { heading, info, ok, warn, dim } from '../lib/output.mjs';
import { configDir } from '../lib/paths.mjs';
import { readIndex, SCHEMA_VERSION } from '../lib/usage-index.mjs';
import {
  BASELINE_TRAILING_DAYS, LAT_BUCKET_EDGES, LEN_BUCKET_EDGES, TAP_MAX_TOKENS,
} from '../lib/usage-aggregate.mjs';
import {
  crossSessionClusters, nearDupClusters, reAskPairs, tapStats,
} from '../lib/usage-prompt-patterns.mjs';
import { labelFor } from '../lib/usage-prompt-vocabulary.mjs';
import { PROVENANCE_TAGS } from '../lib/usage-provenance.mjs';
import { MODES } from '../lib/usage-modes.mjs';
import {
  openRouterActivityFile,
  readOpenRouterActivity,
  refreshOpenRouterActivity,
} from '../lib/usage-openrouter.mjs';

export const options = {
  json: { type: 'boolean', default: false },
  'dry-run': { type: 'boolean', default: false },
  // Deliberately no default: `score` and `prompts` want DIFFERENT defaults (14
  // days vs all history — patterns are lifetime phenomena), and a default here
  // would make "the user asked for 14" indistinguishable from "nobody asked".
  window: { type: 'string' },
};

export const help = `ak usage — provider account analytics cache + offline scorecard summary

The local transcript scorecard remains automatic and offline in \`ak dashboard\`;
\`ak usage score\` prints an offline text summary of that same local evidence —
no network, no credentials. This command otherwise manages separately fetched
provider-account metadata. Provider analytics are never merged into
transcript-derived sessions, host totals, projects, or task attribution.

Usage:
  ak usage status
  ak usage refresh openrouter
  ak usage score [--window 7|14|30] [--json]
  ak usage prompts [--window 7|14|30|all] [--json]

Environment:
  OPENROUTER_MANAGEMENT_KEY   required only for refresh; an inference key is
                              intentionally not accepted

Options:
  --json      emit machine-readable output (cache status/result, or the score/prompts projection)
  --dry-run   describe an OpenRouter refresh without network or writes
  --window N  score: 7, 14, or 30 days (default 14)
              prompts: 7, 14, 30, or all (default all — patterns are lifetime
              phenomena, so the whole retained corpus is the honest default)

Examples:
  ak usage status                    inspect the offline cache; no network
  ak usage refresh openrouter        explicitly fetch the last 30 completed UTC days
  ak usage status --json             print the normalized credential-free cache
  ak usage score                     offline scorecard summary, last 14 days
  ak usage score --window 30 --json  machine-readable scorecard projection
  ak usage prompts                   what you type, over all retained history
  ak usage prompts --window 30       the same report, last 30 days only`;

function summary(value) {
  if (!value) return null;
  return {
    provider: value.provider,
    source: value.source,
    fetchedAt: value.fetchedAt,
    coverage: value.coverage,
    totals: value.totals,
    models: value.byModel?.length ?? 0,
    upstreamProviders: value.byProvider?.length ?? 0,
  };
}

// ── score: offline text scorecard over the dashboard's own aggregate ───────
// `readIndex`/`buildIndex` (usage-index.mjs) already compute everything the
// dashboard's Usage tab renders; this section is RENDERING ONLY. The one
// exception is a handful of display-ready ratios the aggregate does not ship
// as fields (active-day counts, cache-read share) — the browser client
// derives those the same way, client-side, from the identical payload (see
// src/lib/dashboard/client/usage.mjs's renderScoreHero/cadenceCells). The
// formatters below restate that file's fmtUsd/fmtSecs/fmtAtLeast family in
// Node because that file is a browser bundle read as TEXT into a served page
// (never node-imported — see its own header comment) and so cannot be
// imported here.

const SCORE_WINDOWS = [7, 14, 30];
const LAT_OVERFLOW = LAT_BUCKET_EDGES[LAT_BUCKET_EDGES.length - 1];
const LEN_OVERFLOW = LEN_BUCKET_EDGES[LEN_BUCKET_EDGES.length - 1];
const ZERO_BUCKET = { sessions: 0, cost: 0 };

function parseScoreWindow(raw) {
  const n = Number(raw);
  return SCORE_WINDOWS.includes(n) ? n : null;
}

function fmtUsd(n) {
  const v = Number(n) || 0;
  if (v >= 1000) return `$${Math.round(v).toLocaleString()}`;
  if (v >= 10) return `$${v.toFixed(0)}`;
  return `$${v.toFixed(2)}`;
}

// A positive figure that rounds away at two decimals is not $0.00 — folding
// it in there reads as "this cost nothing", a different and false claim from
// "this cost less than a cent". A true zero is left alone: it is not less
// than a cent, it is nothing.
function fmtUsdMin(n) {
  const v = Number(n) || 0;
  const txt = fmtUsd(v);
  return v > 0 && txt === '$0.00' ? '<$0.01' : txt;
}

function fmtNum(n) { return (Number(n) || 0).toLocaleString(); }

function fmtTok(n) {
  const v = Number(n) || 0;
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return String(Math.round(v));
}

function fmtHours(sec) {
  const h = (Number(sec) || 0) / 3600;
  return `${h >= 10 ? Math.round(h) : h.toFixed(1)}h`;
}

function fmtMins(m) {
  const v = Number(m) || 0;
  return v >= 60 ? `${Math.round(v / 60)}h` : `${Math.round(v)}m`;
}

function fmtRatio(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  return Math.abs(n) >= 10 ? String(Math.round(n)) : n.toFixed(1);
}

// <=60, not <60: the latency histogram's overflow bucket floor IS 60s, and
// that value has to read "60s" — the edge the reader can see — rather than
// rolling up to "1m" and renaming the boundary.
function fmtSecs(sec) {
  const s = Number(sec) || 0;
  if (s <= 60) return `${s < 10 ? Math.round(s * 10) / 10 : Math.round(s)}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  const h = Math.round(s / 360) / 10;
  return `${h % 1 === 0 ? String(h) : h.toFixed(1)}h`;
}

// A value from a histogram's overflow bucket has no upper edge to
// interpolate towards, so the percentile that landed in it reports that
// bucket's FLOOR — prefixed "≥" so it reads "at least this". Null is
// rendered 'no samples', never a bare dash: this is a text report, and
// "nothing was measured" is a different, more honest claim than a blank.
function fmtAtLeast(v, lastEdge) {
  if (v == null || !Number.isFinite(v)) return 'no samples';
  return `${v >= lastEdge ? '≥' : ''}${fmtSecs(v)}`;
}

// Signed change vs the previous equal-length window; '' when there is none to
// compare against (prev null/0 — an unmeasurable baseline claims nothing). A
// magnitude that rounds away is reported flat rather than claiming a
// direction the printed number does not support.
function fmtDelta(curr, prev, { unit = '%' } = {}) {
  if (prev == null || prev === 0) return '';
  const c = Number(curr) || 0;
  const p = Number(prev) || 0;
  const delta = c - p;
  const mag = unit === 'pp'
    ? Math.round(Math.abs(delta) * 10) / 10
    : Math.round(Math.abs((delta / p) * 100));
  if (mag === 0) return '  •flat vs prev';
  const arrow = delta > 0 ? '▲' : '▼';
  return `  ${arrow}${mag}${unit === 'pp' ? ' pp' : '%'} vs prev`;
}

function printScoreHero(agg, windowDays) {
  const t = agg.totals ?? {};
  const p = agg.previous?.totals ?? null;
  heading(`ak usage — scorecard (last ${windowDays}d)`);
  info(`SESSIONS               ${fmtNum(t.sessions)}  `
    + `${dim(`${fmtNum(t.responses)} assistant turns`)}${fmtDelta(t.sessions, p?.sessions)}`);
  info(`API-EQUIVALENT         ${fmtUsd(t.cost)}  `
    + `${dim('list price · not plan billing')}${fmtDelta(t.cost, p?.cost)}`);
  info(`TOKENS                 ${fmtTok(t.tokens)}  `
    + `${dim(`${fmtTok(t.output)} out · ${fmtTok(t.cacheRead)} cached`)}${fmtDelta(t.tokens, p?.tokens)}`);
  info(`ENGAGED TIME           ${fmtHours(t.engagedSeconds)}  `
    + `${dim(`${fmtMins(t.spanMinutes)} summed · sessions overlap`)}${fmtDelta(t.engagedSeconds, p?.engagedSeconds)}`);
  const tokens = Number(t.tokens) || 0;
  const cacheShare = tokens ? (Number(t.cacheRead) / tokens) * 100 : 0;
  const prevTokens = Number(p?.tokens) || 0;
  const prevCacheShare = p && prevTokens ? (Number(p.cacheRead) / prevTokens) * 100 : null;
  const saved = Number(t.cacheSavedUsd) || 0;
  const savedNote = saved > 0 ? ` · saved ≈ ${fmtUsd(saved)} vs uncached` : '';
  info(`CACHE READ             ${cacheShare.toFixed(1)}%  `
    + `${dim(`priced at 0.1× input${savedNote}`)}${fmtDelta(cacheShare, prevCacheShare, { unit: 'pp' })}`);
}

function printScoreCadence(agg) {
  const t = agg.totals ?? {};
  const active = Object.keys(agg.byDay ?? {}).length;
  heading('Cadence');
  const perDay = active ? (Number(t.sessions) || 0) / active : null;
  // byDay's presence contract is BILLED days, which is why the aggregate keeps
  // a separate engagedByDay map — the two sets genuinely differ. The browser
  // judged that surprising enough for a three-line tooltip; a terminal reader
  // has nothing to hover, so it goes inline.
  info(`SESSIONS / ACTIVE DAY   ${perDay == null ? '—' : fmtRatio(perDay)}  `
    + dim(`${fmtNum(active)} day${active === 1 ? '' : 's'} that billed tokens · includes subagent sessions`));
  const auto = t.responsesPerPrompt ?? null;
  const touch = t.humanPromptsPerHour ?? null;
  const autoNote = auto == null ? 'no prompts you typed in window'
    : (touch == null ? 'touch rate not recorded' : `${fmtRatio(touch)} prompts / engaged hour`);
  info(`AUTONOMY                ${auto == null ? '—' : `${fmtRatio(auto)}×`}  ${dim(autoNote)}`);
  const med = t.costPerSessionMedian ?? null;
  const p90 = t.costPerSessionP90 ?? null;
  const costNote = med == null ? 'no priced sessions in window' : `median · P90 ${p90 == null ? '—' : fmtUsdMin(p90)}`;
  info(`COST / SESSION          ${med == null ? '—' : fmtUsdMin(med)}  ${dim(costNote)}`);
  const perHour = t.costPerEngagedHour ?? null;
  info(`COST / ENGAGED HOUR     ${perHour == null ? '—' : fmtUsd(perHour)}  `
    + dim(perHour == null ? 'no engaged time measured' : 'engaged time, not wall clock'));
}

function printScoreRhythm(agg) {
  const r = agg.rhythm ?? {};
  heading('Your rhythm — session length · response latency');
  info(`SESSION LENGTH          median ${fmtAtLeast(r.lenMedianSeconds, LEN_OVERFLOW)}  `
    + dim(`P90 ${fmtAtLeast(r.lenP90Seconds, LEN_OVERFLOW)}`));
  info(`RESPONSE LATENCY        p50 ${fmtAtLeast(r.latP50, LAT_OVERFLOW)}  `
    + dim(`p95 ${fmtAtLeast(r.latP95, LAT_OVERFLOW)} · n ${fmtNum(r.latCount)}`));
}

/** Shared renderer for the posture table: `keys` decides the row set and
 *  order, defaulting an absent bucket to zero — so a table always shows
 *  every row the caller asks for (including 'not-recorded'), never only the
 *  rows that happened to have data. */
function printBucketTable(title, map, keys) {
  heading(title);
  for (const key of keys) {
    const b = map[key] ?? ZERO_BUCKET;
    const n = Number(b.sessions) || 0;
    info(`${key.padEnd(16)} ${fmtNum(n)} session${n === 1 ? '' : 's'}  ${dim(fmtUsd(b.cost))}`);
  }
}

function printScoreModeTable(agg) {
  printBucketTable('Mode — permission posture', agg.byMode ?? {}, [...MODES, 'not-recorded']);
}

function printScoreReliability(agg) {
  heading('Reliability — turns that never landed');
  const t = agg.totals ?? {};
  const responses = Number(t.responses) || 0;
  const exceptions = Number(t.exceptions) || 0;
  const aborts = Number(t.aborts) || 0;
  const rate = responses ? (exceptions / responses) * 1000 : null;
  const line = `EXCEPTIONS / 1K RESPONSES   ${rate == null ? 'no samples' : rate.toFixed(1)}  `
    + dim(`${fmtNum(exceptions)} of ${fmtNum(responses)} responses`);
  if (rate == null) info(line);
  else if (exceptions > 0) warn(line);
  else ok(line);
  // Codex-only evidence: turn_aborted is the only interrupt signal any host
  // writes, so a window with no codex sessions has nothing that COULD have
  // recorded one. Rendering 0 there would read as "you never interrupted a
  // turn" — the browser carries the same rule, and a terminal reader has no
  // tooltip to correct it with.
  const codex = agg.byHost?.codex ?? null;
  const codexSessions = Number(codex?.sessions) || 0;
  const codexResponses = Number(codex?.responses) || 0;
  const abortNote = codexSessions
    ? (codexResponses
      ? `interrupted mid-flight — codex only, ${fmtRatio((aborts / codexResponses) * 1000)} per 1k codex responses`
      : 'interrupted mid-flight — codex only; no codex responses in window')
    : 'not recorded — only codex transcripts carry an interrupt signal, and this window has none';
  info(`ABORTED TURNS               ${codexSessions ? fmtNum(aborts) : '—'}  ${dim(abortNote)}`);
}

/** The --json shape: an ADDITIVE, credential-free, offline projection of the
 *  same aggregate the text report renders from — verbatim fields, no
 *  reshaping, so a consumer diffing this against the dashboard's /api/usage
 *  payload sees the identical totals/rhythm/byMode/bySource.
 *
 *  `promptBaselines` is the one field here the TEXT report does not print. It
 *  is included because it is the only observable evidence that the widened
 *  lookback below actually reached the trailing history: a baseline is a
 *  percentile over days that must have been read off disk, so a null one is
 *  how a too-narrow lookback shows up. Counts and shares only — no hash, no
 *  session id, no prompt-derived text. */
function scoreProjection(agg, windowDays) {
  return {
    window: windowDays,
    totals: agg.totals,
    rhythm: agg.rhythm,
    byMode: agg.byMode,
    bySource: agg.bySource,
    promptBaselines: agg.promptBaselines,
    previous: agg.previous,
  };
}

async function runScore({ flags, deps }) {
  const windowDays = parseScoreWindow(flags.window ?? '14');
  if (windowDays == null) {
    warn(`ak usage score: --window must be 7, 14, or 30 (got ${JSON.stringify(flags.window)})`);
    return 2;
  }
  const readAgg = deps.readIndex ?? readIndex;
  let agg;
  try {
    // lookbackDays widens what usage-index.mjs reads off disk so records from
    // BEFORE this window survive to be aggregated; previous:true is what turns
    // the nearest of those into agg.previous. This window's own
    // totals/sessions stay exactly `windowDays` wide either way (the aggregate
    // filters them at its own display cutoff).
    //
    // The width is `windowDays + BASELINE_TRAILING_DAYS`, not `windowDays * 2`.
    // Two consumers read history here and they need different depths: the
    // previous-window projection needs one extra window, but the personal
    // tap-share baseline is a percentile over the 90 days immediately BEFORE
    // the displayed one (usage-aggregate.buildPromptBaselines), and it needs
    // BASELINE_MIN_ACTIVE_DAYS of them before it will claim a normal at all.
    // At `* 2` a 14-day report read 28 days, so the baseline was structurally
    // null on any corpus — and a detector specified to compare against the
    // operator's own history silently fell back to an absolute threshold. The
    // wider figure is a strict superset for every supported window (7/14/30),
    // so `previous` is unaffected.
    agg = await readAgg({
      days: windowDays,
      lookbackDays: windowDays + BASELINE_TRAILING_DAYS,
      previous: true,
    });
  } catch (error) {
    const message = String(error?.message ?? error);
    if (flags.json) console.log(JSON.stringify({ window: windowDays, error: message }, null, 2));
    else warn(message);
    return 1;
  }
  if (flags.json) {
    console.log(JSON.stringify(scoreProjection(agg, windowDays), null, 2));
    return 0;
  }
  printScoreHero(agg, windowDays);
  printScoreCadence(agg);
  printScoreRhythm(agg);
  printScoreModeTable(agg);
  printScoreReliability(agg);
  return 0;
}

// ── prompts: what you actually type, read from fingerprints ────────────────
// The Prompts view's CLI companion (spec §3.3). Everything in this section is
// derived from the per-prompt FINGERPRINTS the scan path persists — a hash of
// the normalized text, a token count, a bounded token-hash sketch, a
// provenance tag and two shape flags (spec §2.2). No prompt text is read, and
// none is printed: the deep pass below is the one place text appears, and it
// re-reads the transcripts on demand to get it.
//
// WHERE THE FINGERPRINTS COME FROM, stated plainly because it is the one
// unobvious coupling here. The aggregate publishes prompt COUNTS
// (totals.typedPrompts/tapCount, promptsByHost, promptStatsByDay,
// promptBaselines) but not the fingerprints themselves — `records` never
// leaves usage-index.mjs's scan(), and a session row carries only the folded
// per-session projection. The index CACHE is therefore the only place the
// fingerprint layer is readable from, so this section calls readIndex first
// (which rescans and rewrites that cache, so it is never read stale) and then
// reads the cache it just wrote. If a supported accessor ever lands on
// usage-index.mjs, `readPromptRecords` is the single call site to move.

const PROMPT_WINDOWS = ['7', '14', '30', 'all'];

/** "All history" in days. The index prunes any cache entry whose last activity
 *  is older than 366 days (usage-index.mjs's KEEP_MS) and the dashboard clamps
 *  every queryable window at 365, so 365 days IS all the history this corpus
 *  can hold — not an arbitrary ceiling standing in for infinity. */
const ALL_WINDOW_DAYS = 365;

/** The clustering threshold the view ships at (spec §3.2 panel 3), looser than
 *  the pattern library's own 0.8 default on purpose: phrasing variance is the
 *  signal. Eleven wordings of one request outrank eleven identical ones,
 *  because eleven wordings prove there is no canonical form to point at. */
const CLUSTER_JACCARD = 0.6;

/** Re-asks keep the research's tighter 0.8 (findings §5.1). A re-ask is "I said
 *  the same thing again because that didn't work", which is a claim about near
 *  sameness; the loose threshold above would count a follow-up as a repeat. */
const REASK_JACCARD = 0.8;

const TOP_CLUSTERS = 15;
const TOP_TAP_LENGTHS = 8;

/** @returns {{ label: string|number, days: number }|null} */
function parsePromptWindow(raw) {
  const value = String(raw ?? 'all');
  if (!PROMPT_WINDOWS.includes(value)) return null;
  return value === 'all'
    ? { label: 'all', days: ALL_WINDOW_DAYS }
    : { label: Number(value), days: Number(value) };
}

function promptCacheFile() { return path.join(configDir(), 'usage-index.json'); }

/** Parsed session records from the index cache, or `[]` for any reason at all
 *  (absent, corrupt, or written by a different schema). An empty corpus is a
 *  reportable state here — "nothing was measured" — not an error. */
function readPromptRecords(cacheFile) {
  try {
    const raw = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (raw?.schemaVersion !== SCHEMA_VERSION || !raw.entries) return [];
    return Object.values(raw.entries).map((e) => e?.session).filter(Boolean);
  } catch {
    return [];
  }
}

/** The day a record's tokens FIRST billed on — the attribution `byDay` and
 *  `promptStatsByDay` already use, restated here because the aggregate keeps
 *  it private and a prompt series keyed any other way would not line up with
 *  the per-day figures printed beside it. `null` when the record never billed. */
function firstBilledDay(rec) {
  let first = null;
  for (const row of rec.usage ?? []) if (first === null || row.day < first) first = row.day;
  return first;
}

/**
 * Every stored fingerprint in the window, decorated with WHERE it happened —
 * the input shape usage-prompt-patterns.mjs documents.
 *
 * TWO CONVERSIONS, both load-bearing. The scan path stores `q`/`o` as the
 * number 1 and OMITS them when false (usage-parsers.promptShape); the pattern
 * library reads them as booleans and treats ABSENT as "nobody classified this"
 * (usage-prompt-patterns.buildCluster). Passed through unchanged, every
 * cluster would report class `unknown` and zero personas — silently disabling
 * the type split, the persona seed, and three of the four seed patterns. An
 * absent flag here means "measured, and not that shape", because the cache is
 * schema-gated: every record in it was written by the current parser, which
 * always decides both flags.
 *
 * The record gate matches the aggregate's own (`!rec.responses` is not a
 * session; `rec.end < cutoff` is outside the window), so the counts here and
 * the counts the aggregate publishes are taken over the same population.
 */
function decoratedFingerprints(records, cutoffMs) {
  const out = [];
  for (const rec of records) {
    if (!rec?.responses || !Array.isArray(rec.promptFPs)) continue;
    if (rec.end == null || rec.end < cutoffMs) continue;
    const day = firstBilledDay(rec);
    const host = rec.host ?? rec.provider ?? 'unknown';
    for (const fp of rec.promptFPs) {
      out.push({ ...fp, q: fp.q === 1, o: fp.o === 1, sessionId: rec.id, day, host });
    }
  }
  return out;
}

// ── prompt formatters ───────────────────────────────────────────────────────

/** A share as a percentage, or the honest absence. `null` reaches here from
 *  every aggregate field whose denominator was empty, and printing 0.0% there
 *  would claim a measurement nobody made. */
function fmtShare(n) {
  return n == null || !Number.isFinite(n) ? 'no samples' : `${(n * 100).toFixed(1)}%`;
}

/** A count that may not exist. Distinguished from `fmtNum` so a genuine zero
 *  ("measured, and it was none") still prints as 0. */
function fmtMaybe(n) {
  return n == null || !Number.isFinite(n) ? 'not measured' : fmtNum(n);
}

/** One fixed-width table row: `[text, width]` pads right, `[text, width, true]`
 *  pads left for a numeric column. */
function tableRow(cells) {
  return cells
    .map(([text, width, right]) => (right ? String(text).padStart(width) : String(text).padEnd(width)))
    .join('  ')
    .trimEnd();
}

// ── prompt sections ─────────────────────────────────────────────────────────

/** Counts per provenance tag over the whole fingerprinted population — the
 *  denominator every other figure sits behind (spec §2.1). Every tag in the
 *  vocabulary gets a row, including the ones this corpus never produced: a
 *  missing tag is evidence about the corpus, not a row to drop. */
function provenanceSplit(fps) {
  const counts = Object.create(null);
  for (const tag of PROVENANCE_TAGS) counts[tag] = 0;
  let other = 0;
  for (const fp of fps) {
    if (Object.hasOwn(counts, fp.p)) counts[fp.p]++;
    else other++;
  }
  return other ? { ...counts, unrecognized: other } : counts;
}

function printTypedPrompts(fps, typed) {
  heading('Typed prompts');
  const split = provenanceSplit(fps);
  const share = fps.length ? typed.length / fps.length : null;
  info(`TYPED                   ${fmtNum(typed.length)}  `
    + dim(`${fmtShare(share)} of ${fmtNum(fps.length)} fingerprinted prompt turns`));
  info(`  provenance            ${Object.entries(split).map(([k, v]) => `${k} ${fmtNum(v)}`).join(' · ')}`);
  const questions = typed.filter((f) => f.q === true).length;
  info(`QUESTIONS               ${fmtNum(questions)}  `
    + dim(`${fmtShare(typed.length ? questions / typed.length : null)} of typed · the rest are instructions and statements`));
  const personas = typed.filter((f) => f.o === true).length;
  info(`PERSONA OPENERS         ${fmtNum(personas)}  `
    + dim('role assignments ("you are a…") typed by hand'));
  if (!fps.length) {
    info(dim('  no samples — no session in this window carries the fingerprint layer'));
  }
}

/** Tap counts grouped by TOKEN LENGTH. This tier has no text, so "the top
 *  taps" can only be a length distribution — which is the honest shape of the
 *  question at this tier, and the deep pass prints the verbatim table. */
function tapLengthRows(fps, maxTokens) {
  const byLen = new Map();
  for (const fp of fps) {
    const t = Number(fp.t);
    if (!Number.isFinite(t) || t > maxTokens) continue;
    const r = byLen.get(t) ?? { tokens: t, prompts: 0, sessions: new Set(), days: new Set(), hosts: new Set() };
    r.prompts++;
    if (fp.sessionId) r.sessions.add(fp.sessionId);
    if (fp.day) r.days.add(fp.day);
    if (fp.host) r.hosts.add(fp.host);
    byLen.set(t, r);
  }
  return [...byLen.values()].sort((a, b) => b.prompts - a.prompts || a.tokens - b.tokens);
}

function printTaps(taps, lengths) {
  heading('Supervision taps');
  info(`TAPS                    ${fmtNum(taps.taps)}  `
    + dim(`${fmtShare(taps.prompts ? taps.share : null)} of typed · ${taps.maxTokens} normalized tokens or fewer`));
  info(dim('  what this does not model: whether the tap was necessary. Some are legitimate approvals.'));
  if (!lengths.length) {
    info(dim('  no samples'));
    return;
  }
  info(dim(tableRow([['tokens', 6, true], ['prompts', 8, true], ['sessions', 8, true], ['days', 5, true], ['hosts', 20]])));
  for (const r of lengths.slice(0, TOP_TAP_LENGTHS)) {
    info(tableRow([
      [r.tokens, 6, true], [fmtNum(r.prompts), 8, true], [fmtNum(r.sessions.size), 8, true],
      [fmtNum(r.days.size), 5, true], [[...r.hosts].sort().join('+') || '—', 20],
    ]));
  }
}

/** Per-host, per-month typed/tap counts folded out of `promptStatsByDay` — the
 *  divergence the research measured (Claude 16.8→12.5% against Codex
 *  7.7→15.2%) is a monthly series, and the day series is what the aggregate
 *  publishes. */
function monthlyTapShare(statsByDay) {
  const rows = new Map();
  for (const [day, d] of Object.entries(statsByDay ?? {})) {
    const month = day.slice(0, 7);
    for (const [host, h] of Object.entries(d.byHost ?? {})) {
      const key = `${host}${month}`;
      const row = rows.get(key) ?? { host, month, typed: 0, taps: 0 };
      row.typed += Number(h.typed) || 0;
      row.taps += Number(h.taps) || 0;
      rows.set(key, row);
    }
  }
  return [...rows.values()]
    .map((r) => ({ ...r, share: r.typed ? r.taps / r.typed : null }))
    .sort((a, b) => (a.host < b.host ? -1 : a.host > b.host ? 1 : 0) || (a.month < b.month ? -1 : 1));
}

/** The personal baseline is a percentile over the 90 days BEFORE the displayed
 *  window, so at the all-history window there is no window before this one for
 *  it to be taken over. That is a structural `n/a`, not a data gap, and it must
 *  not print as "no samples" — which would read as "we looked and found
 *  nothing" about a question that was never askable. */
function baselineCell(agg, host, win) {
  if (win.label === 'all') return 'n/a';
  return fmtShare(agg.promptBaselines?.[host]?.tapShareP75_trailing90d ?? null);
}

function printHostInterplay(agg, win) {
  heading('Host interplay');
  const hosts = Object.entries(agg.promptsByHost ?? {});
  if (!hosts.length) {
    info(dim('  no samples — no host in this window carries a typed prompt'));
    return;
  }
  info(dim(tableRow([['host', 10], ['typed', 7, true], ['taps', 6, true], ['tap share', 10, true],
    ['p90 tokens', 12, true], ['personas', 9, true], ['your p75', 10, true]])));
  for (const [host, s] of hosts.sort()) {
    info(tableRow([
      [host, 10], [fmtNum(s.typed), 7, true], [fmtNum(s.taps), 6, true], [fmtShare(s.tapShare), 10, true],
      [fmtMaybe(s.p90TypedTokens), 12, true], [fmtNum(s.personaOpeners), 9, true],
      [baselineCell(agg, host, win), 10, true],
    ]));
  }
  info(dim('  "your p75" is this host\'s own trailing-90d daily tap share — the operator\'s normal,'));
  info(dim('  not a fixed target. Windows are unequal per host, so compare a host to itself.'));
  if (win.label === 'all') {
    info(dim('  n/a at the all-history window: a trailing baseline needs a window before this one.'));
  }
  const months = monthlyTapShare(agg.promptStatsByDay);
  if (!months.length) return;
  info(dim('  monthly tap share — the direction each host is moving in'));
  info(dim(tableRow([['host', 10], ['month', 8], ['typed', 7, true], ['taps', 6, true], ['tap share', 10, true]])));
  for (const r of months) {
    info(tableRow([[r.host, 10], [r.month, 8], [fmtNum(r.typed), 7, true], [fmtNum(r.taps), 6, true],
      [fmtShare(r.share), 10, true]]));
  }
}

/** A cluster reduced to the row the panel renders: its curated-or-derived name,
 *  where that name came from, and the span it covers. */
function clusterRow(cluster) {
  const label = labelFor(cluster);
  return {
    key: cluster.key,
    name: label.name,
    labelSource: label.source,
    seed: label.seed,
    size: cluster.size,
    sessions: cluster.sessions.size,
    days: cluster.days.size,
    hosts: [...cluster.hosts].sort(),
    class: cluster.class,
    tokens: cluster.tokens,
    personas: cluster.personas,
  };
}

function printClusters(rows) {
  heading('Recurring clusters');
  info(dim(`  near-duplicates at Jaccard ≥ ${CLUSTER_JACCARD}, kept when they span 3+ sessions or 2+ days`));
  if (!rows.length) {
    info(dim('  no samples'));
    return;
  }
  info(dim(tableRow([['pattern', 42], ['n', 4, true], ['sess', 5, true], ['days', 5, true],
    ['tok', 5, true], ['class', 12], ['source', 14]])));
  for (const r of rows.slice(0, TOP_CLUSTERS)) {
    info(tableRow([
      [r.name.length > 42 ? `${r.name.slice(0, 41)}…` : r.name, 42],
      [fmtNum(r.size), 4, true], [fmtNum(r.sessions), 5, true], [fmtNum(r.days), 5, true],
      [fmtMaybe(r.tokens?.median), 5, true], [r.class, 12], [r.labelSource, 14],
    ]));
  }
}

function printReAsks(reAsks) {
  heading('Re-asks');
  info(dim('  the same thing asked twice inside one session, within six turns'));
  if (!reAsks.pairs.length) {
    info(dim('  no samples'));
    return;
  }
  info(`PAIRS                   ${fmtNum(reAsks.pairs.length)}  `
    + dim(`across ${fmtNum(reAsks.sessions)} session${reAsks.sessions === 1 ? '' : 's'}`));
  const gaps = Object.entries(reAsks.gaps).sort((a, b) => Number(a[0]) - Number(b[0]));
  info(`GAP DISTRIBUTION        ${gaps.map(([gap, n]) => `${gap} turn${gap === '1' ? '' : 's'} → ${n}`).join(' · ')}`);
  const immediate = Number(reAsks.gaps[1]) || 0;
  info(dim(`  ${fmtShare(immediate / reAsks.pairs.length)} land one turn apart — the immediately preceding response is what failed`));
}

/** Sessions that typed nothing at all: subagents, hooks and scheduled work.
 *  Sessions with no fingerprint layer are excluded from BOTH halves of the
 *  fraction — "unknowable" is not "headless" — which is the same rule the
 *  headless-share detector applies. */
function headlessShare(sessions) {
  const classified = (sessions ?? []).filter((s) => Number.isFinite(s.typedPrompts));
  const responses = classified.reduce((n, s) => n + (Number(s.responses) || 0), 0);
  const headless = classified.filter((s) => Number(s.typedPrompts) === 0);
  const headlessResponses = headless.reduce((n, s) => n + (Number(s.responses) || 0), 0);
  return {
    sessions: classified.length,
    headlessSessions: headless.length,
    responses,
    headlessResponses,
    share: responses > 0 ? headlessResponses / responses : null,
  };
}

function printHeadless(h) {
  heading('Headless share');
  info(`RESPONSES UNWATCHED     ${fmtShare(h.share)}  `
    + dim(`${fmtNum(h.headlessResponses)} of ${fmtNum(h.responses)} responses, from ${fmtNum(h.headlessSessions)} of ${fmtNum(h.sessions)} classified sessions`));
  info(dim('  a reframe, not a criticism: this is the share of the bill that rides on briefs'));
  info(dim('  rather than on steering. Sessions with no fingerprint layer are in neither half.'));
}

/** Everything the aggregate tier computes, in one pass, so the text report and
 *  the --json projection are provably the same numbers. */
function promptReport(agg, fps, win) {
  const typed = fps.filter((f) => f.p === 'human');
  const clusters = crossSessionClusters(nearDupClusters(typed, { jaccard: CLUSTER_JACCARD }));
  const reAsks = reAskPairs(typed, { jaccard: REASK_JACCARD });
  return {
    win,
    fps,
    typed,
    taps: tapStats(typed, { maxTokens: TAP_MAX_TOKENS }),
    tapLengths: tapLengthRows(typed, TAP_MAX_TOKENS),
    clusters: clusters.map(clusterRow),
    reAsks,
    headless: headlessShare(agg.sessions),
  };
}

/** The --json shape: fingerprint-derived only — hashes, counts, token counts,
 *  shares and host names. No prompt text exists at this tier to leak. */
function promptProjection(agg, r) {
  return {
    window: r.win.label,
    windowDays: r.win.days,
    generatedAt: agg.generatedAt,
    corpus: { fingerprints: r.fps.length, typed: r.typed.length, sessions: agg.totals?.sessions ?? 0 },
    typed: {
      total: r.typed.length,
      byProvenance: provenanceSplit(r.fps),
      questions: r.typed.filter((f) => f.q === true).length,
      personaOpeners: r.typed.filter((f) => f.o === true).length,
    },
    taps: {
      taps: r.taps.taps, prompts: r.taps.prompts, share: r.taps.prompts ? r.taps.share : null,
      maxTokens: r.taps.maxTokens, byHost: r.taps.byHost,
      byLength: r.tapLengths.map((t) => ({
        tokens: t.tokens, prompts: t.prompts,
        sessions: t.sessions.size, days: t.days.size, hosts: [...t.hosts].sort(),
      })),
    },
    hosts: {
      byHost: agg.promptsByHost ?? {},
      baselines: agg.promptBaselines ?? {},
      monthlyTapShare: monthlyTapShare(agg.promptStatsByDay),
    },
    clusters: r.clusters,
    reAsks: { pairs: r.reAsks.pairs.length, sessions: r.reAsks.sessions, gaps: r.reAsks.gaps },
    headless: r.headless,
  };
}

function printPromptReport(agg, r) {
  heading(`ak usage — prompts (${r.win.label === 'all' ? 'all history' : `last ${r.win.days}d`})`);
  info(dim('every figure below is derived from prompt fingerprints — no prompt text is read or stored'));
  printTypedPrompts(r.fps, r.typed);
  printTaps(r.taps, r.tapLengths);
  printHostInterplay(agg, r.win);
  printClusters(r.clusters);
  printReAsks(r.reAsks);
  printHeadless(r.headless);
}

async function runPrompts({ flags, deps }) {
  const win = parsePromptWindow(flags.window);
  if (win == null) {
    warn(`ak usage prompts: --window must be 7, 14, 30, or all (got ${JSON.stringify(flags.window)})`);
    return 2;
  }
  const readAgg = deps.readIndex ?? readIndex;
  let agg;
  try {
    // Same widening as `score`, for the same reason: the per-host tap-share
    // baseline printed beside each host is a percentile over the 90 days
    // before this window, and it can only be built from records that were read.
    agg = await readAgg({ days: win.days, lookbackDays: win.days + BASELINE_TRAILING_DAYS });
  } catch (error) {
    const message = String(error?.message ?? error);
    if (flags.json) console.log(JSON.stringify({ window: win.label, error: message }, null, 2));
    else warn(message);
    return 1;
  }
  // Read AFTER readIndex, which rewrites this file as its last act before
  // aggregating — so the fingerprints below are the same corpus the counts
  // above were folded from, never a stale one.
  const cutoffMs = Date.parse(agg.generatedAt) - win.days * 86_400_000;
  // NOT `deps.cacheFile` — that name is already taken by the OpenRouter
  // activity cache this command also manages, and they are different files.
  const fps = decoratedFingerprints(readPromptRecords(deps.indexCacheFile ?? promptCacheFile()), cutoffMs);
  const report = promptReport(agg, fps, win);
  if (flags.json) {
    console.log(JSON.stringify(promptProjection(agg, report), null, 2));
    return 0;
  }
  printPromptReport(agg, report);
  return 0;
}

// Exported ONLY for a direct-import unit test of the <$0.01 boundary
// (true-zero vs a real sub-cent positive) — see tests/kit/usage-cli.test.mjs.
// Constructing a SECOND fixture transcript whose priced total is exactly
// zero is disproportionate: a session prices to exactly $0 only by carrying
// no usage rows at all, which the aggregate's own cost distribution already
// excludes (see usage-aggregate.mjs's `_priced`), so there is no fixture
// shape that reaches the true-zero branch. Not part of this command's CLI
// contract.
export const __test = { fmtUsdMin };

/** `ak usage status` — a pure offline read of the OpenRouter activity cache. */
function runOpenRouterStatus({ flags, cacheFile, read }) {
  const value = read({ cacheFile });
  if (flags.json) {
    console.log(JSON.stringify({ cacheFile, openrouter: value }, null, 2));
    return 0;
  }
  heading('ak usage — offline provider analytics');
  if (!value) {
    info('OpenRouter: no local activity cache.');
    info('Refresh explicitly: ak usage refresh openrouter');
    return 0;
  }
  const t = value.totals;
  ok(`OpenRouter cache: ${value.fetchedAt}`);
  info(`${t.requests} requests · ${t.promptTokens + t.completionTokens} tokens · `
    + `${value.byModel.length} model(s) · ${value.byProvider.length} upstream provider(s)`);
  info(dim('account-level only · never merged into local session or host totals'));
  return 0;
}

/** `ak usage refresh openrouter` — the one named network request this command
 *  owns, and its --dry-run plan. */
async function runOpenRouterRefresh({ flags, cacheFile, refresh }) {
  if (flags['dry-run']) {
    const plan = {
      dryRun: true,
      action: 'refresh',
      provider: 'openrouter',
      cacheFile,
      network: false,
      writes: false,
    };
    if (flags.json) console.log(JSON.stringify(plan, null, 2));
    else {
      heading('ak usage — refresh plan (dry-run)');
      info('Would fetch OpenRouter account activity with OPENROUTER_MANAGEMENT_KEY.');
      info(`Would replace the private normalized cache: ${cacheFile}`);
      info(dim('No network request or file write was performed.'));
    }
    return 0;
  }
  try {
    const value = await refresh({ cacheFile });
    if (flags.json) {
      console.log(JSON.stringify({ cacheFile, openrouter: value }, null, 2));
      return 0;
    }
    const s = summary(value);
    ok(`OpenRouter activity cached: ${s.totals.requests} requests · ${s.models} model(s)`);
    info(`${s.coverage.from ?? 'no activity'} → ${s.coverage.through ?? 'no activity'} `
      + dim('· completed UTC days only'));
    info(dim('cache contains no key, endpoint id, user id, session id, project, or prompt data'));
    return 0;
  } catch (error) {
    if (flags.json) {
      console.log(JSON.stringify({ cacheFile, error: String(error?.message ?? error) }, null, 2));
    } else {
      warn(String(error?.message ?? error));
    }
    return 1;
  }
}

/**
 * @param {{ flags: Record<string, any>, positionals: string[],
 *           deps?: { cacheFile?: string, indexCacheFile?: string,
 *                    read?: typeof readOpenRouterActivity,
 *                    refresh?: typeof refreshOpenRouterActivity,
 *                    readIndex?: typeof readIndex } }} input
 */
export async function run({ flags, positionals, deps = {} }) {
  const action = positionals[0] ?? 'status';
  const provider = positionals[1];
  const cacheFile = deps.cacheFile ?? openRouterActivityFile();

  if (action === 'status' && provider === undefined) {
    return runOpenRouterStatus({ flags, cacheFile, read: deps.read ?? readOpenRouterActivity });
  }
  if (action === 'score') return runScore({ flags, deps });
  if (action === 'prompts') return runPrompts({ flags, deps });
  if (action === 'refresh' && provider === 'openrouter' && positionals.length === 2) {
    return runOpenRouterRefresh({ flags, cacheFile, refresh: deps.refresh ?? refreshOpenRouterActivity });
  }

  warn('usage: ak usage status | ak usage refresh openrouter | ak usage score | ak usage prompts');
  return 2;
}
