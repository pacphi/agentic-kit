// usage-outcome-ledger.mjs — the coaching outcome ledger's store (spec §6.4):
// small I/O (a JSON file beside the usage-index cache) plus the ledger's own
// state-transition logic. Card DERIVATION and its predicates live in
// usage-coaching.mjs, which this module imports FROM — never the reverse.
//
// INVARIANT, test-pinned: no field anywhere in a ledger record ever holds
// prompt text — ids, hashes, counts, host names and curated label names only.
// Every string this module writes is either a fixed enum, a timestamp, or a
// template built from numbers (see measureOutcome's deltaText).
//
// CANONICAL WINDOW (Fix round 1, C-1): every ledger-facing evidence read —
// a new record's `baseline`, adoption-by-collapse's "current count", and
// `measureOutcome`'s comparison — MUST come from a fixed 30-day aggregate,
// regardless of what window `--window`/the dashboard's day selector is
// displaying. A baseline snapshotted under one window and compared against a
// count read under another are not commensurable numbers: switching
// `--window` alone could otherwise fabricate an adoption, an outcome delta,
// and — 14 days later — a permanent retirement verdict, none of it backed by
// anything the operator actually did. Every record carries `windowDays`
// (always CANONICAL_WINDOW_DAYS today) so a caller — and this module itself
// — can tell a canonical-window record from anything else; a record loaded
// without that field is discarded rather than migrated. This ledger has
// never shipped to a user, so there is no real migration debt: a record from
// before this fix simply reads as though it never existed.
import fs from 'node:fs';
import path from 'node:path';
import { configDir } from './paths.mjs';
import {
  detectAdoption, measureOutcome, currentEvidenceFor, OUTCOME_MIN_DAYS, DAY_MS,
} from './usage-coaching.mjs';

/**
 * @typedef {import('./usage-coaching.mjs').CoachingCard} CoachingCard
 * @typedef {import('./usage-coaching.mjs').LedgerRecord} LedgerRecord
 * @typedef {{ version: number, records: Array<LedgerRecord> }} Ledger
 * @typedef {CoachingCard & { status: LedgerRecord['status'], stale: boolean,
 *   dismissCount: number, outcome: LedgerRecord['outcome'],
 *   refutation: string|null }} AnnotatedCard the public shape `reconcile`
 *   returns — a card's own fields plus the ledger's read of it (see `annotate`)
 */

export const LEDGER_SCHEMA_VERSION = 1;

/** The only window ledger-facing evidence is ever read under (Fix round 1,
 *  C-1) — see the module doc. */
export const CANONICAL_WINDOW_DAYS = 30;

/** A dismissed card whose evidence hash has changed gets ONE re-proposal
 *  (spec §6.4 decay); at this many dismissals it stops re-proposing even
 *  across a hash change — the operator has said no twice. */
export const DISMISS_PERMANENT_THRESHOLD = 2;

/** Fix round 1, I-1: a hash-changed dismissed record re-proposes only when
 *  the count has moved this much — a strict fraction WORSE than the count
 *  recorded at dismissal — not on every hash change. Any single additional
 *  occurrence of a recurring habit changes the hash (it is one more instance
 *  of the exact evidence being hashed), so gating on hash-changed alone made
 *  a dismissal survive only until the next occurrence of the very behaviour
 *  it was about. */
export const DISMISS_MATERIALITY_RATIO = 0.5;

const VALID_STATUSES = new Set(['proposed', 'adopted', 'dismissed', 'expired', 'retired']);

export function defaultLedgerPath() {
  return path.join(configDir(), 'usage-outcome-ledger.json');
}

function blankLedger() {
  return { version: LEDGER_SCHEMA_VERSION, records: [] };
}

/**
 * Distinguishes three shapes, per spec §10's "dismissal persistence survives
 * rescans AND SCHEMA BUMPS" (Fix round 1, I-2):
 *  - missing / unparseable JSON / not our recognizable shape at all ⇒
 *    CORRUPT — reads as blank, safe to overwrite (nothing recoverable).
 *  - `version === LEDGER_SCHEMA_VERSION` ⇒ the version this build owns.
 *  - a well-formed but NEWER integer `version` ⇒ a schema a future `ak`
 *    wrote that this build does not understand — `future: true`. This is
 *    NOT the same as corrupt: the file is readable, just not by this code.
 *    An older `ak` must never destroy it (that would silently resurrect
 *    every dismissed card the newer build had suppressed). The caller is
 *    responsible for checking `.future` and refusing to reconcile/save when
 *    it is set (see runPrompts/dashboardCoachingPayload) — this function
 *    only reports the shape, it never decides what happens next.
 */
export function loadLedger(filePath) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return blankLedger(); // missing/corrupt/unparseable → blank, safe to overwrite
  }
  if (raw?.version === LEDGER_SCHEMA_VERSION && Array.isArray(raw.records)) {
    return { version: raw.version, records: raw.records };
  }
  if (Number.isInteger(raw?.version) && raw.version > LEDGER_SCHEMA_VERSION && Array.isArray(raw.records)) {
    return { version: raw.version, records: raw.records, future: true };
  }
  return blankLedger(); // recognizably ours but malformed → corrupt, safe to replace
}

/** Atomic write: tmp file in the same directory, then rename — the same
 *  pattern usage-index.mjs's writeCache uses, so a reader never observes a
 *  half-written ledger. Unlike that cache, a failed write here is NOT
 *  swallowed: the ledger's whole point is durable dismissal/outcome state, and
 *  a caller (the CLI's `--dismiss`) needs to know if the persist actually
 *  happened rather than print a confirmation that lied. */
export function saveLedger(filePath, ledger) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(ledger, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, filePath);
  try { fs.chmodSync(filePath, 0o600); } catch { /* best effort on exotic filesystems */ }
}

/** Builds the working `Map<id, record>` from a loaded ledger, DISCARDING any
 *  record that is not a canonical-window record this build recognizes as
 *  valid (Fix round 1, C-1 + I-5): missing/mismatched `windowDays`, or a
 *  `status` outside the five-value enum. A discarded record is treated as
 *  though it never existed — the next pass that sees its card proposes it
 *  fresh, exactly like a brand-new id. This is a legitimate simplification
 *  only because this ledger has never shipped: there is no real record to
 *  lose, only a pre-release shape to stop trusting. */
function loadRecordsMap(ledger) {
  const map = new Map();
  for (const r of ledger?.records ?? []) {
    if (!r || typeof r !== 'object') continue;
    if (r.windowDays !== CANONICAL_WINDOW_DAYS) continue;
    if (!VALID_STATUSES.has(r.status)) continue;
    map.set(r.id, { ...r });
  }
  return map;
}

/** The evidence numbers a ledger record snapshots as its `baseline` — read
 *  fresh off the CANONICAL evidence context (Fix round 1, C-1:
 *  `adoptionInputs.currentPatterns` must be the fixed-30d context, never the
 *  operator's displayed `--window`), so every baseline in the ledger is
 *  commensurable with every other one regardless of what window was
 *  displayed the day it was written.
 *  @param {CoachingCard} card
 *  @param {{ currentPatterns?: object }} [adoptionInputs] */
function snapshotBaseline(card, adoptionInputs) {
  return { count: 0, ...(currentEvidenceFor(card.id, adoptionInputs?.currentPatterns ?? {}) ?? {}) };
}

function isoNow(now) { return new Date(now).toISOString(); }

/** The public shape both the CLI and the dashboard render: the card's own
 *  fields plus the ledger's read of it.
 *
 *  `generatedAt` is deliberately the RECORD's stamp, not the spread card's
 *  (Fix round 1, M-3): a card is re-derived fresh every pass, so its own
 *  `generatedAt` is always "now" — rendering that would make every card look
 *  freshly generated even when it has been sitting `proposed` for weeks. The
 *  record's `generatedAt` is the as-of stamp spec §6.3 means: when this
 *  recommendation was FIRST proposed, frozen from that point on (see
 *  `reconcile`'s branches — nothing but initial creation and expired-resupply
 *  ever writes it).
 *
 * `stale` is always `false` in v1 — see the module doc: a rule-derived
 * card's evidenceHash is refreshed in the same pass it would otherwise go
 * stale in, because recomputing it costs nothing (spec §6.3's staleness is a
 * Layer-3/inference concept; the field exists so a future enriched card has
 * somewhere to report it).
 *  @param {CoachingCard} card
 *  @param {LedgerRecord} record */
function annotate(card, record) {
  return {
    ...card,
    generatedAt: record.generatedAt,
    status: record.status,
    stale: false,
    dismissCount: record.dismissCount ?? 0,
    outcome: record.outcome ?? null,
    refutation: record.refutation ?? null,
  };
}

/**
 * The pure ledger transition function (spec §6.4). Given the ledger as of the
 * last pass and the cards freshly derived this pass, returns the NEXT ledger
 * plus the cards annotated with each one's current ledger status. Does not
 * persist — the caller decides whether to `saveLedger` (the CLI does, on
 * every invocation; the dashboard does not, per its read-only contract).
 *
 * `adoptionInputs.currentPatterns` MUST be the CANONICAL 30-day evidence
 * context (Fix round 1, C-1), independent of whatever window `cards` was
 * derived from for display — every baseline snapshot and outcome/collapse
 * comparison below reads through it.
 *
 * MUST NOT be called with a ledger `loadLedger` reported `future: true` for
 * (Fix round 1, I-2) — the caller checks that first and skips reconciling
 * entirely; this function does not re-check, so a future-version ledger
 * handed to it directly would be reconciled and OVERWRITTEN, which is the
 * exact hazard the caller-side check exists to prevent.
 *
 * Transitions:
 *  - a card with no existing record ⇒ new record, `proposed`, canonical
 *    baseline snapshotted now, `windowDays: CANONICAL_WINDOW_DAYS`.
 *  - `dismissed`, same evidence hash ⇒ unchanged (suppressed).
 *  - `dismissed`, changed hash, WORSENED MATERIALLY since the count recorded
 *    at dismissal (≥ DISMISS_MATERIALITY_RATIO, in the worsening direction)
 *    and dismissed fewer than DISMISS_PERMANENT_THRESHOLD times ⇒
 *    re-proposed once (fresh baseline); at or past the threshold ⇒ stays
 *    dismissed permanently. A changed hash that has NOT worsened materially
 *    leaves the record untouched — materiality is always measured against
 *    the frozen dismissal-time count, never a creeping reference, so
 *    one-at-a-time growth cannot escape detection by resetting the goalpost
 *    each pass.
 *  - `proposed` ⇒ evidence hash kept current (display only — the baseline
 *    stays frozen at proposal, which is what "collapsed since proposal"
 *    needs); adoption predicate checked; true ⇒ `adopted`, baseline
 *    RE-snapshotted at the adoption moment.
 *  - `adopted` ⇒ outcome measured every pass; not improved past
 *    OUTCOME_MIN_DAYS since adoption ⇒ `retired` with `refutation`.
 *  - `proposed` whose card did not fire this pass ⇒ `expired`.
 *  - `expired` whose card fires again ⇒ back to `proposed`, fresh
 *    evidenceHash/baseline/statusAt, but the ORIGINAL `generatedAt` and any
 *    prior `dismissCount` survive — "we lost the evidence" was never a
 *    verdict, so its reappearance is not a new recommendation.
 *  - `retired` and permanently-`dismissed` are the only terminal statuses in
 *    v1: a reappearing card does not resurrect either.
 *
 * @param {Ledger} ledger
 * @param {Array<CoachingCard>} cards this pass's `deriveCards` output
 * @param {{ adoptionInputs?: { claudeMdTexts?: string[], skillDirs?: string[],
 *   currentPatterns?: object }, now?: number }} [opts]
 * @returns {{ ledger: Ledger, cards: Array<AnnotatedCard> }}
 */
export function reconcile(ledger, cards, { adoptionInputs = {}, now = Date.now() } = {}) {
  const records = loadRecordsMap(ledger);
  const seenIds = new Set();
  const outCards = [];

  for (const card of cards ?? []) {
    seenIds.add(card.id);
    let record = records.get(card.id);

    if (!record) {
      record = {
        id: card.id, evidenceHash: card.evidenceHash, status: 'proposed',
        generatedAt: card.generatedAt, statusAt: isoNow(now),
        baseline: snapshotBaseline(card, adoptionInputs),
        windowDays: CANONICAL_WINDOW_DAYS,
      };
      records.set(card.id, record);
    } else if (record.status === 'dismissed') {
      if (record.evidenceHash !== card.evidenceHash) {
        const fresh = currentEvidenceFor(card.id, adoptionInputs.currentPatterns ?? {});
        const currentCount = Number(fresh?.count);
        const dismissedAtCount = Number(record.dismissedAtCount);
        const worsenedMaterially = Number.isFinite(currentCount) && Number.isFinite(dismissedAtCount)
          && currentCount > dismissedAtCount
          && (dismissedAtCount <= 0 || (currentCount - dismissedAtCount) / dismissedAtCount >= DISMISS_MATERIALITY_RATIO);
        if (worsenedMaterially) {
          const dismissals = record.dismissCount ?? 1;
          if (dismissals < DISMISS_PERMANENT_THRESHOLD) {
            record.status = 'proposed';
            record.evidenceHash = card.evidenceHash;
            record.statusAt = isoNow(now);
            record.baseline = snapshotBaseline(card, adoptionInputs);
            delete record.dismissedAtCount;
          } else {
            record.evidenceHash = card.evidenceHash; // bookkeeping only; permanent
          }
        }
        // else: hash moved but not materially — record left exactly as-is,
        // including evidenceHash, so materiality keeps being measured from
        // the ORIGINAL dismissal-time count every pass.
      }
    } else if (record.status === 'proposed') {
      record.evidenceHash = card.evidenceHash; // display freshness only — baseline stays at proposal
      const { adopted } = detectAdoption(card, { ...adoptionInputs, ledgerRecord: record });
      if (adopted) {
        record.status = 'adopted';
        record.statusAt = isoNow(now);
        record.baseline = snapshotBaseline(card, adoptionInputs); // re-anchor for outcome measurement
        delete record.outcome; delete record.refutation;
      }
    } else if (record.status === 'adopted') {
      const outcome = measureOutcome(record, adoptionInputs.currentPatterns);
      record.outcome = { ...outcome, measuredAt: isoNow(now) };
      if (!outcome.improved) {
        const adoptedAt = Date.parse(record.statusAt);
        if (Number.isFinite(adoptedAt) && now - adoptedAt >= OUTCOME_MIN_DAYS * DAY_MS) {
          record.status = 'retired';
          record.statusAt = isoNow(now);
          record.refutation = outcome.deltaText;
        }
      }
    } else if (record.status === 'expired') {
      record.status = 'proposed';
      record.evidenceHash = card.evidenceHash;
      record.statusAt = isoNow(now);
      record.baseline = snapshotBaseline(card, adoptionInputs);
      // generatedAt and dismissCount are deliberately left untouched.
    }
    // 'retired' and permanently-dismissed records reappearing as a live card
    // fall through unchanged above (no branch matches) — terminal in v1.

    outCards.push(annotate(card, records.get(card.id)));
  }

  for (const [id, record] of records) {
    if (record.status === 'proposed' && !seenIds.has(id)) {
      record.status = 'expired';
      record.statusAt = isoNow(now);
    }
  }

  return { ledger: { version: LEDGER_SCHEMA_VERSION, records: [...records.values()] }, cards: outCards };
}

/**
 * The explicit `--dismiss <id>` mutation (CLI-only — spec §3.3's privacy
 * split keeps dismissal off the dashboard). `cardId` must name a card this
 * pass actually derived; an id with no live evidence is rejected by the
 * caller printing the known-id list, not silently accepted here.
 *
 * Snapshots `dismissedAtCount` from the CANONICAL evidence context (Fix
 * round 1, I-1) — the count re-proposal's materiality gate compares future
 * counts against.
 *
 * @param {Ledger} ledger
 * @param {string} cardId
 * @param {Array<CoachingCard>} cards this pass's `deriveCards` output
 * @param {{ adoptionInputs?: { currentPatterns?: object }, now?: number }} [opts]
 * @returns {{ ledger: Ledger, found: boolean }}
 */
export function dismissCard(ledger, cardId, cards, { adoptionInputs = {}, now = Date.now() } = {}) {
  const card = (cards ?? []).find((c) => c.id === cardId);
  if (!card) return { ledger, found: false };
  const records = loadRecordsMap(ledger);
  const record = records.get(cardId) ?? {
    id: cardId, evidenceHash: card.evidenceHash, status: 'proposed',
    generatedAt: card.generatedAt, statusAt: isoNow(now), baseline: { count: 0 },
    windowDays: CANONICAL_WINDOW_DAYS,
  };
  record.status = 'dismissed';
  record.evidenceHash = card.evidenceHash;
  record.dismissCount = (record.dismissCount ?? 0) + 1;
  record.statusAt = isoNow(now);
  record.dismissedAtCount = snapshotBaseline(card, adoptionInputs).count;
  records.set(cardId, record);
  return { ledger: { version: LEDGER_SCHEMA_VERSION, records: [...records.values()] }, found: true };
}

/** Counts per status, over the WHOLE ledger — including records whose card
 *  is not currently firing, so a dismissed/retired history stays visible even
 *  in a quiet window. */
export function summarizeLedger(records) {
  const summary = { proposed: 0, adopted: 0, dismissed: 0, expired: 0, retired: 0 };
  for (const r of records ?? []) if (Object.hasOwn(summary, r.status)) summary[r.status]++;
  return summary;
}

const CLAUDE_MD_CANDIDATES = ['CLAUDE.md', 'CLAUDE.local.md'];
const SKILLS_DIR_REL = path.join('.claude', 'skills');

function readTextIfExists(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

/**
 * The filesystem half of `detectAdoption`'s inputs, gathered once per run and
 * shared by the CLI and the dashboard so the two never disagree about what
 * counts as adopted. Reads the given working directory's own CLAUDE.md /
 * CLAUDE.local.md and `.claude/skills/` — the project `ak usage prompts` (or
 * the dashboard) was started against, exactly like the agent-facing CLAUDE.md
 * convention itself. Missing files/dirs read as empty lists, not errors: a
 * project with no CLAUDE.md yet has adopted nothing, which is the honest
 * answer, not a failure.
 *
 * `cwd` has no default (Fix round 1, M-6): a caller must pass one explicitly
 * — `process.cwd()` on the CLI, `startDashboard`'s own configured `cwd` on
 * the dashboard — rather than this function silently reading the CURRENT
 * process's cwd, which need not be the same directory across the two
 * surfaces (the dashboard process's cwd is not guaranteed to be the one
 * `ak usage prompts` runs in).
 *
 * @param {string} cwd
 * @returns {{ claudeMdTexts: string[], skillDirs: string[] }}
 */
export function gatherAdoptionInputs(cwd) {
  const claudeMdTexts = CLAUDE_MD_CANDIDATES
    .map((name) => readTextIfExists(path.join(cwd, name)))
    .filter((t) => typeof t === 'string');
  let skillDirs = [];
  try {
    skillDirs = fs.readdirSync(path.join(cwd, SKILLS_DIR_REL), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch { /* no skills dir yet — an empty list is honest, not an error */ }
  return { claudeMdTexts, skillDirs };
}
