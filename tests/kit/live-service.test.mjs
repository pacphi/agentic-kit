import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LiveSessionsService, stableProjectKey } from '../../src/lib/live/index.mjs';
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

test('service resolves the Claude inference provider from configuration, keyed by raw cwd', (t) => {
  const sb = sandbox();
  fs.writeFileSync(path.join(sb.claude, 'c1.jsonl'), line({
    type: 'user', sessionId: 'c1', timestamp: '2026-07-27T10:00:00Z',
    cwd: '/Users/private-user/work/visible-project',
    message: { model: 'claude-x', content: 'private' },
  }));
  const asked = [];
  const service = new LiveSessionsService({
    roots: sb.roots, intervalMs: 10, readCodexState: () => null,
    resolveClaudeProvider: ({ cwd }) => {
      asked.push(cwd);
      return { provider: 'vertex', provenance: 'configured' };
    },
    now: () => '2026-07-27T12:00:00Z',
  });
  t.after(() => service.close());
  service.start();
  assert.deepEqual(asked, ['/Users/private-user/work/visible-project']);
  const node = service.snapshot().sessions[0].nodes.find((n) => n.kind === 'session');
  assert.equal(node.provider, 'vertex');
  assert.equal(node.providerProvenance, 'configured');
});

test('codex metadata learned during bootstrap persists into live tailing', async (t) => {
  const sb = sandbox();
  const file = path.join(sb.codex, 'rollout-2026-07-27T10-00-00-x1.jsonl');
  fs.writeFileSync(file,
    line({ type: 'session_meta', timestamp: '2026-07-27T10:00:00Z',
      payload: { id: 'x1', model: 'gpt-x', model_provider: 'openai', cwd: '/Users/private/repo' } })
    + line({ type: 'turn_context', timestamp: '2026-07-27T10:00:01Z',
      payload: { model: 'gpt-x', cwd: '/Users/private/repo' } }));
  const service = new LiveSessionsService({
    roots: sb.roots, intervalMs: 10, readCodexState: () => null,
    now: () => '2026-07-27T12:00:00Z',
  });
  t.after(() => service.close());
  const live = [];
  service.subscribe((event) => live.push(event));
  service.start();
  fs.appendFileSync(file, line({ type: 'event_msg', timestamp: '2026-07-27T12:00:01Z',
    payload: { type: 'agent_message', message: 'private' } }));
  await waitUntil(() => live.some((event) => event.action === 'agent.output'),
    'expected the appended agent_message to surface');
  const output = live.find((event) => event.action === 'agent.output');
  assert.equal(output.sessionId, 'x1');
  assert.equal(output.provider, 'openai');
  assert.equal(output.providerProvenance, 'observed');
  const node = service.snapshot().sessions[0].nodes.find((n) => n.kind === 'session');
  assert.equal(node.provider, 'openai');
  assert.equal(node.providerProvenance, 'observed');
});

test('service discovers nested subagent transcripts and files them under the parent session', async (t) => {
  const sb = sandbox();
  const nested = path.join(sb.claude, 'c1', 'subagents');
  fs.mkdirSync(nested, { recursive: true });
  const file = path.join(nested, 'agent-w1.jsonl');
  fs.writeFileSync(file, line({
    type: 'user', sessionId: 'c1', agentId: 'w1', isSidechain: true,
    timestamp: '2026-07-27T11:59:00Z', cwd: '/Users/private-user/work/visible-project',
    message: { content: 'private worker prompt' },
  }));
  const service = new LiveSessionsService({
    roots: sb.roots, intervalMs: 10, readCodexState: () => null,
    now: () => '2026-07-27T12:00:00Z',
  });
  t.after(() => service.close());
  service.start();
  assert.equal(service.snapshot().sessions.length, 1);
  assert.equal(service.snapshot().sessions[0].id, 'c1');
  assert.ok(service.snapshot().sessions[0].nodes.some(
    (node) => node.id === 'w1' && node.kind === 'subagent',
  ));
  fs.appendFileSync(file, line({
    type: 'assistant', sessionId: 'c1', agentId: 'w1', isSidechain: true,
    timestamp: '2026-07-27T12:00:01Z', cwd: '/Users/private-user/work/visible-project',
    message: { content: [] },
  }));
  await waitUntil(() => service.snapshot().sessions[0].lifecycle === 'active',
    'subagent transcript activity never marked the parent session live');
  assert.ok(!JSON.stringify(service.snapshot()).includes('private worker prompt'));
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

test('runtime observation keeps concurrent Claude and Codex repositories live without transcript appends', (t) => {
  const sb = sandbox();
  const projects = ['agentic-kit', 'keel', 'emailibrium'].map((name) => path.join(sb.dir, name));
  for (const project of projects) fs.mkdirSync(path.join(project, '.git'), { recursive: true });
  const service = new LiveSessionsService({
    roots: sb.roots, readCodexState: () => null, runtimeScanMs: 0,
    readActiveSessions: () => [
      { pid: 10, host: 'codex', cwd: projects[0] },
      { pid: 20, host: 'claude', cwd: projects[1] },
      { pid: 30, host: 'claude', cwd: projects[2] },
    ],
    now: () => '2026-08-03T22:45:00Z',
  });
  t.after(() => service.close());
  service.start();
  const snapshot = service.snapshot();
  assert.deepEqual(snapshot.projects.map((project) => project.label).sort(),
    ['agentic-kit', 'emailibrium', 'keel']);
  assert.equal(snapshot.sessions.filter((session) => session.lifecycle === 'active').length, 3);
  assert.ok(snapshot.projects.every((project) => project.liveCount === 1));
  assert.ok(snapshot.sessions.every((session) => session.project !== 'unknown'));
});

test('runtime leases require canonical Git repositories and expire after three missed surveys', (t) => {
  const sb = sandbox();
  const repository = path.join(sb.dir, 'keel');
  const nonRepository = path.join(sb.dir, 'scratch');
  fs.mkdirSync(path.join(repository, '.git'), { recursive: true });
  fs.mkdirSync(nonRepository);
  let active = [
    { pid: 20, startedAt: '2026-08-03T16:00:00Z', host: 'claude', cwd: repository },
    { pid: 21, startedAt: '2026-08-03T16:00:00Z', host: 'claude', cwd: nonRepository },
  ];
  let nowMs = Date.parse('2026-08-03T16:00:00Z');
  let tick;
  const service = new LiveSessionsService({
    roots: sb.roots, readCodexState: () => null, runtimeScanMs: 0, runtimeMisses: 3,
    readActiveSessions: () => active,
    setInterval: (fn) => { tick = fn; return { unref() {} }; },
    clearInterval: () => {}, now: () => new Date(nowMs).toISOString(),
  });
  t.after(() => service.close());
  service.start();
  assert.deepEqual(service.snapshot().projects.map((project) => project.label), ['keel']);
  active = [];
  for (let count = 0; count < 2; count++) {
    nowMs += 2_001;
    tick();
  }
  assert.equal(service.snapshot().projects[0].liveCount, 1);
  nowMs += 2_001;
  tick();
  assert.equal(service.snapshot().projects[0].liveCount, 0);
  assert.equal(service.snapshot().sessions[0].lifecycle, 'quiescent');
});

test('runtime PID generations do not let an expired process quiesce its replacement', (t) => {
  const sb = sandbox();
  const repository = path.join(sb.dir, 'agentic-kit');
  fs.mkdirSync(path.join(repository, '.git'), { recursive: true });
  let startedAt = '2026-08-03T16:00:00Z';
  let nowMs = Date.parse(startedAt);
  let tick;
  const service = new LiveSessionsService({
    roots: sb.roots, readCodexState: () => null, runtimeScanMs: 0, runtimeMisses: 3,
    readActiveSessions: () => [{ pid: 10, startedAt, host: 'codex', cwd: repository }],
    setInterval: (fn) => { tick = fn; return { unref() {} }; },
    clearInterval: () => {}, now: () => new Date(nowMs).toISOString(),
  });
  t.after(() => service.close());
  service.start();
  const firstId = service.snapshot().sessions[0].id;
  startedAt = '2026-08-03T16:05:00Z';
  for (let count = 0; count < 3; count++) {
    nowMs += 2_001;
    tick();
  }
  const sessions = service.snapshot().sessions;
  assert.equal(sessions.find((session) => session.id === firstId).lifecycle, 'quiescent');
  assert.equal(sessions.find((session) => session.id !== firstId).lifecycle, 'active');
  assert.equal(service.snapshot().projects[0].liveCount, 1);
});

test('runtime synthetic sessions rebind to transcript identity when evidence arrives', (t) => {
  const sb = sandbox();
  const repository = path.join(sb.dir, 'emailibrium');
  fs.mkdirSync(path.join(repository, '.git'), { recursive: true });
  let tick;
  const service = new LiveSessionsService({
    roots: sb.roots, readCodexState: () => null, runtimeScanMs: 0,
    readActiveSessions: () => [{
      pid: 30, startedAt: '2026-08-03T16:00:00Z', host: 'claude', cwd: repository,
    }],
    setInterval: (fn) => { tick = fn; return { unref() {} }; },
    clearInterval: () => {}, now: () => '2026-08-03T16:00:00Z',
  });
  t.after(() => service.close());
  service.start();
  assert.match(service.snapshot().sessions[0].id, /^runtime-/);
  fs.writeFileSync(path.join(sb.claude, 'real-session.jsonl'), line({
    type: 'user', sessionId: 'real-session', timestamp: '2026-08-03T16:00:00Z',
    cwd: repository, message: { model: 'claude-x', content: 'private' },
  }));
  tick();
  assert.deepEqual(service.snapshot().sessions.map((session) => session.id), ['real-session']);
  assert.equal(service.snapshot().projects[0].liveCount, 1);
});

test('runtime survey failures degrade health without expiring prior leases', async (t) => {
  const sb = sandbox();
  const repository = path.join(sb.dir, 'keel');
  fs.mkdirSync(path.join(repository, '.git'), { recursive: true });
  let fail = false;
  let tick;
  const service = new LiveSessionsService({
    roots: sb.roots, readCodexState: () => null, runtimeScanMs: 0,
    readActiveSessions: () => fail
      ? Promise.reject(Object.assign(new Error('private path'), { code: 'ERR_RUNTIME_TEST' }))
      : [{ pid: 20, startedAt: '2026-08-03T16:00:00Z', host: 'claude', cwd: repository }],
    setInterval: (fn) => { tick = fn; return { unref() {} }; },
    clearInterval: () => {}, now: () => '2026-08-03T16:00:00Z',
  });
  t.after(() => service.close());
  service.start();
  fail = true;
  tick();
  await waitUntil(() => service.snapshot().health.runtime.status === 'degraded');
  assert.equal(service.snapshot().projects[0].liveCount, 1);
  assert.equal(service.snapshot().health.runtime.lastError, 'ERR_RUNTIME_TEST');
});

test('ledger edges retain their repository after bounded projection eviction', (t) => {
  const sb = sandbox();
  const ledger = {
    threads: new Map([
      ['parent', { project: 'agentic-kit', projectKey: stableProjectKey('agentic-kit') }],
      ['child-a', { project: 'keel' }],
      ['child-b', { project: 'emailibrium' }],
    ]),
    parents: new Map([['child-a', 'parent'], ['child-b', 'parent']]),
  };
  const service = new LiveSessionsService({
    roots: sb.roots, maxSessions: 2, readCodexState: () => ledger,
    readActiveSessions: () => [], now: () => '2026-08-03T22:45:00Z',
  });
  t.after(() => service.close());
  service.start();
  const parent = service.snapshot().sessions.find((session) => session.id === 'parent');
  assert.equal(parent.project, 'agentic-kit');
  assert.ok(!service.snapshot().projects.some((project) => project.label === 'unknown'));
});
