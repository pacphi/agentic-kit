// `ak status --live` (decision 9b, #237 S4): an opt-in run of the quick, free
// `ak x verify` checks — the same functions, no second copy — in parallel, each
// under its own timeout (a timeout reads inconclusive, never failed), recorded
// in the live-check evidence store. Plain `ak status` and the dashboard never
// run them; they show the remembered results with their age.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  sandboxHome, assertSandboxed, captureLog, rmrf,
  sandboxProject, writeKitConfig, offlineKitConfig, fakeGlobalRoot,
} from './helpers/home-sandbox.mjs';

const HOME = sandboxHome('ak-status-live');
delete process.env.AQE_EMBEDDER_ENDPOINT;
const paths = await import('../../src/lib/paths.mjs');
const evidence = await import('../../src/lib/live-check-evidence.mjs');
const verify = await import('../../src/commands/x/verify.mjs');
const status = await import('../../src/commands/status.mjs');
const exec = await import('../../src/lib/exec.mjs');
const output = await import('../../src/lib/output.mjs');
const liveSection = (await import('../../src/commands/status/sections/live-checks.mjs')).default;
assertSandboxed(paths, HOME);
paths._setGlobalRootForTest(fakeGlobalRoot(HOME, { ruflo: '9.9.9', 'agentic-qe': '9.9.9' }));

const PROJECT = sandboxProject('ak-status-live');
const reset = () => rmrf(evidence.liveCheckDir());
const cfg = offlineKitConfig();

test('the default set is the quick, free checks that apply to this configuration', () => {
  const ids = (c) => verify.liveChecksFor(c).map((check) => check.id).sort();
  const managed = { ...cfg, aqeEmbedding: { mode: 'endpoint', endpoint: 'http://127.0.0.1:11434', provisioning: 'ollama' } };
  assert.deepEqual(ids({ ...managed, integrations: { hosts: { claude: true, codex: true } } }),
    ['aqe-embedding', 'mcp', 'memory', 'providers', 'security']);
  assert.deepEqual(ids({ ...managed, integrations: { hosts: { claude: true, codex: false } } }),
    ['aqe-embedding', 'memory', 'providers', 'security'], 'Codex MCP discovery needs Codex');
  assert.deepEqual(ids({ ...managed, aqe: false, security: false }), ['memory', 'providers']);
  assert.deepEqual(ids({ ...managed, aqeEmbedding: { mode: 'unmanaged' } }), ['memory', 'providers', 'security'],
    'like sync, the embedding request runs only for a backend the kit manages');
  assert.ok(ids({ ...managed, aqeEmbedding: { mode: 'in-process' } }).includes('aqe-embedding'));
  assert.ok(ids({ ...cfg, integrations: { tools: { dejaVu: { enabled: true } } } }).includes('deja-vu'));
  for (const slow of ['learning', 'harvest']) {
    assert.ok(!verify.liveChecksFor(cfg).some((check) => check.id === slow), `${slow} is slow; never in --live`);
  }
});

test('checks run in parallel and their results are remembered as status-live', async () => {
  reset();
  let started = 0;
  let release;
  const bothStarted = new Promise((resolve) => { release = resolve; });
  const meet = async () => { started += 1; if (started === 2) release(); await bothStarted; };
  const checks = [
    { id: 'security', run: async () => { await meet(); output.fail('aidefence missing'); return false; } },
    { id: 'memory', run: async () => { await meet(); output.ok('round trip'); return true; } },
  ];
  const { result, out } = await captureLog(() => verify.runLiveChecks({ cfg, cwd: PROJECT, checks, timeoutMs: 2_000 }));
  assert.deepEqual(result.map((r) => [r.id, r.status]), [['security', 'failed'], ['memory', 'passed']],
    'sequential checks would deadlock on the barrier and time out');
  assert.equal(result[0].reason, 'aidefence missing', 'a failure keeps its first failure line');
  assert.equal(out, '', 'check output is captured, not printed into the status table');
  const security = evidence.readLiveCheck('security', {
    inputsKey: evidence.liveCheckInputsKey('security', { cfg, cwd: PROJECT }) });
  assert.equal(security.source, 'status-live');
  assert.equal(security.status, 'failed');
  assert.equal(security.invalidated, false);
  assert.equal(evidence.readLiveCheck('memory', {}).status, 'passed');
});

test('a check past its timeout is inconclusive, and its spawned work is stopped', async () => {
  reset();
  let cleanedUp = false;
  const checks = [{
    id: 'providers',
    run: async () => {
      try {
        return (await exec.run(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { timeout: 60_000 })).code === 0;
      } finally { cleanedUp = true; }
    },
  }];
  const started = Date.now();
  const [r] = await verify.runLiveChecks({ cfg, cwd: PROJECT, checks, timeoutMs: 200, graceMs: 5_000 });
  assert.equal(r.status, 'inconclusive');
  assert.match(r.reason, /no result within/);
  assert.ok(cleanedUp, 'the aborted child must let the check reach its own cleanup');
  assert.ok(Date.now() - started < 10_000, 'the timeout must not wait for the 30 s child');
  assert.equal(evidence.readLiveCheck('providers', {}).status, 'inconclusive');
});

test('a check that throws is inconclusive, not failed', async () => {
  reset();
  const [r] = await verify.runLiveChecks({ cfg, cwd: PROJECT, timeoutMs: 1_000,
    checks: [{ id: 'mcp', run: async () => { throw new Error('npm is not on PATH'); } }] });
  assert.equal(r.status, 'inconclusive');
  assert.match(r.reason, /could not run/);
});

test('a check may return its own outcome (the embedding request)', async () => {
  reset();
  const [r] = await verify.runLiveChecks({ cfg, cwd: PROJECT, timeoutMs: 1_000,
    checks: [{ id: 'aqe-embedding', run: async () => ({ status: 'failed', reason: 'endpoint-unreachable' }) }] });
  assert.deepEqual([r.status, r.reason], ['failed', 'endpoint-unreachable']);
});

test('an abort scope reaches exec.run without an explicit signal', async () => {
  const controller = new AbortController();
  const pending = exec.withAbortSignal(controller.signal,
    () => exec.run(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { timeout: 60_000 }));
  setTimeout(() => controller.abort(), 50);
  const started = Date.now();
  const r = await pending;
  assert.notEqual(r.code, 0);
  assert.ok(Date.now() - started < 10_000);
});

test('the provider check never initializes AQE in a project that has none', { skip: process.platform === 'win32' }, async () => {
  reset();
  // AQE 3.14.3 `aqe health` auto-initializes `.agentic-qe` (memory.db, patterns.rvf,
  // witness keys) in its cwd — observed in a disposable HOME. A status check must not.
  const bin = fs.mkdtempSync(path.join(HOME, 'fake-aqe-'));
  const calls = path.join(bin, 'calls.log');
  fs.writeFileSync(path.join(bin, 'aqe'),
    `#!/bin/sh\necho "$@" >> "${calls}"\nif [ "$1" = health ]; then mkdir -p .agentic-qe; echo "LLM Billing: claude-code"; fi\n`,
    { mode: 0o755 });
  const priorPath = process.env.PATH;
  const prior = process.cwd();
  process.env.PATH = `${bin}${path.delimiter}/usr/bin${path.delimiter}/bin`;
  process.chdir(PROJECT);
  try {
    const checks = verify.liveChecksFor(cfg).filter((check) => check.id === 'providers');
    const [r] = await verify.runLiveChecks({ cfg, cwd: PROJECT, checks, timeoutMs: 20_000 });
    assert.equal(fs.existsSync(path.join(PROJECT, '.agentic-qe')), false, 'the check must not create an AQE store');
    const invoked = fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '';
    assert.doesNotMatch(invoked, /^health/m);
    assert.doesNotMatch(r.reason ?? '', /aqe/i, 'an uninitialized project is not a provider-wiring failure');
  } finally {
    process.chdir(prior);
    process.env.PATH = priorPath;
    rmrf(bin, path.join(PROJECT, '.agentic-qe'));
  }
});

// ── the status section that shows remembered results ────────────────────────

test('the live-checks section shows only remembered results, each with its age', async () => {
  reset();
  assert.deepEqual(await liveSection.collect({ cfg, cwd: PROJECT }), [], 'no evidence, no rows');
  const record = (id, status, reason, at = Date.now() - 3 * 60_000) => evidence.recordLiveCheck({ id, status, reason, source: 'status-live',
    inputsKey: evidence.liveCheckInputsKey(id, { cfg, cwd: PROJECT }) }, { now: at });
  record('security', 'failed', '@claude-flow/security missing');
  record('memory', 'passed', null);
  record('aqe-embedding', 'failed', 'endpoint-unreachable');
  const rows = await liveSection.collect({ cfg, cwd: PROJECT });
  assert.deepEqual(rows.map((r) => [r.subsystem, r.level, r.fix]),
    [['live-checks', 'warn', null], ['live-checks', 'ok', null]], 'aqe-embedding stays in its own row');
  assert.match(rows[0].message, /^security: last live check failed 3m ago \(ak status --live\): @claude-flow\/security missing$/);
  assert.match(rows[1].message, /^memory: last live check passed 3m ago/);
});

// ── the command ──────────────────────────────────────────────────────────────

async function runStatus(flags, runLive) {
  const prior = process.cwd();
  process.chdir(PROJECT);
  try { return await captureLog(() => status.run({ flags, pkgRoot: path.resolve('.'), runLive })); }
  finally { process.chdir(prior); }
}

test('plain status never runs a live check', async () => {
  writeKitConfig(HOME, cfg);
  let calls = 0;
  await runStatus({}, async () => { calls += 1; return []; });
  assert.equal(calls, 0);
});

test('status --live runs the checks before collecting, so the rows show them', async () => {
  writeKitConfig(HOME, cfg);
  reset();
  const runLive = async ({ cfg: seen, cwd }) => {
    assert.equal(cwd, fs.realpathSync(PROJECT));
    evidence.recordLiveCheck({ id: 'security', status: 'failed', reason: 'defend ambiguous', source: 'status-live',
      inputsKey: evidence.liveCheckInputsKey('security', { cfg: seen, cwd }) });
    return [{ id: 'security', status: 'failed', reason: 'defend ambiguous', elapsedMs: 5 }];
  };
  const { out } = await runStatus({ live: true }, runLive);
  assert.match(out, /security: last live check failed just now \(ak status --live\): defend ambiguous/);
});

test('status --live --json prints one JSON object that carries the live results', async () => {
  writeKitConfig(HOME, cfg);
  const { out } = await runStatus({ live: true, json: true },
    async () => [{ id: 'memory', status: 'passed', reason: null, elapsedMs: 9 }]);
  const parsed = JSON.parse(out);
  assert.deepEqual(parsed.live, [{ id: 'memory', status: 'passed', reason: null, elapsedMs: 9 }]);
  assert.ok(Array.isArray(parsed.rows));
});

test.after(() => rmrf(HOME, PROJECT));
