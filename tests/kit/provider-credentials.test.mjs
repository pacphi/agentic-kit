// Issue #54 — aqe fallback-chain credential checking.
//
// Before this, three separate places validated a chain entry (applyAqeRouter,
// `x provider pick`, `ak status`) and none of them touched credentials: a chain
// whose second rung had no API key was written, reported `ok`, and only failed
// at QE-run time — far from the config that caused it. These tests pin the
// credential layer and the write-time warning that consumes it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadKitConfig } from '../../src/lib/config.mjs';
import { AQE_CONSTRUCTIBLE_PROVIDERS } from '../../src/lib/routing.mjs';
import {
  AQE_PROVIDER_TYPES, AQE_PROVIDER_CREDENTIALS, aqeProviderCredential,
  credentialGaps, detectAqeProviders, fallbackSource,
  applyAqeRouter, aqeRouterFile,
} from '../../src/lib/providers.mjs';

// An env with NO provider credentials at all — the baseline every "absent" case
// is measured against, so a key that happens to be exported on the developer's
// machine can never make a negative assertion pass vacuously.
const BARE_ENV = {};

const tmpProject = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-cred-'));
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  return dir;
};
const rm = (dir) => fs.rmSync(dir, { recursive: true, force: true });

function defaultCfg() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-cred-cfg-'));
  const cfg = loadKitConfig(path.join(dir, 'kit.json'));
  rm(dir);
  return cfg;
}

/** Run `fn` with the named env vars removed from process.env, then restore.
 *  applyAqeRouter reads process.env (it has no env injection point), so the
 *  write-time tests must scrub the real env rather than pass a fixture. */
function withoutEnv(keys, fn) {
  const saved = {};
  for (const k of keys) { saved[k] = process.env[k]; delete process.env[k]; }
  try { return fn(); } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

// Every env var any descriptor can consult — scrubbing all of them makes the
// "keyless rung" fixture deterministic regardless of what this machine exports.
const ALL_CREDENTIAL_ENV = [...new Set(
  Object.values(AQE_PROVIDER_CREDENTIALS).flatMap((d) => [...(d.keyEnv ?? []), ...(d.also ?? [])]),
)];

// ── the anti-divergence guard (the acceptance criterion) ────────────────────

test('every AQE_PROVIDER_TYPES member has a credential descriptor', () => {
  // The original defect in miniature: AQE_PROVIDER_TYPES had ten members and the
  // only credential probe was scoped to a FOUR-member list that was never
  // reconciled with it, so six provider types were unverifiable by construction.
  const missing = AQE_PROVIDER_TYPES.filter((p) => !(p in AQE_PROVIDER_CREDENTIALS));
  assert.deepEqual(missing, [], 'these aqe provider types are unverifiable by construction');
});

test('no credential descriptor exists for a provider nothing can ever emit', () => {
  // The other direction of the same guard, but deliberately NOT set-equality:
  // `codex` legitimately has a descriptor while being absent from
  // AQE_PROVIDER_TYPES (that list also gates AQE_LLM_PROVIDER validation, so
  // widening it would be a separate behavior change) — policyToAgentOverrides
  // emits `provider: 'codex'`, so those projected entries need one. The real
  // invariant is that every descriptor corresponds to a provider some code path
  // can actually produce, not that the two lists are identical.
  const emittable = new Set([...AQE_PROVIDER_TYPES, ...AQE_CONSTRUCTIBLE_PROVIDERS]);
  const orphans = Object.keys(AQE_PROVIDER_CREDENTIALS).filter((p) => !emittable.has(p));
  assert.deepEqual(orphans, [], 'a descriptor for a provider nothing emits is dead weight that will rot');
});

test('codex — emitted by the agentOverrides projection — is credential-checkable', () => {
  // Regression pin for the specific gap: a codex-hosted activity projects to
  // `provider: 'codex'`, which a types-only credential map could not verify.
  assert.ok(AQE_CONSTRUCTIBLE_PROVIDERS.includes('codex'));
  const c = aqeProviderCredential('codex', { env: BARE_ENV });
  assert.equal(c.known, true, 'a projected codex override must be verifiable');
  assert.equal(c.billing, 'subscription', 'codex is host-credentialed, not metered');
});

test('every credential descriptor declares exactly one credential mechanism', () => {
  for (const [id, d] of Object.entries(AQE_PROVIDER_CREDENTIALS)) {
    const mechanisms = [d.keyEnv ? 'keyEnv' : null, d.host ? 'host' : null, d.local ? 'local' : null].filter(Boolean);
    assert.equal(mechanisms.length, 1, `${id} must declare exactly one of keyEnv/host/local, got ${mechanisms}`);
    if (d.keyEnv) assert.ok(d.keyEnv.length > 0, `${id} keyEnv is non-empty`);
    assert.ok(['metered', 'subscription', 'local'].includes(d.billing), `${id} billing is classified (got ${d.billing})`);
  }
});

test('openrouter — the one credentialed provider on the reported machine — has a descriptor', () => {
  // It was absent from API_PROVIDERS entirely, so the only live key on the box
  // was invisible to every ak surface while keyless `openai` displayed as configured.
  assert.ok(AQE_PROVIDER_CREDENTIALS.openrouter?.keyEnv?.includes('OPENROUTER_API_KEY'));
});

// ── aqeProviderCredential ───────────────────────────────────────────────────

test('aqeProviderCredential sees a key-present provider and names the var that satisfied it', () => {
  const c = aqeProviderCredential('openrouter', { env: { OPENROUTER_API_KEY: 'sk-test' } });
  assert.equal(c.known, true);
  assert.equal(c.present, true);
  assert.equal(c.billing, 'metered');
  assert.equal(c.source, 'OPENROUTER_API_KEY');
  assert.deepEqual(c.missing, []);
});

test('aqeProviderCredential reports a keyless metered provider as absent, naming what would fix it', () => {
  const c = aqeProviderCredential('openai', { env: BARE_ENV });
  assert.equal(c.present, false);
  assert.ok(c.missing.length > 0, 'must say what is missing, not just that it is');
  assert.match(c.missing.join(' '), /OPENAI_API_KEY/);
});

test('aqeProviderCredential accepts any of a providers alternate key vars', () => {
  for (const key of AQE_PROVIDER_CREDENTIALS.gemini.keyEnv) {
    assert.equal(aqeProviderCredential('gemini', { env: { [key]: 'k' } }).present, true, `${key} satisfies gemini`);
  }
});

test('aqeProviderCredential treats local providers as always usable and $0', () => {
  for (const id of ['ollama', 'onnx']) {
    const c = aqeProviderCredential(id, { env: BARE_ENV });
    assert.equal(c.present, true, `${id} needs no credential`);
    assert.equal(c.billing, 'local');
  }
});

test('aqeProviderCredential routes claude-code to the host login, not an API key', () => {
  // claude-code is credentialed by the frontier host's oauth/subscription — a
  // keyEnv probe would report the working subscription rung as dead.
  const c = aqeProviderCredential('claude-code', { env: BARE_ENV });
  assert.equal(c.known, true);
  assert.equal(c.billing, 'subscription');
});

test('aqeProviderCredential requires a providers extra hard-required vars, not just the key', () => {
  // azure needs an endpoint; bedrock needs the secret half of the pair. A
  // key-only check would call a half-configured provider live.
  const azureKey = AQE_PROVIDER_CREDENTIALS['azure-openai'].keyEnv[0];
  assert.equal(aqeProviderCredential('azure-openai', { env: { [azureKey]: 'k' } }).present, false,
    'key without endpoint is not usable');
  const full = aqeProviderCredential('azure-openai', { env: { [azureKey]: 'k', AZURE_OPENAI_ENDPOINT: 'https://x' } });
  assert.equal(full.present, true);

  assert.equal(aqeProviderCredential('bedrock', { env: { AWS_ACCESS_KEY_ID: 'a' } }).present, false,
    'access key without secret is not usable');
});

test('aqeProviderCredential reports an unknown provider as unknown, never as present', () => {
  const c = aqeProviderCredential('not-a-provider', { env: BARE_ENV });
  assert.equal(c.known, false);
  assert.equal(c.present, false, 'unknown must never read as usable');
});

// ── credentialGaps (the shared basis for all three surfaces) ────────────────

test('credentialGaps is empty for a fully credentialed chain', () => {
  const chain = [{ provider: 'openrouter' }, { provider: 'ollama' }];
  assert.deepEqual(credentialGaps(chain, { env: { OPENROUTER_API_KEY: 'k' } }), []);
});

test('credentialGaps names the dead rung of the exact reported chain', () => {
  // The reproduction: claude-code + openai, no OPENAI_API_KEY. One live rung and
  // a silent dead end underneath it.
  const gaps = credentialGaps(
    [{ provider: 'claude-code', models: ['claude-opus-5'] }, { provider: 'openai', models: ['gpt-5.6'] }],
    { env: BARE_ENV },
  );
  assert.deepEqual(gaps.map((g) => g.provider), ['openai']);
  assert.match(gaps[0].missing.join(' '), /OPENAI_API_KEY/);
});

test('credentialGaps preserves chain order so the report reads top-down', () => {
  const gaps = credentialGaps(
    [{ provider: 'openai' }, { provider: 'ollama' }, { provider: 'cognitum' }],
    { env: BARE_ENV },
  );
  assert.deepEqual(gaps.map((g) => g.provider), ['openai', 'cognitum']);
});

test('credentialGaps ignores malformed entries instead of throwing', () => {
  assert.deepEqual(credentialGaps([null, {}, { models: ['x'] }], { env: BARE_ENV }), []);
  assert.deepEqual(credentialGaps([], { env: BARE_ENV }), []);
});

test('credentialGaps EXCLUDES an unknown provider — unverifiable is not uncredentialed', () => {
  // Reporting "no credential for: mystery-provider" would be ak asserting a fact
  // about a provider it has no descriptor for. Silence is the honest answer: we
  // do not know, and saying we do would be the same over-claiming this whole
  // issue exists to stop.
  assert.deepEqual(credentialGaps([{ provider: 'mystery-provider' }], { env: BARE_ENV }), []);
  // …and it must not swallow a real gap sitting next to the unknown one.
  const mixed = credentialGaps(
    [{ provider: 'mystery-provider' }, { provider: 'openai' }],
    { env: BARE_ENV },
  );
  assert.deepEqual(mixed.map((g) => g.provider), ['openai']);
});

// ── hostAuth injection: BRANCH coverage only ───────────────────────────────
//
// READ THIS BEFORE TRUSTING THE TESTS BELOW.
//
// `hostAuthState` carries a deliberate, NOT platform-gated inference:
//   if (id === 'claude' && present) return { mode: 'oauth', ... }
// so `claude-code` resolves to `present: true` on every platform, with an empty
// env, always. Verified against the real function.
//
// That means these tests exercise the host-credential BRANCH by forcing a state
// `claude-code` cannot reach in production. They are worth keeping — the branch
// is real and shared with `codex` — but they must NOT be read as evidence that
// "ak warns when the Claude subscription is missing". Structurally, ak never
// does that for claude-code, by design.
//
// The genuinely reachable host-credential gap is `codex` (no such inference),
// and it is covered for real — no injection, real env + filesystem path — in
// status-viability.test.mjs, which sandboxes HOME. It cannot live here: this
// file does not redirect HOME, so a codex probe would read the developer's own
// ~/.codex/auth.json and pass or fail depending on whose machine ran it.

test('the host-credential branch reports a logged-out host as a dead rung', () => {
  const c = aqeProviderCredential('claude-code', {
    env: BARE_ENV,
    hostAuth: () => ({ mode: 'none', billing: 'unknown', source: null, note: null }),
  });
  assert.equal(c.present, false);
  assert.ok(c.missing.length > 0, 'it must say what would fix it');
  assert.match(c.missing.join(' '), /claude/i);
});

test('the host-credential branch reports a logged-in host as present and subscription-billed', () => {
  const c = aqeProviderCredential('claude-code', {
    env: BARE_ENV,
    hostAuth: () => ({ mode: 'oauth', billing: 'subscription', source: 'login', note: null }),
  });
  assert.equal(c.present, true);
  assert.equal(c.billing, 'subscription');
  assert.deepEqual(c.missing, []);
});

test('claude-code is present WITHOUT injection — the inference this pins is unconditional', () => {
  // Pins the production reality the two tests above deliberately bypass, so the
  // gap between "branch tested" and "state reachable" can never be forgotten.
  // If someone ever platform-gates that inference, this fails and the comment
  // above stops being true — which is exactly when it needs re-reading.
  const c = aqeProviderCredential('claude-code', { env: BARE_ENV });
  assert.equal(c.present, true, 'claude-code never reports a credential gap in production');
});

test('credentialGaps propagates an injected host-auth failure across the whole chain', () => {
  // Branch-level, same caveat as above. The property is that a dead host rung
  // does not get special-cased into silence just because it is the primary.
  const gaps = credentialGaps(
    [{ provider: 'claude-code' }, { provider: 'openai' }],
    { env: BARE_ENV, hostAuth: () => ({ mode: 'none', billing: 'unknown', source: null, note: null }) },
  );
  assert.deepEqual(gaps.map((g) => g.provider), ['claude-code', 'openai']);
});

// ── detectAqeProviders (what `ak x provider status` renders) ────────────────

test('detectAqeProviders covers every aqe provider type', () => {
  const got = detectAqeProviders({ env: BARE_ENV });
  assert.deepEqual(Object.keys(got).sort(), [...AQE_PROVIDER_TYPES].sort());
});

test('detectAqeProviders shows openrouter as present when OPENROUTER_API_KEY is set', () => {
  // The explicit acceptance criterion — a credentialed provider must never be
  // invisible while a keyless one displays as configured.
  const got = detectAqeProviders({ env: { OPENROUTER_API_KEY: 'sk-test' } });
  assert.equal(got.openrouter.present, true);
  assert.equal(got.openai.present, false, 'and a keyless provider must not read as configured');
});

// ── fallbackSource (provenance stamping, #55 item 4) ───────────────────────

test('fallbackSource treats a legacy unstamped chain entry as a deliberate user pin', () => {
  // Unrecoverable provenance must fail SAFE: never auto-touch what might have
  // been typed by hand.
  assert.equal(fallbackSource({ provider: 'openai', models: ['gpt-5.6'] }), 'user');
  assert.equal(fallbackSource(undefined), 'user');
});

test('fallbackSource returns a stamped entrys own provenance', () => {
  assert.equal(fallbackSource({ provider: 'openai', source: 'suggested' }), 'suggested');
  assert.equal(fallbackSource({ provider: 'openai', source: 'user' }), 'user');
});

// ── applyAqeRouter: warn at write time, but STILL WRITE ────────────────────

test('applyAqeRouter warns about a keyless rung AND still writes the chain', () => {
  // "Do not refuse to write" is explicit in the issue: the user may export the
  // key later, and silently dropping a rung is worse than an inert one.
  const dir = tmpProject();
  withoutEnv(ALL_CREDENTIAL_ENV, () => {
    const cfg = defaultCfg();
    cfg.providers.aqeProvider = 'claude-code';
    cfg.providers.aqeFallback = [
      { provider: 'claude-code', models: ['claude-opus-5'] },
      { provider: 'openai', models: ['gpt-5.6'] },
    ];
    const res = applyAqeRouter(cfg, dir);

    assert.equal(res.changed, true, 'the config is still written');
    assert.match(res.detail, /no credential for/i, 'the detail names the credential gap');
    assert.match(res.detail, /openai/, 'and names the dead rung');
    assert.ok(!/claude-code — needs/.test(res.detail), 'the live subscription rung is not flagged');

    const disk = JSON.parse(fs.readFileSync(aqeRouterFile(dir), 'utf8'));
    assert.deepEqual(disk.fallbackChain.entries.map((e) => e.provider), ['claude-code', 'openai'],
      'the keyless rung is preserved on disk, not dropped');
  });
  rm(dir);
});

test('applyAqeRouter emits no credential warning when every rung is viable', () => {
  const dir = tmpProject();
  withoutEnv(ALL_CREDENTIAL_ENV, () => {
    process.env.OPENROUTER_API_KEY = 'sk-test';
    const cfg = defaultCfg();
    cfg.providers.aqeFallback = [
      { provider: 'openrouter', models: ['z-ai/glm-5.2'] },
      { provider: 'ollama', models: ['llama3'] },
    ];
    const res = applyAqeRouter(cfg, dir);
    assert.equal(res.changed, true);
    assert.ok(!/no credential for/i.test(res.detail), `unexpected credential warning: ${res.detail}`);
  });
  rm(dir);
});

test('applyAqeRouter reports the models gap and the credential gap independently', () => {
  // Two different defects on the same rung must both surface — an empty-models
  // warning must not mask a missing key.
  const dir = tmpProject();
  withoutEnv(ALL_CREDENTIAL_ENV, () => {
    const cfg = defaultCfg();
    cfg.providers.aqeFallback = [{ provider: 'openai', models: [] }];
    const res = applyAqeRouter(cfg, dir);
    assert.match(res.detail, /no models for/i);
    assert.match(res.detail, /no credential for/i);
  });
  rm(dir);
});
