import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EXECUTION_ADAPTERS } from '../../src/lib/execution/adapters.mjs';
import { executeRunPlan } from '../../src/lib/execution/runner.mjs';

const worker = (id, host = 'opencode', dependsOn) => ({ id, activity: 'implementation', role: 'coder', host, prompt: id, ...(dependsOn ? { dependsOn } : {}) });
const clock = () => '2026-07-29T00:00:00.000Z';
const handoff = (outcome = 'done') => ({
  outcome, artifacts: [], decisions: [], risks: [],
});

test('the built-in registry exposes supervised transports for every managed host', () => {
  assert.equal(EXECUTION_ADAPTERS.get('claude').id, 'claude-print-json');
  assert.equal(EXECUTION_ADAPTERS.get('codex').id, 'codex-exec-json');
  assert.equal(EXECUTION_ADAPTERS.get('opencode').id, 'opencode-server');
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
    summarize(state) { return handoff(`completed ${state.worker.id}`); },
    async cancel(state) { events.push(`cancel:${state.worker.id}`); },
    async cleanup(state) { events.push(`cleanup:${state.worker.id}`); },
  };
}

// ── bounded escalation (ADR-0019) ───────────────────────────────────────────

/** An adapter that fails (or succeeds) per host with a canned script. */
function scriptedAdapter(events, script) {
  return {
    id: 'scripted',
    async readiness() { return { ready: true }; },
    async prepare({ worker: w }) { return { worker: w }; },
    async launch(state) { return state; },
    async observe(state) { events.push(`observe:${state.worker.host}`); return script.observe?.() ?? { type: 'idle' }; },
    interpret(state, _observed) {
      const fail = script.fail;
      return {
        workerId: state.worker.id, activity: state.worker.activity, role: state.worker.role, host: state.worker.host,
        status: fail ? (script.status ?? 'failed') : 'succeeded',
        exitCategory: fail ? (script.exitCategory ?? 'worker_error') : 'success',
        startedAt: clock(), endedAt: clock(), durationMs: 1,
        provider: null, providerProvenance: 'unknown', configuredModel: state.worker.configuredModel ?? null,
        observedModel: null, sessionId: null, transcriptRefs: [],
        failure: fail ? { reason: script.reason ?? 'scripted failure' } : null, usage: null,
      };
    },
    summarize(state) { return script.handoff ?? handoff(`completed on ${state.worker.host}`); },
    async cancel() {},
    async cleanup() {},
  };
}

const escalatableWorker = (id, host, ladder) => ({
  id, activity: 'implementation', role: 'coder', host, configuredModel: `${host}-model`,
  prompt: id, ...(ladder ? { escalate: ladder } : {}),
});

test('escalation advances one rung on failure and records the full trail (OpenCode-qualified route)', async () => {
  const events = [];
  const adapters = {
    opencode: scriptedAdapter(events, { fail: true, reason: 'serve 400' }),
    claude: scriptedAdapter(events, { fail: false }),
  };
  const plan = { workers: [
    escalatableWorker('coder', 'opencode', [{ host: 'claude', model: 'claude-opus-5' }]),
    { ...escalatableWorker('reviewer', 'claude'), dependsOn: ['coder'], role: 'reviewer', activity: 'review' },
  ] };
  const results = await executeRunPlan(plan, { adapters, escalate: true, clock });
  const coder = results.find((r) => r.workerId === 'coder');
  assert.equal(coder.status, 'succeeded', 'the claude rung carried the worker');
  assert.equal(coder.host, 'claude', 'the final result reports the rung that actually ran');
  assert.equal(coder.attempts.length, 2);
  assert.deepEqual(
    coder.attempts.map((a) => [a.host, a.status]),
    [['opencode', 'failed'], ['claude', 'succeeded']],
    'ordered, bounded trail — opencode first, then the claude rung',
  );
  assert.match(coder.attempts[0].reason, /serve 400/);
  assert.equal(results.find((r) => r.workerId === 'reviewer').status, 'succeeded',
    'an escalated success unblocks dependents');
});

test('escalation is bounded by the ladder and records every attempt when it exhausts', async () => {
  const events = [];
  const adapters = {
    opencode: scriptedAdapter(events, { fail: true, reason: 'first' }),
    claude: scriptedAdapter(events, { fail: true, reason: 'second' }),
    codex: scriptedAdapter(events, { fail: true, reason: 'third' }),
  };
  const plan = { workers: [escalatableWorker('coder', 'opencode', [{ host: 'claude' }, { host: 'codex' }])] };
  const [result] = await executeRunPlan(plan, { adapters, escalate: true, clock });
  assert.equal(result.status, 'failed');
  assert.equal(result.attempts.length, 3, 'three attempts, then it stops — no unbounded retry');
  assert.deepEqual(result.attempts.map((a) => a.host), ['opencode', 'claude', 'codex']);
  assert.equal(result.host, 'codex', 'the final result is the last rung actually executed');
});

test('consent and uncertain states are never escalated (permission, orphaned, blocked)', async () => {
  for (const [exitCategory, status] of [['permission_required', 'failed'], ['orphaned', 'failed'], ['worker_error', 'blocked']]) {
    const adapters = {
      opencode: scriptedAdapter([], { fail: true, exitCategory, status }),
      claude: scriptedAdapter([], { fail: false }),
    };
    const plan = { workers: [escalatableWorker('coder', 'opencode', [{ host: 'claude' }])] };
    const [result] = await executeRunPlan(plan, { adapters, escalate: true, clock });
    assert.equal(result.attempts ?? undefined, undefined,
      `${exitCategory}/${status} must not escalate (attempts absent — single attempt, no trail fabricated)`);
    assert.equal(result.host, 'opencode', 'no rung was attempted past the boundary');
  }
});

test('without --escalate a ladder-carrying worker makes exactly one attempt', async () => {
  const events = [];
  const adapters = { opencode: scriptedAdapter(events, { fail: true }), claude: scriptedAdapter(events, { fail: false }) };
  const plan = { workers: [escalatableWorker('coder', 'opencode', [{ host: 'claude' }])] };
  const [result] = await executeRunPlan(plan, { adapters, escalate: false, clock });
  assert.equal(result.status, 'failed');
  assert.equal(result.attempts ?? undefined, undefined);
  assert.deepEqual(events.filter((e) => e.startsWith('observe:')), ['observe:opencode'], 'no rung attempted');
});

test('a successful first attempt leaves no escalation trail (nothing fabricated)', async () => {
  const adapters = { opencode: scriptedAdapter([], { fail: false }) };
  const plan = { workers: [escalatableWorker('coder', 'opencode', [{ host: 'claude' }])] };
  const [result] = await executeRunPlan(plan, { adapters, escalate: true, clock });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.attempts ?? undefined, undefined, 'one attempt is indistinguishable from escalation off');
});

test('a rung with no execution adapter records cli_unavailable and advances to the next rung', async () => {
  const adapters = { codex: scriptedAdapter([], { fail: false }) };
  const plan = { workers: [escalatableWorker('coder', 'opencode', [{ host: 'claude' }, { host: 'codex' }])] };
  const [result] = await executeRunPlan(plan, { adapters, escalate: true, clock });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.attempts.length, 3);
  assert.deepEqual(result.attempts.map((a) => [a.host, a.exitCategory]),
    [['opencode', 'cli_unavailable'], ['claude', 'cli_unavailable'], ['codex', 'success']]);
});

test('the attempts trail is schema-validated end to end', async () => {
  const adapters = {
    opencode: scriptedAdapter([], { fail: true }),
    claude: scriptedAdapter([], { fail: false }),
  };
  const plan = { workers: [escalatableWorker('coder', 'opencode', [{ host: 'claude', model: 'claude-opus-5' }])] };
  const [result] = await executeRunPlan(plan, { adapters, escalate: true, clock });
  const { validateWorkerResult } = await import('../../src/lib/execution/schema.mjs');
  assert.doesNotThrow(() => validateWorkerResult(result), 'the escalated result passes the same schema');
  assert.equal(result.attempts[1].model, 'claude-opus-5', 'the rung model is recorded');
});

// qe-court A2: the timeout branch must schema-validate interpret() too — a
// malformed timeout result becomes a bounded protocol_error, never garbage
// shipped raw into `ak run --json`.
test('a malformed interpret() on the timeout path is bounded, not shipped raw (qe-court A2)', async () => {
  const malformed = {
    id: 'mal',
    async readiness() { return { ready: true }; },
    async prepare({ worker: w }) { return { worker: w }; },
    async launch(state) { return state; },
    async observe() { return new Promise(() => {}); }, // never settles → the deadline hits
    interpret() { return { bogus: true }; },            // garbage a strict validator must reject
    summarize() { return handoff(); },
    async cancel() {},
    async cleanup() {},
  };
  const results = await executeRunPlan({ workers: [worker('a', 'opencode')] }, {
    adapters: { opencode: malformed }, timeoutMs: 5, clock,
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].workerId, 'a');
  assert.equal(results[0].status, 'failed');
  assert.equal(results[0].exitCategory, 'protocol_error',
    'a malformed timeout interpret() is converted to a bounded protocol error, not shipped as-is');
  assert.ok(results[0].failure && typeof results[0].failure.reason === 'string');
});

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

test('runtime handoffs reach only declared dependents in declaration order and stay private', async () => {
  const prompts = new Map();
  const contextAdapter = {
    id: 'context',
    async readiness() { return { ready: true }; },
    async prepare({ worker: w }) { prompts.set(w.id, w.prompt); return { worker: w }; },
    async launch(state) { return state; },
    async observe(state) {
      if (state.worker.id === 'a') await new Promise((resolve) => setTimeout(resolve, 15));
      return { type: 'idle' };
    },
    interpret(state) {
      return {
        workerId: state.worker.id, activity: state.worker.activity, role: state.worker.role, host: state.worker.host,
        status: 'succeeded', exitCategory: 'success', startedAt: clock(), endedAt: clock(), durationMs: 0,
        provider: null, providerProvenance: 'unknown', configuredModel: null, observedModel: null,
        sessionId: null, transcriptRefs: [], failure: null, usage: null,
      };
    },
    summarize(state) {
      return handoff(`summary-${state.worker.id}`);
    },
    async cancel() {},
    async cleanup() {},
  };
  const plan = { workers: [
    worker('a'),
    worker('b'),
    worker('independent'),
    worker('fan-in', 'opencode', ['a', 'b']),
  ] };
  const results = await executeRunPlan(plan, {
    adapters: { opencode: contextAdapter }, maxConcurrent: 3, clock,
  });
  const fanIn = prompts.get('fan-in');
  assert.ok(fanIn.indexOf('summary-a') < fanIn.indexOf('summary-b'),
    'dependsOn declaration order wins even when b finishes first');
  assert.doesNotMatch(prompts.get('independent'), /AK_DEPENDENCY_DATA/);
  assert.match(prompts.get('a'), /AK_HANDOFF_V1/, 'a producer is asked for a handoff only at runtime');
  assert.doesNotMatch(prompts.get('fan-in'), /Internal dependency handoff required/,
    'a leaf receives dependency data but is not asked to produce another handoff');
  const wire = JSON.stringify(results);
  assert.doesNotMatch(wire, /summary-a|AK_HANDOFF|handoff/i,
    'internal summaries and protocol markers never enter public WorkerResult JSON');
});

test('a missing required handoff is a protocol error and blocks its dependent', async () => {
  const missing = adapter();
  missing.summarize = () => null;
  const results = await executeRunPlan({
    workers: [worker('producer'), worker('consumer', 'opencode', ['producer'])],
  }, { adapters: { opencode: missing }, clock });
  assert.equal(results[0].status, 'blocked');
  assert.equal(results[0].exitCategory, 'protocol_error');
  assert.match(results[0].failure.reason, /handoff was missing/);
  assert.equal(results[1].status, 'blocked');
  assert.deepEqual(results[1].failure.dependencies, ['producer']);
});

test('a malformed handoff cannot escalate and duplicate a successful producer side effect', async () => {
  const events = [];
  const malformed = scriptedAdapter(events, { fail: false, handoff: { outcome: 'missing arrays' } });
  const fallback = scriptedAdapter(events, { fail: false });
  const plan = { workers: [
    escalatableWorker('producer', 'opencode', [{ host: 'claude' }]),
    worker('consumer', 'opencode', ['producer']),
  ] };
  const results = await executeRunPlan(plan, {
    adapters: { opencode: malformed, claude: fallback },
    escalate: true,
    clock,
  });
  assert.equal(results[0].status, 'blocked');
  assert.equal(results[0].exitCategory, 'protocol_error');
  assert.equal(results[0].attempts, undefined, 'a protocol-only failure is never retried');
  assert.deepEqual(events.filter((event) => event.startsWith('observe:')), ['observe:opencode']);
  assert.equal(results[1].status, 'blocked');
});

test('escalation forwards only the final successful rung handoff', async () => {
  const prompts = [];
  const failing = scriptedAdapter([], {
    fail: true,
    handoff: handoff('must-not-forward'),
  });
  const successful = scriptedAdapter([], {
    fail: false,
    handoff: handoff('final-success'),
  });
  const consumer = {
    ...scriptedAdapter([], { fail: false }),
    async prepare({ worker: w }) { prompts.push(w.prompt); return { worker: w }; },
  };
  const plan = { workers: [
    escalatableWorker('producer', 'opencode', [{ host: 'claude' }]),
    { ...worker('consumer', 'codex', ['producer']), activity: 'review', role: 'reviewer' },
  ] };
  const results = await executeRunPlan(plan, {
    adapters: { opencode: failing, claude: successful, codex: consumer },
    escalate: true,
    clock,
  });
  assert.equal(results[0].status, 'succeeded');
  assert.match(prompts[0], /final-success/);
  assert.doesNotMatch(prompts[0], /must-not-forward/);
});

function phaseAdapter(stall, events) {
  const pending = () => new Promise(() => {});
  return {
    id: `stall-${stall}`,
    async readiness() {
      events.push('readiness');
      return stall === 'readiness' ? pending() : { ready: true };
    },
    async prepare({ worker: w }) {
      events.push('prepare');
      return stall === 'prepare' ? pending() : { worker: w, resource: false };
    },
    async launch(state) {
      events.push('launch');
      state.resource = true;
      return stall === 'launch' ? pending() : state;
    },
    async observe() {
      events.push('observe');
      return stall === 'observe' ? pending() : { type: 'idle' };
    },
    interpret(state, observation) {
      const orphaned = observation.type === 'orphaned';
      const timedOut = observation.type === 'timeout';
      return {
        workerId: state.worker.id, activity: state.worker.activity, role: state.worker.role, host: state.worker.host,
        status: orphaned ? 'failed' : (timedOut ? 'timed_out' : 'succeeded'),
        exitCategory: orphaned ? 'orphaned' : (timedOut ? 'timeout' : 'success'),
        startedAt: clock(), endedAt: clock(), durationMs: 0,
        provider: null, providerProvenance: 'unknown', configuredModel: null, observedModel: null,
        sessionId: null, transcriptRefs: [], failure: timedOut || orphaned ? { reason: observation.reason ?? observation.type } : null,
        usage: null,
      };
    },
    summarize() { return handoff(); },
    async cancel(state) { events.push(`cancel:${state.resource}`); return { type: 'cancelled' }; },
    async cleanup(state) { events.push(`cleanup:${state.resource}`); return { cleaned: true }; },
  };
}

test('one deadline bounds readiness, prepare, launch, and observe with phase-correct cleanup', async () => {
  for (const phase of ['readiness', 'prepare', 'launch', 'observe']) {
    const events = [];
    const [result] = await executeRunPlan({ workers: [worker('deadline')] }, {
      adapters: { opencode: phaseAdapter(phase, events) },
      timeoutMs: 8,
      clock,
    });
    assert.equal(result.status, 'timed_out', phase);
    assert.equal(result.exitCategory, 'timeout', phase);
    if (phase === 'readiness' || phase === 'prepare') {
      assert.equal(events.some((event) => event.startsWith('cancel:')), false, `${phase}: no resource state`);
      assert.equal(events.some((event) => event.startsWith('cleanup:')), false, `${phase}: no resource state`);
    } else {
      assert.ok(events.includes('cancel:true'), `${phase}: acquired resource is cancelled`);
      assert.ok(events.includes('cleanup:true'), `${phase}: acquired resource is cleaned`);
    }
  }
});

test('the attempt budget is shared rather than renewed for every lifecycle phase', async () => {
  const wait = () => new Promise((resolve) => setTimeout(resolve, 10));
  const events = [];
  const slow = phaseAdapter('none', events);
  slow.readiness = async () => { events.push('readiness'); await wait(); return { ready: true }; };
  slow.prepare = async ({ worker: w }) => { events.push('prepare'); await wait(); return { worker: w, resource: false }; };
  slow.launch = async (state) => { events.push('launch'); state.resource = true; await wait(); return state; };
  const started = Date.now();
  const [result] = await executeRunPlan({ workers: [worker('shared')] }, {
    adapters: { opencode: slow },
    timeoutMs: 24,
    clock,
  });
  assert.equal(result.status, 'timed_out');
  assert.ok(Date.now() - started < 60, 'three phases do not each receive a fresh 24 ms budget');
  if (events.includes('launch')) {
    assert.ok(events.includes('cancel:true'), 'an acquired launch resource is cancelled');
  } else {
    assert.equal(events.some((event) => event.startsWith('cancel:')), false,
      'scheduler delay may exhaust the shared budget before any resource exists');
  }
});

test('every lifecycle phase receives the same signal and a non-increasing remaining budget', async () => {
  const seen = [];
  const record = (phase, options) => {
    seen.push({ phase, signal: options.signal, timeoutMs: options.timeoutMs });
  };
  const measured = {
    ...phaseAdapter('none', []),
    async readiness(options) { record('readiness', options); return { ready: true }; },
    async prepare({ worker: w, ...options }) {
      record('prepare', options);
      return { worker: w, resource: false };
    },
    async launch(state, options) { record('launch', options); state.resource = true; return state; },
    async observe(_state, options) { record('observe', options); return { type: 'idle' }; },
  };
  const [result] = await executeRunPlan({ workers: [worker('measured')] }, {
    adapters: { opencode: measured },
    timeoutMs: 100,
    clock,
  });
  assert.equal(result.status, 'succeeded');
  assert.equal(new Set(seen.map(({ signal }) => signal)).size, 1, 'one AbortSignal spans the attempt');
  for (let i = 1; i < seen.length; i++) {
    assert.ok(seen[i].timeoutMs <= seen[i - 1].timeoutMs,
      `${seen[i].phase} cannot receive a renewed timeout`);
  }
});

test('cleanup orphan evidence upgrades an apparent success', async () => {
  const survivor = phaseAdapter('none', []);
  survivor.cleanup = async () => ({ cleaned: false, orphaned: true });
  const [result] = await executeRunPlan({ workers: [worker('survivor')] }, {
    adapters: { opencode: survivor },
    clock,
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.exitCategory, 'orphaned');
});

test('a cleanup exception is uncertain resource state and upgrades apparent success to orphaned', async () => {
  const uncertain = phaseAdapter('none', []);
  uncertain.cleanup = async () => { throw new Error('cleanup transport broke'); };
  const [result] = await executeRunPlan({ workers: [worker('uncertain')] }, {
    adapters: { opencode: uncertain },
    clock,
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.exitCategory, 'orphaned');
});

test('runner reports an unknown host without attempting a lifecycle', async () => {
  const [result] = await executeRunPlan({ workers: [worker('a', 'unknown')] }, { clock });
  assert.equal(result.exitCategory, 'cli_unavailable');
  assert.match(result.failure.reason, /no execution adapter/);
});

// #88: the construction invariant — every routable host has an execution
// adapter and vice versa, enforced at import. A fresh process import must
// never throw; a violating edit fails here (and at import) instead of at
// runtime with cli_unavailable on every worker.
test('routable hosts and execution adapters cannot drift apart (construction invariant)', async () => {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const path = await import('node:path');
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const r = spawnSync(process.execPath, ['-e',
    "import('./src/lib/execution/adapters.mjs').then(() => console.log('in-sync'))",
  ], { encoding: 'utf8', cwd: repo });
  assert.equal(r.status, 0, `execution adapters module must import cleanly:\n${r.stderr}`);
  assert.match(r.stdout, /in-sync/);
});

// #88 test-gap: plan-validation guards — removing any of these converts a
// throw into a silent hang or a late crash.
test('plan validation rejects duplicate ids, unknown deps, self-deps, and bad concurrency', async () => {
  await assert.rejects(executeRunPlan({ workers: [worker('a'), worker('a')] }, { clock }),
    /duplicate worker id "a"/);
  await assert.rejects(executeRunPlan({ workers: [worker('a', 'opencode', ['ghost'])] }, { clock }),
    /depends on unknown worker "ghost"/);
  await assert.rejects(executeRunPlan({ workers: [worker('a', 'opencode', ['a'])] }, { clock }),
    /cannot depend on itself/);
  await assert.rejects(executeRunPlan({ workers: [worker('a')] }, { maxConcurrent: 0, clock }),
    /maxConcurrent must be a positive integer/);
});

// #88 test-gap: a dependency cycle must throw, not hang forever.
test('a dependency cycle is detected and thrown, never silently hung', async () => {
  const plan = { workers: [worker('a', 'opencode', ['b']), worker('b', 'opencode', ['a'])] };
  await assert.rejects(executeRunPlan(plan, { adapters: { opencode: adapter({}) }, clock }),
    /dependency cycle/);
});

// #88 test-gap: readiness-false short-circuits as cli_unavailable with the reason.
test('an unready host reports cli_unavailable without attempting a lifecycle', async () => {
  const events = [];
  const unready = {
    id: 'unready',
    async readiness() { events.push('readiness'); return { ready: false, exitCategory: 'cli_unavailable' }; },
    async prepare() { events.push('prepare'); return {}; },
    async launch() { events.push('launch'); return {}; },
    async observe() { return { type: 'idle' }; },
    interpret() { events.push('interpret'); return {}; },
    summarize() { return handoff(); },
    async cancel() {},
    async cleanup() {},
  };
  const [result] = await executeRunPlan({ workers: [worker('a', 'opencode')] }, {
    adapters: { opencode: unready }, clock,
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.exitCategory, 'cli_unavailable');
  assert.match(result.failure.reason, /host is not ready/);
  assert.deepEqual(events, ['readiness'], 'prepare/launch/interpret never run for an unready host');
});
