// The Coaching section of `ak usage prompts` (spec §5, §6.4): rendering,
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
import { dismissCard, summarizeLedger, CANONICAL_WINDOW_DAYS } from '../../lib/usage-outcome-ledger.mjs';
import { BASELINE_TRAILING_DAYS } from '../../lib/usage-aggregate.mjs';

function fmtNum(n) { return (Number(n) || 0).toLocaleString(); }

/** The chip text per ledger status, the same six states the dashboard renders
 *  (usage-prompts.mjs's coaching card). `stale` never appears in v1 — every
 *  proposed card's evidenceHash is refreshed the same pass it would go stale
 *  in, because a rule-derived card costs nothing to recompute (spec §6.3) —
 *  so this switch has no branch for it; there is nothing stale to report.
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
    return card.outcome.improved
      ? `adopted ✓ — ${card.outcome.deltaText} (30d basis)`
      : `adopted ✓ — too early to tell (${card.outcome.deltaText} (30d basis))`;
  }
  if (card.status === 'retired') return `retired — did not improve: ${card.refutation} (30d basis)`;
  if (card.status === 'dismissed') return 'dismissed';
  if (card.status === 'expired') return 'expired — evidence no longer present';
  return 'proposed';
}

/** `generatedAt` + the first 8 hex chars of `evidenceHash`, as a dim trailing
 *  line (Fix round 1, M-3) — spec §5 makes a point of every card carrying
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
  // W5 enrichment (spec §6.3): only an ENRICHED card's evidence can drift out
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
  info(dim('  rule-derived and free to recompute every scan (spec §6.3) — nothing here goes stale; '
    + 'a card is only ever proposed, adopted, dismissed, expired, or retired'));
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

/** `--draft <id>`: print that one card's draft verbatim and nothing else —
 *  json-safe (a minimal object under --json, the raw text otherwise), so a
 *  caller can pipe either straight into a file. Draft-only, always (spec §5):
 *  the draft TEXT lives on the card object `deriveCards` already produced,
 *  so this never touches the ledger — no load, no reconcile, no write (Fix
 *  round 1, M-7: a read-shaped flag must not mutate anything). */
export function runDraftFlag(cards, id, json) {
  const card = cards.find((c) => c.id === id);
  if (!card) {
    warn(`ak usage prompts --draft: unknown card id ${JSON.stringify(id)}. Known ids: ${knownCardIdsText(cards)}`);
    return 2;
  }
  if (!card.draft) {
    const withDraft = cards.filter((c) => c.draft).map((c) => c.id).join(', ') || '(none this window)';
    warn(`ak usage prompts --draft: card ${JSON.stringify(id)} has no draft. Cards with a draft: ${withDraft}`);
    return 2;
  }
  if (json) console.log(JSON.stringify({ id: card.id, kind: card.draft.kind, text: card.draft.text }, null, 2));
  else console.log(card.draft.text);
  return 0;
}

/** `--dismiss <id>`: persist the dismissal and print a confirmation. Ledger
 *  writes are CLI-only (spec §3.3's privacy split; the dashboard's reconcile
 *  is read-only — see dashboard-server.mjs's promptsPayload). The id is
 *  validated against `cards` (this pass's reconciled set) by the caller
 *  BEFORE this function is reached, so an unknown id never gets here (Fix
 *  round 1, M-7) — `dismissCard`'s own `found: false` path is unreachable in
 *  practice but kept as the honest fallback that would fire if it ever were. */
export function runDismissFlag({ ledger, ledgerPath, save, cards, id, json, adoptionInputs, now }) {
  const { ledger: next, found } = dismissCard(ledger, id, cards, { adoptionInputs, now });
  if (!found) {
    warn(`ak usage prompts --dismiss: unknown card id ${JSON.stringify(id)}. Known ids: ${knownCardIdsText(cards)}`);
    return 2;
  }
  save(ledgerPath, next);
  const record = next.records.find((r) => r.id === id);
  if (json) console.log(JSON.stringify({ id, status: 'dismissed', dismissCount: record.dismissCount }, null, 2));
  else ok(`Dismissed '${id}' (dismissal ${fmtNum(record.dismissCount)}).`);
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
