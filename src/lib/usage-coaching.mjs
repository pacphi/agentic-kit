// usage-coaching.mjs — the coaching ENGINE: deriveCards, currentEvidenceFor,
// deterministic adoption detection, and outcome measurement (coaching cards
// and the outcome ledger, METRICS.md §22).
// NO I/O and NO clock reads beyond the `now` a caller passes in — the store
// (usage-outcome-ledger.mjs) is a separate, small-I/O module that imports
// FROM here, never the reverse.
//
// The six v1 RULES (each an evidence extractor, a propose-bar predicate, and
// a card text builder) live in usage-coaching-rules.mjs, imported below —
// split out once this file crossed the repo's file-size limit for a new lib.
// This file owns the CONTRACT every rule is evaluated through; that module
// owns what each rule actually says.
//
// `evidenceHash` itself lives in the leaf module usage-evidence-hash.mjs
// (Fix round 3) — both this file's callers and usage-coaching-rules.mjs's
// card builders need it, so it sits below both rather than inside either,
// breaking what would otherwise be an engine<->rules import cycle. Re-
// exported here unchanged, so every existing `evidenceHash` import stays
// valid.
//
// v1 rules are RULE-DERIVED, not inferred (layer-3 inference refresh,
// METRICS.md §23, is a later wave). Every number a card states is read off one of the
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
import { RULES } from './usage-coaching-rules.mjs';

export { evidenceHash } from './usage-evidence-hash.mjs';

/** Adoption-by-collapse and outcome-improvement share this reasoning but not
 *  this exact number: collapse is the ADOPTION signal (ADR-0039's outcome-
 *  ledger decision — "the target cluster's recurrence collapsed"), a stricter bar than "improved"
 *  (measureOutcome below), which only asks whether the count moved down at
 *  all. A card can be adopted by CLAUDE.md/skill-dir detection long before its
 *  recurrence collapses 80%, and outcome measurement has to track THAT case
 *  too. */
export const ADOPTION_COLLAPSE_RATIO = 0.2;

/** How long an adopted-but-not-improving card is given before it is retired
 *  with its refutation shown (METRICS.md §22). */
export const OUTCOME_MIN_DAYS = 14;
export const DAY_MS = 86_400_000;

/**
 * @typedef {{ id: string, title: string, finding: string, try: string,
 *   basis: string, evidenceHash: string, generatedAt: string,
 *   draft?: { kind: 'claude-md-line'|'skill-skeleton'|'link', text: string } }} CoachingCard
 */

/**
 * The deterministic v1 card set (METRICS.md §22's six rules), each card only when its evidence
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
    // QE review F-9: `source` is stamped EXPLICITLY rather than left implicit.
    // Both surfaces now render it on every card, and a missing field defaulting
    // to "rule" would fail in the one direction that matters — quietly claiming
    // a model-authored card was computed from the aggregate.
    cards.push({ ...rule.card(evidence, now, ctx), source: 'rule' });
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
 * Deterministic adoption predicates (METRICS.md §22's adoption routes),
 * evaluated in order: a matching CLAUDE.md line, then a matching skill directory, then
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

/** The honest delta text for an adopted card whose canonical baseline held
 *  nothing. QE review F-1: there is no comparison to make, and saying so is
 *  the whole fix — see `measureOutcome`. */
export const NOTHING_TO_MEASURE_TEXT = 'no occurrences in the canonical 30-day window — nothing to measure';

/**
 * Current vs. the recorded baseline count, for an ADOPTED ledger record.
 * `improved` is a strict decrease — any real drop counts, since retirement
 * (not this function) is what applies the 14-day patience window. `null`
 * evidence (the underlying structure vanished, e.g. no fingerprint layer at
 * all this pass) reports as un-improved with an honest "not measured" delta
 * rather than a fabricated number.
 *
 * `measurable` (QE review F-1, HIGH) says whether the comparison MEANS
 * anything, and it is what stops the caller from turning arithmetic into a
 * verdict. A baseline of zero cannot be improved on: a count cannot go below
 * zero, so `current < baseline` is false FOREVER, and the ledger would retire
 * the card 14 days later with "0 → 0 since adoption" no matter what the
 * operator did. That is reachable on the DEFAULT path — `--window` defaults to
 * `all`, so a card fires on all-time evidence while the ledger judges it on
 * the canonical 30 days, and an operator who adopted the habit months ago has
 * exactly zero recent occurrences. `improved` and `measurable` are separate
 * because they answer different questions: "did it get better" and "was there
 * anything to get better".
 *
 * @param {{ id: string, baseline?: { count?: number } }} record
 * @param {object} currentPatterns same shape `currentEvidenceFor` takes
 * @returns {{ measurable: boolean, improved: boolean, deltaText: string }}
 */
export function measureOutcome(record, currentPatterns) {
  const baselineCount = Number(record?.baseline?.count);
  const fresh = currentEvidenceFor(record?.id, currentPatterns ?? {});
  const currentCount = Number(fresh?.count);
  if (!Number.isFinite(baselineCount) || !Number.isFinite(currentCount)) {
    return { measurable: false, improved: false, deltaText: 'not measured this pass — evidence unavailable' };
  }
  if (baselineCount <= 0) {
    return { measurable: false, improved: false, deltaText: NOTHING_TO_MEASURE_TEXT };
  }
  return {
    measurable: true,
    improved: currentCount < baselineCount,
    deltaText: `${baselineCount} → ${currentCount} since adoption`,
  };
}
