import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClaudeExecutionAdapter as createRealClaudeExecutionAdapter } from '../../src/lib/execution/claude.mjs';
import { createCodexExecutionAdapter as createRealCodexExecutionAdapter } from '../../src/lib/execution/codex.mjs';
import { executeWorker } from '../../src/lib/execution/runner.mjs';
import { HANDOFF_END, HANDOFF_START } from '../../src/lib/execution/handoff.mjs';

const passthroughResolve = (command, args) => ({ command, args, resolved: true });
const createClaudeExecutionAdapter = (options = {}) => createRealClaudeExecutionAdapter({
  resolveFn: passthroughResolve,
  signalFn: async (child, signal) => !!child?.kill?.(signal),
  ...options,
});
const createCodexExecutionAdapter = (options = {}) => createRealCodexExecutionAdapter({
  resolveFn: passthroughResolve,
  signalFn: async (child, signal) => !!child?.kill?.(signal),
  ...options,
});

const worker = (host, model = 'model-1') => ({
  id: `${host}-1`, activity: 'implementation', role: 'coder', host, configuredModel: model, prompt: 'Do the work.',
});
const clock = () => '2026-07-29T00:00:00.000Z';

function child({ code = 0, stdout = '', stderr = '' } = {}) {
  const result = new EventEmitter();
  result.stdout = new EventEmitter();
  result.stderr = new EventEmitter();
  result.kill = () => { queueMicrotask(() => result.emit('close', null, 'SIGTERM')); return true; };
  queueMicrotask(() => {
    if (stdout) result.stdout.emit('data', stdout);
    if (stderr) result.stderr.emit('data', stderr);
    result.emit('close', code, null);
  });
  return result;
}

const tagged = (outcome) => `${HANDOFF_START}${JSON.stringify({
  outcome, artifacts: [], decisions: [], risks: [],
})}${HANDOFF_END}`;

test('Claude adapter uses bounded print/stream-json mode without a permission bypass', async () => {
  const calls = [];
  const adapter = createClaudeExecutionAdapter({
    haveFn: async () => true, clock,
    spawnFn: (command, args, options) => { calls.push({ command, args, options }); return child(); },
  });
  const result = await executeWorker(worker('claude'), adapter, { cwd: process.cwd(), clock });
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(calls[0].args, [
    '--print', '--output-format', 'stream-json', '--verbose',
    '--model', 'model-1', 'Do the work.',
  ]);
  assert.ok(!calls[0].args.some((arg) => arg.includes('dangerously') || arg.includes('bypass')));
});

test('Claude and Codex extract only tagged final-message handoffs from structured output', async () => {
  const claude = createClaudeExecutionAdapter({
    haveFn: async () => true,
    clock,
    spawnFn: () => child({
      stdout: JSON.stringify({
        type: 'result', subtype: 'success', result: `final prose\n${tagged('claude-final')}`,
      }),
    }),
  });
  const claudeState = await claude.launch(await claude.prepare({ worker: worker('claude'), cwd: process.cwd() }));
  assert.equal(claude.summarize(claudeState, await claude.observe(claudeState)).outcome, 'claude-final');

  const codex = createCodexExecutionAdapter({
    haveFn: async () => true,
    clock,
    spawnFn: () => child({
      stdout: [
        JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', text: tagged('wrong-item') } }),
        JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: tagged('codex-final') } }),
      ].join('\n'),
    }),
  });
  const codexState = await codex.launch(await codex.prepare({ worker: worker('codex'), cwd: process.cwd() }));
  assert.equal(codex.summarize(codexState, await codex.observe(codexState)).outcome, 'codex-final');
});

test('subprocess summarizers never treat raw stdout or non-message JSONL as a handoff', async () => {
  const claude = createClaudeExecutionAdapter({
    haveFn: async () => true,
    spawnFn: () => child({ stdout: tagged('raw-stdout') }),
  });
  const cs = await claude.launch(await claude.prepare({ worker: worker('claude'), cwd: process.cwd() }));
  const co = await claude.observe(cs);
  assert.throws(() => claude.summarize(cs, co), /Claude JSONL output was malformed/);

  const codex = createCodexExecutionAdapter({
    haveFn: async () => true,
    spawnFn: () => child({
      stdout: JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', text: tagged('tool-output') } }),
    }),
  });
  const xs = await codex.launch(await codex.prepare({ worker: worker('codex'), cwd: process.cwd() }));
  assert.equal(codex.summarize(xs, await codex.observe(xs)), null);
});

test('structured handoffs survive oversized unrelated JSONL without unbounded capture', async () => {
  const oversized = JSON.stringify({ type: 'noise', text: 'x'.repeat(300 * 1024) });
  const cases = [
    ['claude', createClaudeExecutionAdapter, JSON.stringify({
      type: 'result', subtype: 'success', result: tagged('claude-after-noise'),
    })],
    ['codex', createCodexExecutionAdapter, JSON.stringify({
      type: 'item.completed', item: { type: 'agent_message', text: tagged('codex-after-noise') },
    })],
  ];
  for (const [host, factory, terminal] of cases) {
    const adapter = factory({
      haveFn: async () => true,
      spawnFn: () => child({ stdout: `${oversized}\n${terminal}\n` }),
    });
    const state = await adapter.launch(await adapter.prepare({ worker: worker(host), cwd: process.cwd() }));
    const observation = await adapter.observe(state);
    assert.ok(Buffer.byteLength(observation.stdout, 'utf8') <= 256 * 1024);
    assert.equal(adapter.summarize(state, observation).outcome, `${host}-after-noise`);
  }
});

test('failed subprocess diagnostics redact complete and truncated private handoffs', async () => {
  for (const output of [
    `hook failed after ${tagged('private decision')} trailing diagnostics`,
    `hook failed after ${HANDOFF_START}secret without a closing delimiter`,
  ]) {
    const adapter = createCodexExecutionAdapter({
      haveFn: async () => true,
      spawnFn: () => child({ code: 1, stdout: output }),
    });
    const result = await executeWorker(worker('codex'), adapter, { cwd: process.cwd(), clock });
    assert.equal(result.status, 'failed');
    assert.match(result.failure.reason, /private handoff withheld/);
    assert.doesNotMatch(result.failure.reason, /private decision|secret|AK_HANDOFF/);
  }
});

// #88: per-node turn caps reach the claude CLI (--max-turns); codex has no
// equivalent surface and must not receive one.
test('claude forwards a positive maxTurns as --max-turns; unset/zero forwards nothing', async () => {
  const calls = [];
  const adapter = createClaudeExecutionAdapter({
    haveFn: async () => true, clock,
    spawnFn: (command, args) => { calls.push(args); return child(); },
  });
  await executeWorker({ ...worker('claude'), maxTurns: 15 }, adapter, { cwd: process.cwd(), clock });
  const cap = calls[0].indexOf('--max-turns');
  assert.ok(cap > 0 && calls[0][cap + 1] === '15', `expected ['--max-turns','15'] in argv: ${calls[0]}`);
  await executeWorker(worker('claude'), adapter, { cwd: process.cwd(), clock });
  assert.ok(!calls[1].includes('--max-turns'), 'no maxTurns on the worker → no flag');
  await executeWorker({ ...worker('claude'), maxTurns: 0 }, adapter, { cwd: process.cwd(), clock });
  assert.ok(!calls[2].includes('--max-turns'), 'zero is not a valid turn cap → no flag');
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

test('Codex deliberately ignores maxTurns because exec has no turn-cap flag', async () => {
  const calls = [];
  const adapter = createCodexExecutionAdapter({
    haveFn: async () => true, clock,
    spawnFn: (_command, args) => { calls.push(args); return child(); },
  });
  await executeWorker({ ...worker('codex'), maxTurns: 15 }, adapter, { cwd: '/workspace/fixture', clock });
  assert.ok(!calls[0].includes('--max-turns'));
  assert.deepEqual(calls[0], [
    'exec', '--json', '--cd', '/workspace/fixture', '--model', 'model-1', 'Do the work.',
  ]);
});

test('Claude and Codex launch the resolved invocation without joining hostile argv', async () => {
  for (const [host, factory] of [
    ['claude', createClaudeExecutionAdapter],
    ['codex', createCodexExecutionAdapter],
  ]) {
    const calls = [];
    const prompt = 'do work & whoami | $(echo pwned) "quoted"';
    const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
    const prefix = ['-NoProfile', '-File', `C:\\tools\\${host}.ps1`];
    const adapter = factory({
      haveFn: async (command) => command === host,
      resolveFn: (command, args) => {
        assert.equal(command, host);
        return { command: powershell, args: [...prefix, ...args], resolved: true };
      },
      clock,
      spawnFn: (command, args) => { calls.push({ command, args }); return child(); },
    });
    const result = await executeWorker(
      { ...worker(host), prompt },
      adapter,
      { cwd: process.cwd(), clock },
    );
    assert.equal(result.status, 'succeeded');
    assert.equal(calls[0].command, powershell);
    assert.deepEqual(calls[0].args.slice(0, prefix.length), prefix);
    assert.equal(calls[0].args.at(-1), prompt, `${host} prompt must remain one literal argv element`);
  }
});

test('subprocess launch refuses an unresolved Windows shim before spawning', async () => {
  let spawned = false;
  const adapter = createClaudeExecutionAdapter({
    haveFn: async () => true,
    resolveFn: (command, args) => ({ command, args, resolved: false }),
    spawnFn: () => { spawned = true; return child(); },
  });
  const state = await adapter.prepare({ worker: worker('claude'), cwd: process.cwd() });
  await assert.rejects(adapter.launch(state), /no safe Windows invocation/);
  assert.equal(spawned, false);
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

test('subprocess cancellation waits for TERM, then uses one bounded KILL fallback', async () => {
  const result = new EventEmitter();
  result.stdout = new EventEmitter();
  result.stderr = new EventEmitter();
  result.signals = [];
  result.kill = (signal) => {
    result.signals.push(signal);
    if (signal === 'SIGKILL') queueMicrotask(() => result.emit('close', null, signal));
    return true;
  };
  const adapter = createClaudeExecutionAdapter({
    haveFn: async () => true, clock, spawnFn: () => result,
    terminationGraceMs: 2, forceGraceMs: 20,
  });
  const state = await adapter.launch(await adapter.prepare({ worker: worker('claude'), cwd: process.cwd() }));
  assert.deepEqual(await adapter.cancel(state), { type: 'cancelled' });
  assert.deepEqual(result.signals, ['SIGTERM', 'SIGKILL']);
});

test('a subprocess surviving TERM and KILL is reported as orphaned, never timed out cleanly', async () => {
  const result = new EventEmitter();
  result.stdout = new EventEmitter();
  result.stderr = new EventEmitter();
  result.signals = [];
  result.kill = (signal) => { result.signals.push(signal); return true; };
  const adapter = createClaudeExecutionAdapter({
    haveFn: async () => true, clock, spawnFn: () => result,
    terminationGraceMs: 2, forceGraceMs: 2,
  });
  const terminal = await executeWorker(worker('claude'), adapter, {
    cwd: process.cwd(), clock, timeoutMs: 50,
  });
  assert.equal(terminal.status, 'failed');
  assert.equal(terminal.exitCategory, 'orphaned');
  assert.match(terminal.failure.reason, /did not terminate/);
  assert.deepEqual(result.signals.slice(0, 2), ['SIGTERM', 'SIGKILL']);
});
