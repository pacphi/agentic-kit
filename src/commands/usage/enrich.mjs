// The --enrich flow of `ak usage prompts` (METRICS.md §23; ADR-0039's
// CLI-only inference boundary): gather masked exemplars for candidate clusters
// through the SAME deep-pass machinery `--deep` uses, print a consent
// preamble before invoking anything, run the two enrichment engine calls
// (usage-enrich.mjs), persist the results, and report what changed. Split
// out of usage.mjs on the status.mjs/status/*.mjs and coaching.mjs
// precedent, so usage.mjs itself only grows by the flag/help wiring and one
// call site.
//
// NEVER PRINTS TO STDOUT IN --json MODE (beyond the final JSON blob usage.mjs
// itself prints): `info`/`warn`/`heading` all write to stdout via
// console.log (src/lib/output.mjs), and mixing human-readable status lines
// into a `--json` stream would corrupt it for a caller piping into `jq`. The
// explicit `--enrich` flag itself is the operator's consent in that mode —
// enrichment still runs and its outcome rides in the JSON payload's own
// `enrichment` key (usage.mjs adds that), just without a printed preamble.
import { heading, info, warn, dim } from '../../lib/output.mjs';
import {
  enrichLabels, synthesizeCards, findingsSummaryHash, isCardStale, hydrateStoredCards,
} from '../../lib/usage-enrich.mjs';
import { saveLabelStore } from '../../lib/usage-label-store.mjs';
import { makeInvoke, UNAVAILABLE_MESSAGE } from '../../lib/llm-invoke.mjs';
import { maskSecrets } from '../../lib/usage-aggregate.mjs';
import {
  readPromptEntries, deepFingerprints, exemplarCandidates, collectExemplars, promptCacheFile,
} from './deep-pass.mjs';

/**
 * @typedef {import('../../lib/usage-enrich.mjs').AggLike} AggLike
 * @typedef {import('../../lib/usage-label-store.mjs').LabelStore} LabelStore
 */

/** Mirrors usage-enrich.mjs's own MIN_CANDIDATE_COUNT — kept as a second,
 *  explicit constant rather than an import so this file's candidate-key scan
 *  (which only needs KEYS, to gather exemplars for) stays decoupled from the
 *  engine's own internals; `enrichLabels` re-derives the identical candidate
 *  set from `clusters` itself and is the actual authority on who gets asked. */
const MIN_CANDIDATE_COUNT = 3;

/** @param {import('../../lib/usage-enrich.mjs').ClusterRow[]} [clusters] */
function candidateKeysOf(clusters) {
  return (Array.isArray(clusters) ? clusters : [])
    .filter((c) => c?.label?.source === 'characterized' && Number(c.count) >= MIN_CANDIDATE_COUNT)
    .map((c) => c.key);
}

/** One masked exemplar per candidate cluster, through the exact CLI-only
 *  deep-pass machinery `--deep` uses (spec: "Reuse these; do not
 *  re-derive") — scoped to just the candidate keys, never the full short-
 *  prompt/persona/re-ask tables `--deep` prints. `maskSecrets` is applied
 *  here too (render-time masking, the same discipline the deep pass itself
 *  uses); usage-enrich.mjs's `enrichLabels` re-applies it defensively on top. */
function gatherCandidateExemplars({ candidateKeys, win, agg, deps }) {
  if (!candidateKeys.length) return {};
  const entries = readPromptEntries(deps.indexCacheFile ?? promptCacheFile());
  const cutoffMs = Date.parse(agg.generatedAt) - win.days * 86_400_000;
  const typed = deepFingerprints(entries, cutoffMs);
  const wanted = new Set(candidateKeys);
  const { text } = collectExemplars({
    entries, cutoffMs, wanted, candidates: exemplarCandidates(typed, wanted), reAskSessions: new Set(),
  });
  const exemplarsByKey = {};
  for (const key of candidateKeys) {
    const body = text.get(key);
    if (body !== undefined) exemplarsByKey[key] = [maskSecrets(body)];
  }
  return exemplarsByKey;
}

/** Fix round 1, M-3: the preamble now states BOTH calls `--enrich` can make,
 *  not only the labeling one, and describes what is ACTUALLY about to
 *  happen this pass rather than a fixed claim — when I-1(a)'s delta-gate
 *  has decided synthesis will be skipped, saying "about to send a second
 *  call" would itself be the exact kind of overclaim this fix exists to
 *  remove. Ends "described above" (M-3) — nothing was ever literally
 *  "shown".
 *
 *  Security review SEC-1: the closing line used to say only "No prompt text
 *  leaves this machine beyond what is described above" — true about VOLUME,
 *  silent about AUTHORSHIP. The snippets come from transcripts on disk, and
 *  `provenanceOf` is one-directional (an unrecognized machine template falls
 *  through to `human`), so what is about to be sent is not reliably text the
 *  operator typed. An operator consenting to send "their own prompts" would
 *  be consenting to something narrower than what actually goes. */
function printConsentPreamble({
  candidateCount, snippetCount, synthesisNeeded, describe,
}) {
  heading('Enrichment');
  info(`About to send ${candidateCount} cluster${candidateCount === 1 ? '' : 's'} `
    + `(${snippetCount} masked snippet${snippetCount === 1 ? '' : 's'}) to the model for naming.`);
  info(synthesisNeeded
    ? 'Also about to send a second call carrying the current findings summary (counts, labels, and '
      + 'shares only — capped to the top 40 clusters by count) for coaching suggestions.'
    : dim('Coaching synthesis is unchanged since the last pass and will be skipped this run.'));
  info('No prompt text leaves this machine beyond what is described above. Those snippets are '
    + 'transcript-derived — they may include text you did not type.');
  info(dim(`Billing: ${describe()}`));
}

/** Fix round 1, M-1/M-4: both `labelResult.dropped` and `cardResult.dropped`
 *  are categorized-reason objects, not a single number — this sums one for
 *  the human-readable line while the categorized shape itself still reaches
 *  `--json` untouched via `enrichmentProjection` (usage.mjs). Replaces the
 *  old `proposed - accepted` computation for cards, which conflated a
 *  genuine rejection with a card merely capped by MAX_SYNTHESIZED_CARDS. */
function sumDropped(dropped) {
  return Object.values(dropped ?? {}).reduce((n, v) => n + (Number(v) || 0), 0);
}

/** Printed the moment `enrichLabels` resolves, independent of what happens
 *  to the synthesis call next — the label half's own persisted result must
 *  never go unreported just because the SECOND invocation later fails
 *  (C-2's own point: labels already paid for are not discarded, and the
 *  operator should see that on the screen, not only infer it from the
 *  file). */
function printLabelSummary(labelResult) {
  const labelDropped = sumDropped(labelResult.dropped);
  const labelDroppedNote = labelDropped ? ` (${labelDropped} dropped)` : '';
  info(`Labeled ${labelResult.labeled} of ${labelResult.candidates.length} candidate cluster`
    + `${labelResult.candidates.length === 1 ? '' : 's'}${labelDroppedNote}.`);
}

function printCardSummary(cardResult) {
  const cardDropped = sumDropped(cardResult.dropped);
  const cardDroppedNote = cardDropped ? ` (${cardDropped} dropped)` : '';
  info(`Synthesized ${cardResult.accepted} new coaching card${cardResult.accepted === 1 ? '' : 's'}`
    + `${cardDroppedNote}.`);
}

/** Fix round 1, C-1: the one honest line for either invocation failing —
 *  factored out so both the labeling and the synthesis call sites report it
 *  identically. `err.message` already carries llm-invoke.mjs's own bounded
 *  stderr tail. */
function invocationFailedLine(err) {
  return `ak usage prompts --enrich: invocation failed: ${err.message}; deterministic tiers are unaffected.`;
}

/** The `cardResult.dropped` shape when synthesis is SKIPPED this pass (I-1a)
 *  — every reason zeroed, matching `synthesizeCards`'s own shape exactly, so
 *  a caller reading `cardResult.dropped` never has to special-case "skipped"
 *  versus "ran and rejected nothing". */
const NO_CARDS_DROPPED = {
  badId: 0, badText: 0, noBasis: 0, unmatchedNumber: 0, duplicateId: 0, duplicateOfExisting: 0,
};

/**
 * The whole `--enrich` flow. Returns `null` when nothing ran at all (no
 * invocation path available, the label store is a newer schema this build
 * refuses to write to, OR the invocation itself failed — Fix round 1, C-1)
 * — the caller's existing report still renders normally either way (spec:
 * exits 0, deterministic tiers unaffected).
 *
 * @param {{ agg: AggLike & { generatedAt: string }, findingsSummary: object,
 *   labelStore: LabelStore, labelStorePath: string, win: { days: number },
 *   deps: object, now: number, json: boolean }} input
 * @returns {Promise<{ labelStore: LabelStore, labelsChanged: boolean,
 *   labelResult: object, cardResult: object }|null>}
 */
export async function runEnrichPass({
  agg, findingsSummary, labelStore, labelStorePath, win, deps, now, json,
}) {
  if (labelStore.future) {
    if (!json) {
      warn(`ak usage prompts --enrich: the label store at ${labelStorePath} is a newer schema `
        + `(v${labelStore.version}) this build does not understand — enrichment is unavailable `
        + 'this run, and the file was left untouched.');
    }
    return null;
  }

  const seam = await makeInvoke({});
  if (!seam) {
    if (!json) info(dim(UNAVAILABLE_MESSAGE));
    return null;
  }

  const candidateKeys = candidateKeysOf(agg.promptPatterns?.clusters);
  const exemplarsByKey = gatherCandidateExemplars({
    candidateKeys, win, agg, deps,
  });
  // M-3: a TRUE count of snippets, not of clusters that happen to have one
  // — today's gather is ≤1 snippet per candidate, making the two equal, but
  // this must stay a real count rather than an alias for candidate count.
  const snippetCount = Object.values(exemplarsByKey).reduce((n, arr) => n + arr.length, 0);

  // Fix round 1, I-1(a): the delta-gate for the coaching-synthesis call,
  // mirroring the label half's own delta-only discipline. Skip ONLY when
  // NEITHER signal says anything moved: the findingsSummary hash matches the
  // last pass that actually completed synthesis, AND no already-stored
  // enriched card reads stale against the CURRENT findings. `findingsHash`
  // is computed from the SAME findingsSummary the caller already built from
  // the canonical 30d aggregate (coaching.mjs), so this reads exactly what
  // synthesizeCards would be shown if it ran.
  const findingsHash = findingsSummaryHash(findingsSummary);
  const hydratedStoredCards = hydrateStoredCards(labelStore.cards);
  const anyCardStale = hydratedStoredCards.some((c) => isCardStale(c, findingsSummary));
  const hashUnchanged = labelStore.lastSynthesis?.findingsHash === findingsHash;
  const synthesisNeeded = !hashUnchanged || anyCardStale;
  const existingCards = hydratedStoredCards.map((c) => ({ id: c.id, title: c.title }));

  if (!json) {
    printConsentPreamble({
      candidateCount: candidateKeys.length, snippetCount, synthesisNeeded, describe: seam.describe,
    });
  }

  // Fix round 1, C-1: an AVAILABLE but FAILING CLI (usage limit, expired
  // auth, the 120s timeout) must never reach reportFatal. TWO SEPARATE
  // try/catch blocks, not one around both calls — labeling and synthesis are
  // independent halves, and a failure in the SECOND must never suppress
  // reporting that the FIRST genuinely succeeded (see printLabelSummary's
  // own doc). Either catch prints one honest line and returns null; the
  // caller falls through to its normal deterministic render and returns 0,
  // exactly like the "unavailable" path above.
  let labelResult;
  let persistedStore;
  try {
    labelResult = await enrichLabels({
      clusters: agg.promptPatterns?.clusters ?? [], exemplarsByKey, store: labelStore.labels,
      invoke: seam.invoke, now,
    });
    // Fix round 1, C-2: persist labels BEFORE the synthesis call. The write
    // is already atomic and idempotent (usage-label-store.mjs), so doing it
    // here costs nothing — and it means a failure on the SECOND invocation
    // (the likely casualty near a usage limit, since the two calls are
    // back-to-back) can never discard label work the first call already
    // paid for. `lastSynthesis` carries forward unchanged: synthesis has not
    // run yet at this point, successfully or otherwise.
    persistedStore = {
      version: 1,
      labels: { ...labelStore.labels, ...labelResult.entries },
      cards: { ...labelStore.cards },
      lastSynthesis: labelStore.lastSynthesis,
    };
    saveLabelStore(labelStorePath, persistedStore);
  } catch (err) {
    if (!json) warn(invocationFailedLine(err));
    return null;
  }
  if (!json) printLabelSummary(labelResult);

  let cardResult;
  try {
    cardResult = synthesisNeeded
      ? await synthesizeCards({
        findingsSummary, invoke: seam.invoke, now, existingCards,
      })
      : { cards: [], proposed: 0, accepted: 0, dropped: NO_CARDS_DROPPED };
  } catch (err) {
    if (!json) warn(invocationFailedLine(err));
    return null;
  }
  if (!json) {
    if (synthesisNeeded) printCardSummary(cardResult);
    else info('Coaching synthesis skipped — no evidence drift');
  }

  const nextCards = { ...persistedStore.cards };
  for (const card of cardResult.cards) {
    nextCards[card.id] = {
      title: card.title, finding: card.finding, try: card.try, basis: card.basis,
      basisNumbers: card.basisNumbers, evidenceHash: card.evidenceHash, generatedAt: card.generatedAt,
    };
  }
  // lastSynthesis only advances when synthesis actually RAN this pass — a
  // skip carries the prior record forward untouched, and a FAILED synthesis
  // never reaches here at all (the catch above returns first), so a failed
  // attempt is correctly retried next pass rather than silently treated as
  // done.
  const nextLastSynthesis = synthesisNeeded
    ? { findingsHash, at: new Date(now).toISOString() }
    : labelStore.lastSynthesis;
  const finalStore = {
    version: 1, labels: persistedStore.labels, cards: nextCards, lastSynthesis: nextLastSynthesis,
  };
  saveLabelStore(labelStorePath, finalStore);

  return {
    labelStore: finalStore, labelsChanged: labelResult.labeled > 0, labelResult, cardResult,
  };
}
