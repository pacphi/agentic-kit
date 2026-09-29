// The live checks and slow proofs behind `ak status --refresh=live` (ADR-0055
// live-check evidence; ADR-0063 refresh vocabulary). Without `--only` the
// quick checks that apply to the configuration run; `--only` names checks,
// runs exactly those (a named check runs even when it would not apply), and
// is the only way a slow proof runs. Every check spawns a real CLI, so these
// tests run with nothing invokable on PATH: what is pinned here is the
// selection and exit-code contract and each check's behaviour when its subject
// is absent — the case a user hits on a half-installed machine, and the one
// where a "proof" quietly reporting success would be worst.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import {
  sandboxHome, assertSandboxed, snapshot, assertUnchanged, captureLog, rmrf,
  sandboxProject, writeKitConfig, offlineKitConfig, fakeGlobalRoot,
} from './helpers/home-sandbox.mjs';

const HOME = sandboxHome('ak-live-checks');
const paths = await import('../../src/lib/paths.mjs');
const live = await import('../../src/lib/live-checks.mjs');
const evidence = await import('../../src/lib/live-check-evidence.mjs');
const projectMemorySection = (await import('../../src/commands/status/sections/project-memory.mjs')).default;
const { refreshRequestFromFlags, cliRefreshStages } = await import('../../src/lib/refresh.mjs');
const status = await import('../../src/commands/status.mjs');
const { loadKitConfig } = await import('../../src/lib/config.mjs');
assertSandboxed(paths, HOME);

const PROJECT = sandboxProject('ak-live-checks');
const GLOBAL_ROOT = fakeGlobalRoot(HOME, { ruflo: '9.9.9' });
paths._setGlobalRootForTest(GLOBAL_ROOT);
const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const seedHome = (cfg = offlineKitConfig()) => {
  rmrf(paths.configDir());
  writeKitConfig(HOME, cfg);
};

/** Run the named checks from the sandbox project, as `ak status` passes them. */
async function runOnly(only, { cfg = loadKitConfig() } = {}) {
  const cwd = process.cwd();
  process.chdir(PROJECT);
  try {
    return (await captureLog(() => live.runLiveChecks({ cfg, cwd: PROJECT, only }))).result;
  } finally { process.chdir(cwd); }
}
const texts = (result) => result.entries.map((e) => e.text).join('\n');

// ── the check names and the --only flag ─────────────────────────────────────

test('the quick checks and the slow proofs are two named lists', () => {
  assert.deepEqual(live.LIVE_CHECK_IDS, ['aqe-embedding', 'mcp', 'providers', 'security', 'deja-vu', 'memory']);
  assert.deepEqual(live.SLOW_PROOF_IDS, ['learning', 'harvest', 'aqe', 'memory-routes']);
  assert.equal(live.LIVE_CHECK_IDS, evidence.LIVE_CHECK_IDS,
    'one list: every quick check has its own evidence id, and the evidence store names no other');
});

test('--only splits comma lists, keeps order and drops repeats', () => {
  assert.deepEqual(refreshRequestFromFlags({ refresh: 'live', only: ['security,memory'] }),
    { strength: 'live', projectTrees: false, only: ['security', 'memory'] });
  assert.deepEqual(refreshRequestFromFlags({ refresh: 'live', only: ['learning', ' memory , learning'] }).only,
    ['learning', 'memory']);
  assert.deepEqual(refreshRequestFromFlags({ refresh: 'live', only: 'aqe' }).only, ['aqe'], 'a programmatic string');
  assert.deepEqual(refreshRequestFromFlags({ refresh: 'live' }).only, []);
});

test('--only needs --refresh=live', () => {
  for (const flags of [{ only: ['security'] }, { refresh: '', only: ['security'] }, { refresh: true, only: ['security'] },
    { refresh: 'machine', only: ['security'] }]) {
    const request = refreshRequestFromFlags(flags);
    assert.equal(typeof request.error, 'string', JSON.stringify(flags));
    assert.match(request.error, /--only needs --refresh=live/);
  }
});

test('an unknown --only name is refused with every accepted name', () => {
  const request = refreshRequestFromFlags({ refresh: 'live', only: ['security,bogus'] });
  assert.equal(typeof request.error, 'string');
  assert.match(request.error, /bogus/);
  for (const id of [...live.LIVE_CHECK_IDS, ...live.SLOW_PROOF_IDS]) {
    assert.ok(request.error.includes(id), `the error names ${id}: ${request.error}`);
  }
  assert.match(refreshRequestFromFlags({ refresh: 'live', only: [' , '] }).error, /--only needs a check name/);
});

test('each check carries its timeout and the evidence id its result is remembered under', () => {
  const entry = (id) => live.liveChecksFor(offlineKitConfig(), [id])[0];
  for (const id of live.LIVE_CHECK_IDS) {
    assert.equal(entry(id).timeoutMs, 60_000, id);
    assert.equal(entry(id).evidenceId, id, id);
  }
  for (const id of live.SLOW_PROOF_IDS) assert.equal(entry(id).timeoutMs, 360_000, id);
  assert.equal(entry('learning').evidenceId, null);
  assert.equal(entry('harvest').evidenceId, null);
  assert.equal(entry('aqe').evidenceId, null, 'the aqe proof remembers only its embedding request, itself');
  assert.equal(entry('memory-routes').evidenceId, 'memory-routes');
});

test('without --only the quick checks that apply run; mcp runs whenever Codex is enabled', async () => {
  seedHome();
  const results = await runOnly(undefined, { cfg: { integrations: { hosts: { codex: true } } } });
  assert.deepEqual(results.map((r) => r.id), ['mcp', 'providers', 'security', 'memory']);
  const mcp = results.find((r) => r.id === 'mcp');
  assert.equal(mcp.status, 'failed');
  assert.equal(mcp.reason, 'effective Codex MCP inventory unavailable');
  const ids = live.liveChecksFor({ integrations: { tools: { dejaVu: { enabled: true } } } }).map((c) => c.id);
  for (const slow of live.SLOW_PROOF_IDS) assert.ok(!ids.includes(slow), `${slow} runs only when named`);
});

test('--only runs exactly the named checks, even one that does not apply', async () => {
  seedHome(offlineKitConfig({ integrations: { hosts: { claude: true, codex: false } } }));
  rmrf(evidence.liveCheckDir());
  const results = await runOnly(['mcp', 'security']);
  assert.deepEqual(results.map((r) => r.id), ['mcp', 'security'], 'in the order named');
  assert.deepEqual(results.map((r) => [r.id, r.applies]), [['mcp', false], ['security', true]],
    'each result says whether the check applies to this setup');
  assert.equal(evidence.readLiveCheck('mcp', {}), null, 'a check that does not apply is not remembered');
  assert.equal(evidence.readLiveCheck('security', {}).status, 'failed');
  await assert.rejects(live.runLiveChecks({ cfg: loadKitConfig(), cwd: PROJECT, only: ['nope'] }), TypeError);
});

test('an entry\'s own timeout bounds it when the caller sets none', async () => {
  const checks = [{ id: 'memory', timeoutMs: 50, run: () => new Promise(() => {}) }];
  const [r] = await live.runLiveChecks({ cfg: offlineKitConfig(), cwd: PROJECT, checks, graceMs: 10 });
  assert.equal(r.status, 'inconclusive');
  assert.equal(r.reason, 'no result within 50 ms');
});

// ── ak status --refresh=live [--only] ───────────────────────────────────────
// The refresh stages run over fakes (a real Maintenance service writes
// <state>/agentic-kit/maintenance/); the live checks are a spy and the local
// re-check returns healthy rows, so the exit code is the live checks' alone.

const HEALTHY = [{ subsystem: 'versions', level: 'ok', message: 'fake', fix: null, repair: null }];
const SECURITY_FAILED = {
  id: 'security', status: 'failed', reason: '@claude-flow/security missing', elapsedMs: 3_000,
  entries: [
    { level: 'heading', text: 'security — packages load, defend flags injection / passes clean' },
    { level: 'fail', text: '@claude-flow/security missing' },
    { level: 'ok', text: '@claude-flow/aidefence present' },
  ],
};

async function runStatus(flags, results, overrides = {}) {
  seedHome();
  const calls = [];
  const deps = {
    collector: { refreshDeep: async () => ({ ok: true, persisted: { ok: true } }) },
    maintenance: { scan: async () => ({ scan: {} }) },
    management: { refreshInventory: async () => ({}), rebuildAfterMeasurement: async () => ({}) },
    runLive: async (options) => { calls.push(options); return results; },
    collect: async () => HEALTHY.map((r) => ({ ...r })),
    ...overrides,
  };
  const refreshStages = cliRefreshStages({ cwd: PROJECT, pkgRoot: PKG_ROOT, deps });
  const { result, out } = await captureLog(() => status.run({ flags, pkgRoot: PKG_ROOT, deps: { refreshStages } }));
  return { code: result, out, calls };
}

test('--only decides the exit code: 1 when a named check fails, 0 when it passes', async () => {
  const failed = await runStatus({ refresh: 'live', only: ['security'] }, [SECURITY_FAILED]);
  assert.equal(failed.code, 1, failed.out);
  assert.deepEqual(failed.calls[0].only, ['security'], 'the live checks get the names');
  const passed = await runStatus({ refresh: 'live', only: ['security'] },
    [{ id: 'security', status: 'passed', reason: null, elapsedMs: 3_000, entries: [] }]);
  assert.equal(passed.code, 0, passed.out);
  const inconclusive = await runStatus({ refresh: 'live', only: ['security'] },
    [{ id: 'security', status: 'inconclusive', reason: 'no result within 60 s', elapsedMs: 60_000, entries: [] }]);
  assert.equal(inconclusive.code, 1, 'an inconclusive named check is not a pass');
});

test('without --only a failed live check is a warning and leaves the exit code at 0', async () => {
  const { code, out } = await runStatus({ refresh: 'live' }, [SECURITY_FAILED]);
  assert.equal(code, 0, out);
});

const SECURITY_PASSED = { id: 'security', status: 'passed', reason: null, elapsedMs: 3_000, entries: [] };
const FAILING_ROW = { subsystem: 'natives', level: 'fail', message: 'native runtime missing', fix: null, repair: null };

test('with --only a failing row still prints and reaches --json, but only the named checks set the exit code', async () => {
  const collect = async () => [...HEALTHY, FAILING_ROW].map((r) => ({ ...r }));
  const human = await runStatus({ refresh: 'live', only: ['security'] }, [SECURITY_PASSED], { collect });
  assert.equal(human.code, 0, human.out);
  assert.match(human.out, /native runtime missing/, 'the failing row is still shown');
  const json = await runStatus({ refresh: 'live', only: ['security'], json: true }, [SECURITY_PASSED], { collect });
  assert.equal(json.code, 0);
  assert.equal(JSON.parse(json.out).overall, 'fail');
  const unnamed = await runStatus({ refresh: 'live' }, [SECURITY_PASSED], { collect });
  assert.equal(unnamed.code, 1, 'without --only a failing row sets the exit code, as always');
});

test('with --only a failed refresh stage still shows in --json, but only the named checks set the exit code', async () => {
  const maintenance = { scan: async () => { throw new Error('provider scan exploded'); } };
  const { code, out } = await runStatus({ refresh: 'live', only: ['security'], json: true }, [SECURITY_PASSED], { maintenance });
  assert.equal(code, 0, out);
  const { refresh } = JSON.parse(out);
  assert.equal(refresh.ok, false);
  const stage = refresh.stages.find((s) => s.id === 'maintenance');
  assert.deepEqual([stage.state, stage.detail], ['failed', 'provider scan exploded']);
  const unnamed = await runStatus({ refresh: 'live', json: true }, [SECURITY_PASSED], { maintenance });
  assert.equal(unnamed.code, 1, 'without --only a failed stage sets the exit code, as always');
});

test('with --only a named check that never ran is not a pass: exit 1', async () => {
  const runLive = async () => { throw new Error('the live checks could not start'); };
  const human = await runStatus({ refresh: 'live', only: ['security'] }, [], { runLive });
  assert.equal(human.code, 1, human.out);
  assert.match(human.out, /Running live checks failed \(\d+ ms\): the live checks could not start/);
  const json = await runStatus({ refresh: 'live', only: ['security'], json: true }, [], { runLive });
  assert.equal(json.code, 1);
  assert.equal(JSON.parse(json.out).refresh.stages.find((s) => s.id === 'live').state, 'failed');
});

test('a named check that does not apply says on its line that its result is not remembered', async () => {
  const { out } = await runStatus({ refresh: 'live', only: ['mcp', 'security'] }, [
    { id: 'mcp', status: 'failed', reason: 'effective Codex MCP inventory unavailable', elapsedMs: 20, entries: [], applies: false },
    { id: 'security', status: 'passed', reason: null, elapsedMs: 30, entries: [], applies: true },
  ]);
  assert.match(out, /^⚠ {2}mcp failed \(20 ms\) — effective Codex MCP inventory unavailable; not remembered: this check does not apply to your setup$/m);
  assert.match(out, /^✓ security passed \(30 ms\)$/m, 'a check that applies says nothing more');
  const skipped = await runStatus({ refresh: 'live', only: ['deja-vu'] }, [
    { id: 'deja-vu', status: 'skipped', reason: 'disabled and unowned', elapsedMs: 2, entries: [], applies: false },
  ]);
  assert.equal(skipped.code, 1, 'a named skipped proof did not pass');
  assert.match(skipped.out, /Running live checks \(\d+ ms\): 1 skipped/);
  assert.match(skipped.out, /^⚠ {2}deja-vu skipped \(2 ms\) — disabled and unowned; not remembered: this check does not apply to your setup$/m);
});

test('one line per check; with --only each check\'s own lines are indented under it', async () => {
  const plain = await runStatus({ refresh: 'live' }, [SECURITY_FAILED,
    { id: 'memory', status: 'passed', reason: null, elapsedMs: 40, entries: [{ level: 'ok', text: 'round trip' }] }]);
  assert.match(plain.out, /^✓ Running live checks \(\d+ ms\): 1 failed, 1 passed\n⚠ {2}security failed \(3 s\) — @claude-flow\/security missing\n✓ memory passed \(40 ms\)$/m);
  assert.doesNotMatch(plain.out, /^ {4}/m, 'without --only the checks\' own lines stay out of the way');

  const named = await runStatus({ refresh: 'live', only: ['security'] }, [SECURITY_FAILED]);
  assert.match(named.out,
    /^⚠ {2}security failed \(3 s\) — @claude-flow\/security missing\n {4}✗ @claude-flow\/security missing\n {4}✓ @claude-flow\/aidefence present$/m);
});

test('--json carries the live results and prints only JSON', async () => {
  const { code, out } = await runStatus({ refresh: 'live', only: ['security'], json: true }, [SECURITY_FAILED]);
  const parsed = JSON.parse(out);
  assert.deepEqual(parsed.live, [SECURITY_FAILED]);
  assert.equal(parsed.refresh.ok, true);
  assert.equal(code, 1);
});

test('ak status refuses --only without --refresh=live, and an unknown name, as usage errors', async () => {
  for (const flags of [{ refresh: '', only: ['security'] }, { refresh: 'live', only: ['bogus'] }]) {
    const { code, out, calls } = await runStatus(flags, []);
    assert.equal(code, 2, out);
    assert.equal(calls.length, 0, 'a usage error runs nothing');
  }
});

// ── each check when its subject is absent ───────────────────────────────────

test('the security check FAILS when the security packages are absent', async () => {
  seedHome();
  const [r] = await runOnly(['security']);
  assert.equal(r.status, 'failed', 'a missing security surface must fail the proof, not warn past it');
  assert.equal(r.reason, '@claude-flow/security missing');
});

test('the security check calls out the aidefence gap by name and stops early', async () => {
  seedHome();
  const secDir = path.join(paths.rufloNodeModules(), '@claude-flow', 'security');
  fs.mkdirSync(secDir, { recursive: true });
  fs.writeFileSync(path.join(secDir, 'package.json'), '{"name":"@claude-flow/security"}');
  try {
    const [r] = await runOnly(['security']);
    assert.equal(r.status, 'failed');
    assert.match(texts(r), /@claude-flow\/security present/);
    assert.match(r.reason, /aidefence missing — defend is silently non-functional \(ruvnet\/ruflo#2670\)/);
    assert.ok(!/defend: flags injection/.test(texts(r)),
      'with aidefence missing the defend exercise is meaningless and must be skipped');
  } finally { rmrf(secDir); }
});

// Ruflo 3.32.2+ ships a built-in defend engine (ruvnet/ruflo#2670), and in
// 3.46.1 text-mode defend still crashes after it detects a threat
// (ruvnet/ruflo#3473). The check reads the `-o json` verdict, so a detection is
// reported from the verdict and a crash as a crash, never a pass.
const DEFEND_FIXTURES = new URL('../fixtures/ruflo-defend/', import.meta.url);
const fixture = (name) => fs.readFileSync(new URL(name, DEFEND_FIXTURES), 'utf8');

test('parseDefendVerdict reads the recorded 3.46.1 JSON verdicts and rejects the text-mode crash', () => {
  assert.deepEqual(live.parseDefendVerdict(fixture('threat.json.txt')), { safe: false, threats: 2 });
  assert.deepEqual(live.parseDefendVerdict(fixture('clean.json.txt')), { safe: true, threats: 0 });
  assert.equal(live.parseDefendVerdict(fixture('threat-crash.txt')), null);
  assert.equal(live.parseDefendVerdict(''), null);
  assert.equal(live.parseDefendVerdict('{"safe": "no"}'), null, 'a non-boolean safe is not a verdict');
});

function securityTree({ aidefence = false, builtin = true } = {}) {
  const cf = path.join(paths.rufloNodeModules(), '@claude-flow');
  const made = [];
  const pkg = (name) => {
    fs.mkdirSync(path.join(cf, name), { recursive: true });
    fs.writeFileSync(path.join(cf, name, 'package.json'), JSON.stringify({ name: `@claude-flow/${name}` }));
    made.push(path.join(cf, name));
  };
  pkg('security');
  if (aidefence) pkg('aidefence');
  if (builtin) {
    const dir = path.join(cf, 'cli', 'dist', 'src', 'security');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'builtin-aidefence.js'), 'export {};\n');
    made.push(path.join(cf, 'cli'));
  }
  return () => made.forEach((dir) => rmrf(dir));
}

/** A runner that answers `security defend` from fixtures, by input. */
function defendRunner({ threat, clean }) {
  const calls = [];
  const runner = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (args[0] === 'security' && args[1] === 'defend') {
      const input = args[args.indexOf('-i') + 1];
      return /Ignore all previous/.test(input) ? threat : clean;
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  return { runner, calls };
}

test('verifySecurity reports a detection from the JSON verdict when only the built-in engine is present', async () => {
  seedHome();
  const cleanup = securityTree({ aidefence: false, builtin: true });
  try {
    const { runner, calls } = defendRunner({
      threat: { code: 1, stdout: fixture('threat.json.txt'), stderr: '' },
      clean: { code: 0, stdout: fixture('clean.json.txt'), stderr: '' },
    });
    const { result, out } = await captureLog(() => live.verifySecurity({ runner }));
    assert.equal(result, true, out);
    assert.match(out, /defend: flags injection \(2 threats\), passes clean/);
    assert.match(out, /aidefence missing: defend uses Ruflo's built-in engine/);
    const defends = calls.filter((c) => c[2] === 'defend');
    assert.equal(defends.length, 2, 'aidefence absent no longer returns early');
    for (const c of defends) assert.deepEqual(c.slice(-2), ['-o', 'json']);
  } finally { cleanup(); }
});

test('verifySecurity reports the post-detection crash (ruvnet/ruflo#3473) as a crash and fails', async () => {
  seedHome();
  const cleanup = securityTree({ aidefence: true, builtin: true });
  try {
    const { runner } = defendRunner({
      threat: { code: 1, stdout: fixture('threat-crash.txt'), stderr: '' },
      clean: { code: 0, stdout: fixture('clean.json.txt'), stderr: '' },
    });
    const { result, out } = await captureLog(() => live.verifySecurity({ runner }));
    assert.equal(result, false);
    assert.match(out, /defend crashed before reporting a verdict \(ruvnet\/ruflo#3473\)/);
    assert.doesNotMatch(out, /defend: flags injection/);
  } finally { cleanup(); }
});

test('verifySecurity fails when the clean input is flagged', async () => {
  seedHome();
  const cleanup = securityTree({ aidefence: true, builtin: true });
  try {
    const { runner } = defendRunner({
      threat: { code: 1, stdout: fixture('threat.json.txt'), stderr: '' },
      clean: { code: 1, stdout: fixture('threat.json.txt'), stderr: '' },
    });
    const { result, out } = await captureLog(() => live.verifySecurity({ runner }));
    assert.equal(result, false);
    assert.match(out, /defend ambiguous/);
  } finally { cleanup(); }
});

// The secrets scan must find the project, not whatever folder `ak status`
// happens to run in: it always scans the repository root, passed as `cwd`
// (never as a path argument, so no Windows path passes through `.cmd` shim
// quoting), and prints which folder it scanned.
const DEFEND_PASSES_CLEANLY = {
  threat: { code: 1, stdout: fixture('threat.json.txt'), stderr: '' },
  clean: { code: 0, stdout: fixture('clean.json.txt'), stderr: '' },
};

/** Like defendRunner, but also answers `security secrets` and records every
 *  call's opts so the secrets scan's cwd and args can be asserted. */
function securityRunner({ threat, clean, secrets = { code: 0, stdout: '', stderr: '' } }) {
  const calls = [];
  const runner = async (cmd, args, opts = {}) => {
    calls.push({ cmd, args, opts });
    if (args[0] === 'security' && args[1] === 'defend') {
      const input = args[args.indexOf('-i') + 1];
      return /Ignore all previous/.test(input) ? threat : clean;
    }
    if (args[0] === 'security' && args[1] === 'secrets') return secrets;
    return { code: 0, stdout: '', stderr: '' };
  };
  return { runner, calls };
}

test('verifySecurity scans the repository root from a subfolder, and says which folder', async () => {
  seedHome();
  const cleanup = securityTree({ aidefence: true, builtin: true });
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ak-live-checks-secrets-')));
  fs.mkdirSync(path.join(root, '.git'));
  const sub = path.join(root, 'sub');
  fs.mkdirSync(sub);
  try {
    const { runner, calls } = securityRunner(DEFEND_PASSES_CLEANLY);
    const { result, out } = await captureLog(() => live.verifySecurity({ runner, cwd: sub }));
    assert.equal(result, true, out);
    const secretsCall = calls.find((c) => c.args[0] === 'security' && c.args[1] === 'secrets');
    assert.ok(secretsCall, 'the secrets scan runs from a subfolder too');
    assert.equal(secretsCall.opts.cwd, root, 'the repository root travels as cwd, not as an argument');
    assert.deepEqual(secretsCall.args, ['security', 'secrets', '--path', '.']);
    assert.equal(secretsCall.opts.timeout, 120_000);
    assert.ok(out.includes(`secrets scan of ${root}: no secrets found`), out);
  } finally { cleanup(); rmrf(root); }
});

test('verifySecurity skips the secrets scan and says so outside a repository', async (t) => {
  seedHome();
  const cleanup = securityTree({ aidefence: true, builtin: true });
  const bare = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ak-live-checks-nosecrets-')));
  t.after(() => rmrf(bare));
  // With TMPDIR itself inside a Git checkout this folder would not be 'outside'
  // one; check with repoRoot itself rather than assume the layout.
  const enclosing = paths.repoRoot(bare);
  if (enclosing) { t.skip(`TMPDIR is inside the git repository ${enclosing}; this case would scan it`); cleanup(); return; }
  try {
    const { runner, calls } = securityRunner(DEFEND_PASSES_CLEANLY);
    const { result, out } = await captureLog(() => live.verifySecurity({ runner, cwd: bare }));
    assert.equal(result, true, out);
    assert.match(out, /secrets scan skipped: not inside a repository/);
    assert.ok(!calls.some((c) => c.args[0] === 'security' && c.args[1] === 'secrets'),
      'not inside a repository: the runner is never called for the secrets scan');
  } finally { cleanup(); }
});

test('a non-zero secrets exit is reported with warn but never flips the verdict', async () => {
  seedHome();
  const cleanup = securityTree({ aidefence: true, builtin: true });
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ak-live-checks-secretsfail-')));
  fs.mkdirSync(path.join(root, '.git'));
  try {
    const { runner } = securityRunner({ ...DEFEND_PASSES_CLEANLY, secrets: { code: 2, stdout: '', stderr: 'boom' } });
    const { result, out } = await captureLog(() => live.verifySecurity({ runner, cwd: root }));
    assert.equal(result, true, 'a failing secrets scan warns; it never flips the verdict, which depends only on the packages and defend');
    assert.ok(out.includes(
      `secrets scan of ${root} reported findings or could not run (exit 2) — run: ruflo security secrets --path . in ${root}`,
    ), out);
  } finally { cleanup(); rmrf(root); }
});

test('the learning proof runs only when named, fails honestly without ruflo, and records nothing', async () => {
  seedHome();
  rmrf(evidence.liveCheckDir());
  const before = snapshot(HOME);
  const [r] = await runOnly(['learning']);
  assert.equal(r.id, 'learning');
  assert.equal(r.status, 'failed');
  assert.match(r.reason, /ruflo neural train failed/);
  assert.equal(fs.existsSync(evidence.liveCheckDir()), false, 'a slow proof has no live-check evidence');
  assertUnchanged(before, HOME, 'the learning proof writes nothing into HOME');
});

// The temporary folders are asserted against a private root, never the shared
// os.tmpdir(): a proof running in another test process creates the same
// prefix there, so a diff of the shared folder could blame this proof for it.
function privateRoot(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ak-live-checks-tmproot-')));
  t.after(() => rmrf(root));
  return root;
}

test('the learning proof leaves no temp directory behind', async (t) => {
  const tmpRoot = privateRoot(t);
  const cwds = [];
  const runner = async (cmd, args, opts) => { cwds.push(opts.cwd); return { code: 1, stdout: '', stderr: 'boom' }; };
  const { result } = await captureLog(() => live.verifyLearning({ tmpRoot, runner }));
  assert.equal(result, false);
  assert.equal(cwds.length, 1);
  assert.equal(path.dirname(cwds[0]), tmpRoot, 'the proof trained inside the given root');
  assert.deepEqual(fs.readdirSync(tmpRoot), [], 'the isolated training dir must be cleaned up even on failure');
});

test('the memory check fails honestly when ruflo cannot be run', async () => {
  seedHome();
  const [r] = await runOnly(['memory']);
  assert.equal(r.status, 'failed');
  assert.equal(r.reason, 'ruflo CLI not installed — cannot prove project memory');
});

test('the memory check leaves no temp directory behind', async (t) => {
  const tmpRoot = privateRoot(t);
  const cwds = [];
  const runner = async (cmd, args, opts) => { cwds.push(opts.cwd); return { code: 1, stdout: '', stderr: '' }; };
  const { result, out } = await captureLog(() => live.verifyMemory({ tmpRoot, runner, haveCmd: async () => true }));
  assert.equal(result, false);
  assert.match(out, /ruflo memory init failed/);
  assert.ok(cwds.length >= 1 && cwds.every((cwd) => path.dirname(cwd) === tmpRoot), JSON.stringify(cwds));
  assert.deepEqual(fs.readdirSync(tmpRoot), [], 'the isolated memory proof dir must be cleaned up even on failure');
});

test('the aqe proof fails on an oversized RVF store rather than probing further', async () => {
  seedHome();
  const aqeDir = paths.projectAqeDir(PROJECT);
  fs.mkdirSync(aqeDir, { recursive: true });
  fs.writeFileSync(path.join(aqeDir, 'brain.rvf'), 'x'.repeat(4096));
  const prev = process.env.RUFLO_AQE_RVF_MAX_BYTES;
  process.env.RUFLO_AQE_RVF_MAX_BYTES = '16';
  try {
    const [r] = await runOnly(['aqe']);
    assert.equal(r.status, 'failed');
    assert.equal(r.reason, '1 oversized RVF store(s) — run: ak sync');
    assert.ok(fs.existsSync(path.join(aqeDir, 'brain.rvf')), 'the proof is read-only — it never quarantines');
  } finally {
    if (prev === undefined) delete process.env.RUFLO_AQE_RVF_MAX_BYTES;
    else process.env.RUFLO_AQE_RVF_MAX_BYTES = prev;
    rmrf(aqeDir);
  }
});

test('the providers check fails when kit.json enables a host that is not installed', async () => {
  seedHome(offlineKitConfig({ providers: { hosts: { claude: true, codex: true } } }));
  const [r] = await runOnly(['providers']);
  assert.equal(r.status, 'failed');
  assert.match(texts(r), /host 'codex' enabled in kit\.json but not on PATH/);
});

test('the providers check fails on aqe fallback-chain drift between kit.json and disk', async () => {
  seedHome(offlineKitConfig({
    providers: {
      hosts: { claude: false, codex: false },
      aqeFallback: [{ provider: 'claude-code', models: ['claude-opus-5'] }],
    },
  }));
  const [r] = await runOnly(['providers']);
  assert.equal(r.status, 'failed');
  assert.match(texts(r), /aqe fallback chain drift/);
});

test('the harvest proof fails (never skips to a pass) when the ruflo CLI is absent', async () => {
  seedHome();
  const [r] = await runOnly(['harvest']);
  assert.equal(r.status, 'failed', 'harvest drives only Ruflo verbs, so no ruflo means no proof');
  assert.equal(r.reason, 'ruflo CLI not installed — cannot prove the harvest write path');
  assert.doesNotMatch(texts(r), /agentdb/, 'the retired standalone CLI is never probed');
});

test('every check and slow proof, named together, runs; one failure is reported per check', async () => {
  seedHome();
  const all = [...live.LIVE_CHECK_IDS, ...live.SLOW_PROOF_IDS];
  const results = await runOnly(all);
  assert.deepEqual(results.map((r) => r.id), all);
  for (const id of ['security', 'memory', 'learning', 'harvest', 'memory-routes']) {
    assert.equal(results.find((r) => r.id === id).status, 'failed', `${id} cannot pass with nothing installed`);
  }
});

test('the live checks write nothing into HOME except the results they remember for status', async () => {
  seedHome();
  rmrf(paths.evidenceDir());
  const before = snapshot(HOME);
  await runOnly([...live.LIVE_CHECK_IDS, ...live.SLOW_PROOF_IDS]);
  // The providers check reaches collectIntegrationFacts() (providers.mjs), which
  // caches its host-presence probe beside the live-check store, under the same
  // evidence directory — so the allowlist is the whole evidence store.
  const stateRel = path.relative(HOME, paths.evidenceDir());
  const liveCheckRel = path.relative(HOME, evidence.liveCheckDir());
  const after = snapshot(HOME);
  const changed = [...after.keys()].filter((k) => before.get(k) !== after.get(k));
  const outside = changed.filter((k) => !k.startsWith(stateRel) && !stateRel.startsWith(k.replace(/\/$/, '')));
  assert.deepEqual(outside, [], 'the checks prove things; their only write is the evidence cache (live-check + host detection)');
  assert.ok(changed.some((k) => k.startsWith(`${liveCheckRel}${path.sep}security.json`)),
    'the failed security check must be remembered for ak status');
});

// ── what is remembered ──────────────────────────────────────────────────────

test('a failed check is remembered for status with its first failure as the reason', async () => {
  seedHome();
  rmrf(evidence.liveCheckDir());
  await runOnly(['security']);
  const got = evidence.readLiveCheck('security', {});
  assert.equal(got.status, 'failed');
  assert.equal(got.source, 'status-refresh-live');
  assert.equal(got.reason, '@claude-flow/security missing');
});

test('the memory-routes proof is remembered separately; learning and harvest are not remembered', async () => {
  seedHome();
  rmrf(evidence.liveCheckDir());
  await runOnly(['memory-routes', 'learning', 'harvest']);
  const got = evidence.readLiveCheck('memory-routes', {});
  assert.equal(got.status, 'failed');
  assert.equal(got.source, 'status-refresh-live');
  assert.equal(evidence.readLiveCheck('memory', {}).status, 'failed');
  assert.deepEqual(fs.readdirSync(evidence.liveCheckDir()), ['memory-routes.json', 'memory.json']);
});

test('a failed or timed-out routing run replaces a previous pass; a later generic memory pass cannot revive it', async () => {
  seedHome();
  rmrf(evidence.liveCheckDir());
  const cfg = offlineKitConfig();
  const route = (run, timeoutMs = 50) => ({ id: 'memory-routes', evidenceId: 'memory-routes',
    timeoutMs, applies: () => true, run });
  const generic = { id: 'memory', evidenceId: 'memory', timeoutMs: 50, applies: () => true,
    run: async () => true };
  await live.runLiveChecks({ cfg, cwd: PROJECT, checks: [route(async () => ({ status: 'passed' }))] });
  assert.equal(evidence.readLiveCheck('memory-routes').status, 'passed');
  await live.runLiveChecks({ cfg, cwd: PROJECT, checks: [route(async () => false)] });
  assert.equal(evidence.readLiveCheck('memory-routes').status, 'failed');
  await live.runLiveChecks({ cfg, cwd: PROJECT, checks: [route(() => new Promise(() => {}), 10)], graceMs: 1 });
  assert.equal(evidence.readLiveCheck('memory-routes').status, 'inconclusive');
  await live.runLiveChecks({ cfg, cwd: PROJECT, checks: [generic] });
  assert.equal(evidence.readLiveCheck('memory').status, 'passed');
  assert.equal(evidence.readLiveCheck('memory-routes').status, 'inconclusive');
});

test('a route timeout after the CLI proof keeps the generic memory pass', async () => {
  seedHome();
  rmrf(evidence.liveCheckDir());
  const check = { id: 'memory-routes', evidenceId: 'memory-routes', timeoutMs: 10, applies: () => true,
    run: ({ onCliOutcome }) => {
      onCliOutcome({ status: 'passed', reason: null });
      return new Promise(() => {});
    } };
  const [result] = await live.runLiveChecks({ cfg: offlineKitConfig(), cwd: PROJECT, checks: [check], graceMs: 1 });
  assert.equal(result.status, 'inconclusive');
  assert.equal(evidence.readLiveCheck('memory').status, 'passed');
  assert.equal(evidence.readLiveCheck('memory-routes').status, 'inconclusive');
});

test('a CLI upgrade during the route check cannot attribute the old observation to the new version', async (t) => {
  seedHome();
  rmrf(evidence.liveCheckDir());
  const root = fs.mkdtempSync(path.join(HOME, 'routing-upgrade-'));
  const cli = path.join(root, 'ruflo', 'node_modules', '@claude-flow', 'cli');
  fs.mkdirSync(cli, { recursive: true });
  const setVersion = (version) => fs.writeFileSync(path.join(cli, 'package.json'), JSON.stringify({ version }));
  t.after(() => { paths._setGlobalRootForTest(GLOBAL_ROOT); rmrf(root); });
  paths._setGlobalRootForTest(root);
  setVersion('3.45.0');
  const oldKey = evidence.liveCheckInputsKey('memory-routes');
  const check = { id: 'memory-routes', evidenceId: 'memory-routes', timeoutMs: 50, applies: () => true,
    run: async ({ onCliOutcome }) => {
      onCliOutcome({ status: 'passed', reason: null });
      setVersion('3.45.1');
      return { status: 'passed', reason: null };
    } };
  const [result] = await live.runLiveChecks({ cfg: offlineKitConfig(), cwd: PROJECT, checks: [check] });
  const currentKey = evidence.liveCheckInputsKey('memory-routes');
  assert.notEqual(currentKey, oldKey);
  assert.equal(result.status, 'inconclusive');
  assert.equal(evidence.readLiveCheck('memory-routes', { inputsKey: oldKey }).status, 'inconclusive');
  assert.equal(evidence.readLiveCheck('memory-routes', { inputsKey: oldKey }).invalidated, false);
  assert.equal(evidence.readLiveCheck('memory-routes', { inputsKey: currentKey }).invalidated, true);
  assert.equal(evidence.readLiveCheck('memory').status, 'passed');

  const project = sandboxProject('ak-route-upgrade-row');
  t.after(() => rmrf(project));
  const swarm = path.join(project, '.swarm');
  fs.mkdirSync(swarm);
  for (const name of ['memory.db', 'agentdb-memory.db']) {
    const db = new DatabaseSync(path.join(swarm, name));
    db.exec('CREATE TABLE memory_entries (status TEXT); INSERT INTO memory_entries VALUES (NULL)');
    db.close();
  }
  const row = async (version) => (await projectMemorySection.collect({ cwd: project,
    rufloVersion: version })).find((item) => /two project memory stores/.test(item.message));
  assert.equal((await row('3.45.0')).level, 'warn');
  assert.equal((await row('3.45.1')).level, 'warn');
});

test('a skipped deja-vu proof is not remembered as a pass', async () => {
  seedHome();
  rmrf(evidence.liveCheckDir());
  const [r] = await runOnly(['deja-vu']);
  assert.equal(r.status, 'skipped');
  assert.equal(r.reason, 'disabled and unowned');
  assert.match(texts(r), /deja-vu disabled and unowned — skipped/);
  assert.equal(evidence.readLiveCheck('deja-vu', {}), null);
});

test('a skipped applicable check never writes conformance evidence', async () => {
  seedHome();
  rmrf(evidence.liveCheckDir());
  const [result] = await live.runLiveChecks({ cfg: offlineKitConfig(), cwd: PROJECT,
    checks: [{ id: 'deja-vu', evidenceId: 'deja-vu', applies: () => true,
      run: async () => ({ status: 'skipped', reason: 'not installed' }) }] });
  assert.equal(result.status, 'skipped');
  assert.equal(evidence.readLiveCheck('deja-vu', {}), null);
});

test('learning removes only its call-owned folder after success, missing artifacts, thrown runner, and abort', async (t) => {
  const tmpRoot = privateRoot(t);
  const unrelated = path.join(tmpRoot, 'unrelated');
  fs.mkdirSync(unrelated);
  const cases = [
    async (_cmd, _args, { cwd }) => {
      const neural = path.join(cwd, '.claude-flow', 'neural');
      fs.mkdirSync(neural, { recursive: true });
      fs.writeFileSync(path.join(neural, 'stats.json'), '{"patternsLearned":1}');
      fs.writeFileSync(path.join(neural, 'patterns.json'), '[{"id":"one"}]');
      return { code: 0, stdout: '', stderr: '' };
    },
    async () => ({ code: 0, stdout: '', stderr: '' }),
    async () => { throw new Error('runner failed'); },
    async () => { throw new DOMException('aborted', 'AbortError'); },
  ];
  for (const [i, runner] of cases.entries()) {
    const { result } = await captureLog(() => live.verifyLearning({ tmpRoot, runner }));
    assert.equal(result, i === 0, `case ${i}`);
    assert.deepEqual(fs.readdirSync(tmpRoot), ['unrelated'], `case ${i} left a call-owned folder`);
  }
});

test('memory removes its call-owned folder even when final purge throws', async (t) => {
  const tmpRoot = privateRoot(t);
  fs.mkdirSync(path.join(tmpRoot, 'unrelated'));
  const runner = async (_cmd, args) => {
    if (args[1] === 'init') return { code: 0, stdout: '', stderr: '' };
    if (args[1] === 'store') return { code: 1, stdout: '', stderr: 'store failed' };
    throw new Error('purge failed');
  };
  await assert.rejects(captureLog(() => live.verifyMemory({ tmpRoot, runner, haveCmd: async () => true })), /purge failed/);
  assert.deepEqual(fs.readdirSync(tmpRoot), ['unrelated']);
});

test('memory removes only its call-owned folder when init throws or is aborted', async (t) => {
  const tmpRoot = privateRoot(t);
  fs.mkdirSync(path.join(tmpRoot, 'unrelated'));
  for (const error of [new Error('runner failed'), new DOMException('aborted', 'AbortError')]) {
    const { result } = await captureLog(() => live.verifyMemory({ tmpRoot,
      runner: async () => { throw error; }, haveCmd: async () => true }));
    assert.equal(result, false);
    assert.deepEqual(fs.readdirSync(tmpRoot), ['unrelated']);
  }
});

test('memory removes its call-owned folder after a successful mocked CLI round trip', async (t) => {
  const tmpRoot = privateRoot(t);
  fs.mkdirSync(path.join(tmpRoot, 'unrelated'));
  let db;
  let storedValue;
  const runner = async (_cmd, args, { cwd }) => {
    if (args[1] === 'init') {
      fs.mkdirSync(path.join(cwd, '.swarm'));
      db = new DatabaseSync(path.join(cwd, '.swarm', 'memory.db'));
      db.exec('CREATE TABLE memory_entries (namespace TEXT, key TEXT)');
    } else if (args[1] === 'store') {
      db.prepare('INSERT INTO memory_entries VALUES (?, ?)').run(args[args.indexOf('-n') + 1], args[args.indexOf('-k') + 1]);
      storedValue = args[args.indexOf('--value') + 1];
    } else if (args[1] === 'retrieve') {
      return { code: 0, stdout: storedValue, stderr: '' };
    } else if (args[1] === 'purge') {
      db.exec('DELETE FROM memory_entries');
      db.close();
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  const { result } = await captureLog(() => live.verifyMemory({
    tmpRoot, runner, haveCmd: async () => true, observeRoutes: false,
  }));
  assert.equal(result, true);
  assert.deepEqual(fs.readdirSync(tmpRoot), ['unrelated']);
});

test('harvest removes only its call-owned folder on success, nonzero result, thrown runner, and abort', async (t) => {
  const tmpRoot = privateRoot(t);
  fs.mkdirSync(path.join(tmpRoot, 'unrelated'));
  for (const mode of ['success', 'nonzero', 'throw', 'abort']) {
    const dirs = [];
    const runner = async (_cmd, _args, { cwd }) => {
      dirs.push(cwd);
      if (mode === 'throw') throw new Error('runner failed');
      if (mode === 'abort') throw new DOMException('aborted', 'AbortError');
      return { code: mode === 'nonzero' ? 1 : 0, stdout: '', stderr: '' };
    };
    const { result } = await captureLog(() => live.verifyHarvest({ tmpRoot, runner, haveCmd: async () => true }));
    assert.equal(result, mode === 'success', mode);
    assert.ok(dirs.length >= 1 && dirs.every((dir) => path.dirname(dir) === tmpRoot), mode);
    assert.deepEqual(fs.readdirSync(tmpRoot), ['unrelated'], mode);
  }
});

test('an aqe proof stopped before the embedding request remembers no embedding result', async () => {
  seedHome();
  rmrf(evidence.liveCheckDir());
  const aqeDir = paths.projectAqeDir(PROJECT);
  fs.mkdirSync(aqeDir, { recursive: true });
  fs.writeFileSync(path.join(aqeDir, 'brain.rvf'), 'x'.repeat(4096));
  const prev = process.env.RUFLO_AQE_RVF_MAX_BYTES;
  process.env.RUFLO_AQE_RVF_MAX_BYTES = '16';
  try {
    assert.equal((await runOnly(['aqe']))[0].status, 'failed');
    assert.equal(evidence.readLiveCheck('aqe-embedding', {}), null);
  } finally {
    if (prev === undefined) delete process.env.RUFLO_AQE_RVF_MAX_BYTES;
    else process.env.RUFLO_AQE_RVF_MAX_BYTES = prev;
    rmrf(aqeDir);
  }
});

// A backend the kit manages (endpoint or in-process); the unreachable port keeps the
// request from touching any real embedder.
const MANAGED_EMBEDDING = { mode: 'endpoint', endpoint: 'http://127.0.0.1:9', provisioning: 'external' };

test('the aqe proof remembers its live embedding request, keyed like status reads it', async () => {
  seedHome(offlineKitConfig({ aqeEmbedding: MANAGED_EMBEDDING }));
  rmrf(evidence.liveCheckDir());
  const [r] = await runOnly(['aqe']);
  assert.match(texts(r), /live embedding request: /);
  const cfg = JSON.parse(fs.readFileSync(paths.kitConfigPath(), 'utf8'));
  const got = evidence.readLiveCheck('aqe-embedding', {
    inputsKey: evidence.liveCheckInputsKey('aqe-embedding', { cfg, cwd: PROJECT }) });
  assert.equal(got.source, 'status-refresh-live');
  assert.equal(got.status, 'failed', 'no AQE runtime in the sandbox: the request cannot pass');
  assert.equal(got.invalidated, false);
  assert.deepEqual(fs.readdirSync(evidence.liveCheckDir()), ['aqe-embedding.json'], 'the aqe proof itself has no evidence id');
});

// An unmanaged backend is probed and printed, but its failure is not the kit's
// evidence: status would otherwise show a failure for a backend it does not own.
for (const [label, extra] of [
  ['an unmanaged AQE backend', { aqeEmbedding: { mode: 'unmanaged' } }],
  ['no AQE embedding choice', {}],
  ['AQE turned off', { aqe: false, aqeEmbedding: MANAGED_EMBEDDING }],
]) {
  test(`the aqe proof and the named embedding check print but do not remember the request for ${label}`, async () => {
    // A developer shell may export AQE_EMBEDDER_* (the result then reads
    // "unavailable" instead of "not-configured"); the test owns its environment.
    const saved = Object.fromEntries(Object.keys(process.env).filter((key) => key.startsWith('AQE_EMBEDDER_')).map((key) => [key, process.env[key]]));
    for (const key of Object.keys(saved)) delete process.env[key];
    try {
      seedHome(offlineKitConfig(extra));
      rmrf(evidence.liveCheckDir());
      const [proof, request] = await runOnly(['aqe', 'aqe-embedding']);
      assert.ok(proof.entries.some((e) => e.level === 'fail' && /^live embedding request: (unavailable|not-configured)/.test(e.text)),
        'the failed request is still printed');
      assert.equal(request.status, 'failed', 'a named check runs even when the kit does not manage the backend');
      assert.equal(evidence.readLiveCheck('aqe-embedding', {}), null);
    } finally {
      Object.assign(process.env, saved);
    }
  });
}

test('aqeEmbeddingManaged: only an endpoint or in-process choice with AQE on', () => {
  assert.equal(live.aqeEmbeddingManaged({ aqeEmbedding: MANAGED_EMBEDDING }), true);
  assert.equal(live.aqeEmbeddingManaged({ aqeEmbedding: { mode: 'in-process' } }), true);
  assert.equal(live.aqeEmbeddingManaged({ aqeEmbedding: { mode: 'unmanaged' } }), false);
  assert.equal(live.aqeEmbeddingManaged({}), false);
  assert.equal(live.aqeEmbeddingManaged(undefined), false);
  assert.equal(live.aqeEmbeddingManaged({ aqe: false, aqeEmbedding: MANAGED_EMBEDDING }), false);
  const inDefault = (cfg) => live.liveChecksFor(cfg).some((check) => check.id === 'aqe-embedding');
  assert.equal(inDefault({ aqeEmbedding: MANAGED_EMBEDDING }), true, 'the default set uses the same gate');
  assert.equal(inDefault({ aqeEmbedding: { mode: 'unmanaged' } }), false);
});

test('a passing live embedding request says the embedder is verified, not the pattern index', async () => {
  seedHome(offlineKitConfig({ aqeEmbedding: MANAGED_EMBEDDING }));
  const probe = async () => ({ status: 'passed', reason: null, dimension: 384 });
  const { out } = await captureLog(() => live.checkAqeEmbedding({ cwd: PROJECT, corpus: false, probe }));
  assert.match(out, /✓ embedder verified: live embedding request passed; dimension=384; AQE pattern index binding unverified \(agentic-qe#754\)/);
});

test.after(() => rmrf(HOME, PROJECT));

// Provider checks run from the project root, whatever folder `ak status` starts
// in, and every AQE call is pinned there so no subfolder store appears. `aqe
// health` runs with AQE's in-memory backend: its billing section still prints
// and the project's memory.db is not opened (agentic-qe unified-memory.js).
const recordingRunner = (calls) => async (cmd, args, opts = {}) => {
  calls.push({ cmd, args, cwd: opts.cwd, env: opts.env ?? {} });
  if (cmd === 'aqe' && args[0] === 'health') return { code: 0, stdout: 'LLM Billing:\n  Provider: claude', stderr: '' };
  return { code: 0, stdout: '', stderr: '' };
};

function projectWithSub(t, { llmConfig } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(PROJECT, 'verify-root-')));
  t.after(() => rmrf(root));
  fs.mkdirSync(path.join(root, '.git'));
  fs.mkdirSync(path.join(root, '.agentic-qe'));
  if (llmConfig) fs.writeFileSync(path.join(root, '.agentic-qe', 'llm-config.json'), JSON.stringify(llmConfig));
  const sub = path.join(root, 'sub');
  fs.mkdirSync(sub);
  return { root, sub };
}

test('verifyProviders from a subfolder reads the root\'s AQE router file and pins every call to the root', async (t) => {
  const chain = [{ provider: 'claude-code', models: ['claude-opus-5'] }];
  const { root, sub } = projectWithSub(t, { llmConfig: { _managedBy: 'agentic-kit', fallbackChain: { entries: chain } } });
  const cfg = offlineKitConfig({ integrations: { hosts: { claude: false, codex: false } }, providers: { aqeFallback: chain } });
  const calls = [];
  const { out } = await captureLog(() => live.verifyProviders({ cwd: sub, cfg, runner: recordingRunner(calls), haveCmd: async () => true }));
  assert.match(out, /aqe fallback chain on disk matches kit\.json \(claude-code\)/);
  assert.doesNotMatch(out, /drift/);
  const spawned = calls.filter((c) => c.cmd === 'aqe' || c.cmd === 'ruflo');
  assert.ok(spawned.some((c) => c.cmd === 'aqe' && c.args[0] === 'health'), JSON.stringify(calls));
  for (const c of spawned) {
    assert.equal(c.cwd, root, `${c.cmd} ${c.args.join(' ')} runs in the root`);
    assert.equal(c.env.AQE_PROJECT_ROOT, root);
    assert.equal(c.env.AQE_MEMORY_PATH, path.join(root, '.agentic-qe', 'memory.db'));
    assert.equal(c.env.AQE_STORAGE_PATH, path.join(root, '.agentic-qe'));
  }
  const health = spawned.find((c) => c.args[0] === 'health');
  assert.equal(health.env.AQE_MEMORY_BACKEND, 'memory', 'aqe health never opens the project store');
  assert.equal(fs.existsSync(path.join(sub, '.agentic-qe')), false);
});

test('verifyProviders outside a repository skips the project checks and says so', async (t) => {
  const bare = fs.realpathSync(fs.mkdtempSync(path.join(path.dirname(PROJECT), 'ak-live-checks-norepo-')));
  t.after(() => rmrf(bare));
  const cfg = offlineKitConfig({ integrations: { hosts: { claude: false, codex: false } },
    providers: { aqeFallback: [{ provider: 'claude-code', models: ['claude-opus-5'] }] } });
  const calls = [];
  const { out } = await captureLog(() => live.verifyProviders({ cwd: bare, cfg, runner: recordingRunner(calls), haveCmd: async () => true }));
  assert.match(out, /project checks skipped: not inside a repository/);
  assert.ok(!calls.some((c) => c.cmd === 'aqe'), JSON.stringify(calls));
  assert.deepEqual(fs.readdirSync(bare), []);
});

test('verifyAqe from a subfolder scans the root\'s store and reads the root\'s corpus', async (t) => {
  const { root, sub } = projectWithSub(t);
  const calls = [];
  let corpusPath;
  const probe = async (o) => { corpusPath = o.corpusPath; return { status: 'passed', dimension: 384 }; };
  await captureLog(() => live.verifyAqe({ cwd: sub, runner: recordingRunner(calls), probe, cfg: offlineKitConfig() }));
  assert.equal(corpusPath, path.join(root, '.agentic-qe', 'memory.db'));
  const status = calls.find((c) => c.cmd === 'aqe' && c.args[0] === 'status');
  assert.ok(status, JSON.stringify(calls));
  assert.equal(status.cwd, root);
  assert.equal(status.env.AQE_PROJECT_ROOT, root);
  assert.equal(fs.existsSync(path.join(sub, '.agentic-qe')), false);
});
