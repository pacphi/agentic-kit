import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSessionIdentity } from '../../src/lib/usage-index.mjs';
import { createLiveEvent } from '../../src/lib/live/index.mjs';
import { groupUsageByIntegrationAxes } from '../../src/lib/adapters/facts.mjs';

test('legacy usage records gain an explicit host without claiming an observed provider', () => {
  assert.deepEqual(normalizeSessionIdentity({
    id: 'legacy-claude',
    provider: 'claude',
    model: 'claude-opus-5',
  }), {
    id: 'legacy-claude',
    host: 'claude',
    provider: null,
    model: 'claude-opus-5',
    providerProvenance: 'unknown',
  });
  assert.deepEqual(normalizeSessionIdentity({
    id: 'legacy-codex',
    provider: 'codex',
  }), {
    id: 'legacy-codex',
    host: 'codex',
    provider: null,
    model: null,
    providerProvenance: 'unknown',
  });
});

test('new usage records retain independently observed host and provider identity', () => {
  assert.deepEqual(normalizeSessionIdentity({
    id: 'r1',
    host: 'claude',
    provider: 'ollama',
    model: 'qwen3.6:latest',
    providerProvenance: 'observed',
  }), {
    id: 'r1',
    host: 'claude',
    provider: 'ollama',
    model: 'qwen3.6:latest',
    providerProvenance: 'observed',
  });
});

test('a host transcript with configured provider evidence does not become observed', () => {
  const event = createLiveEvent({
    sessionId: 's1',
    observedAt: '2026-07-28T12:00:00.000Z',
    host: 'claude',
    provider: 'ollama',
    providerProvenance: 'configured',
    model: 'qwen3.6:latest',
    surface: 'native',
    actor: { id: 's1', kind: 'session' },
    action: 'session.started',
    status: 'running',
    source: {
      adapter: 'claude-transcript',
      confidence: 'observed',
      fields: { host: 'observed', provider: 'configured', model: 'configured' },
    },
  });
  assert.equal(event.host, 'claude');
  assert.equal(event.provider, 'ollama');
  assert.equal(event.model, 'qwen3.6:latest');
  assert.equal(event.providerProvenance, 'configured');
  assert.equal(event.source.fields.host, 'observed');
  assert.equal(event.source.fields.provider, 'configured');
});

test('live events preserve unknown provider identity rather than defaulting from host', () => {
  const event = createLiveEvent({
    sessionId: 's2',
    observedAt: '2026-07-28T12:00:00.000Z',
    host: 'codex',
    surface: 'native',
    actor: { id: 's2', kind: 'session' },
    action: 'session.started',
    status: 'running',
    source: { adapter: 'codex-transcript', confidence: 'observed' },
  });
  assert.equal(event.host, 'codex');
  assert.equal(event.provider, null);
  assert.equal(event.providerProvenance, 'unknown');
});

test('dashboard facts group host and provider axes independently', () => {
  const grouped = groupUsageByIntegrationAxes([
    { host: 'claude', provider: 'anthropic', tokens: 10, cost: 1 },
    { host: 'claude', provider: 'ollama', tokens: 20, cost: 0 },
    { host: 'codex', provider: 'ollama', tokens: 30, cost: 0 },
    { host: 'codex', provider: null, tokens: 40, cost: null },
  ]);
  assert.deepEqual(grouped.byHost, {
    claude: { sessions: 2, tokens: 30, cost: 1 },
    codex: { sessions: 2, tokens: 70, cost: null },
  });
  assert.deepEqual(grouped.byProvider, {
    anthropic: { sessions: 1, tokens: 10, cost: 1 },
    ollama: { sessions: 2, tokens: 50, cost: 0 },
    unknown: { sessions: 1, tokens: 40, cost: null },
  });
});

test('dashboard grouping never turns unknown price into zero', () => {
  const grouped = groupUsageByIntegrationAxes([
    { host: 'claude', provider: 'openrouter', tokens: 100, cost: null },
  ]);
  assert.equal(grouped.byProvider.openrouter.cost, null);
  assert.equal(grouped.byHost.claude.cost, null);
});
