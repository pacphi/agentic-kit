// Usage findings — aggregates in, ranked insights out (ADR-0009 §6).
//
// This module is PURE: it reads a plain `Aggregate` (see the spec §5) and returns
// plain objects. No `fs`, no clock, no network — that is what makes every detector
// unit-testable against a synthetic aggregate.
//
// Three rules from ADR-0009 §6 are enforced in code, not left to reviewer taste:
//
//   1. NO FABRICATED IMPACT. `impact` is a number only when it is arithmetic over
//      the user's own aggregate. A detector that cannot compute one says `null`,
//      and the UI shows "no $ claimed". A constant is not an estimate.
//   2. NO ABSOLUTE-DOLLAR FIRING THRESHOLDS. Every threshold is a SHARE of the
//      window (of its spend, its sessions, or its responses). A "$10 is a lot"
//      rule of thumb calibrated on one corpus would scream on a small window and
//      whisper on a large one; a share behaves the same at any size.
//   3. CAPABILITY CLAIMS CARRY CITATIONS. `model-routing` is the one detector that
//      touches "model X vs Y", so it carries `sources` and deliberately recommends
//      complexity-aware routing rather than a blanket move to the newest model.
//      A diagnostic panel that nudges toward the newest model by default is an
//      advertisement, not a diagnostic.

// ── Pricing structure (multipliers, not rates) ───────────────────────────────
// `pricing.mjs` owns the per-model $ rates. What we need here is only the SHAPE
// of the formula, so a token mix can be converted into billable "units" and the
// user's own window cost can be attributed across it:
//
//   units = input·1 + cacheWrite·1.25 + cacheRead·0.1 + output·OUTPUT_MULT
//
// Dividing the window's measured cost by its units yields a $/unit that is
// derived entirely from the user's data — no rate table, no vendor assumption,
// and correct even when the price table drifts.
export const CACHE_WRITE_MULT = 1.25;
export const CACHE_READ_MULT = 0.1;
// Output:input rate ratio. 5× across every current Anthropic tier (10/50, 5/25,
// 3/15, 1/5); OpenAI's lines sit near 8×, so a Codex-heavy window under-attributes
// output slightly. It moves the split between line items, never the total.
export const OUTPUT_MULT = 5;

// Rate ratio of the balanced tier to the premium tier (Sonnet 3/15 ÷ Opus 5/25 =
// 0.6), so re-routing routine work down a tier saves 40% of that work's cost.
// This is the only structural constant that reaches an `impact`, and it multiplies
// a spend figure measured from the aggregate — the magnitude is always the user's.
export const TIER_SAVING_RATIO = 0.4;

// ── Firing thresholds ────────────────────────────────────────────────────────
// Exported so tests can pin boundaries to the same numbers the detectors use, and
// so the UI can explain "why am I seeing this". Every `*Share` is a fraction of
// the window, per rule 2 above.
export const THRESHOLDS = {
  // context-tax: median per-session cache write, priced and multiplied out, as a
  // share of window spend.
  contextTaxMinShare: 0.01,
  contextTaxWarnShare: 0.10,

  // premium-on-routine: what counts as "routine", and the saving floor.
  premiumMaxResponses: 6,
  premiumMaxMinutes: 8,
  premiumMinSavingShare: 0.01,

  // churn: abandoned sessions that still paid a full context load.
  churnMaxPrompts: 1,
  churnMaxMinutes: 2,
  churnMinShare: 0.005,

  // overnight: local-hour band that reads as unattended, and its response share.
  overnightHours: [1, 2, 3, 4, 5],
  overnightMinShare: 0.08,

  // spend-trend: recent half vs prior half of the window's days.
  trendMinDelta: 0.25,

  // project-concentration / classify-coverage.
  concentrationMinShare: 0.22,
  unclassifiedMinShare: 0.25,

  // model-routing: prev-generation Opus share of spend.
  prevGenMinShare: 0.15,

  // cost-per-session-spread: costliest ÷ cheapest category, and the evidence floor
  // below which a category is too thin to be a data point.
  spreadMinRatio: 10,
  spreadMinCategorySessions: 3,

  // high-volume-automation: repetition count, and cheapness expressed RELATIVE to
  // the window's own mean session cost (the spec table's "<$5" was the reference
  // corpus's value of exactly this — an absolute floor would violate rule 2).
  automationMinSessions: 100,
  automationMaxAvgShare: 0.5,

  // parallel-sessions: summed span ÷ union span — how many sessions were open
  // at once, on average, while anything was open. All parallel sessions draw on
  // ONE plan limit, which is why the factor matters at all.
  parallelMinFactor: 2,

  // subagent-share / long-session-share: cost share of sidechain (subagent)
  // transcripts, and of sessions spanning 8+ hours. Both mirror characteristics
  // Claude Code's own /usage panel reports, computed here from local data.
  sidechainMinShare: 0.25,
  longSessionMinutes: 480,
  longSessionMinShare: 0.25,

  // limit-pacing (detectLimitInsights): fires only past this utilization, and
  // only when consumption is running ahead of the window's own elapsed share by
  // this lead factor — pace alone at 5% used is noise, pace at 60% is a fact.
  pacingMinUsedPercent: 50,
  pacingLeadFactor: 1.25,

  // cross-host-arbitrage (detectLimitInsights): one host's weekly window above
  // the high mark while the other host has a lane under the low mark.
  arbitrageHighPercent: 75,
  arbitrageLowPercent: 25,
};

// ── Grounding for `model-routing` (ADR-0009 §6) ──────────────────────────────
// Two findings that look contradictory, plus the literature that reconciles them:
// capability gains land on hard tasks, overthinking overhead lands on easy ones.
// Third-party "model X vs Y" blog comparisons are NOT admissible here.
export const MODEL_ROUTING_SOURCES = [
  { label: 'Anthropic — Introducing Claude Opus 5 (vendor benchmark)',
    url: 'https://www.anthropic.com/news/claude-opus-5' },
  { label: 'pacphi/retort — local controlled A/B on a routine task',
    url: 'https://github.com/pacphi/retort/blob/main/versions-blog.md' },
  { label: 'Think Fast and Slow: Step-Level Cognitive Depth Adaptation (arXiv 2602.12662)',
    url: 'https://arxiv.org/html/2602.12662' },
  { label: 'OckBench: Measuring the Efficiency of LLM Reasoning (arXiv 2511.05722)',
    url: 'https://arxiv.org/html/2511.05722' },
  { label: 'Stop Overthinking: A Survey on Efficient Reasoning (arXiv 2503.16419)',
    url: 'https://arxiv.org/pdf/2503.16419' },
];

// Premium reasoning tiers, and the current Opus generation. Prefix matches, so a
// dated id (`claude-opus-5[1m]`, `claude-haiku-4-5-20251001`) resolves correctly.
const PREMIUM_PREFIXES = ['claude-fable', 'claude-mythos', 'claude-opus'];
const CURRENT_OPUS_PREFIX = 'claude-opus-5';
const PREV_GEN_OPUS_PREFIX = 'claude-opus-';

const SEVERITY_RANK = { warn: 0, info: 1, ok: 2 };

// ── Small pure helpers ───────────────────────────────────────────────────────

const num = (v) => (Number.isFinite(v) ? v : 0);
const round2 = (n) => Math.round(n * 100) / 100;
const usd = (n) => `$${Math.round(n).toLocaleString('en-US')}`;
const usd2 = (n) => `$${n.toFixed(2)}`;
const pct = (n) => `${Math.round(n * 100)}%`;
const kTok = (n) => `${Math.round(n / 1000).toLocaleString('en-US')}K`;
const count = (n) => Math.round(n).toLocaleString('en-US');

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function sumBy(rows, key) {
  return rows.reduce((acc, r) => acc + num(r?.[key]), 0);
}

function mean(rows, key) {
  return rows.length ? sumBy(rows, key) / rows.length : 0;
}

// Billable units for a token mix — see the pricing-structure note above.
function billableUnits(t) {
  return num(t.input)
    + num(t.cacheWrite) * CACHE_WRITE_MULT
    + num(t.cacheRead) * CACHE_READ_MULT
    + num(t.output) * OUTPUT_MULT;
}

// `models` is a model→responses map; tolerate an array of ids too.
function modelIds(session) {
  const m = session?.models;
  if (Array.isArray(m)) return m.filter((x) => typeof x === 'string');
  if (m && typeof m === 'object') return Object.keys(m);
  return [];
}

const isPremiumModel = (id) => PREMIUM_PREFIXES.some((p) => id.startsWith(p));
const isPrevGenOpus = (id) => id.startsWith(PREV_GEN_OPUS_PREFIX) && !id.startsWith(CURRENT_OPUS_PREFIX);

// Keyed map → sorted [key, value] pairs, costliest first. Tolerates a missing map.
function entriesByCost(map) {
  if (!map || typeof map !== 'object') return [];
  return Object.entries(map)
    .filter(([, v]) => v && typeof v === 'object')
    .sort((a, b) => num(b[1].cost) - num(a[1].cost));
}

// ── The detectors ────────────────────────────────────────────────────────────

/**
 * A keyed rollup bucket (byModel / byProvider / byProject / byCategory). Every
 * field is optional because detectors tolerate partial aggregates.
 * @typedef {Record<string, Record<string, number>>} UsageBucketMap
 */

/**
 * The aggregate emitted by `usage-index.mjs` (spec §5), typed loosely on
 * purpose: this module is defensive by contract — it must stay silent rather
 * than throw when a slice is absent — so every member is optional and the
 * numeric leaves are read through the `num()` guard rather than trusted.
 *
 * @typedef {object} UsageAggregate
 * @property {Record<string, number>} [totals]
 * @property {Array<Record<string, any>>} [sessions]
 * @property {Record<string, number>} [punchcard]
 * @property {Record<string, Record<string, number>>} [byDay]
 * @property {UsageBucketMap} [byModel]
 * @property {UsageBucketMap} [byProvider]
 * @property {UsageBucketMap} [byProject]
 * @property {UsageBucketMap} [byCategory]
 */

/**
 * Rank findings over a usage aggregate.
 *
 * @param {UsageAggregate} [agg] Aggregate from `usage-index.mjs` (see spec §5).
 *   Partial or missing input is tolerated: a detector with no evidence stays silent.
 * @returns {Array<{id:string, kind:'coach'|'trend', severity:'warn'|'info'|'ok',
 *   title:string, finding:string, evidence:string, action:string,
 *   command:string|null, impact:number|null, sources?:Array<{label:string,url:string}>}>}
 *   Ranked most-impactful first: computed-impact findings descending, then
 *   $-free findings by severity.
 */
export function detectInsights(agg) {
  const a = agg && typeof agg === 'object' ? agg : {};
  const totals = a.totals && typeof a.totals === 'object' ? a.totals : {};
  const sessions = Array.isArray(a.sessions) ? a.sessions : [];
  const windowCost = num(totals.cost);
  const sessionCount = Number.isFinite(totals.sessions) ? totals.sessions : sessions.length;

  const found = [];
  const push = (insight) => found.push({ command: null, impact: null, ...insight });

  // 1 ── context-tax. Every session re-pays a fixed startup cache write before any
  // work happens. Priced from the window's own $/unit, so no rate table is assumed.
  const units = billableUnits(totals);
  if (sessions.length && windowCost > 0 && units > 0) {
    const medCacheWrite = median(sessions.map((s) => num(s.cacheWrite)));
    const costPerUnit = windowCost / units;
    const tax = medCacheWrite * sessions.length * CACHE_WRITE_MULT * costPerUnit;
    const share = windowCost > 0 ? tax / windowCost : 0;
    if (share >= THRESHOLDS.contextTaxMinShare) {
      const cwShare = (num(totals.cacheWrite) * CACHE_WRITE_MULT) / units;
      push({
        id: 'context-tax', kind: 'coach',
        severity: share >= THRESHOLDS.contextTaxWarnShare ? 'warn' : 'info',
        title: 'Every session re-pays a fixed context tax',
        finding: `The median session writes ${kTok(medCacheWrite)} tokens to cache before any work `
          + `happens. Across ${count(sessions.length)} sessions that is about ${usd(tax)} of this `
          + `window's ${usd(windowCost)} (${pct(share)}).`,
        evidence: `Cache writes are ${pct(cwShare)} of the window's billable volume and bill at `
          + `${CACHE_WRITE_MULT}× input. A finished session never re-reads that prefix — a new one `
          + 'always re-writes it.',
        action: 'Trim the always-on guidance blocks, or move rarely-used reference material behind '
          + 'a skill so it loads on demand instead of into every session.',
        command: 'ak x blocks audit',
        impact: round2(tax),
      });
    }
  }

  // 2 ── premium-on-routine. Frontier reasoning on short, shallow sessions. Fires
  // only when the projected saving clears a SHARE of the window (rule 2): $1k of
  // saving is decisive in a $10k window and noise in a $200k one.
  const routinePremium = sessions.filter((s) => modelIds(s).some(isPremiumModel)
    && num(s.responses) <= THRESHOLDS.premiumMaxResponses
    && num(s.minutes) <= THRESHOLDS.premiumMaxMinutes);
  if (routinePremium.length && windowCost > 0) {
    const spend = sumBy(routinePremium, 'cost');
    const saving = spend * TIER_SAVING_RATIO;
    if (saving / windowCost >= THRESHOLDS.premiumMinSavingShare) {
      push({
        id: 'premium-on-routine', kind: 'coach', severity: 'warn',
        title: 'Premium models are doing short, shallow sessions',
        finding: `${count(routinePremium.length)} sessions ran on an Opus/Fable-tier model but `
          + `lasted ≤${THRESHOLDS.premiumMaxMinutes} minutes with ≤${THRESHOLDS.premiumMaxResponses} `
          + `responses, costing ${usd(spend)} — ${pct(spend / windowCost)} of the window.`,
        evidence: 'Short sessions are lookups, small edits and quick reviews; they rarely exercise '
          + `frontier reasoning. The balanced tier prices at ${Math.round((1 - TIER_SAVING_RATIO) * 100)}% `
          + 'of premium, so the saving is the measured spend on those sessions times '
          + `${TIER_SAVING_RATIO}.`,
        action: 'Route quick and mechanical activities to the balanced tier in your per-activity '
          + 'policy. Reasoning-heavy activities stay where they are.',
        command: 'ak x provider pick',
        impact: round2(saving),
      });
    }
  }

  // 3 ── churn. Sessions abandoned before they produced anything still paid a full
  // context load. Floored on a share of window spend, not on a dollar amount.
  const churned = sessions.filter((s) => num(s.prompts) <= THRESHOLDS.churnMaxPrompts
    && num(s.minutes) < THRESHOLDS.churnMaxMinutes);
  if (churned.length && windowCost > 0) {
    const spend = sumBy(churned, 'cost');
    if (spend / windowCost >= THRESHOLDS.churnMinShare) {
      push({
        id: 'churn', kind: 'coach', severity: 'info',
        title: 'Abandoned sessions still cost a full context load',
        finding: `${count(churned.length)} sessions `
          + `(${pct(churned.length / Math.max(sessions.length, 1))} of the window) took `
          + `≤${THRESHOLDS.churnMaxPrompts} prompt and ran under ${THRESHOLDS.churnMaxMinutes} `
          + `minutes, costing ${usd(spend)}.`,
        evidence: 'That is the shape of a /clear-and-restart cycle or a mistaken launch. Each one '
          + 'still pays the startup cache write in full before being thrown away.',
        action: 'Prefer continuing a session over clearing it when the topic is related — the '
          + 'cached prefix has already been paid for.',
        impact: round2(spend),
      });
    }
  }

  // 4 ── overnight. Sustained small-hours activity is the signature of unattended
  // loops, not of a person. No dollar claim: this is a "confirm it is intended"
  // finding, and the cost of unintended automation is not knowable from here.
  const punch = a.punchcard && typeof a.punchcard === 'object' ? a.punchcard : {};
  const punchEntries = Object.entries(punch);
  if (punchEntries.length) {
    const nightHours = new Set(THRESHOLDS.overnightHours);
    let night = 0; let allResponses = 0;
    for (const [key, value] of punchEntries) {
      const responses = num(value);
      allResponses += responses;
      const hour = Number(String(key).split('-')[1]);
      if (nightHours.has(hour)) night += responses;
    }
    const share = allResponses > 0 ? night / allResponses : 0;
    if (share > THRESHOLDS.overnightMinShare) {
      const [lo] = THRESHOLDS.overnightHours;
      const hi = THRESHOLDS.overnightHours[THRESHOLDS.overnightHours.length - 1];
      push({
        id: 'overnight', kind: 'trend', severity: 'warn',
        title: 'A meaningful share of activity happens overnight',
        finding: `${pct(share)} of assistant responses (${count(night)}) land between `
          + `${String(lo).padStart(2, '0')}:00 and ${String(hi).padStart(2, '0')}:59 local time.`,
        evidence: 'Sustained small-hours activity is the signature of unattended loops, daemons, '
          + 'or scheduled jobs rather than interactive work.',
        action: 'Confirm this is intended automation. If not, reap stale daemons and check whether '
          + 'a loop is still firing.',
        command: 'ak x daemon-gc',
      });
    }
  }

  // 5 ── spend-trend. Direction of travel over the window's own days.
  const dayEntries = Object.entries(a.byDay && typeof a.byDay === 'object' ? a.byDay : {})
    .sort((x, y) => (x[0] < y[0] ? -1 : 1));
  if (dayEntries.length >= 2) {
    const half = Math.floor(dayEntries.length / 2);
    const older = dayEntries.slice(0, half).map(([, v]) => v);
    const recent = dayEntries.slice(-half).map(([, v]) => v);
    const oldAvg = mean(older, 'cost');
    const recentAvg = mean(recent, 'cost');
    if (oldAvg > 0) {
      const delta = (recentAvg - oldAvg) / oldAvg;
      if (Math.abs(delta) >= THRESHOLDS.trendMinDelta) {
        const up = delta > 0;
        push({
          id: 'spend-trend', kind: 'trend', severity: up ? 'warn' : 'ok',
          title: up ? 'Daily spend is accelerating' : 'Daily spend is falling',
          finding: `The last ${count(half)} days averaged ${usd(recentAvg)}/day against `
            + `${usd(oldAvg)}/day over the ${count(half)} days before — ${up ? 'up' : 'down'} `
            + `${pct(Math.abs(delta))}.`,
          evidence: `Sessions per day went ${mean(older, 'sessions').toFixed(0)} → `
            + `${mean(recent, 'sessions').toFixed(0)} across the same split.`,
          action: up
            ? 'Check whether a new automation, loop, or scheduled job started in the recent half.'
            : 'Whatever changed is working — keep it.',
        });
      }
    }
  }

  // 6 ── project-concentration. Where effort is pooled is where a fix multiplies.
  const projects = entriesByCost(a.byProject);
  if (projects.length && windowCost > 0) {
    const [topName, topValue] = projects[0];
    const share = num(topValue.cost) / windowCost;
    if (share > THRESHOLDS.concentrationMinShare) {
      const runnerUp = projects[1];
      push({
        id: 'project-concentration', kind: 'coach', severity: 'info',
        title: `${topName} dominates your usage`,
        finding: `${pct(share)} of API-equivalent spend (${usd(num(topValue.cost))}) and `
          + `${count(num(topValue.sessions))} sessions went to one project.`,
        evidence: runnerUp
          ? `The next largest is ${runnerUp[0]} at ${usd(num(runnerUp[1].cost))}.`
          : 'It is the only project in this window.',
        action: 'Worth a dedicated per-activity routing policy and a tighter project CLAUDE.md — '
          + 'savings there multiply across every session.',
      });
    }
  }

  // 7 ── classify-coverage. Honesty about our own confidence: an unclassified
  // residue is reported, never force-fitted to reach 100% coverage.
  const categories = a.byCategory && typeof a.byCategory === 'object' ? a.byCategory : {};
  const unclassified = num(categories.Unclassified?.sessions);
  if (unclassified > 0 && sessionCount > 0) {
    const share = unclassified / sessionCount;
    if (share > THRESHOLDS.unclassifiedMinShare) {
      push({
        id: 'classify-coverage', kind: 'coach', severity: 'info',
        title: 'A large share of sessions could not be categorised',
        finding: `${count(unclassified)} of ${count(sessionCount)} sessions (${pct(share)}) fall `
          + 'below the classifier confidence floor.',
        evidence: 'Categories come from session provenance, titles and tool mix; short or '
          + 'generically-titled sessions carry little signal, and a forced label would make the '
          + 'other categories untrustworthy too.',
        // No command: the optional LLM-labelling pass (ADR-0009 §5 Layer 3) is
        // designed but not shipped, and a dead command in a diagnostic is worse
        // than none.
        action: 'Short or generically-titled sessions are the usual cause — descriptive first '
          + 'prompts and skill-invoked sessions classify well. An optional LLM labelling pass '
          + 'is planned but not yet available.',
      });
    }
  }

  // 8 ── model-routing. DELIBERATELY NOT an upgrade nudge (rule 3, ADR-0009 §6).
  // A first-pass detector saw prev-gen spend and recommended upgrading. Grounding
  // reversed it: the vendor benchmark measures HARD tasks, a local controlled A/B
  // on a ROUTINE task measured the newer model taking 3.4× the steps and 3.7× the
  // cost for identical output, and the overthinking-tax literature reconciles the
  // two. So this fires to say "your mix is defensible" and recommends routing by
  // complexity — including, on many corpora, changing nothing.
  const prevGenCost = Object.entries(a.byModel && typeof a.byModel === 'object' ? a.byModel : {})
    .filter(([id]) => isPrevGenOpus(id))
    .reduce((acc, [, v]) => acc + num(v?.cost), 0);
  if (prevGenCost > 0 && windowCost > 0) {
    const share = prevGenCost / windowCost;
    if (share >= THRESHOLDS.prevGenMinShare) {
      const routine = sessions.filter((s) => num(s.responses) <= THRESHOLDS.premiumMaxResponses
        && num(s.minutes) <= THRESHOLDS.premiumMaxMinutes);
      const routineShare = sessions.length ? routine.length / sessions.length : 0;
      push({
        id: 'model-routing', kind: 'coach', severity: 'ok',
        title: 'Your model mix is defensible — route by complexity, not by recency',
        finding: `${pct(share)} of spend (${usd(prevGenCost)}) sits on a previous-generation Opus `
          + `model${sessions.length ? `, and ${pct(routineShare)} of your sessions are routine `
            + `(≤${THRESHOLDS.premiumMaxResponses} responses, ≤${THRESHOLDS.premiumMaxMinutes} min)` : ''}. `
          + 'On routine work the newer model is measurably more expensive, not less.',
        evidence: 'Anthropic reports Opus 5 more than doubling Opus 4.8 per task on a hard-task, '
          + 'vendor-reported benchmark; a local controlled A/B on a routine task measured Opus 5 '
          + 'taking 3.4× the steps and 3.7× the cost for the same output. Both hold — capability '
          + 'gains land on hard tasks, overthinking overhead lands on easy ones.',
        action: 'Route by task complexity: keep routine activities on the cheaper tier and reserve '
          + 'the newest model for genuinely hard work. Confirm against your own workload before '
          + 'changing anything.',
        command: 'ak x provider pick',
        sources: MODEL_ROUTING_SOURCES,
      });
    }
  }

  // 9 ── cost-per-session-spread. Names where leverage actually is. `Unclassified`
  // is excluded (it is a confidence bucket, not a kind of work) and thin categories
  // are excluded (a handful of sessions is an anecdote, not a rate).
  const rated = Object.entries(categories)
    .filter(([name, v]) => name !== 'Unclassified' && v && typeof v === 'object'
      && num(v.sessions) >= THRESHOLDS.spreadMinCategorySessions)
    .map(([name, v]) => ({ name, value: v, per: num(v.cost) / num(v.sessions) }))
    .sort((x, y) => y.per - x.per);
  if (rated.length >= 2) {
    const hi = rated[0];
    const lo = rated[rated.length - 1];
    if (hi.per > 0 && lo.per > 0 && hi.per / lo.per >= THRESHOLDS.spreadMinRatio) {
      const ratio = hi.per / lo.per;
      push({
        id: 'cost-per-session-spread', kind: 'coach', severity: 'info',
        title: `${hi.name} costs ${Math.round(ratio)}× more per session than ${lo.name}`,
        finding: `${hi.name}: ${count(num(hi.value.sessions))} sessions at ${usd2(hi.per)} each. `
          + `${lo.name}: ${count(num(lo.value.sessions))} sessions at ${usd2(lo.per)} each.`,
        evidence: sessionCount > 0 && windowCost > 0
          ? `${hi.name} is ${pct(num(hi.value.sessions) / sessionCount)} of sessions but `
            + `${pct(num(hi.value.cost) / windowCost)} of spend.`
          : `${hi.name} carries ${usd(num(hi.value.cost))} across ${count(num(hi.value.sessions))} sessions.`,
        action: `Your leverage is in ${hi.name}, not in trimming the cheap categories — a 10% `
          + `improvement there is worth more than eliminating ${lo.name} entirely.`,
      });
    }
  }

  // 10 ── high-volume-automation. High count + low unit cost + short duration is
  // the shape of a scheduled or hook-driven job. "Low cost" is measured against
  // the window's OWN mean session cost, so the rule travels between corpora.
  // Only the highest-volume qualifying category is reported, keeping ids unique.
  const windowMeanSession = sessionCount > 0 ? windowCost / sessionCount : 0;
  if (windowMeanSession > 0) {
    const ceiling = windowMeanSession * THRESHOLDS.automationMaxAvgShare;
    const candidates = Object.entries(categories)
      .filter(([name, v]) => name !== 'Unclassified' && v && typeof v === 'object'
        && num(v.sessions) >= THRESHOLDS.automationMinSessions
        && num(v.cost) / num(v.sessions) < ceiling)
      .sort((x, y) => num(y[1].sessions) - num(x[1].sessions));
    if (candidates.length) {
      const [name, value] = candidates[0];
      const runs = num(value.sessions);
      const avgCost = num(value.cost) / runs;
      const avgMinutes = num(value.minutes) / runs;
      push({
        id: 'high-volume-automation', kind: 'trend', severity: 'info',
        title: `${count(runs)} short ${name} sessions look automated`,
        finding: `${name} ran ${count(runs)} times`
          + `${sessionCount > 0 ? ` (${pct(runs / sessionCount)} of all sessions)` : ''}, averaging `
          + `${usd2(avgCost)} and ${avgMinutes.toFixed(1)} minutes each.`,
        evidence: `That is ${pct(avgCost / windowMeanSession)} of this window's mean session cost `
          + `(${usd2(windowMeanSession)}). High count, low unit cost and short duration is the shape `
          + 'of a scheduled or hook-driven job rather than interactive work.',
        action: 'Cheap individually, but confirm the cadence is intended — and that its findings '
          + 'are actually being read, or it is pure overhead.',
      });
    }
  }

  // 11 ── parallel-sessions. Summed span ÷ union span = mean concurrency while
  // anything was open. Every parallel session draws on the SAME plan limit
  // (Claude Code's own /usage panel makes the same point), so sustained
  // parallelism is how a week's allowance disappears in two days. No dollar
  // claim: parallelism shifts WHEN tokens are spent, not directly how many.
  const spanSum = num(totals.spanMinutes) * 60;
  const spanUnion = num(totals.spanUnionSeconds);
  if (spanUnion > 0 && sessionCount >= 2) {
    const factor = spanSum / spanUnion;
    if (factor >= THRESHOLDS.parallelMinFactor) {
      push({
        id: 'parallel-sessions', kind: 'trend', severity: 'info',
        title: `Sessions ran ~${factor.toFixed(1)}× in parallel`,
        finding: `Summed session time is ${Math.round(spanSum / 3600)}h against ${Math.round(spanUnion / 3600)}h `
          + `of wall-clock with anything open — on average ${factor.toFixed(1)} sessions at once.`,
        evidence: 'All sessions on a subscription share one rate-limit pool, so parallel work '
          + 'consumes the same allowance faster; queueing spreads it more evenly.',
        action: 'Keep parallelism for genuinely independent work; queue the rest, or route some '
          + 'lanes to the other host so the two pools share the load.',
        command: 'ak x provider pick',
      });
    }
  }

  // 12 ── subagent-share. Sidechain/subagent transcripts as a share of spend —
  // the local computation of the "subagent-heavy sessions" characteristic
  // Claude Code's /usage panel reports. The dollar figure is measured, but NOT
  // claimed as impact: subagent work is not waste, it is a composition fact.
  const side = sessions.filter((s) => s.sidechain === true || s.threadSource === 'subagent');
  if (side.length && windowCost > 0) {
    const spend = sumBy(side, 'cost');
    const share = spend / windowCost;
    if (share >= THRESHOLDS.sidechainMinShare) {
      push({
        id: 'subagent-share', kind: 'trend', severity: 'info',
        title: `Subagent transcripts carry ${pct(share)} of spend`,
        finding: `${count(side.length)} sidechain/subagent transcripts account for ${usd(spend)} of `
          + `this window's ${usd(windowCost)}.`,
        evidence: 'Each spawned agent runs its own requests with its own context load, so '
          + 'delegation multiplies token volume even when the main thread stays small.',
        action: 'Be deliberate about fan-out: fewer, better-briefed subagents — and a cheaper '
          + 'model for mechanical subagent roles — keep the leverage without the volume.',
      });
    }
  }

  // 13 ── long-session-share. Sessions spanning 8+ hours are usually loops,
  // daemons, or forgotten terminals rather than a sitting; their spend share
  // says how much of the window rides on unattended context.
  const long = sessions.filter((s) => num(s.minutes) >= THRESHOLDS.longSessionMinutes);
  if (long.length && windowCost > 0) {
    const spend = sumBy(long, 'cost');
    const share = spend / windowCost;
    if (share >= THRESHOLDS.longSessionMinShare) {
      push({
        id: 'long-session-share', kind: 'trend', severity: 'info',
        title: `${pct(share)} of spend sits in 8h+ sessions`,
        finding: `${count(long.length)} sessions spanned ${Math.round(THRESHOLDS.longSessionMinutes / 60)}+ hours `
          + `and carried ${usd(spend)} (${pct(share)}) of the window.`,
        evidence: 'Very long spans are the signature of background loops and left-open sessions; '
          + 'long-lived context is also the expensive kind — every turn re-reads it.',
        action: 'Confirm the long-runners are intentional; close or /clear sessions that have '
          + 'become idle context holders.',
        command: 'ak x daemon-gc',
      });
    }
  }

  // Ranked: measured dollars first (descending), then $-free findings by severity.
  // `Array.prototype.sort` is stable, so detector order breaks remaining ties.
  return found.sort((x, y) => (num(y.impact) - num(x.impact))
    || (SEVERITY_RANK[x.severity] - SEVERITY_RANK[y.severity]));
}

// ── Limit-aware findings (ADR-0010) ──────────────────────────────────────────
// Same contract and rules as detectInsights, over the /api/limits payload from
// quota.mjs instead of the transcript aggregate. Still PURE: "now" is
// `limits.generatedAt` — data, not a clock — so every firing is reproducible
// from its input. Vendor-reported percentages ARE the user's own data (rule 1):
// they are the one denominator ADR-0009 §3 said local parsing could never
// honestly invent.

/** Flatten both providers' windows into rows detectors can iterate:
 *  { host, lane, label, usedPercent, windowMinutes, resetsAt }. */
function limitWindows(limits) {
  const rows = [];
  for (const w of limits?.claude?.windows ?? []) {
    rows.push({ host: 'claude', lane: null, label: w.label ?? w.id, usedPercent: num(w.usedPercent), windowMinutes: w.windowMinutes ?? null, resetsAt: w.resetsAt ?? null });
  }
  for (const lane of limits?.codex?.lanes ?? []) {
    for (const w of lane.windows ?? []) {
      rows.push({ host: 'codex', lane: lane.name ?? lane.id, label: w.label ?? w.id, usedPercent: num(w.usedPercent), windowMinutes: w.windowMinutes ?? null, resetsAt: w.resetsAt ?? null });
    }
  }
  return rows.filter((r) => Number.isFinite(r.usedPercent));
}

// "codex codex" reads as a stutter when the default lane carries the host's
// own name — the lane is only worth naming when it distinguishes.
const hostLane = (r) => r.host + (r.lane && r.lane !== r.host ? ` ${r.lane}` : '');

/**
 * Rank findings over vendor-reported plan limits (the /api/limits payload).
 *
 * @param {{ generatedAt?: string, claude?: any, codex?: any }} [limits]
 * @param {UsageAggregate} [agg] optional transcript aggregate for composition
 *   context (currently unused by the firing rules; reserved for evidence).
 * @returns same Insight contract as detectInsights.
 */
export function detectLimitInsights(limits, agg) { // eslint-disable-line no-unused-vars
  const rows = limitWindows(limits);
  const nowMs = Date.parse(limits?.generatedAt ?? '') || null;
  const found = [];
  const push = (insight) => found.push({ command: null, impact: null, ...insight });

  // A ── limit-pacing: consumption running ahead of the window's own clock.
  // elapsedShare needs both resetsAt and the window duration; a window missing
  // either stays silent rather than pacing against a guess.
  for (const r of rows) {
    if (!nowMs || !Number.isFinite(r.resetsAt) || !Number.isFinite(r.windowMinutes) || r.windowMinutes <= 0) continue;
    const windowMs = r.windowMinutes * 60_000;
    const remainingMs = r.resetsAt * 1000 - nowMs;
    if (remainingMs <= 0 || remainingMs > windowMs) continue; // reset passed, or clock skew
    const elapsedShare = 1 - remainingMs / windowMs;
    const usedShare = r.usedPercent / 100;
    if (r.usedPercent < THRESHOLDS.pacingMinUsedPercent || elapsedShare <= 0) continue;
    if (usedShare < elapsedShare * THRESHOLDS.pacingLeadFactor) continue;
    const remainH = Math.round(remainingMs / 3_600_000);
    const projected = Math.round((usedShare / elapsedShare) * 100);
    push({
      id: `limit-pacing-${r.host}${r.lane ? `-${String(r.lane).toLowerCase().replace(/[^a-z0-9]+/g, '-')}` : ''}-${r.windowMinutes}`.replace(/-+$/, ''),
      kind: 'trend', severity: usedShare >= 0.9 ? 'warn' : 'info',
      title: `${hostLane(r)} ${r.label} window is ahead of pace at ${Math.round(r.usedPercent)}%`,
      finding: `${Math.round(r.usedPercent)}% used with ${pct(1 - elapsedShare)} of the window still to run `
        + `(${remainH}h to reset) — on current pace that projects to ~${projected}% of the limit.`,
      evidence: `Vendor-reported utilization against the window's own elapsed time: `
        + `${Math.round(r.usedPercent)}% consumed vs ${pct(elapsedShare)} elapsed.`,
      action: 'Front-load what matters before the cap, shift routine work to the other host or a '
        + 'cheaper lane, and let non-urgent automation wait for the reset.',
      command: 'ak x provider pick',
    });
  }

  // B ── cross-host-arbitrage: one host's window high while the other host has
  // clear headroom. This is the dual-host case ak exists for.
  const high = rows.filter((r) => r.usedPercent >= THRESHOLDS.arbitrageHighPercent);
  for (const h of high) {
    const spare = rows.filter((r) => r.host !== h.host && r.usedPercent <= THRESHOLDS.arbitrageLowPercent);
    if (!spare.length) continue;
    const best = spare.sort((x, y) => x.usedPercent - y.usedPercent)[0];
    push({
      id: `cross-host-arbitrage-${h.host}`,
      kind: 'coach', severity: h.usedPercent >= 90 ? 'warn' : 'info',
      title: `${hostLane(h)} is at ${Math.round(h.usedPercent)}% while ${hostLane(best)} sits at ${Math.round(best.usedPercent)}%`,
      finding: `The ${h.label} window on ${hostLane(h)} has ${Math.round(100 - h.usedPercent)}% headroom left; `
        + `${hostLane(best)} (${best.label}) is ${Math.round(best.usedPercent)}% used.`,
      evidence: 'Both hosts are enabled on this machine and their plan pools are independent — '
        + 'work routed to the idle pool costs nothing against the strained one.',
      action: 'Shift routine and mechanical activities to the host with headroom in the '
        + 'per-activity routing policy; reasoning-critical work can stay put.',
      command: 'ak x provider pick',
    });
    break; // one arbitrage finding is guidance; one per hot window is nagging
  }

  // C ── codex-reset-credits: a granted, expiring resource the user may not
  // know they hold. Redemption is deliberately left to codex's own /usage UI —
  // consuming a finite grant is not a diagnostic's call to make.
  const rc = limits?.codex?.resetCredits;
  if (rc && Number.isFinite(rc.availableCount) && rc.availableCount > 0) {
    const expiries = (rc.credits ?? [])
      .filter((c) => c && c.status === 'available' && Number.isFinite(c.expiresAt))
      .map((c) => c.expiresAt)
      .sort((a, b) => a - b);
    const soonest = expiries.length && nowMs ? Math.max(0, Math.round((expiries[0] * 1000 - nowMs) / 86_400_000)) : null;
    push({
      id: 'codex-reset-credits', kind: 'coach', severity: 'info',
      title: `${count(rc.availableCount)} Codex rate-limit reset credit${rc.availableCount === 1 ? '' : 's'} available`,
      finding: `Codex has granted ${count(rc.availableCount)} full rate-limit reset${rc.availableCount === 1 ? '' : 's'}`
        + `${soonest !== null ? `; the soonest expires in ~${count(soonest)} day${soonest === 1 ? '' : 's'}` : ''}.`,
      evidence: 'Reported by codex app-server (account/rateLimits/read → rateLimitResetCredits); '
        + 'an unredeemed credit that expires is simply lost.',
      action: 'If a Codex window is pinned at its cap, redeem a reset from codex’s own /usage '
        + 'screen. This panel never consumes one on your behalf.',
    });
  }

  return found.sort((x, y) => (num(y.impact) - num(x.impact))
    || (SEVERITY_RANK[x.severity] - SEVERITY_RANK[y.severity]));
}
