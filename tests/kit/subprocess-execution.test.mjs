import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClaudeExecutionAdapter } from '../../src/lib/execution/claude.mjs';
import { createCodexExecutionAdapter } from '../../src/lib/execution/codex.mjs';
import { executeWorker } from '../../src/lib/execution/runner.mjs';

const worker = (host, model = 'model-1') => ({
  id: `${host}-1`, activity: 'implementation', role: 'coder', host, configuredModel: model, prompt: 'Do the work.',
});
const clock = () => '2026-07-29T00:00:00.000Z';

function child({ code = 0, stderr = '' } = {}) {
  const result = new EventEmitter();
  result.stdout = new EventEmitter();
  result.stderr = new EventEmitter();
  result.kill = () => { queueMicrotask(() => result.emit('close', null, 'SIGTERM')); return true; };
  queueMicrotask(() => {
    if (stderr) result.stderr.emit('data', stderr);
    result.emit('close', code, null);
  });
  return result;
}

test('Claude adapter uses print/json mode without a permission bypass', async () => {
  const calls = [];
  const adapter = createClaudeExecutionAdapter({
    haveFn: async () => true, clock,
    spawnFn: (command, args, options) => { calls.push({ command, args, options }); return child(); },
  });
  const result = await executeWorker(worker('claude'), adapter, { cwd: process.cwd(), clock });
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(calls[0].args, ['--print', '--output-format', 'json', '--model', 'model-1', 'Do the work.']);
  assert.ok(!calls[0].args.some((arg) => arg.includes('dangerously') || arg.includes('bypass')));
});

// qe-court B6: the subprocess adapters observe exit codes, not billing
// identity — provider must be recorded as unknown, never fabricated from the
// host id (ADR-0018's invariant).
test('subprocess results never fabricate provider identity from the host (qe-court B6)', async () => {
  for (const host of ['claude', 'codex']) {
    const adapter = (host === 'claude' ? createClaudeExecutionAdapter : createCodexExecutionAdapter)({
      haveFn: async () => true, clock,
      spawnFn: () => child(),
    });
    const result = await executeWorker(worker(host), adapter, { cwd: process.cwd(), clock });
    assert.equal(result.status, 'succeeded');
    assert.equal(result.provider, null, `${host}: provider must not be the host id`);
    assert.equal(result.providerProvenance, 'unknown', `${host}: provenance must be unknown without observation`);
  }
});

test('Codex adapter pins its supplied workspace and normalizes host failures', async () => {
  const calls = [];
  const adapter = createCodexExecutionAdapter({
    haveFn: async () => true, clock,
    spawnFn: (command, args, options) => { calls.push({ command, args, options }); return child({ code: 1, stderr: 'model not found' }); },
  });
  const result = await executeWorker(worker('codex'), adapter, { cwd: '/workspace/fixture', clock });
  assert.equal(result.status, 'failed');
  assert.equal(result.exitCategory, 'model_unavailable');
  assert.deepEqual(calls[0].args, ['exec', '--json', '--cd', '/workspace/fixture', '--model', 'model-1', 'Do the work.']);
  assert.ok(!calls[0].args.some((arg) => arg.includes('dangerously') || arg.includes('bypass')));
});

test('subprocess cleanup terminates a still-running direct child', async () => {
  const result = new EventEmitter();
  result.stdout = new EventEmitter();
  result.stderr = new EventEmitter();
  let signal = null;
  result.kill = (value) => { signal = value; queueMicrotask(() => result.emit('close', null, value)); return true; };
  const adapter = createClaudeExecutionAdapter({ haveFn: async () => true, clock, spawnFn: () => result });
  const state = await adapter.launch(await adapter.prepare({ worker: worker('claude'), cwd: process.cwd() }));
  await adapter.cleanup(state);
  assert.equal(signal, 'SIGTERM');
});
