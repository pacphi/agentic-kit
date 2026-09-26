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

test('bounded native discovery rotates to a newer transcript created after startup', () => {
  const sb = sandbox();
  const old = path.join(sb.claude, 'old.jsonl');
  fs.writeFileSync(old, line({
    type: 'user', sessionId: 'old', cwd: '/work/old-project',
    timestamp: '2026-07-27T11:00:00Z',
  }));
  fs.utimesSync(old, new Date(1_000), new Date(1_000));
  let tick;
  const service = new LiveSessionsService({
    roots: sb.roots, maxFiles: 1, readCodexState: () => null,
    setInterval: (fn) => { tick = fn; return { unref() {} }; }, clearInterval: () => {},
    now: () => '2026-07-27T12:00:00Z',
  });
  service.start();
  const recent = path.join(sb.claude, 'recent.jsonl');
  fs.writeFileSync(recent, line({
    type: 'user', sessionId: 'recent', cwd: '/work/recent-project',
    timestamp: '2026-07-27T12:00:00Z',
  }));
  fs.utimesSync(recent, new Date(2_000), new Date(2_000));
  tick();
  assert.ok(service.snapshot().sessions.some((session) => session.id === 'recent'));
  assert.equal(service.snapshot().health.claude.files, 1);
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

test('runtime provider resolution is Claude-only across all live hosts', (t) => {
  const sb = sandbox();
  const hosts = ['claude', 'codex', 'opencode'];
  const projects = hosts.map((host) => path.join(sb.dir, host));
  for (const project of projects) fs.mkdirSync(path.join(project, '.git'), { recursive: true });
  const asked = [];
  const service = new LiveSessionsService({
    roots: sb.roots, readCodexState: () => null, runtimeScanMs: 0,
    readActiveSessions: () => hosts.map((host, index) => ({
      pid: index + 1, host, cwd: projects[index],
    })),
    resolveClaudeProvider: ({ cwd }) => {
      asked.push(cwd);
      return { provider: 'anthropic', provenance: 'inferred' };
    },
    now: () => '2026-08-03T22:45:00Z',
  });
  t.after(() => service.close());
  service.start();
  const snapshot = service.snapshot();
  const providerFor = (host) => snapshot.sessions.find((session) => session.host === host)
    .nodes.find((node) => node.kind === 'session').provider;
  assert.deepEqual(asked, [projects[0]]);
  assert.equal(providerFor('claude'), 'anthropic');
  assert.equal(providerFor('codex'), null);
  assert.equal(providerFor('opencode'), null);
});

test('runtime leases require a Git repository or an exact-folder transcript match, and expire after three missed surveys', (t) => {
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

test('runtime presence does not bind to a session older than the process generation', (t) => {
  const sb = sandbox();
  const repository = path.join(sb.dir, 'agentic-kit');
  fs.mkdirSync(path.join(repository, '.git'), { recursive: true });
  fs.writeFileSync(path.join(sb.codex, 'rollout-2026-08-02T10-00-00-old.jsonl'), line({
    type: 'session_meta', timestamp: '2026-08-02T10:00:00Z',
    payload: { id: 'old', model: 'gpt-x', cwd: repository },
  }));
  const service = new LiveSessionsService({
    roots: sb.roots, readCodexState: () => null, runtimeScanMs: 0,
    readActiveSessions: () => [{
      pid: 33, startedAt: '2026-08-03T16:00:00Z', host: 'codex', cwd: repository,
    }],
    now: () => '2026-08-03T16:01:00Z',
  });
  t.after(() => service.close());
  service.start();
  const sessions = service.snapshot().sessions;
  assert.ok(sessions.some((session) => session.id === 'old'
    && session.presence.state !== 'present'));
  assert.ok(sessions.some((session) => session.id.startsWith('runtime-')
    && session.presence.state === 'present'));
});

test('runtime presence stays synthetic when same-repository transcript identity is ambiguous', (t) => {
  const sb = sandbox();
  const repository = path.join(sb.dir, 'keel');
  fs.mkdirSync(path.join(repository, '.git'), { recursive: true });
  for (const id of ['candidate-a', 'candidate-b']) {
    fs.writeFileSync(path.join(sb.claude, `${id}.jsonl`), line({
      type: 'user', sessionId: id, timestamp: '2026-08-03T16:00:30Z',
      cwd: repository, message: { model: 'claude-x', content: 'private' },
    }));
  }
  const service = new LiveSessionsService({
    roots: sb.roots, readCodexState: () => null, runtimeScanMs: 0,
    readActiveSessions: () => [{
      pid: 34, startedAt: '2026-08-03T16:00:00Z', host: 'claude', cwd: repository,
    }],
    now: () => '2026-08-03T16:01:00Z',
  });
  t.after(() => service.close());
  service.start();
  const sessions = service.snapshot().sessions;
  assert.equal(sessions.filter((session) => session.presence.state === 'present').length, 1);
  assert.ok(sessions.find((session) => session.presence.state === 'present')
    .id.startsWith('runtime-'));
  assert.ok(sessions.filter((session) => session.id.startsWith('candidate-'))
    .every((session) => session.presence.state !== 'present'));
});

// Non-Git folders (#238 item 2, decision 2). A plain folder's project key is a
// hash of its name only, so a process may lease a transcript session only when
// both come from exactly the same folder.
const plainFolderService = (t, sb, readActiveSessions, extra = {}) => {
  let tick = null;
  const options = {
    roots: sb.roots, readCodexState: () => null, workspaceStore: null, runtimeScanMs: 0,
    resolveClaudeProvider: () => null, readActiveSessions,
    setInterval: (fn) => { tick = fn; return { unref() {} }; }, clearInterval: () => {},
    now: () => '2026-09-25T01:16:00Z', ...extra,
  };
  // A workspace file means "use the real store", which needs no injected one.
  if (extra.workspaceFile) delete options.workspaceStore;
  const service = new LiveSessionsService(options);
  t.after(() => { service.close(); fs.rmSync(sb.dir, { recursive: true, force: true }); });
  return { service, tick: () => tick() };
};
const plainFolders = (sb) => {
  const a = path.join(sb.dir, 'a', 'scratch');
  const b = path.join(sb.dir, 'b', 'scratch');
  fs.mkdirSync(a, { recursive: true });
  fs.mkdirSync(b, { recursive: true });
  fs.writeFileSync(path.join(sb.claude, 'S1.jsonl'), line({
    type: 'user', sessionId: 'S1', cwd: a, timestamp: '2026-09-25T01:15:30Z',
    message: { role: 'user', content: 'private prompt' },
  }));
  return { a, b };
};
const PROCESS_START = '2026-09-25T01:15:00Z';
const sessionS1 = (service) => service.snapshot().sessions.find((session) => session.id === 'S1');

test('a process in a non-Git folder leases the transcript session from exactly that folder', (t) => {
  const sb = sandbox();
  const { a } = plainFolders(sb);
  const { service } = plainFolderService(t, sb,
    () => [{ pid: 4242, host: 'claude', cwd: a, startedAt: PROCESS_START }]);
  service.start();
  assert.equal(sessionS1(service).presence.state, 'present', 'a waiting session in a plain folder stays in Live');
  assert.deepEqual(service.snapshot().sessions.map((session) => session.id), ['S1'],
    'the process is bound to its transcript, not shown as a second session');
});

test('a process in a same-named but different non-Git folder never leases the session', (t) => {
  const sb = sandbox();
  const { b } = plainFolders(sb);
  const { service } = plainFolderService(t, sb,
    () => [{ pid: 4242, host: 'claude', cwd: b, startedAt: PROCESS_START }]);
  service.start();
  assert.notEqual(sessionS1(service).presence.state, 'present', 'same basename is not the same folder');
  assert.deepEqual(service.snapshot().sessions.map((session) => session.id), ['S1'],
    'an unmatched plain-folder process gets no runtime-only session keyed by its name');
});

test('an exact-folder match compares real paths, so a symlinked cwd still matches', (t) => {
  const sb = sandbox();
  plainFolders(sb);
  const alias = path.join(sb.dir, 'alias');
  fs.symlinkSync(path.join(sb.dir, 'a'), alias, process.platform === 'win32' ? 'junction' : 'dir');
  const { service } = plainFolderService(t, sb,
    () => [{ pid: 4242, host: 'claude', cwd: path.join(alias, 'scratch'), startedAt: PROCESS_START }]);
  service.start();
  assert.equal(sessionS1(service).presence.state, 'present');
});

test('a bound plain-folder process that moves to a same-named folder loses the lease', (t) => {
  const sb = sandbox();
  const { a, b } = plainFolders(sb);
  let cwd = a;
  const { service, tick } = plainFolderService(t, sb,
    () => [{ pid: 4242, host: 'claude', cwd, startedAt: PROCESS_START }]);
  service.start();
  assert.equal(sessionS1(service).presence.state, 'present');
  cwd = b;
  for (let survey = 0; survey < 3; survey++) tick();
  assert.notEqual(sessionS1(service).presence.state, 'present',
    'the prior binding is re-checked against the folder, not only the name-based project key');
});

test('the exact-folder correlator never reaches the snapshot, events, or workspace store', (t) => {
  const sb = sandbox();
  const { a } = plainFolders(sb);
  const workspaceFile = path.join(sb.dir, 'observability-workspaces.json');
  const { service, tick } = plainFolderService(t, sb,
    () => [{ pid: 4242, host: 'claude', cwd: a, startedAt: PROCESS_START }], { workspaceFile });
  const events = [];
  service.subscribe((event) => events.push(event));
  service.start();
  tick();
  assert.equal(sessionS1(service).presence.state, 'present');
  assert.ok(fs.existsSync(workspaceFile), 'guard: the workspace store was written, so it is really checked');
  const surfaces = [JSON.stringify(service.snapshot()), JSON.stringify(events),
    JSON.stringify(service.replay()), fs.readFileSync(workspaceFile, 'utf8')];
  for (const surface of surfaces) {
    assert.doesNotMatch(surface, /[a-f0-9]{64}/, 'no keyed folder digest is published or persisted');
    for (const fragment of [sb.dir, fs.realpathSync(sb.dir)]) assert.ok(!surface.includes(fragment));
  }
});

test('runtime-only Claude sessions resolve provider identity without host inference', (t) => {
  const sb = sandbox();
  const repository = path.join(sb.dir, 'emailibrium');
  fs.mkdirSync(path.join(repository, '.git'), { recursive: true });
  const asked = [];
  const service = new LiveSessionsService({
    roots: sb.roots, readCodexState: () => null, runtimeScanMs: 0,
    readActiveSessions: () => [{
      pid: 31, startedAt: '2026-08-03T16:00:00Z', host: 'claude', cwd: repository,
    }],
    resolveClaudeProvider: ({ cwd }) => {
      asked.push(cwd);
      return { provider: 'bedrock', provenance: 'configured' };
    },
    now: () => '2026-08-03T16:00:00Z',
  });
  t.after(() => service.close());
  service.start();
  const session = service.snapshot().sessions[0];
  const actor = session.nodes.find((node) => node.kind === 'session');
  assert.deepEqual(asked, [repository]);
  assert.equal(actor.provider, 'bedrock');
  assert.equal(actor.providerProvenance, 'configured');
  assert.equal(session.coverage.providerIdentity, 'configured');
});

test('runtime survey failures preserve a bounded grace then expire prior leases', async (t) => {
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
  for (let attempt = 1; attempt <= 3; attempt++) {
    tick();
    await waitUntil(() => service.snapshot().health.runtime.errors === attempt);
    assert.equal(service.snapshot().projects[0].liveCount, attempt < 3 ? 1 : 0);
  }
  assert.equal(service.snapshot().sessions[0].lifecycle, 'quiescent');
  assert.equal(service.snapshot().sessions[0].presence.evidence, 'unknown');
  assert.equal(service.snapshot().health.runtime.lastError, 'ERR_RUNTIME_TEST');
  fail = false;
  tick();
  await waitUntil(() => service.snapshot().projects[0].liveCount === 1);
  assert.equal(service.snapshot().sessions[0].presence.evidence, 'observed');
  assert.equal(service.snapshot().health.runtime.status, 'ok');
});

test('OpenCode workspace metadata persists as historical evidence across restarts', (t) => {
  const sb = sandbox();
  const repository = path.join(sb.dir, 'opencode-repo');
  const workspaceFile = path.join(sb.dir, 'observability-workspaces.json');
  fs.mkdirSync(path.join(repository, '.git'), { recursive: true });
  const workspace = {
    key: 'workspace:0123456789abcdef', repositoryLabel: 'opencode-repo',
    directoryLabel: 'repo root', branchLabel: 'feature/opencode', branchState: 'attached',
    changes: { additions: 12, deletions: 3, files: 2, binaryFiles: 0,
      basis: 'tracked-vs-head', completeness: 'untracked-and-binary-lines-excluded',
      capturedAt: '2026-08-03T16:00:00Z' },
    capturedAt: '2026-08-03T16:00:00Z', source: 'git', confidence: 'observed',
  };
  const live = new LiveSessionsService({
    roots: sb.roots, workspaceFile, readCodexState: () => null, runtimeScanMs: 0,
    readActiveSessions: () => [{
      pid: 40, startedAt: '2026-08-03T16:00:00Z', host: 'opencode',
      cwd: repository, workspace,
    }],
    now: () => '2026-08-03T16:00:00Z',
  });
  live.start();
  assert.equal(live.snapshot().projects[0].liveCount, 1);
  assert.equal(live.snapshot().sessions[0].workspace.branchLabel, 'feature/opencode');
  live.close();

  const history = new LiveSessionsService({
    roots: sb.roots, workspaceFile, readCodexState: () => null,
    readActiveSessions: () => [], now: () => '2026-08-03T17:00:00Z',
  });
  t.after(() => history.close());
  history.start();
  const restored = history.snapshot().sessions.find((session) => session.host === 'opencode');
  assert.equal(restored.workspace.branchLabel, 'feature/opencode');
  assert.equal(restored.workspace.changes.additions, 12);
  assert.equal(restored.presence.state, 'unknown');
  assert.equal(history.snapshot().projects[0].liveCount, 0);
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

test('historySnapshot() date-windows a one-shot scan without disturbing the live tailer', (t) => {
  const sb = sandbox();
  const now = Date.parse('2026-08-06T12:00:00Z');
  const recent = path.join(sb.claude, 'recent.jsonl');
  const old = path.join(sb.claude, 'old.jsonl');
  fs.writeFileSync(recent, line({
    type: 'user', sessionId: 'recent', timestamp: '2026-08-06T11:00:00Z',
    cwd: '/Users/private-user/work/visible-project',
    message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
  }));
  fs.writeFileSync(old, line({
    type: 'user', sessionId: 'old', timestamp: '2026-01-01T11:00:00Z',
    cwd: '/Users/private-user/work/other-project',
    message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
  }));
  // discoverJsonl sorts/filters by mtime, not the record's own timestamp —
  // stamp the file itself so the sinceMs cutoff below has something real to bite on.
  const oldMs = Date.parse('2026-01-01T11:00:00Z') / 1000;
  fs.utimesSync(old, oldMs, oldMs);

  const service = new LiveSessionsService({
    roots: sb.roots, intervalMs: 10, readCodexState: () => null, now: () => new Date(now).toISOString(),
  });
  t.after(() => service.close());

  // A 1-day window sees only the recent file.
  const windowed = service.historySnapshot({ sinceMs: now - 86_400_000 });
  assert.deepEqual(windowed.sessions.map((s) => s.id), ['recent']);
  // "all time" (sinceMs omitted) sees both.
  const all = service.historySnapshot();
  assert.deepEqual(all.sessions.map((s) => s.id).sort(), ['old', 'recent']);

  // A one-shot scan of an unterminated session must never read as "live" —
  // it would otherwise vanish from the History browser's session list, which
  // explicitly filters OUT anything still reading as live.
  assert.equal(windowed.projects[0].liveCount, 0);
  assert.equal(windowed.sessions[0].activity.state, 'idle');

  // The live tailer's own state is untouched: it was never start()ed, so its
  // projection is still empty — historySnapshot() must not have populated it.
  assert.deepEqual(service.snapshot().sessions, []);
});

test('historyPage() pages the complete cross-host set after materialization', (t) => {
  const sb = sandbox();
  for (let index = 0; index < 1001; index++) {
    const id = `claude-${String(index).padStart(4, '0')}`;
    fs.writeFileSync(path.join(sb.claude, `${id}.jsonl`), line({
      type: 'user', sessionId: id, timestamp: '2026-08-01T10:00:00Z',
      cwd: '/Users/private-user/work/claude-project', message: { role: 'user' },
    }));
  }
  const codexFile = path.join(sb.codex, 'rollout-2026-08-02T10-00-00-codex.jsonl');
  fs.writeFileSync(codexFile, line({
    type: 'session_meta', timestamp: '2026-08-02T10:00:00Z',
    payload: { id: 'codex-1', cwd: '/Users/private-user/work/codex-project', model_provider: 'openai' },
  }));
  const service = new LiveSessionsService({
    roots: sb.roots, readCodexState: () => null,
    now: () => '2026-08-03T12:00:00Z',
  });
  t.after(() => service.close());

  const all = service.historySnapshot();
  assert.equal(all.sessions.length, 1002, 'history must not apply the live 100-session bound');
  assert.equal(all.coverage.complete, true);
  assert.equal(all.coverage.sources.claude.returnedFiles, 1001);
  assert.equal(all.coverage.sources.codex.returnedFiles, 1);

  const seen = new Set();
  let page = service.historyPage({ limit: 100 });
  while (page) {
    for (const session of page.sessions) {
      assert.equal(seen.has(session.key), false, `duplicate session ${session.key}`);
      seen.add(session.key);
    }
    if (!page.pagination.hasMore) break;
    page = service.historyPage({ limit: 100, pageToken: page.pagination.nextPageToken });
  }
  assert.equal(seen.size, 1002);
  assert.equal([...seen].filter((key) => key.startsWith('claude:')).length, 1001);
  assert.equal([...seen].filter((key) => key.startsWith('codex:')).length, 1);
});

test('service coverage retains dropped-line evidence when a different source is healthy', async (t) => {
  const sb = sandbox();
  const file = path.join(sb.claude, 'bad.jsonl');
  fs.writeFileSync(file, '');
  fs.writeFileSync(path.join(sb.claude, 'good.jsonl'), '');
  const service = new LiveSessionsService({ roots: sb.roots, intervalMs: 10, readCodexState: () => null });
  t.after(() => { service.close(); fs.rmSync(sb.dir, { recursive: true, force: true }); });
  service.start();
  fs.appendFileSync(file, 'x'.repeat(1024 * 1024 + 1) + '\n');
  await waitUntil(() => service.snapshot().acquisitionCoverage.truncated, 'missing live acquisition coverage');
  const coverage = service.snapshot().acquisitionCoverage;
  assert.equal(coverage.complete, false);
  assert.equal(coverage.droppedLines, 1);
});

test('live coverage is incomplete when the discovery file cap binds, and says how many were left out', (t) => {
  const sb = sandbox();
  for (let i = 0; i < 10; i++) {
    const file = path.join(sb.claude, `session-${i}.jsonl`);
    fs.writeFileSync(file, '');
    fs.utimesSync(file, new Date(1_000 + i * 1_000), new Date(1_000 + i * 1_000));
  }
  fs.writeFileSync(path.join(sb.codex, 'rollout-2026-07-27T00-00-00-x1.jsonl'), '');
  const service = new LiveSessionsService({
    roots: sb.roots, maxFiles: 4, readCodexState: () => null, workspaceStore: null,
    setInterval: () => ({ unref() {} }), clearInterval: () => {},
    now: () => '2026-07-27T12:00:00Z',
  });
  t.after(() => { service.close(); fs.rmSync(sb.dir, { recursive: true, force: true }); });
  service.start();
  const coverage = service.snapshot().acquisitionCoverage;
  assert.equal(coverage.complete, false, 'a capped window is not complete coverage');
  assert.equal(coverage.truncated, true);
  assert.equal(coverage.omittedFiles, 8);
  assert.deepEqual(coverage.sources, {
    claude: { candidateFiles: 10, returnedFiles: 2, fileLimit: 2, truncated: true },
    codex: { candidateFiles: 1, returnedFiles: 1, fileLimit: 2, truncated: false },
  });
  const health = service.snapshot().health;
  assert.equal(health.claude.files, 2);
  assert.equal(health.claude.candidateFiles, 10, 'Sources can say the tailed files are the newest of more');
  assert.equal(health.codex.candidateFiles, 1);
});

test('live coverage stays complete when every discovered file fits the cap', (t) => {
  const sb = sandbox();
  fs.writeFileSync(path.join(sb.claude, 'only.jsonl'), '');
  const service = new LiveSessionsService({
    roots: sb.roots, maxFiles: 4, readCodexState: () => null, workspaceStore: null,
    setInterval: () => ({ unref() {} }), clearInterval: () => {},
    now: () => '2026-07-27T12:00:00Z',
  });
  t.after(() => { service.close(); fs.rmSync(sb.dir, { recursive: true, force: true }); });
  service.start();
  const coverage = service.snapshot().acquisitionCoverage;
  assert.equal(coverage.complete, true);
  assert.equal(coverage.truncated, false);
  assert.equal(coverage.omittedFiles, 0);
});

test('the files counter does not drift across idle stop and restart', (t) => {
  const sb = sandbox();
  for (let i = 0; i < 3; i++) fs.writeFileSync(path.join(sb.claude, `s${i}.jsonl`), '');
  const service = new LiveSessionsService({
    roots: sb.roots, maxFiles: 4, readCodexState: () => null, workspaceStore: null,
    setInterval: () => ({ unref() {} }), clearInterval: () => {},
    now: () => '2026-07-27T12:00:00Z',
  });
  t.after(() => { service.close(); fs.rmSync(sb.dir, { recursive: true, force: true }); });
  const files = [];
  for (let cycle = 0; cycle < 3; cycle++) {
    service.start();
    files.push(service.snapshot().health.claude.files);
    service.close();
  }
  assert.deepEqual(files, [2, 2, 2], 'the dashboard reuses one service; each restart must recount, not add');
});

test('the files counter follows the moving newest-file window', (t) => {
  const sb = sandbox();
  let tick;
  const add = (i) => {
    const file = path.join(sb.claude, `s${i}.jsonl`);
    fs.writeFileSync(file, '');
    fs.utimesSync(file, new Date(1_000 + i * 1_000), new Date(1_000 + i * 1_000));
  };
  for (let i = 0; i < 3; i++) add(i);
  const service = new LiveSessionsService({
    roots: sb.roots, maxFiles: 4, readCodexState: () => null, workspaceStore: null,
    setInterval: (fn) => { tick = fn; return { unref() {} }; }, clearInterval: () => {},
    now: () => '2026-07-27T12:00:00Z',
  });
  t.after(() => { service.close(); fs.rmSync(sb.dir, { recursive: true, force: true }); });
  service.start();
  const seen = [service.snapshot().health.claude.files];
  for (let i = 3; i < 6; i++) { add(i); tick(); seen.push(service.snapshot().health.claude.files); }
  assert.deepEqual(seen, [2, 2, 2, 2]);
});

// Idle stop and restart (#238 item 4). The dashboard reuses one service: it
// calls close() 30 s after the last Live client leaves and start() on the next
// visit. A restart must resume every tailed file where it stopped.
const idleService = (t, sb, extra = {}) => {
  let tick = null;
  const service = new LiveSessionsService({
    roots: sb.roots, readCodexState: () => null, workspaceStore: null,
    setInterval: (fn) => { tick = fn; return { unref() {} }; }, clearInterval: () => {},
    now: () => '2026-09-25T01:16:00Z', ...extra,
  });
  t.after(() => { service.close(); fs.rmSync(sb.dir, { recursive: true, force: true }); });
  const actions = [];
  service.subscribe((event) => actions.push(event.action));
  return { service, actions, tick: () => tick() };
};
const GAP_SESSION = '0199aaaa-bbbb-7ccc-8ddd-eeeeffff0002';
const rolloutMeta = (id = GAP_SESSION) => line({
  type: 'session_meta', timestamp: '2026-09-25T01:00:00Z', payload: { id, cwd: '/private/project' },
});
const functionCall = (callId) => line({
  type: 'response_item', timestamp: '2026-09-25T01:15:01Z',
  payload: { type: 'function_call', name: 'exec_command', call_id: callId, arguments: '{}' },
});
const toolNodes = (service, id = GAP_SESSION) => (service.snapshot().sessions
  .find((session) => session.id === id)?.nodes ?? []).filter((node) => node.kind === 'tool');

test('operations appended while Live is idle-stopped appear after restart', (t) => {
  const sb = sandbox();
  const file = path.join(sb.codex, `rollout-2026-09-25T01-00-00-${GAP_SESSION}.jsonl`);
  fs.writeFileSync(file, rolloutMeta());
  const { service, actions } = idleService(t, sb);
  service.start();
  service.close();
  fs.appendFileSync(file, functionCall('during-gap'));
  service.start();
  assert.equal(toolNodes(service).length, 1, 'an operation appended during the idle stop must not be lost');
  assert.equal(actions.filter((action) => action === 'session.discovered').length, 1,
    'a restart resumes the tailed file; it does not rediscover the session');
});

test('a transcript created while Live is idle-stopped is read from its first byte on restart', (t) => {
  const sb = sandbox();
  const { service } = idleService(t, sb);
  service.start();
  service.close();
  fs.writeFileSync(path.join(sb.codex, `rollout-2026-09-25T01-00-00-${GAP_SESSION}.jsonl`),
    rolloutMeta() + functionCall('in-new-file'));
  service.start();
  assert.equal(toolNodes(service).length, 1, 'a file that appeared after observation began holds only new work');
});

test('a partial record at idle stop completes after restart', (t) => {
  const sb = sandbox();
  const file = path.join(sb.codex, `rollout-2026-09-25T01-00-00-${GAP_SESSION}.jsonl`);
  fs.writeFileSync(file, rolloutMeta());
  const { service, tick } = idleService(t, sb);
  service.start();
  const record = functionCall('split');
  const half = Math.floor(record.length / 2);
  fs.appendFileSync(file, record.slice(0, half));
  tick();
  service.close();
  fs.appendFileSync(file, record.slice(half));
  service.start();
  assert.equal(toolNodes(service).length, 1, 'the buffered first half is kept across the stop');
});

test('live coverage says since when Live has been watching, across idle restarts', (t) => {
  const sb = sandbox();
  let now = '2026-09-25T01:00:00.000Z';
  const { service } = idleService(t, sb, { now: () => now });
  assert.equal(service.snapshot().acquisitionCoverage.observedSince, null, 'nothing is observed before start');
  service.start();
  assert.equal(service.snapshot().acquisitionCoverage.observedSince, '2026-09-25T01:00:00.000Z');
  service.close();
  now = '2026-09-25T02:00:00.000Z';
  service.start();
  assert.equal(service.snapshot().acquisitionCoverage.observedSince, '2026-09-25T01:00:00.000Z',
    'offsets are kept across the idle stop, so observation is continuous');
});

// Structured-source health acceptance (#237 §E). Each case drives the real
// service and tailer through a manual reconcile tick so every pass is explicit.
const structuredService = (t, sources, extra = {}) => {
  const sb = sandbox();
  let tick = null;
  const service = new LiveSessionsService({
    roots: sb.roots, cwd: sb.dir, readCodexState: () => null, workspaceStore: null,
    structuredSources: sources(sb.dir),
    setInterval: (fn) => { tick = fn; return { unref() {} }; }, clearInterval: () => {},
    now: () => '2026-09-26T12:00:00Z', ...extra,
  });
  t.after(() => { service.close(); fs.rmSync(sb.dir, { recursive: true, force: true }); });
  service.start();
  return { sb, service, tick: () => tick(), health: () => service.snapshot().health };
};
const record = (fields = {}) => line({
  sessionId: 'qe-1', agentId: 'gate-1', action: 'gate.completed', status: 'completed', ...fields,
});
const canTestPermissions = process.platform !== 'win32' && process.getuid?.() !== 0;
const pick = ({ status, files, readable, missing, unreadable, events, errors }) => ({
  status, files, readable, missing, unreadable, events, errors,
});

test('an absent structured source reports awaiting file, never ok', (t) => {
  const { health } = structuredService(t, (dir) => [{ surface: 'ruflo', file: path.join(dir, 'ruflo.jsonl') }]);
  assert.deepEqual(pick(health().ruflo), {
    status: 'awaiting-file', files: 1, readable: 0, missing: 1, unreadable: 0, events: 0, errors: 0,
  });
});

test('an empty structured source is readable but reports no events yet', (t) => {
  const { health } = structuredService(t, (dir) => {
    fs.writeFileSync(path.join(dir, 'aqe.jsonl'), '');
    return [{ surface: 'aqe', file: path.join(dir, 'aqe.jsonl') }];
  });
  assert.deepEqual(pick(health().aqe), {
    status: 'no-events', files: 1, readable: 1, missing: 0, unreadable: 0, events: 0, errors: 0,
  });
});

test('a valid structured record is accepted and makes the source ok', (t) => {
  const { sb, tick, health } = structuredService(t, (dir) => {
    fs.writeFileSync(path.join(dir, 'aqe.jsonl'), '');
    return [{ surface: 'aqe', file: path.join(dir, 'aqe.jsonl') }];
  });
  fs.appendFileSync(path.join(sb.dir, 'aqe.jsonl'), record());
  tick();
  assert.equal(health().aqe.status, 'ok');
  assert.equal(health().aqe.accepted, 1);
  assert.equal(health().aqe.rejected, 0);
  assert.equal(health().aqe.lastAcceptedAt, '2026-09-26T12:00:00Z');
});

test('a schema-invalid structured record is rejected with a reason and no record content', (t) => {
  const { sb, tick, health } = structuredService(t, (dir) => {
    fs.writeFileSync(path.join(dir, 'aqe.jsonl'), '');
    return [{ surface: 'aqe', file: path.join(dir, 'aqe.jsonl') }];
  });
  fs.appendFileSync(path.join(sb.dir, 'aqe.jsonl'),
    line({ sessionId: 'qe-1', agentId: 'gate-1', secret: 'PRIVATE BODY' }));
  tick();
  assert.equal(health().aqe.status, 'degraded', 'a source whose records are all rejected is not operational');
  assert.equal(health().aqe.rejected, 1);
  assert.equal(health().aqe.accepted, 0);
  assert.equal(health().aqe.lastRejection, 'missing-action');
  assert.ok(!JSON.stringify(health()).includes('PRIVATE BODY'));
  fs.appendFileSync(path.join(sb.dir, 'aqe.jsonl'), record());
  tick();
  assert.equal(health().aqe.status, 'ok', 'a later accepted record restores the source');
  assert.equal(health().aqe.rejected, 1, 'the rejection count is kept');
});

test('a malformed line keeps the source degraded within and after the same pass', (t) => {
  const { sb, tick, health } = structuredService(t, (dir) => {
    fs.writeFileSync(path.join(dir, 'ruflo.jsonl'), '');
    return [{ surface: 'ruflo', file: path.join(dir, 'ruflo.jsonl') }];
  });
  fs.appendFileSync(path.join(sb.dir, 'ruflo.jsonl'), '{not json\n');
  tick();
  assert.equal(health().ruflo.status, 'degraded', 'ok must not overwrite the error from the same pass');
  assert.equal(health().ruflo.errors, 1);
  assert.equal(health().ruflo.lastError, 'invalid-json');
  tick();
  assert.equal(health().ruflo.status, 'degraded', 'nothing has been accepted since the error');
  fs.appendFileSync(path.join(sb.dir, 'ruflo.jsonl'), record());
  tick();
  assert.equal(health().ruflo.status, 'ok');
  assert.equal(health().ruflo.errors, 1);
});

test('an unreadable structured source is degraded with its error category', { skip: !canTestPermissions }, (t) => {
  let file;
  const { tick, health } = structuredService(t, (dir) => {
    file = path.join(dir, 'aqe.jsonl');
    fs.writeFileSync(file, record());
    fs.chmodSync(file, 0o000);
    return [{ surface: 'aqe', file }];
  });
  t.after(() => { try { fs.chmodSync(file, 0o600); } catch { /* removed */ } });
  tick();
  assert.deepEqual(pick(health().aqe), {
    status: 'degraded', files: 1, readable: 0, missing: 0, unreadable: 1, events: 0, errors: 1,
  });
  assert.equal(health().aqe.lastError, 'EACCES');
  fs.chmodSync(file, 0o600);
  tick();
  assert.equal(health().aqe.status, 'no-events', 'restored access clears the unreadable state');
  assert.equal(health().aqe.readable, 1);
});

test('records in a structured source created after start are all ingested', (t) => {
  const { sb, tick, health } = structuredService(t, (dir) => [{ surface: 'aqe', file: path.join(dir, 'late.jsonl') }]);
  assert.equal(health().aqe.status, 'awaiting-file');
  fs.writeFileSync(path.join(sb.dir, 'late.jsonl'),
    record({ agentId: 'a1' }) + record({ agentId: 'a2' }) + record({ agentId: 'a3' }));
  tick();
  assert.equal(health().aqe.status, 'ok');
  assert.equal(health().aqe.accepted, 3, 'late creation is legitimate; none of its records may be skipped');
});

test('removal, recreation, truncation, and rotation keep structured health truthful', (t) => {
  const { sb, tick, health } = structuredService(t, (dir) => {
    fs.writeFileSync(path.join(dir, 'ruflo.jsonl'), '');
    return [{ surface: 'ruflo', file: path.join(dir, 'ruflo.jsonl') }];
  });
  const file = path.join(sb.dir, 'ruflo.jsonl');
  fs.appendFileSync(file, record({ agentId: 'first' }));
  tick();
  assert.equal(health().ruflo.accepted, 1);

  fs.rmSync(file);
  tick();
  assert.equal(health().ruflo.status, 'awaiting-file', 'a removed source is awaiting, not ok');
  assert.equal(health().ruflo.missing, 1);
  fs.writeFileSync(file, record({ agentId: 'recreated' }));
  tick();
  assert.equal(health().ruflo.status, 'ok');
  assert.equal(health().ruflo.accepted, 2, 'the recreated file is read from its beginning');

  fs.truncateSync(file, 0);
  tick();
  fs.appendFileSync(file, record({ agentId: 'after-truncation' }));
  tick();
  assert.equal(health().ruflo.accepted, 3);

  fs.renameSync(file, `${file}.1`);
  fs.writeFileSync(file, record({ agentId: 'rotated' }));
  tick();
  assert.equal(health().ruflo.accepted, 4);
  assert.equal(health().ruflo.status, 'ok');
});

test('multiple structured sources report mixed health per surface', (t) => {
  const { sb, tick, health } = structuredService(t, (dir) => {
    fs.writeFileSync(path.join(dir, 'ruflo-a.jsonl'), '');
    fs.writeFileSync(path.join(dir, 'aqe.jsonl'), '');
    return [
      { surface: 'ruflo', file: path.join(dir, 'ruflo-a.jsonl') },
      { surface: 'ruflo', file: path.join(dir, 'ruflo-missing.jsonl') },
      { surface: 'aqe', file: path.join(dir, 'aqe.jsonl') },
    ];
  });
  fs.appendFileSync(path.join(sb.dir, 'ruflo-a.jsonl'), record());
  fs.appendFileSync(path.join(sb.dir, 'aqe.jsonl'), record());
  tick();
  assert.deepEqual(pick(health().ruflo), {
    status: 'awaiting-file', files: 2, readable: 1, missing: 1, unreadable: 0, events: 1, errors: 0,
  }, 'one ingesting source must not hide a missing one');
  assert.equal(health().aqe.status, 'ok');
});
