// usage-outcome-ledger.mjs — the coaching outcome ledger's store (spec §6.4):
// small I/O (a JSON file beside the usage-index cache) plus the ledger's own
// state-transition logic. Card DERIVATION and its predicates live in
// usage-coaching.mjs, which this module imports FROM — never the reverse.
//
// INVARIANT, test-pinned: no field anywhere in a ledger record ever holds
// prompt text — ids, hashes, counts, host names and curated label names only.
// Every string this module writes is either a fixed enum, a timestamp, or a
// template built from numbers (see measureOutcome's deltaText).
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
 */

export const LEDGER_SCHEMA_VERSION = 1;

/** A dismissed card whose evidence hash has changed gets ONE re-proposal
 *  (spec §6.4 decay); at this many dismissals it stops re-proposing even
 *  across a hash change — the operator has said no twice. */
export const DISMISS_PERMANENT_THRESHOLD = 2;

export function defaultLedgerPath() {
  return path.join(configDir(), 'usage-outcome-ledger.json');
}

function blankLedger() {
  return { version: LEDGER_SCHEMA_VERSION, records: [] };
}

/** A missing or corrupt ledger reads as blank — the same "first run" shape a
 *  brand-new install has, never an error. Schema drift (a future version this
 *  build does not understand) also reads as blank rather than guessing at a
 *  migration; nothing here has shipped a v2 yet. */
export function loadLedger(filePath) {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (raw?.version === LEDGER_SCHEMA_VERSION && Array.isArray(raw.records)) {
      return { version: raw.version, records: raw.records };
    }
  } catch { /* missing/corrupt → blank */ }
  return blankLedger();
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

/** The evidence numbers a ledger record snapshots as its `baseline` — read
 *  fresh off the SAME evidence context that produced `card` this pass (not a
 *  re-guess: `adoptionInputs.currentPatterns` is that identical context,
 *  handed through unchanged), so the snapshot always matches what the card
 *  actually said.
 *  @param {CoachingCard} card
 *  @param {{ currentPatterns?: object }} [adoptionInputs] */
function snapshotBaseline(card, adoptionInputs) {
  return { count: 0, ...(currentEvidenceFor(card.id, adoptionInputs?.currentPatterns ?? {}) ?? {}) };
}

function isoNow(now) { return new Date(now).toISOString(); }

/** The public shape both the CLI and the dashboard render: the card's own
 *  fields plus the ledger's read of it. `stale` is always `false` in v1 — see
 *  the module doc: a rule-derived card's evidenceHash is refreshed in the same
 *  pass it would otherwise go stale in, because recomputing it costs nothing
 *  (spec §6.3's staleness is a Layer-3/inference concept; the field exists so
 *  a future enriched card has somewhere to report it).
 *  @param {CoachingCard} card
 *  @param {LedgerRecord} record */
function annotate(card, record) {
  return {
    ...card,
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
 * Transitions:
 *  - a card with no existing record ⇒ new record, `proposed`, baseline
 *    snapshotted now.
 *  - `dismissed`, same evidence hash ⇒ unchanged (suppressed).
 *  - `dismissed`, changed hash, dismissed fewer than
 *    DISMISS_PERMANENT_THRESHOLD times ⇒ re-proposed once (fresh baseline);
 *    at or past the threshold ⇒ stays dismissed permanently.
 *  - `proposed` ⇒ evidence hash kept current (display only — the baseline
 *    stays frozen at proposal, which is what "collapsed since proposal"
 *    needs); adoption predicate checked; true ⇒ `adopted`, baseline
 *    RE-snapshotted at the adoption moment.
 *  - `adopted` ⇒ outcome measured every pass; not improved past
 *    OUTCOME_MIN_DAYS since adoption ⇒ `retired` with `refutation`.
 *  - `proposed` whose card did not fire this pass ⇒ `expired`.
 *  - `expired`/`retired`/`dismissed`-permanent are terminal in v1: a
 *    reappearing card does not resurrect them (`expired` is the one
 *    exception — see the loop below — because "we lost the evidence" is not a
 *    verdict the way retirement or a second dismissal is).
 *
 * @param {Ledger} ledger
 * @param {Array<CoachingCard>} cards this pass's `deriveCards` output
 * @param {{ adoptionInputs?: { claudeMdTexts?: string[], skillDirs?: string[],
 *   currentPatterns?: object }, now?: number }} [opts]
 * @returns {{ ledger: Ledger, cards: Array<object> }}
 */
export function reconcile(ledger, cards, { adoptionInputs = {}, now = Date.now() } = {}) {
  const records = new Map((ledger?.records ?? []).map((r) => [r.id, { ...r }]));
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
      };
      records.set(card.id, record);
    } else if (record.status === 'dismissed') {
      if (record.evidenceHash !== card.evidenceHash) {
        const dismissals = record.dismissCount ?? 1;
        if (dismissals < DISMISS_PERMANENT_THRESHOLD) {
          record.status = 'proposed';
          record.evidenceHash = card.evidenceHash;
          record.generatedAt = card.generatedAt;
          record.statusAt = isoNow(now);
          record.baseline = snapshotBaseline(card, adoptionInputs);
        } else {
          record.evidenceHash = card.evidenceHash; // bookkeeping only; status stays dismissed forever
        }
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
    }
    // 'expired' or 'retired' records reappearing as a live card fall through
    // unchanged above (no branch matches those statuses) — terminal in v1.

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
 * @param {Ledger} ledger
 * @param {string} cardId
 * @param {Array<CoachingCard>} cards this pass's `deriveCards` output
 * @param {number} [now]
 * @returns {{ ledger: Ledger, found: boolean }}
 */
export function dismissCard(ledger, cardId, cards, now = Date.now()) {
  const card = (cards ?? []).find((c) => c.id === cardId);
  if (!card) return { ledger, found: false };
  const records = new Map((ledger?.records ?? []).map((r) => [r.id, { ...r }]));
  const record = records.get(cardId) ?? {
    id: cardId, evidenceHash: card.evidenceHash, status: 'proposed',
    generatedAt: card.generatedAt, statusAt: isoNow(now), baseline: { count: 0 },
  };
  record.status = 'dismissed';
  record.evidenceHash = card.evidenceHash;
  record.dismissCount = (record.dismissCount ?? 0) + 1;
  record.statusAt = isoNow(now);
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
 * counts as adopted. Reads the CURRENT working directory's own CLAUDE.md /
 * CLAUDE.local.md and `.claude/skills/` — the project `ak usage prompts` (or
 * the dashboard) was started against, exactly like the agent-facing CLAUDE.md
 * convention itself. Missing files/dirs read as empty lists, not errors: a
 * project with no CLAUDE.md yet has adopted nothing, which is the honest
 * answer, not a failure.
 *
 * @param {string} [cwd]
 * @returns {{ claudeMdTexts: string[], skillDirs: string[] }}
 */
export function gatherAdoptionInputs(cwd = process.cwd()) {
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
