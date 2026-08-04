import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createLiveEvent, LiveReplayStream, emptyLiveProjection,
  reduceLiveEvent, resolveProjectIdentity, resolveProjectLabel, serializeLiveProjection,
  sweepLiveProjection, stableProjectKey,
} from '../../src/lib/live/index.mjs';

const base = (over = {}) => ({
  sessionId: 's1', observedAt: '2026-07-27T12:00:00Z',
  host: 'claude', surface: 'native',
  actor: { id: 's1', kind: 'session', provider: 'anthropic' },
  action: 'session.started', status: 'running',
  source: { adapter: 'fixture', confidence: 'observed' },
  ...over,
});

test('event schema constructs an allowlisted DTO and cannot leak transcript content', () => {
  const event = createLiveEvent({
    ...base(), prompt: 'secret prompt', message: { content: 'secret response' },
    source: { adapter: 'fixture', confidence: 'observed', raw: 'secret' },
    attributes: { durationMs: -5, toolCategory: 'Read', arguments: '/private/file' },
  });
  assert.equal(event.schemaVersion, 1);
  assert.equal(event.attributes.durationMs, 0);
  assert.equal(event.attributes.toolCategory, 'Read');
  const json = JSON.stringify(event);
  for (const secret of ['secret prompt', 'secret response', '/private/file']) {
    assert.ok(!json.includes(secret));
  }
});

test('event schema rejects records without stable correlation keys', () => {
  assert.throws(() => createLiveEvent({ action: 'x', actor: { id: 'a' } }), /sessionId/);
});

test('event schema preserves explicit blocked evidence', () => {
  assert.equal(createLiveEvent(base({ status: 'blocked' })).status, 'blocked');
});

test('event schema preserves retired compatibility provenance as internal', () => {
  assert.equal(createLiveEvent(base({ surface: 'dual-run' })).surface, 'internal');
});

test('event schema assigns privacy-safe project and host-qualified session identities', () => {
  const event = createLiveEvent(base({
    sessionId: 'shared:id',
    project: '/Users/private/work/Visible Project',
  }));
  assert.equal(event.project, 'Visible Project');
  assert.equal(event.projectKey, stableProjectKey('Visible Project'));
  assert.equal(event.sessionKey, 'claude:shared:id');
  assert.ok(!JSON.stringify(event).includes('/Users/private'));
});

test('project identity resolves linked and retained worktrees to their owning repository', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-live-project-'));
  const repository = path.join(root, 'agentic-kit');
  const worktree = path.join(root, 'm3-multi-provider-persona-grounding');
  fs.mkdirSync(worktree, { recursive: true });
  fs.writeFileSync(path.join(worktree, '.git'),
    `gitdir: ${path.join(repository, '.git', 'worktrees', 'm3')}\n`);

  assert.equal(resolveProjectLabel(worktree), 'agentic-kit');
  assert.equal(resolveProjectLabel(
    '/Development/agentic-kit/.claude/worktrees/m3-multi-provider-persona-grounding',
  ), 'agentic-kit');
  assert.equal(resolveProjectLabel('/Development/agentic-kit'), 'agentic-kit');
});

test('project identity resolves repository subdirectories to the repository root', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-live-project-'));
  const repository = path.join(root, 'tub-vault');
  fs.mkdirSync(path.join(repository, '.git'), { recursive: true });
  fs.mkdirSync(path.join(repository, 'scripts', 'lib'), { recursive: true });

  assert.equal(resolveProjectLabel(repository), 'tub-vault');
  assert.equal(resolveProjectLabel(path.join(repository, 'scripts')), 'tub-vault');
  assert.equal(resolveProjectLabel(path.join(repository, 'scripts', 'lib')), 'tub-vault');
});

test('canonical project keys distinguish unrelated same-named repositories', () => {
  const left = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-live-left-'));
  const right = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-live-right-'));
  const leftRepo = path.join(left, 'api');
  const rightRepo = path.join(right, 'api');
  fs.mkdirSync(path.join(leftRepo, '.git'), { recursive: true });
  fs.mkdirSync(path.join(rightRepo, '.git'), { recursive: true });
  const one = resolveProjectIdentity(leftRepo);
  const two = resolveProjectIdentity(rightRepo);
  assert.equal(one.label, 'api');
  assert.equal(two.label, 'api');
  assert.notEqual(one.key, two.key);
});

test('project identity prefers a real nested repository over worktree path heuristics', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-live-project-'));
  const outer = path.join(root, 'outer');
  const nested = path.join(outer, '.claude', 'worktrees', 'nested');
  fs.mkdirSync(path.join(outer, '.git'), { recursive: true });
  fs.mkdirSync(path.join(nested, '.git'), { recursive: true });
  const identity = resolveProjectIdentity(nested);
  assert.equal(identity.label, 'nested');
  assert.equal(identity.canonical, true);
});

test('project identity distinguishes unresolved paths and a repository literally named unknown', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-live-project-'));
  const repository = path.join(root, 'unknown');
  fs.mkdirSync(path.join(repository, '.git'), { recursive: true });
  assert.deepEqual(resolveProjectIdentity(path.join(root, 'scratch')).canonical, false);
  const identity = resolveProjectIdentity(repository);
  assert.equal(identity.canonical, true);
  assert.equal(identity.label, 'unknown repository');
});

test('project identity resolves subdirectories of a linked worktree to the owning repository', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-live-project-'));
  const repository = path.join(root, 'agentic-kit');
  const worktree = path.join(root, 'm3-persona-grounding');
  fs.mkdirSync(path.join(worktree, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(worktree, '.git'),
    `gitdir: ${path.join(repository, '.git', 'worktrees', 'm3')}\n`);

  assert.equal(resolveProjectLabel(path.join(worktree, 'scripts')), 'agentic-kit');
});

test('replay stream assigns monotonic ids, bounds history and detects stale cursors', () => {
  const stream = new LiveReplayStream({ capacity: 2, prefix: 'live' });
  const one = stream.publish(createLiveEvent(base()));
  const two = stream.publish(createLiveEvent(base({ action: 'agent.output' })));
  const three = stream.publish(createLiveEvent(base({ action: 'session.completed' })));
  assert.deepEqual([one.eventId, two.eventId, three.eventId], ['live:1', 'live:2', 'live:3']);
  assert.deepEqual(stream.replay().events.map((e) => e.eventId), ['live:2', 'live:3']);
  assert.deepEqual(stream.replay('live:2').events.map((e) => e.eventId), ['live:3']);
  assert.equal(stream.replay('live:1').reset, false);
  assert.equal(stream.replay('live:0').reset, true);
  assert.equal(stream.replay('wrong:2').reset, true);
});

test('projection adds typed nodes and stable relationship edges immutably', () => {
  const event = {
    ...createLiveEvent(base({
      action: 'agent.spawned', target: { id: 'child', kind: 'subagent' },
    })),
    eventId: 'ak:1', ingestSeq: 1,
  };
  const empty = emptyLiveProjection();
  const projection = reduceLiveEvent(empty, event);
  assert.equal(empty.sessions.size, 0);
  const json = serializeLiveProjection(projection);
  assert.equal(json.cursor, 'ak:1');
  assert.deepEqual(json.sessions[0].nodes.map((n) => n.id), ['s1', 'child']);
  assert.equal(json.sessions[0].edges[0].confidence, 'observed');
});

test('projection preserves safe display metadata and event provenance on resource nodes', () => {
  const started = {
    ...createLiveEvent(base({
      action: 'tool.started',
      target: { id: 'call-1', kind: 'tool', label: 'Read' },
      attributes: { toolCategory: 'Read' },
    })), eventId: 'ak:1',
  };
  const completed = {
    ...createLiveEvent(base({
      action: 'tool.completed', status: 'completed',
      target: { id: 'call-1', kind: 'tool' },
      attributes: { durationMs: 125 },
    })), eventId: 'ak:2',
  };
  const projection = reduceLiveEvent(reduceLiveEvent(emptyLiveProjection(), started), completed);
  const actor = projection.sessions.get('claude:s1').nodes.get('s1');
  const node = projection.sessions.get('claude:s1').nodes.get('call-1');
  assert.equal(actor.provider, 'anthropic');
  assert.equal(actor.providerProvenance, 'unknown');
  assert.equal(node.label, 'Read');
  assert.equal(node.status, 'completed');
  assert.equal(node.lastAction, 'tool.completed');
  assert.equal(node.sourceAdapter, 'fixture');
  assert.equal(node.durationMs, 125);
});

test('projection retains provider, provenance and model when later evidence lacks them', () => {
  const identified = {
    ...createLiveEvent(base({
      actor: { id: 's1', kind: 'session', provider: 'openai', model: 'gpt-x' },
      source: { adapter: 'fixture', confidence: 'observed', fields: { provider: 'observed' } },
    })), eventId: 'ak:1',
  };
  const anonymous = {
    ...createLiveEvent(base({
      actor: { id: 's1', kind: 'session' }, action: 'agent.output',
    })), eventId: 'ak:2',
  };
  const projection = reduceLiveEvent(reduceLiveEvent(emptyLiveProjection(), identified), anonymous);
  const node = projection.sessions.get('claude:s1').nodes.get('s1');
  assert.equal(node.provider, 'openai');
  assert.equal(node.providerProvenance, 'observed');
  assert.equal(node.model, 'gpt-x');
  assert.equal(node.lastAction, 'agent.output');
});

test('projection is idempotent by eventId and preserves terminal state', () => {
  const started = {
    ...createLiveEvent(base()), eventId: 'ak:1', ingestSeq: 1,
  };
  const completed = {
    ...createLiveEvent(base({ action: 'session.completed', status: 'completed' })),
    eventId: 'ak:2', ingestSeq: 2,
  };
  const lateRunning = {
    ...createLiveEvent(base({ action: 'agent.output', status: 'running' })),
    eventId: 'ak:3', ingestSeq: 3,
  };
  const one = reduceLiveEvent(emptyLiveProjection(), started);
  assert.equal(reduceLiveEvent(one, started), one);
  const final = reduceLiveEvent(reduceLiveEvent(one, completed), lateRunning);
  assert.equal(final.sessions.get('claude:s1').status, 'completed');
  assert.equal(final.sessions.get('claude:s1').nodes.get('s1').status, 'completed');
});

test('child-before-parent updates placeholder and clock skew does not regress cursor', () => {
  const childFirst = {
    ...createLiveEvent(base({
      action: 'agent.spawned', target: { id: 'child', kind: 'subagent' },
      observedAt: '2026-07-27T12:00:10Z',
    })), eventId: 'ak:1', ingestSeq: 1,
  };
  const childObserved = {
    ...createLiveEvent(base({
      actor: { id: 'child', kind: 'subagent', role: 'reviewer' },
      action: 'agent.output', observedAt: '2026-07-27T12:00:05Z',
    })), eventId: 'ak:2', ingestSeq: 2,
  };
  const projection = reduceLiveEvent(
    reduceLiveEvent(emptyLiveProjection(), childFirst), childObserved,
  );
  assert.equal(projection.cursor, 'ak:2');
  assert.equal(projection.sessions.get('claude:s1').nodes.get('child').role, 'reviewer');
});

test('later generic worker activity does not erase an authoritative ledger identity', () => {
  const spawned = {
    ...createLiveEvent(base({
      action: 'agent.spawned',
      target: { id: 'child', kind: 'subagent', label: 'Bohr', role: 'tester' },
    })), eventId: 'ak:1',
  };
  const active = {
    ...createLiveEvent(base({
      actor: { id: 'child', kind: 'subagent', role: 'worker' },
      action: 'agent.output',
    })), eventId: 'ak:2',
  };
  const projection = reduceLiveEvent(
    reduceLiveEvent(emptyLiveProjection(), spawned), active,
  );
  const child = projection.sessions.get('claude:s1').nodes.get('child');
  assert.equal(child.label, 'Bohr');
  assert.equal(child.role, 'tester');
});

test('metadata-only hierarchy evidence does not regress a running actor lifecycle', () => {
  const running = {
    ...createLiveEvent(base()), eventId: 'ak:1',
  };
  const hierarchy = {
    ...createLiveEvent(base({
      action: 'agent.spawned', status: 'unknown',
      target: { id: 'child', kind: 'subagent' },
    })), eventId: 'ak:2',
  };
  const projection = reduceLiveEvent(
    reduceLiveEvent(emptyLiveProjection(), running), hierarchy,
  );
  assert.equal(projection.sessions.get('claude:s1').nodes.get('s1').status, 'running');
});

test('field provenance can explicitly record an assumption without upgrading source confidence', () => {
  const event = createLiveEvent(base({
    source: {
      adapter: 'fixture', confidence: 'observed',
      fields: { provider: 'assumed' },
    },
  }));
  assert.equal(event.source.confidence, 'observed');
  assert.equal(event.source.fields.provider, 'assumed');
});

test('lifecycle sweep marks quiescent and expired but never completed', () => {
  const event = {
    ...createLiveEvent(base()), eventId: 'ak:1', ingestSeq: 1,
  };
  const active = reduceLiveEvent(emptyLiveProjection(), event);
  const quiet = sweepLiveProjection(active, {
    now: '2026-07-27T12:01:00Z', quiescentMs: 10_000, expiryMs: 120_000,
  });
  assert.equal(quiet.sessions.get('claude:s1').lifecycle, 'quiescent');
  assert.equal(quiet.sessions.get('claude:s1').status, 'running');
  const expired = sweepLiveProjection(quiet, {
    now: '2026-07-27T12:03:00Z', quiescentMs: 10_000, expiryMs: 120_000,
  });
  assert.equal(expired.sessions.get('claude:s1').lifecycle, 'expired');
  assert.equal(expired.sessions.get('claude:s1').status, 'running');
});

test('lifecycle sweep holds sessions with executing tools active until the pending window closes', () => {
  const running = { ...createLiveEvent(base()), eventId: 'ak:1' };
  const started = {
    ...createLiveEvent(base({
      action: 'tool.started',
      target: { id: 'call-1', kind: 'tool', label: 'Write' },
      attributes: { toolCategory: 'Write' },
    })), eventId: 'ak:2',
  };
  const active = reduceLiveEvent(reduceLiveEvent(emptyLiveProjection(), running), started);
  // Transcripts only append when a tool finishes; a 14-minute execution must
  // not demote the session even though expiryMs elapsed with no events.
  const midExecution = sweepLiveProjection(active, {
    now: '2026-07-27T12:14:00Z', quiescentMs: 10_000, expiryMs: 120_000,
  });
  assert.equal(midExecution.sessions.get('claude:s1').lifecycle, 'active');
  const abandoned = sweepLiveProjection(active, {
    now: '2026-07-27T13:00:00Z', quiescentMs: 10_000, expiryMs: 120_000,
    pendingExpiryMs: 1_800_000,
  });
  assert.equal(abandoned.sessions.get('claude:s1').lifecycle, 'expired');
});

test('lifecycle sweep resumes normal demotion once the pending tool completes', () => {
  const running = { ...createLiveEvent(base()), eventId: 'ak:1' };
  const started = {
    ...createLiveEvent(base({
      action: 'tool.started', target: { id: 'call-1', kind: 'tool' },
    })), eventId: 'ak:2',
  };
  const completed = {
    ...createLiveEvent(base({
      action: 'tool.completed', status: 'completed',
      target: { id: 'call-1', kind: 'tool' },
    })), eventId: 'ak:3',
  };
  const projection = [running, started, completed]
    .reduce((state, event) => reduceLiveEvent(state, event), emptyLiveProjection());
  const swept = sweepLiveProjection(projection, {
    now: '2026-07-27T12:14:00Z', quiescentMs: 10_000, expiryMs: 120_000,
  });
  assert.equal(swept.sessions.get('claude:s1').lifecycle, 'expired');
});

test('only fresh running execution evidence is active; ledger and unknown evidence are historical', () => {
  const unknown = {
    ...createLiveEvent(base({
      action: 'session.discovered', status: 'unknown',
      source: { adapter: 'codex-state', confidence: 'observed' },
    })), eventId: 'ak:1',
  };
  const ledgerRunning = {
    ...createLiveEvent(base({
      action: 'session.discovered', status: 'running',
      source: { adapter: 'codex-state', confidence: 'observed' },
    })), eventId: 'ak:2',
  };
  const freshRunning = {
    ...createLiveEvent(base({
      action: 'agent.output', status: 'running',
      source: { adapter: 'codex-rollout', confidence: 'observed' },
    })), eventId: 'ak:3',
  };
  const first = reduceLiveEvent(emptyLiveProjection(), unknown);
  assert.equal(first.sessions.get('claude:s1').lifecycle, 'historical');
  const second = reduceLiveEvent(first, ledgerRunning);
  assert.equal(second.sessions.get('claude:s1').lifecycle, 'historical');
  const active = reduceLiveEvent(second, freshRunning);
  assert.equal(active.sessions.get('claude:s1').lifecycle, 'active');
});

test('project live counts require both running status and active lifecycle', () => {
  let projection = emptyLiveProjection();
  for (const [id, status, adapter] of [
    ['unknown', 'unknown', 'codex-state'],
    ['ledger-running', 'running', 'codex-state'],
    ['fresh-running', 'running', 'codex-rollout'],
  ]) {
    projection = reduceLiveEvent(projection, {
      ...createLiveEvent(base({
        sessionId: id, project: 'demo', status,
        actor: { id, kind: 'session' },
        action: adapter === 'codex-state' ? 'session.discovered' : 'session.started',
        source: { adapter, confidence: 'observed' },
      })), eventId: `ak:${id}`,
    });
  }
  assert.equal(serializeLiveProjection(projection).projects[0].liveCount, 1);
});

test('synthetic load remains bounded in replay and projection', () => {
  const stream = new LiveReplayStream({ capacity: 100 });
  let projection = emptyLiveProjection();
  for (let i = 0; i < 2_000; i++) {
    const event = stream.publish(createLiveEvent(base({
      actor: { id: `agent-${i}`, kind: 'agent' }, action: 'agent.output',
    })));
    projection = reduceLiveEvent(projection, event);
  }
  assert.equal(stream.snapshot().events.length, 100);
  assert.equal(projection.sessions.get('claude:s1').nodes.size, 1_000);
});

test('projection bounds resource nodes while preferentially retaining semantic topology', () => {
  let projection = emptyLiveProjection();
  const semantic = [
    { id: 'session', kind: 'session' },
    { id: 'agent', kind: 'agent' },
    { id: 'child', kind: 'subagent' },
    { id: 'gate', kind: 'gate' },
  ];
  let seq = 0;
  for (const actor of semantic) {
    seq++;
    projection = reduceLiveEvent(projection, {
      ...createLiveEvent(base({
        sessionId: 'session', actor, action: 'agent.output',
      })), eventId: `ak:${seq}`,
    }, { maxNodesPerSession: 8 });
  }
  for (let i = 0; i < 50; i++) {
    seq++;
    projection = reduceLiveEvent(projection, {
      ...createLiveEvent(base({
        sessionId: 'session', actor: semantic[0], action: 'tool.completed',
        status: 'completed', target: { id: `tool-${i}`, kind: 'tool' },
      })), eventId: `ak:${seq}`,
    }, { maxNodesPerSession: 8 });
  }
  const nodes = projection.sessions.get('claude:session').nodes;
  assert.equal(nodes.size, 8);
  for (const id of semantic.map((node) => node.id)) assert.ok(nodes.has(id), id);
});

test('projection bounds total sessions and evicts terminal sessions first', () => {
  let projection = emptyLiveProjection();
  for (const [i, status] of ['completed', 'running', 'running'].entries()) {
    projection = reduceLiveEvent(projection, {
      ...createLiveEvent(base({
        sessionId: `s${i}`, actor: { id: `s${i}`, kind: 'session' }, status,
      })), eventId: `ak:${i}`,
    }, { maxSessions: 2 });
  }
  assert.deepEqual([...projection.sessions.keys()], ['claude:s1', 'claude:s2']);
});

test('projection keeps identical provider session IDs distinct and catalogs them by project', () => {
  const claude = {
    ...createLiveEvent(base({
      sessionId: 'same', project: '/private/one/Project Alpha',
      host: 'claude', actor: { id: 'same', kind: 'session', provider: 'anthropic' },
    })), eventId: 'ak:1',
  };
  const codex = {
    ...createLiveEvent(base({
      sessionId: 'same', project: 'Project Alpha', host: 'codex',
      actor: { id: 'same', kind: 'session', provider: 'openai' },
      action: 'session.completed', status: 'completed',
      observedAt: '2026-07-27T12:01:00Z',
    })), eventId: 'ak:2',
  };
  const snapshot = serializeLiveProjection(
    reduceLiveEvent(reduceLiveEvent(emptyLiveProjection(), claude), codex),
  );
  assert.equal(snapshot.sessions.length, 2);
  assert.deepEqual(snapshot.sessions.map((session) => session.key).sort(), [
    'claude:same', 'codex:same',
  ]);
  assert.equal(snapshot.projects.length, 1);
  assert.deepEqual(snapshot.projects[0], {
    id: stableProjectKey('Project Alpha'),
    label: 'Project Alpha',
    sessions: ['claude:same', 'codex:same'],
    sessionCount: 2,
    childSessionCount: 0,
    liveCount: 1,
    completedCount: 1,
    hosts: { claude: 1, codex: 1 },
    providers: { anthropic: 1, openai: 1 },
    updatedAt: '2026-07-27T12:01:00.000Z',
  });
});

test('project catalog keeps unknown inference providers separate from observed hosts', () => {
  const event = {
    ...createLiveEvent(base({
      sessionId: 'unknown-provider', host: 'claude',
      provider: null, providerProvenance: 'unknown',
      actor: { id: 'unknown-provider', kind: 'session', provider: null },
    })), eventId: 'ak:unknown-provider',
  };
  const snapshot = serializeLiveProjection(reduceLiveEvent(emptyLiveProjection(), event));
  assert.deepEqual(snapshot.projects[0].hosts, { claude: 1 });
  assert.deepEqual(snapshot.projects[0].providers, { unknown: 1 });
  assert.equal(snapshot.sessions[0].nodes[0].provider, null);
  assert.equal(snapshot.sessions[0].nodes[0].providerProvenance, 'unknown');
});

test('projection reconciles late parentage and catalogs only root sessions', () => {
  const childDiscovered = {
    ...createLiveEvent(base({
      sessionId: 'child', host: 'codex',
      actor: { id: 'child', kind: 'session', provider: 'openai' },
      action: 'session.discovered', status: 'unknown',
      observedAt: '2026-07-27T12:05:00Z',
    })), eventId: 'ak:1',
  };
  const authoritativeParentage = {
    ...createLiveEvent(base({
      sessionId: 'child', parentSessionId: 'root', host: 'codex',
      actor: { id: 'child', kind: 'session', provider: 'openai' },
      action: 'session.metadata', status: 'unknown',
      source: { adapter: 'codex-state', confidence: 'observed' },
      observedAt: '2026-07-27T12:10:00Z',
    })), eventId: 'ak:2',
  };
  const root = {
    ...createLiveEvent(base({
      sessionId: 'root', host: 'codex',
      actor: { id: 'root', kind: 'session', provider: 'openai' },
      observedAt: '2026-07-27T12:06:00Z',
    })), eventId: 'ak:3',
  };
  const projection = [childDiscovered, authoritativeParentage, root]
    .reduce((state, event) => reduceLiveEvent(state, event), emptyLiveProjection());
  const snapshot = serializeLiveProjection(projection);

  assert.equal(snapshot.sessions.find((session) => session.id === 'child').parentSessionId, 'root');
  assert.equal(snapshot.sessions.find((session) => session.id === 'child').updatedAt,
    '2026-07-27T12:05:00.000Z');
  assert.deepEqual(snapshot.projects[0].sessions, ['codex:root']);
  assert.equal(snapshot.projects[0].sessionCount, 1);
  assert.equal(snapshot.projects[0].childSessionCount, 1);
});

test('hierarchy serialization keeps orphans reachable and bounds parent cycles', () => {
  const events = [
    { sessionId: 'orphan', parentSessionId: 'missing' },
    { sessionId: 'cycle-a', parentSessionId: 'cycle-b' },
    { sessionId: 'cycle-b', parentSessionId: 'cycle-a' },
  ].map((shape, index) => ({
    ...createLiveEvent(base({
      ...shape, host: 'codex',
      actor: { id: shape.sessionId, kind: 'session', provider: 'openai' },
      action: 'session.discovered', status: 'unknown',
    })),
    eventId: `ak:${index + 1}`,
  }));
  const snapshot = serializeLiveProjection(events.reduce(
    (state, event) => reduceLiveEvent(state, event), emptyLiveProjection(),
  ));
  const byId = Object.fromEntries(snapshot.sessions.map((session) => [session.id, session]));

  assert.equal(byId.orphan.hierarchyState, 'orphan');
  assert.equal(byId.orphan.navigationRoot, true);
  assert.equal(byId['cycle-a'].hierarchyState, 'cycle');
  assert.equal(byId['cycle-a'].navigationRoot, true);
  assert.equal(byId['cycle-b'].navigationRoot, false);
  assert.deepEqual(snapshot.projects[0].sessions, ['codex:cycle-a', 'codex:orphan']);
});
