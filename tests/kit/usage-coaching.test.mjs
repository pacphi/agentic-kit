import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  evidenceHash, deriveCards, detectAdoption, measureOutcome, currentEvidenceFor,
  OUTCOME_MIN_DAYS, DAY_MS,
} from '../../src/lib/usage-coaching.mjs';
import {
  RELEASE_RITUAL_MIN_COUNT, COMMIT_PUSH_MIN_COUNT, REASK_DELTA_MIN_PAIRS, PERSONA_LIBRARY_MIN_COUNT,
} from '../../src/lib/usage-coaching-rules.mjs';
import {
  loadLedger, saveLedger, reconcile, dismissCard, summarizeLedger, defaultLedgerPath,
  gatherAdoptionInputs, LEDGER_SCHEMA_VERSION, DISMISS_PERMANENT_THRESHOLD, DISMISS_MATERIALITY_RATIO,
  CANONICAL_WINDOW_DAYS,
} from '../../src/lib/usage-outcome-ledger.mjs';
import { aggregate } from '../../src/lib/usage-aggregate.mjs';
import { blankSession, addUsage, notePromptFingerprint } from '../../src/lib/usage-parsers.mjs';

const NOW = Date.parse('2026-08-29T12:00:00.000Z');

// ── fixture builders (hand-shaped promptPatterns/promptsByHost/insights) ────

function cluster({ name, source = 'seed', class: cls = 'instruction', count, sessions, days, key = 'k1', hosts = ['claude'] }) {
  return { key, label: { name, source }, class: cls, count, sessions, days, hosts, medianTokens: 3, sampleSessionIds: [] };
}

function hostRow({ typed = 100, taps = 10, personaOpeners = 0, p90TypedTokens = 50 } = {}) {
  return { typed, taps, tapShare: typed ? taps / typed : null, p90TypedTokens, personaOpeners, questionShare: 0.1 };
}

function insight(id, extra = {}) {
  return { id, kind: 'coach', severity: 'info', title: id, finding: `${id} finding text`, evidence: `${id} evidence text`, command: null, impact: null, ...extra };
}

// ── evidenceHash ─────────────────────────────────────────────────────────────

test('evidenceHash is stable regardless of key order, and looks like sha256-16', () => {
  const a = evidenceHash({ id: 'x', count: 5, sessions: 3 });
  const b = evidenceHash({ sessions: 3, count: 5, id: 'x' });
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{16}$/);
});

test('evidenceHash changes when any count in the input changes', () => {
  const a = evidenceHash({ id: 'x', count: 5 });
  const b = evidenceHash({ id: 'x', count: 6 });
  assert.notEqual(a, b);
});

test('evidenceHash is stable across nested objects/arrays, key order irrelevant at every depth', () => {
  const a = evidenceHash({ id: 'x', nested: { b: 1, a: 2 }, list: [1, 2, 3] });
  const b = evidenceHash({ nested: { a: 2, b: 1 }, id: 'x', list: [1, 2, 3] });
  assert.equal(a, b);
  // Array order DOES matter — it is not a key set.
  const c = evidenceHash({ id: 'x', nested: { a: 2, b: 1 }, list: [3, 2, 1] });
  assert.notEqual(a, c);
});

// ── deriveCards: per-rule fire/no-fire boundaries ───────────────────────────

test('release-ritual-skill fires at count >= 5 on the seed-matched cluster, not below', () => {
  const hit = cluster({ name: 'Release ritual', count: RELEASE_RITUAL_MIN_COUNT, sessions: 5, days: 3 });
  const miss = cluster({ name: 'Release ritual', count: RELEASE_RITUAL_MIN_COUNT - 1, sessions: 4, days: 2 });
  const cardsHit = deriveCards({ promptPatterns: { clusters: [hit] }, promptBaselines: null, promptsByHost: null, insights: [], now: NOW });
  const cardsMiss = deriveCards({ promptPatterns: { clusters: [miss] }, promptBaselines: null, promptsByHost: null, insights: [], now: NOW });
  const card = cardsHit.find((c) => c.id === 'release-ritual-skill');
  assert.ok(card, 'expected release-ritual-skill to fire at the boundary count');
  assert.equal(cardsMiss.find((c) => c.id === 'release-ritual-skill'), undefined, 'must not fire one below the bar');
  assert.equal(card.draft.kind, 'skill-skeleton');
  assert.match(card.draft.text, /release-ritual/);
  assert.match(card.basis, /5 recurrences across 5 sessions, 3 days/);
  assert.match(card.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(typeof card.evidenceHash, 'string');
});

test('commit-push-claude-md fires at count >= 5 on the seed-matched cluster, not below', () => {
  const hit = cluster({ name: 'Commit-and-push instruction', count: COMMIT_PUSH_MIN_COUNT, sessions: 6, days: 4 });
  const miss = cluster({ name: 'Commit-and-push instruction', count: COMMIT_PUSH_MIN_COUNT - 1, sessions: 6, days: 4 });
  const cardsHit = deriveCards({ promptPatterns: { clusters: [hit] }, promptBaselines: null, promptsByHost: null, insights: [], now: NOW });
  const cardsMiss = deriveCards({ promptPatterns: { clusters: [miss] }, promptBaselines: null, promptsByHost: null, insights: [], now: NOW });
  const card = cardsHit.find((c) => c.id === 'commit-push-claude-md');
  assert.ok(card);
  assert.equal(cardsMiss.find((c) => c.id === 'commit-push-claude-md'), undefined);
  assert.equal(card.draft.kind, 'claude-md-line');
  assert.doesNotMatch(card.draft.text, /commit and push\.?$/i, 'the draft is generated boilerplate, not the prompt text');
});

test('a cluster whose label does not match the seed (wrong name or source) never fires either cluster rule', () => {
  const wrongName = cluster({ name: 'Something else', count: 99, sessions: 99, days: 99 });
  const wrongSource = cluster({ name: 'Release ritual', source: 'characterized', count: 99, sessions: 99, days: 99 });
  for (const c of [wrongName, wrongSource]) {
    const cards = deriveCards({ promptPatterns: { clusters: [c] }, promptBaselines: null, promptsByHost: null, insights: [], now: NOW });
    assert.equal(cards.find((x) => x.id === 'release-ritual-skill' || x.id === 'commit-push-claude-md'), undefined);
  }
});

test('reask-delta fires at pairCount >= 10, not below; carries no draft', () => {
  const hit = deriveCards({
    promptPatterns: { reAsks: { pairCount: REASK_DELTA_MIN_PAIRS, sessionCount: 7 } },
    promptBaselines: null, promptsByHost: null, insights: [], now: NOW,
  });
  const miss = deriveCards({
    promptPatterns: { reAsks: { pairCount: REASK_DELTA_MIN_PAIRS - 1, sessionCount: 7 } },
    promptBaselines: null, promptsByHost: null, insights: [], now: NOW,
  });
  const card = hit.find((c) => c.id === 'reask-delta');
  assert.ok(card);
  assert.equal(card.draft, undefined, 'reask-delta must not carry a draft');
  assert.match(card.basis, /10 re-ask pairs across 7 sessions/);
  assert.equal(miss.find((c) => c.id === 'reask-delta'), undefined);
});

test('codex-completion-criteria requires BOTH the host-prompt-asymmetry insight and codex favoring the asymmetry', () => {
  const byHost = { codex: hostRow({ personaOpeners: 12, p90TypedTokens: 200 }), claude: hostRow({ personaOpeners: 2, p90TypedTokens: 80 }) };
  const withInsight = deriveCards({
    promptPatterns: null, promptBaselines: null, promptsByHost: byHost,
    insights: [insight('host-prompt-asymmetry')], now: NOW,
  });
  assert.ok(withInsight.find((c) => c.id === 'codex-completion-criteria'));
  const withoutInsight = deriveCards({
    promptPatterns: null, promptBaselines: null, promptsByHost: byHost, insights: [], now: NOW,
  });
  assert.equal(withoutInsight.find((c) => c.id === 'codex-completion-criteria'), undefined,
    'the insight must be present even when the host numbers alone would qualify');
  // Insight present but claude is the one favored — must not fire.
  const flipped = deriveCards({
    promptPatterns: null, promptBaselines: null,
    promptsByHost: { codex: hostRow({ personaOpeners: 1, p90TypedTokens: 40 }), claude: hostRow({ personaOpeners: 9, p90TypedTokens: 200 }) },
    insights: [insight('host-prompt-asymmetry')], now: NOW,
  });
  assert.equal(flipped.find((c) => c.id === 'codex-completion-criteria'), undefined);
  const card = withInsight.find((c) => c.id === 'codex-completion-criteria');
  assert.equal(card.draft, undefined, 'codex-completion-criteria must not carry a draft');
});

// Fix round 1, M-4: the length arm needs the SAME 1.5x floor the
// host-prompt-asymmetry detector itself uses (THRESHOLDS.asymmetryMinRatio)
// — a bare ratio > 1 rendered "Codex prompts run longer" on a one-token
// difference, and the finding must print only the arm that actually fired.
test('codex-completion-criteria\'s length arm requires the detector\'s own 1.5x floor, and prints only the arm that fired', () => {
  const insights = [insight('host-prompt-asymmetry')];
  // Persona-only: length ratio does not clear 1.5x (273 vs 322 even favors
  // claude) — this exact shape is the one the review caught rendering
  // "Codex prompts run longer" when it should have been impossible.
  const personaOnly = deriveCards({
    promptPatterns: null, promptBaselines: null,
    promptsByHost: {
      codex: hostRow({ personaOpeners: 12, p90TypedTokens: 273 }),
      claude: hostRow({ personaOpeners: 2, p90TypedTokens: 322 }),
    },
    insights, now: NOW,
  }).find((c) => c.id === 'codex-completion-criteria');
  assert.ok(personaOnly);
  assert.doesNotMatch(personaOnly.finding, /runs measurably longer/, 'length claim must be impossible when the ratio favors claude');
  assert.doesNotMatch(personaOnly.basis, /p90 typed length/);
  assert.match(personaOnly.finding, /retypes more role assignments than Claude does/);

  // A ratio just under 1.5x must not fire the length arm either.
  const belowFloor = deriveCards({
    promptPatterns: null, promptBaselines: null,
    promptsByHost: {
      codex: hostRow({ personaOpeners: 1, p90TypedTokens: 149 }),
      claude: hostRow({ personaOpeners: 1, p90TypedTokens: 100 }),
    },
    insights, now: NOW,
  }).find((c) => c.id === 'codex-completion-criteria');
  assert.equal(belowFloor, undefined, '1.49x must not clear the 1.5x floor');

  // At/above 1.5x, the length arm fires and states its own numbers.
  const lengthOnly = deriveCards({
    promptPatterns: null, promptBaselines: null,
    promptsByHost: {
      codex: hostRow({ personaOpeners: 1, p90TypedTokens: 150 }),
      claude: hostRow({ personaOpeners: 1, p90TypedTokens: 100 }),
    },
    insights, now: NOW,
  }).find((c) => c.id === 'codex-completion-criteria');
  assert.ok(lengthOnly);
  assert.match(lengthOnly.finding, /runs measurably longer prompts than Claude does/);
  assert.doesNotMatch(lengthOnly.finding, /retypes more role assignments/);
  assert.match(lengthOnly.basis, /p90 typed length 150 tokens on codex vs 100 on claude/);
  assert.doesNotMatch(lengthOnly.finding, /which usually means/i, 'no causal assertion — measured phrasing only (M-4)');
});

// A host that clears tapRowsOverThreshold's real gates (taps >= THRESHOLDS.tapMinCount
// [20] and share above its comparator) vs. one that does not, for the I-4 two-host pin.
const OVER_THRESHOLD_HOST = hostRow({ typed: 100, taps: 25 }); // share 0.25 > the 0.10 absolute floor
const UNDER_THRESHOLD_HOST = hostRow({ typed: 200, taps: 10 }); // taps < 20 AND share 0.05 < the floor

test('progress-report-taps fires when supervision-tap-share is present AND at least one host clears its own threshold', () => {
  const withBoth = deriveCards({
    promptPatterns: null, promptBaselines: null,
    promptsByHost: { claude: OVER_THRESHOLD_HOST },
    insights: [insight('supervision-tap-share')], now: NOW,
  });
  const card = withBoth.find((c) => c.id === 'progress-report-taps');
  assert.ok(card);
  assert.equal(card.draft, undefined);

  const withoutInsight = deriveCards({
    promptPatterns: null, promptBaselines: null, promptsByHost: { claude: OVER_THRESHOLD_HOST },
    insights: [], now: NOW,
  });
  assert.equal(withoutInsight.find((c) => c.id === 'progress-report-taps'), undefined);

  // The insight fired historically but THIS ctx's own recomputation finds no
  // host over threshold (e.g. a stale/mismatched snapshot) — no card, rather
  // than fabricating a count from hosts that do not qualify.
  const noQualifyingHost = deriveCards({
    promptPatterns: null, promptBaselines: null, promptsByHost: { claude: UNDER_THRESHOLD_HOST },
    insights: [insight('supervision-tap-share')], now: NOW,
  });
  assert.equal(noQualifyingHost.find((c) => c.id === 'progress-report-taps'), undefined);
});

// Fix round 1, I-4: the basis number and the ledger baseline number must be
// the SAME quantity — pinned with a two-host fixture where only one host is
// over its own threshold.
test('progress-report-taps measures the SAME host population it displays (I-4 two-host pin)', () => {
  const promptsByHost = { claude: OVER_THRESHOLD_HOST, codex: UNDER_THRESHOLD_HOST };
  const insights = [insight('supervision-tap-share')];
  const cards = deriveCards({ promptPatterns: null, promptBaselines: null, promptsByHost, insights, now: NOW });
  const card = cards.find((c) => c.id === 'progress-report-taps');
  assert.ok(card);
  // Only claude's 25 taps count — codex never clears its own threshold.
  assert.match(card.basis, /25 supervision taps recorded across claude this window\./);
  assert.doesNotMatch(card.basis, /codex/, 'a host that never cleared its own threshold must not be counted');

  const currentPatterns = { promptsByHost, insights };
  const baseline = currentEvidenceFor('progress-report-taps', currentPatterns);
  assert.equal(baseline.count, 25, 'the ledger baseline must be the identical quantity the basis states');
  assert.deepEqual(baseline.hosts, ['claude']);
});

test('progress-report-taps states which comparator actually applied — never claims a baseline it did not use', () => {
  const insights = [insight('supervision-tap-share')];
  // No promptBaselines at all -> every qualifying row falls back to the
  // absolute floor, never "your own trailing baseline".
  const floorOnly = deriveCards({
    promptPatterns: null, promptBaselines: null, promptsByHost: { claude: OVER_THRESHOLD_HOST },
    insights, now: NOW,
  }).find((c) => c.id === 'progress-report-taps');
  assert.match(floorOnly.finding, /against the floor used while there is no personal baseline yet/);
  assert.doesNotMatch(floorOnly.finding, /your own trailing baseline/);

  // A real trailing-90d baseline for claude makes the row baseline-judged.
  const withBaseline = deriveCards({
    promptPatterns: null, promptsByHost: { claude: OVER_THRESHOLD_HOST },
    promptBaselines: { claude: { tapShareP75_trailing90d: 0.05 } },
    insights, now: NOW,
  }).find((c) => c.id === 'progress-report-taps');
  assert.match(withBaseline.finding, /against your own trailing baseline/);
});

// Fix round 1, I-3: codex-role-library is scoped to Codex specifically (its
// id, and the spec §8 sibling effort it points at, are both Codex-shaped) —
// "whichever host leads" produced wrong, Codex-specific advice rendered
// under a Claude-leading corpus.
test('codex-role-library fires at personaOpeners >= 10 on Codex, not below, and never on Claude leading', () => {
  const hit = deriveCards({
    promptPatterns: null, promptBaselines: null,
    promptsByHost: { codex: hostRow({ personaOpeners: PERSONA_LIBRARY_MIN_COUNT }), claude: hostRow({ personaOpeners: 1 }) },
    insights: [], now: NOW,
  });
  const miss = deriveCards({
    promptPatterns: null, promptBaselines: null,
    promptsByHost: { codex: hostRow({ personaOpeners: PERSONA_LIBRARY_MIN_COUNT - 1 }), claude: hostRow({ personaOpeners: 1 }) },
    insights: [], now: NOW,
  });
  const card = hit.find((c) => c.id === 'codex-role-library');
  assert.ok(card);
  assert.equal(card.draft.kind, 'link');
  assert.match(card.title, /Codex/);
  assert.doesNotMatch(card.try, /claude/i, 'the recommendation text must stay Codex-shaped');
  assert.doesNotMatch(card.draft.text, /ak host pick/, 'must not point at a command that cannot manage prompt fragments (I-3)');
  assert.doesNotMatch(card.finding, /largest measured pattern/i, 'no uncomputed superlative (M-5)');
  assert.equal(miss.find((c) => c.id === 'codex-role-library'), undefined);

  // Claude leading, even by a wide margin, produces NO card at all — the
  // recommendation (a managed Codex role-fragment library) does not apply.
  const claudeLeading = deriveCards({
    promptPatterns: null, promptBaselines: null,
    promptsByHost: { codex: hostRow({ personaOpeners: 0 }), claude: hostRow({ personaOpeners: 40 }) },
    insights: [], now: NOW,
  });
  assert.equal(claudeLeading.find((c) => c.id === 'codex-role-library'), undefined,
    'a Claude-leading corpus must not produce Codex-specific advice');

  // No codex host data at all this window: structurally absent, not a
  // fabricated zero.
  assert.equal(currentEvidenceFor('codex-role-library', { promptsByHost: { claude: hostRow() } }), null);
});

// ── evidence-honesty: absent inputs yield NO card, never a zero-count one ───

test('absent promptPatterns yields no cluster/reask cards at all — never a fabricated zero', () => {
  const cards = deriveCards({ promptPatterns: null, promptBaselines: null, promptsByHost: null, insights: [], now: NOW });
  assert.equal(cards.length, 0);
});

test('a promptPatterns WITH an empty clusters array (measured, found nothing) still yields no card — correctly below the bar, not absent', () => {
  const cards = deriveCards({ promptPatterns: { clusters: [], reAsks: { pairCount: 0, sessionCount: 0 } }, promptBaselines: null, promptsByHost: null, insights: [], now: NOW });
  assert.equal(cards.length, 0);
});

test('absent promptsByHost yields no host-keyed cards, distinctly from an empty object', () => {
  const insights = [insight('host-prompt-asymmetry'), insight('supervision-tap-share')];
  const absent = deriveCards({ promptPatterns: null, promptBaselines: null, promptsByHost: null, insights, now: NOW });
  assert.equal(absent.length, 0, 'null promptsByHost: absent, no card');
  // An empty (but present) promptsByHost is measured-zero: no host clears
  // any threshold, so NONE of the three host-keyed cards fire — correctly
  // below the bar, not the "absent" case (which would also yield nothing,
  // but for a structurally different reason — see currentEvidenceFor below).
  const empty = deriveCards({ promptPatterns: null, promptBaselines: null, promptsByHost: {}, insights, now: NOW });
  assert.equal(empty.length, 0);
  assert.deepEqual(currentEvidenceFor('progress-report-taps', { promptsByHost: {}, insights }), null,
    'an empty promptsByHost has no rows to sum — no qualifying host, not a fabricated zero');
  assert.equal(currentEvidenceFor('progress-report-taps', { promptsByHost: null, insights }), null);
});

// ── currentEvidenceFor ───────────────────────────────────────────────────────

test('currentEvidenceFor reports a real zero for a rule id given data but no match', () => {
  const e = currentEvidenceFor('release-ritual-skill', { promptPatterns: { clusters: [] } });
  assert.deepEqual(e, { count: 0, clusterKey: null, sessions: 0, days: 0 });
});

test('currentEvidenceFor reports null (not zero) when the structure itself is absent', () => {
  assert.equal(currentEvidenceFor('release-ritual-skill', { promptPatterns: null }), null);
  assert.equal(currentEvidenceFor('reask-delta', {}), null);
});

// ── detectAdoption: all three routes + negatives ────────────────────────────

test('detectAdoption: CLAUDE.md route fires when the draft line is present verbatim, not otherwise', () => {
  const card = deriveCards({ promptPatterns: { clusters: [cluster({ name: 'Commit-and-push instruction', count: 6, sessions: 6, days: 3 })] }, promptBaselines: null, promptsByHost: null, insights: [], now: NOW })
    .find((c) => c.id === 'commit-push-claude-md');
  const yes = detectAdoption(card, { claudeMdTexts: [`# CLAUDE.md\n\n- ${card.draft.text}\n`] });
  assert.deepEqual(yes, { adopted: true, via: 'claude-md' });
  const no = detectAdoption(card, { claudeMdTexts: ['# CLAUDE.md\n\nsomething unrelated\n'] });
  assert.equal(no.adopted, false);
});

test('detectAdoption: skill-dir route fires when a dir named after the card slug exists, not otherwise', () => {
  const card = deriveCards({ promptPatterns: { clusters: [cluster({ name: 'Release ritual', count: 6, sessions: 6, days: 3 })] }, promptBaselines: null, promptsByHost: null, insights: [], now: NOW })
    .find((c) => c.id === 'release-ritual-skill');
  const yes = detectAdoption(card, { skillDirs: ['release-ritual', 'something-else'] });
  assert.deepEqual(yes, { adopted: true, via: 'skill-dir' });
  const no = detectAdoption(card, { skillDirs: ['unrelated-skill'] });
  assert.equal(no.adopted, false);
});

test('detectAdoption: collapse route fires at <= 20% of the baseline count recorded at proposal, not above', () => {
  const card = deriveCards({ promptPatterns: { clusters: [cluster({ key: 'kk', name: 'Release ritual', count: 20, sessions: 10, days: 5 })] }, promptBaselines: null, promptsByHost: null, insights: [], now: NOW })
    .find((c) => c.id === 'release-ritual-skill');
  const ledgerRecord = { baseline: { count: 20 } };
  const collapsed = detectAdoption(card, {
    ledgerRecord, currentPatterns: { promptPatterns: { clusters: [cluster({ key: 'kk', name: 'Release ritual', count: 4, sessions: 3, days: 2 })] } },
  });
  assert.deepEqual(collapsed, { adopted: true, via: 'collapse' });
  const notYet = detectAdoption(card, {
    ledgerRecord, currentPatterns: { promptPatterns: { clusters: [cluster({ key: 'kk', name: 'Release ritual', count: 5, sessions: 4, days: 2 })] } },
  });
  assert.equal(notYet.adopted, false, '5 of 20 is 25%, above the 20% bar');
});

// Fix round 1, I-7: collapse is adoption evidence only for release-ritual-skill,
// commit-push-claude-md, and reask-delta — a recurring PATTERN the operator
// stops repeating. The three statistic-backed cards' "count" is a derived
// number that can drop for reasons unrelated to the recommendation, so
// recording that as "adopted" would be a fabricated causal claim.
test('detectAdoption: collapse route is opt-in — the three statistic cards never adopt by collapse, even at a qualifying ratio', () => {
  const completionCard = deriveCards({
    promptPatterns: null, promptBaselines: null,
    promptsByHost: { codex: hostRow({ personaOpeners: 20, p90TypedTokens: 200 }), claude: hostRow({ personaOpeners: 2, p90TypedTokens: 80 }) },
    insights: [insight('host-prompt-asymmetry')], now: NOW,
  }).find((c) => c.id === 'codex-completion-criteria');
  const stillNotAdopted = detectAdoption(completionCard, {
    ledgerRecord: { baseline: { count: 20 } },
    currentPatterns: { promptsByHost: { codex: hostRow({ personaOpeners: 1 }), claude: hostRow({ personaOpeners: 20 }) } },
  });
  assert.deepEqual(stillNotAdopted, { adopted: false, via: null },
    'a persona-opener drop from 20 to 1 (5%, well past the 20% collapse bar) must not read as adoption');

  const progressCard = deriveCards({
    promptPatterns: null, promptBaselines: null, promptsByHost: { claude: OVER_THRESHOLD_HOST },
    insights: [insight('supervision-tap-share')], now: NOW,
  }).find((c) => c.id === 'progress-report-taps');
  const progressNotAdopted = detectAdoption(progressCard, {
    ledgerRecord: { baseline: { count: 25 } },
    currentPatterns: { promptsByHost: {}, insights: [] },
  });
  assert.deepEqual(progressNotAdopted, { adopted: false, via: null });

  const roleCard = deriveCards({
    promptPatterns: null, promptBaselines: null,
    promptsByHost: { codex: hostRow({ personaOpeners: PERSONA_LIBRARY_MIN_COUNT }) },
    insights: [], now: NOW,
  }).find((c) => c.id === 'codex-role-library');
  const roleNotAdopted = detectAdoption(roleCard, {
    ledgerRecord: { baseline: { count: PERSONA_LIBRARY_MIN_COUNT } },
    currentPatterns: { promptsByHost: { codex: hostRow({ personaOpeners: 0 }) } },
  });
  assert.deepEqual(roleNotAdopted, { adopted: false, via: null },
    'codex-role-library has NO adoption route at all — no draft-based route matches its "link" kind, and collapse is off');
});

test('detectAdoption returns not-adopted when nothing matches any route', () => {
  const card = deriveCards({ promptPatterns: { reAsks: { pairCount: 12, sessionCount: 8 } }, promptBaselines: null, promptsByHost: null, insights: [], now: NOW })
    .find((c) => c.id === 'reask-delta');
  const result = detectAdoption(card, { claudeMdTexts: [], skillDirs: [], currentPatterns: {}, ledgerRecord: null });
  assert.deepEqual(result, { adopted: false, via: null });
});

// ── measureOutcome ───────────────────────────────────────────────────────────

test('measureOutcome reports improved=true with a numeric delta when the count dropped', () => {
  const record = { id: 'release-ritual-skill', baseline: { count: 24 } };
  const out = measureOutcome(record, { promptPatterns: { clusters: [cluster({ key: 'kk', name: 'Release ritual', count: 2, sessions: 2, days: 1 })] } });
  assert.equal(out.improved, true);
  assert.equal(out.deltaText, '24 → 2 since adoption');
});

test('measureOutcome reports improved=false, with the same honest delta, when the count did not drop', () => {
  const record = { id: 'release-ritual-skill', baseline: { count: 5 } };
  const out = measureOutcome(record, { promptPatterns: { clusters: [cluster({ key: 'kk', name: 'Release ritual', count: 9, sessions: 6, days: 4 })] } });
  assert.equal(out.improved, false);
  assert.equal(out.deltaText, '5 → 9 since adoption');
});

// ── reconcile: the transition matrix ────────────────────────────────────────

function ledgerOf(records) { return { version: LEDGER_SCHEMA_VERSION, records }; }

test('reconcile: a brand-new card proposes with a frozen baseline snapshot', () => {
  const c = cluster({ key: 'kk', name: 'Release ritual', count: 12, sessions: 8, days: 4 });
  const cards = deriveCards({ promptPatterns: { clusters: [c] }, promptBaselines: null, promptsByHost: null, insights: [], now: NOW });
  const { ledger, cards: out } = reconcile(ledgerOf([]), cards, { now: NOW, adoptionInputs: { currentPatterns: { promptPatterns: { clusters: [c] } } } });
  assert.equal(ledger.records.length, 1);
  assert.equal(ledger.records[0].status, 'proposed');
  assert.equal(ledger.records[0].baseline.count, 12);
  assert.equal(out[0].status, 'proposed');
  assert.equal(out[0].id, 'release-ritual-skill');
});

// Fix round 2, N-2: a card can fire from the WINDOWED evidence `deriveCards`
// saw (real, deterministic) while the CANONICAL 30d context genuinely cannot
// measure that id this pass (e.g. its own fingerprint layer is absent) —
// `currentEvidenceFor` correctly returns null for that. The baseline must
// record that absence honestly, never fabricate a `{count: 0}` that would
// misread as "measured, and it was zero".
test('N-2: a new record\'s baseline is null (not {count:0}) when the canonical evidence is unmeasurable', () => {
  const windowedCard = deriveCards({
    promptPatterns: { clusters: [cluster({ key: 'kk', name: 'Release ritual', count: 12, sessions: 8, days: 4 })] },
    promptBaselines: null, promptsByHost: null, insights: [], now: NOW,
  });
  // The canonical context has NO promptPatterns at all this pass — genuinely
  // unmeasurable, structurally distinct from "measured and found nothing".
  const { ledger } = reconcile(ledgerOf([]), windowedCard, {
    now: NOW, adoptionInputs: { currentPatterns: { promptPatterns: null } },
  });
  assert.equal(ledger.records[0].status, 'proposed');
  assert.equal(ledger.records[0].baseline, null, 'absent canonical evidence must never be written as a measured zero');
});

test('N-2: a null baseline is "not comparable" — no collapse-adoption, and measureOutcome reports honestly, never treating null as 0', () => {
  const card = deriveCards({
    promptPatterns: { clusters: [cluster({ key: 'kk', name: 'Release ritual', count: 12, sessions: 8, days: 4 })] },
    promptBaselines: null, promptsByHost: null, insights: [], now: NOW,
  }).find((c) => c.id === 'release-ritual-skill');

  // detectAdoption's collapse route: a null baseline must never look like "0
  // recorded at proposal", which numeric collapse math would treat as
  // "already collapsed to <= 20% of nothing" and adopt spuriously.
  const adoption = detectAdoption(card, {
    ledgerRecord: { baseline: null },
    currentPatterns: { promptPatterns: { clusters: [cluster({ key: 'kk', name: 'Release ritual', count: 1, sessions: 1, days: 1 })] } },
  });
  assert.deepEqual(adoption, { adopted: false, via: null }, 'a null baseline is not comparable, not "already at zero"');

  // measureOutcome on a record with a null baseline: honestly "not measured",
  // never Number(null) === 0 read as "improved from zero".
  const outcome = measureOutcome({ id: 'release-ritual-skill', baseline: null },
    { promptPatterns: { clusters: [cluster({ key: 'kk', name: 'Release ritual', count: 1, sessions: 1, days: 1 })] } });
  assert.equal(outcome.improved, false);
  assert.equal(outcome.deltaText, 'not measured this pass — evidence unavailable');
});

test('N-2: dismissedAtCount is null (not 0) when unmeasurable at dismissal, and a null reference never reads as "material"', () => {
  const cards = deriveCards({
    promptPatterns: { clusters: [cluster({ key: 'kk', name: 'Release ritual', count: 12, sessions: 8, days: 4 })] },
    promptBaselines: null, promptsByHost: null, insights: [], now: NOW,
  });
  // Dismissed while the canonical context cannot measure this id at all.
  const { ledger: dismissed } = dismissCard(ledgerOf([]), 'release-ritual-skill', cards, {
    now: NOW, adoptionInputs: { currentPatterns: { promptPatterns: null } },
  });
  assert.equal(dismissed.records[0].dismissedAtCount, null);

  // Evidence changes (hash moves) and a real canonical count NOW exists —
  // must NOT read a null dismissedAtCount as "was 0", which would make ANY
  // positive current count spuriously "material" and resurrect the card.
  const laterCards = deriveCards({
    promptPatterns: { clusters: [cluster({ key: 'kk', name: 'Release ritual', count: 30, sessions: 10, days: 5 })] },
    promptBaselines: null, promptsByHost: null, insights: [], now: NOW,
  });
  const { ledger } = reconcile(dismissed, laterCards, {
    now: NOW + DAY_MS,
    adoptionInputs: { currentPatterns: { promptPatterns: { clusters: [cluster({ key: 'kk', name: 'Release ritual', count: 30, sessions: 10, days: 5 })] } } },
  });
  assert.equal(ledger.records[0].status, 'dismissed', 'an unmeasurable dismissal-time reference must never resurrect the card on the next real count');
});

test('reconcile: proposed -> adopted (via CLAUDE.md) -> retired after OUTCOME_MIN_DAYS of no improvement', () => {
  const cardsFor = (count) => deriveCards({
    promptPatterns: { clusters: [cluster({ key: 'kk', name: 'Commit-and-push instruction', count, sessions: 6, days: 3 })] },
    promptBaselines: null, promptsByHost: null, insights: [], now: NOW,
  });
  const draftLine = cardsFor(10).find((c) => c.id === 'commit-push-claude-md').draft.text;

  // Pass 1: propose.
  let { ledger } = reconcile(ledgerOf([]), cardsFor(10), {
    now: NOW, adoptionInputs: { claudeMdTexts: [], currentPatterns: { promptPatterns: { clusters: [cluster({ key: 'kk', name: 'Commit-and-push instruction', count: 10, sessions: 6, days: 3 })] } } },
  });
  assert.equal(ledger.records[0].status, 'proposed');

  // Pass 2: the operator adds the draft line — adopts.
  const step2 = reconcile(ledger, cardsFor(10), {
    now: NOW + DAY_MS, adoptionInputs: { claudeMdTexts: [draftLine], currentPatterns: { promptPatterns: { clusters: [cluster({ key: 'kk', name: 'Commit-and-push instruction', count: 10, sessions: 6, days: 3 })] } } },
  });
  ledger = step2.ledger;
  assert.equal(ledger.records[0].status, 'adopted');
  assert.equal(ledger.records[0].baseline.count, 10, 'baseline re-anchors at the adoption moment');
  assert.equal(step2.cards[0].status, 'adopted');

  // Pass 3: still no improvement, but inside the 14-day patience window — stays adopted.
  const step3 = reconcile(ledger, cardsFor(11), {
    now: NOW + DAY_MS + 5 * DAY_MS, adoptionInputs: { claudeMdTexts: [draftLine], currentPatterns: { promptPatterns: { clusters: [cluster({ key: 'kk', name: 'Commit-and-push instruction', count: 11, sessions: 7, days: 4 })] } } },
  });
  ledger = step3.ledger;
  assert.equal(ledger.records[0].status, 'adopted');
  assert.equal(ledger.records[0].outcome.improved, false);

  // Pass 4: past OUTCOME_MIN_DAYS since adoption, still not improved — retires.
  const step4 = reconcile(ledger, cardsFor(11), {
    now: NOW + DAY_MS + (OUTCOME_MIN_DAYS + 1) * DAY_MS, adoptionInputs: { claudeMdTexts: [draftLine], currentPatterns: { promptPatterns: { clusters: [cluster({ key: 'kk', name: 'Commit-and-push instruction', count: 11, sessions: 7, days: 4 })] } } },
  });
  assert.equal(step4.ledger.records[0].status, 'retired');
  assert.equal(typeof step4.ledger.records[0].refutation, 'string');
  assert.match(step4.ledger.records[0].refutation, /^\d+ → \d+ since adoption$/);
  assert.equal(step4.cards[0].status, 'retired');
  assert.equal(step4.cards[0].refutation, step4.ledger.records[0].refutation);
});

function releaseRitualCardsAt(count, opts = {}) {
  return deriveCards({
    promptPatterns: { clusters: [cluster({ key: 'kk', name: 'Release ritual', count, sessions: 8, days: 4, ...opts })] },
    promptBaselines: null, promptsByHost: null, insights: [], now: NOW,
  });
}
function releaseRitualCurrentPatternsAt(count) {
  return { promptPatterns: { clusters: [cluster({ key: 'kk', name: 'Release ritual', count, sessions: 8, days: 4 })] } };
}

test('reconcile: dismissed stays suppressed while its evidenceHash is unchanged (never re-proposed)', () => {
  const c = cluster({ key: 'kk', name: 'Release ritual', count: 12, sessions: 8, days: 4 });
  const cards = deriveCards({ promptPatterns: { clusters: [c] }, promptBaselines: null, promptsByHost: null, insights: [], now: NOW });
  const { ledger: dismissed } = dismissCard(ledgerOf([]), 'release-ritual-skill', cards, {
    now: NOW, adoptionInputs: { currentPatterns: releaseRitualCurrentPatternsAt(12) },
  });
  assert.equal(dismissed.records[0].status, 'dismissed');
  assert.equal(dismissed.records[0].dismissCount, 1);
  assert.equal(dismissed.records[0].dismissedAtCount, 12);

  const { ledger, cards: out } = reconcile(dismissed, cards, { now: NOW + DAY_MS, adoptionInputs: {} });
  assert.equal(ledger.records[0].status, 'dismissed', 'unchanged evidence must not re-propose');
  assert.equal(out[0].status, 'dismissed');
});

// Fix round 1, I-1: re-proposal is gated on MATERIALITY (count moved >= 50% in
// the worsening direction since the count recorded at dismissal), not merely
// on the evidence hash changing. Any single additional occurrence changes the
// hash — gating on that alone meant a dismissal survived only until the very
// next occurrence of the habit it was about.
test('reconcile: dismiss, then the count ticks by one — still suppressed (I-1 pin)', () => {
  const { ledger: dismissed } = dismissCard(ledgerOf([]), 'release-ritual-skill', releaseRitualCardsAt(20), {
    now: NOW, adoptionInputs: { currentPatterns: releaseRitualCurrentPatternsAt(20) },
  });
  assert.equal(dismissed.records[0].dismissedAtCount, 20);

  const tickedCards = releaseRitualCardsAt(21);
  assert.notEqual(dismissed.records[0].evidenceHash, tickedCards[0].evidenceHash, 'sanity: one more occurrence DOES change the hash');
  const { ledger } = reconcile(dismissed, tickedCards, {
    now: NOW + DAY_MS, adoptionInputs: { currentPatterns: releaseRitualCurrentPatternsAt(21) },
  });
  assert.equal(ledger.records[0].status, 'dismissed', '20 -> 21 is a 5% move, well under the 50% materiality bar');
  assert.equal(ledger.records[0].evidenceHash, dismissed.records[0].evidenceHash,
    'the hash is left untouched on a non-material change, so materiality keeps measuring from the ORIGINAL dismissal-time count');
});

test('reconcile: dismissed record re-proposes once it worsens materially (>= 50% up from the dismissal-time count)', () => {
  const { ledger: dismissed } = dismissCard(ledgerOf([]), 'release-ritual-skill', releaseRitualCardsAt(20), {
    now: NOW, adoptionInputs: { currentPatterns: releaseRitualCurrentPatternsAt(20) },
  });

  // Just under the 50% bar: still suppressed.
  const almost = releaseRitualCardsAt(29); // (29-20)/20 = 45%
  const stillSuppressed = reconcile(dismissed, almost, {
    now: NOW + DAY_MS, adoptionInputs: { currentPatterns: releaseRitualCurrentPatternsAt(29) },
  });
  assert.equal(stillSuppressed.ledger.records[0].status, 'dismissed', '45% must not clear the 50% bar');

  // At/above the bar: re-proposes with a fresh baseline.
  const worsened = releaseRitualCardsAt(30); // (30-20)/20 = 50% exactly
  assert.equal(DISMISS_MATERIALITY_RATIO, 0.5);
  const step = reconcile(dismissed, worsened, {
    now: NOW + DAY_MS, adoptionInputs: { currentPatterns: releaseRitualCurrentPatternsAt(30) },
  });
  assert.equal(step.ledger.records[0].status, 'proposed');
  assert.equal(step.ledger.records[0].baseline.count, 30, 'the re-proposal freezes a FRESH baseline, not the old one');
  assert.equal(step.ledger.records[0].dismissedAtCount, undefined, 'the frozen dismissal-time reference is cleared on re-proposal');

  // A count that IMPROVED (moved down) since dismissal must not re-propose,
  // even by a large margin — "worsening direction" is required, not just "changed".
  const improved = releaseRitualCardsAt(2);
  const stillSuppressedOnImprovement = reconcile(dismissed, improved, {
    now: NOW + DAY_MS, adoptionInputs: { currentPatterns: releaseRitualCurrentPatternsAt(2) },
  });
  assert.equal(stillSuppressedOnImprovement.ledger.records[0].status, 'dismissed',
    'a count that DROPPED since dismissal is not a "worsening" and must not resurrect the card');
});

test('reconcile: a materially-worsened re-proposal, dismissed again, becomes permanent across further hash changes', () => {
  const { ledger: firstDismiss } = dismissCard(ledgerOf([]), 'release-ritual-skill', releaseRitualCardsAt(12), {
    now: NOW, adoptionInputs: { currentPatterns: releaseRitualCurrentPatternsAt(12) },
  });
  assert.equal(firstDismiss.records[0].dismissCount, 1);
  assert.equal(firstDismiss.records[0].dismissedAtCount, 12);

  // 12 -> 20 is a 66.7% worsening — clears the materiality bar, decay allows one re-propose.
  const step1 = reconcile(firstDismiss, releaseRitualCardsAt(20), {
    now: NOW + DAY_MS, adoptionInputs: { currentPatterns: releaseRitualCurrentPatternsAt(20) },
  });
  assert.equal(step1.ledger.records[0].status, 'proposed', 'a materially worsened count re-proposes once after one dismissal');
  assert.equal(step1.ledger.records[0].baseline.count, 20, 'the re-proposal freezes a fresh baseline');

  // Dismiss again — dismissCount reaches the permanent threshold.
  const { ledger: secondDismiss } = dismissCard(step1.ledger, 'release-ritual-skill', releaseRitualCardsAt(20), {
    now: NOW + DAY_MS, adoptionInputs: { currentPatterns: releaseRitualCurrentPatternsAt(20) },
  });
  assert.equal(secondDismiss.records[0].dismissCount, DISMISS_PERMANENT_THRESHOLD);
  assert.equal(secondDismiss.records[0].status, 'dismissed');

  // Evidence worsens materially AGAIN — must NOT re-propose this time (permanent).
  const step2 = reconcile(secondDismiss, releaseRitualCardsAt(40), {
    now: NOW + 2 * DAY_MS, adoptionInputs: { currentPatterns: releaseRitualCurrentPatternsAt(40) },
  });
  assert.equal(step2.ledger.records[0].status, 'dismissed', `>= ${DISMISS_PERMANENT_THRESHOLD} dismissals must suppress permanently across further material changes`);
});

test('reconcile: a proposed card whose evidence disappears this pass expires', () => {
  const c = cluster({ key: 'kk', name: 'Release ritual', count: 12, sessions: 8, days: 4 });
  const cards = deriveCards({ promptPatterns: { clusters: [c] }, promptBaselines: null, promptsByHost: null, insights: [], now: NOW });
  const { ledger } = reconcile(ledgerOf([]), cards, { now: NOW, adoptionInputs: {} });
  assert.equal(ledger.records[0].status, 'proposed');

  // Next pass: the cluster is gone — deriveCards produces no card for this id.
  const { ledger: next, cards: nextCards } = reconcile(ledger, [], { now: NOW + DAY_MS, adoptionInputs: {} });
  assert.equal(next.records[0].status, 'expired');
  assert.equal(nextCards.length, 0, 'an expired record with no live card renders no card');
});

// Fix round 1, C-2: the module's own docblock always promised this ("we lost
// the evidence" is not a verdict), but the code fell through to a permanent
// `expired` chip. Its own row in the transition matrix, re-supplying the card
// after one quiet pass.
test('reconcile: an expired record whose card fires again returns to proposed, keeping generatedAt and dismissCount, with a fresh baseline', () => {
  const cardsAt30 = releaseRitualCardsAt(30);
  let { ledger } = reconcile(ledgerOf([]), cardsAt30, {
    now: NOW, adoptionInputs: { currentPatterns: releaseRitualCurrentPatternsAt(30) },
  });
  const originalGeneratedAt = ledger.records[0].generatedAt;
  assert.equal(ledger.records[0].status, 'proposed');

  // Quiet pass: no card fires — expires.
  ({ ledger } = reconcile(ledger, [], { now: NOW + DAY_MS, adoptionInputs: {} }));
  assert.equal(ledger.records[0].status, 'expired');
  assert.equal(ledger.records[0].generatedAt, originalGeneratedAt, 'expiry must not touch the as-of stamp');

  // The pattern fires again, at DOUBLE its original strength — re-supply.
  const cardsAt60 = releaseRitualCardsAt(60);
  const resupply = reconcile(ledger, cardsAt60, {
    now: NOW + 5 * DAY_MS, adoptionInputs: { currentPatterns: releaseRitualCurrentPatternsAt(60) },
  });
  assert.equal(resupply.ledger.records[0].status, 'proposed', 'an expired record must resurrect, not stay stuck at "evidence no longer present"');
  assert.equal(resupply.ledger.records[0].generatedAt, originalGeneratedAt, 'generatedAt is the ORIGINAL proposal stamp, never overwritten by a re-supply');
  assert.equal(resupply.ledger.records[0].baseline.count, 60, 'the baseline is FRESH at re-supply, not the pre-expiry one');
  assert.equal(resupply.ledger.records[0].evidenceHash, cardsAt60[0].evidenceHash);
  assert.equal(resupply.cards[0].status, 'proposed');
});

test('reconcile: an expired record with a prior dismissCount keeps it across re-supply', () => {
  const { ledger: dismissed } = dismissCard(ledgerOf([]), 'release-ritual-skill', releaseRitualCardsAt(20), {
    now: NOW, adoptionInputs: { currentPatterns: releaseRitualCurrentPatternsAt(20) },
  });
  // Materially worsens (20 -> 35, 75%) -> re-proposes once (I-1), then goes quiet -> expires.
  let { ledger } = reconcile(dismissed, releaseRitualCardsAt(35), {
    now: NOW + DAY_MS, adoptionInputs: { currentPatterns: releaseRitualCurrentPatternsAt(35) },
  });
  assert.equal(ledger.records[0].status, 'proposed');
  ({ ledger } = reconcile(ledger, [], { now: NOW + 2 * DAY_MS, adoptionInputs: {} }));
  assert.equal(ledger.records[0].status, 'expired');
  assert.equal(ledger.records[0].dismissCount, 1);

  const resupply = reconcile(ledger, releaseRitualCardsAt(50), {
    now: NOW + 3 * DAY_MS, adoptionInputs: { currentPatterns: releaseRitualCurrentPatternsAt(50) },
  });
  assert.equal(resupply.ledger.records[0].status, 'proposed');
  assert.equal(resupply.ledger.records[0].dismissCount, 1, 'prior dismissal history survives a re-supply');
});

test('reconcile: an adopted or dismissed record is untouched by evidence disappearing (expiry only applies to proposed)', () => {
  const c = cluster({ key: 'kk', name: 'Release ritual', count: 12, sessions: 8, days: 4 });
  const cards = deriveCards({ promptPatterns: { clusters: [c] }, promptBaselines: null, promptsByHost: null, insights: [], now: NOW });
  const { ledger: dismissed } = dismissCard(ledgerOf([]), 'release-ritual-skill', cards, { now: NOW });
  const { ledger: next } = reconcile(dismissed, [], { now: NOW + DAY_MS, adoptionInputs: {} });
  assert.equal(next.records[0].status, 'dismissed', 'expiry is defined only for proposed records');
});

// ── C-1: the canonical window (ledger-facing evidence is never the displayed
// window) ────────────────────────────────────────────────────────────────────
//
// Re-run of the review's own C-1 repro: a corpus whose behaviour is perfectly
// CONSTANT (the operator changes nothing), observed at three different
// windows. Before this fix, switching --window alone fabricated an adoption,
// an outcome delta, and — 14 days later — a permanent retirement verdict,
// none of it backed by anything the operator did. After it, ledger-facing
// reads always come from the SAME canonical evidence regardless of which
// window's cards are being displayed, so none of that is possible.

test('C-1 repro: switching the displayed window alone can no longer fabricate an adoption', () => {
  // The "operator changes nothing" corpus: a steady cluster whose count is
  // proportional to the window (all/30d/7d), exactly like the review's
  // one-commit-and-push-every-1.25-days-for-60-days scenario. `cardsAtWindow`
  // stands in for what --window N would derive for DISPLAY; `canonical`
  // stands in for the fixed 30d read the ledger must use regardless.
  const cardsAtWindow = (count) => deriveCards({
    promptPatterns: { clusters: [cluster({ key: 'kk', name: 'Release ritual', count, sessions: count, days: count })] },
    promptBaselines: null, promptsByHost: null, insights: [], now: NOW,
  });
  const canonicalAt = (count) => ({ promptPatterns: { clusters: [cluster({ key: 'kk', name: 'Release ritual', count, sessions: count, days: count })] } });

  // Run 1: all-history window derives the card; proposed against the SAME
  // canonical (30d) count, per this fixture's constant-rate corpus, 42.
  const allWindowCards = cardsAtWindow(42);
  const { ledger } = reconcile(ledgerOf([]), allWindowCards, {
    now: NOW, adoptionInputs: { currentPatterns: canonicalAt(42) },
  });
  assert.equal(ledger.records[0].status, 'proposed');
  assert.equal(ledger.records[0].baseline.count, 42, 'the baseline is the CANONICAL count, not whatever the displayed window showed');

  // Run 2: the operator switches to --window 7 (nothing else changes). The
  // DISPLAYED card now derives from a 7-day slice (count 6), but the ledger
  // read is STILL pinned to the canonical 30d count (42) — so 6-of-42 never
  // even enters the collapse comparison.
  const sevenDayCards = cardsAtWindow(6);
  const step2 = reconcile(ledger, sevenDayCards, {
    now: NOW + DAY_MS, adoptionInputs: { currentPatterns: canonicalAt(42) },
  });
  assert.equal(step2.ledger.records[0].status, 'proposed',
    'a --window switch alone must never fabricate an adoption — the canonical count (42) never collapsed');
  assert.equal(step2.cards[0].basis, sevenDayCards[0].basis,
    'the RENDERED basis still honors the operator\'s window (spec: display stays windowed) — 7 recurrences, not 42');
  assert.notEqual(step2.cards[0].basis, allWindowCards[0].basis, 'sanity: the two windows really do render different basis text');

  // Run 3: back to the default window. Still proposed — no fabricated
  // "adopted"/outcome ever entered the ledger.
  const step3 = reconcile(step2.ledger, allWindowCards, {
    now: NOW + 2 * DAY_MS, adoptionInputs: { currentPatterns: canonicalAt(42) },
  });
  assert.equal(step3.ledger.records[0].status, 'proposed');
  assert.equal(step3.ledger.records[0].outcome, undefined, 'no outcome was ever measured, because no adoption was ever fabricated');
});

test('C-1: a new record\'s windowDays is always CANONICAL_WINDOW_DAYS, regardless of the cards\' own window', () => {
  assert.equal(CANONICAL_WINDOW_DAYS, 30);
  const cards = releaseRitualCardsAt(9); // a card that would fire at, say, --window 7 too
  const { ledger } = reconcile(ledgerOf([]), cards, {
    now: NOW, adoptionInputs: { currentPatterns: releaseRitualCurrentPatternsAt(9) },
  });
  assert.equal(ledger.records[0].windowDays, CANONICAL_WINDOW_DAYS);
});

test('C-1: a record loaded without windowDays (pre-fix shape) is discarded — treated as though it never existed', () => {
  const legacyRecord = {
    id: 'release-ritual-skill', evidenceHash: 'x'.repeat(16), status: 'dismissed',
    generatedAt: new Date(NOW).toISOString(), statusAt: new Date(NOW).toISOString(),
    baseline: { count: 999 }, dismissCount: 2,
    // no windowDays — the pre-Fix-round-1 shape.
  };
  const cards = releaseRitualCardsAt(9);
  const { ledger } = reconcile(ledgerOf([legacyRecord]), cards, {
    now: NOW, adoptionInputs: { currentPatterns: releaseRitualCurrentPatternsAt(9) },
  });
  assert.equal(ledger.records.length, 1);
  assert.equal(ledger.records[0].status, 'proposed', 'a windowDays-less record is discarded, so the card proposes fresh, not "still dismissed"');
  assert.equal(ledger.records[0].windowDays, CANONICAL_WINDOW_DAYS);
});

test('I-5 (optional clamp): a record with a status outside the five-value enum is discarded on load', () => {
  const corruptRecord = {
    id: 'release-ritual-skill', evidenceHash: 'x'.repeat(16), status: '<img src=x onerror=alert(1)>',
    generatedAt: new Date(NOW).toISOString(), statusAt: new Date(NOW).toISOString(),
    baseline: { count: 999 }, windowDays: CANONICAL_WINDOW_DAYS,
  };
  const cards = releaseRitualCardsAt(9);
  const { ledger } = reconcile(ledgerOf([corruptRecord]), cards, {
    now: NOW, adoptionInputs: { currentPatterns: releaseRitualCurrentPatternsAt(9) },
  });
  assert.equal(ledger.records.length, 1);
  assert.equal(ledger.records[0].status, 'proposed', 'an invalid status is discarded, not carried through to the DOM');
});

// ── version field ────────────────────────────────────────────────────────────

test('a fresh/missing ledger loads at the current schema version with zero records', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-ledger-'));
  const file = path.join(dir, 'usage-outcome-ledger.json');
  const ledger = loadLedger(file);
  assert.deepEqual(ledger, { version: LEDGER_SCHEMA_VERSION, records: [] });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('defaultLedgerPath sits beside the usage-index cache path convention (same config dir, its own file name)', () => {
  const p = defaultLedgerPath();
  assert.equal(path.basename(p), 'usage-outcome-ledger.json');
  assert.equal(path.basename(path.dirname(p)), 'agentic-kit');
});

// Fix round 1, I-2: spec §10 requires dismissal persistence to survive
// "rescans AND SCHEMA BUMPS" — an older `ak` reading a NEWER, well-formed
// ledger must not silently destroy it (that would resurrect every dismissed
// card the newer build had suppressed). A CORRUPT/unparseable file is a
// different case and stays safe to replace.
test('loadLedger reports a well-formed FUTURE version distinctly from a corrupt one, and never destroys it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-ledger-'));
  const file = path.join(dir, 'usage-outcome-ledger.json');

  // A newer ak wrote v2 with a dismissed record.
  const futureLedger = {
    version: 2, records: [{ id: 'release-ritual-skill', evidenceHash: 'a'.repeat(16), status: 'dismissed', dismissCount: 3 }],
  };
  fs.writeFileSync(file, JSON.stringify(futureLedger));
  const loaded = loadLedger(file);
  assert.equal(loaded.future, true);
  assert.equal(loaded.version, 2);
  assert.deepEqual(loaded.records, futureLedger.records, 'the future records must be reported, not discarded');

  // The file on disk is untouched by the mere act of loading it.
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), futureLedger);

  // A corrupt file (same directory, different name) is NOT a future version —
  // it reads as blank, which is safe to overwrite (nothing recoverable).
  const corruptFile = path.join(dir, 'corrupt.json');
  fs.writeFileSync(corruptFile, '{not valid json');
  const corruptLoaded = loadLedger(corruptFile);
  assert.equal(corruptLoaded.future, undefined);
  assert.deepEqual(corruptLoaded, { version: LEDGER_SCHEMA_VERSION, records: [] });

  fs.rmSync(dir, { recursive: true, force: true });
});

test('loadLedger reads the CURRENT version normally, with no future flag', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-ledger-'));
  const file = path.join(dir, 'usage-outcome-ledger.json');
  fs.writeFileSync(file, JSON.stringify({ version: LEDGER_SCHEMA_VERSION, records: [] }));
  const loaded = loadLedger(file);
  assert.equal(loaded.future, undefined);
  assert.equal(loaded.version, LEDGER_SCHEMA_VERSION);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── atomic save (tmp+rename observable) ─────────────────────────────────────

test('saveLedger writes atomically: the final file is valid JSON at the right version, and no tmp file is left behind', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-ledger-'));
  const file = path.join(dir, 'usage-outcome-ledger.json');
  const ledger = { version: LEDGER_SCHEMA_VERSION, records: [{ id: 'x', evidenceHash: 'a'.repeat(16), status: 'proposed', generatedAt: new Date(NOW).toISOString(), statusAt: new Date(NOW).toISOString(), baseline: { count: 3 } }] };
  saveLedger(file, ledger);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), ledger);
  const leftovers = fs.readdirSync(dir).filter((n) => n.includes('.tmp'));
  assert.deepEqual(leftovers, [], 'a stray .tmp file means rename did not clean up after itself');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('saveLedger overwrites a prior version cleanly (round-trips through loadLedger)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-ledger-'));
  const file = path.join(dir, 'usage-outcome-ledger.json');
  saveLedger(file, { version: LEDGER_SCHEMA_VERSION, records: [] });
  saveLedger(file, { version: LEDGER_SCHEMA_VERSION, records: [{ id: 'y', evidenceHash: 'b'.repeat(16), status: 'dismissed', generatedAt: new Date(NOW).toISOString(), statusAt: new Date(NOW).toISOString(), baseline: { count: 1 }, dismissCount: 1 }] });
  const back = loadLedger(file);
  assert.equal(back.records.length, 1);
  assert.equal(back.records[0].id, 'y');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── summarizeLedger ──────────────────────────────────────────────────────────

test('summarizeLedger counts every status over the whole ledger, including ids with no live card', () => {
  const summary = summarizeLedger([
    { id: 'a', status: 'proposed' }, { id: 'b', status: 'adopted' },
    { id: 'c', status: 'dismissed' }, { id: 'd', status: 'expired' }, { id: 'e', status: 'retired' },
    { id: 'f', status: 'adopted' },
  ]);
  assert.deepEqual(summary, { proposed: 1, adopted: 2, dismissed: 1, expired: 1, retired: 1 });
});

// ── gatherAdoptionInputs ─────────────────────────────────────────────────────

test('gatherAdoptionInputs reads CLAUDE.md/CLAUDE.local.md text and .claude/skills dir names, honestly empty when absent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-adopt-'));
  const empty = gatherAdoptionInputs(dir);
  assert.deepEqual(empty, { claudeMdTexts: [], skillDirs: [] });

  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# CLAUDE.md\n- a line\n');
  fs.mkdirSync(path.join(dir, '.claude', 'skills', 'release-ritual'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'skills', 'release-ritual', 'SKILL.md'), 'skeleton');
  const filled = gatherAdoptionInputs(dir);
  assert.deepEqual(filled.claudeMdTexts, ['# CLAUDE.md\n- a line\n']);
  assert.deepEqual(filled.skillDirs, ['release-ritual']);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── no-prompt-text invariant, walked structurally ───────────────────────────

const PLANTED_TEXT = 'PLANTED-PROMPT-TEXT-MUST-NEVER-REACH-THE-LEDGER-xyzzy';

function allStrings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) allStrings(v, out);
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) { out.push(k); allStrings(v, out); }
  return out;
}

test('no ledger field, at any depth, ever carries prompt text — walked structurally after a full propose/adopt/retire cycle', () => {
  // A cluster whose LABEL happens to be a seed name (never planted text) plus
  // a synthetic promptPatterns/promptsByHost/insights set that exercises every
  // rule, then run it through the full ledger lifecycle. If PLANTED_TEXT were
  // ever threaded through evidence, a card, or a ledger record, it would show
  // up here — it appears nowhere in any of the fixtures below, which is the
  // point: nothing downstream of a "prompt" can legitimately produce it.
  const c = cluster({ key: 'kk', name: 'Commit-and-push instruction', count: 12, sessions: 8, days: 4 });
  const byHost = {
    codex: hostRow({ personaOpeners: 15, p90TypedTokens: 300, taps: 25 }),
    claude: hostRow({ personaOpeners: 1, p90TypedTokens: 40, taps: 25 }),
  };
  const insights = [insight('host-prompt-asymmetry'), insight('supervision-tap-share')];
  const cards = deriveCards({ promptPatterns: { clusters: [c], reAsks: { pairCount: 15, sessionCount: 9 } }, promptBaselines: null, promptsByHost: byHost, insights, now: NOW });
  const currentPatterns = { promptPatterns: { clusters: [c], reAsks: { pairCount: 15, sessionCount: 9 } }, promptsByHost: byHost, insights };

  let ledger = ledgerOf([]);
  ({ ledger } = reconcile(ledger, cards, { now: NOW, adoptionInputs: { currentPatterns } }));
  ({ ledger } = dismissCard(ledger, cards.find((x) => x.id === 'reask-delta').id, cards, { adoptionInputs: { currentPatterns }, now: NOW }));
  ({ ledger } = reconcile(ledger, cards, { now: NOW + OUTCOME_MIN_DAYS * DAY_MS, adoptionInputs: { skillDirs: ['release-ritual'], currentPatterns } }));

  const strings = allStrings(ledger);
  for (const s of strings) assert.doesNotMatch(s, new RegExp(PLANTED_TEXT), `found planted text in ledger: ${s}`);
  // Positive control: every string is one of the fixed shapes a ledger record
  // is allowed to carry, never free text off a card's finding/basis/try/draft.
  const CARD_IDS = /^(release-ritual-skill|commit-push-claude-md|reask-delta|codex-completion-criteria|progress-report-taps|codex-role-library)$/;
  for (const s of strings) {
    const ok = /^(version|records|id|evidenceHash|status|generatedAt|statusAt|baseline|outcome|refutation|dismissCount|dismissedAtCount|windowDays|count|clusterKey|sessions|days|sessionCount|otherCount|host|otherHost|hosts|comparator|p90Host|p90Other|improved|deltaText|measuredAt)$/.test(s)
      || /^(proposed|adopted|dismissed|expired|retired)$/.test(s)
      || /^(baseline|floor|mixed)$/.test(s) // progress-report-taps' comparator enum
      || CARD_IDS.test(s)
      || /^[0-9a-f]{16}$/.test(s)
      || /^\d{4}-\d{2}-\d{2}T.*Z$/.test(s)
      || /^\d+ → \d+ since adoption$/.test(s)
      || s === 'not measured this pass — evidence unavailable'
      || s === 'kk' || s === 'claude' || s === 'codex' || s === null;
    assert.ok(ok, `unexpected string shape in ledger (possible text leak): ${JSON.stringify(s)}`);
  }
});

// ── INTEGRATION REGRESSION PIN: aggregate -> deriveCards -> reconcile -> CLI render, through the REAL producer ──

function commitPushSession(id, at, day, text) {
  const rec = blankSession(id, 'claude');
  Object.assign(rec, { title: id, project: 'proj', prompts: 1, responses: 1, start: at - 60_000, end: at });
  rec.active = [[at - 60_000, at]];
  addUsage(rec, day, 'claude-opus-5', { input: 50, output: 20, cacheRead: 0, cacheWrite: 0, responses: 1 });
  rec.models = ['claude-opus-5'];
  rec.lenSeconds = 60;
  notePromptFingerprint(rec, text, 'prompt');
  return rec;
}

test('INTEGRATION: aggregate(records, {prompts:true}) -> deriveCards -> reconcile -> CLI coaching section, through the real producer', async () => {
  const COMMIT_PUSH_PHRASINGS = [
    'Commit and push', 'Commit push', 'Please commit and push', 'Commit and push now',
    'Commit and push it', 'Commit and push please',
  ];
  const day = (n) => {
    const d = new Date(NOW - n * DAY_MS);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  };
  const records = COMMIT_PUSH_PHRASINGS.map((text, i) => {
    const at = NOW - (i % 3) * DAY_MS - 3_600_000;
    return commitPushSession(`icp-${i}`, at, day(i % 3), text);
  });

  const deps = {
    costOf: ({ input = 0, output = 0, cacheRead = 0, cacheWrite = 0 }) => (input + output + cacheRead + cacheWrite) / 1000,
    pricesAsOf: '2026-08-01',
    classify: () => ({ category: 'Unclassified', confidence: 0, basis: 'no signal' }),
    detectInsights: () => [],
  };
  const agg = aggregate(records, { days: 30, now: NOW, cutoff: NOW - 30 * DAY_MS, prompts: true, deps });
  assert.ok(agg.promptPatterns, 'the real producer must build the promptPatterns projection');
  const commitCluster = agg.promptPatterns.clusters.find((c) => c.label?.name === 'Commit-and-push instruction');
  assert.ok(commitCluster, `expected the real clustering pipeline to seed-match a commit-and-push cluster from ${JSON.stringify(agg.promptPatterns.clusters)}`);

  const cards = deriveCards({
    promptPatterns: agg.promptPatterns, promptBaselines: agg.promptBaselines,
    promptsByHost: agg.promptsByHost, insights: agg.insights, now: NOW,
  });
  const card = cards.find((c) => c.id === 'commit-push-claude-md');
  assert.ok(card, 'the real aggregate must drive the commit-push-claude-md card end to end');

  const currentPatterns = { promptPatterns: agg.promptPatterns, promptsByHost: agg.promptsByHost, insights: agg.insights };
  const { cards: annotated } = reconcile(ledgerOf([]), cards, { now: NOW, adoptionInputs: { currentPatterns } });
  const annotatedCard = annotated.find((c) => c.id === 'commit-push-claude-md');
  assert.equal(annotatedCard.status, 'proposed');

  // Render through the REAL CLI section renderer, not a hand-rolled string.
  const { __test } = await import('../../src/commands/usage.mjs');
  const lines = [];
  const orig = console.log;
  console.log = (s) => lines.push(String(s));
  try {
    __test.printCoaching({ cards: annotated, summary: { proposed: 1, adopted: 0, dismissed: 0, expired: 0, retired: 0 } });
  } finally {
    console.log = orig;
  }
  const out = lines.join('\n');
  assert.match(out, /Coaching/);
  assert.match(out, /Commit-and-push is retyped, not remembered/);
  assert.match(out, /proposed/);
  // Fix round 1, M-1: the rendered ledger-summary line actually renders (the
  // pin used to call printCoaching with the wrong key, making this a no-op).
  assert.match(out, /ledger — 1 proposed · 0 adopted · 0 dismissed · 0 expired · 0 retired/);
  // Fix round 1, M-3: generatedAt + the evidence hash's first 8 chars render
  // as a trailing line on every card.
  assert.match(out, new RegExp(`as of ${annotatedCard.generatedAt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} · ${annotatedCard.evidenceHash.slice(0, 8)}`));
  // Privacy pin: none of the six typed phrasings reached the rendered section.
  for (const p of COMMIT_PUSH_PHRASINGS) assert.equal(out.includes(p), false, `prompt text "${p}" leaked into the rendered coaching section`);
});
