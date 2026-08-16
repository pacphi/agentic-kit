// P2 (ADR-0031) — the derived execution adapter for an admitted external
// host. Unit-level: every case here injects `runHook`/`haveFn`/`clock`, so
// none of it depends on a real subprocess or on B1's manifest/hook-runner
// landing timing. The real-subprocess, real-manifest black-box proof lives in
// adapter-conformance.test.mjs (the acme fixture's execution.run hook).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildAdmittedExecutionAdapter, registerAdmittedExecution, resetAdmittedExecution, admittedExecutionAdapterFor,
  resetAllAdmitted,
} from '../../src/lib/execution/admitted.mjs';
import { executionAdapterFor } from '../../src/lib/execution/adapters.mjs';
import { validateExecutionAdapter } from '../../src/lib/execution/schema.mjs';
import { normalizeHandoff, HANDOFF_START, HANDOFF_END } from '../../src/lib/execution/handoff.mjs';
import { validateAdapterManifest } from '../../src/lib/adapters/manifest.mjs';
import { applyAdmitted, effectiveHostRegistry } from '../../src/lib/adapters/admitted.mjs';
import { bootstrapHostAdapters } from '../../src/lib/adapters/admission.mjs';
import { isRoutableHost, validateRoute } from '../../src/lib/routing.mjs';

const clock = () => '2026-08-16T00:00:00.000Z';

function validHost(overrides = {}) {
  return {
    id: 'hermes',
    label: 'Hermes',
    install: { bin: 'hermes', externalInstallPolicy: 'detect-never-overwrite' },
    capabilities: {
      canDriveSession: false, canBePrimary: false, canRouteActivities: true,
      commandStatusline: false, transcripts: false, usage: false,
      nativeMcpConfig: false, nativeGuidance: false,
    },
    trust: { approvalPolicy: 'unchanged', changes: [] },
    enabledByDefault: false,
    configProjection: 'ruflo',
    observability: [],
    ...overrides,
  };
}

function hermesManifest(overrides = {}) {
  return validateAdapterManifest({
    name: 'hermes',
    version: '1.0.0',
    contract: 1,
    host: validHost(),
    detection: { bin: 'hermes' },
    driving: { surfaces: ['cli-subprocess'] },
    execution: { run: { hook: { command: ['hermes-run'], timeoutMs: 30_000 } } },
    trust: {
      changes: [{
        id: 'hermes-subprocess-hooks', kind: 'third-party-adapter', scope: 'project',
        owner: 'hermes', value: 'subprocess hooks', effect: 'run consented hooks for hermes',
      }],
    },
    ...overrides,
  });
}

const worker = (overrides = {}) => ({
  id: 'coder', activity: 'implementation', role: 'coder', host: 'hermes',
  configuredModel: 'hermes-large', prompt: 'implement the thing', ...overrides,
});

// F-9: pairs both overlay resets so they can never desync between tests.
beforeEach(() => resetAllAdmitted());

// ── shape ────────────────────────────────────────────────────────────────

test('buildAdmittedExecutionAdapter returns a shape that passes validateExecutionAdapter', () => {
  const adapter = buildAdmittedExecutionAdapter(hermesManifest());
  assert.equal(adapter.id, 'hermes-adapter');
  assert.doesNotThrow(() => validateExecutionAdapter(adapter));
});

test('buildAdmittedExecutionAdapter requires an execution block and a detection.bin', () => {
  const routableHost = {
    id: 'x', capabilities: { canRouteActivities: true },
  };
  assert.throws(() => buildAdmittedExecutionAdapter({
    host: routableHost, driving: { surfaces: ['cli-subprocess'] },
  }), TypeError);
  assert.throws(() => buildAdmittedExecutionAdapter({
    host: routableHost, driving: { surfaces: ['cli-subprocess'] }, execution: { run: { hook: { command: ['x'] } } },
  }), TypeError, 'missing detection.bin');
});

// ── readiness ────────────────────────────────────────────────────────────

test('readiness reflects haveFn', async () => {
  const ready = buildAdmittedExecutionAdapter(hermesManifest(), { haveFn: async () => true });
  assert.deepEqual(await ready.readiness({}), { ready: true });

  const notReady = buildAdmittedExecutionAdapter(hermesManifest(), { haveFn: async () => false });
  assert.deepEqual(await notReady.readiness({}), { ready: false, exitCategory: 'cli_unavailable' });
});

// ── prepare ──────────────────────────────────────────────────────────────

test('prepare rejects a worker for a different host and a relative cwd', async () => {
  const adapter = buildAdmittedExecutionAdapter(hermesManifest(), { clock });
  await assert.rejects(() => adapter.prepare({ worker: worker({ host: 'codex' }), cwd: '/abs' }), TypeError);
  await assert.rejects(() => adapter.prepare({ worker: worker(), cwd: 'relative/path' }), TypeError);
  const state = await adapter.prepare({ worker: worker(), cwd: '/abs' });
  assert.equal(state.prompt, 'implement the thing');
  assert.equal(state.startedAt, clock());
});

// ── launch: stdin, env, and the min-wins timeout margin ─────────────────

test('launch invokes runHook with stdin=prompt, AK_WORKER_* env (incl. AK_WORKER_CWD, R-2), and a margin below the phase budget', async () => {
  const calls = [];
  const runHook = async (options) => { calls.push(options); return { ok: true, stdout: 'done', stdoutText: 'done', exitCode: 0, detail: null }; };
  const adapter = buildAdmittedExecutionAdapter(hermesManifest(), { runHook, clock });
  const state = await adapter.prepare({ worker: worker(), cwd: '/abs' });
  await adapter.launch(state, { timeoutMs: 3000 });

  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(call.hostId, 'hermes');
  assert.equal(call.verb, 'run');
  assert.equal(call.stdin, 'implement the thing');
  assert.deepEqual(call.env, {
    AK_WORKER_ID: 'coder', AK_WORKER_ACTIVITY: 'implementation', AK_WORKER_ROLE: 'coder', AK_WORKER_MODEL: 'hermes-large',
    AK_WORKER_CWD: '/abs',
  });
  // Inner (hook-runner-facing) timeout must be strictly less than the phase
  // budget, so hook-runner's own kill always fires first.
  assert.ok(call.timeoutMs < 3000, 'inner timeout must undercut the phase budget');
  assert.ok(call.timeoutMs > 0);
});

test('launch sends an empty string AK_WORKER_MODEL when the worker has no configuredModel', async () => {
  const calls = [];
  const runHook = async (options) => { calls.push(options); return { ok: true, stdout: '', exitCode: 0, detail: null }; };
  const adapter = buildAdmittedExecutionAdapter(hermesManifest(), { runHook, clock });
  const state = await adapter.prepare({ worker: worker({ configuredModel: null }), cwd: '/abs' });
  await adapter.launch(state, { timeoutMs: 5000 });
  assert.equal(calls[0].env.AK_WORKER_MODEL, '');
});

// ── observe / interpret: the full mapping matrix ─────────────────────────

async function runToResult(hookResult, { worker: w = worker() } = {}) {
  const runHook = async () => hookResult;
  const adapter = buildAdmittedExecutionAdapter(hermesManifest(), { runHook, clock });
  const state = await adapter.prepare({ worker: w, cwd: '/abs' });
  await adapter.launch(state, { timeoutMs: 5000 });
  const observation = await adapter.observe(state);
  return { adapter, state, observation, result: adapter.interpret(state, observation) };
}

test('exit 0 with a JSON payload maps summary/observedModel/provider/usage and providerProvenance=inferred (F-7)', async () => {
  const stdout = JSON.stringify({
    summary: 'implemented the thing', observedModel: 'hermes-large-2', provider: 'hermes-vendor', usage: { tokens: 42 },
  });
  const { result, adapter, state, observation } = await runToResult({
    ok: true, stdout, stdoutText: stdout, stderrText: '', exitCode: 0, detail: null,
  });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.exitCategory, 'success');
  assert.equal(result.failure, null);
  assert.equal(result.observedModel, 'hermes-large-2');
  assert.equal(result.provider, 'hermes-vendor');
  // F-7: a self-declared payload provider is 'inferred', NEVER 'observed' —
  // ak did not verify the hook's claim against anything.
  assert.equal(result.providerProvenance, 'inferred');
  assert.deepEqual(result.usage, { tokens: 42 });
  assert.equal(result.host, 'hermes');

  const handoff = adapter.summarize(state, observation);
  assert.deepEqual(handoff, { outcome: 'implemented the thing', artifacts: [], decisions: [], risks: [] });
  assert.doesNotThrow(() => normalizeHandoff(handoff), 'summarize output must be normalizeHandoff-compatible');
});

test('F-7: a payload-declared provider is bounded to 64 chars', async () => {
  const longProvider = 'x'.repeat(200);
  const stdout = JSON.stringify({ summary: 'ok', provider: longProvider });
  const { result } = await runToResult({ ok: true, stdout, stdoutText: stdout, stderrText: '', exitCode: 0, detail: null });
  assert.equal(result.provider.length, 64);
  assert.equal(result.provider, longProvider.slice(0, 64));
});

test('exit 0 with plain-text stdout becomes the summary when stderr is empty', async () => {
  const { result, adapter, state, observation } = await runToResult({
    ok: true, stdout: 'plain text result', stdoutText: 'plain text result', stderrText: '', exitCode: 0, detail: null,
  });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.provider, null);
  assert.equal(result.providerProvenance, 'unknown');
  assert.equal(result.observedModel, null);
  assert.equal(result.usage, null);

  const handoff = adapter.summarize(state, observation);
  assert.deepEqual(handoff, { outcome: 'plain text result', artifacts: [], decisions: [], risks: [] });
});

test('F-4: non-empty stderrText is never auto-promoted into a summary, even with plain-text stdout', async () => {
  const { adapter, state, observation } = await runToResult({
    ok: true, stdout: 'looks like a normal result', stdoutText: 'looks like a normal result',
    stderrText: 'a stray debug line', exitCode: 0, detail: null,
  });
  assert.equal(adapter.summarize(state, observation), null,
    'stderr chatter must never become the cross-vendor dependency handoff');
});

// R-1 (HIGH, blocker fix): the pre-R-1 shape parsed the JSON payload from
// hook-runner's MERGED `stdout` field — the instant a hook wrote anything to
// stderr (a Node/npm deprecation warning, nothing to do with the hook's own
// correctness), the merged text was no longer clean JSON, JSON.parse threw,
// and a perfectly valid summary/provider/usage was silently discarded. Worse
// downstream: any worker OTHERS depend on (`requireHandoff`) would then throw
// "required worker handoff was missing" and fail the whole pipeline over one
// stderr line. Fixed by parsing from `stdoutText` (hook-runner's UNMERGED
// stdout) instead — a valid JSON payload now parses regardless of stderr;
// only the PLAIN-TEXT promotion path stays gated on stderr being empty (F-4,
// unchanged, and still proven by the sibling test above).
test('R-1: a JSON payload alongside stderr chatter STILL yields its summary, provider, and usage', async () => {
  const stdoutText = JSON.stringify({ summary: 'built the thing', provider: 'hermes-vendor', usage: { tokens: 7 } });
  const stdout = `${stdoutText}\n--- stderr ---\nnpm warn deprecated some-pkg@1.0.0`;
  const { result, adapter, state, observation } = await runToResult({
    ok: true, stdout, stdoutText, stderrText: 'npm warn deprecated some-pkg@1.0.0', exitCode: 0, detail: null,
  });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.provider, 'hermes-vendor');
  assert.equal(result.providerProvenance, 'inferred');
  assert.deepEqual(result.usage, { tokens: 7 });

  const handoff = adapter.summarize(state, observation);
  assert.deepEqual(handoff, { outcome: 'built the thing', artifacts: [], decisions: [], risks: [] });
  assert.doesNotThrow(() => normalizeHandoff(handoff));
});

test('exit 0 with empty stdout summarizes to null (no fabricated handoff)', async () => {
  const { adapter, state, observation } = await runToResult({
    ok: true, stdout: '', stdoutText: '', stderrText: '', exitCode: 0, detail: null,
  });
  assert.equal(adapter.summarize(state, observation), null);
});

// R-1 (pipeline-level): the scenario above must not just parse cleanly in
// isolation — it must not block a DEPENDENT worker either. Pre-R-1, the
// producer's missing handoff (mustSummarize, since a descendant depends on
// it) turned executeWorkerAttempt's requireHandoff check into a protocol
// error, blocking the producer AND its descendant over one stderr line.
test('R-1 (pipeline): a JSON summary alongside stderr flows to a dependent worker without blocking it', async () => {
  const { executeRunPlan } = await import('../../src/lib/execution/runner.mjs');
  const stdoutText = JSON.stringify({ summary: 'built the thing', provider: 'hermes-vendor' });
  const stdout = `${stdoutText}\n--- stderr ---\nnpm warn deprecated some-pkg@1.0.0`;
  const hookResult = {
    ok: true, stdout, stdoutText, stderrText: 'npm warn deprecated some-pkg@1.0.0', exitCode: 0, detail: null,
  };
  const runHook = async () => hookResult;
  const adapter = buildAdmittedExecutionAdapter(hermesManifest(), { runHook, clock, haveFn: async () => true });
  const plan = {
    workers: [
      { id: 'producer', activity: 'implementation', role: 'coder', host: 'hermes', prompt: 'produce' },
      {
        id: 'consumer', activity: 'review', role: 'reviewer', host: 'hermes', prompt: 'consume', dependsOn: ['producer'],
      },
    ],
  };
  const results = await executeRunPlan(plan, { adapters: { hermes: adapter }, clock });
  const producer = results.find((r) => r.workerId === 'producer');
  const consumer = results.find((r) => r.workerId === 'consumer');
  assert.equal(producer.status, 'succeeded', producer.failure?.reason);
  assert.equal(producer.provider, 'hermes-vendor');
  assert.equal(consumer.status, 'succeeded', consumer.failure?.reason);
});

test('non-zero exit maps to failed/worker_error with a bounded reason including the exit code', async () => {
  const { result, adapter, state, observation } = await runToResult({
    ok: false, stdout: 'boom on line 1\n--- stderr ---\nstack trace tail', stderrText: 'stack trace tail',
    exitCode: 1, detail: 'hermes:run adapter hook exited with code 1',
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.exitCategory, 'worker_error');
  assert.match(result.failure.reason, /code 1/);
  assert.ok(result.failure.reason.length <= 240);
  assert.equal(adapter.summarize(state, observation), null, 'a failed worker never produces a handoff');
});

test('F-3: a private handoff block embedded in the failing stdout tail is redacted from the worker_error reason', async () => {
  const leaking = `some output ${HANDOFF_START}{"outcome":"secret","artifacts":[],"decisions":[],"risks":[]}${HANDOFF_END} more`;
  const { result } = await runToResult({
    ok: false, stdout: leaking, stderrText: '', exitCode: 1, detail: 'hermes:run adapter hook exited with code 1',
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.exitCategory, 'worker_error');
  assert.doesNotMatch(result.failure.reason, /secret/);
  assert.doesNotMatch(result.failure.reason, /AK_HANDOFF_V1/);
  assert.match(result.failure.reason, /private handoff withheld/);
});

// ── F-6: reserved hook exit codes (consent/auth boundary) ────────────────

test('F-6: exit code 77 maps to status blocked / exitCategory permission_required', async () => {
  const { result } = await runToResult({
    ok: false, stdout: '', stderrText: '', exitCode: 77, detail: 'hermes:run adapter hook exited with code 77',
  });
  assert.equal(result.status, 'blocked');
  assert.equal(result.exitCategory, 'permission_required');
});

test('F-6: exit code 78 maps to status failed / exitCategory auth_required', async () => {
  const { result } = await runToResult({
    ok: false, stdout: '', stderrText: '', exitCode: 78, detail: 'hermes:run adapter hook exited with code 78',
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.exitCategory, 'auth_required');
});

test('a spawn failure (ENOENT-style) maps to failed/cli_unavailable', async () => {
  const { result } = await runToResult({
    ok: false, stdout: '', exitCode: null, detail: "hermes:run adapter hook failed to start: ENOENT (spawn hermes-run ENOENT)",
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.exitCategory, 'cli_unavailable');
  assert.match(result.failure.reason, /ENOENT/);
});

test("hook-runner's own timeout detail maps to timed_out/timeout", async () => {
  const { result } = await runToResult({
    ok: false, stdout: '', exitCode: null, detail: 'hermes:run adapter hook timed out after 5000ms and was killed',
  });
  assert.equal(result.status, 'timed_out');
  assert.equal(result.exitCategory, 'timeout');
});

// ── interpret: runner-injected terminal events (outer deadline abort) ────

test('interpret handles a runner-injected {type:"timeout"} terminal event', async () => {
  const adapter = buildAdmittedExecutionAdapter(hermesManifest(), { clock });
  const state = await adapter.prepare({ worker: worker(), cwd: '/abs' });
  const result = adapter.interpret(state, { type: 'timeout', reason: 'launch exceeded the worker deadline' });
  assert.equal(result.status, 'timed_out');
  assert.equal(result.exitCategory, 'timeout');
});

test('interpret handles a runner-injected {type:"orphaned"} terminal event', async () => {
  const adapter = buildAdmittedExecutionAdapter(hermesManifest(), { clock });
  const state = await adapter.prepare({ worker: worker(), cwd: '/abs' });
  const result = adapter.interpret(state, { type: 'orphaned' });
  assert.equal(result.status, 'failed');
  assert.equal(result.exitCategory, 'orphaned');
});

test('interpret treats an unrecognized observation as a protocol error rather than fabricating success', async () => {
  const adapter = buildAdmittedExecutionAdapter(hermesManifest(), { clock });
  const state = await adapter.prepare({ worker: worker(), cwd: '/abs' });
  const result = adapter.interpret(state, { type: 'idle' });
  assert.equal(result.status, 'failed');
  assert.equal(result.exitCategory, 'protocol_error');
});

// ── cancel / cleanup: honest post-launch no-ops, honest pre-launch orphan ─

test('cancel after launch has resolved is an honest no-op (hook-runner already owns the kill)', async () => {
  const adapter = buildAdmittedExecutionAdapter(hermesManifest(), { clock });
  const launchedState = { hookResult: { ok: true, stdout: '', stderrText: '', exitCode: 0, detail: null } };
  assert.deepEqual(await adapter.cancel(launchedState), { type: 'cancelled' });
  assert.deepEqual(await adapter.cleanup(launchedState), { cleaned: true });
});

test('F-2: cancel BEFORE launch resolves reports orphaned (non-escalating), never a plain cancelled', async () => {
  const adapter = buildAdmittedExecutionAdapter(hermesManifest(), { clock });
  const state = await adapter.prepare({ worker: worker(), cwd: '/abs' });
  // state.hookResult was never set — launch() is (hypothetically) still
  // pending when the runner's outer deadline fires and calls cancel().
  const cancelled = await adapter.cancel(state);
  assert.deepEqual(cancelled, { type: 'cancelled', orphaned: true });

  // The runner maps a cancel() reporting orphaned:true into
  // interpret(state, {type:'orphaned'}) — prove OUR adapter's interpret
  // honors that terminal shape (already covered generically for 'orphaned'
  // above, but pinned here specifically as the F-2 consequence).
  const result = adapter.interpret(state, { type: 'orphaned' });
  assert.equal(result.status, 'failed');
  assert.equal(result.exitCategory, 'orphaned');
});

// ── F-1: relative hook commands anchor to baseDir, or refuse outright ────

test('F-1: a relative hook command with no baseDir is refused at construction (execution-unanchored)', () => {
  const manifest = hermesManifest({ execution: { run: { hook: { command: ['run-hook.mjs'] } } } });
  assert.throws(() => buildAdmittedExecutionAdapter(manifest), (error) => {
    assert.equal(error.reason, 'execution-unanchored');
    return true;
  });
});

test('F-1: a relative NON-flag argument with no baseDir is refused (argv0 itself may be a bare PATH binary)', () => {
  const manifest = hermesManifest({ execution: { run: { hook: { command: ['node', 'scripts/run.mjs'] } } } });
  assert.throws(() => buildAdmittedExecutionAdapter(manifest), (error) => {
    assert.equal(error.reason, 'execution-unanchored');
    return true;
  });
});

test('F-1/R-3: a bare flag (and a non-path flag value) is never mistaken for a relative path', () => {
  const manifest = hermesManifest({ execution: { run: { hook: { command: ['hermes-run', '--config', 'x', '--verbose'] } } } });
  assert.doesNotThrow(() => buildAdmittedExecutionAdapter(manifest));
});

// R-3 (residual of F-1): the pre-R-3 shape skipped every '-'-prefixed arg
// entirely before checking whether it looked like a path — so a single
// `--flag=value` token (still '-'-prefixed as a WHOLE token) slipped past
// unchecked even when its value half was a relative script. Now every arg is
// inspected, catching this with a null baseDir exactly like a bare relative
// argument would be.
test("R-3: a '--flag=value' token whose value is a relative path is refused with a null baseDir", () => {
  const manifest = hermesManifest({ execution: { run: { hook: { command: ['node', '--import=./evil.mjs', 'hermes-run'] } } } });
  assert.throws(() => buildAdmittedExecutionAdapter(manifest), (error) => {
    assert.equal(error.reason, 'execution-unanchored');
    return true;
  });
});

test("R-3: the same '--flag=value' token is legal once a baseDir anchors the command", () => {
  const manifest = hermesManifest({ execution: { run: { hook: { command: ['node', '--import=./evil.mjs', 'hermes-run'] } } } });
  assert.doesNotThrow(() => buildAdmittedExecutionAdapter(manifest, { baseDir: '/adapters/hermes' }));
});

test('F-1: a bare PATH-resolved interpreter/binary command stays legal with no baseDir', () => {
  const manifest = hermesManifest(); // command: ['hermes-run'] — no separator, no script extension
  assert.doesNotThrow(() => buildAdmittedExecutionAdapter(manifest));
});

test('F-1: an absolute command is always legal, baseDir or not', () => {
  const manifest = hermesManifest({ execution: { run: { hook: { command: ['/usr/bin/hermes-run', '/abs/arg.mjs'] } } } });
  assert.doesNotThrow(() => buildAdmittedExecutionAdapter(manifest));
});

test('F-1: a relative command IS legal once a baseDir anchors it, and launch passes cwd=baseDir to runHook', async () => {
  const manifest = hermesManifest({ execution: { run: { hook: { command: ['node', 'run-hook.mjs'] } } } });
  const calls = [];
  const runHook = async (options) => { calls.push(options); return { ok: true, stdout: '', stderrText: '', exitCode: 0, detail: null }; };
  const adapter = buildAdmittedExecutionAdapter(manifest, { runHook, clock, baseDir: '/adapters/hermes' });
  const state = await adapter.prepare({ worker: worker(), cwd: '/abs' });
  await adapter.launch(state, { timeoutMs: 5000 });
  assert.equal(calls[0].cwd, '/adapters/hermes');
});

// R-2: the tempting fix for "the hook lost its cwd signal" would be spawning
// in the repo cwd unconditionally — but that reopens F-1 (a relative command
// would resolve against the operator's cwd again). Instead: baseDir anchors
// a relative command when one was declared; with NO baseDir, the
// construction-time check already proved the command has no relative
// component a cwd could redirect (bare PATH binaries only), so falling back
// to the repo cwd here is safe AND gives the hook a normal spawn location —
// never Node's own "inherit ak's own process.cwd()" default.
test('R-2: launch falls back to state.cwd (never omits cwd) when there is no baseDir', async () => {
  const calls = [];
  const runHook = async (options) => { calls.push(options); return { ok: true, stdout: '', stdoutText: '', stderrText: '', exitCode: 0, detail: null }; };
  const adapter = buildAdmittedExecutionAdapter(hermesManifest(), { runHook, clock }); // baseDir defaults to null
  const state = await adapter.prepare({ worker: worker(), cwd: '/abs' });
  await adapter.launch(state, { timeoutMs: 5000 });
  assert.equal(calls[0].cwd, '/abs');
});

// ── F-1 (bootstrap-level): baseDir derives from entry.source ─────────────

test('F-1 (bootstrap): an npm-sourced execution adapter with a relative command is refused with a surfaced warning', async () => {
  const manifest = hermesManifest({ execution: { run: { hook: { command: ['run-hook.mjs'] } } } });
  const { hashManifest } = await import('../../src/lib/adapters/admission.mjs');
  const hash = hashManifest(manifest);
  const result = await bootstrapHostAdapters({
    cfg: { hostAdapters: [{ name: 'hermes', source: 'npm:hermes-adapter@1.0.0' }] },
    env: { AK_EXPERIMENTAL_HOST_ADAPTERS: '1' },
    readManifest: async () => manifest,
    consent: { recordedHashFor: () => hash, isTrusted: () => true },
  });
  assert.equal(result.admitted.length, 1, 'the host itself still admits — only execution registration fails');
  const warning = result.warnings.find((w) => w.reason === 'execution-unanchored');
  assert.ok(warning, `expected an 'execution-unanchored' warning; got ${JSON.stringify(result.warnings)}`);
});

test('F-1 (bootstrap): a file-sourced manifest derives baseDir from realpath(dirname(source)) and registers cleanly', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-execution-basedir-'));
  try {
    const manifest = hermesManifest({ execution: { run: { hook: { command: ['node', 'run-hook.mjs'] } } } });
    const { hashManifest } = await import('../../src/lib/adapters/admission.mjs');
    const hash = hashManifest(manifest);
    const manifestPath = path.join(tmpDir, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    const result = await bootstrapHostAdapters({
      cfg: { hostAdapters: [{ name: 'hermes', source: manifestPath }] },
      env: { AK_EXPERIMENTAL_HOST_ADAPTERS: '1' },
      readManifest: async () => manifest,
      consent: { recordedHashFor: () => hash, isTrusted: () => true },
    });
    assert.equal(result.admitted.length, 1);
    assert.deepEqual(result.warnings, [], `expected no warnings; got ${JSON.stringify(result.warnings)}`);
    assert.notEqual(admittedExecutionAdapterFor('hermes'), null, 'registration must have succeeded with a real baseDir');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── F-5: driving.surfaces must include 'cli-subprocess' ──────────────────

test("F-5: a manifest whose driving.surfaces omits 'cli-subprocess' gets no execution adapter (surface-unsupported)", () => {
  const manifest = hermesManifest({ driving: { surfaces: ['mcp'] } });
  assert.throws(() => buildAdmittedExecutionAdapter(manifest), (error) => {
    assert.equal(error.reason, 'surface-unsupported');
    return true;
  });
});

test('F-5 (bootstrap): the execution-candidate filter refuses a non-cli-subprocess manifest with its own reason', async () => {
  const manifest = hermesManifest({ driving: { surfaces: ['mcp'] } });
  const { hashManifest } = await import('../../src/lib/adapters/admission.mjs');
  const hash = hashManifest(manifest);
  const result = await bootstrapHostAdapters({
    cfg: { hostAdapters: [{ name: 'hermes', source: '/does/not/matter/manifest.json' }] },
    env: { AK_EXPERIMENTAL_HOST_ADAPTERS: '1' },
    readManifest: async () => manifest,
    consent: { recordedHashFor: () => hash, isTrusted: () => true },
  });
  assert.equal(result.admitted.length, 1);
  const warning = result.warnings.find((w) => w.reason === 'surface-unsupported');
  assert.ok(warning, `expected a 'surface-unsupported' warning; got ${JSON.stringify(result.warnings)}`);
  assert.equal(admittedExecutionAdapterFor('hermes'), null);
});

// ── F-8: canRouteActivities is re-asserted at the construction site ──────

test('F-8: a raw canRouteActivities:false host object is refused at construction (defence-in-depth)', () => {
  const manifest = {
    host: { id: 'hermes', capabilities: { canRouteActivities: false } },
    detection: { bin: 'hermes' },
    driving: { surfaces: ['cli-subprocess'] },
    execution: { run: { hook: { command: ['hermes-run'] } } },
  };
  assert.throws(() => buildAdmittedExecutionAdapter(manifest), (error) => {
    assert.equal(error.reason, 'not-routable');
    return true;
  });
});

// ── F-9: paired overlay resets ────────────────────────────────────────────

test('F-9: resetAllAdmitted() clears both the host overlay and the execution overlay together', () => {
  const manifest = hermesManifest({ name: 'acme', host: validHost({ id: 'acme' }) });
  applyAdmitted([{ entry: manifest.host }]);
  registerAdmittedExecution(manifest);
  assert.ok(effectiveHostRegistry().some((host) => host.id === 'acme'));
  assert.notEqual(admittedExecutionAdapterFor('acme'), null);

  resetAllAdmitted();

  assert.ok(!effectiveHostRegistry().some((host) => host.id === 'acme'));
  assert.equal(admittedExecutionAdapterFor('acme'), null);
});

// ── registry: overlay discipline mirrors adapters/admitted.mjs ──────────

test('registerAdmittedExecution/admittedExecutionAdapterFor/resetAdmittedExecution round-trip, and a second register replaces', () => {
  assert.equal(admittedExecutionAdapterFor('hermes'), null);
  const first = registerAdmittedExecution(hermesManifest());
  assert.equal(admittedExecutionAdapterFor('hermes'), first);

  const second = registerAdmittedExecution(hermesManifest({ version: '1.0.1' }));
  assert.notEqual(second, first);
  assert.equal(admittedExecutionAdapterFor('hermes'), second, 'a second register replaces, not accumulates');

  resetAdmittedExecution();
  assert.equal(admittedExecutionAdapterFor('hermes'), null);
});

// ── seam: executionAdapterFor falls through to the admitted overlay ─────

test('executionAdapterFor falls through to an admitted execution adapter for a non-built-in host', () => {
  assert.equal(executionAdapterFor('hermes'), null);
  const registered = registerAdmittedExecution(hermesManifest());
  assert.equal(executionAdapterFor('hermes'), registered);
});

// ── byte-zero pins (flag/overlay off vs on) ──────────────────────────────

test('byte-zero: with nothing admitted, executionAdapterFor is null and validateRoute refuses the host', () => {
  assert.equal(executionAdapterFor('acme'), null);
  assert.equal(isRoutableHost('acme'), false);
  assert.ok(validateRoute({ host: 'acme' }).length > 0);
});

test('with the host + execution overlay applied, executionAdapterFor resolves and validateRoute accepts', () => {
  const manifest = hermesManifest({ name: 'acme', host: validHost({ id: 'acme' }) });
  applyAdmitted([{ entry: manifest.host }]);
  registerAdmittedExecution(manifest);

  assert.equal(isRoutableHost('acme'), true);
  assert.deepEqual(validateRoute({ host: 'acme' }), []);
  assert.notEqual(executionAdapterFor('acme'), null);
});
