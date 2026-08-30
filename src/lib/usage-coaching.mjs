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

/** The total supervision-tap count across every host this window — a real,
 *  always-computable sum over `promptsByHost`, used only to track whether tap
 *  volume is trending down after this card is adopted.
 *
 * DELIBERATELY NUMBERS-ONLY: this object becomes the ledger's `baseline`
 * snapshot (usage-outcome-ledger.mjs), and the ledger may never carry free
 * text — not even the detector's own prose, which is safe to DISPLAY (it is
 * template-and-numbers, never a prompt) but is still a string blob with no
 * place in a persisted record. The matched insight's `finding` is looked up
 * again, separately, only at card-BUILD time (progressReportCard, which
 * receives `ctx` directly) — never threaded through evidence/baseline. */
function progressReportEvidence(ctx) {
  const insight = (ctx.insights ?? []).find((i) => i?.id === 'supervision-tap-share');
  if (!insight) return null;
  const byHost = ctx.promptsByHost;
  if (!byHost) return null;
  let taps = 0;
  for (const host of Object.keys(byHost)) taps += Number(byHost[host]?.taps) || 0;
  return { count: taps };
}

/** The host with the MOST retyped persona openers — "on one host" per spec,
 *  not specifically Codex (unlike codex-completion-criteria, which is a
 *  named-host comparison by design). */
function roleLibraryEvidence(ctx) {
  const byHost = ctx.promptsByHost;
  if (!byHost) return null;
  let best = null;
  for (const host of Object.keys(byHost).sort()) {
    const n = Number(byHost[host]?.personaOpeners) || 0;
    if (!best || n > best.count) best = { count: n, host };
  }
  return best ?? { count: 0, host: null };
}

// ── per-rule firing bar (propose gate only — never applied to the raw
// evidence current/outcome machinery reads) ─────────────────────────────────

const releaseRitualMeetsBar = (e) => e.count >= RELEASE_RITUAL_MIN_COUNT;
const commitPushMeetsBar = (e) => e.count >= COMMIT_PUSH_MIN_COUNT;
const reaskDeltaMeetsBar = (e) => e.count >= REASK_DELTA_MIN_PAIRS;
function completionCriteriaMeetsBar(e, ctx) {
  const asymmetryPresent = (ctx.insights ?? []).some((i) => i?.id === 'host-prompt-asymmetry');
  if (!asymmetryPresent) return false;
  const personaFavorsCodex = e.count > e.otherCount;
  const lengthFavorsCodex = e.p90Host != null && e.p90Other > 0 && e.p90Host / e.p90Other > 1;
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

function completionCriteriaCard(e, now) {
  const evidence = { id: 'codex-completion-criteria', ...e };
  const ratioText = e.p90Host != null && e.p90Other > 0
    ? ` p90 typed length codex ${e.p90Host} vs claude ${e.p90Other} tokens.` : '';
  return {
    id: 'codex-completion-criteria',
    title: 'Codex needs the finish line stated up front',
    finding: 'Codex prompts run longer or open with more retyped roles than Claude\'s, which usually '
      + 'means Codex is not being told what "done" looks like up front.',
    try: 'Tell Codex what "done" looks like in the first prompt — explicit completion criteria, '
      + 'not steering after the fact.',
    basis: `codex ${e.count} persona openers vs claude ${e.otherCount}.${ratioText}`,
    evidenceHash: evidenceHash(evidence),
    generatedAt: new Date(now).toISOString(),
  };
}

function progressReportCard(e, now, ctx) {
  const evidence = { id: 'progress-report-taps', ...e };
  // Display-only enrichment: the matched insight's own already-thresholded,
  // number-dense sentence, looked up fresh from `ctx` — never carried through
  // `evidence`/the ledger baseline (see progressReportEvidence's doc).
  const insightFinding = (ctx?.insights ?? []).find((i) => i?.id === 'supervision-tap-share')?.finding;
  return {
    id: 'progress-report-taps',
    title: 'You are tapping for progress the agent already has',
    finding: 'Supervision taps are elevated against your own trailing baseline — some of that is you '
      + 'checking on progress the agent could have volunteered.',
    try: 'Have the agent post an unprompted progress update at natural checkpoints (before/after each '
      + 'major step), so a check-in tap is not needed.',
    basis: insightFinding || `${e.count} supervision taps recorded across all hosts this window.`,
    evidenceHash: evidenceHash(evidence),
    generatedAt: new Date(now).toISOString(),
  };
}

function roleLibraryCard(e, now) {
  const evidence = { id: 'codex-role-library', ...e };
  return {
    id: 'codex-role-library',
    title: 'A role gets retyped by hand on ' + e.host,
    finding: `${e.count} persona/role assignments were retyped by hand on ${e.host} — the largest `
      + 'measured pattern in this shape of prompt.',
    try: `Move the retyped role assignment into a managed prompt-fragment library for ${e.host} workers, `
      + 'instead of retyping it each session.',
    basis: `${e.count} persona openers retyped on ${e.host}.`,
    evidenceHash: evidenceHash(evidence),
    generatedAt: new Date(now).toISOString(),
    draft: {
      kind: 'link',
      text: `Sibling effort: a managed ${e.host} role-fragment library (prompts-view spec §8) — `
        + 'see `ak host pick`.',
    },
  };
}

/** @type {ReadonlyArray<{id: string, evidence: Function, meetsBar: Function, card: Function}>} */
const RULES = [
  { id: 'release-ritual-skill', evidence: releaseRitualEvidence, meetsBar: releaseRitualMeetsBar, card: releaseRitualSkillCard },
  { id: 'commit-push-claude-md', evidence: commitPushEvidence, meetsBar: commitPushMeetsBar, card: commitPushClaudeMdCard },
  { id: 'reask-delta', evidence: reaskDeltaEvidence, meetsBar: reaskDeltaMeetsBar, card: reaskDeltaCard },
  { id: 'codex-completion-criteria', evidence: completionCriteriaEvidence, meetsBar: completionCriteriaMeetsBar, card: completionCriteriaCard },
  { id: 'progress-report-taps', evidence: progressReportEvidence, meetsBar: progressReportMeetsBar, card: progressReportCard },
  { id: 'codex-role-library', evidence: roleLibraryEvidence, meetsBar: roleLibraryMeetsBar, card: roleLibraryCard },
];

/** Exposed only for direct per-rule unit tests, the same precedent as
 *  usage-insights.mjs's `_detectors`. Not part of the public API. */
export const _rules = Object.fromEntries(RULES.map((r) => [r.id, r]));

/**
 * The deterministic v1 card set (spec §5), each card only when its evidence
 * condition holds. Pure: no I/O, no clock read beyond `now`.
 *
 * @param {{ promptPatterns: object|null, promptBaselines: object|null,
 *   promptsByHost: object|null, insights: Array<object>|null, now: number }} input
 * @returns {Array<object>} cards, in RULES order
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
 * `now` — `{ promptPatterns, promptsByHost, insights }` — despite the
 * parameter's name (kept verbatim per the ledger contract this satisfies):
 * the two-hosts and per-host-taps rules need `promptsByHost`/`insights` too,
 * not only the cluster/reAsks halves the name suggests.
 *
 * @param {string} id
 * @param {{ promptPatterns?: object|null, promptsByHost?: object|null, insights?: Array<object>|null }} currentPatterns
 */
export function currentEvidenceFor(id, currentPatterns) {
  const rule = RULES.find((r) => r.id === id);
  if (!rule) return null;
  const ctx = {
    promptPatterns: currentPatterns?.promptPatterns ?? null,
    promptsByHost: currentPatterns?.promptsByHost ?? null,
    insights: Array.isArray(currentPatterns?.insights) ? currentPatterns.insights : [],
  };
  return rule.evidence(ctx);
}

const cardSlug = (id) => id.replace(/-skill$/, '');

/**
 * Deterministic adoption predicates (spec §6.4), evaluated in the order
 * spec'd: a matching CLAUDE.md line, then a matching skill directory, then
 * "the target recurrence collapsed" (current count ≤ ADOPTION_COLLAPSE_RATIO
 * of the count recorded when this card was first proposed). Pure — every
 * input is caller-supplied.
 *
 * @param {object} card a card from `deriveCards`
 * @param {{ claudeMdTexts?: string[], skillDirs?: string[],
 *   currentPatterns?: object, ledgerRecord?: object }} [inputs]
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

  const baselineCount = Number(ledgerRecord?.baseline?.count);
  if (Number.isFinite(baselineCount) && baselineCount > 0) {
    const fresh = currentEvidenceFor(card.id, currentPatterns ?? {});
    const currentCount = Number(fresh?.count);
    if (Number.isFinite(currentCount) && currentCount <= baselineCount * ADOPTION_COLLAPSE_RATIO) {
      return { adopted: true, via: 'collapse' };
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
