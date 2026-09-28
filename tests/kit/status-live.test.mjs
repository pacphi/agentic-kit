// `ak status --refresh=live` (decision 9b, #237 S4; ADR-0063): an opt-in run of
// the quick, free live checks (src/lib/live-checks.mjs) in parallel, each
// under its own timeout (a timeout reads inconclusive, never failed), recorded
// in the live-check evidence store. Plain `ak status` and the dashboard never
// run them; they show the remembered results with their age.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  sandboxHome, assertSandboxed, captureLog, rmrf,
  sandboxProject, writeKitConfig, offlineKitConfig, fakeGlobalRoot, spawnEnv,
} from './helpers/home-sandbox.mjs';

const HOME = sandboxHome('ak-status-live');
delete process.env.AQE_EMBEDDER_ENDPOINT;
const paths = await import('../../src/lib/paths.mjs');
const evidence = await import('../../src/lib/live-check-evidence.mjs');
const verify = await import('../../src/lib/live-checks.mjs');
const status = await import('../../src/commands/status.mjs');
const refresh = await import('../../src/lib/refresh.mjs');
const { loadKitConfig } = await import('../../src/lib/config.mjs');
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
    assert.ok(!verify.liveChecksFor(cfg).some((check) => check.id === slow), `${slow} is slow; never in the live stage`);
  }
});

test('checks run in parallel and their results are remembered as status-refresh-live', async () => {
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
  assert.equal(security.source, 'status-refresh-live');
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
  const record = (id, status, reason, at = Date.now() - 3 * 60_000) => evidence.recordLiveCheck({ id, status, reason, source: 'status-refresh-live',
    inputsKey: evidence.liveCheckInputsKey(id, { cfg, cwd: PROJECT }) }, { now: at });
  record('security', 'failed', '@claude-flow/security missing');
  record('memory', 'passed', null);
  record('aqe-embedding', 'failed', 'endpoint-unreachable');
  const rows = await liveSection.collect({ cfg, cwd: PROJECT });
  assert.deepEqual(rows.map((r) => [r.subsystem, r.level, r.fix]),
    [['live-checks', 'warn', null], ['live-checks', 'ok', null]], 'aqe-embedding stays in its own row');
  assert.match(rows[0].message, /^security: last live check failed 3m ago \(ak status --refresh=live\): @claude-flow\/security missing$/);
  assert.match(rows[1].message, /^memory: last live check passed 3m ago/);
});

test('a result the configuration no longer matches points at the live refresh', async () => {
  reset();
  evidence.recordLiveCheck({ id: 'memory', status: 'passed', reason: null, source: 'status-refresh-live', inputsKey: 'another-configuration' });
  const [memory] = await liveSection.collect({ cfg, cwd: PROJECT });
  assert.match(memory.message, /^memory: configuration changed since the last live check \(just now\); re-check with ak status --refresh=live$/);
});

// ── the command ──────────────────────────────────────────────────────────────
// `--refresh=live` runs the CLI stage set with the live checks as a spy. The
// collector, Maintenance service and management facade are fakes: the real
// ones write <state>/agentic-kit/maintenance/. The local stage is the real
// status re-check, so the rows show what the live stage remembered. That
// re-check resolves the npm global root afresh, past `_setGlobalRootForTest`,
// so npm_config_prefix points it at the same fake tree (the live-check key of
// `security` and `memory` is the installed ruflo version found there).

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// Self-contained so the child script below can embed its source text.
const fakeServices = () => ({
  collector: { refreshDeep: async () => ({ ok: true, persisted: { ok: true } }) },
  maintenance: { scan: async () => ({ scan: {} }) },
  management: { refreshInventory: async () => ({}), rebuildAfterMeasurement: async () => ({}) },
});
const fakeRoot = () => fakeGlobalRoot(HOME, { ruflo: '9.9.9', 'agentic-qe': '9.9.9' });

/** status.run from the project, with the CLI stages built there (so the live
 *  checks see the same cwd `ak status` passes them). */
async function runStatus(flags, runLive) {
  const prior = { cwd: process.cwd(), prefix: process.env.npm_config_prefix };
  const root = fakeRoot();
  paths._setGlobalRootForTest(root);
  process.env.npm_config_prefix = path.dirname(root);
  process.chdir(PROJECT);
  try {
    const refreshStages = refresh.cliRefreshStages({ cwd: process.cwd(), pkgRoot: PKG_ROOT, deps: { ...fakeServices(), runLive } });
    return await captureLog(() => status.run({ flags, pkgRoot: PKG_ROOT, deps: { refreshStages } }));
  } finally {
    process.chdir(prior.cwd);
    if (prior.prefix === undefined) delete process.env.npm_config_prefix; else process.env.npm_config_prefix = prior.prefix;
  }
}
const failedRows = (out) => (/^ {2}✗ /m.test(out) ? 1 : 0);

test('plain status never runs a live check', async () => {
  writeKitConfig(HOME, cfg);
  let calls = 0;
  await runStatus({}, async () => { calls += 1; return []; });
  assert.equal(calls, 0);
});

test('status --refresh=live runs the checks before the local re-check, so the rows show them', async () => {
  writeKitConfig(HOME, cfg);
  reset();
  let seenCfg;
  const runLive = async ({ cfg: seen, cwd }) => {
    seenCfg = seen;
    assert.equal(cwd, fs.realpathSync(PROJECT));
    evidence.recordLiveCheck({ id: 'security', status: 'failed', reason: 'defend ambiguous', source: 'status-refresh-live',
      inputsKey: evidence.liveCheckInputsKey('security', { cfg: seen, cwd }) });
    return [{ id: 'security', status: 'failed', reason: 'defend ambiguous', elapsedMs: 5 }];
  };
  const { out, result } = await runStatus({ refresh: 'live' }, runLive);
  assert.deepEqual(seenCfg, loadKitConfig(), 'the live checks get the kit config');
  assert.match(out, /^Running live checks…\n✓ Running live checks \(\d+ ms\): 1 failed$/m,
    'the start of the live checks is announced, then their result');
  assert.match(out, /security: last live check failed just now \(ak status --refresh=live\): defend ambiguous/);
  assert.equal(result, failedRows(out), 'a failed live check is a warning; only a failing row sets the exit code');
});

test('status --refresh=live --json prints one JSON object that carries the live results', () => {
  writeKitConfig(HOME, cfg);
  const moduleUrl = (rel) => pathToFileURL(path.join(PKG_ROOT, rel)).href;
  const root = fakeRoot();
  const script = `
    const paths = await import(${JSON.stringify(moduleUrl('src/lib/paths.mjs'))});
    paths._setGlobalRootForTest(${JSON.stringify(root)});
    const status = await import(${JSON.stringify(moduleUrl('src/commands/status.mjs'))});
    const refresh = await import(${JSON.stringify(moduleUrl('src/lib/refresh.mjs'))});
    const { exitWhenFlushed } = await import(${JSON.stringify(moduleUrl('src/lib/output.mjs'))});
    const runLive = async () => [{ id: 'memory', status: 'passed', reason: null, elapsedMs: 9 }];
    const fakeServices = ${fakeServices.toString()};
    const refreshStages = refresh.cliRefreshStages({ cwd: process.cwd(), pkgRoot: ${JSON.stringify(PKG_ROOT)},
      deps: { ...fakeServices(), runLive } });
    exitWhenFlushed(await status.run({ flags: { refresh: 'live', json: true }, pkgRoot: ${JSON.stringify(PKG_ROOT)},
      deps: { refreshStages } }));
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: PROJECT, env: spawnEnv(HOME, { NO_COLOR: '1', npm_config_prefix: path.dirname(root) }), encoding: 'utf8', timeout: 120_000,
  });
  assert.ok(child.stdout.trim().startsWith('{'), `stdout is not a JSON object:\n${child.stdout}\n--- stderr:\n${child.stderr}`);
  const parsed = JSON.parse(child.stdout);
  assert.equal(child.status, parsed.overall === 'fail' ? 1 : 0, child.stderr);
  assert.equal(parsed.refresh.ok, true);
  assert.deepEqual(parsed.live, [{ id: 'memory', status: 'passed', reason: null, elapsedMs: 9 }]);
  assert.ok(Array.isArray(parsed.rows) && parsed.rows.length > 0);
  assert.deepEqual(parsed.refresh.stages.map(({ id, state }) => [id, state]),
    [['maintenance', 'done'], ['inventory', 'done'], ['live', 'done'], ['local', 'done']]);
});

test.after(() => rmrf(HOME, PROJECT));
