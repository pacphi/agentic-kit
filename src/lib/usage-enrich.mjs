// usage-enrich.mjs — the layer-3 enrichment ENGINE (METRICS.md §23): delta-only
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
// THE PRIVACY SPLIT IS LOAD-BEARING (ADR-0039 "The privacy split"). `enrichLabels` receives
// masked exemplar text ONLY (never raw), and defensively re-caps/re-masks it
// anyway — the caller is trusted to have already done both, but this
// function does not trust its own caller absolutely on the one boundary that
// keeps prompt text off the dashboard permanently. `synthesizeCards` never
// receives exemplar text AT ALL — `findingsSummary` is counts/labels/shares,
// nothing else, and this module has no code path that could smuggle text
// past that even if a caller tried.
//
// THE ANTI-FABRICATION GATE IS NOT OPTIONAL (ADR-0039 "The anti-fabrication
// gate" — "never silently spending tokens" extends to never silently
// INVENTING a number either).
// Every number a synthesized card states in its finding/try/basis text, and
// every number in its own basisNumbers, must be traceable to a number that
// is ACTUALLY present in the findingsSummary the model was given. A card
// that cites even one number nobody supplied is dropped, unconditionally —
// this is the single most load-bearing test in this wave.
import { evidenceHash } from './usage-evidence-hash.mjs';
import { maskSecrets } from './usage-aggregate.mjs';
import { isValidLabelName, CARD_ID_RE } from './usage-label-store.mjs';
import {
  pathWordsByNumber, vocabularyOf, numericClaims, claimIsGrounded,
} from './usage-fabrication-gate.mjs';
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

/** Settled labels are never re-judged (METRICS.md §23). A candidate is a
 *  cluster with NO store entry (label source would be 'curated' or
 *  'enriched' if it had one — see usage-prompt-vocabulary.mjs's
 *  `withStoreLabel`) and NO seed match either (source would be 'seed').
 *  Only the honest fallback, 'characterized', with enough recurrence to be
 *  worth a model call. */
const MIN_CANDIDATE_COUNT = 3;

/** The privacy split's numeric bounds (ADR-0039 "The privacy split"), enforced HERE even
 *  though the caller is expected to have already applied them — defense in
 *  depth on a load-bearing boundary, not a trust assumption. */
const MAX_EXEMPLARS_PER_CLUSTER = 2;
const MAX_EXEMPLAR_CHARS = 200;

/** "Asks for 0..3 additional coaching suggestions" (METRICS.md §23) — a hard cap
 *  regardless of how many the model returns. */
const MAX_SYNTHESIZED_CARDS = 3;

/** The id shape a synthesized card's slug must have. Security review SEC-4:
 *  this used to be a second, local copy of the same regex the store now
 *  enforces on READ. One definition, in the module that owns the file, so the
 *  write path and the read path cannot drift apart again — which is exactly
 *  how the asymmetry the review found came about. */
const CARD_ID_SLUG_RE = CARD_ID_RE;
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
 *  'characterized', so filtering on 'characterized' alone is the delta.
 *
 *  Fix round 1, I-6: `store` is also checked directly here (`!store?.[c.key]`)
 *  — belt AND suspenders, matching the module's own stated posture of not
 *  trusting a caller absolutely on a load-bearing boundary (the same
 *  reasoning `maskedExemplarsFor` already applies to the privacy split). The
 *  caller-side `withStoreLabel` application stays the primary mechanism
 *  (`label.source` reflects the real resolution, including seed/curated
 *  precedence this function has no way to reconstruct from `store` alone);
 *  this is a second, independent check that can never disagree with it for a
 *  settled key, and catches the case where a caller passes a real store
 *  without having applied it to `clusters` first. */
function labelCandidates(clusters, store) {
  return (Array.isArray(clusters) ? clusters : [])
    .filter((c) => c?.label?.source === 'characterized' && Number(c.count) >= MIN_CANDIDATE_COUNT
      && !store?.[c.key]);
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
 *   candidates: string[], labeled: number,
 *   dropped: { unknownKey: number, duplicateKey: number, invalidName: number } }>}
 */
export async function enrichLabels({
  clusters, exemplarsByKey, store, invoke, now,
}) {
  const candidateRows = labelCandidates(clusters, store);
  const candidateKeys = candidateRows.map((c) => c.key);
  const dropped = { unknownKey: 0, duplicateKey: 0, invalidName: 0 };
  if (!candidateRows.length) {
    return {
      entries: {}, candidates: [], labeled: 0, dropped,
    };
  }

  const raw = await invoke(buildLabelPrompt(candidateRows, exemplarsByKey));
  const parsed = parseJsonArray(raw);
  const askedKeys = new Set(candidateKeys);

  const entries = {};
  const seen = new Set();
  for (const item of parsed) {
    const key = item && typeof item.key === 'string' ? item.key : null;
    if (!key || !askedKeys.has(key)) { dropped.unknownKey++; continue; }
    if (seen.has(key)) { dropped.duplicateKey++; continue; }
    // Fix round 1, I-7: the model's OUTPUT is masked defensively, same as its
    // input already was (`maskedExemplarsFor`) — a model asked to "name this
    // cluster based on the sample" can legitimately echo the sample back,
    // which for this corpus's short tap clusters comfortably fits under 48
    // characters and would otherwise persist raw prompt text at rest.
    const masked = maskSecrets(String(item?.name ?? ''));
    if (!isValidLabelName(masked)) { dropped.invalidName++; continue; }
    seen.add(key);
    entries[key] = { name: masked.trim(), source: 'enriched', firstSeen: new Date(now).toISOString() };
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

/** A cluster's display `name` is the one field in `findingsSummary` that can
 *  change with NO evidence having moved at all — a same-pass label/re-curate
 *  changes it, and `activeLabels` is re-applied before `findingsSummary` is
 *  rebuilt on every later pass too. `numbersInSummary` (the anti-fabrication
 *  gate's own universe, and `isCardStale`'s) already ignores every string
 *  field including this one, for the same reason: a name is not evidence. */
function stripDisplayNames(findingsSummary) {
  const clusters = Array.isArray(findingsSummary?.clusters) ? findingsSummary.clusters : [];
  return { ...findingsSummary, clusters: clusters.map(({ name: _name, ...rest }) => rest) };
}

/**
 * Fix round 1, I-1(a): a hash of the findingsSummary's EVIDENCE — "has
 * anything about current findings moved at all since the last time synthesis
 * actually ran" — distinct from `citedEvidenceHash`'s per-card question
 * ("has the evidence THIS card cited moved"). The caller
 * (usage/enrich.mjs's `runEnrichPass`) records this alongside `lastSynthesis`
 * and skips a NEW `synthesizeCards` call when it is unchanged AND no stored
 * card reads stale — new evidence (a cluster crossing the candidate floor, a
 * count moving) is exactly what would move this hash, so "unchanged" is a
 * real claim that nothing worth asking about again has appeared. Deliberately
 * insensitive to a cluster's display `name` alone (`stripDisplayNames`) —
 * otherwise the very next pass after ANY labeling round would see the hash
 * move on cosmetics only and re-spend a synthesis call for no new evidence,
 * defeating the two-consecutive-runs guarantee this exists to provide.
 *
 * @param {object} findingsSummary
 * @returns {string}
 */
export function findingsSummaryHash(findingsSummary) {
  return evidenceHash(stripDisplayNames(findingsSummary ?? {}));
}

/**
 * "The hash of the findingsSummary slice [a card] cites" (METRICS.md §23): the
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
 * "stale — recompute with --enrich" (METRICS.md §23), never silently
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

/** Fix round 1, I-1(c): the prompt's OWN view of `findingsSummary.clusters`
 *  is capped to the top-N by count. Measured on this machine's real corpus,
 *  458 clusters cost ~21K tokens (~83 KB) on EVERY `--enrich`, and that is
 *  the whole retained corpus, not "current findings" a synthesis pass needs
 *  to reason about. This caps only what the model is SHOWN — the gate below
 *  (`numbersInSummary`) still validates every returned number against the
 *  FULL, uncapped `findingsSummary`, never this display-only slice, so a
 *  response citing a number from cluster #41 is still checked for truth,
 *  just never offered as something to name. `citedEvidenceHash` (used for
 *  the stored evidenceHash and every later staleness check) ALSO always
 *  reads the full summary, so a card's frozen hash and a later fresh one are
 *  computed the same way regardless of how many clusters synthesis was
 *  shown the day it was written — capping the prompt cannot manufacture a
 *  false staleness signal. */
const MAX_SYNTHESIS_CLUSTERS = 40;

function cappedClustersFor(findingsSummary) {
  const clusters = Array.isArray(findingsSummary?.clusters) ? findingsSummary.clusters : [];
  if (clusters.length <= MAX_SYNTHESIS_CLUSTERS) return clusters;
  return [...clusters]
    .sort((a, b) => (Number(b.count) || 0) - (Number(a.count) || 0))
    .slice(0, MAX_SYNTHESIS_CLUSTERS);
}

/** Fix round 1, I-1(b): existing enriched cards are named explicitly so the
 *  model does not re-propose the same suggestion under a different slug —
 *  live-run evidence: `enriched-reduce-large-prompt-retyping` and
 *  `enriched-template-large-repeated-prompt` are the same suggestion twice,
 *  different ids, both on disk. This is a best-effort steer, not a
 *  guarantee (the model can still restate an idea under new-enough wording);
 *  the mechanical, deterministic backstop is the id-collision drop below. */
function buildCardPrompt(findingsSummary, existingCards) {
  const totalClusters = Array.isArray(findingsSummary?.clusters) ? findingsSummary.clusters.length : 0;
  const displaySummary = { ...findingsSummary, clusters: cappedClustersFor(findingsSummary) };
  const clusterNote = totalClusters > MAX_SYNTHESIS_CLUSTERS
    ? `\n\n(showing the top ${MAX_SYNTHESIS_CLUSTERS} of ${totalClusters} clusters by count — every number `
      + 'above still belongs to the full corpus, not only what is listed here)'
    : '';
  const doNotDuplicate = (existingCards ?? []).length
    ? '\n\nDo NOT propose a suggestion that duplicates any of these existing ones, by id or by '
      + 'substance:\n' + existingCards.map((c) => `- ${c.id}: "${c.title}"`).join('\n')
    : '';
  return 'You are proposing coaching suggestions for a developer, based ONLY on the aggregate '
    + 'numbers below — no prompt text was shared with you, and you must not imply that any was. '
    + 'Propose 0 to 3 NEW suggestions that are not obvious duplicates of standard advice. Every '
    + 'number you state in "finding", "try", or "basis" MUST be one of the numbers that appears in '
    + 'the data below — never invent, round, or estimate a number; "basisNumbers" must list every '
    + 'number your suggestion is grounded in. Respond with ONLY a JSON array, no prose before or '
    + 'after it, in this exact shape:\n'
    + '[{"id":"kebab-case-slug","title":"...","finding":"...","try":"...","basis":"...",'
    + `"basisNumbers":[...]}]${doNotDuplicate}\n\nData:\n${JSON.stringify(displaySummary, null, 2)}${clusterNote}`;
}

function isSingleLineNonEmpty(value) {
  return typeof value === 'string' && value.length > 0 && !/[\r\n]/.test(value);
}

/**
 * @param {{ findingsSummary: object, invoke: (prompt: string) => Promise<string>,
 *   now: number, existingCards?: Array<{ id: string, title: string }> }} input
 * @returns {Promise<{ cards: Array<{ id: string, title: string, finding: string, try: string,
 *   basis: string, basisNumbers: number[], source: 'enriched', evidenceHash: string,
 *   generatedAt: string }>, proposed: number, accepted: number, dropped: Record<string, number> }>}
 */
export async function synthesizeCards({
  findingsSummary, invoke, now, existingCards,
}) {
  const existing = Array.isArray(existingCards) ? existingCards : [];
  const existingIds = new Set(existing.map((c) => c.id));
  const raw = await invoke(buildCardPrompt(findingsSummary, existing));
  const parsed = parseJsonArray(raw);
  const summaryNumbers = numbersInSummary(findingsSummary);
  // QE review F-3: the same summary, indexed by the PATHS each number is
  // reachable from, so a cited number can be bound to the dimension the prose
  // attaches it to rather than merely to the summary as a whole.
  const summaryPaths = pathWordsByNumber(findingsSummary);
  const summaryVocabulary = vocabularyOf(summaryPaths);

  const dropped = {
    badId: 0, badText: 0, noBasis: 0, unmatchedNumber: 0, unboundNumber: 0,
    duplicateId: 0, duplicateOfExisting: 0,
  };
  const cards = [];
  const seenIds = new Set();

  for (const item of parsed) {
    if (cards.length >= MAX_SYNTHESIZED_CARDS) break;
    if (!item || typeof item !== 'object') { dropped.badText++; continue; }

    const slug = typeof item.id === 'string' ? item.id : '';
    if (!CARD_ID_SLUG_RE.test(slug)) { dropped.badId++; continue; }
    if (seenIds.has(slug)) { dropped.duplicateId++; continue; }
    // Fix round 1, I-1(b): the mechanical backstop for the do-not-duplicate
    // ask above — a returned id that collides with an id already on disk is
    // dropped outright, categorized separately from an in-response duplicate
    // (`duplicateId`) so the CLI summary can say which happened.
    if (existingIds.has(`${ENRICHED_ID_PREFIX}${slug}`)) { dropped.duplicateOfExisting++; continue; }

    if (!CARD_TEXT_FIELDS.every((field) => isSingleLineNonEmpty(item[field]))) { dropped.badText++; continue; }

    const basisNumbers = Array.isArray(item.basisNumbers)
      ? item.basisNumbers.filter((n) => Number.isFinite(n))
      : [];
    if (!basisNumbers.length) { dropped.noBasis++; continue; }

    // ANTI-FABRICATION GATE, in two passes over the model-authored prose
    // (title is exempt — a stylistic number there asserts no evidence).
    //
    // 1. EXISTENCE, unchanged: every numeral stated anywhere, plus every
    //    basisNumbers entry, must appear somewhere in the supplied summary.
    //    `basisNumbers` has no prose around it, so existence is all that can
    //    be asked of it — and `citedEvidenceHash` is computed from it.
    const cited = [...CARD_FABRICATION_FIELDS.flatMap((field) => numbersInText(item[field])), ...basisNumbers];
    if (!cited.every((n) => summaryNumbers.has(n))) { dropped.unmatchedNumber++; continue; }

    // 2. BINDING (QE review F-3, HIGH): a number must also measure the thing
    //    the sentence attaches it to. Existence alone admitted 41 of the 100
    //    integers 1..100 on a corpus this size, and degraded further as the
    //    corpus grew — so "across 13 projects" passed on a summary carrying no
    //    project data at all, because 13 happened to be some cluster's day
    //    count. Counted separately from `unmatchedNumber` so the CLI summary
    //    and --json can say WHICH kind of ungrounded claim was dropped.
    const claims = CARD_FABRICATION_FIELDS
      .flatMap((field) => numericClaims(item[field], summaryVocabulary));
    if (!claims.every((claim) => claimIsGrounded(claim, summaryPaths))) {
      dropped.unboundNumber++; continue;
    }

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
