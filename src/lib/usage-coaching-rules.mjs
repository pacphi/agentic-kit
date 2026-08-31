// usage-coaching-rules.mjs — the six v1 coaching rules (METRICS.md §22): for each,
// an evidence extractor, a propose-bar predicate, and a card text builder.
// Split out of usage-coaching.mjs on the status.mjs/status/*.mjs precedent
// once that file crossed the repo's file-size limit for a new lib. The
// ENGINE — deriveCards, currentEvidenceFor, detectAdoption, measureOutcome —
// stays in usage-coaching.mjs, which imports `RULES` from here. `evidenceHash`
// (needed by the card builders below) lives in the leaf module
// usage-evidence-hash.mjs, imported directly from there rather than back
// through usage-coaching.mjs (Fix round 3 — that indirection was a real
// engine<->rules import cycle; this module now has no dependency on
// usage-coaching.mjs at all). No behavior changed by either split — every
// export here is verbatim from the original usage-coaching.mjs.
import { SEED_PATTERNS } from './usage-prompt-vocabulary.mjs';
import { tapRowsOverThreshold } from './usage-insights.mjs';
import { evidenceHash } from './usage-evidence-hash.mjs';

// ── thresholds (exported so tests pin the exact boundary the rules use) ────

export const RELEASE_RITUAL_MIN_COUNT = 5;
export const COMMIT_PUSH_MIN_COUNT = 5;
export const REASK_DELTA_MIN_PAIRS = 10;
export const PERSONA_LIBRARY_MIN_COUNT = 10;

function seedName(id) {
  const seed = SEED_PATTERNS.find((s) => s.id === id);
  return seed ? seed.name : null;
}

// Resolved once, from the vocabulary's own registry — never a hand-copied
// string. If the vocabulary ever renames these seeds, this rule renames with
// it instead of silently going quiet.
const RELEASE_RITUAL_NAME = seedName('release-ritual');
const COMMIT_PUSH_NAME = seedName('commit-and-push');

/** The one cluster this rule is about, or `null`. Matched on the PUBLISHED
 *  label (name + seed source) — `promptClusterRow` (usage-aggregate.mjs) never
 *  ships the vocabulary's internal seed id, so the name is the only handle a
 *  consumer downstream of the aggregate has. */
function findSeedCluster(clusters, name) {
  if (!Array.isArray(clusters)) return null;
  return clusters.find((c) => c?.label?.source === 'seed' && c?.label?.name === name) ?? null;
}

// ── per-rule evidence extraction ────────────────────────────────────────────
//
// Each `xEvidence(ctx)` ALWAYS returns the current, real numbers for its
// metric when the underlying data structure exists — even a genuine zero —
// and returns `null` only when the structure itself is absent (no
// `promptPatterns`, no `promptsByHost`). This is the single source both
// `deriveCards` (gated by `xMeetsBar`) and the outcome/adoption machinery
// (ungated — it wants the raw current count, whether or not it still clears
// the propose bar) read from, so the two can never disagree about what "the
// current count" means for a given card id.

function clusterEvidence(ctx, name) {
  const pp = ctx.promptPatterns;
  if (!pp || !Array.isArray(pp.clusters)) return null; // no fingerprint layer at all: absent, not zero
  const cluster = findSeedCluster(pp.clusters, name);
  return cluster
    ? { count: cluster.count, clusterKey: cluster.key, sessions: cluster.sessions, days: cluster.days }
    : { count: 0, clusterKey: null, sessions: 0, days: 0 }; // measured: no such cluster right now
}

function releaseRitualEvidence(ctx) { return clusterEvidence(ctx, RELEASE_RITUAL_NAME); }
function commitPushEvidence(ctx) { return clusterEvidence(ctx, COMMIT_PUSH_NAME); }

function reaskDeltaEvidence(ctx) {
  const pp = ctx.promptPatterns;
  if (!pp || !pp.reAsks) return null;
  return { count: Number(pp.reAsks.pairCount) || 0, sessionCount: Number(pp.reAsks.sessionCount) || 0 };
}

/** Codex vs Claude, on the two per-host figures the host-prompt-asymmetry
 *  detector itself compares (usage-insights.mjs's p90Spread/persona check),
 *  read fresh here rather than parsed out of that detector's prose — the
 *  detector's `Insight` carries only rendered text, never structured numbers.
 *  `count`/`otherCount` track persona openers (the cleaner integer signal for
 *  collapse tracking); `p90Host`/`p90Other` ride along for the ratio half of
 *  the firing rule and for the card's own basis text. */
function completionCriteriaEvidence(ctx) {
  const byHost = ctx.promptsByHost;
  if (!byHost) return null;
  const codex = byHost.codex, claude = byHost.claude;
  if (!codex || !claude) return null;
  return {
    count: Number(codex.personaOpeners) || 0, otherCount: Number(claude.personaOpeners) || 0,
    host: 'codex', otherHost: 'claude',
    p90Host: Number.isFinite(codex.p90TypedTokens) ? codex.p90TypedTokens : null,
    p90Other: Number.isFinite(claude.p90TypedTokens) ? claude.p90TypedTokens : null,
  };
}

/** The supervision-tap count summed over the SAME host set the
 *  supervision-tap-share detector fired on — `tapRowsOverThreshold` re-run
 *  fresh against `ctx`, not the whole of `promptsByHost` (Fix round 1, I-4:
 *  the displayed basis and the ledger baseline must be the same quantity, and
 *  summing every host — including ones under their own threshold — made them
 *  different numbers with nothing connecting them).
 *
 * `comparator` records WHICH rule justified each qualifying row — `'baseline'`
 * when every row cleared its own trailing p75, `'floor'` when every row fell
 * back to the absolute floor (no personal baseline yet), `'mixed'` when both
 * occur — a fixed three-value enum, safe for the ledger, that lets the card
 * state which comparator actually applied instead of asserting "your own
 * trailing baseline" when a floor fallback is what actually fired.
 *
 * DELIBERATELY NUMBERS-AND-ENUMS-ONLY: this object becomes the ledger's
 * `baseline` snapshot (usage-outcome-ledger.mjs), which may never carry free
 * text — not even the detector's own prose, which is safe to DISPLAY but is
 * still a string blob with no place in a persisted record. */
function progressReportEvidence(ctx) {
  const insight = (ctx.insights ?? []).find((i) => i?.id === 'supervision-tap-share');
  if (!insight) return null;
  if (!ctx.promptsByHost) return null;
  const rows = tapRowsOverThreshold({ promptsByHost: ctx.promptsByHost, promptBaselines: ctx.promptBaselines });
  if (!rows.length) return null; // the insight fired on a pass this ctx cannot reproduce (e.g. a stale snapshot)
  const taps = rows.reduce((n, r) => n + r.taps, 0);
  const withBaseline = rows.filter((r) => r.baseline !== null).length;
  const comparator = withBaseline === rows.length ? 'baseline' : withBaseline === 0 ? 'floor' : 'mixed';
  return { count: taps, hosts: rows.map((r) => r.host).sort(), comparator };
}

/** Codex specifically (Fix round 1, I-3) — not "whichever host leads". The
 *  sibling effort this card points at (tracked separately, not part of this
 *  build) is scoped to Codex by name
 *  ("the Codex analogue of `.claude/agents/`"); generalizing the HOST while
 *  the RECOMMENDATION TEXT stayed Codex-shaped produced wrong advice on a
 *  Claude-leading corpus (a card whose id says codex, whose rendered text
 *  said claude, and whose draft pointed at a command that manages hosts and
 *  providers, not prompt fragments). A Claude-leading corpus now produces no
 *  card at all — honest, since Claude already has `.claude/agents/`. */
function roleLibraryEvidence(ctx) {
  const byHost = ctx.promptsByHost;
  if (!byHost || !byHost.codex) return null; // no codex data at all this window: absent, not zero
  return { count: Number(byHost.codex.personaOpeners) || 0, host: 'codex' };
}

// ── per-rule firing bar (propose gate only — never applied to the raw
// evidence current/outcome machinery reads) ─────────────────────────────────

const releaseRitualMeetsBar = (e) => e.count >= RELEASE_RITUAL_MIN_COUNT;
const commitPushMeetsBar = (e) => e.count >= COMMIT_PUSH_MIN_COUNT;
const reaskDeltaMeetsBar = (e) => e.count >= REASK_DELTA_MIN_PAIRS;

/** The same 1.5× ratio the host-prompt-asymmetry detector itself requires
 *  (usage-insights.mjs's `THRESHOLDS.asymmetryMinRatio`) — Fix round 1, M-4:
 *  a bare `> 1` fired on a one-token difference, rendering "Codex prompts run
 *  longer" when the measured ratio did not clear the bar the insight this
 *  card leans on actually uses. */
const COMPLETION_CRITERIA_LENGTH_RATIO = 1.5;

function completionCriteriaMeetsBar(e, ctx) {
  const asymmetryPresent = (ctx.insights ?? []).some((i) => i?.id === 'host-prompt-asymmetry');
  if (!asymmetryPresent) return false;
  const personaFavorsCodex = e.count > e.otherCount;
  const lengthFavorsCodex = e.p90Host != null && e.p90Other > 0
    && e.p90Host / e.p90Other >= COMPLETION_CRITERIA_LENGTH_RATIO;
  return personaFavorsCodex || lengthFavorsCodex;
}
const progressReportMeetsBar = () => true; // the insight-presence gate already ran inside rawEvidence
const roleLibraryMeetsBar = (e) => e.count >= PERSONA_LIBRARY_MIN_COUNT;

// ── card text builders ──────────────────────────────────────────────────────

function releaseRitualSkillDraft() {
  return '---\n'
    + 'name: release-ritual\n'
    + 'description: Capture your release steps so they are loaded, not retyped.\n'
    + '---\n\n'
    + '# Release ritual\n\n'
    + 'This skeleton was generated from a recurring PATTERN, not from anything you typed —\n'
    + 'fill in your project\'s actual sequence below.\n\n'
    + '## When to use this\n\n'
    + 'Whenever you are about to cut a release: version bump, changelog, tag, publish, verify.\n\n'
    + '## Steps\n\n'
    + '1. ...\n'
    + '2. ...\n'
    + '3. ...\n';
}

function releaseRitualSkillCard(e, now) {
  const evidence = { id: 'release-ritual-skill', ...e };
  return {
    id: 'release-ritual-skill',
    // §4.5 association: this card is about ONE specific cluster (its seed match),
    // so it publishes that cluster's key and names no kind.
    clusterKey: e.clusterKey ?? null, targetKind: null,
    title: 'The release ritual is still muscle memory',
    finding: `"${RELEASE_RITUAL_NAME}" recurred ${e.count} times across ${e.sessions} sessions and `
      + `${e.days} days — a procedure retyped instead of reused.`,
    try: 'Capture the steps as a repo skill, so the ritual is loaded next time instead of retyped.',
    basis: `${e.count} recurrences across ${e.sessions} sessions, ${e.days} days.`,
    evidenceHash: evidenceHash(evidence),
    generatedAt: new Date(now).toISOString(),
    draft: { kind: 'skill-skeleton', text: releaseRitualSkillDraft() },
  };
}

function commitPushDraft() {
  return "Once a change is verified (tests green, build clean), commit and push it "
    + 'without waiting to be asked again.';
}

function commitPushClaudeMdCard(e, now) {
  const evidence = { id: 'commit-push-claude-md', ...e };
  return {
    id: 'commit-push-claude-md',
    clusterKey: e.clusterKey ?? null, targetKind: null, // §4.5: cluster-specific card
    title: 'Commit-and-push is retyped, not remembered',
    finding: `"${COMMIT_PUSH_NAME}" recurred ${e.count} times across ${e.sessions} sessions and `
      + `${e.days} days — a one-line habit the agent could apply on its own.`,
    try: 'Add one line to CLAUDE.md so the agent commits and pushes once a change is verified, '
      + 'instead of waiting to be told each time.',
    basis: `${e.count} recurrences across ${e.sessions} sessions, ${e.days} days.`,
    evidenceHash: evidenceHash(evidence),
    generatedAt: new Date(now).toISOString(),
    draft: { kind: 'claude-md-line', text: commitPushDraft() },
  };
}

function reaskDeltaCard(e, now) {
  const evidence = { id: 'reask-delta', ...e };
  return {
    id: 'reask-delta',
    // §4.5 association: kind-level, not cluster-specific — it addresses the
    // derived `reask` kind wherever it appears, so the client joins it by kind.
    clusterKey: null, targetKind: 'reask',
    title: 'The same ask lands twice, often',
    finding: `${e.count} prompts were asked again inside the same session this window, across `
      + `${e.sessionCount} session${e.sessionCount === 1 ? '' : 's'} — the first ask did not land.`,
    try: 'State the acceptance criteria in the first ask, so a re-ask is not needed to get there.',
    basis: `${e.count} re-ask pairs across ${e.sessionCount} sessions this window.`,
    evidenceHash: evidenceHash(evidence),
    generatedAt: new Date(now).toISOString(),
  };
}

/** Renders ONLY the arm(s) that actually fired (Fix round 1, M-4) —
 *  recomputed here rather than threaded from `meetsBar`, but from the exact
 *  same two comparisons, so it can never disagree with why the card exists.
 *  A one-arm fire (e.g. personas favor codex, length does not clear
 *  COMPLETION_CRITERIA_LENGTH_RATIO) must never render the OTHER arm's claim
 *  — that was the bug: "Codex prompts run longer" printed unconditionally
 *  even when the measured ratio (codex 273 vs claude 322 tokens) ran the
 *  other way. */
function completionCriteriaCard(e, now) {
  const evidence = { id: 'codex-completion-criteria', ...e };
  const personaFavorsCodex = e.count > e.otherCount;
  const lengthFavorsCodex = e.p90Host != null && e.p90Other > 0
    && e.p90Host / e.p90Other >= COMPLETION_CRITERIA_LENGTH_RATIO;
  const basisParts = [];
  if (personaFavorsCodex) basisParts.push(`${e.count} persona openers on codex vs ${e.otherCount} on claude`);
  if (lengthFavorsCodex) basisParts.push(`p90 typed length ${e.p90Host} tokens on codex vs ${e.p90Other} on claude`);
  const findingArm = personaFavorsCodex && lengthFavorsCodex
    ? 'retypes more role assignments and runs measurably longer prompts than Claude does'
    : personaFavorsCodex ? 'retypes more role assignments than Claude does'
      : 'runs measurably longer prompts than Claude does';
  return {
    id: 'codex-completion-criteria',
    // §4.5: host-level (Codex vs Claude asymmetry) — maps to neither a cluster
    // nor a derived kind, so it is deferred from the pattern table in v1.
    clusterKey: null, targetKind: null,
    title: 'Codex needs the finish line stated up front',
    finding: `Codex ${findingArm} — a pattern consistent with not being told what "done" looks like `
      + 'up front, measured from prompt shape alone.',
    try: 'Tell Codex what "done" looks like in the first prompt — explicit completion criteria, '
      + 'not steering after the fact.',
    basis: `${basisParts.join('; ')}.`,
    evidenceHash: evidenceHash(evidence),
    generatedAt: new Date(now).toISOString(),
  };
}

/** The comparator clause names WHICH rule actually fired (Fix round 1, I-4
 *  extended) — never asserts "your own trailing baseline" when the floor
 *  fallback is what fired, mirroring `tapComparisonClause`'s own wording so
 *  the CLI/dashboard's language matches the Findings tab's for the same
 *  underlying rule. */
function progressReportComparatorText(e) {
  if (e.comparator === 'baseline') return 'against your own trailing baseline';
  if (e.comparator === 'floor') return 'against the floor used while there is no personal baseline yet';
  return 'against the threshold each host was judged against';
}

function progressReportCard(e, now) {
  const evidence = { id: 'progress-report-taps', ...e };
  const hostsText = e.hosts.join(', ');
  return {
    id: 'progress-report-taps',
    clusterKey: null, targetKind: 'tap', // §4.5: addresses the tap kind
    title: 'You are tapping for progress the agent already has',
    finding: `Supervision taps on ${hostsText} are elevated ${progressReportComparatorText(e)} — some `
      + 'of that is you checking on progress the agent could have volunteered.',
    try: 'Have the agent post an unprompted progress update at natural checkpoints (before/after each '
      + 'major step), so a check-in tap is not needed.',
    basis: `${e.count} supervision taps recorded across ${hostsText} this window.`,
    evidenceHash: evidenceHash(evidence),
    generatedAt: new Date(now).toISOString(),
  };
}

function roleLibraryCard(e, now) {
  const evidence = { id: 'codex-role-library', ...e };
  return {
    id: 'codex-role-library',
    clusterKey: null, targetKind: 'persona', // §4.5: addresses the role-preamble kind

    title: 'A role gets retyped by hand on Codex',
    // No superlative (Fix round 1, M-5): "the largest measured pattern" was a
    // fact about the RESEARCH corpus, not this operator's — nothing here
    // ranks this recurrence against anything of theirs.
    finding: `${e.count} persona/role assignments were retyped by hand on Codex this window — a `
      + 'candidate for a managed prompt-fragment library.',
    try: 'Move the retyped role assignment into a managed prompt-fragment library for Codex '
      + 'workers, instead of retyping it each session.',
    basis: `${e.count} persona openers retyped on Codex.`,
    evidenceHash: evidenceHash(evidence),
    generatedAt: new Date(now).toISOString(),
    draft: {
      // Fix round 1, I-3: `ak host pick` manages hosts/providers, not prompt
      // fragments — pointing there was a misdirection. The library itself
      // does not exist yet; this draft is a pointer to the tracked sibling
      // effort, not an instruction the operator can run today.
      kind: 'link',
      text: 'Sibling effort, tracked separately: a managed Codex '
        + 'role-fragment library, the Codex analogue of `.claude/agents/`. Not yet built — this '
        + 'card is a pointer to that effort, not something to run today.',
    },
  };
}

/** Fix round 1, I-7: adoption-by-collapse is opt-in per rule. The collapse
 *  clause (METRICS.md §22) is about "the TARGET CLUSTER's recurrence" — the
 *  pattern the card asks the operator to stop repeating — which is the two cluster
 *  cards and reask-delta (collapsing the re-ask pairs IS the intended
 *  effect of stating acceptance criteria up front). The three
 *  statistic-backed cards (codex-completion-criteria's persona/length
 *  comparison, progress-report-taps' tap volume, codex-role-library's
 *  persona count) can drop for reasons that have nothing to do with the
 *  recommendation — recording that as "adopted" would be a fabricated
 *  causal claim. Those three keep the CLAUDE.md/skill-dir routes only;
 *  codex-role-library has neither (no draft kind matches those routes and
 *  collapse is now off), so it has NO adoption route at all — honest: it
 *  stays proposed until dismissed or expired, never auto-adopted.
 *  @type {ReadonlyArray<{id: string, evidence: Function, meetsBar: Function, card: Function, collapseIsAdoption: boolean}>} */
export const RULES = [
  { id: 'release-ritual-skill', evidence: releaseRitualEvidence, meetsBar: releaseRitualMeetsBar, card: releaseRitualSkillCard, collapseIsAdoption: true },
  { id: 'commit-push-claude-md', evidence: commitPushEvidence, meetsBar: commitPushMeetsBar, card: commitPushClaudeMdCard, collapseIsAdoption: true },
  { id: 'reask-delta', evidence: reaskDeltaEvidence, meetsBar: reaskDeltaMeetsBar, card: reaskDeltaCard, collapseIsAdoption: true },
  { id: 'codex-completion-criteria', evidence: completionCriteriaEvidence, meetsBar: completionCriteriaMeetsBar, card: completionCriteriaCard, collapseIsAdoption: false },
  { id: 'progress-report-taps', evidence: progressReportEvidence, meetsBar: progressReportMeetsBar, card: progressReportCard, collapseIsAdoption: false },
  { id: 'codex-role-library', evidence: roleLibraryEvidence, meetsBar: roleLibraryMeetsBar, card: roleLibraryCard, collapseIsAdoption: false },
];

/** Exposed only for direct per-rule unit tests, the same precedent as
 *  usage-insights.mjs's `_detectors`. Not part of the public API. */
export const _rules = Object.fromEntries(RULES.map((r) => [r.id, r]));
