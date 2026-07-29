import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EXECUTION_ADAPTERS } from '../../src/lib/execution/adapters.mjs';
import { executeRunPlan } from '../../src/lib/execution/runner.mjs';

const worker = (id, host = 'opencode', dependsOn) => ({ id, activity: 'implementation', role: 'coder', host, prompt: id, ...(dependsOn ? { dependsOn } : {}) });
const clock = () => '2026-07-29T00:00:00.000Z';

test('the built-in registry exposes the supervised OpenCode transport only', () => {
  assert.equal(EXECUTION_ADAPTERS.get('opencode').id, 'opencode-server');
  assert.equal(EXECUTION_ADAPTERS.has('claude'), false);
  assert.equal(EXECUTION_ADAPTERS.has('codex'), false);
});

function adapter({ observation = { type: 'idle' }, events = [] } = {}) {
  return {
    id: 'fake',
    async readiness() { events.push('ready'); return { ready: true }; },
    async prepare({ worker: w }) { events.push(`prepare:${w.id}`); return { worker: w }; },
    async launch(state) { events.push(`launch:${state.worker.id}`); return state; },
    async observe(state) { events.push(`observe:${state.worker.id}`); return observation; },
    interpret(state, observed) {
      events.push(`interpret:${state.worker.id}:${observed.type}`);
      return {
        workerId: state.worker.id, activity: state.worker.activity, role: state.worker.role, host: state.worker.host,
        status: observed.type === 'timeout' ? 'timed_out' : 'succeeded', exitCategory: observed.type === 'timeout' ? 'timeout' : 'success',
        startedAt: clock(), endedAt: clock(), durationMs: 0, provider: null, providerProvenance: 'unknown',
        configuredModel: null, observedModel: null, sessionId: null, transcriptRefs: [], failure: null, usage: null,
      };
    },
    async cancel(state) { events.push(`cancel:${state.worker.id}`); },
    async cleanup(state) { events.push(`cleanup:${state.worker.id}`); },
  };
}

test('runner schedules a dependency DAG and blocks only descendants of a failure', async () => {
  const events = [];
  const ok = adapter({ events });
  const failed = { ...adapter({ events }), interpret(state) {
    return { workerId: state.worker.id, activity: state.worker.activity, role: state.worker.role, host: state.worker.host,
      status: 'failed', exitCategory: 'worker_error', startedAt: clock(), endedAt: clock(), durationMs: 0,
      provider: null, providerProvenance: 'unknown', configuredModel: null, observedModel: null, sessionId: null, transcriptRefs: [], failure: { reason: 'no' }, usage: null };
  } };
  const results = await executeRunPlan({ workers: [worker('a', 'opencode'), worker('b', 'bad'), worker('c', 'opencode', ['a']), worker('d', 'opencode', ['b'])] }, {
    adapters: { opencode: ok, bad: failed }, maxConcurrent: 2, clock,
  });
  assert.deepEqual(results.map((result) => result.status), ['succeeded', 'failed', 'succeeded', 'blocked']);
  assert.ok(events.includes('launch:c'));
  assert.ok(!events.includes('launch:d'));
});

test('runner reports an unimplemented host without attempting a lifecycle', async () => {
  const [result] = await executeRunPlan({ workers: [worker('a', 'claude')] }, { clock });
  assert.equal(result.exitCategory, 'cli_unavailable');
  assert.match(result.failure.reason, /no execution adapter/);
});
