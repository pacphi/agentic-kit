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
  assert.match(out, /unknown suite: bogus \(learning\|memory\|security\|aqe\|providers\|harvest\|all\)/);
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

test('the harvest suite skips (does not fail) when the agentdb CLI is absent', async () => {
  seedHome();
  const { result, out } = await runVerify(['harvest']);
  assert.equal(result, 0, 'an unavailable optional dependency is a skip, not a failed proof');
  assert.match(out, /agentdb CLI not installed — skipping harvest proof/);
});

test('`all` runs every suite and fails if any single proof failed', async () => {
  seedHome();
  const { result, out } = await runVerify([]);
  assert.equal(result, 1);
  for (const heading of ['learning —', 'memory —', 'security —', 'aqe —', 'providers —', 'harvest —']) {
    assert.ok(out.includes(heading), `the default run must include the ${heading} suite`);
  }
  assert.match(out, /verification failed — see above/);
});

test('verify writes nothing into HOME', async () => {
  seedHome();
  const before = snapshot(HOME);
  await runVerify([]);
  assertUnchanged(before, HOME, '`ak x verify` proves things; it must not change them');
});

test.after(() => rmrf(HOME, PROJECT));
