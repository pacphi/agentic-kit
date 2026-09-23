import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseDoctor, parseRouteEmbedder, parseIntelligence, parseNeuralStatus, parseFunnel, auditStats, collectEvidence,
  readEvidenceCache, writeEvidenceCache,
} from '../../src/lib/ruflo-components/evidence.mjs';

const fixture = (name) => fs.readFileSync(new URL(`../fixtures/ruflo-components/${name}`, import.meta.url), 'utf8');

test('doctor parser reads a spinner-prefixed line and plain lines', () => {
  const rows = parseDoctor(fixture('doctor-typesafe-3.43.0.txt'));
  assert.deepEqual(rows, [{ status: 'pass', name: '@ruvector/typesafe router',
    detail: 'Not installed; disabled (set CLAUDE_FLOW_ROUTER_TYPESAFE=1) — hooks_route uses the built-in router' }]);
  assert.equal(parseDoctor(fixture('doctor-metaharness-3.43.0.txt')).length, 3);
});

test('doctor parser strips ANSI colour and ignores unrelated lines', () => {
  assert.deepEqual(parseDoctor('\u001b[32m⚠\u001b[0m Encryption at Rest: Off\nSummary: 0 passed'),
    [{ status: 'warn', name: 'Encryption at Rest', detail: 'Off' }]);
  assert.deepEqual(parseDoctor('totally different format'), []);
});

test('route embedder, intelligence, neural and funnel parsers', () => {
  assert.equal(parseRouteEmbedder('... routedBy=semantic embedder=minilm ...'), 'minilm');
  assert.equal(parseRouteEmbedder('no marker'), null);
  assert.deepEqual(parseIntelligence(fixture('intelligence-stats-3.43.0.txt')),
    { mode: 'balanced', lastTrainingSeconds: 170300, trajectories: 13649 });
  assert.deepEqual(parseNeuralStatus(fixture('neural-status-3.43.0.txt')), { sonaEngineLoaded: false });
  assert.deepEqual(parseFunnel(fixture('funnel-status-3.43.0.txt')), { enabled: true, decidedBy: 'package-default' });
  assert.equal(parseIntelligence('garbage'), null);
});

test('funnel parser accepts the JSON shape first, and falls back to the text form', () => {
  assert.deepEqual(parseFunnel(JSON.stringify({ enabled: true, decidedBy: 'package-default', disclosure: 'disclosed_enabled' })),
    { enabled: true, decidedBy: 'package-default' });
  assert.deepEqual(parseFunnel(JSON.stringify({ enabled: false, decidedBy: 'user-opt-out' })),
    { enabled: false, decidedBy: 'user-opt-out' });
  assert.deepEqual(parseFunnel('Funnel: enabled (decided by: package-default)\nDisclosure: disclosed_enabled'),
    { enabled: true, decidedBy: 'package-default' });
  assert.equal(parseFunnel('not json, not the text form either'), null);
  assert.equal(parseFunnel('{"enabled": "yes"}'), null);
});

// ADR-305: funnel precedence is env > enterprise-policy > user-config >
// project-config > package-default. parseFunnel treats decidedBy as an opaque
// string (no allowlist), so every source round-trips; snapshot.mjs is what
// tells ak's own channel ('user-config') apart from the other four (see
// ruflo-components-snapshot.test.mjs).
test('funnel parser round-trips every ADR-305 decidedBy source', () => {
  for (const decidedBy of ['env', 'enterprise-policy', 'user-config', 'project-config', 'package-default']) {
    assert.deepEqual(parseFunnel(JSON.stringify({ enabled: false, decidedBy })), { enabled: false, decidedBy });
  }
});

test('audit stats count the last 24 hours only and keep recent refusal reasons', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-audit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'audit.jsonl');
  const now = Date.parse('2026-09-23T12:00:00Z');
  const line = (iso, allowed, reason) => JSON.stringify({ timestamp: iso, sessionId: 's', toolName: 'memory_store', allowed, reason });
  fs.writeFileSync(file, [
    line('2026-09-21T12:00:00Z', false, 'old'),
    line('2026-09-23T11:00:00Z', true),
    line('2026-09-23T11:30:00Z', false, 'maxToolCallsPerTurn (120) exceeded within the last 60000ms for this session'),
    'not json',
  ].join('\n') + '\n');
  assert.deepEqual(auditStats(file, now), { audited: 2, refused: 1,
    reasons: ['maxToolCallsPerTurn (120) exceeded within the last 60000ms for this session'] });
  assert.equal(auditStats(path.join(dir, 'missing.jsonl'), now), null);
});

test('collectEvidence survives probe failures and records them', async () => {
  const runner = async (cmd, args) => {
    if (args.includes('funnel')) return { code: 1, stdout: '', stderr: 'boom' };
    if (args.includes('doctor')) return { code: 0, stdout: fixture('doctor-typesafe-3.43.0.txt'), stderr: '' };
    return { code: 124, stdout: '', stderr: 'timed out' };
  };
  const evidence = await collectEvidence({ projectRoot: null, cfg: {}, rufloVersion: '3.43.0', runner, now: Date.now() });
  assert.equal(evidence.funnel, null);
  assert.match(evidence.errors.funnel, /boom/);
  assert.equal(evidence.learning.mode, null);
  assert.match(evidence.errors.intelligence, /timed out/);
});

test('collectEvidence wires successful probes into the evidence shape', async () => {
  const runner = async (cmd, args) => {
    if (args.includes('funnel')) return { code: 0, stdout: fixture('funnel-status-3.43.0.txt'), stderr: '' };
    if (args[0] === 'doctor' && args.includes('typesafe')) {
      return { code: 0, stdout: fixture('doctor-typesafe-3.43.0.txt'), stderr: '' };
    }
    if (args[0] === 'doctor' && args.includes('metaharness')) {
      return { code: 0, stdout: fixture('doctor-metaharness-3.43.0.txt'), stderr: '' };
    }
    if (args.includes('route')) return { code: 0, stdout: fixture('route-minilm-3.44.0.txt'), stderr: '' };
    if (args.includes('stats') && args.includes('intelligence')) {
      return { code: 0, stdout: fixture('intelligence-stats-3.43.0.txt'), stderr: '' };
    }
    if (args.includes('status') && args.includes('neural')) {
      return { code: 0, stdout: fixture('neural-status-3.43.0.txt'), stderr: '' };
    }
    return { code: 1, stdout: '', stderr: 'unexpected probe' };
  };
  const now = Date.parse('2026-09-23T12:00:00Z');
  const evidence = await collectEvidence({ projectRoot: null, cfg: {}, rufloVersion: '3.43.0', runner, now });
  assert.equal(evidence.capturedAt, new Date(now).toISOString());
  assert.equal(evidence.rufloVersion, '3.43.0');
  assert.deepEqual(evidence.typesafe.doctor, { status: 'pass', name: '@ruvector/typesafe router',
    detail: 'Not installed; disabled (set CLAUDE_FLOW_ROUTER_TYPESAFE=1) — hooks_route uses the built-in router' });
  assert.equal(evidence.minilm.embedder, 'minilm');
  assert.equal(evidence.learning.mode, 'balanced');
  assert.equal(evidence.learning.engineLoaded, false);
  assert.equal(evidence.turnCredit.present, true);
  assert.deepEqual(evidence.funnel, { enabled: true, decidedBy: 'package-default' });
  assert.deepEqual(evidence.errors, {});
});

test('3.44.0 fixtures: route embedder markers and doctor typesafe row', () => {
  assert.equal(parseRouteEmbedder(fixture('route-minilm-3.44.0.txt')), 'minilm');
  assert.equal(parseRouteEmbedder(fixture('route-default-3.44.0.txt')), 'hash');
  const rows = parseDoctor(fixture('doctor-typesafe-3.44.0.txt'));
  assert.deepEqual(rows, [{ status: 'pass', name: '@ruvector/typesafe router',
    detail: 'Not installed; disabled (set CLAUDE_FLOW_ROUTER_TYPESAFE=1) — hooks_route uses the built-in router' }]);
});

test('3.44.0 fixture: funnel status JSON parses directly', () => {
  assert.deepEqual(parseFunnel(fixture('funnel-status-3.44.0.json')), { enabled: true, decidedBy: 'package-default' });
});

test('collectEvidence never throws when the injected module-version resolver throws', async () => {
  const runner = async (cmd, args) => {
    if (args.includes('funnel')) return { code: 0, stdout: fixture('funnel-status-3.43.0.txt'), stderr: '' };
    if (args[0] === 'doctor' && args.includes('typesafe')) {
      return { code: 0, stdout: fixture('doctor-typesafe-3.43.0.txt'), stderr: '' };
    }
    if (args[0] === 'doctor' && args.includes('metaharness')) {
      return { code: 0, stdout: fixture('doctor-metaharness-3.43.0.txt'), stderr: '' };
    }
    if (args.includes('route')) return { code: 0, stdout: fixture('route-minilm-3.44.0.txt'), stderr: '' };
    if (args.includes('stats') && args.includes('intelligence')) {
      return { code: 0, stdout: fixture('intelligence-stats-3.43.0.txt'), stderr: '' };
    }
    if (args.includes('status') && args.includes('neural')) {
      return { code: 0, stdout: fixture('neural-status-3.43.0.txt'), stderr: '' };
    }
    return { code: 1, stdout: '', stderr: 'unexpected probe' };
  };
  const resolveModuleVersion = () => { throw new Error('cannot determine npm global root (is npm installed?)'); };
  const evidence = await collectEvidence({
    projectRoot: null, cfg: {}, rufloVersion: '3.43.0', runner, now: Date.now(), resolveModuleVersion,
  });
  assert.equal(evidence.typesafe.resolves, false);
  assert.equal(evidence.memoryFix.version, null);
  assert.match(evidence.errors.typesafeModule, /cannot determine npm global root/);
  assert.match(evidence.errors.memoryModule, /cannot determine npm global root/);
});

test('writeEvidenceCache then readEvidenceCache round-trips; a missing path reads as null', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-evidence-cache-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'evidence.json');
  assert.equal(readEvidenceCache(file), null);
  const evidence = {
    capturedAt: '2026-09-23T12:00:00.000Z', rufloVersion: '3.44.0',
    typesafe: { resolves: false, doctor: null }, minilm: { embedder: 'minilm' },
    learning: { mode: 'balanced', engineLoaded: false, lastTrainingSeconds: 170300, trajectories: 13649 },
    turnCredit: { present: true }, memoryFix: { version: null },
    funnel: { enabled: true, decidedBy: 'package-default' },
    governance: { audit: { audited: 2, refused: 1, reasons: [] } }, errors: {},
  };
  writeEvidenceCache(file, evidence);
  assert.deepEqual(readEvidenceCache(file), evidence);
  assert.equal(readEvidenceCache(path.join(dir, 'missing.json')), null);
});
