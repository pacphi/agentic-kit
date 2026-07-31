// The two "green row that means the wrong thing" defects, at the surface users
// actually read: `ak status`.
//
//   #54 — the providers row compared chain ORDER only, so an all-dead chain in
//         the right order reported `ok`. Viability is now its own row: `warn`.
//   #55 — seeded routing pins diverging from current defaults were invisible.
//         Now `info`, deliberately NOT `warn`: measured end-to-end the diverged
//         pin is cheaper and faster on routine work, so the user is owed a
//         neutral decision, not a lint to clear.
//
// Both defects are the same class — a row that means "matches what's on disk"
// being read as "matches what ak recommends".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  sandboxHome, assertSandboxed, captureLog, rmrf, sandboxProject,
  writeKitConfig, offlineKitConfig, fakeGlobalRoot,
} from './helpers/home-sandbox.mjs';

const HOME = sandboxHome('ak-viability');
const paths = await import('../../src/lib/paths.mjs');
const status = await import('../../src/commands/status.mjs');
const sync = await import('../../src/commands/sync.mjs');
const { AQE_PROVIDER_CREDENTIALS, aqeProviderCredential, credentialGaps } = await import('../../src/lib/providers.mjs');
const { DEFAULT_ROUTES, ACTIVITIES, seedActivityRoutes, divergedRoutes } = await import('../../src/lib/routing.mjs');
assertSandboxed(paths, HOME);

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PROJECT = sandboxProject('ak-viability');
const SRC = path.resolve(PKG_ROOT, 'src');

// Every env var any credential descriptor consults. Scrubbed around each
// credential assertion so a key exported on the developer's machine can never
// make the "keyless rung" fixture pass or fail by accident.
const ALL_CREDENTIAL_ENV = [...new Set(
  Object.values(AQE_PROVIDER_CREDENTIALS).flatMap((d) => [...(d.keyEnv ?? []), ...(d.also ?? [])]),
)];

// async + awaited fn(): without the await, `finally` fires the instant fn()
// returns its (still-pending) promise — before any of fn()'s own awaited work
// (e.g. `await collect()`, which itself awaits driftReport() etc.) has run —
// so the restore races ahead and clobbers env vars fn() hasn't read yet. This
// stayed invisible on any machine that happens to export a REAL credential env
// var (e.g. a personal OPENROUTER_API_KEY): the premature restore lands on
// that real value instead of `undefined`, and a real key is just as truthy as
// the test's injected one, so the assertion passes for the wrong reason.
async function withoutEnv(keys, fn) {
  const saved = {};
  for (const k of keys) { saved[k] = process.env[k]; delete process.env[k]; }
  try { return await fn(); } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

function seedHome(extra = {}) {
  rmrf(paths.claudeDir(), paths.configDir());
  fs.mkdirSync(paths.claudeDir(), { recursive: true });
  fs.writeFileSync(paths.claudeMdPath(), '# machine notes\n');
  writeKitConfig(HOME, offlineKitConfig(extra));
  paths._setGlobalRootForTest(fakeGlobalRoot(HOME, { ruflo: '9.9.9', 'agentic-qe': '9.9.9' }));
}

const collect = () => status.collect({ pkgRoot: PKG_ROOT, cwd: PROJECT });
const rowsFor = (rows, subsystem) => rows.filter((r) => r.subsystem === subsystem);

/** A non-default provider config (isDefault() must be false or the providers
 *  branch short-circuits to its advisory row) carrying the given chain. */
const routeConfig = (routes = {}) => ({
  integrations: {
    version: 2,
    hosts: { claude: true, codex: true, opencode: false },
    bindings: [],
  },
  routing: { version: 1, primaryHost: 'claude', routes },
});
const cfgWithChain = (aqeFallback) => ({
  ...routeConfig(),
  providers: { aqeFallback },
});

/** A dual-routing policy pinned to the PRIOR Opus generation — the exact #55
 *  reproduction, a machine seeded before the alpha.22 catalog bump. Built from
 *  seedActivityRoutes so the escalation ladders are present exactly as a real seed
 *  writes them: two of the six diverge ONLY on their escalation rung, and a
 *  hand-built fixture that dropped `escalation` would silently under-report. */
function divergedPolicy() {
  const rewind = (m) => (m === 'claude-opus-5' ? 'claude-opus-4-8' : m);
  const seed = seedActivityRoutes({ hosts: ['claude', 'codex'] });
  const activityRoutes = {};
  for (const [act, r] of Object.entries(seed)) {
    activityRoutes[act] = {
      ...r,
      model: rewind(r.model),
      ...(r.escalation ? { escalation: r.escalation.map((e) => ({ ...e, model: rewind(e.model) })) } : {}),
    };
  }
  return activityRoutes;
}

/** The six the issue reported, named rather than recomputed — if a catalog bump
 *  changes this set, the test should fail loudly rather than silently re-derive. */
const REPRODUCTION_ACTIVITIES = [
  'architecture', 'debugging', 'design', 'implementation', 'security-analysis', 'testing',
];

// ── #54: chain viability is its own row, and it is a WARN ──────────────────

test('the providers row is WARN when a chain rung has no credential', async () => {
  await withoutEnv(ALL_CREDENTIAL_ENV, async () => {
    seedHome(cfgWithChain([
      { provider: 'claude-code', models: ['claude-opus-5'] },
      { provider: 'openai', models: ['gpt-5.6'] },
    ]));
    const viability = rowsFor(await collect(), 'providers').find((r) => /rungs have credentials/.test(r.message));
    assert.ok(viability, 'chain viability must be reported, not folded into the order check');
    assert.equal(viability.level, 'warn', 'one live rung out of two is not `ok`');
    assert.match(viability.message, /1\/2 rungs have credentials/);
    assert.match(viability.message, /openai/, 'the dead rung is named');
    assert.match(viability.message, /OPENAI_API_KEY/, 'and so is the credential that would fix it');
  });
});

test('the credential row is a WARN, never a FAIL — the primary rung still works', async () => {
  await withoutEnv(ALL_CREDENTIAL_ENV, async () => {
    seedHome(cfgWithChain([
      { provider: 'claude-code', models: ['claude-opus-5'] },
      { provider: 'openai', models: ['gpt-5.6'] },
    ]));
    const viability = rowsFor(await collect(), 'providers').find((r) => /rungs have credentials/.test(r.message));
    assert.notEqual(viability.level, 'fail');
  });
});

test('the credential row plans no fix — only the user can supply a key', async () => {
  await withoutEnv(ALL_CREDENTIAL_ENV, async () => {
    seedHome(cfgWithChain([{ provider: 'openai', models: ['gpt-5.6'] }]));
    const viability = rowsFor(await collect(), 'providers').find((r) => /rungs have credentials/.test(r.message));
    assert.equal(viability.fix, null, '`ak sync` cannot invent a credential — it must not plan to');
  });
});

test('the providers row is OK only when every chain rung is viable', async () => {
  await withoutEnv(ALL_CREDENTIAL_ENV, async () => {
    process.env.OPENROUTER_API_KEY = 'sk-test';
    seedHome(cfgWithChain([
      { provider: 'openrouter', models: ['z-ai/glm-5.2'] },
      { provider: 'ollama', models: ['llama3'] },
    ]));
    const viability = rowsFor(await collect(), 'providers').find((r) => /rungs have credentials/.test(r.message));
    assert.equal(viability.level, 'ok');
    assert.match(viability.message, /2\/2 rungs have credentials/);
  });
});

// ── the REACHABLE host-credential gap: codex ───────────────────────────────
//
// provider-credentials.test.mjs covers the host-credential branch by injecting
// a fake hostAuth, but for `claude-code` that state cannot occur in production:
// hostAuthState infers a keychain/subscription login whenever the CLI is
// present, unconditionally, so claude-code never reports a gap. `codex` has no
// such inference — its credential is a real OPENAI_API_KEY or a real
// ~/.codex/auth.json — so it is the host rung that can genuinely go dead.
//
// This must live here rather than beside the other credential tests because it
// reads the filesystem: only a sandboxed HOME makes "no codex login" true
// regardless of whose machine runs the suite.

test('a codex rung with no key and no login is a REAL, reachable credential gap', () => {
  const c = aqeProviderCredential('codex', { env: {} });
  assert.equal(c.known, true);
  assert.equal(c.present, false,
    'with HOME sandboxed there is no ~/.codex/auth.json — this is the production-reachable gap');
  assert.ok(c.missing.length > 0, 'and it names what would fix it');
});

test('a codex rung is credentialed by an OPENAI_API_KEY alone', () => {
  const c = aqeProviderCredential('codex', { env: { OPENAI_API_KEY: 'sk-test' } });
  assert.equal(c.present, true, 'an api key satisfies codex without any login file');
});

test('the sandbox really has no codex login — this suites premise, asserted', () => {
  // Guards the two tests above from silently becoming vacuous (or from passing
  // for the wrong reason) if the HOME redirect ever stops taking effect.
  assert.ok(!fs.existsSync(path.join(HOME, '.codex', 'auth.json')),
    'the sandboxed HOME must not contain a real codex login');
});

test('credentialGaps reports a dead codex rung through the real env path', () => {
  // No injection anywhere: this is the genuine end-to-end shape of a chain whose
  // host rung has no credential.
  const gaps = credentialGaps([{ provider: 'codex' }, { provider: 'openai' }], { env: {} });
  assert.deepEqual(gaps.map((g) => g.provider), ['codex', 'openai']);
});

// ── #55: divergence is INFO, and never framed as lag ───────────────────────

// The words a fix must never use. Each asserts the newer default is strictly
// better, which the measurements contradict on routine work — and a user who
// believes it pays 2-3x the agentic turns for nothing.
const FORBIDDEN_FRAMING = /\b(stale|outdated|superseded)\b/i;

test('diverged seeded routes are reported as INFO, not WARN', async () => {
  seedHome(routeConfig(divergedPolicy()));
  const row = rowsFor(await collect(), 'routing').find((r) => /diverge/i.test(r.message));
  assert.ok(row, 'divergence must surface somewhere — invisibility is the defect');
  assert.equal(row.level, 'info',
    '`warn` would push users to spend 2-3x the agentic turns clearing a lint that is sometimes wrong');
});

test('the divergence row never calls a diverged route stale, outdated, or superseded', async () => {
  seedHome(routeConfig(divergedPolicy()));
  const row = rowsFor(await collect(), 'routing').find((r) => /diverge/i.test(r.message));
  assert.ok(!FORBIDDEN_FRAMING.test(row.message), `row must stay neutral, got: ${row.message}`);
});

test('the divergence row shows both models so the trade is visible', async () => {
  seedHome(routeConfig(divergedPolicy()));
  const row = rowsFor(await collect(), 'routing').find((r) => /diverge/i.test(r.message));
  assert.match(row.message, /claude-opus-4-8/, 'the pin the machine is on');
  assert.match(row.message, /claude-opus-5/, 'and the default it diverges from');
});

test('the divergence row counts all SIX activities of the reported reproduction', async () => {
  // Four diverge on their primary model; implementation/testing diverge only on
  // their escalation rung. A row that counted four would under-report the very
  // state the issue documented.
  seedHome(routeConfig(divergedPolicy()));
  const row = rowsFor(await collect(), 'routing').find((r) => /diverge/i.test(r.message));
  assert.match(row.message, new RegExp(`\\b${REPRODUCTION_ACTIVITIES.length}\\b`));
});

test('divergedRoutes and the status row agree on exactly which six diverge', async () => {
  // Pins the set, not just the count — a catalog bump that changes membership
  // should fail loudly here rather than silently re-derive a new "correct" answer.
  assert.deepEqual(divergedRoutes(divergedPolicy()).map((d) => d.activity).sort(),
    REPRODUCTION_ACTIVITIES);
});

test('a policy seeded from CURRENT defaults produces no divergence row at all', async () => {
  const activityRoutes = {};
  for (const act of ACTIVITIES) {
    activityRoutes[act] = { host: DEFAULT_ROUTES[act].host, model: DEFAULT_ROUTES[act].model, provenance: 'seeded' };
  }
  seedHome(routeConfig(activityRoutes));
  assert.equal(rowsFor(await collect(), 'routing').filter((r) => /diverge/i.test(r.message)).length, 0);
});

test('user-pinned routes are never reported as divergence, however old the model', async () => {
  const activityRoutes = { architecture: { host: 'claude', model: 'claude-opus-4-8', provenance: 'user' } };
  seedHome(routeConfig(activityRoutes));
  assert.equal(rowsFor(await collect(), 'routing').filter((r) => /diverge/i.test(r.message)).length, 0);
});

// ── the load-bearing one: `ak sync` must NOT auto-refresh ─────────────────

test('the divergence row carries no fix — the mechanism that keeps it out of syncs plan', async () => {
  // sync's plan is *defined* as the rows carrying a `fix`. A null fix is
  // therefore not cosmetic: it is what structurally prevents an auto-refresh.
  seedHome(routeConfig(divergedPolicy()));
  const row = rowsFor(await collect(), 'routing').find((r) => /diverge/i.test(r.message));
  assert.equal(row.fix, null);
});

test('ak sync never plans a routing refresh for a diverged policy', async () => {
  seedHome(routeConfig(divergedPolicy()));
  const cwd = process.cwd();
  process.chdir(PROJECT);
  let out;
  try {
    ({ out } = await captureLog(() => sync.run({
      flags: { 'dry-run': true, 'no-upgrade': false, json: false }, pkgRoot: PKG_ROOT,
    })));
  } finally { process.chdir(cwd); }
  const planned = out.split('\n').filter((l) => l.trim().startsWith('•'));
  assert.ok(!planned.some((l) => /refresh|diverge/i.test(l)),
    `sync must not plan a refresh, got: ${planned.join(' | ')}`);
});

test('a dry-run sync leaves the diverged policy byte-identical on disk', async () => {
  seedHome(routeConfig(divergedPolicy()));
  const before = fs.readFileSync(paths.kitConfigPath(), 'utf8');
  const cwd = process.cwd();
  process.chdir(PROJECT);
  try {
    await captureLog(() => sync.run({
      flags: { 'dry-run': true, 'no-upgrade': false, json: false }, pkgRoot: PKG_ROOT,
    }));
  } finally { process.chdir(cwd); }
  assert.equal(fs.readFileSync(paths.kitConfigPath(), 'utf8'), before);
});

test('sync.mjs does not reference the seeded-route refresh path at all', async () => {
  // The behavioral tests above prove sync does not refresh on THESE fixtures.
  // This proves it cannot on any fixture: the refresh function is not reachable
  // from sync's module. `ak sync` is documented as idempotent reapplication of
  // persisted choice — silently changing which model the user's work runs on
  // would break that contract (and, per the measurements, cost turns for nothing).
  const src = fs.readFileSync(path.join(SRC, 'commands', 'sync.mjs'), 'utf8');
  assert.ok(!/refreshSeededRoutes/.test(src), 'sync must never call refreshSeededRoutes');
  assert.ok(!/divergedRoutes/.test(src), 'sync must not even consult divergence');
});

// ── neutral framing is a whole-surface property, not one row ───────────────

test('no status row anywhere frames a diverged route as stale/outdated/superseded', async () => {
  seedHome(routeConfig(divergedPolicy()));
  for (const r of await collect()) {
    if (!/diverge|seeded route/i.test(r.message)) continue;
    assert.ok(!FORBIDDEN_FRAMING.test(r.message), `neutral framing violated: ${r.message}`);
  }
});

test.after(() => rmrf(HOME, PROJECT));
