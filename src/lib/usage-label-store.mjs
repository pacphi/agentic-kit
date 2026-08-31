// usage-label-store.mjs — persistence for layer-3 enrichment artifacts (spec
// §6.3, W5 build). Two kinds of cached artifact share one versioned file
// beside the outcome ledger:
//
//   - LABELS: usage-prompt-vocabulary.mjs's own store contract,
//     `{ [clusterKey]: { name, source: 'curated'|'enriched', firstSeen } }`.
//     Settled labels are never re-judged (that module's own doc) — this file
//     never decides that; it only persists what `usage-enrich.mjs` produced.
//   - CARDS: synthesized coaching cards' CONTENT (title/finding/try/basis/
//     basisNumbers/evidenceHash/generatedAt), keyed by their namespaced id
//     (`enriched-<slug>`). The outcome ledger (usage-outcome-ledger.mjs)
//     tracks an enriched card's LIFECYCLE (proposed/adopted/dismissed/…) the
//     same as a rule card's; it has never held card PROSE, and extending it
//     to do so would mix a lifecycle-only contract with content that has
//     nothing to do with adoption/outcome tracking. This file is where an
//     enriched card's words live, so `ak usage prompts` (with or without
//     `--enrich`) can re-supply the SAME card object to `reconcile` every
//     pass without spending another model call to reconstruct its text.
//
// DISCIPLINE MIRRORED FROM usage-outcome-ledger.mjs (Fix round 1, I-2), on
// this brief's explicit instruction: missing/corrupt/unparseable → blank,
// safe to overwrite (nothing recoverable); a well-formed but NEWER version →
// reported as `future: true` and never destroyed (the caller must refuse to
// reconcile/overwrite it — see runPrompts); atomic tmp+rename write.
//
// INVARIANT (test-pinned): no label NAME ever exceeds 48 characters, contains
// a newline, or carries a control/bidi character (`isValidLabelName`, the same
// predicate usage-enrich.mjs's response validation uses — ONE place owns what
// a legal label value is). No card field ever contains a newline or such a
// character either. All are enforced HERE, on every write AND every read —
// not merely trusted of the caller —
// because this is the layer-3 privacy boundary's last line of defense before
// something reaches disk. Card prose (finding/try/basis) is deliberately NOT
// held to the label's 48-char ceiling: "13 recurrences across 11 sessions, 9
// days." is a normal basis string, well past 48 characters, exactly like
// every existing RULE card's finding/basis text (usage-coaching-rules.mjs).
//
// NO EXEMPLAR TEXT IS EVER PERSISTED HERE — not because this module scans for
// it (it cannot tell a masked exemplar snippet from any other sentence), but
// because usage-enrich.mjs never returns one: a label's `name` is a model-
// proposed short name, a card's prose is model-proposed coaching text, and
// neither is ever the exemplar text itself. This module's job is to persist
// exactly the shape it is handed, faithfully and atomically.
import fs from 'node:fs';
import path from 'node:path';
import { configDir } from './paths.mjs';
import { hasUnsafeChars } from './text-safety.mjs';
import { writePrivateFileAtomic } from './file-write.mjs';

export const LABEL_STORE_SCHEMA_VERSION = 1;

const MAX_LABEL_NAME_CHARS = 48;

export function defaultLabelStorePath() {
  return path.join(configDir(), 'usage-prompt-labels.json');
}

function blankStore() {
  return {
    version: LABEL_STORE_SCHEMA_VERSION, labels: {}, cards: {}, lastSynthesis: null,
  };
}

/** One stored `lastSynthesis` record, or `null` if malformed — the same
 *  drop-not-fabricate discipline as a label/card entry. Fix round 1, I-1(a):
 *  records the findingsSummary hash and timestamp of the last pass that
 *  ACTUALLY called `synthesizeCards` (never a skipped one — see
 *  usage/enrich.mjs's runEnrichPass), so a later pass can tell "nothing has
 *  moved since we last asked" without an invocation. */
function sanitizedLastSynthesis(value) {
  if (!value || typeof value !== 'object') return null;
  if (typeof value.findingsHash !== 'string' || !value.findingsHash) return null;
  if (typeof value.at !== 'string' || !value.at) return null;
  return { findingsHash: value.findingsHash, at: value.at };
}

/**
 * The shared invariant for a cluster label NAME — usage-enrich.mjs's response
 * validation and this module's defensive write-time filter both call this, so
 * "what a legal label value is" is defined in exactly one place.
 *
 * @param {unknown} name
 * @returns {boolean}
 */
export function isValidLabelName(name) {
  if (typeof name !== 'string') return false;
  const trimmed = name.trim();
  if (!trimmed) return false;
  if (trimmed.length > MAX_LABEL_NAME_CHARS) return false;
  // Security review SEC-2: checked on the RAW string, not the trimmed one.
  // `String.prototype.trim` removes whitespace, and every character
  // text-safety.mjs rejects is a control or a mark, not whitespace — except
  // the ones trim WOULD eat, which must still fail. Checking the raw string
  // means nothing gets in by hiding where a trim would have looked.
  if (hasUnsafeChars(name)) return false;
  // Fix round 1, M-2: newline-checked against the TRIMMED name, matching the
  // length check above — every caller stores `.trim()`'d text (enrichLabels'
  // `item.name.trim()`), so a name like "Release ritual\n" (a trailing
  // newline a trim already removes) must not be rejected on the raw string
  // alone; a newline INSIDE the trimmed text still fails, correctly.
  return !/[\r\n]/.test(trimmed);
}

/** No embedded newline, and no control or bidi character — the invariants
 *  every free-text CARD field is held to (prose length itself is not capped
 *  the way a label name is; see the module doc). `undefined`/non-string is
 *  invalid: a card field is required.
 *
 *  Security review SEC-2 added the second half. Card prose reaches the
 *  terminal through `printCoachingCard` and the DOM through `coachingCard`,
 *  and the review painted a fabricated red "ak: SECURITY ALERT" banner over a
 *  cleared screen using nothing but a card's `finding` text. */
function isSingleLineText(value) {
  return typeof value === 'string' && value.length > 0
    && !/[\r\n]/.test(value) && !hasUnsafeChars(value);
}

/** One stored label entry, or null if it fails the invariant — dropped, not
 *  truncated: a truncated name could cut mid-word, which is its own kind of
 *  dishonesty. `source` is not re-validated here (usage-prompt-vocabulary.mjs
 *  already treats an unrecognized source as `curated` at READ time; this
 *  module persists whatever string it is given for that field, since it is a
 *  closed enum elsewhere, not free text). */
function sanitizedLabelEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (!isValidLabelName(entry.name)) return null;
  return {
    // QE review F-10: TRIMMED on persist. `isValidLabelName` validates the
    // trimmed name — length and newlines both — while this used to store the
    // raw one, so the module's own stated invariant ("no label NAME ever
    // exceeds 48 characters or contains a newline") was false on disk: a name
    // of "  \n\n  Release ritual  \n\n  " persisted with its newlines intact,
    // and a 48-character name plus padding exceeded the ceiling. No render was
    // wrong (every read path trims and both surfaces escape), but an invariant
    // that is only true after the reader repairs it is not an invariant.
    name: entry.name.trim(),
    source: typeof entry.source === 'string' ? entry.source : 'curated',
    firstSeen: typeof entry.firstSeen === 'string' ? entry.firstSeen : null,
  };
}

const CARD_TEXT_FIELDS = ['title', 'finding', 'try', 'basis'];

/** One stored card entry, or null if any of its free-text fields carries a
 *  newline, its `basisNumbers` is not an array of finite numbers, or its
 *  `evidenceHash`/`generatedAt` are not strings — the shape `usage-
 *  enrich.mjs`'s `synthesizeCards` produces after the anti-fabrication gate. */
function sanitizedCardEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  for (const field of CARD_TEXT_FIELDS) if (!isSingleLineText(entry[field])) return null;
  if (!Array.isArray(entry.basisNumbers) || !entry.basisNumbers.every((n) => Number.isFinite(n))) return null;
  if (typeof entry.evidenceHash !== 'string' || !entry.evidenceHash) return null;
  if (typeof entry.generatedAt !== 'string' || !entry.generatedAt) return null;
  const out = {
    title: entry.title, finding: entry.finding, try: entry.try, basis: entry.basis,
    basisNumbers: [...entry.basisNumbers], evidenceHash: entry.evidenceHash, generatedAt: entry.generatedAt,
  };
  return out;
}

/**
 * The KEY contracts, enforced on both sides of the file.
 *
 * Security review SEC-4 (MEDIUM): `sanitizedEntries` used to sanitize the
 * entry VALUE only — `entries[key] = sanitized` accepted any key whatsoever.
 * The write path already enforced the card-id shape against model output
 * (`usage-enrich.mjs`'s `CARD_ID_SLUG_RE`); the read path did not, so a store
 * edited out of band could name a card anything, and `hydrateStoredCards`
 * turned that key straight into `card.id`. The review drove it end to end:
 *
 *   ak usage prompts --dismiss "$(printf 'enriched-evil\033[31m\033]0;PWNED\007')"
 *   -> exit 0, "Dismissed 'enriched-evil<ESC>[31m<ESC>]0;PWNED<BEL>'"
 *
 * This is the same asymmetry the Fix-round-2 I-8/M-8 comment below closed for
 * entry VALUES. The key was left out.
 *
 * A card id is the namespaced slug `synthesizeCards` builds
 * (`enriched-<slug>`), which is exactly the shape CARD_ID_RE describes — the
 * write path's own contract, now enforced on read as well. Exported so
 * `usage-enrich.mjs` validates against the same definition rather than a
 * second copy of it; this module already owns "what a legal label value is"
 * for the same reason.
 *
 * A LABEL key is deliberately held to a WEAKER rule. It is a cluster key —
 * `usage-prompt-patterns.mjs` makes those a SHA-256 hex prefix — but nothing
 * in the format is load-bearing here, an orphaned key is inert (it simply
 * matches no cluster), and pinning the store to today's hashing scheme would
 * be this module inventing a contract the codebase does not otherwise have.
 * What it does refuse is the part that made SEC-4 a finding at all: a key
 * carrying control or bidi characters, or one long enough to be a payload.
 */
export const CARD_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const MAX_KEY_CHARS = 120;

const isCardId = (key) => typeof key === 'string'
  && key.length <= MAX_KEY_CHARS && CARD_ID_RE.test(key);
const isLabelKey = (key) => typeof key === 'string'
  && key.length > 0 && key.length <= MAX_KEY_CHARS && !hasUnsafeChars(key);

/** Applies `sanitizer` to every entry of `rawMap` whose KEY passes
 *  `keyIsValid`, dropping (never fixing or
 *  truncating) any entry that fails either, and counting the drops. Fix round 2
 *  (I-8/M-8): shared by BOTH the read path (loadLabelStore) and the write
 *  path (saveLabelStore) now, so "what counts as a legal entry" is enforced
 *  identically on both sides of the file — a malformed entry can no longer
 *  survive on disk (write-time, unchanged since Fix round 1) NOR reach a
 *  caller in memory (read-time, new this round) just because it arrived by
 *  some path other than this module's own write. */
function sanitizedEntries(rawMap, sanitizer, keyIsValid) {
  const entries = Object.create(null);
  let dropped = 0;
  for (const [key, entry] of Object.entries(rawMap ?? {})) {
    const sanitized = keyIsValid(key) ? sanitizer(entry) : null;
    if (sanitized) entries[key] = sanitized;
    else dropped++;
  }
  return { entries, dropped };
}

/**
 * Distinguishes three shapes, per the ledger's own I-2 rule:
 *  - missing / unparseable JSON / not a recognizable `{version, labels,
 *    cards}` shape at all ⇒ CORRUPT — reads as blank, safe to overwrite.
 *  - `version === LABEL_STORE_SCHEMA_VERSION` ⇒ the version this build owns.
 *  - a well-formed but NEWER integer `version` ⇒ `future: true`. NOT the same
 *    as corrupt: the file is readable, just not by this code. The caller is
 *    responsible for refusing to reconcile/overwrite when `.future` is set
 *    (this function only reports the shape).
 *
 * @typedef {{ name: string, source: string, firstSeen: string|null }} LabelEntry
 * @typedef {{ title: string, finding: string, try: string, basis: string,
 *   basisNumbers: number[], evidenceHash: string, generatedAt: string }} CardEntry
 * @typedef {{ findingsHash: string, at: string }} LastSynthesis
 * @typedef {{ labels: number, cards: number }} DroppedCounts
 * @typedef {{ version: number, labels: Record<string, LabelEntry>,
 *   cards: Record<string, CardEntry>, lastSynthesis: LastSynthesis|null,
 *   future?: true, dropped?: DroppedCounts }} LabelStore
 *
 * @param {string} filePath
 * @returns {LabelStore}
 */
export function loadLabelStore(filePath) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return blankStore();
  }
  const wellFormed = raw && typeof raw === 'object'
    && Number.isInteger(raw.version)
    && raw.labels && typeof raw.labels === 'object' && !Array.isArray(raw.labels)
    && raw.cards && typeof raw.cards === 'object' && !Array.isArray(raw.cards);
  if (!wellFormed) return blankStore();
  // `lastSynthesis` is optional on read — a store written before this field
  // existed has none, which reads as "never synthesized", correctly forcing
  // the first --enrich after an upgrade to run synthesis once rather than
  // assuming a hash match it never actually recorded.
  const lastSynthesis = sanitizedLastSynthesis(raw.lastSynthesis);
  // Fix round 2, I-8/M-8: `raw.labels`/`raw.cards` used to be returned
  // VERBATIM here — the write path's own entry validation
  // (sanitizedLabelEntry/sanitizedCardEntry) never ran on read. This build
  // never WRITES a malformed entry, so reaching one required an out-of-band
  // edit, a hand-recovered file, another build, or corruption that still
  // parses as JSON — but when it happened, a card missing `basisNumbers`
  // reached `isCardStale` (a deliberate throw-on-malformed contract there)
  // and crashed the whole command with a raw TypeError, `--enrich` or not.
  // Sanitizing here closes that (I-8) AND a second bug sharing the same root
  // cause (M-8): a label entry with a blank/invalid `name` used to still
  // read back as a real store entry, so `labelCandidates`' key-presence
  // check (`!store?.[c.key]`) would permanently exclude its cluster from
  // ever being offered to `enrichLabels` again, even though the entry was
  // never a legal label to begin with. Dropping it here means `store[c.key]`
  // reads `undefined` for it, exactly as if the bad write had never
  // happened — the cluster becomes a normal candidate again. Applied to
  // BOTH the current-version and future-version branches below: a future
  // schema's `cards`/`labels` are already never re-saved by this build (the
  // caller refuses to write a `future` store), so sanitizing what is READ
  // from one only removes a crash vector, never data this build could have
  // preserved correctly anyway.
  const { entries: rawLabels, dropped: droppedLabels } = sanitizedEntries(raw.labels, sanitizedLabelEntry, isLabelKey);
  const { entries: rawCards, dropped: droppedCards } = sanitizedEntries(raw.cards, sanitizedCardEntry, isCardId);
  const dropped = droppedLabels || droppedCards ? { labels: droppedLabels, cards: droppedCards } : undefined;
  // sanitizedEntries accumulates on a null-prototype object (safe against a
  // key literally named "__proto__" hijacking the accumulator's own
  // prototype during the build-up). saveLabelStore's copy of this never
  // needed to unwrap it — its result goes straight into JSON.stringify,
  // which is prototype-agnostic. loadLabelStore's result does NOT go through
  // another serialization step before reaching a caller, so it is spread
  // into a plain object here — object-spread copies via CreateDataProperty,
  // not the `[[Set]]` a plain `{}`'s bracket-assignment would have used, so
  // a `"__proto__"`-named entry still lands as an ordinary own property
  // rather than reinterpreting itself as a prototype re-link.
  const base = {
    version: raw.version, labels: { ...rawLabels }, cards: { ...rawCards }, lastSynthesis,
    ...(dropped ? { dropped } : {}),
  };
  if (raw.version === LABEL_STORE_SCHEMA_VERSION) return base;
  if (raw.version > LABEL_STORE_SCHEMA_VERSION) return { ...base, future: true };
  return blankStore();
}

/**
 * Atomic write: tmp file in the same directory, then rename — the same
 * pattern usage-outcome-ledger.mjs's saveLedger uses. Every label/card entry
 * is re-validated here, defensively, and silently dropped if it fails the
 * invariant — the anti-fabrication/response-validation gates in
 * usage-enrich.mjs already filter before this is ever called, so a drop here
 * means either a caller bypassed that gate or a future bug did; this module
 * still refuses to let a malformed entry reach disk either way.
 *
 * MUST NOT be called with a store `loadLabelStore` reported `future: true`
 * for — the caller checks that first and skips saving entirely (the same
 * contract runPrompts already honors for the outcome ledger).
 *
 * @param {string} filePath
 * @param {{ version: number, labels: Record<string, object>, cards: Record<string, object>,
 *   lastSynthesis?: object|null }} store
 */
export function saveLabelStore(filePath, store) {
  const { entries: labels } = sanitizedEntries(store?.labels, sanitizedLabelEntry, isLabelKey);
  const { entries: cards } = sanitizedEntries(store?.cards, sanitizedCardEntry, isCardId);
  const lastSynthesis = sanitizedLastSynthesis(store?.lastSynthesis);
  const next = {
    version: LABEL_STORE_SCHEMA_VERSION, labels, cards, lastSynthesis,
  };
  writePrivateFileAtomic(filePath, JSON.stringify(next, null, 2));
}
