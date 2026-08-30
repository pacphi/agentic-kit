import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  evidenceHash, deriveCards, detectAdoption, measureOutcome, currentEvidenceFor,
  RELEASE_RITUAL_MIN_COUNT, COMMIT_PUSH_MIN_COUNT, REASK_DELTA_MIN_PAIRS, PERSONA_LIBRARY_MIN_COUNT,
  OUTCOME_MIN_DAYS, DAY_MS,
} from '../../src/lib/usage-coaching.mjs';
import {
  loadLedger, saveLedger, reconcile, dismissCard, summarizeLedger, defaultLedgerPath,
  gatherAdoptionInputs, LEDGER_SCHEMA_VERSION, DISMISS_PERMANENT_THRESHOLD,
} from '../../src/lib/usage-outcome-ledger.mjs';
import { aggregate } from '../../src/lib/usage-aggregate.mjs';
import { blankSession, addUsage, notePromptFingerprint } from '../../src/lib/usage-parsers.mjs';
import { heading, info, dim } from '../../src/lib/output.mjs';

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

test('progress-report-taps fires exactly when supervision-tap-share is present, regardless of magnitude', () => {
  const byHost = { claude: hostRow({ taps: 3 }) };
  const withInsight = deriveCards({
    promptPatterns: null, promptBaselines: null, promptsByHost: byHost,
    insights: [insight('supervision-tap-share', { finding: 'taps are 40% of what you type on claude' })], now: NOW,
  });
  const card = withInsight.find((c) => c.id === 'progress-report-taps');
  assert.ok(card);
  assert.equal(card.draft, undefined);
  assert.match(card.basis, /taps are 40% of what you type on claude/, 'basis reuses the detector\'s own evidence-honest sentence');
  const withoutInsight = deriveCards({
    promptPatterns: null, promptBaselines: null, promptsByHost: byHost, insights: [], now: NOW,
  });
  assert.equal(withoutInsight.find((c) => c.id === 'progress-report-taps'), undefined);
});

test('codex-role-library fires at personaOpeners >= 10 on the leading host, not below', () => {
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
  assert.equal(miss.find((c) => c.id === 'codex-role-library'), undefined);
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
  // An empty (but present) promptsByHost is measured-zero: codex-completion-criteria
  // still cannot fire (needs both host rows), progress-report-taps CAN because it
  // only needs the insight plus a (possibly empty) promptsByHost to sum over.
  const empty = deriveCards({ promptPatterns: null, promptBaselines: null, promptsByHost: {}, insights, now: NOW });
  assert.equal(empty.find((c) => c.id === 'codex-completion-criteria'), undefined);
  assert.ok(empty.find((c) => c.id === 'progress-report-taps'), 'an empty but present promptsByHost is a real zero, not an absence');
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

test('reconcile: dismissed stays suppressed while its evidenceHash is unchanged (never re-proposed)', () => {
  const c = cluster({ key: 'kk', name: 'Release ritual', count: 12, sessions: 8, days: 4 });
  const cards = deriveCards({ promptPatterns: { clusters: [c] }, promptBaselines: null, promptsByHost: null, insights: [], now: NOW });
  const { ledger: dismissed } = dismissCard(ledgerOf([]), 'release-ritual-skill', cards, NOW);
  assert.equal(dismissed.records[0].status, 'dismissed');
  assert.equal(dismissed.records[0].dismissCount, 1);

  const { ledger, cards: out } = reconcile(dismissed, cards, { now: NOW + DAY_MS, adoptionInputs: {} });
  assert.equal(ledger.records[0].status, 'dismissed', 'unchanged evidence must not re-propose');
  assert.equal(out[0].status, 'dismissed');
});

test('reconcile: dismissed + changed evidence hash re-proposes exactly once, then a second dismissal makes it permanent', () => {
  const cardsAt = (count) => deriveCards({
    promptPatterns: { clusters: [cluster({ key: 'kk', name: 'Release ritual', count, sessions: 8, days: 4 })] },
    promptBaselines: null, promptsByHost: null, insights: [], now: NOW,
  });
  const { ledger: firstDismiss } = dismissCard(ledgerOf([]), 'release-ritual-skill', cardsAt(12), NOW);
  assert.equal(firstDismiss.records[0].dismissCount, 1);

  // Evidence changes (count 12 -> 20 changes the hash) — decay allows one re-propose.
  const changedCards = cardsAt(20);
  const step1 = reconcile(firstDismiss, changedCards, { now: NOW + DAY_MS, adoptionInputs: { currentPatterns: { promptPatterns: { clusters: [cluster({ key: 'kk', name: 'Release ritual', count: 20, sessions: 8, days: 4 })] } } } });
  assert.equal(step1.ledger.records[0].status, 'proposed', 'a changed hash re-proposes once after one dismissal');
  assert.equal(step1.ledger.records[0].baseline.count, 20, 'the re-proposal freezes a fresh baseline');

  // Dismiss again — dismissCount reaches the permanent threshold.
  const { ledger: secondDismiss } = dismissCard(step1.ledger, 'release-ritual-skill', changedCards, NOW + DAY_MS);
  assert.equal(secondDismiss.records[0].dismissCount, DISMISS_PERMANENT_THRESHOLD);
  assert.equal(secondDismiss.records[0].status, 'dismissed');

  // Evidence changes AGAIN — must NOT re-propose this time (permanent).
  const step2 = reconcile(secondDismiss, cardsAt(30), { now: NOW + 2 * DAY_MS, adoptionInputs: {} });
  assert.equal(step2.ledger.records[0].status, 'dismissed', `>= ${DISMISS_PERMANENT_THRESHOLD} dismissals must suppress permanently across further hash changes`);
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

test('reconcile: an adopted or dismissed record is untouched by evidence disappearing (expiry only applies to proposed)', () => {
  const c = cluster({ key: 'kk', name: 'Release ritual', count: 12, sessions: 8, days: 4 });
  const cards = deriveCards({ promptPatterns: { clusters: [c] }, promptBaselines: null, promptsByHost: null, insights: [], now: NOW });
  const { ledger: dismissed } = dismissCard(ledgerOf([]), 'release-ritual-skill', cards, NOW);
  const { ledger: next } = reconcile(dismissed, [], { now: NOW + DAY_MS, adoptionInputs: {} });
  assert.equal(next.records[0].status, 'dismissed', 'expiry is defined only for proposed records');
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
  const byHost = { codex: hostRow({ personaOpeners: 15, p90TypedTokens: 300 }), claude: hostRow({ personaOpeners: 1, p90TypedTokens: 40 }) };
  const insights = [insight('host-prompt-asymmetry'), insight('supervision-tap-share')];
  const cards = deriveCards({ promptPatterns: { clusters: [c], reAsks: { pairCount: 15, sessionCount: 9 } }, promptBaselines: null, promptsByHost: byHost, insights, now: NOW });
  const currentPatterns = { promptPatterns: { clusters: [c], reAsks: { pairCount: 15, sessionCount: 9 } }, promptsByHost: byHost, insights };

  let ledger = ledgerOf([]);
  ({ ledger } = reconcile(ledger, cards, { now: NOW, adoptionInputs: { currentPatterns } }));
  ({ ledger } = dismissCard(ledger, cards.find((x) => x.id === 'reask-delta').id, cards, NOW));
  ({ ledger } = reconcile(ledger, cards, { now: NOW + OUTCOME_MIN_DAYS * DAY_MS, adoptionInputs: { skillDirs: ['release-ritual'], currentPatterns } }));

  const strings = allStrings(ledger);
  for (const s of strings) assert.doesNotMatch(s, new RegExp(PLANTED_TEXT), `found planted text in ledger: ${s}`);
  // Positive control: every string is one of the fixed shapes a ledger record
  // is allowed to carry, never free text off a card's finding/basis/try/draft.
  const CARD_IDS = /^(release-ritual-skill|commit-push-claude-md|reask-delta|codex-completion-criteria|progress-report-taps|codex-role-library)$/;
  for (const s of strings) {
    const ok = /^(version|records|id|evidenceHash|status|generatedAt|statusAt|baseline|outcome|refutation|dismissCount|count|clusterKey|sessions|days|sessionCount|otherCount|host|otherHost|p90Host|p90Other|insightFinding|improved|deltaText|measuredAt)$/.test(s)
      || /^(proposed|adopted|dismissed|expired|retired)$/.test(s)
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
  // Privacy pin: none of the six typed phrasings reached the rendered section.
  for (const p of COMMIT_PUSH_PHRASINGS) assert.equal(out.includes(p), false, `prompt text "${p}" leaked into the rendered coaching section`);
});
