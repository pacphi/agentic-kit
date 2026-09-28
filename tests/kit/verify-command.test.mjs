// `ak x verify` — the deep proofs. Every suite spawns a real CLI, so these
// tests run with nothing invokable on PATH: what is pinned here is the
// dispatch contract (suite selection, exit codes) and each suite's behaviour
// when its subject is absent — which is precisely the case a user hits on a
// half-installed machine, and the one where a "proof" quietly reporting
// success would be worst.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  sandboxHome, assertSandboxed, snapshot, assertUnchanged, captureLog, rmrf,
  sandboxProject, writeKitConfig, offlineKitConfig, fakeGlobalRoot,
} from './helpers/home-sandbox.mjs';

const HOME = sandboxHome('ak-verify');
const paths = await import('../../src/lib/paths.mjs');
const verify = await import('../../src/commands/x/verify.mjs');
const evidence = await import('../../src/lib/live-check-evidence.mjs');
assertSandboxed(paths, HOME);

const PROJECT = sandboxProject('ak-verify');
paths._setGlobalRootForTest(fakeGlobalRoot(HOME, { ruflo: '9.9.9' }));

const seedHome = (cfg = offlineKitConfig()) => {
  rmrf(paths.configDir());
  writeKitConfig(HOME, cfg);
};

/** Run a suite from the sandbox project. */
async function runVerify(positionals) {
  const cwd = process.cwd();
  process.chdir(PROJECT);
  try {
    return await captureLog(() => verify.run({ positionals }));
  } finally { process.chdir(cwd); }
}

test('an unknown suite exits 2 and names the valid suites', async () => {
  seedHome();
  const { result, out } = await runVerify(['bogus']);
  assert.equal(result, 2, 'a usage error is exit 2, distinct from a failed proof (1)');
  assert.match(out, /unknown suite: bogus \(learning\|memory\|security\|aqe\|mcp\|providers\|harvest\|deja-vu\|all\)/);
  assert.ok(!/all selected proofs passed/.test(out), 'a usage error must not claim success');
});

test('a usage error runs no suite at all', async () => {
  seedHome();
  const before = snapshot(HOME);
  const { out } = await runVerify(['bogus']);
  assert.ok(!/^\n?learning|^security —|^aqe —/m.test(out), 'no suite heading printed');
  assertUnchanged(before, HOME, 'a rejected suite name must not run anything');
});

test('the security suite FAILS (exit 1) when the security packages are absent', async () => {
  seedHome();
  const { result, out } = await runVerify(['security']);
  assert.equal(result, 1, 'a missing security surface must fail the proof, not warn past it');
  assert.match(out, /@claude-flow\/security missing/);
  assert.match(out, /verification failed/);
});

test('the security suite calls out the aidefence gap by name and stops early', async () => {
  seedHome();
  const secDir = path.join(paths.rufloNodeModules(), '@claude-flow', 'security');
  fs.mkdirSync(secDir, { recursive: true });
  fs.writeFileSync(path.join(secDir, 'package.json'), '{"name":"@claude-flow/security"}');
  try {
    const { result, out } = await runVerify(['security']);
    assert.equal(result, 1);
    assert.match(out, /@claude-flow\/security present/);
    assert.match(out, /aidefence missing — defend is silently non-functional \(ruvnet\/ruflo#2670\)/);
    assert.ok(!/defend: flags injection/.test(out),
      'with aidefence missing the defend exercise is meaningless and must be skipped');
  } finally { rmrf(secDir); }
});

// Ruflo 3.32.2+ ships a built-in defend engine (ruvnet/ruflo#2670), and in
// 3.46.1 text-mode defend still crashes after it detects a threat
// (ruvnet/ruflo#3473). verify reads the `-o json` verdict, so a detection is
// reported from the verdict and a crash as a crash, never a pass.
const DEFEND_FIXTURES = new URL('../fixtures/ruflo-defend/', import.meta.url);
const fixture = (name) => fs.readFileSync(new URL(name, DEFEND_FIXTURES), 'utf8');

test('parseDefendVerdict reads the recorded 3.46.1 JSON verdicts and rejects the text-mode crash', () => {
  assert.deepEqual(verify.parseDefendVerdict(fixture('threat.json.txt')), { safe: false, threats: 2 });
  assert.deepEqual(verify.parseDefendVerdict(fixture('clean.json.txt')), { safe: true, threats: 0 });
  assert.equal(verify.parseDefendVerdict(fixture('threat-crash.txt')), null);
  assert.equal(verify.parseDefendVerdict(''), null);
  assert.equal(verify.parseDefendVerdict('{"safe": "no"}'), null, 'a non-boolean safe is not a verdict');
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
    const { result, out } = await captureLog(() => verify.verifySecurity({ runner }));
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
    const { result, out } = await captureLog(() => verify.verifySecurity({ runner }));
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
    const { result, out } = await captureLog(() => verify.verifySecurity({ runner }));
    assert.equal(result, false);
    assert.match(out, /defend ambiguous/);
  } finally { cleanup(); }
});

test('the learning suite fails honestly when ruflo cannot be run', async () => {
  seedHome();
  const { result, out } = await runVerify(['learning']);
  assert.equal(result, 1);
  assert.match(out, /ruflo neural train failed/);
});

test('the learning suite leaves no temp directory behind', async () => {
  seedHome();
  const os = await import('node:os');
  const before = new Set(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('agentic-kit-learn-')));
  await runVerify(['learning']);
  const after = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('agentic-kit-learn-'));
  assert.deepEqual(after.filter((n) => !before.has(n)), [],
    'the isolated training dir must be cleaned up even on failure');
});

test('the memory suite fails honestly when ruflo cannot be run', async () => {
  seedHome();
  const { result, out } = await runVerify(['memory']);
  assert.equal(result, 1);
  assert.match(out, /ruflo CLI not installed — cannot prove project memory/);
});

test('the memory suite leaves no temp directory behind', async () => {
  seedHome();
  const os = await import('node:os');
  const before = new Set(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('agentic-kit-memory-')));
  await runVerify(['memory']);
  const after = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('agentic-kit-memory-'));
  assert.deepEqual(after.filter((n) => !before.has(n)), [],
    'the isolated memory proof dir must be cleaned up even on failure');
});

test('the aqe suite fails on an oversized RVF store rather than probing further', async () => {
  seedHome();
  const aqeDir = paths.projectAqeDir(PROJECT);
  fs.mkdirSync(aqeDir, { recursive: true });
  fs.writeFileSync(path.join(aqeDir, 'brain.rvf'), 'x'.repeat(4096));
  const prev = process.env.RUFLO_AQE_RVF_MAX_BYTES;
  process.env.RUFLO_AQE_RVF_MAX_BYTES = '16';
  try {
    const { result, out } = await runVerify(['aqe']);
    assert.equal(result, 1);
    assert.match(out, /1 oversized RVF store\(s\) — run: ak sync/);
    assert.ok(fs.existsSync(path.join(aqeDir, 'brain.rvf')), 'verify is read-only — it never quarantines');
  } finally {
    if (prev === undefined) delete process.env.RUFLO_AQE_RVF_MAX_BYTES;
    else process.env.RUFLO_AQE_RVF_MAX_BYTES = prev;
    rmrf(aqeDir);
  }
});

test('the providers suite fails when kit.json enables a host that is not installed', async () => {
  seedHome(offlineKitConfig({ providers: { hosts: { claude: true, codex: true } } }));
  const { result, out } = await runVerify(['providers']);
  assert.equal(result, 1);
  assert.match(out, /host 'codex' enabled in kit\.json but not on PATH/);
});

test('the providers suite fails on aqe fallback-chain drift between kit.json and disk', async () => {
  seedHome(offlineKitConfig({
    providers: {
      hosts: { claude: false, codex: false },
      aqeFallback: [{ provider: 'claude-code', models: ['claude-opus-5'] }],
    },
  }));
  const { result, out } = await runVerify(['providers']);
  assert.equal(result, 1);
  assert.match(out, /aqe fallback chain drift/);
});

test('the harvest suite fails (never skips to a pass) when the ruflo CLI is absent', async () => {
  seedHome();
  const { result, out } = await runVerify(['harvest']);
  assert.equal(result, 1, 'harvest drives only Ruflo verbs, so no ruflo means no proof');
  assert.match(out, /ruflo CLI not installed — cannot prove the harvest write path/);
  assert.doesNotMatch(out, /agentdb/, 'the retired standalone CLI is never probed');
});

test('`all` runs every suite and fails if any single proof failed', async () => {
  seedHome();
  const { result, out } = await runVerify([]);
  assert.equal(result, 1);
  for (const heading of ['learning —', 'memory —', 'security —', 'aqe —', 'providers —', 'harvest —', 'deja-vu —']) {
    assert.ok(out.includes(heading), `the default run must include the ${heading} suite`);
  }
  assert.match(out, /verification failed — see above/);
});

test('verify writes nothing into HOME except the results it remembers for status', async () => {
  seedHome();
  rmrf(evidence.liveCheckDir());
  const before = snapshot(HOME);
  await runVerify([]);
  const stateRel = path.relative(HOME, evidence.liveCheckDir());
  const after = snapshot(HOME);
  const changed = [...after.keys()].filter((k) => before.get(k) !== after.get(k));
  const outside = changed.filter((k) => !k.startsWith(stateRel) && !stateRel.startsWith(k.replace(/\/$/, '')));
  assert.deepEqual(outside, [], '`ak x verify` proves things; its only write is the live-check evidence store');
  assert.ok(changed.some((k) => k.startsWith(`${stateRel}${path.sep}security.json`)),
    'the failed security proof must be remembered for ak status');
});

test('a failed proof is remembered for status with its first failure as the reason', async () => {
  seedHome();
  rmrf(evidence.liveCheckDir());
  await runVerify(['security']);
  const got = evidence.readLiveCheck('security', {});
  assert.equal(got.status, 'failed');
  assert.equal(got.source, 'verify');
  assert.equal(got.reason, '@claude-flow/security missing');
});

test('a skipped deja-vu proof is not remembered as a pass', async () => {
  seedHome();
  rmrf(evidence.liveCheckDir());
  const { result, out } = await runVerify(['deja-vu']);
  assert.equal(result, 0);
  assert.match(out, /deja-vu disabled and unowned — skipped/);
  assert.equal(evidence.readLiveCheck('deja-vu', {}), null);
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
    assert.equal((await runVerify(['aqe'])).result, 1);
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
  const { out } = await runVerify(['aqe']);
  assert.match(out, /live embedding request: /);
  const cfg = JSON.parse(fs.readFileSync(paths.kitConfigPath(), 'utf8'));
  const got = evidence.readLiveCheck('aqe-embedding', {
    inputsKey: evidence.liveCheckInputsKey('aqe-embedding', { cfg, cwd: PROJECT }) });
  assert.equal(got.source, 'verify');
  assert.equal(got.status, 'failed', 'no AQE runtime in the sandbox: the request cannot pass');
  assert.equal(got.invalidated, false);
});

// An unmanaged backend is probed and printed, but its failure is not the kit's
// evidence: status would otherwise show a failure for a backend it does not own.
for (const [label, extra] of [
  ['an unmanaged AQE backend', { aqeEmbedding: { mode: 'unmanaged' } }],
  ['no AQE embedding choice', {}],
  ['AQE turned off', { aqe: false, aqeEmbedding: MANAGED_EMBEDDING }],
]) {
  test(`the aqe proof prints but does not remember the embedding request for ${label}`, async () => {
    // A developer shell may export AQE_EMBEDDER_* (the result then reads
    // "unavailable" instead of "not-configured"); the test owns its environment.
    const saved = Object.fromEntries(Object.keys(process.env).filter((key) => key.startsWith('AQE_EMBEDDER_')).map((key) => [key, process.env[key]]));
    for (const key of Object.keys(saved)) delete process.env[key];
    try {
      seedHome(offlineKitConfig(extra));
      rmrf(evidence.liveCheckDir());
      const { out } = await runVerify(['aqe']);
      assert.match(out, /✗ live embedding request: (unavailable|not-configured)/, 'the failed request is still printed');
      assert.equal(evidence.readLiveCheck('aqe-embedding', {}), null);
    } finally {
      Object.assign(process.env, saved);
    }
  });
}

test('aqeEmbeddingManaged: only an endpoint or in-process choice with AQE on', () => {
  assert.equal(verify.aqeEmbeddingManaged({ aqeEmbedding: MANAGED_EMBEDDING }), true);
  assert.equal(verify.aqeEmbeddingManaged({ aqeEmbedding: { mode: 'in-process' } }), true);
  assert.equal(verify.aqeEmbeddingManaged({ aqeEmbedding: { mode: 'unmanaged' } }), false);
  assert.equal(verify.aqeEmbeddingManaged({}), false);
  assert.equal(verify.aqeEmbeddingManaged(undefined), false);
  assert.equal(verify.aqeEmbeddingManaged({ aqe: false, aqeEmbedding: MANAGED_EMBEDDING }), false);
  const live = (cfg) => verify.liveChecksFor(cfg).some((check) => check.id === 'aqe-embedding');
  assert.equal(live({ aqeEmbedding: MANAGED_EMBEDDING }), true, 'status --live uses the same gate');
  assert.equal(live({ aqeEmbedding: { mode: 'unmanaged' } }), false);
});

test('a passing live embedding request says the embedder is verified, not the pattern index', async () => {
  seedHome(offlineKitConfig({ aqeEmbedding: MANAGED_EMBEDDING }));
  const probe = async () => ({ status: 'passed', reason: null, dimension: 384 });
  const { out } = await captureLog(() => verify.checkAqeEmbedding({ cwd: PROJECT, corpus: false, probe }));
  assert.match(out, /✓ embedder verified: live embedding request passed; dimension=384; AQE pattern index binding unverified \(agentic-qe#754\)/);
});

test.after(() => rmrf(HOME, PROJECT));

// Task 5.1 (Branch 5): provider checks run from the project root, whatever folder
// `ak x verify` starts in, and every AQE call is pinned there so no subfolder store
// appears. `aqe health` runs with AQE's in-memory backend: its billing section still
// prints and the project's memory.db is not opened (agentic-qe unified-memory.js).
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
  const { out } = await captureLog(() => verify.verifyProviders({ cwd: sub, cfg, runner: recordingRunner(calls), haveCmd: async () => true }));
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
  const bare = fs.realpathSync(fs.mkdtempSync(path.join(path.dirname(PROJECT), 'ak-verify-norepo-')));
  t.after(() => rmrf(bare));
  const cfg = offlineKitConfig({ integrations: { hosts: { claude: false, codex: false } },
    providers: { aqeFallback: [{ provider: 'claude-code', models: ['claude-opus-5'] }] } });
  const calls = [];
  const { out } = await captureLog(() => verify.verifyProviders({ cwd: bare, cfg, runner: recordingRunner(calls), haveCmd: async () => true }));
  assert.match(out, /project checks skipped: not inside a repository/);
  assert.ok(!calls.some((c) => c.cmd === 'aqe'), JSON.stringify(calls));
  assert.deepEqual(fs.readdirSync(bare), []);
});

test('verifyAqe from a subfolder scans the root\'s store and reads the root\'s corpus', async (t) => {
  const { root, sub } = projectWithSub(t);
  const calls = [];
  let corpusPath;
  const probe = async (o) => { corpusPath = o.corpusPath; return { status: 'passed', dimension: 384 }; };
  await captureLog(() => verify.verifyAqe({ cwd: sub, runner: recordingRunner(calls), probe, cfg: offlineKitConfig() }));
  assert.equal(corpusPath, path.join(root, '.agentic-qe', 'memory.db'));
  const status = calls.find((c) => c.cmd === 'aqe' && c.args[0] === 'status');
  assert.ok(status, JSON.stringify(calls));
  assert.equal(status.cwd, root);
  assert.equal(status.env.AQE_PROJECT_ROOT, root);
  assert.equal(fs.existsSync(path.join(sub, '.agentic-qe')), false);
});
