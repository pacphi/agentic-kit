// The --enrich flow of `ak usage prompts` (spec §6.3, §3.3's CLI-only
// inference boundary): gather masked exemplars for candidate clusters
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
  enrichLabels, synthesizeCards,
} from '../../lib/usage-enrich.mjs';
import { saveLabelStore } from '../../lib/usage-label-store.mjs';
import { makeInvoke, UNAVAILABLE_MESSAGE } from '../../lib/llm-invoke.mjs';
import { maskSecrets } from '../../lib/usage-aggregate.mjs';
import {
  readPromptEntries, deepFingerprints, exemplarCandidates, collectExemplars, promptCacheFile,
} from '../usage.mjs';

/** Mirrors usage-enrich.mjs's own MIN_CANDIDATE_COUNT — kept as a second,
 *  explicit constant rather than an import so this file's candidate-key scan
 *  (which only needs KEYS, to gather exemplars for) stays decoupled from the
 *  engine's own internals; `enrichLabels` re-derives the identical candidate
 *  set from `clusters` itself and is the actual authority on who gets asked. */
const MIN_CANDIDATE_COUNT = 3;

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

function printConsentPreamble({ candidateCount, snippetCount, describe }) {
  heading('Enrichment');
  info(`About to send ${candidateCount} cluster${candidateCount === 1 ? '' : 's'} `
    + `(${snippetCount} masked snippet${snippetCount === 1 ? '' : 's'}) to the model for naming, plus `
    + 'the current aggregate counts for coaching suggestions. No prompt text leaves this machine '
    + 'beyond what is shown above.');
  info(dim(`Billing: ${describe()}`));
}

function printEnrichSummary({ labelResult, cardResult }) {
  const labelDroppedNote = labelResult.dropped ? ` (${labelResult.dropped} dropped)` : '';
  info(`Labeled ${labelResult.labeled} of ${labelResult.candidates.length} candidate cluster`
    + `${labelResult.candidates.length === 1 ? '' : 's'}${labelDroppedNote}.`);
  const cardDropped = cardResult.proposed - cardResult.accepted;
  const cardDroppedNote = cardDropped > 0 ? ` (${cardDropped} dropped)` : '';
  info(`Synthesized ${cardResult.accepted} new coaching card${cardResult.accepted === 1 ? '' : 's'}`
    + `${cardDroppedNote}.`);
}

/**
 * The whole `--enrich` flow. Returns `null` when nothing ran at all (no
 * invocation path available, or the label store is a newer schema this
 * build refuses to write to) — the caller's existing report still renders
 * normally either way (spec: exits 0, deterministic tiers unaffected).
 *
 * @param {{ agg: object, findingsSummary: object, labelStore: object,
 *   labelStorePath: string, win: { days: number }, deps: object, now: number,
 *   json: boolean }} input
 * @returns {Promise<{ labelStore: object, labelsChanged: boolean,
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

  if (!json) {
    printConsentPreamble({
      candidateCount: candidateKeys.length, snippetCount: Object.keys(exemplarsByKey).length,
      describe: seam.describe,
    });
  }

  const labelResult = await enrichLabels({
    clusters: agg.promptPatterns?.clusters ?? [], exemplarsByKey, store: labelStore.labels,
    invoke: seam.invoke, now,
  });
  const cardResult = await synthesizeCards({ findingsSummary, invoke: seam.invoke, now });

  const nextCards = { ...labelStore.cards };
  for (const card of cardResult.cards) {
    nextCards[card.id] = {
      title: card.title, finding: card.finding, try: card.try, basis: card.basis,
      basisNumbers: card.basisNumbers, evidenceHash: card.evidenceHash, generatedAt: card.generatedAt,
    };
  }
  const nextStore = { version: 1, labels: { ...labelStore.labels, ...labelResult.entries }, cards: nextCards };
  saveLabelStore(labelStorePath, nextStore);

  if (!json) printEnrichSummary({ labelResult, cardResult });

  return {
    labelStore: nextStore, labelsChanged: labelResult.labeled > 0, labelResult, cardResult,
  };
}
