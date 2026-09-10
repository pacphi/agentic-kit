import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readContextConfig, contextHome } from '../../src/lib/codex-context-config.mjs';
import { inspectCodexContext, manageCodexContext, releaseCodexContext } from '../../src/lib/codex-context.mjs';

const now = Date.parse('2026-09-09T14:00:00Z');
function fixture(t, source = 'model = "gpt-6-astra"\n[tui]\nstatus_line = ["context-remaining"]\n') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-context-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.writeFileSync(path.join(home, 'config.toml'), source);
  const cache = { client_version: '0.153.4', fetched_at: new Date(now).toISOString(), models: [
    { slug: 'gpt-6-astra', context_window: 272000, max_context_window: 872000, effective_context_window_percent: 95 },
    { slug: 'gpt-5.6-sol', context_window: 272000, max_context_window: 872000, effective_context_window_percent: 95 },
    { slug: 'gpt-5.5', context_window: 272000, max_context_window: 272000, effective_context_window_percent: 95 },
  ] };
  const writeCache = () => fs.writeFileSync(path.join(home, 'models_cache.json'), JSON.stringify(cache));
  writeCache();
  const cfg = { integrations: { hosts: { codex: true } }, codexContext: null };
  const options = { home, now, runner: async () => ({ code: 0, stdout: 'codex-cli 0.153.4' }), persist: () => {} };
  return { home, cfg, options, cache, writeCache, source, read: () => fs.readFileSync(path.join(home, 'config.toml'), 'utf8') };
}

test('native maximum is model-aware and sync is idempotent without altering the cache', async (t) => {
  const f = fixture(t);
  const beforeCache = fs.readFileSync(path.join(f.home, 'models_cache.json'), 'utf8');
  await manageCodexContext(f.cfg, { ...f.options, enable: true });
  const status = inspectCodexContext(f.cfg, f.options);
  assert.deepEqual(status.models.map(m => [m.model, m.effectiveWindow]), [
    ['gpt-6-astra', 828400], ['gpt-5.6-sol', 828400], ['gpt-5.5', 258400],
  ]);
  assert.equal(status.drifted, false);
  assert.equal((await manageCodexContext(f.cfg, f.options)).changed, false);
  assert.equal(fs.readFileSync(path.join(f.home, 'models_cache.json'), 'utf8'), beforeCache);
  assert.match(f.read(), /\[tui\]\nstatus_line = \["context-remaining"\]/);
});

test('unmanaged inspection never writes or requests a repair', (t) => {
  const f = fixture(t);
  const result = inspectCodexContext(f.cfg, f.options);
  assert.equal(result.owned, false);
  assert.equal(result.observedAt, new Date(now).toISOString());
  assert.equal(result.cacheFetchedAt, f.cache.fetched_at);
  assert.equal(result.drifted, false);
  assert.equal(f.read(), f.source);
});

test('restore prior scalar and CRLF formatting when disabling owned context', async (t) => {
  const f = fixture(t, '# keep\r\nmodel_context_window = 100_000 # original\r\n[tui]\r\nother = true\r\n');
  await manageCodexContext(f.cfg, { ...f.options, enable: true });
  assert.equal(/(?<!\r)\n/.test(f.read()), false);
  await releaseCodexContext(f.cfg, f.options);
  assert.equal(f.read(), f.source);
  assert.equal(f.cfg.codexContext, null);
});

test('disable preserves user edits; sync repairs owned drift', async (t) => {
  const f = fixture(t);
  await manageCodexContext(f.cfg, { ...f.options, enable: true });
  fs.writeFileSync(path.join(f.home, 'config.toml'), f.read().replace('872000', '500000'));
  assert.equal(inspectCodexContext(f.cfg, f.options).drifted, true);
  await manageCodexContext(f.cfg, f.options);
  fs.writeFileSync(path.join(f.home, 'config.toml'), f.read().replace('872000', '400000'));
  await releaseCodexContext(f.cfg, f.options);
  assert.match(f.read(), /400000/);
});

test('multiline instructions and profile tables cannot masquerade as top-level overrides', () => {
  const parsed = readContextConfig('instructions = """\nmodel_context_window = 1\n"""\nmodel_context_window = 872000\n[profiles.small]\nmodel_context_window = 10\n');
  assert.equal(parsed.window, 872000);
});

for (const source of ['model_context_window = 1\nmodel_context_window = 2\n', '"model_context_window" = 1\n', 'model_context_window = -1\n', 'model_context_window = 1.2\n', 'model_context_window = 9007199254740992\n', 'instructions = """\nunterminated']) {
  test('ambiguous or invalid TOML is rejected before ownership or file mutation: ' + source.slice(0, 40), async t => {
    const f = fixture(t, source);
    await assert.rejects(manageCodexContext(f.cfg, { ...f.options, enable: true }));
    assert.equal(f.read(), source);
    assert.equal(f.cfg.codexContext, null);
  });
}

for (const change of [c => { c.fetched_at = '2020-01-01'; }, c => { delete c.models[0].effective_context_window_percent; }, c => { c.models[0].max_context_window = -1; }, c => { c.models = []; }]) {
  test('untrusted capacity evidence prevents a write', async t => {
    const f = fixture(t); change(f.cache); f.writeCache();
    await assert.rejects(manageCodexContext(f.cfg, { ...f.options, enable: true }));
    assert.equal(f.read(), f.source);
  });
}

test('a fresh catalog with the same per-model clamp contract survives a Codex patch upgrade', async t => {
  const f = fixture(t);
  f.cache.client_version = '0.154.0'; f.writeCache();
  const options = { ...f.options, runner: async () => ({ code: 0, stdout: 'codex-cli 0.154.0' }) };
  await manageCodexContext(f.cfg, { ...options, enable: true });
  assert.equal(inspectCodexContext(f.cfg, options).available, true);
  assert.match(f.read(), /model_context_window = 872000/);
});

test('native version mismatch and custom providers cannot acquire ownership', async t => {
  const f = fixture(t);
  await assert.rejects(manageCodexContext(f.cfg, { ...f.options, enable: true, runner: async () => ({ code: 0, stdout: 'codex-cli 0.154.0' }) }));
  fs.writeFileSync(path.join(f.home, 'config.toml'), 'model_provider = "local"\n');
  await assert.rejects(manageCodexContext(f.cfg, { ...f.options, enable: true }));
  assert.equal(f.cfg.codexContext, null);
});

test('ownership persists before writing and failed persistence cannot alter config', async t => {
  const f = fixture(t);
  await assert.rejects(manageCodexContext(f.cfg, { ...f.options, enable: true, persist: () => { throw new Error('disk full'); } }));
  assert.equal(f.read(), f.source);
});

test('CODEX_HOME must be absolute and ownership cannot cross homes', async t => {
  assert.throws(() => contextHome({ CODEX_HOME: '../other' }), /absolute/);
  const f = fixture(t); await manageCodexContext(f.cfg, { ...f.options, enable: true });
  await assert.rejects(releaseCodexContext(f.cfg, { ...f.options, home: '/another/home' }), /scope/);
});

test('interrupted reprojection retains both old and pending values for recovery', async t => {
  const f = fixture(t);
  await manageCodexContext(f.cfg, { ...f.options, enable: true });
  f.cache.models[0].max_context_window = 900000; f.writeCache();
  await assert.rejects(manageCodexContext(f.cfg, { ...f.options, persist: () => { fs.appendFileSync(path.join(f.home, 'config.toml'), '# concurrent edit\n'); } }));
  assert.equal(f.cfg.codexContext.lastProjection, 872000);
  assert.equal(f.cfg.codexContext.pendingProjection, 900000);
  await releaseCodexContext(f.cfg, f.options);
  assert.equal(f.read(), f.source + '# concurrent edit\n');
});

test('restoring an original EOF scalar retains a boundary before newly appended settings', async t => {
  const f = fixture(t, 'model_context_window = 100');
  await manageCodexContext(f.cfg, { ...f.options, enable: true });
  fs.appendFileSync(path.join(f.home, 'config.toml'), 'model = "gpt-6-astra"\n');
  await releaseCodexContext(f.cfg, f.options);
  assert.equal(readContextConfig(f.read()).model, 'gpt-6-astra');
  assert.equal(readContextConfig(f.read()).window, 100);
});

test('failed release persistence retains recovery ownership in memory', async t => {
  const f = fixture(t); await manageCodexContext(f.cfg, { ...f.options, enable: true });
  const receipt = structuredClone(f.cfg.codexContext);
  await assert.rejects(releaseCodexContext(f.cfg, { ...f.options, persist: () => { throw new Error('disk full'); } }));
  assert.deepEqual(f.cfg.codexContext, receipt);
  await releaseCodexContext(f.cfg, f.options);
  assert.equal(f.read(), f.source);
});

test('repeated interrupted reconciliations retain the owned value actually on disk', async t => {
  const f = fixture(t); let saves = 0;
  await assert.rejects(manageCodexContext(f.cfg, { ...f.options, enable: true,
    persist: () => { if (++saves === 2) throw new Error('final save failed'); },
  }));
  assert.equal(f.cfg.codexContext.pendingProjection, 872000);
  f.cache.models[0].max_context_window = 900000; f.writeCache();
  await assert.rejects(manageCodexContext(f.cfg, { ...f.options,
    persist: () => { fs.appendFileSync(path.join(f.home, 'config.toml'), '# race\n'); },
  }));
  assert.equal(f.cfg.codexContext.lastProjection, 872000);
  await releaseCodexContext(f.cfg, f.options);
  assert.equal(f.read(), f.source + '# race\n');
});
