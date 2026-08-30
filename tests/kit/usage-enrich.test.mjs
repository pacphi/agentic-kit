// usage-enrich.mjs — the layer-3 enrichment ENGINE (spec §6.3, W5 build):
// delta-only labeling and coaching-card synthesis, pure logic with an
// INJECTED `invoke`. NO NETWORK AND NO REAL CLAUDE CALL IN ANY TEST HERE —
// every `invoke` below is a plain async function returning canned text.
//
// The load-bearing tests in this file are the anti-fabrication gate (a
// synthesized card citing a number not present in the supplied
// findingsSummary is dropped, unconditionally) and the privacy-split
// defensive caps (masked exemplar snippets are capped at the engine level,
// not merely trusted of the caller).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  enrichLabels, synthesizeCards, buildFindingsSummary, citedEvidenceHash, isCardStale,
  applyLabelStoreToPatterns, hydrateStoredCards, applyCardStaleness, findingsSummaryHash,
} from '../../src/lib/usage-enrich.mjs';
import { withStoreLabel } from '../../src/lib/usage-prompt-vocabulary.mjs';
import { loadLabelStore, saveLabelStore } from '../../src/lib/usage-label-store.mjs';
import { aggregate } from '../../src/lib/usage-aggregate.mjs';
import { blankSession, addUsage } from '../../src/lib/usage-parsers.mjs';
import { deriveCards } from '../../src/lib/usage-coaching.mjs';
import { reconcile } from '../../src/lib/usage-outcome-ledger.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const NOW = Date.parse('2026-08-29T12:00:00.000Z');

function cluster(over = {}) {
  return {
    key: 'k0', label: { name: 'Recurring 5-token prompt', source: 'characterized' },
    class: 'other', count: 5, sessions: 4, days: 3, hosts: ['claude'],
    medianTokens: 5, sampleSessionIds: ['s1'],
    ...over,
  };
}

// ── candidate selection (delta-only) ────────────────────────────────────────

test('candidates are clusters whose label source is "characterized" AND count >= 3', async () => {
  const seen = [];
  const invoke = async (p) => { seen.push(p); return '[]'; };
  const clusters = [
    cluster({ key: 'char-big', count: 3 }),               // candidate: characterized, count>=3
    cluster({ key: 'char-small', count: 2 }),              // NOT a candidate: count<3
    cluster({ key: 'seeded', count: 50, label: { name: 'Release ritual', source: 'seed' } }),
    cluster({ key: 'curated', count: 50, label: { name: 'A person named this', source: 'curated' } }),
    cluster({ key: 'enriched', count: 50, label: { name: 'A model named this', source: 'enriched' } }),
  ];
  const result = await enrichLabels({
    clusters, exemplarsByKey: { 'char-big': ['some short exemplar'] }, store: {}, invoke, now: NOW,
  });
  assert.equal(result.candidates.length, 1);
  assert.deepEqual(result.candidates, ['char-big']);
  assert.match(seen[0], /char-big/, 'the invoked prompt must mention the one real candidate');
  assert.doesNotMatch(seen[0], /char-small|seeded|curated|enriched\b.*named/, 'non-candidates must not reach the prompt');
});

test('a cluster with ANY store entry (curated or enriched) is never sent, even if it also looks characterized', async () => {
  // Simulates the real pipeline: withStoreLabel has already re-resolved this
  // row against a real store BEFORE enrichLabels sees it, so a settled label
  // shows source 'curated'/'enriched', never 'characterized', regardless of
  // what the row would have characterized to on its own.
  const row = cluster({ key: 'settled', count: 40 });
  const store = { settled: { name: 'Already named by a person', source: 'curated', firstSeen: '2026-01-01T00:00:00.000Z' } };
  const resolved = withStoreLabel(row, store);
  assert.equal(resolved.label.source, 'curated');
  let invoked = false;
  const invoke = async () => { invoked = true; return '[]'; };
  const result = await enrichLabels({ clusters: [resolved], exemplarsByKey: {}, store, invoke, now: NOW });
  assert.equal(result.candidates.length, 0);
  assert.equal(invoked, false, 'settled labels are never re-judged — invoke must not even be called');
});

// Fix round 1, I-6: the engine no longer trusts the caller absolutely on the
// delta-only boundary — `store` is checked directly, belt-and-suspenders
// alongside the caller's own `withStoreLabel` application (which the test
// above already covers as the primary mechanism). This proves the SECOND,
// independent check: a settled key is excluded even when `clusters` was
// handed in WITHOUT `withStoreLabel` having been applied first — i.e. the
// row still literally reads `label.source: 'characterized'`.
test('a store entry excludes its cluster even when the caller never applied withStoreLabel first', async () => {
  const row = cluster({ key: 'unresolved-but-settled', count: 40 }); // label.source is STILL 'characterized'
  const store = { 'unresolved-but-settled': { name: 'Already named', source: 'curated', firstSeen: '2026-01-01T00:00:00.000Z' } };
  let invoked = false;
  const invoke = async () => { invoked = true; return '[]'; };
  const result = await enrichLabels({ clusters: [row], exemplarsByKey: {}, store, invoke, now: NOW });
  assert.equal(result.candidates.length, 0, 'the store param alone must exclude a settled key');
  assert.equal(invoked, false);
});

test('zero candidates never calls invoke at all', async () => {
  let invoked = false;
  const invoke = async () => { invoked = true; return '[]'; };
  const result = await enrichLabels({
    clusters: [cluster({ label: { name: 'x', source: 'seed' } })], exemplarsByKey: {}, store: {}, invoke, now: NOW,
  });
  assert.equal(invoked, false);
  assert.deepEqual(result.entries, {});
});

// ── response validation (labels) ────────────────────────────────────────────

test('a well-formed response labels every candidate it names', async () => {
  const invoke = async () => JSON.stringify([{ key: 'k1', name: 'Release ritual' }, { key: 'k2', name: 'Progress check-in' }]);
  const clusters = [cluster({ key: 'k1' }), cluster({ key: 'k2' })];
  const exemplarsByKey = { k1: ['help me release'], k2: ['how are we doing'] };
  const result = await enrichLabels({ clusters, exemplarsByKey, store: {}, invoke, now: NOW });
  assert.deepEqual(result.entries, {
    k1: { name: 'Release ritual', source: 'enriched', firstSeen: new Date(NOW).toISOString() },
    k2: { name: 'Progress check-in', source: 'enriched', firstSeen: new Date(NOW).toISOString() },
  });
  assert.equal(result.labeled, 2);
  assert.deepEqual(result.dropped, { unknownKey: 0, duplicateKey: 0, invalidName: 0 });
});

test('malformed JSON in the response yields zero entries, not a throw', async () => {
  const invoke = async () => 'Sure! Here is my answer: not actually json at all';
  const clusters = [cluster({ key: 'k1' })];
  const result = await enrichLabels({ clusters, exemplarsByKey: { k1: ['x'] }, store: {}, invoke, now: NOW });
  assert.deepEqual(result.entries, {});
  assert.equal(result.labeled, 0);
});

test('a name outside 1..48 trimmed chars is dropped', async () => {
  const invoke = async () => JSON.stringify([
    { key: 'k1', name: '' },
    { key: 'k2', name: '   ' },
    { key: 'k3', name: 'x'.repeat(49) },
    { key: 'k4', name: 'x'.repeat(48) }, // exactly at the ceiling: kept
  ]);
  const clusters = ['k1', 'k2', 'k3', 'k4'].map((key) => cluster({ key }));
  const exemplarsByKey = Object.fromEntries(clusters.map((c) => [c.key, ['x']]));
  const result = await enrichLabels({ clusters, exemplarsByKey, store: {}, invoke, now: NOW });
  assert.deepEqual(Object.keys(result.entries), ['k4']);
  assert.equal(result.dropped.invalidName, 3, `all 3 rejections are invalid-name shape failures: ${JSON.stringify(result.dropped)}`);
  assert.equal(result.dropped.unknownKey, 0);
  assert.equal(result.dropped.duplicateKey, 0);
});

test('a newline in the name is dropped — newline injection', async () => {
  const invoke = async () => JSON.stringify([{ key: 'k1', name: 'Looks fine\nbut has a newline' }]);
  const clusters = [cluster({ key: 'k1' })];
  const result = await enrichLabels({ clusters, exemplarsByKey: { k1: ['x'] }, store: {}, invoke, now: NOW });
  assert.deepEqual(result.entries, {});
  assert.equal(result.dropped.invalidName, 1);
});

test('a response naming a key that was never asked about is dropped', async () => {
  const invoke = async () => JSON.stringify([
    { key: 'k1', name: 'Fine name' },
    { key: 'never-a-candidate', name: 'Also fine name' },
  ]);
  const clusters = [cluster({ key: 'k1' })];
  const result = await enrichLabels({ clusters, exemplarsByKey: { k1: ['x'] }, store: {}, invoke, now: NOW });
  assert.deepEqual(Object.keys(result.entries), ['k1']);
  assert.equal(result.dropped.unknownKey, 1, `an unrecognized key must be categorized unknownKey: ${JSON.stringify(result.dropped)}`);
});

// Fix round 1, M-1: categorized drop counts, root-causing what the report's
// concern #1 could not — a response naming the SAME key twice.
test('a response naming the same key twice is categorized duplicateKey, only the first kept', async () => {
  const invoke = async () => JSON.stringify([
    { key: 'k1', name: 'First name' },
    { key: 'k1', name: 'Second name' },
  ]);
  const clusters = [cluster({ key: 'k1' })];
  const result = await enrichLabels({ clusters, exemplarsByKey: { k1: ['x'] }, store: {}, invoke, now: NOW });
  assert.equal(result.entries.k1.name, 'First name');
  assert.equal(result.dropped.duplicateKey, 1);
  assert.equal(result.dropped.unknownKey, 0);
  assert.equal(result.dropped.invalidName, 0);
});

test('a name is trimmed before it is stored', async () => {
  const invoke = async () => JSON.stringify([{ key: 'k1', name: '  Release ritual  ' }]);
  const clusters = [cluster({ key: 'k1' })];
  const result = await enrichLabels({ clusters, exemplarsByKey: { k1: ['x'] }, store: {}, invoke, now: NOW });
  assert.equal(result.entries.k1.name, 'Release ritual');
});

// ── privacy split: defensive caps on the exemplar text reaching the prompt ─

test('at most 2 exemplars per cluster reach the prompt, even if more are supplied', async () => {
  let seenPrompt = '';
  const invoke = async (p) => { seenPrompt = p; return '[]'; };
  const clusters = [cluster({ key: 'k1' })];
  const exemplarsByKey = { k1: ['first snippet UNIQUEA', 'second snippet UNIQUEB', 'third snippet UNIQUEC'] };
  await enrichLabels({ clusters, exemplarsByKey, store: {}, invoke, now: NOW });
  assert.match(seenPrompt, /UNIQUEA/);
  assert.match(seenPrompt, /UNIQUEB/);
  assert.doesNotMatch(seenPrompt, /UNIQUEC/, 'a third exemplar for the same cluster must never reach the prompt');
});

test('each exemplar snippet is capped at 200 chars in the prompt, even if supplied longer', async () => {
  let seenPrompt = '';
  const invoke = async (p) => { seenPrompt = p; return '[]'; };
  const clusters = [cluster({ key: 'k1' })];
  const longText = `START-MARKER-${'x'.repeat(300)}-END-MARKER`;
  await enrichLabels({ clusters, exemplarsByKey: { k1: [longText] }, store: {}, invoke, now: NOW });
  assert.match(seenPrompt, /START-MARKER/);
  assert.doesNotMatch(seenPrompt, /END-MARKER/, 'text past the 200-char cap must never reach the prompt');
});

test('exemplar text is masked before it reaches the prompt, even if the caller forgot', async () => {
  let seenPrompt = '';
  const invoke = async (p) => { seenPrompt = p; return '[]'; };
  const clusters = [cluster({ key: 'k1' })];
  // sk-ant- prefixed secrets are one of maskSecrets' recognized shapes.
  const secret = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQR';
  await enrichLabels({ clusters, exemplarsByKey: { k1: [`my key is ${secret}`] }, store: {}, invoke, now: NOW });
  assert.doesNotMatch(seenPrompt, new RegExp(secret), 'a raw secret must never reach the prompt, defensively remasked');
});

// Fix round 1, I-7: input masking (the test above) was solid; OUTPUT masking
// was not — a model asked to "name this cluster" can legitimately echo the
// sample text back, and nothing re-masked its answer before it was stored.
test('a secret echoed back in the PROPOSED NAME is masked before it is stored, not just the exemplar it came from', async () => {
  const secret = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQR';
  const invoke = async () => JSON.stringify([{ key: 'k1', name: `Key is ${secret}` }]);
  const clusters = [cluster({ key: 'k1' })];
  const result = await enrichLabels({ clusters, exemplarsByKey: { k1: ['unrelated exemplar'] }, store: {}, invoke, now: NOW });
  assert.doesNotMatch(JSON.stringify(result.entries), new RegExp(secret),
    'the model\'s OUTPUT must be masked defensively, exactly like its input');
});

// The full ADVERSARIAL echo-shim scenario the review names (a shim that
// echoes its OWN prompt back, RELEASE_PHRASINGS/FIXTURE_SECRET, the real CLI
// pipeline end to end, the on-disk store AND the --enrich --json payload) is
// a CLI-level concern — see tests/kit/usage-cli.test.mjs. The masking test
// directly above is this property's unit-level pin: whatever the model
// returns in `name`, masked before it is ever stored, independent of
// whether it came from an echoed exemplar or was invented outright.

// ── coaching synthesis: anti-fabrication gate (LOAD-BEARING) ───────────────

const FINDINGS_SUMMARY = {
  clusters: [{ key: 'k1', name: 'Recurring 5-token prompt', class: 'other', count: 13, sessions: 11, days: 9 }],
  hosts: { claude: { typed: 60, taps: 6, tapShare: 10 }, codex: { typed: 40, taps: 14, tapShare: 35 } },
  reAsks: { pairCount: 7, sessionCount: 3 },
  exactRepeats: [],
};

test('a card whose EVERY number appears in findingsSummary is accepted', async () => {
  const invoke = async () => JSON.stringify([{
    id: 'my-suggestion', title: 'A title with no numbers',
    finding: 'This recurred 13 times across 11 sessions.',
    try: 'Do something about it.',
    basis: '13 recurrences, 11 sessions, 9 days.',
    basisNumbers: [13, 11, 9],
  }]);
  const result = await synthesizeCards({ findingsSummary: FINDINGS_SUMMARY, invoke, now: NOW });
  assert.equal(result.cards.length, 1);
  assert.equal(result.cards[0].id, 'enriched-my-suggestion');
  assert.equal(result.cards[0].source, 'enriched');
  assert.equal(result.accepted, 1);
  assert.equal(typeof result.cards[0].evidenceHash, 'string');
  assert.equal(result.cards[0].generatedAt, new Date(NOW).toISOString());
});

test('LOAD-BEARING: a card citing a number NOT in findingsSummary is dropped, with a counted reason', async () => {
  const invoke = async () => JSON.stringify([{
    id: 'fabricated', title: 'Impressive-sounding title',
    finding: 'This happened 999 times, an enormous share of your activity.',
    try: 'Fix the 999-instance problem.',
    basis: '999 occurrences.',
    basisNumbers: [999],
  }]);
  const result = await synthesizeCards({ findingsSummary: FINDINGS_SUMMARY, invoke, now: NOW });
  assert.equal(result.cards.length, 0, 'a card citing an unmatched number must never be accepted');
  assert.equal(result.accepted, 0);
  assert.ok(result.dropped.unmatchedNumber >= 1, `expected a counted unmatchedNumber reason, got ${JSON.stringify(result.dropped)}`);
});

test('LOAD-BEARING: a mix of real and fabricated numbers in ONE field still drops the whole card', async () => {
  const invoke = async () => JSON.stringify([{
    id: 'mixed', title: 'Title', finding: 'This recurred 13 times, roughly 500 tokens each.',
    try: 'Do something.', basis: '13 recurrences.', basisNumbers: [13],
  }]);
  const result = await synthesizeCards({ findingsSummary: FINDINGS_SUMMARY, invoke, now: NOW });
  assert.equal(result.cards.length, 0, 'one fabricated number anywhere in finding/try/basis voids the whole card');
});

// Fix round 1, I-2: mutation-tested by the review — narrowing
// CARD_FABRICATION_FIELDS to ['finding'] alone left the WHOLE suite green,
// because every existing gate test plants its fabricated number in
// `finding` or in `basisNumbers`. Nothing exercised `try` or `basis` in
// isolation. Live evidence this is not hypothetical: the real verification
// run's card 1 put its numbers in `basis` alone ("three separate
// 6-count/6-session/1-day variants").
test('LOAD-BEARING (I-2): a fabricated number appearing ONLY in "try" still drops the card', async () => {
  const invoke = async () => JSON.stringify([{
    id: 'try-only-fabrication', title: 'Title', finding: 'This recurred 13 times.',
    try: 'Consider the 777 other instances too.', basis: '13 recurrences.', basisNumbers: [13],
  }]);
  const result = await synthesizeCards({ findingsSummary: FINDINGS_SUMMARY, invoke, now: NOW });
  assert.equal(result.cards.length, 0, 'a fabricated number in "try" alone must still void the card');
  assert.ok(result.dropped.unmatchedNumber >= 1, `expected unmatchedNumber, got ${JSON.stringify(result.dropped)}`);
});

test('LOAD-BEARING (I-2): a fabricated number appearing ONLY in "basis" still drops the card', async () => {
  const invoke = async () => JSON.stringify([{
    id: 'basis-only-fabrication', title: 'Title', finding: 'This recurred 13 times.',
    try: 'Fix it.', basis: '13 recurrences, plus 42 related incidents.', basisNumbers: [13],
  }]);
  const result = await synthesizeCards({ findingsSummary: FINDINGS_SUMMARY, invoke, now: NOW });
  assert.equal(result.cards.length, 0, 'a fabricated number in "basis" alone must still void the card');
  assert.ok(result.dropped.unmatchedNumber >= 1, `expected unmatchedNumber, got ${JSON.stringify(result.dropped)}`);
});

test('a basisNumbers entry not present in findingsSummary drops the card even if finding/try/basis text is clean', () => {
  return synthesizeCards({
    findingsSummary: FINDINGS_SUMMARY,
    invoke: async () => JSON.stringify([{
      id: 'sneaky', title: 'Title', finding: 'A finding with no numbers at all.',
      try: 'A suggestion with no numbers.', basis: 'A basis with no numbers.', basisNumbers: [42],
    }]),
    now: NOW,
  }).then((result) => {
    assert.equal(result.cards.length, 0);
    assert.ok(result.dropped.unmatchedNumber >= 1);
  });
});

test('numbers in the TITLE are exempt from the anti-fabrication gate', async () => {
  const invoke = async () => JSON.stringify([{
    id: 'title-has-99', title: 'Top 99 tips you will not believe',
    finding: 'This recurred 13 times.', try: 'Fix it.', basis: '13 recurrences.', basisNumbers: [13],
  }]);
  const result = await synthesizeCards({ findingsSummary: FINDINGS_SUMMARY, invoke, now: NOW });
  assert.equal(result.cards.length, 1, 'a stylistic number in the title must not void an otherwise-grounded card');
});

test('a card with no basisNumbers at all is dropped — every card must cite something', async () => {
  const invoke = async () => JSON.stringify([{
    id: 'no-basis', title: 'Title', finding: 'A finding.', try: 'A try.', basis: 'A basis.', basisNumbers: [],
  }]);
  const result = await synthesizeCards({ findingsSummary: FINDINGS_SUMMARY, invoke, now: NOW });
  assert.equal(result.cards.length, 0);
  assert.ok(result.dropped.noBasis >= 1);
});

test('a malformed id (not a slug) is dropped', async () => {
  const invoke = async () => JSON.stringify([{
    id: 'Not A Slug!!', title: 'Title', finding: 'This recurred 13 times.', try: 'Fix it.',
    basis: '13 recurrences.', basisNumbers: [13],
  }]);
  const result = await synthesizeCards({ findingsSummary: FINDINGS_SUMMARY, invoke, now: NOW });
  assert.equal(result.cards.length, 0);
  assert.ok(result.dropped.badId >= 1);
});

test('a newline in finding/try/basis/title is dropped', async () => {
  const invoke = async () => JSON.stringify([{
    id: 'has-newline', title: 'Fine', finding: 'Line one\nline two, 13 times.',
    try: 'Fix it.', basis: '13 recurrences.', basisNumbers: [13],
  }]);
  const result = await synthesizeCards({ findingsSummary: FINDINGS_SUMMARY, invoke, now: NOW });
  assert.equal(result.cards.length, 0);
});

test('malformed JSON response yields zero cards, not a throw', async () => {
  const invoke = async () => 'not json';
  const result = await synthesizeCards({ findingsSummary: FINDINGS_SUMMARY, invoke, now: NOW });
  assert.deepEqual(result.cards, []);
  assert.equal(result.accepted, 0);
});

test('more than 3 accepted candidates are capped at 3, deterministically (first 3 in response order)', async () => {
  // The loop index goes only in the TITLE (exempt from the anti-fabrication
  // gate) — embedding it in `finding` would inject a stray, ungrounded digit
  // for every i > 0 and have the gate correctly reject most of these cards,
  // which is a different behavior than the one this test means to pin.
  const many = Array.from({ length: 5 }, (_v, i) => ({
    id: `card-${i}`, title: `Title number ${i}`, finding: 'This recurred 13 times.',
    try: 'Fix it.', basis: '13 recurrences.', basisNumbers: [13],
  }));
  const invoke = async () => JSON.stringify(many);
  const result = await synthesizeCards({ findingsSummary: FINDINGS_SUMMARY, invoke, now: NOW });
  assert.equal(result.cards.length, 3);
  assert.deepEqual(result.cards.map((c) => c.id), ['enriched-card-0', 'enriched-card-1', 'enriched-card-2']);
});

// ── Fix round 1, I-1(b): the do-not-duplicate list ─────────────────────────

test('existing card ids/titles are named explicitly in the prompt as a do-not-duplicate list', async () => {
  let seenPrompt = '';
  const invoke = async (p) => { seenPrompt = p; return '[]'; };
  await synthesizeCards({
    findingsSummary: FINDINGS_SUMMARY, invoke, now: NOW,
    existingCards: [{ id: 'enriched-existing-one', title: 'An existing suggestion' }],
  });
  assert.match(seenPrompt, /Do NOT propose/i);
  assert.match(seenPrompt, /enriched-existing-one/);
  assert.match(seenPrompt, /An existing suggestion/);
});

test('a card whose id collides with an EXISTING stored card is dropped, categorized duplicateOfExisting', async () => {
  const invoke = async () => JSON.stringify([{
    id: 'existing-one', title: 'Title', finding: 'This recurred 13 times.',
    try: 'Fix it.', basis: '13 recurrences.', basisNumbers: [13],
  }]);
  const result = await synthesizeCards({
    findingsSummary: FINDINGS_SUMMARY, invoke, now: NOW,
    existingCards: [{ id: 'enriched-existing-one', title: 'Already proposed' }],
  });
  assert.equal(result.cards.length, 0, 'a returned id colliding with an existing enriched card must be dropped');
  assert.equal(result.dropped.duplicateOfExisting, 1);
});

test('no existingCards argument at all behaves exactly like an empty list — no crash, no do-not-duplicate section', async () => {
  let seenPrompt = '';
  const invoke = async (p) => { seenPrompt = p; return '[]'; };
  await synthesizeCards({ findingsSummary: FINDINGS_SUMMARY, invoke, now: NOW });
  assert.doesNotMatch(seenPrompt, /Do NOT propose/i);
});

// ── Fix round 1, I-1(c): the prompt's cluster view is capped, the gate is not

test('the prompt shows at most the top-40 clusters by count; a card citing a number from cluster #41 is still validated against the FULL summary', async () => {
  const manyClusters = Array.from({ length: 45 }, (_v, i) => ({
    key: `k${i}`, name: null, class: 'other', count: 45 - i, sessions: 1, days: 1,
  }));
  const bigSummary = { ...FINDINGS_SUMMARY, clusters: manyClusters };
  let seenPrompt = '';
  const invoke = async (p) => {
    seenPrompt = p;
    // Cite a number that belongs ONLY to a low-count (capped-out) cluster —
    // e.g. cluster #44 (index 44, count 1) — to prove the GATE still accepts
    // it even though the PROMPT never showed that cluster.
    return JSON.stringify([{
      id: 'low-count-cluster', title: 'Title', finding: 'One cluster recurred just once.',
      try: 'Investigate it.', basis: 'Count of 1.', basisNumbers: [1],
    }]);
  };
  const result = await synthesizeCards({ findingsSummary: bigSummary, invoke, now: NOW });
  // The prompt's displayed data shows only the top 40 by count (45..6), so
  // the tail counts (5..1) must not appear in a "count": position — they may
  // coincidentally appear elsewhere (e.g. a `sessions`/`days` value of 1),
  // which is fine; what matters is the cap note and that the gate still
  // accepted a card grounded in the untruncated full summary.
  assert.match(seenPrompt, /top 40 of 45 clusters/);
  assert.equal(result.cards.length, 1, 'the gate must accept a number from a cluster the PROMPT capped out, because the full summary still contains it');
});

test('no findings summary text (only exemplar-free counts) is ever echoed as a "text leak" — the gate is numeric only', async () => {
  // Sanity: the gate does not choke on a findingsSummary carrying a curated
  // cluster NAME (a label, explicitly allowed — "counts/labels/shares").
  const withName = { ...FINDINGS_SUMMARY, clusters: [{ ...FINDINGS_SUMMARY.clusters[0], name: 'Release ritual' }] };
  const invoke = async () => JSON.stringify([{
    id: 'ok', title: 'Title', finding: 'Release ritual recurred 13 times.',
    try: 'Encode it.', basis: '13 recurrences.', basisNumbers: [13],
  }]);
  const result = await synthesizeCards({ findingsSummary: withName, invoke, now: NOW });
  assert.equal(result.cards.length, 1);
});

// ── buildFindingsSummary: counts/labels/shares only, no exemplar text ─────

test('buildFindingsSummary carries only numbers/labels/shares from the aggregate, never raw fingerprints', () => {
  const agg = {
    promptPatterns: {
      clusters: [{ key: 'k1', label: { name: 'Release ritual', source: 'seed' }, class: 'other', count: 13, sessions: 11, days: 9, hosts: ['claude'] }],
      reAsks: { pairCount: 7, sessionCount: 3, gapHist: { 1: 4 } },
      exactRepeats: [{ key: 'e1', count: 9, tokens: 2, sessions: 7, days: 4, hosts: ['claude'] }],
    },
    promptsByHost: {
      claude: { typed: 60, taps: 6, tapShare: 0.1, questionShare: 0.3, p90TypedTokens: 80, personaOpeners: 0 },
    },
  };
  const summary = buildFindingsSummary(agg);
  assert.equal(summary.clusters[0].name, 'Release ritual');
  assert.equal(summary.clusters[0].count, 13);
  assert.equal(summary.hosts.claude.tapShare, 10, 'shares are rounded whole-number percents, matching how a model would cite them in prose');
  assert.equal(summary.reAsks.pairCount, 7);
  const json = JSON.stringify(summary);
  assert.ok(!json.includes('gapHist'), 'internal aggregate keys the model does not need stay out of the summary');
});

test('buildFindingsSummary survives a null/absent promptPatterns without throwing', () => {
  const summary = buildFindingsSummary({});
  assert.deepEqual(summary.clusters, []);
  assert.deepEqual(summary.hosts, {});
});

// ── citedEvidenceHash / isCardStale ─────────────────────────────────────────

test('citedEvidenceHash is order-independent over basisNumbers', () => {
  const a = citedEvidenceHash(FINDINGS_SUMMARY, [13, 11, 9]);
  const b = citedEvidenceHash(FINDINGS_SUMMARY, [9, 13, 11]);
  assert.equal(a, b);
});

test('isCardStale is false when every basisNumbers entry is still present in fresh findings', () => {
  const card = { basisNumbers: [13, 11, 9], evidenceHash: citedEvidenceHash(FINDINGS_SUMMARY, [13, 11, 9]) };
  assert.equal(isCardStale(card, FINDINGS_SUMMARY), false);
});

test('isCardStale is true once the evidence has moved — a cited number no longer appears anywhere', () => {
  const card = { basisNumbers: [13, 11, 9], evidenceHash: citedEvidenceHash(FINDINGS_SUMMARY, [13, 11, 9]) };
  const moved = {
    ...FINDINGS_SUMMARY,
    clusters: [{ ...FINDINGS_SUMMARY.clusters[0], count: 20, sessions: 11, days: 9 }],
  };
  assert.equal(isCardStale(card, moved), true, 'the count moved from 13 to 20 — 13 no longer appears anywhere');
});

// ── findingsSummaryHash (I-1a's delta-gate primitive) ───────────────────────

test('findingsSummaryHash is UNCHANGED by a cluster display name alone — a label/re-curate is not evidence moving', () => {
  const before = findingsSummaryHash(FINDINGS_SUMMARY);
  const relabeled = {
    ...FINDINGS_SUMMARY,
    clusters: [{ ...FINDINGS_SUMMARY.clusters[0], name: 'A brand new curated name' }],
  };
  assert.equal(findingsSummaryHash(relabeled), before,
    'runEnrichPass rebuilds findingsSummary with activeLabels re-applied on every pass, including the '
    + 'one right after a labeling round — if the hash moved on a name alone, the very next --enrich '
    + 'would always see "evidence changed" with nothing actually new to synthesize about');
});

test('findingsSummaryHash CHANGES when a real evidence number moves, even though no name changed', () => {
  const before = findingsSummaryHash(FINDINGS_SUMMARY);
  const moved = {
    ...FINDINGS_SUMMARY,
    clusters: [{ ...FINDINGS_SUMMARY.clusters[0], count: 20 }],
  };
  assert.notEqual(findingsSummaryHash(moved), before);
});

test('findingsSummaryHash is stable and order-insensitive to key construction — same content, same hash', () => {
  const a = findingsSummaryHash(FINDINGS_SUMMARY);
  const b = findingsSummaryHash({ ...FINDINGS_SUMMARY });
  assert.equal(a, b);
});

test('a deterministic rule card is never subject to isCardStale — the caller only calls it for source:"enriched" cards', () => {
  // Documented contract, not enforced by this function (it has no `source`
  // field to gate on) — the caller (CLI/dashboard) only calls isCardStale for
  // enriched cards. Pinned here so that contract has a test naming it.
  const ruleCard = { id: 'commit-push-claude-md', basisNumbers: undefined, evidenceHash: 'irrelevant' };
  assert.throws(() => isCardStale(ruleCard, FINDINGS_SUMMARY), undefined,
    'a card with no basisNumbers array is a caller error, not a silent false');
});

// ── INTEGRATION: aggregate -> candidates -> (fake invoke) -> store ->
// labelFor resolves 'enriched' -> CLI renders the enriched name; and the
// same for one enriched card through reconcile. ──────────────────────────

function tmpConfigDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ak-enrich-integration-'));
}

function fp(h, t, th, extra = {}) { return { h, t, th, p: 'human', ...extra }; }

/** Stub siblings, the same shape tests/kit/usage-index.test.mjs's own `deps()`
 *  uses — pricing/classification/insights are other modules' contracts. */
function integrationDeps() {
  return {
    costOf: () => 0, pricesAsOf: null,
    classify: () => ({ category: 'Unclassified', confidence: 0, basis: 'no signal' }),
    detectInsights: () => [],
  };
}

/** A tiny corpus that produces exactly one 'characterized' cluster, via the
 *  REAL aggregate()/nearDupClusters() pipeline — not a hand-built row. Three
 *  sessions, one identical token-set fingerprint each (different hashes,
 *  same sketch, so they Jaccard-cluster at 1.0), which clears the default
 *  crossSessionClusters minSessions:3 floor and matches no seed (3 sessions
 *  is below every seed's own session floor). */
function enrichRecords(now) {
  const tokens = ['zeta', 'yankee', 'xray', 'whiskey', 'victor'];
  const mk = (id, end) => {
    const rec = blankSession(`s-${id}`, 'claude');
    Object.assign(rec, {
      title: `s-${id}`, project: 'proj', prompts: 1, responses: 1,
      start: end - 60_000, end, active: [[end - 60_000, end]], lenSeconds: 60,
      promptFPs: [fp(`h${id}`, 5, tokens, { q: 1 })],
    });
    addUsage(rec, '2026-08-20', 'claude-opus-5', { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, responses: 1 });
    return rec;
  };
  return [mk('a', now - 3 * 86_400_000), mk('b', now - 2 * 86_400_000), mk('c', now - 1 * 86_400_000)];
}

test('INTEGRATION: real aggregate -> candidate selection -> fake invoke -> label store -> labelFor resolves enriched -> renders', async () => {
  const dir = tmpConfigDir();
  const labelStorePath = path.join(dir, 'usage-prompt-labels.json');

  const now = Date.parse('2026-08-25T12:00:00.000Z');
  const cutoff = now - 30 * 86_400_000;
  const agg = aggregate(enrichRecords(now), {
    days: 30, now, cutoff, prompts: true, deps: integrationDeps(),
  });
  assert.ok(agg.promptPatterns, 'the aggregate must actually build the prompt-patterns projection');
  const before = agg.promptPatterns.clusters.find((c) => c.label.source === 'characterized');
  assert.ok(before, `expected a characterized cluster from the real pipeline, got: ${JSON.stringify(agg.promptPatterns.clusters)}`);

  const invoke = async () => JSON.stringify([{ key: before.key, name: 'Integration-named cluster' }]);
  const result = await enrichLabels({
    clusters: agg.promptPatterns.clusters, exemplarsByKey: { [before.key]: ['a masked exemplar'] },
    store: {}, invoke, now,
  });
  assert.deepEqual(Object.keys(result.entries), [before.key]);

  saveLabelStore(labelStorePath, { version: 1, labels: result.entries, cards: {} });
  const loaded = loadLabelStore(labelStorePath);

  const after = withStoreLabel(before, loaded.labels);
  assert.equal(after.label.name, 'Integration-named cluster');
  assert.equal(after.label.source, 'enriched');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── shared read-path wiring (CLI + dashboard, deliverable §5) ─────────────

test('applyLabelStoreToPatterns re-resolves every cluster, unchanged when the store has nothing for it', () => {
  const pp = { clusters: [cluster({ key: 'k1' }), cluster({ key: 'k2', label: { name: 'Release ritual', source: 'seed' } })] };
  const store = { k1: { name: 'A person named this', source: 'curated', firstSeen: '2026-01-01T00:00:00.000Z' } };
  const out = applyLabelStoreToPatterns(pp, store);
  assert.equal(out.clusters[0].label.name, 'A person named this');
  assert.equal(out.clusters[0].label.source, 'curated');
  assert.equal(out.clusters[1].label.name, 'Release ritual', 'a seed match with no store entry is untouched');
  assert.equal(out.clusters[1].label.source, 'seed');
});

test('applyLabelStoreToPatterns passes null/empty patterns through unchanged', () => {
  assert.equal(applyLabelStoreToPatterns(null, {}), null);
  const empty = { clusters: [] };
  assert.equal(applyLabelStoreToPatterns(empty, {}), empty);
});

test('hydrateStoredCards restores CoachingCard shape, keyed id becomes the card id, source is enriched', () => {
  const store = {
    'enriched-foo': {
      title: 'Foo', finding: 'Bar happened 3 times.', try: 'Do X.', basis: '3 occurrences.',
      basisNumbers: [3], evidenceHash: 'a'.repeat(16), generatedAt: '2026-08-01T00:00:00.000Z',
    },
  };
  const [card] = hydrateStoredCards(store);
  assert.equal(card.id, 'enriched-foo');
  assert.equal(card.source, 'enriched');
  assert.equal(card.title, 'Foo');
  assert.deepEqual(card.basisNumbers, [3]);
});

test('hydrateStoredCards on an empty/absent store yields an empty array', () => {
  assert.deepEqual(hydrateStoredCards({}), []);
  assert.deepEqual(hydrateStoredCards(undefined), []);
});

test('applyCardStaleness marks a fresh enriched card not-stale and leaves a rule card untouched', () => {
  const fresh = {
    id: 'enriched-fresh', source: 'enriched', basisNumbers: [13, 11, 9],
    evidenceHash: citedEvidenceHash(FINDINGS_SUMMARY, [13, 11, 9]),
  };
  const rule = { id: 'commit-push-claude-md', stale: false };
  const cards = [fresh, rule];
  applyCardStaleness(cards, FINDINGS_SUMMARY);
  assert.equal(fresh.stale, false, 'the same findingsSummary it was synthesized against — nothing moved');
  assert.equal(rule.stale, false, 'a rule card is untouched (still whatever the ledger already set) — this function never writes to a non-enriched card');
});

test('applyCardStaleness detects real drift once a fresh enriched card\'s evidence moves', () => {
  const card = {
    id: 'enriched-x', source: 'enriched', basisNumbers: [13, 11, 9],
    evidenceHash: citedEvidenceHash(FINDINGS_SUMMARY, [13, 11, 9]),
  };
  const cards = [card];
  const movedSummary = { ...FINDINGS_SUMMARY, clusters: [{ ...FINDINGS_SUMMARY.clusters[0], count: 30 }] };
  applyCardStaleness(cards, movedSummary);
  assert.equal(card.stale, true);
});

test('INTEGRATION: one enriched card flows through reconcile exactly like a rule card', async () => {
  const findingsSummary = FINDINGS_SUMMARY;
  const invoke = async () => JSON.stringify([{
    id: 'my-enriched-card', title: 'An enriched suggestion',
    finding: 'This recurred 13 times across 11 sessions.', try: 'Do the obvious thing.',
    basis: '13 recurrences, 11 sessions.', basisNumbers: [13, 11],
  }]);
  const synthesis = await synthesizeCards({ findingsSummary, invoke, now: NOW });
  assert.equal(synthesis.cards.length, 1);

  // No rule cards fire on this ctx (empty promptPatterns et al.) — proves the
  // enriched card reconciles on its own, joining exactly like a rule card
  // would (spec: "id namespaced enriched-<slug>").
  const ruleCards = deriveCards({ promptPatterns: null, promptBaselines: null, promptsByHost: null, insights: [], now: NOW });
  assert.deepEqual(ruleCards, []);

  const allCards = [...ruleCards, ...synthesis.cards];
  const { ledger, cards: reconciled } = reconcile({ version: 1, records: [] }, allCards, { now: NOW });
  assert.equal(reconciled.length, 1);
  assert.equal(reconciled[0].id, 'enriched-my-enriched-card');
  assert.equal(reconciled[0].status, 'proposed');
  assert.equal(ledger.records.length, 1);
  assert.equal(ledger.records[0].id, 'enriched-my-enriched-card');
});
