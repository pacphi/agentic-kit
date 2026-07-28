import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LiveSessionsService } from '../../src/lib/live/index.mjs';
import { waitUntil } from './helpers/wait-until.mjs';
const sandbox = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-live-service-'));
  const claude = path.join(dir, 'claude', 'project');
  const codex = path.join(dir, 'codex', '2026', '07', '27');
  fs.mkdirSync(claude, { recursive: true });
  fs.mkdirSync(codex, { recursive: true });
  return { dir, claude, codex, roots: {
    claude: path.join(dir, 'claude'), codex: path.join(dir, 'codex'),
  } };
};
const line = (value) => `${JSON.stringify(value)}\n`;

test('service bootstraps safe metadata then tails existing files from end', async (t) => {
  const sb = sandbox();
  const file = path.join(sb.claude, 'c1.jsonl');
  fs.writeFileSync(file, line({
    type: 'user', sessionId: 'c1', timestamp: '2026-07-27T10:00:00Z',
    cwd: '/Users/private-user/work/visible-project',
    message: { model: 'claude-x', content: 'historical private prompt' },
  }));
  const service = new LiveSessionsService({
    roots: sb.roots, intervalMs: 10, readCodexState: () => null,
    now: () => '2026-07-27T12:00:00Z',
  });
  t.after(() => service.close());
  const received = [];
  service.subscribe((event) => received.push(event));
  service.start();
  assert.equal(service.snapshot().sessions.length, 1);
  assert.equal(service.snapshot().sessions[0].project, 'visible-project');
  assert.equal(service.snapshot().sessions[0].nodes[0].model, 'claude-x');
  assert.deepEqual(service.snapshot().projects[0].sessions, ['claude:c1']);
  assert.equal(service.snapshot().projects[0].liveCount, 0);
  assert.equal(service.snapshot().projects[0].completedCount, 0);
  fs.appendFileSync(file, line({
    type: 'assistant', sessionId: 'c1', timestamp: '2026-07-27T12:00:01Z',
    cwd: '/Users/private-user/work/visible-project',
    message: { model: 'claude-x', content: [{ type: 'tool_use', id: 't1', name: 'Read',
      input: { file: '/private/path' } }] },
  }));
  await waitUntil(() => received.length >= 3, 'expected 3 events after the append but the tailer never caught up');
  assert.equal(received.length, 3);
  assert.equal(received.filter((event) => event.action === 'session.discovered').length, 1);
  const json = JSON.stringify(service.snapshot());
  assert.ok(!json.includes('historical private prompt'));
  assert.ok(!json.includes('/private/path'));
  assert.ok(!json.includes('private-user'));
  assert.equal(service.snapshot().sessions[0].project, 'visible-project');
  assert.equal(service.snapshot().health.claude.status, 'ok');
});

test('native discovery chooses newest files when the tailer budget is bounded', () => {
  const sb = sandbox();
  const old = path.join(sb.claude, 'old.jsonl');
  const recent = path.join(sb.claude, 'recent.jsonl');
  fs.writeFileSync(old, line({ type: 'user', sessionId: 'old', cwd: '/work/old-project' }));
  fs.writeFileSync(recent, line({ type: 'user', sessionId: 'recent', cwd: '/work/recent-project' }));
  fs.utimesSync(old, new Date(1_000), new Date(1_000));
  fs.utimesSync(recent, new Date(2_000), new Date(2_000));
  const service = new LiveSessionsService({
    roots: sb.roots, maxFiles: 1, readCodexState: () => null,
    setInterval: () => ({ unref() {} }), clearInterval: () => {},
    now: () => '2026-07-27T12:00:00Z',
  });
  service.start();
  assert.deepEqual(service.snapshot().sessions.map((session) => session.id), ['recent']);
  service.close();
});

test('metadata bootstrap is adversarially privacy bounded', () => {
  const sb = sandbox();
  fs.writeFileSync(path.join(sb.codex, 'rollout-2026-07-27T12-00-00-x1.jsonl'), [
    line({ type: 'session_meta', payload: {
      id: 'x1', cwd: '/Users/alice/secret/agentic-kit', title: 'PRIVATE TITLE',
      summary: 'PRIVATE SUMMARY', preview: 'PRIVATE PREVIEW',
    } }),
    line({ type: 'turn_context', payload: {
      model: 'gpt-safe', cwd: '/Users/alice/secret/agentic-kit',
      prompt: 'PRIVATE PROMPT', arguments: { token: 'PRIVATE TOKEN' },
      output: 'PRIVATE OUTPUT', content: 'PRIVATE CONTENT',
    } }),
  ].join(''));
  const service = new LiveSessionsService({
    roots: sb.roots, readCodexState: () => null,
    setInterval: () => ({ unref() {} }), clearInterval: () => {},
    now: () => '2026-07-27T12:00:00Z',
  });
  service.start();
  const json = JSON.stringify(service.snapshot());
  assert.ok(json.includes('agentic-kit'));
  assert.ok(json.includes('gpt-safe'));
  for (const secret of ['alice', '/Users/', 'PRIVATE', 'secret']) assert.ok(!json.includes(secret));
  service.close();
});

test('service reconciles new Codex files from their beginning', async (t) => {
  const sb = sandbox();
  const service = new LiveSessionsService({
    roots: sb.roots, intervalMs: 10, readCodexState: () => null,
    now: () => '2026-07-27T12:00:00Z',
  });
  t.after(() => service.close());
  service.start();
  const file = path.join(sb.codex, 'rollout-2026-07-27T12-00-00-x1.jsonl');
  fs.writeFileSync(file, line({
    type: 'session_meta', timestamp: '2026-07-27T12:00:00Z',
    payload: { id: 'x1', model: 'gpt-x', cwd: '/private/project' },
  }));
  await waitUntil(() => service.snapshot().sessions.length > 0, 'new Codex file was never reconciled into the snapshot');
  const snapshot = service.snapshot();
  assert.equal(snapshot.sessions[0].id, 'x1');
  assert.equal(snapshot.sessions[0].project, 'project');
  assert.ok(!JSON.stringify(snapshot).includes('/private/project'));
});

test('service publishes ledger identity and edges once, supports replay and cleans timers', () => {
  const sb = sandbox();
  let timerCallback;
  let cleared = false;
  const ledger = {
    parents: new Map([['child', 'parent']]),
    threads: new Map([['parent', { model: 'gpt-x' }], ['child', { tokensUsed: 1 }]]),
  };
  const service = new LiveSessionsService({
    roots: sb.roots, readCodexState: () => ledger,
    setInterval: (fn) => { timerCallback = fn; return { unref() {} }; },
    clearInterval: () => { cleared = true; },
    now: () => '2026-07-27T12:00:00Z',
  });
  const seen = [];
  const unsubscribe = service.subscribe((event) => seen.push(event));
  service.start();
  timerCallback();
  assert.equal(seen.length, 3);
  assert.equal(seen.filter((event) => event.action === 'agent.spawned').length, 1);
  assert.equal(service.replay(null).events.length, 3);
  assert.equal(service.snapshot().sessions[0].edges.length, 1);
  unsubscribe();
  service.close();
  assert.equal(cleared, true);
});

test('service optionally ingests explicit AQE sources with bounded metadata', async (t) => {
  const sb = sandbox();
  const file = path.join(sb.dir, 'aqe.jsonl');
  fs.writeFileSync(file, '');
  const service = new LiveSessionsService({
    roots: sb.roots, intervalMs: 10, readCodexState: () => null,
    structuredSources: [{ file, surface: 'aqe' }],
    now: () => '2026-07-27T12:00:00Z',
  });
  t.after(() => service.close());
  service.start();
  fs.appendFileSync(file, line({
    sessionId: 's1', agentId: 'gate1', kind: 'gate',
    event: 'gate.completed', status: 'completed', output: 'private verdict body',
  }));
  await waitUntil(() => JSON.stringify(service.replay(null)).includes('gate.completed'),
    'the structured AQE source event was never ingested');
  const json = JSON.stringify(service.replay(null));
  assert.ok(json.includes('gate.completed'));
  assert.ok(!json.includes('private verdict body'));
  assert.ok(!json.includes(sb.dir));
});

test('explicit structured sources keep priority when native discovery is saturated', async (t) => {
  const sb = sandbox();
  for (let i = 0; i < 8; i++) {
    fs.writeFileSync(path.join(sb.claude, `session-${i}.jsonl`), '');
    fs.writeFileSync(path.join(sb.codex, `rollout-2026-07-27T00-00-00-codex-${i}.jsonl`), '');
  }
  const file = path.join(sb.dir, 'aqe-priority.jsonl');
  fs.writeFileSync(file, '');
  const service = new LiveSessionsService({
    roots: sb.roots,
    structuredSources: [{ file, surface: 'aqe' }],
    maxFiles: 4,
    intervalMs: 10,
    readCodexState: () => null,
    now: () => '2026-07-27T12:00:00Z',
  });
  t.after(() => service.close());
  service.start();
  fs.appendFileSync(file, line({
    sessionId: 'explicit-session', agentId: 'qe-worker',
    event: 'quality.verdict.recorded', status: 'completed',
  }));
  await waitUntil(() => service.snapshot().sessions.some((session) => session.id === 'explicit-session'),
    'the explicit-priority structured source session never appeared, despite native discovery saturation');
  assert.equal(service.snapshot().sessions.some((session) => session.id === 'explicit-session'), true);
});

test('adapter health never exposes filesystem paths from errors', async (t) => {
  const sb = sandbox();
  const file = path.join(sb.claude, 'broken.jsonl');
  fs.writeFileSync(file, '');
  const service = new LiveSessionsService({
    roots: sb.roots, intervalMs: 10, readCodexState: () => null,
    now: () => '2026-07-27T12:00:00Z',
  });
  t.after(() => service.close());
  service.start();
  fs.appendFileSync(file, 'invalid-json\n');
  await waitUntil(() => JSON.stringify(service.snapshot().health).includes('invalid-json'),
    'the parse error was never surfaced into adapter health');
  const health = JSON.stringify(service.snapshot().health);
  assert.ok(!health.includes(sb.dir));
  assert.ok(health.includes('invalid-json'));
});
