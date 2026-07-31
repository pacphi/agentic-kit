import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createOpenCodeExecutionAdapter as createRealOpenCodeExecutionAdapter,
  renderOpenCodeWorkerPrompt,
} from '../../src/lib/execution/opencode.mjs';
import { executeWorker } from '../../src/lib/execution/runner.mjs';
import { HANDOFF_END, HANDOFF_START } from '../../src/lib/execution/handoff.mjs';

const passthroughResolve = (command, args) => ({ command, args, resolved: true });
const createOpenCodeExecutionAdapter = (options = {}) => createRealOpenCodeExecutionAdapter({
  resolveFn: passthroughResolve,
  signalFn: async (child, signal) => !!child?.kill?.(signal),
  ...options,
});

const worker = {
  id: 'worker-1', activity: 'implementation', role: 'coder', host: 'opencode',
  configuredModel: 'openrouter/example', prompt: 'Add a safe server adapter.',
};

const response = (json, { status = 200, body, headers = {} } = {}) => {
  const encoded = new TextEncoder().encode(JSON.stringify(json));
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => json,
    text: async () => JSON.stringify(json),
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    body: body ?? new ReadableStream({
      start(controller) { controller.enqueue(encoded); controller.close(); },
    }),
  };
};
const sse = (events) => new ReadableStream({
  start(controller) { controller.enqueue(new TextEncoder().encode(events)); controller.close(); },
});
const tagged = (outcome) => `${HANDOFF_START}${JSON.stringify({
  outcome, artifacts: [], decisions: [], risks: [],
})}${HANDOFF_END}`;

test('worker prompt is invocation-only and preserves the user permission boundary', () => {
  const prompt = renderOpenCodeWorkerPrompt(worker, { template: 'Task={{task}}\nMeta={{metadata}}\nNo bypass.' });
  assert.match(prompt, /Add a safe server adapter/);
  assert.match(prompt, /configured model: openrouter\/example/);
  assert.doesNotMatch(prompt, /--auto/);
});

// #88: `$`-metachars in the prompt/model are data, never replacement syntax.
test('a prompt carrying $& $` $\' survives rendering byte-for-byte (no $-pattern corruption)', () => {
  const w = { ...worker, prompt: 'cost is $& today, see $` and $\'', configuredModel: 'openrouter/$&' };
  const prompt = renderOpenCodeWorkerPrompt(w, { template: 'Task={{task}}\nMeta={{metadata}}' });
  assert.ok(prompt.includes('cost is $& today, see $` and $\''), `prompt must arrive verbatim:\n${prompt}`);
  assert.ok(prompt.includes('configured model: openrouter/$&'), 'metadata model id is verbatim too');
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
    fetchFn, spawnFn: (_cmd, args, opts) => { assert.deepEqual(args, ['serve', '--hostname', '127.0.0.1', '--port', '0']); assert.deepEqual(opts.stdio, ['ignore', 'pipe', 'pipe']); assert.equal(opts.env.OPENCODE_SERVER_PASSWORD, 'ephemeral'); return child; },
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

test('OpenCode extracts a handoff only from the final assistant text parts', async () => {
  const fetchFn = async (url, init = {}) => {
    if (url.endsWith('/global/health')) return response({ healthy: true });
    if (url.endsWith('/session') && init.method === 'POST') return response({ id: 'ses-summary' });
    if (url.endsWith('/global/event')) {
      return response(null, {
        body: sse('data: {"payload":{"type":"session.idle","properties":{"sessionID":"ses-summary"}}}\n\n'),
      });
    }
    if (url.endsWith('/prompt_async')) return response(null, { status: 204 });
    if (url.endsWith('/message')) {
      return response([
        {
          info: { role: 'assistant', providerID: 'openrouter', modelID: 'example' },
          parts: [
            { type: 'tool', text: tagged('tool-output-must-not-win') },
            { type: 'text', text: `done\n${tagged('assistant-final')}` },
          ],
        },
      ]);
    }
    if (url.endsWith('/instance/dispose')) return response(null, { status: 204 });
    throw new Error(`unexpected URL ${url}`);
  };
  const adapter = createOpenCodeExecutionAdapter({
    fetchFn,
    spawnFn: () => ({ kill: () => true }),
    reservePort: async () => 43140,
    secret: () => 'ephemeral',
  });
  const state = await adapter.launch(await adapter.prepare({ worker, cwd: process.cwd() }));
  const observation = await adapter.observe(state);
  assert.equal(adapter.summarize(state, observation).outcome, 'assistant-final');
  await adapter.cleanup(state);
});

for (const [name, messageResponse] of [
  ['declared oversized message response', response([], { headers: { 'content-length': String(300 * 1024) } })],
  ['oversized assistant text parts', response([{
    info: { role: 'assistant' },
    parts: [{ type: 'text', text: 'x'.repeat(70 * 1024) }],
  }])],
]) {
  test(`OpenCode rejects ${name} before handoff extraction`, async () => {
    const fetchFn = async (url, init = {}) => {
      if (url.endsWith('/global/health')) return response({ healthy: true });
      if (url.endsWith('/session') && init.method === 'POST') return response({ id: 'ses-bounded' });
      if (url.endsWith('/global/event')) {
        return response(null, {
          body: sse('data: {"payload":{"type":"session.idle","properties":{"sessionID":"ses-bounded"}}}\n\n'),
        });
      }
      if (url.endsWith('/prompt_async')) return response(null, { status: 204 });
      if (url.endsWith('/message')) return messageResponse;
      if (url.endsWith('/instance/dispose')) return response(null, { status: 204 });
      throw new Error(`unexpected URL ${url}`);
    };
    const adapter = createOpenCodeExecutionAdapter({
      fetchFn,
      spawnFn: () => ({ kill: () => true }),
      reservePort: async () => 43141,
      secret: () => 'ephemeral',
    });
    const state = await adapter.launch(await adapter.prepare({ worker, cwd: process.cwd() }));
    const result = adapter.interpret(state, await adapter.observe(state));
    assert.equal(result.status, 'failed');
    assert.equal(result.exitCategory, 'protocol_error');
    assert.match(JSON.stringify(result.failure), /exceeded/);
    await adapter.cleanup(state);
  });
}

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

test('malformed server events fail as protocol errors instead of manufacturing completion', async () => {
  const fetchFn = async (url, init = {}) => {
    if (url.endsWith('/global/health')) return response({ healthy: true });
    if (url.endsWith('/session') && init.method === 'POST') return response({ id: 'ses-3' });
    if (url.endsWith('/global/event')) return response(null, { body: sse('data: {not-json}\n\n') });
    if (url.endsWith('/prompt_async') || url.endsWith('/instance/dispose')) return response(null, { status: 204 });
    throw new Error(`unexpected URL ${url}`);
  };
  const adapter = createOpenCodeExecutionAdapter({
    fetchFn, spawnFn: () => ({ kill: () => true }), reservePort: async () => 43125, secret: () => 'ephemeral', clock: () => '2026-07-29T00:00:00.000Z',
  });
  const launched = await adapter.launch(await adapter.prepare({ worker, cwd: process.cwd() }));
  const result = adapter.interpret(launched, await adapter.observe(launched));
  assert.equal(result.status, 'failed');
  assert.equal(result.exitCategory, 'protocol_error');
  await adapter.cleanup(launched);
});

test('runner timeout aborts the session event stream and terminates the owned server', async () => {
  const paths = [];
  let cancelled = false;
  const pending = new ReadableStream({
    start(controller) { this.controller = controller; },
    cancel() { cancelled = true; },
  });
  const child = { signals: [], kill(signal) { this.signals.push(signal); return true; } };
  const fetchFn = async (url, init = {}) => {
    paths.push(`${init.method ?? 'GET'} ${new URL(url).pathname}`);
    if (url.endsWith('/global/health')) return response({ healthy: true });
    if (url.endsWith('/session') && init.method === 'POST') return response({ id: 'ses-4' });
    if (url.endsWith('/global/event')) return response(null, { body: pending });
    if (url.endsWith('/prompt_async') || url.endsWith('/abort') || url.endsWith('/instance/dispose')) return response(null, { status: 204 });
    throw new Error(`unexpected URL ${url}`);
  };
  const adapter = createOpenCodeExecutionAdapter({
    fetchFn, spawnFn: () => child, haveFn: async () => true, reservePort: async () => 43126, secret: () => 'ephemeral',
  });
  const result = await executeWorker(worker, adapter, { cwd: process.cwd(), timeoutMs: 100 });
  assert.equal(result.status, 'timed_out');
  assert.equal(result.exitCategory, 'timeout');
  assert.equal(cancelled, true);
  assert.ok(paths.includes('POST /session/ses-4/abort'));
  assert.deepEqual(child.signals, ['SIGTERM', 'SIGTERM']);
});

test('a server that ignores TERM receives one bounded KILL fallback and reports an orphan', async () => {
  const child = new (await import('node:events')).EventEmitter();
  child.exitCode = null;
  child.kill = () => true;
  const fetchFn = async (url, init = {}) => {
    if (url.endsWith('/global/health')) return response({ healthy: true });
    if (url.endsWith('/session') && init.method === 'POST') return response({ id: 'ses-5' });
    if (url.endsWith('/global/event')) return response(null, { body: new ReadableStream({ cancel() {} }) });
    if (url.endsWith('/prompt_async') || url.endsWith('/abort') || url.endsWith('/instance/dispose')) return response(null, { status: 204 });
    throw new Error(`unexpected URL ${url}`);
  };
  const adapter = createOpenCodeExecutionAdapter({
    fetchFn, spawnFn: () => child, haveFn: async () => true, reservePort: async () => 43127, secret: () => 'ephemeral', terminationGraceMs: 1, forceGraceMs: 1,
  });
  const result = await executeWorker(worker, adapter, { cwd: process.cwd(), timeoutMs: 100 });
  assert.equal(result.status, 'failed');
  assert.equal(result.exitCategory, 'orphaned');
});

// Regression (#76 smoke): the adapter posted `model` as a bare string, but
// opencode serve's prompt_async schema expects {providerID, modelID} or null —
// every configured-model worker 400'd ("Expected object | null, got …").
test('configured models post as a serve-shaped {providerID, modelID} object (or are omitted)', async () => {
  const posts = [];
  const child = { kill: () => true };
  const fetchFn = async (url, init = {}) => {
    if (url.endsWith('/global/health')) return response({ healthy: true });
    if (url.endsWith('/session') && init.method === 'POST') return response({ id: 'ses-m' });
    if (url.endsWith('/global/event')) return response(null, { body: sse('data: {"payload":{"type":"session.idle","properties":{"sessionID":"ses-m"}}}\n\n') });
    if (url.endsWith('/prompt_async')) { posts.push(JSON.parse(init.body)); return response(null, { status: 204 }); }
    if (url.endsWith('/message')) return response([{ info: { role: 'assistant' } }]);
    if (url.endsWith('/instance/dispose')) return response(null, { status: 204 });
    throw new Error(`unexpected URL ${url}`);
  };
  const adapter = createOpenCodeExecutionAdapter({
    fetchFn, spawnFn: () => child, reservePort: async () => 43129, secret: () => 'ephemeral', clock: () => '2026-07-29T00:00:00.000Z',
  });
  await adapter.cleanup(await adapter.observe(await adapter.launch(await adapter.prepare({ worker, cwd: process.cwd() }))));
  assert.deepEqual(posts[0].model, { providerID: 'openrouter', modelID: 'example' },
    'provider/model strings must arrive as the serve schema object');
  // model ids may themselves contain slashes (openrouter paths): split once.
  await adapter.cleanup(await adapter.observe(await adapter.launch(await adapter.prepare({
    worker: { ...worker, configuredModel: 'openrouter/z-ai/glm-5.2' }, cwd: process.cwd(),
  }))));
  assert.deepEqual(posts[1].model, { providerID: 'openrouter', modelID: 'z-ai/glm-5.2' }, 'split on the FIRST slash only');
  // no provider prefix → the server's own configured default (model omitted, never a guessed provider)
  await adapter.cleanup(await adapter.observe(await adapter.launch(await adapter.prepare({
    worker: { ...worker, configuredModel: 'kimi-k3' }, cwd: process.cwd(),
  }))));
  assert.ok(!('model' in posts[2]), 'a bare model id must not be sent as a mangled object');
});

// Regression (#76 smoke): a prompt post that threw (e.g. the 400 above) left
// the terminal SSE promise unconsumed — its socket-close rejection crashed the
// process as an unhandled rejection AFTER the failure verdict.
test('a prompt post failure tears down without an unhandled terminal rejection', async () => {
  const child = { signals: [], kill(signal) { this.signals.push(signal); return true; } };
  const fetchFn = async (url, init = {}) => {
    if (url.endsWith('/global/health')) return response({ healthy: true });
    if (url.endsWith('/session') && init.method === 'POST') return response({ id: 'ses-t' });
    if (url.endsWith('/global/event')) {
      return response(null, {
        body: new ReadableStream({
          start() {}, // never closes on its own — the teardown closes the socket
          cancel() { throw Object.assign(new TypeError('terminated'), { code: 'UND_ERR_SOCKET' }); },
        }),
      });
    }
    if (url.endsWith('/prompt_async')) return response({ name: 'BadRequest' }, { status: 400 });
    throw new Error(`unexpected URL ${url}`);
  };
  const adapter = createOpenCodeExecutionAdapter({
    fetchFn, spawnFn: () => child, reservePort: async () => 43130, secret: () => 'ephemeral',
  });
  let unhandled = null;
  const onUnhandled = (reason) => { unhandled = reason; };
  process.on('unhandledRejection', onUnhandled);
  try {
    await assert.rejects(adapter.launch(await adapter.prepare({ worker, cwd: process.cwd() })), /HTTP 400/);
    // Flush several turns so any dangling rejection would surface.
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
    assert.equal(unhandled, null, `teardown must not leak an unhandled rejection, got: ${unhandled}`);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  assert.deepEqual(child.signals, ['SIGTERM'], 'the owned server is still terminated on the failure path');
});

// S2: the port comes from the child's own stdout ("listening on :<port>") —
// no probe-bind-release race, and reservePort is never consulted when stdout
// is readable.
test('the bound port is read from the child stdout (S2 — no probe-bind-release race)', async () => {
  const { EventEmitter } = await import('node:events');
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => true;
  let reserved = null;
  const fetchFn = async (url, init = {}) => {
    if (url.includes(':43210/global/health')) return response({ healthy: true });
    if (url.endsWith('/session') && init.method === 'POST') return response({ id: 'ses-p' });
    if (url.includes(':43210/global/event')) return response(null, { body: sse('data: {"payload":{"type":"session.idle","properties":{"sessionID":"ses-p"}}}\n\n') });
    if (url.endsWith('/prompt_async')) return response(null, { status: 204 });
    if (url.endsWith('/message')) return response([{ info: { role: 'assistant' } }]);
    if (url.endsWith('/instance/dispose')) return response(null, { status: 204 });
    throw new Error(`unexpected URL ${url}`);
  };
  const adapter = createOpenCodeExecutionAdapter({
    fetchFn,
    spawnFn: () => {
      queueMicrotask(() => {
        child.stdout.emit('data', 'opencode server listening on http://127.0.');
        child.stdout.emit('data', '0.1:43210\n');
      });
      return child;
    },
    reservePort: async () => { reserved = true; return 43123; },
    secret: () => 'ephemeral', clock: () => '2026-07-29T00:00:00.000Z',
  });
  await adapter.cleanup(await adapter.observe(await adapter.launch(await adapter.prepare({ worker, cwd: process.cwd() }))));
  assert.equal(reserved, null, 'reservePort is only the fallback for stdout-less children');
});

test('a child that dies before reporting its port fails honestly, never hangs', async () => {
  const { EventEmitter } = await import('node:events');
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = 1;
  child.kill = () => true;
  const adapter = createOpenCodeExecutionAdapter({
    fetchFn: async () => { throw new Error('fetch must not run'); },
    spawnFn: () => { queueMicrotask(() => child.emit('exit')); return child; },
    secret: () => 'ephemeral',
  });
  await assert.rejects(
    adapter.launch(await adapter.prepare({ worker, cwd: process.cwd() })),
    /exited before reporting its port/,
  );
});

test('a child spawn error before the port report rejects without an unhandled error event', async () => {
  const { EventEmitter } = await import('node:events');
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.kill = () => true;
  const adapter = createOpenCodeExecutionAdapter({
    fetchFn: async () => { throw new Error('fetch must not run'); },
    spawnFn: () => {
      queueMicrotask(() => {
        child.exitCode = -2;
        child.emit('error', new Error('spawn opencode ENOENT'));
      });
      return child;
    },
    secret: () => 'ephemeral',
  });
  await assert.rejects(
    adapter.launch(await adapter.prepare({ worker, cwd: process.cwd() })),
    /failed before reporting its port: spawn opencode ENOENT/,
  );
});

test('OpenCode launch consumes the resolved invocation and rejects an unsafe shim before spawn', async () => {
  const calls = [];
  const child = { kill: () => true };
  const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  const prefix = ['-NoProfile', '-File', 'C:\\tools\\opencode.ps1'];
  const adapter = createOpenCodeExecutionAdapter({
    fetchFn: async (url, init = {}) => {
      if (url.endsWith('/global/health')) return response({ healthy: true });
      if (url.endsWith('/session') && init.method === 'POST') return response({ id: 'ses-r' });
      if (url.endsWith('/global/event')) return response(null, { body: sse('data: {"payload":{"type":"session.idle","properties":{"sessionID":"ses-r"}}}\n\n') });
      if (url.endsWith('/prompt_async')) return response(null, { status: 204 });
      throw new Error(`unexpected URL ${url}`);
    },
    resolveFn: (command, args) => {
      assert.equal(command, 'opencode');
      return { command: powershell, args: [...prefix, ...args], resolved: true };
    },
    spawnFn: (command, args) => {
      calls.push({ command, args });
      return child;
    },
    reservePort: async () => 43123,
    secret: () => 'ephemeral',
  });
  await adapter.launch(await adapter.prepare({ worker, cwd: process.cwd() }));
  assert.equal(calls[0].command, powershell);
  assert.deepEqual(calls[0].args, [
    ...prefix, 'serve', '--hostname', '127.0.0.1', '--port', '0',
  ]);

  let spawned = false;
  const unsafe = createOpenCodeExecutionAdapter({
    resolveFn: (command, args) => ({ command, args, resolved: false }),
    spawnFn: () => { spawned = true; return child; },
  });
  await assert.rejects(
    unsafe.launch(await unsafe.prepare({ worker, cwd: process.cwd() })),
    /no safe Windows invocation/,
  );
  assert.equal(spawned, false);
});

test('teardownTimeoutMs bounds both session abort and instance disposal', async () => {
  const abortedPaths = [];
  const fetchFn = (url, { signal } = {}) => new Promise((resolve, reject) => {
    const pathname = new URL(url).pathname;
    const onAbort = () => {
      abortedPaths.push(pathname);
      reject(Object.assign(new Error(`${pathname} aborted`), { name: 'AbortError' }));
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
  });
  const cancelChild = { signals: [], kill(signal) { this.signals.push(signal); return true; } };
  const cleanupChild = { signals: [], kill(signal) { this.signals.push(signal); return true; } };
  const adapter = createOpenCodeExecutionAdapter({
    fetchFn,
    teardownTimeoutMs: 10,
    secret: () => 'ephemeral',
  });
  const baseState = {
    endpoint: 'http://127.0.0.1:43123',
    password: 'ephemeral',
    sessionId: 'ses-timeout',
  };
  let guard;
  let cancelled;
  let cleaned;
  try {
    [cancelled, cleaned] = await Promise.race([
      Promise.all([
        adapter.cancel({ ...baseState, child: cancelChild, eventAbort: new AbortController() }),
        adapter.cleanup({ ...baseState, child: cleanupChild, eventAbort: new AbortController() }),
      ]),
      new Promise((resolve, reject) => {
        guard = setTimeout(() => reject(new Error('teardown requests exceeded the test deadline')), 500);
      }),
    ]);
  } finally {
    clearTimeout(guard);
  }
  assert.deepEqual(cancelled, { type: 'cancelled' });
  assert.deepEqual(cleaned, { cleaned: true });
  assert.deepEqual(
    new Set(abortedPaths),
    new Set(['/session/ses-timeout/abort', '/instance/dispose']),
    'both hanging teardown requests observe the configured abort deadline',
  );
  assert.deepEqual(cancelChild.signals, ['SIGTERM']);
  assert.deepEqual(cleanupChild.signals, ['SIGTERM']);
});

// S3: the SSE per-line accumulator is capped — a never-terminating line is a
// bounded protocol error, not unbounded memory growth.
test('an SSE line that never terminates is capped (S3 — bounded protocol error)', async () => {
  const child = { kill: () => true };
  const hugeLine = `data: {"payload":{"type":"session.idle","properties":{"sessionID":"ses-x","pad":"${'x'.repeat(300 * 1024)}"}}`;
  const fetchFn = async (url, init = {}) => {
    if (url.endsWith('/global/health')) return response({ healthy: true });
    if (url.endsWith('/session') && init.method === 'POST') return response({ id: 'ses-x' });
    if (url.endsWith('/global/event')) {
      return response(null, {
        body: new ReadableStream({
          start(controller) { controller.enqueue(new TextEncoder().encode(hugeLine)); },
        }),
      });
    }
    if (url.endsWith('/prompt_async')) return response(null, { status: 204 });
    if (url.endsWith('/message')) return response([]);
    if (url.endsWith('/instance/dispose')) return response(null, { status: 204 });
    throw new Error(`unexpected URL ${url}`);
  };
  const adapter = createOpenCodeExecutionAdapter({
    fetchFn, spawnFn: () => child, reservePort: async () => 43123, secret: () => 'ephemeral', clock: () => '2026-07-29T00:00:00.000Z',
  });
  const launched = await adapter.launch(await adapter.prepare({ worker, cwd: process.cwd() }));
  const observation = await adapter.observe(launched);
  assert.equal(observation.type, 'error');
  assert.match(observation.error?.data?.message ?? '', /exceeded the \d+-byte cap/, 'the cap fires as a protocol error');
});

// #88 test-gap: SSE events from a FOREIGN session must be ignored — deleting
// the sessionID filter would terminate on any session's idle.
test('events from a foreign session are ignored until our own session goes idle', async () => {
  const child = { kill: () => true };
  const events = 'data: {"payload":{"type":"session.idle","properties":{"sessionID":"ses-OTHER"}}}\n\n'
    + 'data: {"payload":{"type":"session.idle","properties":{"sessionID":"ses-own"}}}\n\n';
  const fetchFn = async (url, init = {}) => {
    if (url.endsWith('/global/health')) return response({ healthy: true });
    if (url.endsWith('/session') && init.method === 'POST') return response({ id: 'ses-own' });
    if (url.endsWith('/global/event')) return response(null, { body: sse(events) });
    if (url.endsWith('/prompt_async')) return response(null, { status: 204 });
    if (url.endsWith('/message')) return response([{ info: { role: 'assistant', providerID: 'opencode', modelID: 'm1' } }]);
    if (url.endsWith('/instance/dispose')) return response(null, { status: 204 });
    throw new Error(`unexpected URL ${url}`);
  };
  const adapter = createOpenCodeExecutionAdapter({
    fetchFn, spawnFn: () => child, reservePort: async () => 43123, secret: () => 'ephemeral', clock: () => '2026-07-29T00:00:00.000Z',
  });
  const observation = await adapter.observe(await adapter.launch(await adapter.prepare({ worker, cwd: process.cwd() })));
  assert.equal(observation.type, 'idle', 'our own idle event terminates — the foreign one did not end the wait early');
});

// #88 test-gap: the TERM-then-KILL sequence is asserted, not just the verdict.
test('a TERM/KILL-surviving server remains orphaned after cancellation and cleanup', async () => {
  // A child WITH lifecycle events that never closes: the grace wait must time
  // out (not short-circuit), so the bounded KILL fallback actually fires.
  const child = { signals: [], exitCode: null, signalCode: null, once() { return this; }, kill(signal) { this.signals.push(signal); return true; } };
  const fetchFn = async (url, init = {}) => {
    if (url.endsWith('/global/health')) return response({ healthy: true });
    if (url.endsWith('/session') && init.method === 'POST') return response({ id: 'ses-k' });
    if (url.endsWith('/global/event')) return response(null, { body: new ReadableStream({ start() {} }) });
    if (url.endsWith('/prompt_async')) return new Promise(() => {});
    throw new Error(`unexpected URL ${url}`);
  };
  const adapter = createOpenCodeExecutionAdapter({
    fetchFn, spawnFn: () => child, haveFn: async () => true, reservePort: async () => 43123, secret: () => 'ephemeral',
    terminationGraceMs: 5, forceGraceMs: 5,
  });
  const result = await executeWorker(worker, adapter, { cwd: process.cwd(), timeoutMs: 20 });
  assert.equal(result.status, 'failed');
  assert.equal(result.exitCategory, 'orphaned');
  assert.deepEqual(
    child.signals,
    ['SIGTERM', 'SIGKILL', 'SIGTERM', 'SIGKILL'],
    'both cancel and final cleanup prove the survivor with TERM then KILL',
  );
});

test('a stalled prompt submission becomes a timeout and tears down its owned server', async () => {
  const child = { signals: [], kill(signal) { this.signals.push(signal); return true; } };
  const fetchFn = async (url, init = {}) => {
    if (url.endsWith('/global/health')) return response({ healthy: true });
    if (url.endsWith('/session') && init.method === 'POST') return response({ id: 'ses-6' });
    if (url.endsWith('/global/event')) return response(null, { body: new ReadableStream({ cancel() {} }) });
    if (url.endsWith('/prompt_async')) return new Promise(() => {});
    throw new Error(`unexpected URL ${url}`);
  };
  const adapter = createOpenCodeExecutionAdapter({
    fetchFn, spawnFn: () => child, haveFn: async () => true, reservePort: async () => 43128, secret: () => 'ephemeral',
  });
  const result = await executeWorker(worker, adapter, { cwd: process.cwd(), timeoutMs: 20 });
  assert.equal(result.status, 'timed_out');
  assert.equal(result.exitCategory, 'timeout');
  assert.match(result.failure.reason, /launch exceeded|prompt_async timed out/);
  assert.deepEqual(child.signals, ['SIGTERM', 'SIGTERM']);
});

test('the shared deadline aborts every OpenCode launch await and cleans progressive state', async () => {
  const { EventEmitter } = await import('node:events');
  const pendingFetch = (signal) => new Promise((_, reject) => {
    const abort = () => reject(Object.assign(new Error('aborted by attempt deadline'), { name: 'AbortError' }));
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });

  for (const stage of ['port', 'health', 'session', 'event', 'prompt']) {
    const child = new EventEmitter();
    child.exitCode = null;
    child.signalCode = null;
    child.signals = [];
    if (stage === 'port') {
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
    }
    child.kill = (signal) => {
      child.signals.push(signal);
      child.signalCode = signal;
      queueMicrotask(() => child.emit('close', null, signal));
      return true;
    };
    const fetchFn = async (url, init = {}) => {
      if (url.endsWith('/instance/dispose') || url.endsWith('/abort')) return response(null, { status: 204 });
      if (url.endsWith('/global/health')) {
        if (stage === 'health') return pendingFetch(init.signal);
        return response({ healthy: true });
      }
      if (url.endsWith('/session') && init.method === 'POST') {
        if (stage === 'session') return pendingFetch(init.signal);
        return response({ id: `ses-${stage}` });
      }
      if (url.endsWith('/global/event')) {
        if (stage === 'event') return pendingFetch(init.signal);
        return response(null, {
          body: sse(`data: {"payload":{"type":"session.idle","properties":{"sessionID":"ses-${stage}"}}}\n\n`),
        });
      }
      if (url.endsWith('/prompt_async')) {
        if (stage === 'prompt') return pendingFetch(init.signal);
        return response(null, { status: 204 });
      }
      throw new Error(`unexpected URL ${url}`);
    };
    const adapter = createOpenCodeExecutionAdapter({
      fetchFn,
      spawnFn: () => child,
      haveFn: async () => true,
      reservePort: async ({ signal } = {}) => (
        stage === 'port'
          ? pendingFetch(signal)
          : 43200
      ),
      secret: () => 'ephemeral',
      terminationGraceMs: 2,
      forceGraceMs: 2,
      teardownTimeoutMs: 10,
    });
    const result = await executeWorker(worker, adapter, {
      cwd: process.cwd(),
      timeoutMs: 12,
    });
    assert.equal(result.status, 'timed_out', stage);
    assert.equal(result.exitCategory, 'timeout', stage);
    assert.deepEqual(child.signals, ['SIGTERM'], `${stage}: acquired child was terminated exactly once`);
  }
});
