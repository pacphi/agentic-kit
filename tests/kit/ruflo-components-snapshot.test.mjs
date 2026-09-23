import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { componentSnapshot, rufloComponentsPayload } from '../../src/lib/ruflo-components/snapshot.mjs';

const now = Date.parse('2026-09-23T12:00:00Z');
const cfg = { rufloComponents: { typesafePicker: true, minilmPicker: true, mcpGovernance: { maxCallsPerMinute: 120 },
  learningProfile: 'balanced', turnCredit: true, memoryFix2887: true, funnel: false } };
const evidence = (over = {}) => ({
  capturedAt: new Date(now - 60_000).toISOString(), rufloVersion: '3.44.0',
  typesafe: { resolves: true, doctor: { status: 'pass', name: '@ruvector/typesafe router', detail: 'installed; enabled' } },
  minilm: { embedder: 'minilm' },
  learning: { mode: 'balanced', engineLoaded: false, lastTrainingSeconds: 170300, trajectories: 13649 },
  turnCredit: { present: true }, memoryFix: { version: '3.0.0-alpha.25' },
  funnel: { enabled: false, decidedBy: 'user-config' }, governance: { audit: { audited: 10, refused: 0, reasons: [] } },
  errors: {}, ...over });
const projection = (over = {}) => ({ claude: { keys: {}, changed: false }, missingHosts: [], policy: 'valid', ...over });
const byId = (snap, id) => snap.components.find((c) => c.id === id);

test('everything confirmed is active and the summary counts it', () => {
  const snap = componentSnapshot({ cfg, rufloVersion: '3.44.0', evidence: evidence(), projection: projection(), now });
  for (const id of ['typesafePicker', 'minilmPicker', 'mcpGovernance', 'learningProfile', 'turnCredit', 'memoryFix2887', 'funnel']) {
    assert.equal(byId(snap, id).state.id, 'active', id);
  }
  // encryptionAtRest is not yet managed (ADR-0059), so it is outside the denominator.
  assert.deepEqual(snap.summary, { active: 7, total: 7 });
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
    projection: projection({ claude: { keys: { RUFLO_INTELLIGENCE_MODE: { state: 'foreign', reason: '' } }, changed: false } }), now });
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
  assert.match(byId(snap, 'mcpGovernance').state.meaning, /fails closed on an invalid file, so ak removed enforcement/);
});

test('governance with a foreign policy file is user-managed with the leaves-enforcement-off sentence', () => {
  const snap = componentSnapshot({ cfg, rufloVersion: '3.44.0', evidence: evidence(), projection: projection({ policy: 'foreign' }), now });
  const view = byId(snap, 'mcpGovernance');
  assert.equal(view.state.id, 'user-managed');
  assert.match(view.state.meaning, /This project has its own \.harness\/mcp-policy\.json, so ak leaves enforcement off\./);
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

test('encryption is reported as not yet managed (ADR-0059), with no sync promise', () => {
  const snap = componentSnapshot({ cfg, rufloVersion: '3.44.0', evidence: evidence(), projection: projection(), now });
  const state = byId(snap, 'encryptionAtRest').state;
  assert.equal(state.id, 'not-managed-yet');
  assert.match(state.meaning, /ADR-0059/);
  assert.equal(state.action, '');
  assert.doesNotMatch(`${state.meaning} ${state.action}`, /Run ak sync/);
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

test('governance with zero audited calls in 24h is unknown, not active (ADR-0058 §2)', () => {
  const snap = componentSnapshot({
    cfg, rufloVersion: '3.44.0',
    evidence: evidence({ governance: { audit: { audited: 0, refused: 0, reasons: [] } } }),
    projection: projection(), now,
  });
  const view = byId(snap, 'mcpGovernance');
  assert.equal(view.state.id, 'unknown');
  assert.match(view.state.meaning, /No ruflo MCP tool calls have been audited in the last 24 hours, so enforcement has not been observed yet\./);
});

test('governance with observed audit activity is active', () => {
  const snap = componentSnapshot({
    cfg, rufloVersion: '3.44.0',
    evidence: evidence({ governance: { audit: { audited: 3, refused: 0, reasons: [] } } }),
    projection: projection(), now,
  });
  assert.equal(byId(snap, 'mcpGovernance').state.id, 'active');
});

test('governance with no audit evidence at all is unknown', () => {
  const snap = componentSnapshot({
    cfg, rufloVersion: '3.44.0',
    evidence: evidence({ governance: { audit: null } }),
    projection: projection(), now,
  });
  const view = byId(snap, 'mcpGovernance');
  assert.equal(view.state.id, 'unknown');
  assert.match(view.state.meaning, /No ruflo MCP tool calls have been audited in the last 24 hours, so enforcement has not been observed yet\./);
});

// ADR-305 funnel precedence: env > enterprise-policy > user-config > project-config
// > package-default. Only 'user-config' is ak's own channel (`ruflo funnel disable`
// writes ruflo's user-tier state — see apply.mjs's ensureFunnel/releaseFunnel).
test('funnel disabled by ak\'s own user-config channel is active', () => {
  const snap = componentSnapshot({ cfg, rufloVersion: '3.44.0',
    evidence: evidence({ funnel: { enabled: false, decidedBy: 'user-config' } }), projection: projection(), now });
  assert.equal(byId(snap, 'funnel').state.id, 'active');
});

for (const decidedBy of ['env', 'enterprise-policy', 'project-config', 'package-default']) {
  test(`funnel disabled by ${decidedBy} (not ak) reads as user-managed, not an error`, () => {
    const snap = componentSnapshot({ cfg, rufloVersion: '3.44.0',
      evidence: evidence({ funnel: { enabled: false, decidedBy } }), projection: projection(), now });
    const view = byId(snap, 'funnel');
    assert.equal(view.state.id, 'user-managed');
    assert.match(view.state.meaning, new RegExp(`decided by ${decidedBy} — not ak's doing`));
  });
}

test('funnel still enabled (any decidedBy) is applied-unverified, not user-managed', () => {
  const snap = componentSnapshot({ cfg, rufloVersion: '3.44.0',
    evidence: evidence({ funnel: { enabled: true, decidedBy: 'package-default' } }), projection: projection(), now });
  assert.equal(byId(snap, 'funnel').state.id, 'applied-unverified');
});

// Controller ruling 1: the shared, read-only projection every surface (status,
// Task 10's dashboard) builds a snapshot from.
test('rufloComponentsPayload has all 8 components, writes nothing, and reports unwritten typesafe as not applied', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-rc-payload-'));
  try {
    const before = fs.readdirSync(tmp);
    const snap = rufloComponentsPayload({
      cfg, rufloVersion: '3.44.0', projectRoot: null,
      evidenceFile: path.join(tmp, 'evidence.json'),
      userSettingsFile: path.join(tmp, 'settings.json'),
      now,
    });
    assert.equal(snap.components.length, 8);
    assert.equal(byId(snap, 'typesafePicker').state.id, 'not-applied');
    assert.equal(byId(snap, 'turnCredit').state.id, 'unknown');
    assert.deepEqual(fs.readdirSync(tmp), before, 'rufloComponentsPayload must never write');
    assert.equal(fs.existsSync(path.join(tmp, 'evidence.json')), false);
    assert.equal(fs.existsSync(path.join(tmp, 'settings.json')), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});


// Final review M12: with no ruflo the dashboard mirrors ak status's single
// "nothing managed" row, not eight needs-ruflo cards.
test('rufloComponentsPayload without ruflo reports nothing managed', () => {
  const snap = rufloComponentsPayload({ cfg, rufloVersion: null, projectRoot: null, evidenceFile: '/nonexistent/evidence.json', now });
  assert.deepEqual(snap, { rufloVersion: null, capturedAt: null, components: [], summary: { active: 0, total: 0 } });
});

// Final review M13: evidence without a turnCredit object has no line, not "turn-credit not found".
test('turn-credit evidence line is omitted when the probe recorded nothing', () => {
  const e = evidence();
  delete e.turnCredit;
  const snap = componentSnapshot({ cfg, rufloVersion: '3.44.0', evidence: e, projection: projection(), now });
  assert.deepEqual(byId(snap, 'turnCredit').evidence, []);
});

test('governance unknown on ruflo 3.44.0 says stdio launches do not enforce the policy', () => {
  const snap = componentSnapshot({ cfg, rufloVersion: '3.44.0',
    evidence: evidence({ governance: { audit: null } }), projection: projection(), now });
  assert.match(byId(snap, 'mcpGovernance').state.meaning, /do not enforce the policy on stdio MCP launches/);
});

for (const decidedBy of ['env', 'enterprise-policy']) {
  test(`funnel kept on by ${decidedBy} is user-managed, not "restart"`, () => {
    const snap = componentSnapshot({ cfg, rufloVersion: '3.44.0',
      evidence: evidence({ funnel: { enabled: true, decidedBy } }), projection: projection(), now });
    assert.equal(byId(snap, 'funnel').state.id, 'user-managed');
    assert.match(byId(snap, 'funnel').state.meaning, /outranks/);
  });
}
