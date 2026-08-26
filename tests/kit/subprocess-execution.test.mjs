import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClaudeExecutionAdapter as createRealClaudeExecutionAdapter } from '../../src/lib/execution/claude.mjs';
import { createCodexExecutionAdapter as createRealCodexExecutionAdapter } from '../../src/lib/execution/codex.mjs';
import { executeWorker } from '../../src/lib/execution/runner.mjs';
import {
  HANDOFF_END, HANDOFF_REQUEST_JSON, HANDOFF_REQUEST_STRUCTURED,
  HANDOFF_SCHEMA_PATH, HANDOFF_SCHEMA_TEXT, HANDOFF_START,
} from '../../src/lib/execution/handoff.mjs';
import { createPlainTextSummaryCapture } from '../../src/lib/execution/subprocess.mjs';

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
  assert.equal(calls[0].options.detached, process.platform !== 'win32',
    'POSIX workers lead a process group so cancellation reaches MCP descendants');
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

// ── schema-native handoff transport + hermetic seats (ADR-0034, #108) ────────

test('a handoff-bearing worker gets the schema flag on each host; a plain worker does not', async () => {
  const argv = { claude: [], codex: [] };
  for (const [host, factory] of [['claude', createClaudeExecutionAdapter], ['codex', createCodexExecutionAdapter]]) {
    const adapter = factory({
      haveFn: async () => true, clock,
      spawnFn: (_command, args) => { argv[host].push(args); return child(); },
    });
    await executeWorker({ ...worker(host), requiresHandoff: true }, adapter, { cwd: '/workspace/fixture', clock });
    await executeWorker(worker(host), adapter, { cwd: '/workspace/fixture', clock });
  }
  const claudeSchema = argv.claude[0].indexOf('--json-schema');
  assert.ok(claudeSchema > 0 && argv.claude[0][claudeSchema + 1] === HANDOFF_SCHEMA_TEXT);
  assert.ok(!argv.claude[1].includes('--json-schema'));
  const codexSchema = argv.codex[0].indexOf('--output-schema');
  assert.ok(codexSchema > 0 && argv.codex[0][codexSchema + 1] === HANDOFF_SCHEMA_PATH);
  assert.ok(!argv.codex[1].includes('--output-schema'));
  for (const host of ['claude', 'codex']) {
    assert.equal(argv[host][0].at(-1), 'Do the work.', `${host}: prompt stays the final argv element`);
  }
});

test('hermetic seats isolate what each host allows, without any permission bypass', async () => {
  const argv = { claude: [], codex: [] };
  for (const [host, factory] of [['claude', createClaudeExecutionAdapter], ['codex', createCodexExecutionAdapter]]) {
    const adapter = factory({
      haveFn: async () => true, clock,
      spawnFn: (_command, args) => { argv[host].push(args); return child(); },
    });
    await executeWorker({ ...worker(host), hermetic: true }, adapter, { cwd: '/workspace/fixture', clock });
    await executeWorker(worker(host), adapter, { cwd: '/workspace/fixture', clock });
  }
  // Claude: hooks off (plugin receipt mandates included), exactly one MCP
  // server, and a self-carried permission — no dependence on machine settings.
  const claudeArgs = argv.claude[0];
  const settings = claudeArgs.indexOf('--settings');
  assert.ok(settings > 0 && claudeArgs[settings + 1] === '{"disableAllHooks":true}');
  assert.ok(claudeArgs.includes('--strict-mcp-config'));
  const mcp = claudeArgs.indexOf('--mcp-config');
  assert.match(claudeArgs[mcp + 1], /"ruflo"/);
  const allowed = claudeArgs.indexOf('--allowedTools');
  assert.equal(claudeArgs[allowed + 1], 'mcp__ruflo');
  assert.ok(!claudeArgs.includes('--bare'), 'bare mode would silently switch billing off the subscription');
  // Variadic-swallow guard (observed live): --mcp-config/--allowedTools are
  // variadic, so each must be followed by a flag token, and the element
  // before the prompt must be the value of single-value --settings.
  assert.equal(claudeArgs[claudeArgs.indexOf('--allowedTools') + 2][0], '-',
    'a flag token must follow the variadic --allowedTools value');
  assert.equal(claudeArgs.at(-1), 'Do the work.');
  assert.equal(claudeArgs.at(-3), '--settings', 'single-value --settings guards the prompt');
  // Codex: bounded trims only (roster control is not available per-invocation).
  const codexArgs = argv.codex[0];
  assert.ok(codexArgs.includes('--ephemeral'));
  assert.ok(codexArgs.includes('model_reasoning_effort="medium"'));
  assert.ok(codexArgs.includes('project_doc_max_bytes=0'));
  for (const host of ['claude', 'codex']) {
    assert.ok(!argv[host][0].some((arg) => arg.includes('dangerously') || arg.includes('bypass')));
    assert.deepEqual(argv[host][1].includes('--ephemeral') || argv[host][1].includes('--settings'), false,
      `${host}: a plain worker keeps the pre-ADR-0034 argv`);
  }
});

test('each adapter asks for the handoff in its own schema mechanism\'s terms', () => {
  // codex --output-schema constrains the final message → bare-object request.
  const codex = createCodexExecutionAdapter({ haveFn: async () => true });
  assert.equal(codex.handoffRequestFor(worker('codex')), HANDOFF_REQUEST_JSON);
  // claude --json-schema derives structured_output out of band → the model is
  // told what to REPORT, never how to shape its final message (a bare-object
  // demand was obeyed live as "not applicable", refusing the task).
  const claude = createClaudeExecutionAdapter({ haveFn: async () => true });
  assert.equal(claude.handoffRequestFor(worker('claude')), HANDOFF_REQUEST_STRUCTURED);
  assert.match(HANDOFF_REQUEST_STRUCTURED, /structured output/);
  assert.doesNotMatch(HANDOFF_REQUEST_STRUCTURED, /final message/i);
  assert.doesNotMatch(HANDOFF_REQUEST_STRUCTURED, /AK_HANDOFF_V1/);
});

test('claude summarize prefers structured_output; both hosts parse a bare-JSON final message', async () => {
  const handoff = { outcome: 'schema-native', artifacts: [], decisions: [], risks: [] };
  const claude = createClaudeExecutionAdapter({
    haveFn: async () => true, clock,
    spawnFn: () => child({
      stdout: JSON.stringify({
        type: 'result', subtype: 'success', result: 'human-facing text', structured_output: handoff,
      }),
    }),
  });
  const cs = await claude.launch(await claude.prepare({ worker: worker('claude'), cwd: process.cwd() }));
  assert.equal(claude.summarize(cs, await claude.observe(cs)).outcome, 'schema-native');

  const codex = createCodexExecutionAdapter({
    haveFn: async () => true, clock,
    spawnFn: () => child({
      stdout: JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: `${JSON.stringify(handoff)}\n🧠 RuvNet Brain jumped in · guidance only, no source read · v4.2.2-dev` },
      }),
    }),
  });
  const xs = await codex.launch(await codex.prepare({ worker: worker('codex'), cwd: process.cwd() }));
  assert.equal(codex.summarize(xs, await codex.observe(xs)).outcome, 'schema-native');
});

test('a duplicated tagged block in the final message still fails closed', async () => {
  const codex = createCodexExecutionAdapter({
    haveFn: async () => true, clock,
    spawnFn: () => child({
      stdout: JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: `${tagged('one')}${tagged('two')}` },
      }),
    }),
  });
  const xs = await codex.launch(await codex.prepare({ worker: worker('codex'), cwd: process.cwd() }));
  const observation = await codex.observe(xs);
  assert.throws(() => codex.summarize(xs, observation), /malformed or duplicate/);
});

// ── plain-text summary capture (Hermes-class hosts) ──────────────────────────
// De-risks Phase 3: some oneshot hosts emit plain text on stdout rather than
// JSONL. createPlainTextSummaryCapture mirrors createJsonlSummaryCapture's
// write/read contract without the JSON parsing step — the summary is simply
// the last non-empty line seen, bounded the same way.

test('plain-text capture reads null for empty output', () => {
  const capture = createPlainTextSummaryCapture('Hermes');
  assert.equal(capture.read(), null);
});

test('plain-text capture selects the final non-empty line across multiple writes', () => {
  const capture = createPlainTextSummaryCapture('Hermes');
  capture.write('first line\nsecond line\n');
  capture.write('final line');
  assert.equal(capture.read(), 'final line');
});

test('plain-text capture ignores whitespace-only output', () => {
  const capture = createPlainTextSummaryCapture('Hermes');
  capture.write('   \n\t\n   ');
  assert.equal(capture.read(), null);
});

test('plain-text capture keeps a real line even when trailing whitespace-only lines follow', () => {
  const capture = createPlainTextSummaryCapture('Hermes');
  capture.write('real summary\n   \n');
  assert.equal(capture.read(), 'real summary');
});

test('plain-text capture discards an oversized line without poisoning a later one', () => {
  const capture = createPlainTextSummaryCapture('Hermes');
  capture.write(`${'x'.repeat(300 * 1024)}\nfinal line\n`);
  assert.equal(capture.read(), 'final line');
});

test('plain-text capture requires a label', () => {
  assert.throws(() => createPlainTextSummaryCapture(), TypeError);
});
