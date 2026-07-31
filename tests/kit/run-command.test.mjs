import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRunPlan, run } from '../../src/commands/run.mjs';
import { seedActivityRoutes } from '../../src/lib/routing.mjs';

/** Run `fn` with console.log captured; returns { result, out }. */
async function captureLog(fn) {
  const lines = [];
  const real = console.log;
  console.log = (...a) => lines.push(a.map(String).join(' '));
  try { return { result: await fn(), out: lines.join('\n') }; }
  finally { console.log = real; }
}

const succeededResult = (worker) => ({
  workerId: worker.id, activity: worker.activity, role: worker.role, host: worker.host,
  status: 'succeeded', exitCategory: 'success', startedAt: 'x', endedAt: 'y', durationMs: 1,
  provider: null, providerProvenance: 'unknown', configuredModel: worker.configuredModel ?? null,
  observedModel: null, sessionId: null, transcriptRefs: [], failure: null, usage: null,
});

test('ak run materializes the host-neutral plan and keeps run-local route overrides ephemeral', () => {
  const cfg = { routing: { routes: seedActivityRoutes() } };
  const { plan } = buildRunPlan(cfg, 'feature', 'add a queue', ['implementation:claude:claude-sonnet-5']);
  assert.equal(plan.template, 'feature');
  assert.equal(plan.workers.find((entry) => entry.id === 'coder').host, 'claude');
  assert.equal(cfg.routing.routes.implementation.host, 'codex');
});

test('ak run materializes an explicit OpenCode route', () => {
  const cfg = { routing: { routes: { ...seedActivityRoutes(), 'security-scan': {
    host: 'opencode', model: 'openrouter/example', provenance: 'user',
  } } } };
  const { plan } = buildRunPlan(cfg, 'security', 'src/auth');
  const scanner = plan.workers.find((entry) => entry.activity === 'security-scan');
  assert.equal(scanner.host, 'opencode');
  assert.equal(scanner.configuredModel, 'openrouter/example');
});

// qe-court B8: `--json` must emit exactly one parseable document — the human
// status line ("✓ run complete" / the failure text) is gated on !json.
// The cfg seam keeps these fully deterministic (no real kit.json is read).
const testCfg = () => ({ routing: { routes: seedActivityRoutes() } });

test('ak run --json emits exactly one parseable JSON document (qe-court B8)', async () => {
  const executePlan = async (plan) => plan.workers.map(succeededResult);
  const { result, out } = await captureLog(() => run({
    flags: { json: true }, positionals: ['feature', 'probe'], executePlan, cfg: testCfg(),
  }));
  assert.equal(result, 0);
  const parsed = JSON.parse(out); // throws if the status line contaminates the document
  assert.equal(parsed.plan.template, 'feature');
  assert.equal(parsed.results.length, parsed.plan.workers.length);
  assert.ok(!/run complete|non-successful/.test(out), 'no human status line in json mode');
});

test('ak run without --json still prints the human status line', async () => {
  const executePlan = async (plan) => plan.workers.map(succeededResult);
  const { result, out } = await captureLog(() => run({
    flags: {}, positionals: ['feature', 'probe'], executePlan, cfg: testCfg(),
  }));
  assert.equal(result, 0);
  assert.match(out, /run complete/);
});

// ── bounded escalation: plan materialization + CLI surface (ADR-0019) ────────

test('materializeRunPlan attaches the route ladder, dropping self-equal rungs', () => {
  const cfg = { routing: { routes: { implementation: {
    host: 'opencode', model: 'opencode/kimi-k3', provenance: 'user',
    escalation: [
      { host: 'opencode', model: 'opencode/kimi-k3' }, // self-equal: re-running this changes nothing
      { host: 'claude', model: 'claude-sonnet-5' },
    ],
  } } } };
  const { plan } = buildRunPlan(cfg, 'feature', 'probe');
  const coder = plan.workers.find((w) => w.activity === 'implementation');
  assert.deepEqual(coder.escalate, [{ host: 'claude', model: 'claude-sonnet-5' }],
    'only the non-self rung survives, with its model');
});

test('materializeRunPlan rejects an escalation rung to a non-routable host', () => {
  const cfg = { routing: { routes: { implementation: {
    host: 'claude', provenance: 'user', escalation: [{ host: 'not-a-host' }],
  } } } };
  assert.throws(() => buildRunPlan(cfg, 'feature', 'probe'),
    /escalation rung for "implementation" cannot materialize: host "not-a-host" requires canRouteActivities/);
});

test('--dry-run shows the escalation ladder on ladder-carrying workers', async () => {
  const cfg = { routing: { routes: { implementation: {
    host: 'opencode', model: 'opencode/kimi-k3', provenance: 'user',
    escalation: [{ host: 'claude', model: 'claude-sonnet-5' }],
  } } } };
  const { out } = await captureLog(() => run({
    flags: { 'dry-run': true }, positionals: ['feature', 'probe'], cfg,
  }));
  assert.match(out, /coder\s+opencode\s+opencode\/kimi-k3\s+after architect\s+↑ claude/, 'ladder visible in the plan');
});

test('--escalate flows into the executor opts; results print the escalation trail', async () => {
  let seen;
  const executePlan = async (plan, opts) => {
    seen = opts;
    return plan.workers.map((w) => ({
      ...succeededResult(w),
      attempts: [
        { host: 'opencode', model: 'opencode/kimi-k3', status: 'failed', exitCategory: 'worker_error', durationMs: 1, reason: 'serve 400' },
        { host: 'claude', model: 'claude-sonnet-5', status: 'succeeded', exitCategory: 'success', durationMs: 2 },
      ],
    }));
  };
  const { result, out } = await captureLog(() => run({
    flags: { escalate: true }, positionals: ['feature', 'probe'], executePlan, cfg: testCfg(),
  }));
  assert.equal(result, 0);
  assert.equal(seen.escalate, true, 'the flag reaches executeRunPlan');
  assert.ok(out.includes('succeeded (success)') && out.includes('escalated from opencode'),
    `the trail is visible, not silent:\n${out}`);
});

// #88: --timeout above Node's 2^31-1 ms timer ceiling is rejected, never
// silently clamped to ~1 ms for every worker.
test('--timeout above the Node timer ceiling fails with a clear error', async () => {
  const executePlan = async () => { throw new Error('must not run'); };
  const { result, out } = await captureLog(() => run({
    flags: { timeout: '3000000000' }, positionals: ['feature', 'probe'], executePlan, cfg: testCfg(),
  }));
  assert.equal(result, 2);
  assert.match(out, /timeout must not exceed 2147483647/);
});

// #88: a hand-edited routing.routes map is schema-checked at load — a bad entry
// fails with the entry named, not a padEnd crash at print time.
test('a malformed persisted route fails at build with the entry named', () => {
  for (const [policy, needle] of [
    [{ implementation: { host: 'claude', model: 123 } }, /route "implementation"\.model must be a string/],
    [{ implementation: { host: '' } }, /route "implementation" requires a non-empty host/],
    [{ implementation: { host: 'claude', escalation: [{ host: '' }] } }, /route "implementation"\.escalation\[0\] requires a non-empty host/],
    [{ implementation: 'codex' }, /route "implementation" must be an object/],
  ]) {
    assert.throws(() => buildRunPlan({ routing: { routes: policy } }, 'feature', 'probe'),
      (error) => error.message.startsWith('invalid routing policy:') && needle.test(error.message),
      `expected a named policy error for ${needle}`);
  }
});
