// Live-check evidence (decision 9a, #237 S4): `ak sync` and `ak x verify`
// remember what their live checks found, and the read-only `ak status` shows
// that result with its age instead of never learning it. Status itself never
// probes, a configuration change invalidates a result, and an old result is
// labelled stale rather than trusted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  sandboxHome, assertSandboxed, snapshot, assertUnchanged, captureLog, rmrf,
  sandboxProject, writeKitConfig, offlineKitConfig, fakeGlobalRoot,
} from './helpers/home-sandbox.mjs';

const HOME = sandboxHome('ak-live-evidence');
delete process.env.AQE_EMBEDDER_ENDPOINT;
const paths = await import('../../src/lib/paths.mjs');
const evidence = await import('../../src/lib/live-check-evidence.mjs');
const aqeSection = (await import('../../src/commands/status/sections/aqe.mjs')).default;
const { SYNC_STEPS } = await import('../../src/commands/sync.mjs');
assertSandboxed(paths, HOME);
paths._setGlobalRootForTest(fakeGlobalRoot(HOME, { ruflo: '9.9.9', 'agentic-qe': '9.9.9' }));

const PROJECT = sandboxProject('ak-live-evidence');
const NOW = Date.parse('2026-09-26T12:00:00Z');
const MINUTE = 60_000;
const reset = () => rmrf(evidence.liveCheckDir());

test('the store lives under the kit state directory, one file per check', () => {
  assert.ok(evidence.liveCheckDir().startsWith(HOME), 'evidence must never escape the state base');
  assert.equal(path.basename(path.dirname(evidence.liveCheckDir())), 'agentic-kit');
  assert.deepEqual([...evidence.LIVE_CHECK_IDS].sort(),
    ['aqe-embedding', 'deja-vu', 'mcp', 'memory', 'providers', 'security']);
  assert.equal(evidence.LIVE_CHECK_TTL_MS, 24 * 3600_000);
});

test('a recorded result reads back with its source and age', () => {
  reset();
  assert.equal(evidence.recordLiveCheck({ id: 'aqe-embedding', status: 'failed',
    reason: 'endpoint-unreachable', source: 'sync', inputsKey: 'k1' }, { now: NOW }), true);
  const got = evidence.readLiveCheck('aqe-embedding', { inputsKey: 'k1', now: NOW + 5 * MINUTE });
  assert.deepEqual(got, {
    status: 'failed', reason: 'endpoint-unreachable', source: 'sync',
    checkedAt: new Date(NOW).toISOString(), ageMs: 5 * MINUTE, stale: false, invalidated: false,
  });
  assert.ok(fs.existsSync(path.join(evidence.liveCheckDir(), 'aqe-embedding.json')));
});

test('no recorded result reads as null, and a corrupt file never throws', () => {
  reset();
  assert.equal(evidence.readLiveCheck('mcp', { inputsKey: 'k' }), null);
  fs.mkdirSync(evidence.liveCheckDir(), { recursive: true });
  fs.writeFileSync(path.join(evidence.liveCheckDir(), 'mcp.json'), '{not json');
  assert.equal(evidence.readLiveCheck('mcp', { inputsKey: 'k' }), null);
  fs.writeFileSync(path.join(evidence.liveCheckDir(), 'mcp.json'),
    JSON.stringify({ status: 'passed', source: 'nowhere', checkedAt: 'yesterday' }));
  assert.equal(evidence.readLiveCheck('mcp', { inputsKey: 'k' }), null, 'an unrecognised record is no evidence');
});

test('a changed configuration invalidates the result instead of hiding it', () => {
  reset();
  evidence.recordLiveCheck({ id: 'providers', status: 'passed', source: 'verify', inputsKey: 'before' }, { now: NOW });
  const got = evidence.readLiveCheck('providers', { inputsKey: 'after', now: NOW + MINUTE });
  assert.equal(got.invalidated, true);
  assert.equal(got.status, 'passed');
});

test('a result older than the TTL is stale', () => {
  reset();
  evidence.recordLiveCheck({ id: 'security', status: 'passed', source: 'verify', inputsKey: 'k' }, { now: NOW });
  assert.equal(evidence.readLiveCheck('security', { inputsKey: 'k', now: NOW + evidence.LIVE_CHECK_TTL_MS + 1 }).stale, true);
  assert.equal(evidence.readLiveCheck('security', { inputsKey: 'k', now: NOW + 10 * MINUTE, ttlMs: 5 * MINUTE }).stale, true);
  assert.equal(evidence.readLiveCheck('security', { inputsKey: 'k', now: NOW + MINUTE }).stale, false);
});

test('the record boundary rejects unknown ids, statuses and sources', () => {
  reset();
  assert.throws(() => evidence.recordLiveCheck({ id: '../../etc', status: 'passed', source: 'sync', inputsKey: 'k' }), TypeError);
  assert.throws(() => evidence.recordLiveCheck({ id: 'mcp', status: 'green', source: 'sync', inputsKey: 'k' }), TypeError);
  assert.throws(() => evidence.recordLiveCheck({ id: 'mcp', status: 'passed', source: 'dashboard', inputsKey: 'k' }), TypeError);
  assert.equal(fs.existsSync(evidence.liveCheckDir()), false, 'a rejected record writes nothing');
});

test('a stored reason is stripped of control characters and bounded', () => {
  reset();
  const esc = String.fromCharCode(27);
  evidence.recordLiveCheck({ id: 'memory', status: 'failed', source: 'verify', inputsKey: 'k',
    reason: `${esc}[2Jbad‮ ${'x'.repeat(500)}` }, { now: NOW });
  const got = evidence.readLiveCheck('memory', { inputsKey: 'k', now: NOW });
  assert.ok(!got.reason.includes(esc) && !got.reason.includes('‮'));
  assert.ok(got.reason.length <= 200, `reason must be bounded, got ${got.reason.length}`);
});

test('reading evidence never writes', () => {
  reset();
  evidence.recordLiveCheck({ id: 'mcp', status: 'passed', source: 'verify', inputsKey: 'old' }, { now: NOW });
  const before = snapshot(HOME);
  evidence.readLiveCheck('mcp', { inputsKey: 'new', now: NOW + 3 * evidence.LIVE_CHECK_TTL_MS });
  assertUnchanged(before, HOME, 'status reads evidence read-only, even when it is invalidated or stale');
});

test('a write that cannot land reports false instead of throwing', () => {
  reset();
  fs.mkdirSync(path.dirname(evidence.liveCheckDir()), { recursive: true });
  fs.writeFileSync(evidence.liveCheckDir(), 'a file where the directory should be');
  try {
    assert.equal(evidence.recordLiveCheck({ id: 'mcp', status: 'passed', source: 'verify', inputsKey: 'k' }), false);
  } finally { rmrf(evidence.liveCheckDir()); }
});

test('the embedding inputs key follows the selected backend, not the moment', () => {
  const local = { aqeEmbedding: { mode: 'endpoint', endpoint: 'http://127.0.0.1:11434', provisioning: 'ollama' } };
  const other = { aqeEmbedding: { mode: 'endpoint', endpoint: 'http://127.0.0.1:8089', provisioning: 'external' } };
  const key = (cfg, env = {}) => evidence.liveCheckInputsKey('aqe-embedding', { cfg, env, cwd: PROJECT });
  assert.equal(key(local), key(local, { AQE_EMBEDDER_ENDPOINT: 'http://127.0.0.1:9999' }),
    'a managed selection overrides the shell endpoint, so the shell does not change the key');
  assert.notEqual(key(local), key(other));
  assert.notEqual(key({}, { AQE_EMBEDDER_ENDPOINT: 'http://127.0.0.1:1' }), key({}, {}),
    'unmanaged mode probes the shell endpoint, so it is part of the key');
  assert.doesNotThrow(() => key({ aqeEmbedding: { mode: 'bogus' } }), 'an invalid intent must not take down status');
  assert.match(key(local), /^[a-f0-9]{16}$/);
});

test('every id has a key builder that never throws', () => {
  const cfg = offlineKitConfig({ integrations: { hosts: { claude: true, codex: true } } });
  for (const id of evidence.LIVE_CHECK_IDS) {
    assert.match(evidence.liveCheckInputsKey(id, { cfg, cwd: PROJECT }), /^[a-f0-9]{16}$/, id);
  }
  const withoutCodex = offlineKitConfig({ integrations: { hosts: { claude: true, codex: false } } });
  assert.notEqual(evidence.liveCheckInputsKey('mcp', { cfg, cwd: PROJECT }),
    evidence.liveCheckInputsKey('mcp', { cfg: withoutCodex, cwd: PROJECT }), 'toggling a host invalidates the MCP result');
});

test('ages read in human units', () => {
  assert.equal(evidence.formatLiveCheckAge(10_000), 'just now');
  assert.equal(evidence.formatLiveCheckAge(5 * MINUTE), '5m ago');
  assert.equal(evidence.formatLiveCheckAge(3 * 60 * MINUTE), '3h ago');
  assert.equal(evidence.formatLiveCheckAge(50 * 60 * MINUTE), '2d ago');
});

// ── status reader: the aqe-embedding row ─────────────────────────────────────

async function embeddingRow({ record, now } = {}) {
  reset();
  const cfg = offlineKitConfig();
  writeKitConfig(HOME, cfg);
  if (record) {
    evidence.recordLiveCheck({ id: 'aqe-embedding', source: 'sync',
      inputsKey: record.inputsKey ?? evidence.liveCheckInputsKey('aqe-embedding', { cfg, cwd: PROJECT }),
      ...record }, { now: record.at ?? Date.now() - 5 * MINUTE });
  }
  const rows = await aqeSection.collect({ cwd: PROJECT, cfg, now });
  return rows.find((r) => r.subsystem === 'aqe-embedding');
}

test('status without a remembered check keeps the unverified information row', async () => {
  const r = await embeddingRow();
  assert.equal(r.level, 'info');
  assert.equal(r.message, 'unmanaged; backend missing-backend; live model and corpus compatibility unverified');
  assert.equal(r.fix, null);
});

test('status shows a remembered failure as a warning with its age and reason', async () => {
  const r = await embeddingRow({ record: { status: 'failed', reason: 'endpoint-unreachable' } });
  assert.equal(r.level, 'warn', 'failed matches sync and ADR-0055, but never fail: sync convergence counts fail rows');
  assert.match(r.message, /last live check failed 5m ago \(ak sync\): endpoint-unreachable/);
  assert.equal(r.fix, null, 'a remembered result is information, not a sync action');
});

test('status shows a fresh remembered pass as ok with its age', async () => {
  const r = await embeddingRow({ record: { status: 'passed' } });
  assert.equal(r.level, 'ok');
  assert.match(r.message, /last live check passed 5m ago \(ak sync\)/);
  assert.match(r.message, /corpus compatibility unverified/, 'a backend pass never certifies the corpus');
});

test('a stale pass is not green; a stale failure stays a warning', async () => {
  const old = Date.now() - 2 * evidence.LIVE_CHECK_TTL_MS;
  const pass = await embeddingRow({ record: { status: 'passed', at: old } });
  assert.equal(pass.level, 'info');
  assert.match(pass.message, /stale/);
  const failure = await embeddingRow({ record: { status: 'failed', reason: 'endpoint-unreachable', at: old } });
  assert.equal(failure.level, 'warn');
  assert.match(failure.message, /stale/);
});

test('a result from a different configuration is reported as invalidated', async () => {
  const r = await embeddingRow({ record: { status: 'failed', reason: 'endpoint-unreachable', inputsKey: 'from-another-config' } });
  assert.equal(r.level, 'info');
  assert.match(r.message, /configuration changed since the last live check/);
  assert.match(r.message, /ak x verify aqe/);
  assert.doesNotMatch(r.message, /endpoint-unreachable/, 'an invalidated reason must not be presented as current');
});

// ── sync writer: the aqe-embedding step ──────────────────────────────────────

const aqeStep = SYNC_STEPS.find((s) => s.id === 'aqe-embedding');
const syncCtx = (result, cfg) => ({
  cfg, cwd: PROJECT, flags: {}, state: { applyFailures: [] },
  report: () => {}, step: async () => result,
});

test('sync remembers a failed embedding check with the probe reason', async () => {
  reset();
  const cfg = { ...offlineKitConfig(), aqeEmbedding: { mode: 'endpoint', endpoint: 'http://127.0.0.1:11434', provisioning: 'ollama' } };
  await captureLog(() => aqeStep.run(syncCtx({ ok: false, status: 'failed',
    evidence: { status: 'failed', reason: 'endpoint-unreachable' },
    detail: 'Embedding setup incomplete: endpoint-unreachable. Recommended: local Ollama.' }, cfg)));
  const got = evidence.readLiveCheck('aqe-embedding', {
    inputsKey: evidence.liveCheckInputsKey('aqe-embedding', { cfg, cwd: PROJECT }) });
  assert.equal(got.status, 'failed');
  assert.equal(got.source, 'sync');
  assert.equal(got.reason, 'endpoint-unreachable');
  assert.equal(got.invalidated, false, 'sync and status must compute the same inputs key');
});

test('sync remembers a provisioning failure by the first sentence of its detail', async () => {
  reset();
  const cfg = { ...offlineKitConfig(), aqeEmbedding: { mode: 'endpoint', endpoint: 'http://127.0.0.1:11434', provisioning: 'ollama' } };
  await captureLog(() => aqeStep.run(syncCtx({ ok: false, status: 'failed',
    detail: 'Local embedding setup incomplete: Ollama is installed but not running at http://127.0.0.1:11434. Start it, then retry.' }, cfg)));
  const got = evidence.readLiveCheck('aqe-embedding', { now: Date.now() });
  assert.equal(got.reason, 'Local embedding setup incomplete: Ollama is installed but not running at http://127.0.0.1:11434');
});

test('sync remembers a pass and nothing when the backend is unmanaged', async () => {
  reset();
  const cfg = offlineKitConfig();
  await captureLog(() => aqeStep.run(syncCtx({ ok: true, status: 'skipped', detail: 'embeddings unmanaged' }, cfg)));
  assert.equal(evidence.readLiveCheck('aqe-embedding', {}), null, 'a skipped check is not a pass');
  await captureLog(() => aqeStep.run(syncCtx({ ok: true, status: 'ok',
    evidence: { status: 'passed', dimension: 384 }, detail: 'synthetic embedding probe passed' }, cfg)));
  assert.equal(evidence.readLiveCheck('aqe-embedding', {}).status, 'passed');
});

test.after(() => rmrf(HOME, PROJECT));
