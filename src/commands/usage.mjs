// Explicit provider-account analytics refresh + offline cache status, plus an
// offline text scorecard (`score`) rendered from the SAME local-transcript
// aggregate `ak dashboard`'s Usage tab reads — no cost/token/percentile
// arithmetic is redone here; see the score section below for the boundary.
import { heading, info, ok, warn, dim } from '../lib/output.mjs';
import { readIndex } from '../lib/usage-index.mjs';
import { LAT_BUCKET_EDGES, LEN_BUCKET_EDGES } from '../lib/usage-aggregate.mjs';
import { MODES } from '../lib/usage-modes.mjs';
import {
  openRouterActivityFile,
  readOpenRouterActivity,
  refreshOpenRouterActivity,
} from '../lib/usage-openrouter.mjs';

export const options = {
  json: { type: 'boolean', default: false },
  'dry-run': { type: 'boolean', default: false },
  window: { type: 'string', default: '14' },
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

Environment:
  OPENROUTER_MANAGEMENT_KEY   required only for refresh; an inference key is
                              intentionally not accepted

Options:
  --json      emit machine-readable output (cache status/result, or the score projection)
  --dry-run   describe an OpenRouter refresh without network or writes
  --window N  score only: 7, 14, or 30 days (default 14)

Examples:
  ak usage status                    inspect the offline cache; no network
  ak usage refresh openrouter        explicitly fetch the last 30 completed UTC days
  ak usage status --json             print the normalized credential-free cache
  ak usage score                     offline scorecard summary, last 14 days
  ak usage score --window 30 --json  machine-readable scorecard projection`;

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
  heading('cadence');
  const perDay = active ? (Number(t.sessions) || 0) / active : null;
  info(`SESSIONS / ACTIVE DAY   ${perDay == null ? '—' : fmtRatio(perDay)}  `
    + dim(`${fmtNum(active)} active day${active === 1 ? '' : 's'}`));
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
  heading('your rhythm — session length · response latency');
  info(`SESSION LENGTH          median ${fmtAtLeast(r.lenMedianSeconds, LEN_OVERFLOW)}  `
    + dim(`P90 ${fmtAtLeast(r.lenP90Seconds, LEN_OVERFLOW)}`));
  info(`RESPONSE LATENCY        p50 ${fmtAtLeast(r.latP50, LAT_OVERFLOW)}  `
    + dim(`p95 ${fmtAtLeast(r.latP95, LAT_OVERFLOW)} · n ${fmtNum(r.latCount)}`));
}

/** Shared renderer for the mode/served-by tables: `keys` decides the row set
 *  and order, defaulting an absent bucket to zero — so a table always shows
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
  printBucketTable('mode — permission posture', agg.byMode ?? {}, [...MODES, 'not-recorded']);
}

function printScoreProviderTable(agg) {
  const byProv = agg.byInferenceProvider ?? {};
  const keys = new Set(Object.keys(byProv));
  keys.add('not-recorded');
  const ordered = [...keys].sort((a, b) => (Number(byProv[b]?.cost) || 0) - (Number(byProv[a]?.cost) || 0));
  printBucketTable('served by — inference provider', byProv, ordered);
}

function printScoreReliability(agg) {
  heading('reliability — turns that never landed');
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
  info(`ABORTED TURNS               ${fmtNum(aborts)}  `
    + dim('interrupted mid-flight — counted apart from exceptions'));
}

/** The --json shape: an ADDITIVE, credential-free, offline projection of the
 *  same aggregate the text report renders from — verbatim fields, no
 *  reshaping, so a consumer diffing this against the dashboard's /api/usage
 *  payload sees the identical totals/rhythm/byMode/byInferenceProvider. */
function scoreProjection(agg, windowDays) {
  return {
    window: windowDays,
    totals: agg.totals,
    rhythm: agg.rhythm,
    byMode: agg.byMode,
    byInferenceProvider: agg.byInferenceProvider,
    bySource: agg.bySource,
    previous: agg.previous,
  };
}

async function runScore({ flags, deps }) {
  const windowDays = parseScoreWindow(flags.window);
  if (windowDays == null) {
    warn(`ak usage score: --window must be 7, 14, or 30 (got ${JSON.stringify(flags.window)})`);
    return 2;
  }
  const readAgg = deps.readIndex ?? readIndex;
  let agg;
  try {
    // Mirrors dashboard-server.mjs's handleUsage route exactly: lookbackDays
    // widens what usage-index.mjs reads off disk so records from the window
    // BEFORE this one survive to be aggregated, and previous:true is what
    // turns those into agg.previous — this window's own totals/sessions stay
    // exactly `windowDays` wide either way.
    agg = await readAgg({ days: windowDays, lookbackDays: windowDays * 2, previous: true });
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
  printScoreProviderTable(agg);
  printScoreReliability(agg);
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

/**
 * @param {{ flags: Record<string, any>, positionals: string[],
 *           deps?: { cacheFile?: string, read?: typeof readOpenRouterActivity,
 *                    refresh?: typeof refreshOpenRouterActivity,
 *                    readIndex?: typeof readIndex } }} input
 */
export async function run({ flags, positionals, deps = {} }) {
  const action = positionals[0] ?? 'status';
  const provider = positionals[1];
  const cacheFile = deps.cacheFile ?? openRouterActivityFile();
  const read = deps.read ?? readOpenRouterActivity;
  const refresh = deps.refresh ?? refreshOpenRouterActivity;

  if (action === 'status' && provider === undefined) {
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

  if (action === 'score') {
    return runScore({ flags, deps });
  }

  if (action === 'refresh' && provider === 'openrouter' && positionals.length === 2) {
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

  warn('usage: ak usage status | ak usage refresh openrouter | ak usage score');
  return 2;
}
