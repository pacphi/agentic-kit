// usage-coaching.mjs — pure derivation: findings → coaching cards (spec §5),
// deterministic adoption detection, and outcome measurement (spec §6.4). NO
// I/O and NO clock reads beyond the `now` a caller passes in — the store
// (usage-outcome-ledger.mjs) is a separate, small-I/O module that imports
// FROM here, never the reverse.
//
// v1 rules are RULE-DERIVED, not inferred (spec §9 step 5; §6.3 inference
// refresh is a later wave). Every number a card states is read off one of the
// three inputs below — `promptPatterns` (the aggregate's opt-in repetition
// projection, usage-aggregate.mjs's buildPromptPatterns), `promptsByHost` (the
// same aggregate's per-host prompt figures), and `insights` (detectInsights'
// output, already computed on the aggregate the caller read) — never invented,
// and never a text a person typed: clusters are named from the curated
// vocabulary (usage-prompt-vocabulary.mjs), not from prompt content.
//
// EVIDENCE HONESTY: a rule whose inputs are structurally absent (no
// `promptPatterns` at all, no `promptsByHost` at all) yields NO card — absent
// is not the same claim as zero. A rule whose inputs are PRESENT but empty (a
// clusters array with no matching cluster, an empty promptsByHost object)
// legitimately measures zero, which `currentEvidenceFor` reports as `count: 0`
// — that distinction is what makes outcome measurement possible: a
// recommendation that fully worked collapses its cluster out of existence,
// and that has to read as "0", not as "unmeasured".
import { createHash } from 'node:crypto';
import { SEED_PATTERNS } from './usage-prompt-vocabulary.mjs';
// The SAME host-threshold logic the supervision-tap-share detector fires on
// (Fix round 1, I-4): progress-report-taps must measure the identical
// population it displays, not re-derive a looser one and drift from the
// detector — reused, never reimplemented, so the two can never disagree.
// (The evidence object stays enum-only rather than reusing
// tapComparisonClause's own free-text sentence — see progressReportEvidence's
// `comparator` field below — so only tapRowsOverThreshold is needed here.)
import { tapRowsOverThreshold } from './usage-insights.mjs';

// ── evidence hashing (spec §5, §6.2) ────────────────────────────────────────

/** Sort every object's keys, recursively, so two callers who built the same
 *  evidence in a different field order still hash identically. Arrays keep
 *  their order — order is part of an array's meaning, unlike an object's key
 *  order, which is not. */
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key]);
    return out;
  }
  return value;
}

/**
 * A stable 16-hex-char sha256 over a canonical JSON serialization (sorted
 * keys, no whitespace) of `input`. Same inputs ⇒ same hash, on this process or
 * any other; any count change anywhere in `input` ⇒ a different hash — which
 * is the whole mechanism the ledger's staleness/decay logic rests on.
 *
 * @param {unknown} input
 * @returns {string}
 */
export function evidenceHash(input) {
  const json = JSON.stringify(canonicalize(input ?? {}));
  return createHash('sha256').update(json).digest('hex').slice(0, 16);
}

// ── thresholds (exported so tests pin the exact boundary the rules use) ────

export const RELEASE_RITUAL_MIN_COUNT = 5;
export const COMMIT_PUSH_MIN_COUNT = 5;
export const REASK_DELTA_MIN_PAIRS = 10;
export const PERSONA_LIBRARY_MIN_COUNT = 10;

/** Adoption-by-collapse and outcome-improvement share this reasoning but not
 *  this exact number: collapse is the ADOPTION signal (spec §6.4 — "the
 *  target cluster's recurrence collapsed"), a stricter bar than "improved"
 *  (measureOutcome below), which only asks whether the count moved down at
 *  all. A card can be adopted by CLAUDE.md/skill-dir detection long before its
 *  recurrence collapses 80%, and outcome measurement has to track THAT case
 *  too. */
export const ADOPTION_COLLAPSE_RATIO = 0.2;

/** How long an adopted-but-not-improving card is given before it is retired
 *  with its refutation shown (spec §6.4). */
export const OUTCOME_MIN_DAYS = 14;
export const DAY_MS = 86_400_000;

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
 *  sibling effort this card points at (spec §8) is scoped to Codex by name
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
      // effort (spec §8), not an instruction the operator can run today.
      kind: 'link',
      text: 'Sibling effort, tracked separately (prompts-view spec §8): a managed Codex '
        + 'role-fragment library, the Codex analogue of `.claude/agents/`. Not yet built — this '
        + 'card is a pointer to that effort, not something to run today.',
    },
  };
}

/** Fix round 1, I-7: adoption-by-collapse is opt-in per rule. Spec §6.4's
 *  collapse clause is about "the TARGET CLUSTER's recurrence" — the pattern
 *  the card asks the operator to stop repeating — which is the two cluster
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
const RULES = [
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

/**
 * @typedef {{ id: string, title: string, finding: string, try: string,
 *   basis: string, evidenceHash: string, generatedAt: string,
 *   draft?: { kind: 'claude-md-line'|'skill-skeleton'|'link', text: string } }} CoachingCard
 */

/**
 * The deterministic v1 card set (spec §5), each card only when its evidence
 * condition holds. Pure: no I/O, no clock read beyond `now`.
 *
 * @param {{ promptPatterns: object|null, promptBaselines: object|null,
 *   promptsByHost: object|null, insights: Array<object>|null, now: number }} input
 * @returns {Array<CoachingCard>} cards, in RULES order
 */
export function deriveCards({ promptPatterns, promptBaselines, promptsByHost, insights, now }) {
  const ctx = {
    promptPatterns: promptPatterns ?? null,
    promptBaselines: promptBaselines ?? null,
    promptsByHost: promptsByHost ?? null,
    insights: Array.isArray(insights) ? insights : [],
  };
  const cards = [];
  for (const rule of RULES) {
    const evidence = rule.evidence(ctx);
    if (!evidence || !rule.meetsBar(evidence, ctx)) continue;
    cards.push(rule.card(evidence, now, ctx));
  }
  return cards;
}

/**
 * The CURRENT raw evidence for one card id, regardless of whether it still
 * clears the propose bar — the number adoption-by-collapse and outcome
 * measurement compare against. `null` only when the underlying data
 * structure is structurally absent for this rule (see the module doc);
 * otherwise a real object with at least a `count`.
 *
 * `currentPatterns` carries the SAME ctx shape `deriveCards` takes minus
 * `now` — `{ promptPatterns, promptsByHost, promptBaselines, insights }` —
 * despite the parameter's name (kept verbatim per the ledger contract this
 * satisfies): the two-hosts, per-host-taps and baseline-comparison rules
 * need `promptsByHost`/`promptBaselines`/`insights` too, not only the
 * cluster/reAsks halves the name suggests.
 *
 * @param {string} id
 * @param {{ promptPatterns?: object|null, promptsByHost?: object|null, promptBaselines?: object|null, insights?: Array<object>|null }} currentPatterns
 */
export function currentEvidenceFor(id, currentPatterns) {
  const rule = RULES.find((r) => r.id === id);
  if (!rule) return null;
  const ctx = {
    promptPatterns: currentPatterns?.promptPatterns ?? null,
    promptsByHost: currentPatterns?.promptsByHost ?? null,
    promptBaselines: currentPatterns?.promptBaselines ?? null,
    insights: Array.isArray(currentPatterns?.insights) ? currentPatterns.insights : [],
  };
  return rule.evidence(ctx);
}

const cardSlug = (id) => id.replace(/-skill$/, '');

/**
 * @typedef {{ id: string, evidenceHash: string,
 *   status: 'proposed'|'adopted'|'dismissed'|'expired'|'retired',
 *   generatedAt: string, statusAt: string, baseline?: { count?: number },
 *   outcome?: {improved:boolean, deltaText:string, measuredAt?:string}|null,
 *   refutation?: string|null, dismissCount?: number }} LedgerRecord
 */

/**
 * Deterministic adoption predicates (spec §6.4), evaluated in the order
 * spec'd: a matching CLAUDE.md line, then a matching skill directory, then
 * "the target recurrence collapsed" (current count ≤ ADOPTION_COLLAPSE_RATIO
 * of the count recorded when this card was first proposed). Pure — every
 * input is caller-supplied.
 *
 * @param {CoachingCard} card a card from `deriveCards`
 * @param {{ claudeMdTexts?: string[], skillDirs?: string[],
 *   currentPatterns?: object, ledgerRecord?: LedgerRecord|null }} [inputs]
 * @returns {{ adopted: boolean, via: 'claude-md'|'skill-dir'|'collapse'|null }}
 */
export function detectAdoption(card, { claudeMdTexts, skillDirs, currentPatterns, ledgerRecord } = {}) {
  if (!card) return { adopted: false, via: null };

  if (card.draft?.kind === 'claude-md-line') {
    const line = String(card.draft.text ?? '').trim();
    const texts = Array.isArray(claudeMdTexts) ? claudeMdTexts : [];
    if (line && texts.some((t) => typeof t === 'string' && t.includes(line))) {
      return { adopted: true, via: 'claude-md' };
    }
  }

  if (card.draft?.kind === 'skill-skeleton') {
    const slug = cardSlug(card.id);
    const dirs = Array.isArray(skillDirs) ? skillDirs : [];
    if (dirs.includes(slug)) return { adopted: true, via: 'skill-dir' };
  }

  // Fix round 1, I-7: collapse is adoption evidence only for rules about a
  // recurring PATTERN the operator stops repeating — not for rules whose
  // "count" is a derived statistic that can drop for unrelated reasons.
  const rule = RULES.find((r) => r.id === card.id);
  if (rule?.collapseIsAdoption) {
    const baselineCount = Number(ledgerRecord?.baseline?.count);
    if (Number.isFinite(baselineCount) && baselineCount > 0) {
      const fresh = currentEvidenceFor(card.id, currentPatterns ?? {});
      const currentCount = Number(fresh?.count);
      if (Number.isFinite(currentCount) && currentCount <= baselineCount * ADOPTION_COLLAPSE_RATIO) {
        return { adopted: true, via: 'collapse' };
      }
    }
  }

  return { adopted: false, via: null };
}

/**
 * Current vs. the recorded baseline count, for an ADOPTED ledger record.
 * `improved` is a strict decrease — any real drop counts, since retirement
 * (not this function) is what applies the 14-day patience window. `null`
 * evidence (the underlying structure vanished, e.g. no fingerprint layer at
 * all this pass) reports as un-improved with an honest "not measured" delta
 * rather than a fabricated number.
 *
 * @param {{ id: string, baseline?: { count?: number } }} record
 * @param {object} currentPatterns same shape `currentEvidenceFor` takes
 * @returns {{ improved: boolean, deltaText: string }}
 */
export function measureOutcome(record, currentPatterns) {
  const baselineCount = Number(record?.baseline?.count);
  const fresh = currentEvidenceFor(record?.id, currentPatterns ?? {});
  const currentCount = Number(fresh?.count);
  if (!Number.isFinite(baselineCount) || !Number.isFinite(currentCount)) {
    return { improved: false, deltaText: 'not measured this pass — evidence unavailable' };
  }
  return { improved: currentCount < baselineCount, deltaText: `${baselineCount} → ${currentCount} since adoption` };
}
