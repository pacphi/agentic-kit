import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createLiveEvent, JsonlTailer, emptyLiveProjection, reduceLiveEvent,
} from '../../src/lib/live/index.mjs';
import { LIVE_JS } from '../../src/lib/dashboard/live-view.mjs';

const observedAt = '2026-07-27T12:00:00Z';

test('canonical event serialization is a closed allowlist under arbitrary extra fields', () => {
  const allowedTop = new Set([
    'schemaVersion', 'observedAt', 'sourceTimestamp', 'sessionId', 'sessionKey',
    'parentSessionId', 'traceId', 'spanId', 'parentSpanId', 'host',
    'provider', 'model', 'providerProvenance', 'surface',
    'project', 'projectKey', 'actor',
    'action', 'target', 'status', 'source', 'attributes',
  ]);
  for (let i = 0; i < 100; i++) {
    const secret = `never-on-wire-${i}`;
    const event = createLiveEvent({
      sessionId: `session-${i}`,
      observedAt,
      actor: { id: `actor-${i}`, kind: 'agent', unexpected: secret },
      action: 'agent.output',
      source: { adapter: 'fixture', unexpected: secret },
      attributes: { unexpected: secret },
      [`untrusted_${i}`]: secret,
    });
    assert.deepEqual(new Set(Object.keys(event)), allowedTop);
    assert.equal(JSON.stringify(event).includes(secret), false);
  }
});

test('JSONL tailing preserves a UTF-8 record split across byte-level appends', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-live-utf8-'));
  const file = path.join(dir, 'events.jsonl');
  const bytes = Buffer.from(`${JSON.stringify({ label: 'agent 🐝' })}\n`);
  const split = bytes.indexOf(Buffer.from('🐝')) + 2;
  fs.writeFileSync(file, bytes.subarray(0, split));
  const rows = [];
  const errors = [];
  const tailer = new JsonlTailer(file, {
    onRecord: (row) => rows.push(row),
    onError: (error) => errors.push(error),
  });
  tailer.reconcile();
  fs.appendFileSync(file, bytes.subarray(split));
  tailer.reconcile();
  assert.deepEqual(errors, []);
  assert.deepEqual(rows, [{ label: 'agent 🐝' }]);
});

test('projection completion updates the target resource without completing its session', () => {
  const make = (action, status, target, id) => ({
    ...createLiveEvent({
      sessionId: 'session',
      observedAt,
      host: 'claude',
      actor: { id: 'session', kind: 'session' },
      action,
      status,
      target,
      source: { adapter: 'fixture', confidence: 'observed' },
    }),
    eventId: id,
  });
  const started = reduceLiveEvent(
    emptyLiveProjection(),
    make('tool.started', 'running', { id: 'tool-1', kind: 'tool' }, 'ak:1'),
  );
  const completed = reduceLiveEvent(
    started,
    make('tool.completed', 'completed', { id: 'tool-1', kind: 'tool' }, 'ak:2'),
  );
  const session = completed.sessions.get('claude:session');
  assert.equal(session.status, 'unknown');
  assert.equal(session.nodes.get('session').status, 'running');
  assert.equal(session.nodes.get('tool-1').status, 'completed');
});

test('browser delta reducer carries the server resource-completion invariants', () => {
  assert.match(LIVE_JS, /targetTerminal/);
  assert.match(LIVE_JS, /ev\.actor\.kind===["']session["']&&\/\^session/);
  assert.match(LIVE_JS, /upsert\(ev\.actor,targetTerminal\?priorActor/);
  assert.match(LIVE_JS, /targetTerminal\?ev\.status:["']running["']/);
  assert.match(LIVE_JS, /TERMINAL/);
});

test('browser resynchronizes unseen and rebound sessions instead of constructing partial topology', () => {
  assert.match(LIVE_JS, /i<0\|\|ev\.action===["']session\.rebound["']/);
  assert.match(LIVE_JS, /if\(!state\.resyncing\)connect\(\);return/);
  assert.match(LIVE_JS, /function connect\(\)\{if\(state\.resyncing\)return/);
});

test('browser reports unsupported OpenCode transcript topology without opening a stream', () => {
  assert.match(LIVE_JS, /s\.host!==["']opencode["']/);
  assert.match(LIVE_JS, /OpenCode transcript topology unavailable/);
});

test('browser presentation keeps execution host and inference provider independent', () => {
  assert.match(LIVE_JS, /function hostOf/);
  assert.match(LIVE_JS, /function hostName/);
  assert.match(LIVE_JS, /function inferenceProviderName/);
  assert.doesNotMatch(LIVE_JS, /function providerOf/);
  assert.doesNotMatch(LIVE_JS, /v&&v\.provider\|\|v&&v\.host/);
  assert.match(LIVE_JS, /providerProvenance/);
  assert.match(LIVE_JS, /Provider not established/);
  assert.match(LIVE_JS, /s\.host/);
});
