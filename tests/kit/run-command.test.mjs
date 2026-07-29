import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRunPlan, run } from '../../src/commands/run.mjs';
import { seedDualRouting } from '../../src/lib/routing.mjs';

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
  const cfg = { providers: { dualRouting: seedDualRouting() } };
  const { plan } = buildRunPlan(cfg, 'feature', 'add a queue', ['implementation:claude:claude-sonnet-5']);
  assert.equal(plan.template, 'feature');
  assert.equal(plan.workers.find((entry) => entry.id === 'coder').host, 'claude');
  assert.equal(cfg.providers.dualRouting.implementation.host, 'codex');
});

test('ak run materializes an explicit OpenCode route', () => {
  const cfg = { providers: { dualRouting: { ...seedDualRouting(), 'security-scan': {
    host: 'opencode', model: 'openrouter/example', source: 'user',
  } } } };
  const { plan } = buildRunPlan(cfg, 'security', 'src/auth');
  const scanner = plan.workers.find((entry) => entry.activity === 'security-scan');
  assert.equal(scanner.host, 'opencode');
  assert.equal(scanner.configuredModel, 'openrouter/example');
});

// qe-court B8: `--json` must emit exactly one parseable document — the human
// status line ("✓ run complete" / the failure text) is gated on !json.
// The cfg seam keeps these fully deterministic (no real kit.json is read).
const testCfg = () => ({ providers: { dualRouting: seedDualRouting() } });

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
