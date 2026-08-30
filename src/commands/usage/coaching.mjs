// The Coaching section of `ak usage prompts` (METRICS.md §22): rendering,
// the --json shapes, and the --draft/--dismiss flag handlers. Split out of
// usage.mjs on the status.mjs/status/*.mjs precedent — usage.mjs stays the
// command's orchestrator (window parsing, the aggregate read, the other
// report sections) and imports this module for everything coaching-specific.
//
// No behavior changed by this split — every function here is verbatim from
// usage.mjs, moved as a unit with its own local `fmtNum` copy (a one-line
// pure formatter, not worth threading an import back through usage.mjs for
// — the same reasoning usage-rhythm.mjs/usage-prompts.mjs already document
// for their own copied `esc`).
import { heading, info, ok, warn, dim } from '../../lib/output.mjs';
import {
  dismissCard, summarizeLedger, CANONICAL_WINDOW_DAYS, reconcile,
} from '../../lib/usage-outcome-ledger.mjs';
import { BASELINE_TRAILING_DAYS } from '../../lib/usage-aggregate.mjs';
// W5 enrichment (METRICS.md §23) — folded into the SAME coaching-resolution
// orchestration below (resolveCoachingAndEnrichment) because an enriched
// card joins reconcile exactly like a rule card; splitting the two into
// separate call sites would mean two places deciding "is this pass allowed
// to write the ledger/store", which is exactly the kind of drift this
// module's whole job is to prevent.
import {
  applyLabelStoreToPatterns, buildFindingsSummary, hydrateStoredCards, applyCardStaleness,
} from '../../lib/usage-enrich.mjs';
import { runEnrichPass } from './enrich.mjs';
import { promptReport } from '../usage.mjs';

/** @typedef {import('../../lib/usage-coaching.mjs').CoachingCard} CoachingCard */

function fmtNum(n) { return (Number(n) || 0).toLocaleString(); }

/** The chip text per ledger status, the same six states the dashboard renders
 *  (usage-prompts.mjs's coaching card). `stale` is a separate, dedicated line
 *  `printCoachingCard` prints below this one (Fix round 1, M-5) — this
 *  switch covers ledger STATUS only (proposed/adopted/dismissed/expired/
 *  retired), which is orthogonal to an enriched card's staleness; the two
 *  are not mutually exclusive (a `proposed` enriched card can also be stale).
 *
 *  Outcome/refutation lines carry "(30d basis)" (Fix round 1, C-1): both
 *  numbers in `deltaText`/`refutation` are always read from the CANONICAL
 *  30-day aggregate regardless of what `--window` is displaying elsewhere on
 *  this report, and the render must say so — otherwise a reader comparing
 *  this line against the Recurring clusters table above it (which DOES
 *  honor `--window`) would see two different counts for "the same" pattern
 *  with no explanation. */
function coachingStatusLine(card) {
  if (card.status === 'adopted') {
    if (!card.outcome) return 'adopted ✓';
    if (card.outcome.improved) return `adopted ✓ — ${card.outcome.deltaText} (30d basis)`;
    // QE review F-1: an UNMEASURABLE outcome is not a "not yet", it is a
    // "cannot". "Too early to tell" promises a verdict that, against a zero
    // baseline, can never arrive — and the ledger no longer pretends one will.
    if (card.outcome.measurable === false) return `adopted ✓ — ${card.outcome.deltaText}`;
    return `adopted ✓ — too early to tell (${card.outcome.deltaText} (30d basis))`;
  }
  if (card.status === 'retired') return `retired — did not improve: ${card.refutation} (30d basis)`;
  if (card.status === 'dismissed') return 'dismissed';
  if (card.status === 'expired') return 'expired — evidence no longer present';
  return 'proposed';
}

/** `generatedAt` + the first 8 hex chars of `evidenceHash`, as a dim trailing
 *  line (Fix round 1, M-3) — METRICS.md §22 makes a point of every card carrying
 *  both; before this they existed on the object and in `--json` but reached
 *  no rendered card on either surface. */
function printCoachingCard(card) {
  info(card.title);
  info(dim(`  ${card.finding}`));
  info(`  Try: ${card.try}`);
  info(dim(`  Basis: ${card.basis}`));
  info(`  Status: ${coachingStatusLine(card)}`);
  if (card.draft) info(dim(`  Draft → ak usage prompts --draft ${card.id}`));
  if (card.status === 'proposed') info(dim(`  Dismiss → ak usage prompts --dismiss ${card.id}`));
  // W5 enrichment (METRICS.md §23): only an ENRICHED card's evidence can drift out
  // from under its cache — a rule card recomputes fresh every pass and so
  // `card.stale` is always false for it (usage-enrich.mjs's applyCardStaleness
  // never even writes that field on a non-enriched card).
  if (card.stale) info(dim('  stale — recompute with ak usage prompts --enrich'));
  info(dim(`  as of ${card.generatedAt} · ${card.evidenceHash.slice(0, 8)}`));
}

/** The Coaching section: cards rendered finding → Try → basis → status chip.
 *  `coaching` is `{ cards, summary }` — one name on both surfaces (Fix round
 *  1, M-2: this used to be `ledgerSummary` here and `summary` on the
 *  dashboard; collapsed to the dashboard's name before a consumer could come
 *  to depend on both). `coaching.unavailable` (Fix round 1, I-2) renders a
 *  named reason instead of an empty section — set when the on-disk ledger is
 *  a schema newer than this build understands, or when the canonical 30d
 *  aggregate coaching needs could not be read this pass. */
export function printCoaching(coaching) {
  heading('Coaching');
  // Fix round 1, I-5: ported from the dashboard's own caption
  // (usage-prompts.mjs) verbatim in spirit — the two surfaces disagreed
  // (this one claimed "nothing here goes stale" directly above a card that
  // could, and did, render "stale — recompute" beneath it).
  info(dim('  rule-derived cards are free to recompute every scan and never go stale; an enriched card '
    + '(source: enriched) is cached and can — see its own marker below. A card is only ever proposed, '
    + 'adopted, dismissed, expired, or retired'));
  if (coaching?.unavailable) {
    info(dim(`  coaching unavailable this run — ${coaching.reason}`));
    return;
  }
  const cards = coaching?.cards ?? [];
  if (!cards.length) {
    info(dim('  no samples — no coaching card met its evidence bar this window'));
    return;
  }
  for (const card of cards) printCoachingCard(card);
  const s = coaching.summary;
  if (s) {
    info(dim(`  ledger — ${fmtNum(s.proposed)} proposed · ${fmtNum(s.adopted)} adopted · `
      + `${fmtNum(s.dismissed)} dismissed · ${fmtNum(s.expired)} expired · ${fmtNum(s.retired)} retired`));
  }
}

export function coachingProjection(cards, ledger) {
  return { cards, summary: summarizeLedger(ledger.records) };
}

/** The section/`--json` shape when the ledger cannot honestly be reconciled
 *  this pass (Fix round 1, I-2) — `cards: []`/`summary: null` rather than
 *  omitting the key, so a consumer reading `coaching.cards.length` still sees
 *  an array, not a crash. */
export function unavailableCoaching(reason) {
  return { cards: [], summary: null, unavailable: true, reason };
}

/** Every rule-derived card id this pass, joined for an unknown-id error —
 *  '(none this window)' rather than an empty string, so the error itself
 *  never reads as though the command hung. */
export function knownCardIdsText(cards) {
  return cards.map((c) => c.id).join(', ') || '(none this window)';
}

/** How much of an operator-supplied id an error or confirmation line will echo
 *  back. Security review SEC-11 (LOW): a 200 KB `--dismiss` value produced
 *  205,156 bytes on stdout at exit 2, and the SUCCESS path at `runDismissFlag`
 *  interpolated the id RAW while every rejection path already went through
 *  `JSON.stringify`. Self-inflicted through argv only, which is why it is LOW
 *  — but an id long enough to need clipping is already not an id, and one that
 *  reaches the success path came from the store, which SEC-4 shows was not a
 *  trustworthy source of ids either. */
const MAX_ECHOED_ID_CHARS = 120;

/** One id, safe to print: JSON-quoted (so control bytes render as escapes
 *  rather than firing) and clipped. */
export function echoId(id) {
  const text = String(id ?? '');
  return JSON.stringify(text.length > MAX_ECHOED_ID_CHARS
    ? `${text.slice(0, MAX_ECHOED_ID_CHARS)}…`
    : text);
}

/** `--draft <id>`: print that one card's draft verbatim and nothing else —
 *  json-safe (a minimal object under --json, the raw text otherwise), so a
 *  caller can pipe either straight into a file. Draft-only, always (METRICS.md §22):
 *  the draft TEXT lives on the card object `deriveCards` already produced,
 *  so this never touches the ledger — no load, no reconcile, no write (Fix
 *  round 1, M-7: a read-shaped flag must not mutate anything). */
export function runDraftFlag(cards, id, json) {
  const card = cards.find((c) => c.id === id);
  if (!card) {
    warn(`ak usage prompts --draft: unknown card id ${echoId(id)}. Known ids: ${knownCardIdsText(cards)}`);
    return 2;
  }
  if (!card.draft) {
    const withDraft = cards.filter((c) => c.draft).map((c) => c.id).join(', ') || '(none this window)';
    warn(`ak usage prompts --draft: card ${echoId(id)} has no draft. Cards with a draft: ${withDraft}`);
    return 2;
  }
  if (json) console.log(JSON.stringify({ id: card.id, kind: card.draft.kind, text: card.draft.text }, null, 2));
  else console.log(card.draft.text);
  return 0;
}

/** `--dismiss <id>`: persist the dismissal and print a confirmation. Ledger
 *  writes are CLI-only (ADR-0039's privacy split; the dashboard's reconcile
 *  is read-only — see dashboard-server.mjs's promptsPayload). The id is
 *  validated against `cards` (this pass's reconciled set) by the caller
 *  BEFORE this function is reached, so an unknown id never gets here (Fix
 *  round 1, M-7) — `dismissCard`'s own `found: false` path is unreachable in
 *  practice but kept as the honest fallback that would fire if it ever were. */
export function runDismissFlag({ ledger, ledgerPath, save, cards, id, json, adoptionInputs, now }) {
  const { ledger: next, found } = dismissCard(ledger, id, cards, { adoptionInputs, now });
  if (!found) {
    warn(`ak usage prompts --dismiss: unknown card id ${echoId(id)}. Known ids: ${knownCardIdsText(cards)}`);
    return 2;
  }
  save(ledgerPath, next);
  const record = next.records.find((r) => r.id === id);
  if (json) console.log(JSON.stringify({ id, status: 'dismissed', dismissCount: record.dismissCount }, null, 2));
  else ok(`Dismissed ${echoId(id)} (dismissal ${fmtNum(record.dismissCount)}).`);
  return 0;
}

/** The CANONICAL 30-day evidence bundle every ledger-facing read uses (Fix
 *  round 1, C-1) — `agg` when the operator's own `--window` already IS 30d
 *  (no second read needed), otherwise a dedicated fetch at
 *  CANONICAL_WINDOW_DAYS. Returns `null` on a failed fetch, which the caller
 *  reads as "coaching unavailable this pass" rather than failing the whole
 *  report — the rest of `ak usage prompts` does not depend on this read. */
export async function canonicalCoachingAgg(agg, win, readAgg) {
  if (win.days === CANONICAL_WINDOW_DAYS) return agg;
  try {
    return await readAgg({
      days: CANONICAL_WINDOW_DAYS, lookbackDays: CANONICAL_WINDOW_DAYS + BASELINE_TRAILING_DAYS, prompts: true,
    });
  } catch {
    return null;
  }
}

export function currentPatternsOf(a) {
  return { promptPatterns: a.promptPatterns, promptsByHost: a.promptsByHost, promptBaselines: a.promptBaselines, insights: a.insights };
}

/** `--dismiss <id>`: validate against the reconciled set, then persist.
 *  Returns the exit code `runPrompts` should return immediately. Split out
 *  of `resolveCoachingAndEnrichment` purely to keep that function's own
 *  cyclomatic complexity under the repo's ceiling.
 *  @param {{ ledger: object, ledgerPath: string, saveLedgerFn: Function,
 *    reconciledCards: Array<CoachingCard>, id: string, json?: boolean,
 *    adoptionInputs: object, currentPatterns: object, now: number }} input
 *  @returns {number} */
function resolveDismiss({
  ledger, ledgerPath, saveLedgerFn, reconciledCards, id, json, adoptionInputs, currentPatterns, now,
}) {
  const knownIds = new Set(reconciledCards.map((c) => c.id));
  if (!knownIds.has(id)) {
    warn(`ak usage prompts --dismiss: unknown card id ${echoId(id)}. `
      + `Known ids: ${knownCardIdsText(reconciledCards)}`);
    return 2; // Fix round 1, M-7: no write for an id validated invalid
  }
  return runDismissFlag({
    ledger, ledgerPath, save: saveLedgerFn, cards: reconciledCards, id, json,
    adoptionInputs: { ...adoptionInputs, currentPatterns }, now,
  });
}

/**
 * Resolves this pass's coaching state — the outcome-ledger reconcile,
 * optionally preceded by a `--enrich` pass (METRICS.md §23) — and applies the
 * label store to the CANONICAL aggregate too. Split out of `runPrompts`
 * (usage.mjs) on the repo's complexity ceiling: this was the single largest
 * branch that function carried, and enrichment folds into the SAME
 * orchestration rather than a second one, so there is exactly one place
 * deciding "is this pass allowed to write the ledger/store".
 *
 * Returns `{ earlyReturn: number }` when the caller must return THAT value
 * immediately (an in-progress `--dismiss` resolved, or was rejected) —
 * every other path returns `{ coaching, enrichment, report }`. `agg` is
 * mutated in place (its `promptPatterns` may be reassigned to reflect a
 * freshly-enriched label), which is why it is not part of the return shape;
 * `report` IS, because `promptReport` builds a new object.
 *
 * @typedef {{ win: object, patterns: object|null, headless: { sessions: number,
 *   headlessSessions: number, responses: number, headlessResponses: number,
 *   share: number|null } }} PromptReport the shape `usage.mjs`'s own `promptReport` returns
 *
 * @param {{ agg: import('../../lib/usage-enrich.mjs').AggLike & { generatedAt: string, sessions?: Array<object> },
 *   report: PromptReport, win: { days: number, label: string|number }, ruleCards: Array<CoachingCard>,
 *   activeLabels: Record<string, object>,
 *   labelStore: import('../../lib/usage-label-store.mjs').LabelStore, labelStorePath: string,
 *   ledgerPath: string, loadLedgerFn: Function, saveLedgerFn: Function,
 *   readAgg: Function, adoptionInputs: object,
 *   now: number, flags: { enrich?: boolean, dismiss?: string|null, json?: boolean }, deps: object }} input
 * @returns {Promise<{ earlyReturn: number }|{ coaching: object, enrichment: object|null, report: PromptReport }>}
 */
export async function resolveCoachingAndEnrichment({
  agg, report, win, ruleCards, activeLabels, labelStore, labelStorePath,
  ledgerPath, loadLedgerFn, saveLedgerFn, readAgg, adoptionInputs, now, flags, deps,
}) {
  const loadedLedger = loadLedgerFn(ledgerPath);
  if (loadedLedger.future) {
    // Fix round 1, I-2: refuse to reconcile/overwrite a well-formed ledger
    // from a newer schema — doing so would silently resurrect every
    // dismissed card the newer build had suppressed.
    //
    // Fix round 1, I-4: guarded on `!flags.json` — this is pre-existing from
    // W4 (unguarded since before this wave), but the same defect as the W5
    // label-store warn below it, so fixed in the same edit: `warn` writes to
    // stdout (output.mjs), and an unguarded call here would corrupt the
    // `--json` document runPrompts prints right after this returns.
    if (!flags.json) {
      warn(`ak usage prompts: the outcome ledger at ${ledgerPath} is a newer schema `
        + `(v${loadedLedger.version}) this build does not understand — coaching is unavailable `
        + 'this run, and the file was left untouched.');
    }
    if (flags.dismiss != null) return { earlyReturn: 2 }; // nothing readable to dismiss against
    return {
      coaching: unavailableCoaching(`ledger schema v${loadedLedger.version} is newer than this build (v1)`),
      enrichment: null, report,
    };
  }

  const canonicalAgg = await canonicalCoachingAgg(agg, win, readAgg);
  if (!canonicalAgg) {
    warn('ak usage prompts: could not read the canonical 30-day aggregate coaching needs — '
      + 'coaching is unavailable this run.');
    if (flags.dismiss != null) return { earlyReturn: 2 };
    return {
      coaching: unavailableCoaching('the canonical 30-day aggregate could not be read'), enrichment: null, report,
    };
  }

  canonicalAgg.promptPatterns = applyLabelStoreToPatterns(canonicalAgg.promptPatterns, activeLabels);
  // Ledger-facing evidence is always the CANONICAL 30d window (Fix round 1,
  // C-1) — an enriched card's findingsSummary/evidenceHash follow the exact
  // same rule, so switching --window cannot move what an enriched card's
  // staleness is judged against either.
  const findingsSummary = buildFindingsSummary(canonicalAgg);

  // --enrich (METRICS.md §23): a NEW inference pass, CLI-only, opt-in. Skipped
  // entirely — not partially — when the label store itself is unreadable; a
  // readable ledger does not make a partial write to an unreadable store safe.
  const enrichment = (flags.enrich && !labelStore.future)
    ? await runEnrichPass({ agg, findingsSummary, labelStore, labelStorePath, win, deps, now, json: flags.json })
    : null;
  if (enrichment?.labelsChanged) {
    agg.promptPatterns = applyLabelStoreToPatterns(agg.promptPatterns, enrichment.labelStore.labels);
    report = promptReport(agg, win); // re-render the clusters table with the new names
    canonicalAgg.promptPatterns = applyLabelStoreToPatterns(canonicalAgg.promptPatterns, enrichment.labelStore.labels);
  }

  const currentPatterns = currentPatternsOf(canonicalAgg);
  // Persisted enriched cards rejoin reconcile on EVERY pass, not only the one
  // that synthesized them (spec: "join reconcile exactly like rule cards") —
  // hydrateStoredCards restores their content; the ledger still owns their
  // lifecycle exactly like a rule card's.
  const storedCards = hydrateStoredCards((enrichment?.labelStore ?? labelStore).cards);
  // QE review F-2: `ruleCards` derive from the OPERATOR'S window (deliberately
  // — that is what the report shows), while every ledger-facing evidence read
  // is canonical. Telling reconcile which basis the CARDS came from is what
  // stops a display-only `--window` switch from persisting `expired` on a card
  // whose canonical evidence never moved.
  const { ledger, cards: reconciledCards } = reconcile(loadedLedger, [...ruleCards, ...storedCards], {
    adoptionInputs: { ...adoptionInputs, currentPatterns },
    now,
    canonicalBasis: win.days === CANONICAL_WINDOW_DAYS,
  });
  // AFTER reconcile only — annotate() unconditionally sets stale:false, which
  // would clobber this if it ran first (usage-enrich.mjs's own doc).
  applyCardStaleness(reconciledCards, findingsSummary);

  if (flags.dismiss != null) {
    const earlyReturn = resolveDismiss({
      ledger, ledgerPath, saveLedgerFn, reconciledCards, id: flags.dismiss, json: flags.json,
      adoptionInputs, currentPatterns, now,
    });
    return { earlyReturn, enrichment, report };
  }

  // Ledger updates happen on EVERY normal invocation — reconcile above
  // already computed adoption/outcome/expiry transitions; this is the one
  // point that persists them (the dashboard's own reconcile never calls
  // this, per its read-only contract).
  saveLedgerFn(ledgerPath, ledger);
  return { coaching: coachingProjection(reconciledCards, ledger), enrichment, report };
}
