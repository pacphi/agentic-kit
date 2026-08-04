import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  adaptClaudeRecord, adaptCodexRecord, adaptCodexLedger, adaptStructuredEvent,
} from '../../src/lib/live/index.mjs';

const now = '2026-07-27T12:00:00Z';

test('Claude adapter emits tool metadata but never prompt, input or artifact path', () => {
  const events = adaptClaudeRecord({
    type: 'assistant', sessionId: 'c1', timestamp: now,
    message: {
      model: 'claude-x', content: [{
        type: 'tool_use', id: 'tool-1', name: 'Read',
        input: { file_path: '/secret/file', token: 'credential' },
      }],
    },
  }, { observedAt: now, artifact: '/Users/private/c1.jsonl' });
  assert.equal(events.length, 2);
  assert.equal(events[1].action, 'tool.started');
  assert.equal(events[1].target.id, 'tool-1');
  assert.equal(events[1].target.label, 'Read');
  const json = JSON.stringify(events);
  assert.ok(!json.includes('/secret/file'));
  assert.ok(!json.includes('/Users/private'));
});

test('Claude sidechain without agent id is explicitly inferred', () => {
  const [event] = adaptClaudeRecord({
    type: 'assistant', sessionId: 'c1', isSidechain: true, timestamp: now,
    message: { content: [] },
  }, { observedAt: now });
  assert.equal(event.actor.kind, 'subagent');
  assert.equal(event.source.confidence, 'inferred');
});

test('Codex adapter handles session, tool call and tool result fixture shapes', () => {
  const meta = { type: 'session_meta', timestamp: now, payload: {
    id: 'x1', model: 'gpt-x', thread_source: 'subagent', cwd: '/secret/project',
  } };
  const [started] = adaptCodexRecord(meta, { observedAt: now });
  assert.equal(started.actor.kind, 'subagent');
  assert.equal(started.actor.provider, null);
  assert.equal(started.source.fields.model, 'observed');
  const [tool] = adaptCodexRecord({
    type: 'response_item', timestamp: now,
    payload: { type: 'function_call', call_id: 'call-1', name: 'exec', arguments: 'secret' },
  }, { sessionId: 'x1', observedAt: now });
  assert.equal(tool.target.id, 'call-1');
  assert.equal(tool.target.label, 'exec');
  assert.ok(!JSON.stringify(tool).includes('secret'));
  const [done] = adaptCodexRecord({
    type: 'response_item', timestamp: now,
    payload: { type: 'function_call_output', call_id: 'call-1', output: 'private' },
  }, { sessionId: 'x1', observedAt: now });
  assert.equal(done.status, 'completed');
  assert.ok(!JSON.stringify(done).includes('private'));
});

test('Codex session_meta model_provider becomes an observed provider claim', () => {
  const [started] = adaptCodexRecord({
    type: 'session_meta', timestamp: now,
    payload: { id: 'x1', model: 'gpt-x', model_provider: 'openrouter' },
  }, { observedAt: now });
  assert.equal(started.provider, 'openrouter');
  assert.equal(started.actor.provider, 'openrouter');
  assert.equal(started.providerProvenance, 'observed');
});

test('Claude provider resolved from configuration keeps configured provenance', () => {
  const [event] = adaptClaudeRecord({
    type: 'assistant', sessionId: 'c1', timestamp: now,
    message: { model: 'claude-x', content: [] },
  }, { observedAt: now, provider: 'bedrock', providerProvenance: 'configured' });
  assert.equal(event.provider, 'bedrock');
  assert.equal(event.providerProvenance, 'configured');
});

test('Claude first-party default stays an inferred claim, never observed', () => {
  const [event] = adaptClaudeRecord({
    type: 'assistant', sessionId: 'c1', timestamp: now,
    message: { model: 'claude-x', content: [] },
  }, { observedAt: now, provider: 'anthropic', providerProvenance: 'inferred' });
  assert.equal(event.provider, 'anthropic');
  assert.equal(event.providerProvenance, 'inferred');
});

test('Claude without any provider evidence reports unknown provenance', () => {
  const [event] = adaptClaudeRecord({
    type: 'assistant', sessionId: 'c1', timestamp: now,
    message: { model: 'claude-x', content: [] },
  }, { observedAt: now });
  assert.equal(event.provider, null);
  assert.equal(event.providerProvenance, 'unknown');
});

test('Codex ledger creates authoritative spawn edges', () => {
  const ledger = {
    parents: new Map([['child', 'parent']]),
    threads: new Map([
      ['parent', { model: 'gpt-x', project: 'agentic-kit', provider: 'openai' }],
      ['child', { tokensUsed: 42, agentNickname: 'Bohr', agentRole: 'tester' }],
    ]),
  };
  const events = adaptCodexLedger(ledger, { observedAt: now });
  const event = events.find((candidate) => candidate.action === 'agent.spawned');
  assert.equal(event.action, 'agent.spawned');
  assert.equal(event.target.id, 'child');
  assert.equal(event.target.label, 'Bohr');
  assert.equal(event.target.role, 'tester');
  assert.equal(event.source.confidence, 'observed');
  assert.equal(event.project, 'agentic-kit');
  assert.equal(event.source.fields.project, 'observed');
  assert.equal(event.source.fields.hierarchy, 'observed');
  assert.ok(!JSON.stringify(events).includes('/Users/'));
});

test('turn_context contributes safe model metadata without content or cwd', () => {
  const [event] = adaptCodexRecord({
    type: 'turn_context', timestamp: now,
    payload: { model: 'gpt-safe', cwd: '/Users/private/agentic-kit', content: 'private' },
  }, { sessionId: 'x1', project: 'agentic-kit', observedAt: now });
  assert.equal(event.action, 'session.metadata');
  assert.equal(event.actor.model, 'gpt-safe');
  assert.equal(event.project, 'agentic-kit');
  const json = JSON.stringify(event);
  assert.ok(!json.includes('/Users/private'));
  assert.ok(!json.includes('private'));
});

test('structured adapter accepts bounded ruflo and AQE events only', () => {
  const [event] = adaptStructuredEvent({
    sessionId: 's', agentId: 'a', event: 'gate.completed', status: 'completed',
    project: 'forged', projectKey: 'project:ffffffffffffffff', output: 'must not leak',
  }, {
    surface: 'aqe', adapter: 'aqe-hook', observedAt: now,
    project: 'agentic-kit', projectKey: 'project:aaaaaaaaaaaaaaaa',
  });
  assert.equal(event.surface, 'aqe');
  assert.equal(event.project, 'agentic-kit');
  assert.equal(event.projectKey, 'project:aaaaaaaaaaaaaaaa');
  assert.ok(!JSON.stringify(event).includes('must not leak'));
  assert.deepEqual(adaptStructuredEvent({}, { surface: 'aqe' }), []);
});

test('explicit tool names classify skill, plugin and MCP nodes without inspecting input', () => {
  for (const [name, kind] of [
    ['Skill', 'skill'], ['plugin:review', 'plugin'], ['mcp__ruflo__swarm_status', 'mcp'],
  ]) {
    const events = adaptClaudeRecord({
      type: 'assistant', sessionId: 'c1', timestamp: now,
      message: { content: [{ type: 'tool_use', id: name, name, input: { secret: 'private' } }] },
    }, { observedAt: now });
    assert.equal(events[1].target.kind, kind);
    assert.ok(!JSON.stringify(events).includes('private'));
  }
});

test('tool identity has a dedicated allowlisted field without carrying arguments', () => {
  const events = adaptCodexRecord({
    type: 'response_item', timestamp: '2026-07-27T10:00:00.000Z',
    payload: {
      type: 'function_call', call_id: 'call-safe-name', name: 'exec_command',
      arguments: '{"command":"token sk-private-never-serialize"}',
    },
  }, {
    sessionId: 's-tool-name', project: 'agentic-kit',
    observedAt: '2026-07-27T10:00:00.000Z',
  });
  assert.equal(events[0].attributes.toolName, 'exec_command');
  assert.equal(JSON.stringify(events).includes('sk-private-never-serialize'), false);
});
