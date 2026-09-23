import { test } from 'node:test';
import assert from 'node:assert/strict';
import { componentSnapshot } from '../../src/lib/ruflo-components/snapshot.mjs';

const now = Date.parse('2026-09-23T12:00:00Z');
const cfg = { rufloComponents: { typesafePicker: true, minilmPicker: true, mcpGovernance: { maxCallsPerMinute: 120 },
  learningProfile: 'balanced', turnCredit: true, memoryFix2887: true, funnel: false } };
const evidence = (over = {}) => ({
  capturedAt: new Date(now - 60_000).toISOString(), rufloVersion: '3.44.0',
  typesafe: { resolves: true, doctor: { status: 'pass', name: '@ruvector/typesafe router', detail: 'installed; enabled' } },
  minilm: { embedder: 'minilm' },
  learning: { mode: 'balanced', engineLoaded: false, lastTrainingSeconds: 170300, trajectories: 13649 },
  turnCredit: { present: true }, memoryFix: { version: '3.0.0-alpha.25' },
  funnel: { enabled: false, decidedBy: 'user' }, governance: { audit: { audited: 10, refused: 0, reasons: [] } },
  errors: {}, ...over });
const projection = (over = {}) => ({ claude: { conflicts: [], changed: false }, missingHosts: [], policy: 'valid', ...over });
const byId = (snap, id) => snap.components.find((c) => c.id === id);

test('everything confirmed is active and the summary counts it', () => {
  const snap = componentSnapshot({ cfg, rufloVersion: '3.44.0', evidence: evidence(), projection: projection(), now });
  for (const id of ['typesafePicker', 'minilmPicker', 'mcpGovernance', 'learningProfile', 'turnCredit', 'memoryFix2887', 'funnel']) {
    assert.equal(byId(snap, id).state.id, 'active', id);
  }
  assert.deepEqual(snap.summary, { active: 7, total: 8 });
});

test('old ruflo reports needs-ruflo with the version in the label', () => {
  const snap = componentSnapshot({ cfg, rufloVersion: '3.43.0', evidence: evidence({ minilm: { embedder: 'hash' } }), projection: projection(), now });
  assert.equal(byId(snap, 'minilmPicker').state.label, 'needs ruflo ≥ 3.44.0');
});

test('opted-out component is user-managed with its meaning', () => {
  const snap = componentSnapshot({ cfg: { rufloComponents: { ...cfg.rufloComponents, minilmPicker: false } },
    rufloVersion: '3.44.0', evidence: evidence(), projection: projection(), now });
  assert.equal(byId(snap, 'minilmPicker').state.id, 'user-managed');
  assert.match(byId(snap, 'minilmPicker').state.meaning, /leaves it alone/);
});

test('a preserved conflicting value is user-managed, not drifted', () => {
  const snap = componentSnapshot({ cfg, rufloVersion: '3.44.0', evidence: evidence({ learning: { mode: 'research', engineLoaded: false } }),
    projection: projection({ claude: { conflicts: ['RUFLO_INTELLIGENCE_MODE'], changed: false } }), now });
  assert.equal(byId(snap, 'learningProfile').state.id, 'user-managed');
});

test('applied but evidence disagrees → applied-unverified', () => {
  const snap = componentSnapshot({ cfg, rufloVersion: '3.44.0', evidence: evidence({ minilm: { embedder: 'hash' } }), projection: projection(), now });
  assert.equal(byId(snap, 'minilmPicker').state.id, 'applied-unverified');
});

test('stale or missing evidence is unknown, never active', () => {
  const stale = componentSnapshot({ cfg, rufloVersion: '3.44.0', evidence: evidence({ capturedAt: new Date(now - 48 * 3600_000).toISOString() }),
    projection: projection(), now });
  assert.equal(byId(stale, 'typesafePicker').state.id, 'unknown');
  const none = componentSnapshot({ cfg, rufloVersion: '3.44.0', evidence: null, projection: projection(), now });
  assert.equal(byId(none, 'turnCredit').state.id, 'unknown');
});

test('governance with an invalid policy is blocked with the lockout reason', () => {
  const snap = componentSnapshot({ cfg, rufloVersion: '3.44.0', evidence: evidence(), projection: projection({ policy: 'invalid' }), now });
  assert.equal(byId(snap, 'mcpGovernance').state.id, 'blocked');
  assert.match(byId(snap, 'mcpGovernance').state.meaning, /refuse every tool call/);
});

test('missing hosts make a component partial and name them', () => {
  const snap = componentSnapshot({ cfg, rufloVersion: '3.44.0', evidence: evidence(), projection: projection({ missingHosts: ['Codex hooks'] }), now });
  assert.equal(byId(snap, 'typesafePicker').state.id, 'partial');
  assert.match(byId(snap, 'typesafePicker').state.meaning, /Codex hooks/);
});

test('learning profile evidence says when the engine is not loaded', () => {
  const snap = componentSnapshot({ cfg, rufloVersion: '3.44.0', evidence: evidence(), projection: projection(), now });
  assert.ok(byId(snap, 'learningProfile').evidence.some((e) => /engine not loaded/i.test(e.detail)));
});

test('memory fix older than alpha.22 is blocked with upgrade guidance', () => {
  const snap = componentSnapshot({ cfg, rufloVersion: '3.44.0', evidence: evidence({ memoryFix: { version: '3.0.0-alpha.21' } }), projection: projection(), now });
  assert.equal(byId(snap, 'memoryFix2887').state.id, 'blocked');
});

test('encryption is reported as not yet managed (ADR-0059)', () => {
  const snap = componentSnapshot({ cfg, rufloVersion: '3.44.0', evidence: evidence(), projection: projection(), now });
  assert.equal(byId(snap, 'encryptionAtRest').state.id, 'not-applied');
  assert.match(byId(snap, 'encryptionAtRest').state.meaning, /ADR-0059/);
});

test('a probe error surfaces as the unknown reason (ruling: id -> probe key)', () => {
  const snap = componentSnapshot({
    cfg, rufloVersion: '3.44.0',
    evidence: evidence({ minilm: { embedder: null }, errors: { route: 'timed out' } }),
    projection: projection(), now,
  });
  const view = byId(snap, 'minilmPicker');
  assert.equal(view.state.id, 'unknown');
  assert.match(view.state.meaning, /timed out/);
});
