import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOpenCodeExecutionAdapter, renderOpenCodeWorkerPrompt } from '../../src/lib/execution/opencode.mjs';

const worker = {
  id: 'worker-1', activity: 'implementation', role: 'coder', host: 'opencode',
  configuredModel: 'openrouter/example', prompt: 'Add a safe server adapter.',
};

const response = (json, { status = 200, body = null } = {}) => ({ ok: status >= 200 && status < 300, status, json: async () => json, body });
const sse = (events) => new ReadableStream({
  start(controller) { controller.enqueue(new TextEncoder().encode(events)); controller.close(); },
});

test('worker prompt is invocation-only and preserves the user permission boundary', () => {
  const prompt = renderOpenCodeWorkerPrompt(worker, { template: 'Task={{task}}\nMeta={{metadata}}\nNo bypass.' });
  assert.match(prompt, /Add a safe server adapter/);
  assert.match(prompt, /configured model: openrouter\/example/);
  assert.doesNotMatch(prompt, /--auto/);
});

test('server adapter launches loopback-only with ephemeral basic auth and normalizes observed facts', async () => {
  const calls = [];
  const child = { signals: [], kill(signal) { this.signals.push(signal); return true; } };
  const fetchFn = async (url, init = {}) => {
    calls.push({ url, init });
    if (url.endsWith('/global/health')) return response({ healthy: true, version: '1.18.9' });
    if (url.endsWith('/session') && init.method === 'POST') return response({ id: 'ses-1' });
    if (url.endsWith('/global/event')) return response(null, { body: sse('data: {"payload":{"type":"session.idle","properties":{"sessionID":"ses-1"}}}\n\n') });
    if (url.endsWith('/prompt_async')) return response(null, { status: 204 });
    if (url.endsWith('/message')) return response([{ info: { role: 'assistant', providerID: 'openrouter', modelID: 'example', tokens: { input: 1, output: 2 }, cost: 0.01 } }]);
    if (url.endsWith('/instance/dispose')) return response(null, { status: 204 });
    throw new Error(`unexpected URL ${url}`);
  };
  const adapter = createOpenCodeExecutionAdapter({
    fetchFn, spawnFn: (_cmd, args, opts) => { assert.deepEqual(args, ['serve', '--hostname', '127.0.0.1', '--port', '43123']); assert.equal(opts.stdio, 'ignore'); assert.equal(opts.env.OPENCODE_SERVER_PASSWORD, 'ephemeral'); return child; },
    reservePort: async () => 43123, secret: () => 'ephemeral', clock: () => '2026-07-29T00:00:00.000Z',
  });
  const state = await adapter.prepare({ worker, cwd: process.cwd() });
  const launched = await adapter.launch(state);
  const observed = await adapter.observe(launched);
  const result = adapter.interpret(launched, observed);
  assert.equal(result.status, 'succeeded');
  assert.equal(result.provider, 'openrouter');
  assert.equal(result.providerProvenance, 'observed');
  assert.equal(result.observedModel, 'example');
  assert.ok(calls.every(({ init }) => init.headers.authorization.startsWith('Basic ')));
  assert.ok(calls.some(({ url }) => url.endsWith('/prompt_async')));
  await adapter.cleanup(launched);
  assert.deepEqual(child.signals, ['SIGTERM']);
});

test('permission events are deterministically aborted and never converted into implicit approval', async () => {
  const paths = [];
  const fetchFn = async (url, init = {}) => {
    paths.push(`${init.method ?? 'GET'} ${new URL(url).pathname}`);
    if (url.endsWith('/global/health')) return response({ healthy: true });
    if (url.endsWith('/session') && init.method === 'POST') return response({ id: 'ses-2' });
    if (url.endsWith('/global/event')) return response(null, { body: sse('data: {"payload":{"type":"permission.updated","properties":{"id":"perm-1","sessionID":"ses-2"}}}\n\n') });
    if (url.endsWith('/prompt_async') || url.endsWith('/abort')) return response(null, { status: 204 });
    throw new Error(`unexpected URL ${url}`);
  };
  const adapter = createOpenCodeExecutionAdapter({
    fetchFn, spawnFn: () => ({ kill: () => true }), reservePort: async () => 43124, secret: () => 'ephemeral', clock: () => '2026-07-29T00:00:00.000Z',
  });
  const launched = await adapter.launch(await adapter.prepare({ worker, cwd: process.cwd() }));
  const result = adapter.interpret(launched, await adapter.observe(launched));
  assert.equal(result.status, 'blocked');
  assert.equal(result.exitCategory, 'permission_required');
  assert.ok(paths.includes('POST /session/ses-2/abort'));
  assert.ok(!paths.some((p) => p.includes('/permissions/perm-1')));
});
