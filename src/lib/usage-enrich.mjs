// usage-enrich.mjs — the layer-3 enrichment ENGINE (spec §6.3): delta-only
// cluster labeling and coaching-card synthesis. Pure logic with an INJECTED
// `invoke` (src/lib/llm-invoke.mjs's `makeInvoke().invoke`, or a fake one in
// every test) — this module never spawns a process itself and never decides
// whether inference is available; the CLI wiring owns both of those.
//
// Ground truth this module was built against: no inference path existed
// anywhere in this kit before it (providers.mjs is detection/wiring only).
// Every guarantee below is therefore enforced HERE, not inherited from
// precedent elsewhere.
//
// THE PRIVACY SPLIT IS LOAD-BEARING (spec §2.3). `enrichLabels` receives
// masked exemplar text ONLY (never raw), and defensively re-caps/re-masks it
// anyway — the caller is trusted to have already done both, but this
// function does not trust its own caller absolutely on the one boundary that
// keeps prompt text off the dashboard permanently. `synthesizeCards` never
// receives exemplar text AT ALL — `findingsSummary` is counts/labels/shares,
// nothing else, and this module has no code path that could smuggle text
// past that even if a caller tried.
//
// THE ANTI-FABRICATION GATE IS NOT OPTIONAL (spec §6.3's "never silently
// spending tokens" extends to never silently INVENTING a number either).
// Every number a synthesized card states in its finding/try/basis text, and
// every number in its own basisNumbers, must be traceable to a number that
// is ACTUALLY present in the findingsSummary the model was given. A card
// that cites even one number nobody supplied is dropped, unconditionally —
// this is the single most load-bearing test in this wave.
import { evidenceHash } from './usage-evidence-hash.mjs';
import { maskSecrets } from './usage-aggregate.mjs';
import { isValidLabelName } from './usage-label-store.mjs';
import { withStoreLabel } from './usage-prompt-vocabulary.mjs';

/**
 * @typedef {import('./usage-coaching.mjs').CoachingCard} CoachingCard
 * @typedef {{ key: string, label: { name?: string, source?: string, descriptor?: string },
 *   class?: string, count?: number, sessions?: number, days?: number, hosts?: string[],
 *   medianTokens?: number, sampleSessionIds?: string[] }} ClusterRow the published cluster
 *   shape (usage-aggregate.mjs's `promptClusterRow`)
 * @typedef {{ clusters?: ClusterRow[], reAsks?: { pairCount?: number, sessionCount?: number },
 *   exactRepeats?: Array<{ count?: number, tokens?: number, sessions?: number, days?: number }> }} PromptPatterns
 * @typedef {{ promptPatterns?: PromptPatterns|null, promptsByHost?: Record<string, {
 *   typed?: number, taps?: number, tapShare?: number|null, questionShare?: number|null,
 *   p90TypedTokens?: number|null, personaOpeners?: number }>|null }} AggLike the slice of an
 *   aggregate this module reads — never the whole `Aggregate` shape
 */

/** Spec §6.3: settled labels are never re-judged. A candidate is a cluster
 *  with NO store entry (label source would be 'curated' or 'enriched' if it
 *  had one — see usage-prompt-vocabulary.mjs's `withStoreLabel`) and NO seed
 *  match either (source would be 'seed'). Only the honest fallback,
 *  'characterized', with enough recurrence to be worth a model call. */
const MIN_CANDIDATE_COUNT = 3;

/** The privacy split's numeric bounds (spec §2.3/§6.3), enforced HERE even
 *  though the caller is expected to have already applied them — defense in
 *  depth on a load-bearing boundary, not a trust assumption. */
const MAX_EXEMPLARS_PER_CLUSTER = 2;
const MAX_EXEMPLAR_CHARS = 200;

/** "Asks for 0..3 additional coaching suggestions" (spec §6.3) — a hard cap
 *  regardless of how many the model returns. */
const MAX_SYNTHESIZED_CARDS = 3;

const CARD_ID_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ENRICHED_ID_PREFIX = 'enriched-';

/** Every free-text field a card must supply, shape-checked (non-empty,
 *  single-line) — title included. */
const CARD_TEXT_FIELDS = ['title', 'finding', 'try', 'basis'];

/** The SUBSET of CARD_TEXT_FIELDS the anti-fabrication gate checks numbers
 *  in. `title` is deliberately excluded: a stylistic number there ("Top 3
 *  wins") asserts no evidence the way a claim inside "finding"/"try"/"basis"
 *  does, and gating it would make an incidental title number void an
 *  otherwise fully-grounded card. */
const CARD_FABRICATION_FIELDS = ['finding', 'try', 'basis'];

// ── shared: parse a JSON array out of arbitrary model text ─────────────────
// A model instructed to "respond with ONLY a JSON array" sometimes wraps it
// in prose or a code fence anyway. This is defensive extraction, not a
// trust boundary — everything extracted still goes through full validation
// below; a response that cannot be parsed at all yields zero results, never
// a throw (spec: never a stack trace).

function parseJsonArray(text) {
  if (typeof text !== 'string') return [];
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return [];
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// ── enrichLabels ─────────────────────────────────────────────────────────

/** Delta-only candidate selection. `clusters` is the PUBLISHED row shape
 *  (`usage-aggregate.mjs`'s `promptClusterRow`) after the caller has already
 *  re-resolved it against the real store (`withStoreLabel`) — a cluster with
 *  a settled label reads `label.source` as 'curated'/'enriched', not
 *  'characterized', so filtering on 'characterized' alone is the delta. */
function labelCandidates(clusters) {
  return (Array.isArray(clusters) ? clusters : [])
    .filter((c) => c?.label?.source === 'characterized' && Number(c.count) >= MIN_CANDIDATE_COUNT);
}

/** Masked, capped exemplar snippets for one cluster — the ≤2-per-cluster,
 *  ≤200-char bound applied defensively regardless of what the caller
 *  supplied, and `maskSecrets` re-applied (idempotent on already-masked
 *  text) so this function can never be the reason a raw secret reaches a
 *  prompt even if a future caller forgot to mask first. */
function maskedExemplarsFor(key, exemplarsByKey) {
  const list = Array.isArray(exemplarsByKey?.[key]) ? exemplarsByKey[key] : [];
  return list.slice(0, MAX_EXEMPLARS_PER_CLUSTER).map((text) => {
    const masked = maskSecrets(String(text ?? ''));
    return masked.length > MAX_EXEMPLAR_CHARS ? masked.slice(0, MAX_EXEMPLAR_CHARS) : masked;
  });
}

function buildLabelPrompt(candidates, exemplarsByKey) {
  const lines = candidates.map((c) => {
    const exemplars = maskedExemplarsFor(c.key, exemplarsByKey);
    const sampleLines = exemplars.length
      ? exemplars.map((e, i) => `    ${i + 1}. ${JSON.stringify(e)}`).join('\n')
      : '    (no exemplar available)';
    return `- key: ${c.key}\n  count: ${c.count}, sessions: ${c.sessions}, days: ${c.days}\n  samples:\n${sampleLines}`;
  }).join('\n');
  return 'You are naming recurring prompt clusters for a developer-analytics tool. For each cluster '
    + 'below, propose a short, human-readable name (1 to 48 characters, no newlines) describing what '
    + 'the recurring request is about, based only on the sample text shown for that cluster. Respond '
    + 'with ONLY a JSON array, no prose before or after it, in this exact shape:\n'
    + '[{"key":"<the cluster key, verbatim>","name":"<your proposed name>"}]\n\n'
    + `Clusters:\n${lines}`;
}

/**
 * @param {{ clusters: ClusterRow[], exemplarsByKey: Record<string, string[]>,
 *   store: Record<string, object>, invoke: (prompt: string) => Promise<string>,
 *   now: number }} input
 * @returns {Promise<{ entries: Record<string, {name: string, source: 'enriched', firstSeen: string}>,
 *   candidates: string[], labeled: number, dropped: number }>}
 */
export async function enrichLabels({
  clusters, exemplarsByKey, store: _store, invoke, now,
}) {
  const candidateRows = labelCandidates(clusters);
  const candidateKeys = candidateRows.map((c) => c.key);
  if (!candidateRows.length) {
    return {
      entries: {}, candidates: [], labeled: 0, dropped: 0,
    };
  }

  const raw = await invoke(buildLabelPrompt(candidateRows, exemplarsByKey));
  const parsed = parseJsonArray(raw);
  const askedKeys = new Set(candidateKeys);

  const entries = {};
  const seen = new Set();
  let dropped = 0;
  for (const item of parsed) {
    const key = item && typeof item.key === 'string' ? item.key : null;
    if (!key || !askedKeys.has(key) || seen.has(key)) { dropped++; continue; }
    if (!isValidLabelName(item.name)) { dropped++; continue; }
    seen.add(key);
    entries[key] = { name: item.name.trim(), source: 'enriched', firstSeen: new Date(now).toISOString() };
  }

  return {
    entries, candidates: candidateKeys, labeled: Object.keys(entries).length, dropped,
  };
}

// ── buildFindingsSummary ────────────────────────────────────────────────────

/** A fraction (0..1) rendered the way a model would cite it in prose — a
 *  rounded whole-number percent — so the anti-fabrication gate's number
 *  matching lines up with what a card is actually likely to say ("35%"),
 *  not a floating fraction (0.35) nobody would type. `null` in, `null` out:
 *  an unmeasured share is not a measured zero. */
function pctOf(share) {
  return typeof share === 'number' && Number.isFinite(share) ? Math.round(share * 100) : null;
}

/**
 * Counts/labels/shares ONLY — no exemplar text exists here to leak, by
 * construction: nothing this function reads from `agg` ever carries prompt
 * text (cluster NAMES are curated-vocabulary strings, never raw text; every
 * other field is a number). This is the one input `synthesizeCards` sees.
 *
 * @param {AggLike} agg
 * @returns {object}
 */
export function buildFindingsSummary(agg) {
  const pp = agg?.promptPatterns;
  const clusters = Array.isArray(pp?.clusters) ? pp.clusters.map((c) => ({
    key: c.key,
    name: typeof c.label?.name === 'string' ? c.label.name : null,
    class: c.class, count: c.count, sessions: c.sessions, days: c.days,
  })) : [];
  const hosts = {};
  for (const [host, row] of Object.entries(agg?.promptsByHost ?? {})) {
    hosts[host] = {
      typed: row.typed, taps: row.taps,
      tapShare: pctOf(row.tapShare), questionShare: pctOf(row.questionShare),
      p90TypedTokens: row.p90TypedTokens, personaOpeners: row.personaOpeners,
    };
  }
  const reAsks = pp?.reAsks
    ? { pairCount: pp.reAsks.pairCount, sessionCount: pp.reAsks.sessionCount }
    : null;
  const exactRepeats = Array.isArray(pp?.exactRepeats)
    ? pp.exactRepeats.map((r) => ({
      count: r.count, tokens: r.tokens, sessions: r.sessions, days: r.days,
    }))
    : [];
  return {
    clusters, hosts, reAsks, exactRepeats,
  };
}

// ── the anti-fabrication gate's primitives ──────────────────────────────────

/** Every numeral in a free-text string, as Numbers — thousands-comma-
 *  tolerant ("1,234" reads as 1234, matching how a model is likely to write
 *  a large count) so formatting variance alone cannot cause a false drop. */
function numbersInText(text) {
  if (typeof text !== 'string') return [];
  const cleaned = text.replace(/(\d),(\d)/g, '$1$2');
  return (cleaned.match(/\d+(?:\.\d+)?/g) || []).map(Number);
}

/** Every finite number appearing anywhere in a findingsSummary, at any
 *  depth — the universe a card's cited numbers are checked against. */
function numbersInSummary(summary) {
  const out = new Set();
  const walk = (node) => {
    if (typeof node === 'number' && Number.isFinite(node)) { out.add(node); return; }
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node && typeof node === 'object') { for (const v of Object.values(node)) walk(v); }
  };
  walk(summary);
  return out;
}

/**
 * "The hash of the findingsSummary slice [a card] cites" (spec §6.3): the
 * subset of `basisNumbers` that is ACTUALLY present in `findingsSummary`,
 * hashed. At synthesis time (after the anti-fabrication gate has already
 * verified every basisNumbers entry IS present) this is every basisNumbers
 * entry, so the hash captures exactly the evidence the card was grounded in.
 * On a later pass, if the corpus has moved and some of those numbers no
 * longer appear anywhere, the present subset SHRINKS and the hash changes —
 * which is the staleness signal `isCardStale` reads. No LLM call is spent
 * recomputing this; it is pure arithmetic over already-computed aggregates.
 *
 * @param {object} findingsSummary
 * @param {number[]} basisNumbers
 * @returns {string}
 */
export function citedEvidenceHash(findingsSummary, basisNumbers) {
  const summaryNumbers = numbersInSummary(findingsSummary);
  const present = [...new Set((Array.isArray(basisNumbers) ? basisNumbers : []).filter((n) => summaryNumbers.has(n)))]
    .sort((a, b) => a - b);
  return evidenceHash({ present });
}

/**
 * True once a synthesized card's evidence has moved since it was cached —
 * "stale — recompute with --enrich" (spec §6.3/§6.5), never silently
 * re-spending a model call to check. Cheap: pure arithmetic over the CURRENT
 * findingsSummary, no invocation.
 *
 * CONTRACT: only ever called for a card whose `source` is `'enriched'` — a
 * rule-derived card has no `basisNumbers` and recomputes its evidenceHash
 * fresh every pass regardless (usage-outcome-ledger.mjs's `transitionProposed`
 * et al.), so it is never subject to this staleness concept at all. Passing
 * a card with no `basisNumbers` array is therefore a caller error, not a
 * value this function has an honest answer for — it throws rather than
 * silently reporting `false` (which would read as "confirmed fresh").
 *
 * @param {{ basisNumbers?: number[], evidenceHash?: string }} card
 * @param {object} findingsSummary current findings, same shape buildFindingsSummary returns
 * @returns {boolean}
 */
export function isCardStale(card, findingsSummary) {
  if (!Array.isArray(card?.basisNumbers)) {
    throw new TypeError(
      'isCardStale: card.basisNumbers must be an array — call this only for source:"enriched" cards',
    );
  }
  return citedEvidenceHash(findingsSummary, card.basisNumbers) !== card.evidenceHash;
}

// ── synthesizeCards ──────────────────────────────────────────────────────

function buildCardPrompt(findingsSummary) {
  return 'You are proposing coaching suggestions for a developer, based ONLY on the aggregate '
    + 'numbers below — no prompt text was shared with you, and you must not imply that any was. '
    + 'Propose 0 to 3 NEW suggestions that are not obvious duplicates of standard advice. Every '
    + 'number you state in "finding", "try", or "basis" MUST be one of the numbers that appears in '
    + 'the data below — never invent, round, or estimate a number; "basisNumbers" must list every '
    + 'number your suggestion is grounded in. Respond with ONLY a JSON array, no prose before or '
    + 'after it, in this exact shape:\n'
    + '[{"id":"kebab-case-slug","title":"...","finding":"...","try":"...","basis":"...",'
    + '"basisNumbers":[...]}]\n\n'
    + `Data:\n${JSON.stringify(findingsSummary, null, 2)}`;
}

function isSingleLineNonEmpty(value) {
  return typeof value === 'string' && value.length > 0 && !/[\r\n]/.test(value);
}

/**
 * @param {{ findingsSummary: object, invoke: (prompt: string) => Promise<string>,
 *   now: number }} input
 * @returns {Promise<{ cards: Array<{ id: string, title: string, finding: string, try: string,
 *   basis: string, basisNumbers: number[], source: 'enriched', evidenceHash: string,
 *   generatedAt: string }>, proposed: number, accepted: number, dropped: Record<string, number> }>}
 */
export async function synthesizeCards({ findingsSummary, invoke, now }) {
  const raw = await invoke(buildCardPrompt(findingsSummary));
  const parsed = parseJsonArray(raw);
  const summaryNumbers = numbersInSummary(findingsSummary);

  const dropped = {
    badId: 0, badText: 0, noBasis: 0, unmatchedNumber: 0, duplicateId: 0,
  };
  const cards = [];
  const seenIds = new Set();

  for (const item of parsed) {
    if (cards.length >= MAX_SYNTHESIZED_CARDS) break;
    if (!item || typeof item !== 'object') { dropped.badText++; continue; }

    const slug = typeof item.id === 'string' ? item.id : '';
    if (!CARD_ID_SLUG_RE.test(slug)) { dropped.badId++; continue; }
    if (seenIds.has(slug)) { dropped.duplicateId++; continue; }

    if (!CARD_TEXT_FIELDS.every((field) => isSingleLineNonEmpty(item[field]))) { dropped.badText++; continue; }

    const basisNumbers = Array.isArray(item.basisNumbers)
      ? item.basisNumbers.filter((n) => Number.isFinite(n))
      : [];
    if (!basisNumbers.length) { dropped.noBasis++; continue; }

    // ANTI-FABRICATION GATE: every number stated in the model-authored prose
    // (title is exempt — a stylistic number there asserts no evidence) plus
    // every basisNumbers entry must be traceable to the supplied summary.
    const cited = [...CARD_FABRICATION_FIELDS.flatMap((field) => numbersInText(item[field])), ...basisNumbers];
    if (!cited.every((n) => summaryNumbers.has(n))) { dropped.unmatchedNumber++; continue; }

    seenIds.add(slug);
    cards.push({
      id: `${ENRICHED_ID_PREFIX}${slug}`,
      title: item.title, finding: item.finding, try: item.try, basis: item.basis,
      basisNumbers: [...basisNumbers],
      source: 'enriched',
      evidenceHash: citedEvidenceHash(findingsSummary, basisNumbers),
      generatedAt: new Date(now).toISOString(),
    });
  }

  return {
    cards, proposed: parsed.length, accepted: cards.length, dropped,
  };
}

// ── shared read-path wiring (CLI + dashboard, deliverable §5) ─────────────
// The three functions below are what let a PERSISTED store (usage-label-
// store.mjs's file on disk) actually reach a render, on EVERY pass — not
// only a pass that just ran `--enrich`. Both `ak usage prompts` and the
// dashboard's `/api/usage` handler call all three, in this order, so the
// two surfaces can never disagree about what a stored label/card currently
// means: apply the label store, hydrate stored cards into the ledger's
// `cards` input, then — once `reconcile` has run — mark staleness.

/**
 * Re-resolves every cluster in a `promptPatterns` projection against a real
 * label store — equivalent to having threaded the store through at
 * aggregate-build time (see `withStoreLabel`'s own doc for why this is
 * exact, not an approximation). `promptPatterns` may be `null` (the window
 * did not request `prompts: true`) or carry no `clusters` at all; both pass
 * through unchanged rather than being reshaped into an empty projection.
 *
 * @param {PromptPatterns|null} [promptPatterns]
 * @param {Record<string, object>} [labels]
 * @returns {PromptPatterns|null|undefined}
 */
export function applyLabelStoreToPatterns(promptPatterns, labels) {
  if (!promptPatterns || !Array.isArray(promptPatterns.clusters) || !promptPatterns.clusters.length) {
    return promptPatterns;
  }
  return { ...promptPatterns, clusters: promptPatterns.clusters.map((c) => withStoreLabel(c, labels)) };
}

/**
 * A persisted card store entry, restored to the `CoachingCard` shape
 * `reconcile` expects — so an enriched card already on disk rejoins the
 * ledger on EVERY pass (spec: "Enriched cards join reconcile exactly like
 * rule cards"), not only the pass that synthesized it. The ledger tracks
 * this card's LIFECYCLE (usage-outcome-ledger.mjs); this function only
 * restores its CONTENT, which the ledger has never held.
 *
 * @param {Record<string, { title: string, finding: string, try: string,
 *   basis: string, basisNumbers: number[], evidenceHash: string,
 *   generatedAt: string }>} [cardsStore]
 * @returns {Array<CoachingCard & { basisNumbers: number[], source: 'enriched' }>}
 */
export function hydrateStoredCards(cardsStore) {
  return Object.entries(cardsStore ?? {}).map(([id, entry]) => ({
    id,
    title: entry.title,
    finding: entry.finding,
    try: entry.try,
    basis: entry.basis,
    basisNumbers: entry.basisNumbers,
    evidenceHash: entry.evidenceHash,
    generatedAt: entry.generatedAt,
    source: 'enriched',
  }));
}

/**
 * Patches `.stale` onto every ENRICHED card in an already-reconciled array,
 * MUTATING it in place and returning it for chaining. This must run AFTER
 * `reconcile` — `usage-outcome-ledger.mjs`'s `annotate` unconditionally sets
 * `stale: false` on every card it returns (correct for a rule card, which
 * recomputes fresh every pass and so never drifts — see that module's own
 * doc), which would silently overwrite whatever this function set if called
 * before. A rule card (`source !== 'enriched'`) is left untouched.
 *
 * @param {Array<{ source?: string, basisNumbers?: number[], evidenceHash?: string, stale?: boolean }>} cards
 * @param {object} findingsSummary current findings, same shape buildFindingsSummary returns
 * @returns {Array<object>}
 */
export function applyCardStaleness(cards, findingsSummary) {
  for (const card of cards ?? []) {
    if (card?.source === 'enriched') card.stale = isCardStale(card, findingsSummary);
  }
  return cards;
}
