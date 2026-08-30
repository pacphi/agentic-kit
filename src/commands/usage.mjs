// Explicit provider-account analytics refresh + offline cache status, plus an
// offline text scorecard (`score`) rendered from the SAME local-transcript
// aggregate `ak dashboard`'s Usage tab reads — no cost/token/percentile
// arithmetic is redone here; see the score section below for the boundary.
import { heading, info, ok, warn, dim } from '../lib/output.mjs';
import { readIndex } from '../lib/usage-index.mjs';
import {
  BASELINE_TRAILING_DAYS, LAT_BUCKET_EDGES, LEN_BUCKET_EDGES, TAP_MAX_TOKENS,
  PROMPT_CLUSTER_JACCARD, PROMPT_REASK_JACCARD, maskSecrets,
} from '../lib/usage-aggregate.mjs';
import { reAskPairs } from '../lib/usage-prompt-patterns.mjs';
import { MODES } from '../lib/usage-modes.mjs';
import {
  openRouterActivityFile,
  readOpenRouterActivity,
  refreshOpenRouterActivity,
} from '../lib/usage-openrouter.mjs';
import { deriveCards } from '../lib/usage-coaching.mjs';
import {
  loadLedger, saveLedger, defaultLedgerPath, gatherAdoptionInputs,
} from '../lib/usage-outcome-ledger.mjs';
// The ledger reconcile, --enrich (spec §6.3), and --dismiss are ONE
// orchestration (resolveCoachingAndEnrichment) — split out of runPrompts on
// the repo's complexity ceiling; it in turn imports usage/enrich.mjs's
// runEnrichPass (the --enrich flow: consent preamble, exemplar gathering,
// persistence), which reuses the SAME shared deep-pass machinery this file
// does — both import it from ./usage/deep-pass.mjs, so neither imports the
// other for it.
import {
  printCoaching, runDraftFlag, resolveCoachingAndEnrichment,
} from './usage/coaching.mjs';
import { applyLabelStoreToPatterns } from '../lib/usage-enrich.mjs';
import { loadLabelStore, defaultLabelStorePath } from '../lib/usage-label-store.mjs';
import {
  promptCacheFile, readPromptEntries, deepFingerprints, exemplarCandidates, collectExemplars,
  MAX_DEEP_FILE_BYTES,
} from './usage/deep-pass.mjs';

export const options = {
  json: { type: 'boolean', default: false },
  'dry-run': { type: 'boolean', default: false },
  // Deliberately no default: `score` and `prompts` want DIFFERENT defaults (14
  // days vs all history — patterns are lifetime phenomena), and a default here
  // would make "the user asked for 14" indistinguishable from "nobody asked".
  window: { type: 'string' },
  deep: { type: 'boolean', default: false },
  // Coaching (spec §5/§6.4), prompts-only: print one card's draft verbatim, or
  // persist a dismissal. Both take a card id, so both are strings, not flags.
  draft: { type: 'string' },
  dismiss: { type: 'string' },
  // Layer-3 enrichment (spec §6.3), prompts-only, opt-in, CLI-only inference.
  enrich: { type: 'boolean', default: false },
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
  ak usage prompts [--window 7|14|30|all] [--deep] [--enrich] [--json] [--draft ID] [--dismiss ID]

\`ak usage prompts\` reads the prompt FINGERPRINTS the transcript scan already
stores — a hash, a token count, a bounded token-hash sketch, and who wrote the
turn. No prompt text is stored by it and none is printed. \`--deep\` is the
exception, and is opt-in for exactly that reason: it re-reads the transcripts
to print the text behind each finding. That text goes to your terminal and is
written nowhere — but with --json it is in the payload, so redirect that to a
file only if you mean to.

\`--enrich\` is a SEPARATE opt-in: a delta-only model call (the Claude Code
CLI, your subscription) that names still-unnamed recurring clusters and
proposes up to three coaching cards, grounded ONLY in masked exemplar
snippets and aggregate counts — never a full prompt. It prints exactly what
it is about to send before sending it. Settled labels are never re-judged.
Without the Claude Code CLI on PATH, it prints one line and exits 0 — every
deterministic tier of this report is unaffected.

Environment:
  OPENROUTER_MANAGEMENT_KEY   required only for refresh; an inference key is
                              intentionally not accepted

Options:
  --json      emit machine-readable output (cache status/result, or the score/prompts projection)
  --dry-run   describe an OpenRouter refresh without network or writes
  --window N  score: 7, 14, or 30 days (default 14)
              prompts: 7, 14, 30, or all (default all — patterns are lifetime
              phenomena, so the whole retained corpus is the honest default)
  --deep      prompts only: re-read transcripts to print the verbatim prompts
              behind each finding. Costs a few seconds; the report states how
              many it opened and how long it took. With --json the exemplars
              (which CONTAIN PROMPT TEXT) ride under an \`exemplars\` key.
  --draft ID    prompts only: print that card's draft verbatim; --dismiss ID persists a dismissal
  --enrich    prompts only: run the delta-inference labeling/coaching pass. Needs the Claude
              Code CLI; prints what will be sent before it sends anything. With --json the
              result rides under an \`enrichment\` key (counts only — never text).

Examples:
  ak usage status                    inspect the offline cache; no network
  ak usage refresh openrouter        explicitly fetch the last 30 completed UTC days
  ak usage status --json             print the normalized credential-free cache
  ak usage score                     offline scorecard summary, last 14 days
  ak usage score --window 30 --json  machine-readable scorecard projection
  ak usage prompts                   what you type, over all retained history
  ak usage prompts --window 30       the same report, last 30 days only
  ak usage prompts --deep            the same report plus the verbatim exemplars`;

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
// WHERE THE NUMBERS COME FROM. Every figure in the aggregate tier is read off
// `agg.promptPatterns` — the opt-in projection usage-aggregate.mjs builds from
// the records it already holds (`prompts: true`), plus the prompt counts the
// aggregate has always published (totals, promptsByHost, promptStatsByDay,
// promptBaselines). Raw fingerprints have no public accessor and this tier does
// not want one: clustering, classification and the decoration semantics behind
// them live in ONE place, so this command and the dashboard cannot disagree
// about what a cluster is.

const PROMPT_WINDOWS = ['7', '14', '30', 'all'];

/** "All history" in days. The index prunes any cache entry whose last activity
 *  is older than 366 days (usage-index.mjs's KEEP_MS) and the dashboard clamps
 *  every queryable window at 365, so 365 days IS all the history this corpus
 *  can hold — not an arbitrary ceiling standing in for infinity. */
const ALL_WINDOW_DAYS = 365;

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

/** What a truncated table owes its reader: the denominator it was sliced from.
 *  Silence here is the one thing this report cannot afford — a 15-row slice of
 *  561 clusters reads as "these are all the recurring clusters" — so every
 *  table that caps its rows prints this, and prints nothing when nothing was
 *  cut. `Re-asks` states its total before the rows for the same reason. */
function showingNote(shown, total) {
  if (shown >= total) return;
  info(dim(`  showing ${fmtNum(shown)} of ${fmtNum(total)}`));
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

/** The typed-prompt headline, straight off the projection's own denominators.
 *  Every provenance tag it publishes gets a row, including ones this corpus
 *  never produced: a missing tag is evidence about the corpus, not a row to
 *  drop. */
function printTypedPrompts(pp, agg) {
  heading('Typed prompts');
  const { fingerprints, typed } = pp.corpus;
  info(`TYPED                   ${fmtNum(typed)}  `
    + dim(`${fmtShare(fingerprints ? typed / fingerprints : null)} of ${fmtNum(fingerprints)} fingerprinted prompt turns`));
  info(`  provenance            ${Object.entries(pp.provenance).map(([k, v]) => `${k} ${fmtNum(v)}`).join(' · ')}`);
  const personas = Object.values(agg.promptsByHost ?? {}).reduce((n, h) => n + (Number(h.personaOpeners) || 0), 0);
  info(`PERSONA OPENERS         ${fmtNum(personas)}  `
    + dim('role assignments ("you are a…") typed by hand · the question split is per host below'));
  if (!fingerprints) {
    info(dim('  no samples — no session in this window carries the fingerprint layer'));
  }
}

/** Taps: the window counts from `totals`, the length spread from the
 *  projection. There is no text at this tier, so "the top taps" can only be a
 *  length distribution — which is the honest shape of the question here; the
 *  deep pass prints the verbatim table. */
function printTaps(pp, totals) {
  heading('Supervision taps');
  const typed = Number(totals.typedPrompts) || 0;
  const taps = Number(totals.tapCount) || 0;
  info(`TAPS                    ${fmtNum(taps)}  `
    + dim(`${fmtShare(typed ? taps / typed : null)} of typed · ${TAP_MAX_TOKENS} normalized tokens or fewer`));
  info(dim('  what this does not model: whether the tap was necessary. Some are legitimate approvals.'));
  if (!pp.tapLengths.length) {
    info(dim('  no samples'));
    return;
  }
  showingNote(Math.min(TOP_TAP_LENGTHS, pp.tapLengths.length), pp.tapLengths.length);
  info(dim(tableRow([['tokens', 6, true], ['prompts', 8, true], ['sessions', 8, true], ['days', 5, true], ['hosts', 20]])));
  for (const r of pp.tapLengths.slice(0, TOP_TAP_LENGTHS)) {
    info(tableRow([
      [r.tokens, 6, true], [fmtNum(r.prompts), 8, true], [fmtNum(r.sessions), 8, true],
      [fmtNum(r.days), 5, true], [r.hosts.join('+') || '—', 20],
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
    ['questions', 10, true], ['p90 tokens', 12, true], ['personas', 9, true], ['your p75', 10, true]])));
  for (const [host, s] of hosts.sort()) {
    info(tableRow([
      [host, 10], [fmtNum(s.typed), 7, true], [fmtNum(s.taps), 6, true], [fmtShare(s.tapShare), 10, true],
      [fmtShare(s.questionShare), 10, true], [fmtMaybe(s.p90TypedTokens), 12, true],
      [fmtNum(s.personaOpeners), 9, true], [baselineCell(agg, host, win), 10, true],
    ]));
  }
  info(dim('  "questions" is the share of that host\'s typed prompts that ASK rather than instruct;'));
  info(dim('  the rest are instructions and declarative feedback, which the shape rules do not split.'));
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

/**
 * What the `class` column PRINTS. As of RULING A (final-triage item 1), this
 * is the identity map for every value the library can actually emit —
 * `promptShape` decides one thing (is this interrogative) and everything else
 * reads as `other` ON THE WIRE now (usage-prompt-patterns.mjs's
 * `classifyCluster`), not as a render-layer rewrite of a stored `instruction`
 * value. Printing it would still assert imperativeness the rules never
 * tested: the corpus's declarative feedback ("One thing I feel that's
 * missing is…") lands there too, and so does a bare `Yes` — which is exactly
 * why the SOURCE was renamed rather than leaving this table to keep
 * translating it. `unknown` is the one genuine relabel left: "unclassified"
 * reads better in a table cell than the internal name.
 */
const CLASS_LABELS = { question: 'question', other: 'other', mixed: 'mixed', unknown: 'unclassified' };

/** Spec §3.1 KPI 4: the share of typed prompts sitting inside a cluster that
 *  recurs. `crossSessionClusters` has already applied the ≥3-sessions-or-≥2-days
 *  filter, so this is a straight sum over what the projection published. */
function repeatedShare(clusters, totals) {
  const typed = Number(totals?.typedPrompts) || 0;
  if (!typed) return { prompts: 0, share: null };
  const prompts = clusters.reduce((n, c) => n + (Number(c.count) || 0), 0);
  return { prompts, share: prompts / typed };
}

function printClusters(clusters, totals) {
  heading('Recurring clusters');
  info(dim(`  near-duplicates at Jaccard ≥ ${PROMPT_CLUSTER_JACCARD}, kept when they span 3+ sessions or 2+ days`));
  if (!clusters.length) {
    info(dim('  no samples'));
    return;
  }
  const repeated = repeatedShare(clusters, totals);
  info(`REPEATED SHARE          ${fmtShare(repeated.share)}  `
    + dim(`${fmtNum(repeated.prompts)} typed prompts across ${fmtNum(clusters.length)} recurring cluster${clusters.length === 1 ? '' : 's'}`));
  info(dim('  what this does not model: whether the repetition was deliberate.'));
  showingNote(Math.min(TOP_CLUSTERS, clusters.length), clusters.length);
  info(dim(tableRow([['pattern', 42], ['n', 4, true], ['sess', 5, true], ['days', 5, true],
    ['tok', 5, true], ['class', 12], ['source', 14]])));
  for (const r of clusters.slice(0, TOP_CLUSTERS)) {
    info(tableRow([
      [r.label.name.length > 42 ? `${r.label.name.slice(0, 41)}…` : r.label.name, 42],
      [fmtNum(r.count), 4, true], [fmtNum(r.sessions), 5, true], [fmtNum(r.days), 5, true],
      [fmtMaybe(r.medianTokens), 5, true], [CLASS_LABELS[r.class] ?? r.class, 12], [r.label.source, 14],
    ]));
  }
  info(dim('  other = imperative or declarative, undifferentiated — the shape rules test only for a'));
  // Fix round 1, M-6: enrichment (--enrich) has arrived and NAMES clusters —
  // it does not reclassify this split, which the old wording implied.
  info(dim('  question; enrichment (--enrich) names clusters, it does not reclassify them into this split.'));
}

/** The stricter subset of the same phenomenon: identical normalized text, not
 *  a near-duplicate family. `key` is the fingerprint hash, printed short so a
 *  reader can join a row to the `--json` projection; there is no text at this
 *  tier, and the deep pass is where these rows get their words. */
function printExactRepeats(rows) {
  heading('Exact repeats');
  info(dim('  identical normalized text, 3+ occurrences — the surplus a canonical form would remove'));
  if (!rows.length) {
    info(dim('  no samples'));
    return;
  }
  const surplus = rows.reduce((n, r) => n + (Number(r.count) || 0) - 1, 0);
  info(`SURPLUS PROMPTS         ${fmtNum(surplus)}  `
    + dim(`retyped rather than reused, across ${fmtNum(rows.length)} group${rows.length === 1 ? '' : 's'}`));
  showingNote(Math.min(TOP_CLUSTERS, rows.length), rows.length);
  info(dim(tableRow([['key', 8], ['n', 4, true], ['sess', 5, true], ['days', 5, true],
    ['tok', 5, true], ['hosts', 20]])));
  for (const r of rows.slice(0, TOP_CLUSTERS)) {
    info(tableRow([
      [r.key.slice(0, 8), 8], [fmtNum(r.count), 4, true], [fmtNum(r.sessions), 5, true],
      [fmtNum(r.days), 5, true], [fmtNum(r.tokens), 5, true], [r.hosts.join('+') || '—', 20],
    ]));
  }
}

function printReAsks(reAsks) {
  heading('Re-asks');
  info(dim(`  the same thing asked twice inside one session, at Jaccard ≥ ${PROMPT_REASK_JACCARD}`));
  if (!reAsks.pairCount) {
    info(dim('  no samples'));
    return;
  }
  info(`PAIRS                   ${fmtNum(reAsks.pairCount)}  `
    + dim(`across ${fmtNum(reAsks.sessionCount)} session${reAsks.sessionCount === 1 ? '' : 's'}`));
  const gaps = Object.entries(reAsks.gapHist).sort((a, b) => Number(a[0]) - Number(b[0]));
  info(`GAP DISTRIBUTION        ${gaps.map(([gap, n]) => `${gap} turn${gap === '1' ? '' : 's'} → ${n}`).join(' · ')}`);
  const immediate = Number(reAsks.gapHist[1]) || 0;
  info(dim(`  ${fmtShare(immediate / reAsks.pairCount)} land one turn apart — the immediately preceding response is what failed`));
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

/** The aggregate tier, assembled: the shared projection plus the one figure it
 *  does not carry (headless share, which is a property of the session rows
 *  rather than of the prompts). Exported solely so usage/coaching.mjs's
 *  `resolveCoachingAndEnrichment` can recompute it after a --enrich pass
 *  changes `agg.promptPatterns` — not part of this command's own contract. */
export function promptReport(agg, win) {
  return {
    win,
    patterns: agg.promptPatterns,
    headless: headlessShare(agg.sessions),
  };
}

// ── the deep pass: exemplar TEXT, re-read on demand ────────────────────────
// Spec §2.3's F2 pass and the CLI half of the privacy split. The aggregate
// tier above knows THAT a request was retyped in 22 sessions; it cannot say
// what the request was, because the text was never stored. `deepPass` below
// re-reads the transcripts to answer that, through the shared
// exemplar-gathering machinery in ./usage/deep-pass.mjs (promptCacheFile,
// readPromptEntries, deepFingerprints, exemplarCandidates, collectExemplars —
// see that file's own header for the privacy-boundary reasoning and why it
// reads the index cache the tier above never does). `--enrich`
// (usage/enrich.mjs) reuses the identical machinery for its own,
// scoped-to-candidate-clusters pass rather than a second copy of it.
//
// Every exemplar collected is run through `maskSecrets` before it is printed
// or serialized below — the join is computed on the raw text so the hash
// still matches, and only the rendering is masked.

const DEEP_TOP_SHORT = 30;
const DEEP_TOP_REASKS = 20;
const DEEP_TOP_PERSONAS = 20;
/** Re-ask pairs below this length are menu picks and approvals ("1", "yes")
 *  re-picked, which the research separates from the substantive re-asks that
 *  are the actual evidence (findings §5.1). Both are counted at the aggregate
 *  tier; only the substantive ones are worth printing verbatim. */
const REASK_MIN_TOKENS = 5;

/** Exact-text groups among the SHORT typed prompts, biggest first — the
 *  "top 30 short prompts" table (findings §2.2). `h` is never sketched, so
 *  these counts are exact however long the corpus is. */
function shortPromptGroups(typed, maxTokens) {
  const groups = new Map();
  for (const fp of typed) {
    if (!(Number(fp.t) <= maxTokens)) continue;
    const g = groups.get(fp.h) ?? { h: fp.h, tokens: fp.t, prompts: 0, sessions: new Set(), days: new Set(), hosts: new Set() };
    g.prompts++;
    if (fp.sessionId) g.sessions.add(fp.sessionId);
    if (fp.day) g.days.add(fp.day);
    if (fp.host) g.hosts.add(fp.host);
    groups.set(fp.h, g);
  }
  const all = [...groups.values()].sort((a, b) => b.prompts - a.prompts || (a.h < b.h ? -1 : 1));
  return { rows: all.slice(0, DEEP_TOP_SHORT), total: all.length };
}

/** Persona-flagged typed prompts, grouped by exact text, longest first — the
 *  role-scaffolding list (findings §5.3). Tokens stand in for size because
 *  that is what a fingerprint carries; the deep pass adds real characters
 *  once it has the text. */
function personaGroups(typed) {
  const groups = new Map();
  for (const fp of typed) {
    if (fp.o !== 1) continue;   // the raw stored flag; see deepFingerprints
    const g = groups.get(fp.h) ?? { h: fp.h, tokens: fp.t, prompts: 0, sessions: new Set(), hosts: new Set() };
    g.prompts++;
    if (fp.sessionId) g.sessions.add(fp.sessionId);
    if (fp.host) g.hosts.add(fp.host);
    groups.set(fp.h, g);
  }
  const all = [...groups.values()].sort((a, b) => b.tokens - a.tokens || (a.h < b.h ? -1 : 1));
  return { rows: all.slice(0, DEEP_TOP_PERSONAS), total: all.length };
}

/** Minutes between the two asks of one pair, located by walking the session's
 *  own prompt order for the (a, b) hashes exactly `gap` apart — the same index
 *  space `reAskPairs` counted in. `null` when they cannot be located, which is
 *  what a session past MAX_PROMPT_FPS looks like. */
function reAskMinutes(turns, pair) {
  for (let i = 0; i + pair.gap < turns.length; i++) {
    if (turns[i].h !== pair.a || turns[i + pair.gap].h !== pair.b) continue;
    const delta = turns[i + pair.gap].at - turns[i].at;
    return {
      minutes: Number.isFinite(delta) ? delta / 60_000 : null,
      ask: turns[i].text,
      reAsk: turns[i + pair.gap].text,
    };
  }
  return null;
}

/** The pairs worth printing verbatim, and the token count each was measured at
 *  (which the fingerprints carry and the pair itself does not). Re-derived here
 *  rather than read off the projection: `promptPatterns.reAsks` publishes
 *  counts, and printing both halves of a pair needs the two HASHES the counts
 *  are made of. Cheap — pairing is per session over a six-turn window, unlike
 *  the clustering this pass deliberately does not repeat. */
function substantiveReAsks(typed) {
  const tokensOf = new Map();
  for (const fp of typed) if (!tokensOf.has(fp.h)) tokensOf.set(fp.h, fp.t);
  return reAskPairs(typed, { jaccard: PROMPT_REASK_JACCARD }).pairs
    .map((p) => ({ ...p, tokens: tokensOf.get(p.a) ?? 0 }))
    .filter((p) => p.tokens >= REASK_MIN_TOKENS)
    .sort((a, b) => a.gap - b.gap || b.tokens - a.tokens)
    .slice(0, DEEP_TOP_REASKS);
}

/**
 * Join exemplar text to the aggregate tier's findings, opening only the
 * transcripts that owe one. Returns the four exemplar tables plus the MEASURED
 * cost of having produced them — measured, because "this took about four
 * seconds" is a claim about someone else's machine.
 */
function deepPass(entries, report, cutoffMs) {
  const started = Date.now();
  const typed = deepFingerprints(entries, cutoffMs);
  const shorts = shortPromptGroups(typed, TAP_MAX_TOKENS);
  const personas = personaGroups(typed);
  const totals = { shortPrompts: shorts.total, personas: personas.total };
  const pairs = substantiveReAsks(typed);
  // A cluster's `key` IS one of its member hashes — the lexicographically
  // smallest, so it is stable across scans and needs no membership list to
  // find. Printing that member rather than the most frequent one costs a
  // slightly less representative phrasing and saves re-running the clustering
  // the projection already did.
  const clusters = report.patterns.clusters.slice(0, TOP_CLUSTERS);
  const wanted = new Set([
    ...shorts.rows.map((g) => g.h), ...personas.rows.map((g) => g.h), ...clusters.map((c) => c.key),
  ]);
  const { text, bySession, cost } = collectExemplars({
    entries, cutoffMs, wanted,
    candidates: exemplarCandidates(typed, wanted),
    reAskSessions: new Set(pairs.map((p) => p.sessionId)),
  });

  return {
    totals,
    shortPrompts: shorts.rows.map((g) => ({
      h: g.h, tokens: g.tokens, prompts: g.prompts,
      sessions: g.sessions.size, days: g.days.size, hosts: [...g.hosts].sort(),
      text: exemplarText(text, g.h),
    })),
    reAsks: pairs.map((p) => deepReAskRow(p, bySession.get(p.sessionId), text)),
    clusters: clusters.map((row) => ({
      key: row.key, name: row.label.name, size: row.count, sessions: row.sessions,
      text: exemplarText(text, row.key),
    })),
    personas: personas.rows.map((g) => {
      const body = text.get(g.h) ?? null;
      return {
        h: g.h, tokens: g.tokens, prompts: g.prompts, sessions: g.sessions.size,
        hosts: [...g.hosts].sort(),
        chars: body === null ? null : body.length,
        opener: exemplarText(text, g.h),
      };
    }),
    cost: {
      ...cost,
      seconds: Math.round((Date.now() - started) / 100) / 10,
      wanted: wanted.size,
      resolved: text.size,
    },
  };
}

/** A resolved exemplar, masked — or the honest absence when the transcript
 *  that held it is gone. Masking happens HERE, after the hash join, so a
 *  secret-bearing prompt still matches its fingerprint and still never
 *  reaches the terminal in the clear. */
function exemplarText(text, h) {
  const body = h ? text.get(h) : undefined;
  return body === undefined ? null : maskSecrets(body);
}

function deepReAskRow(pair, turns, text) {
  const located = turns ? reAskMinutes(turns, pair) : null;
  return {
    sessionId: pair.sessionId, gap: pair.gap, host: pair.host ?? null, day: pair.day ?? null,
    tokens: pair.tokens, jaccard: Math.round(pair.jaccard * 100) / 100,
    minutes: located?.minutes == null ? null : Math.round(located.minutes * 10) / 10,
    ask: located ? maskSecrets(located.ask) : exemplarText(text, pair.a),
    reAsk: located ? maskSecrets(located.reAsk) : exemplarText(text, pair.b),
  };
}

/** The --json shape: the shared `promptPatterns` projection VERBATIM under
 *  `patterns`, plus the per-host figures the aggregate has always published and
 *  the window's headless share. Verbatim on purpose — a consumer diffing this
 *  against the dashboard's own payload must see the identical object, not a
 *  reshaped one. Fingerprint-derived throughout: hashes, counts, token counts,
 *  shares, host names and session ids. No prompt text exists at this tier. */
function promptProjection(agg, r) {
  return {
    window: r.win.label,
    windowDays: r.win.days,
    generatedAt: agg.generatedAt,
    sessions: agg.totals?.sessions ?? 0,
    typed: { total: agg.totals?.typedPrompts ?? 0, taps: agg.totals?.tapCount ?? 0 },
    hosts: {
      byHost: agg.promptsByHost ?? {},
      baselines: agg.promptBaselines ?? {},
      monthlyTapShare: monthlyTapShare(agg.promptStatsByDay),
    },
    patterns: r.patterns,
    headless: r.headless,
  };
}

function printPromptReport(agg, r) {
  heading(`ak usage — prompts (${r.win.label === 'all' ? 'all history' : `last ${r.win.days}d`})`);
  info(dim('every figure below is derived from prompt fingerprints — no prompt text is read or stored'));
  printTypedPrompts(r.patterns, agg);
  printTaps(r.patterns, agg.totals ?? {});
  printHostInterplay(agg, r.win);
  printClusters(r.patterns.clusters, agg.totals ?? {});
  printExactRepeats(r.patterns.exactRepeats);
  printReAsks(r.patterns.reAsks);
  printHeadless(r.headless);
}

// ── deep-pass printers ──────────────────────────────────────────────────────

/** One-line rendering of a prompt: whitespace collapsed so a pasted paragraph
 *  stays one row, clipped, and 'transcript unavailable' rather than blank when
 *  the file that held it could not be re-read. */
function clipText(text, max) {
  if (text == null) return 'transcript unavailable';
  const one = String(text).replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

function printShortPrompts(rows, total) {
  heading('Top short prompts');
  info(dim(`  every typed prompt of ${TAP_MAX_TOKENS} normalized tokens or fewer, by exact text`));
  if (!rows.length) return info(dim('  no samples'));
  showingNote(rows.length, total);
  info(dim(tableRow([['n', 4, true], ['sess', 5, true], ['days', 5, true], ['hosts', 14], ['prompt', 60]])));
  for (const r of rows) {
    info(tableRow([[fmtNum(r.prompts), 4, true], [fmtNum(r.sessions), 5, true], [fmtNum(r.days), 5, true],
      [r.hosts.join('+') || '—', 14], [clipText(r.text, 60), 60]]));
  }
}

function printReAskPairs(rows) {
  heading('Re-ask pairs');
  info(dim(`  substantive pairs only (${REASK_MIN_TOKENS}+ tokens) — menu picks and approvals are counted above, not printed`));
  if (!rows.length) return info(dim('  no samples'));
  for (const r of rows) {
    const when = r.minutes == null ? 'timing not located' : `${r.minutes} min apart`;
    info(tableRow([[`gap ${r.gap}`, 7], [when, 20], [`${r.tokens} tok`, 8], [r.host ?? '—', 8], [r.sessionId.slice(0, 12), 13]]));
    info(dim(`    ask   ${clipText(r.ask, 92)}`));
    info(dim(`    again ${clipText(r.reAsk, 92)}`));
  }
}

function printClusterExemplars(rows) {
  heading('Cluster exemplars');
  info(dim('  one phrasing per recurring cluster — the member its key names, stable across scans'));
  if (!rows.length) return info(dim('  no samples'));
  for (const r of rows) {
    info(tableRow([[`${r.name}`, 42], [`${fmtNum(r.size)}×`, 6, true], [`${fmtNum(r.sessions)} sess`, 9, true]]));
    info(dim(`    ${clipText(r.text, 96)}`));
  }
}

function printPersonas(rows, total) {
  heading('Persona scaffolding');
  info(dim('  role assignments typed by hand — the text a managed prompt-fragment library would hold'));
  if (!rows.length) return info(dim('  no samples'));
  showingNote(rows.length, total);
  info(dim(tableRow([['chars', 7, true], ['tok', 6, true], ['n', 3, true], ['hosts', 14], ['opener', 60]])));
  for (const r of rows) {
    info(tableRow([[fmtMaybe(r.chars), 7, true], [fmtNum(r.tokens), 6, true], [fmtNum(r.prompts), 3, true],
      [r.hosts.join('+') || '—', 14], [clipText(r.opener, 60), 60]]));
  }
}

function printDeepPass(deep) {
  const c = deep.cost;
  heading(`Deep pass — verbatim exemplars (deep pass: ${fmtNum(c.transcripts)} `
    + `transcript${c.transcripts === 1 ? '' : 's'}, ${c.seconds.toFixed(1)}s)`);
  info(dim('re-read from the transcripts on demand. This text is printed here and written nowhere.'));
  if (c.unreadable > 0 || c.resolved < c.wanted) {
    info(dim(`  ${fmtNum(c.resolved)} of ${fmtNum(c.wanted)} exemplars resolved · `
      + `${fmtNum(c.unreadable)} transcript${c.unreadable === 1 ? '' : 's'} could not be re-read `
      + `(missing, or past the ${Math.round(MAX_DEEP_FILE_BYTES / 1024 / 1024)} MB read ceiling)`));
  }
  printShortPrompts(deep.shortPrompts, deep.totals.shortPrompts);
  printReAskPairs(deep.reAsks);
  printClusterExemplars(deep.clusters);
  printPersonas(deep.personas, deep.totals.personas);
}

// Coaching section rendering, --json shapes, and --draft/--dismiss handling
// (spec §5, §6.4) live in ./usage/coaching.mjs (imported above) — split out
// on the status.mjs/status/*.mjs precedent once this file crossed the
// repo's max-lines threshold. The --enrich flow itself lives in
// ./usage/enrich.mjs for the same reason. runPrompts below is the only
// caller of either.

/** The --json `enrichment` key: counts only, never text (spec: "--enrich
 *  --json: enriched data included, still no text"). `null` when --enrich
 *  was never able to run at all (no invocation path, or a future-schema
 *  label store) — distinguished from "ran and did nothing" the same way
 *  every other absent-vs-zero field on this payload is. */
function enrichmentProjection(enrichment) {
  if (!enrichment) return { ran: false };
  return {
    ran: true,
    labels: {
      candidates: enrichment.labelResult.candidates.length,
      labeled: enrichment.labelResult.labeled,
      dropped: enrichment.labelResult.dropped,
    },
    cards: {
      proposed: enrichment.cardResult.proposed,
      accepted: enrichment.cardResult.accepted,
      dropped: enrichment.cardResult.dropped,
    },
  };
}

async function runPrompts({ flags, deps }) {
  const win = parsePromptWindow(flags.window);
  if (win == null) {
    warn(`ak usage prompts: --window must be 7, 14, 30, or all (got ${JSON.stringify(flags.window)})`);
    return 2;
  }
  // Fix round 1, M-7: rejected before any I/O — neither flag's write can
  // silently win over the other.
  if (flags.draft != null && flags.dismiss != null) {
    warn('ak usage prompts: --draft and --dismiss cannot be combined in one run.');
    return 2;
  }
  const readAgg = deps.readIndex ?? readIndex;
  let agg;
  try {
    // `prompts: true` is what builds agg.promptPatterns — the same projection
    // the dashboard's Prompts view reads, so the two cannot disagree. The
    // lookback widening is the same as `score`'s and for the same reason: the
    // per-host tap-share baseline printed beside each host is a percentile over
    // the 90 days before this window, and it can only be built from records
    // that were read.
    agg = await readAgg({
      days: win.days,
      lookbackDays: win.days + BASELINE_TRAILING_DAYS,
      prompts: true,
    });
  } catch (error) {
    const message = String(error?.message ?? error);
    if (flags.json) console.log(JSON.stringify({ window: win.label, error: message }, null, 2));
    else warn(message);
    return 1;
  }

  // W5 enrichment (spec §6.3): the persisted label store applies to EVERY
  // pass, --enrich or not — a settled label is a fact about the corpus, not
  // a one-time render. A newer-schema store reads as "no store" for THIS
  // pass (same I-2 rule the outcome ledger already follows below); the
  // write-refusal half of that rule is enforced inside runEnrichPass.
  const labelStorePath = deps.labelStorePath ?? defaultLabelStorePath();
  const labelStore = loadLabelStore(labelStorePath);
  if (labelStore.future) {
    // Fix round 1, I-4: guarded on `!flags.json` — this fires on EVERY pass
    // (not only `--enrich`), and `warn` writes to stdout (output.mjs); an
    // unguarded call here corrupts the `--json` document this function
    // prints later, exactly the hazard the implementer already reasoned
    // about and guarded for runEnrichPass's own copy of this same warning.
    if (!flags.json) {
      warn(`ak usage prompts: the label store at ${labelStorePath} is a newer schema `
        + `(v${labelStore.version}) this build does not understand — enriched labels/cards are `
        + 'unavailable this run, and the file was left untouched.');
    }
  }
  const activeLabels = labelStore.future ? {} : labelStore.labels;
  agg.promptPatterns = applyLabelStoreToPatterns(agg.promptPatterns, activeLabels);

  // Coaching cards (spec §5) derive from the OPERATOR'S window, for display —
  // `agg.insights` is populated unconditionally by aggregate()
  // (usage-aggregate.mjs), not only when `prompts: true`, so it needs no
  // separate read here.
  const ruleCards = deriveCards({
    promptPatterns: agg.promptPatterns, promptBaselines: agg.promptBaselines,
    promptsByHost: agg.promptsByHost, insights: agg.insights, now: Date.now(),
  });

  // --draft is a pure read over the RULE cards alone — no ledger, no
  // canonical fetch, no write (Fix round 1, M-7). Enriched cards carry no
  // draft (spec §6.3's synthesis contract has none), so this stays scoped.
  if (flags.draft != null) return runDraftFlag(ruleCards, flags.draft, flags.json);

  let report = promptReport(agg, win);
  const deep = flags.deep ? runDeepPass(agg, report, win, deps) : null;

  const ledgerPath = deps.ledgerPath ?? defaultLedgerPath();
  const loadLedgerFn = deps.loadLedger ?? loadLedger;
  const saveLedgerFn = deps.saveLedger ?? saveLedger;
  const cwd = deps.cwd ?? process.cwd();
  const adoptionInputs = deps.adoptionInputs ?? gatherAdoptionInputs(cwd);
  const now = Date.now();

  // The ledger reconcile, --enrich (spec §6.3), and --dismiss all live in ONE
  // orchestration (usage/coaching.mjs's resolveCoachingAndEnrichment) — split
  // out on the repo's complexity ceiling, since this was the single largest
  // branch runPrompts carried. `report` may come back reassigned (a --enrich
  // pass that actually changed a label re-renders it); `agg.promptPatterns`
  // may be mutated in place for the same reason.
  const resolved = await resolveCoachingAndEnrichment({
    agg, report, win, ruleCards, activeLabels, labelStore, labelStorePath,
    ledgerPath, loadLedgerFn, saveLedgerFn, readAgg, adoptionInputs, now, flags, deps,
  });
  if ('earlyReturn' in resolved) return resolved.earlyReturn;
  const { coaching, enrichment } = resolved;
  report = resolved.report;

  if (flags.json) {
    const projection = {
      ...promptProjection(agg, report), coaching,
      ...(flags.enrich ? { enrichment: enrichmentProjection(enrichment) } : {}),
    };
    console.log(JSON.stringify(deep ? { ...projection, exemplars: deep } : projection, null, 2));
    return 0;
  }
  printPromptReport(agg, report);
  printCoaching(coaching);
  if (deep) printDeepPass(deep);
  return 0;
}

/** The deep pass's own read, kept out of runPrompts so the aggregate tier's
 *  data path stays a single call. The cache is read AFTER readIndex, which
 *  rewrites it as its last act before aggregating — so the fingerprints are the
 *  same corpus the projection was built from, never a stale one. */
function runDeepPass(agg, report, win, deps) {
  // NOT `deps.cacheFile` — that name is already taken by the OpenRouter
  // activity cache this command also manages, and they are different files.
  const entries = readPromptEntries(deps.indexCacheFile ?? promptCacheFile());
  const cutoffMs = Date.parse(agg.generatedAt) - win.days * 86_400_000;
  return deepPass(entries, report, cutoffMs);
}

// Exported ONLY for direct-import unit tests — see tests/kit/usage-cli.test.mjs
// (the <$0.01 boundary, true-zero vs a real sub-cent positive: constructing a
// SECOND fixture transcript whose priced total is exactly zero is
// disproportionate, since a session prices to exactly $0 only by carrying no
// usage rows at all, which the aggregate's own cost distribution already
// excludes — see usage-aggregate.mjs's `_priced`) and
// tests/kit/usage-coaching.test.mjs (the INTEGRATION REGRESSION PIN, which
// renders the coaching section through the real CLI printer rather than a
// hand-rolled restatement of it). Neither is part of this command's CLI
// contract.
export const __test = { fmtUsdMin, printCoaching };

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
