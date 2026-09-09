import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyAqeRouter, undoAqeRouter, aqeRouterFile, applyHosts, undoProviders } from '../../src/lib/providers.mjs';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-preserve-'));
  fs.mkdirSync(path.join(dir, '.git'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const config = () => ({ integrations: { hosts: { claude: true, codex: true } }, providers: {
  aqeFallback: [{ provider: 'openai', models: ['gpt-5.6'] }],
} });
function put(file, data) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data)); }
function get(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

for (const backup of [false, true]) {
  for (const legacy of [false, true]) {
    for (const key of ['defaultProvider', 'userKey']) {
      test(`router preserves ${key} edit (backup=${backup}, legacy=${legacy})`, (t) => {
        const dir = fixture(t); const file = aqeRouterFile(dir);
        if (backup) put(file, { defaultProvider: 'gemini', userKey: 'original' });
        if (legacy) {
          if (backup) fs.copyFileSync(file, `${file}.bak`);
          put(file, { _managedBy: 'agentic-kit', defaultProvider: 'openai' });
        } else applyAqeRouter(config(), dir);
        const cur = get(file); cur[key] = 'edited-after-setup'; put(file, cur);
        const before = fs.readFileSync(file, 'utf8');
        const result = undoAqeRouter(dir);
        assert.equal(result.ok, false);
        assert.equal(result.changed, false);
        assert.match(result.detail, /preserved|review/i);
        assert.equal(fs.readFileSync(file, 'utf8'), before);
        if (backup) assert.ok(fs.existsSync(`${file}.bak`));
      });
    }
  }
}
test('sync after a foreign router edit cannot authorize restoring the old backup', (t) => {
  const dir = fixture(t); const file = aqeRouterFile(dir);
  put(file, { userKey: 'original' });
  applyAqeRouter(config(), dir);
  put(file, { ...get(file), userKey: 'edited' });
  const cfg = config(); cfg.providers.aqeFallback[0].models = ['different-model'];
  applyAqeRouter(cfg, dir);
  assert.equal(undoAqeRouter(dir).ok, false);
  assert.equal(get(file).userKey, 'edited');
});
test('changed backup is preserved instead of replacing the router with unverified bytes', (t) => {
  const dir = fixture(t); const file = aqeRouterFile(dir);
  put(file, { userKey: 'original' }); applyAqeRouter(config(), dir);
  put(`${file}.bak`, { userKey: 'modified backup' });
  const before = fs.readFileSync(file, 'utf8');
  assert.equal(undoAqeRouter(dir).ok, false);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});
test('provider teardown preserves edited and unowned env keys and restores overwritten values', (t) => {
  const dir = fixture(t); const file = path.join(dir, '.claude', 'settings.local.json');
  put(file, { env: { ENABLE_CODEX: 'prior', EXTRA: 'keep' } });
  applyHosts(config(), dir);
  const live = get(file); live.env.ENABLE_CLAUDE_CODE = 'user-edit'; live.env.AQE_MAX_BUDGET_USD = '17'; put(file, live);
  undoProviders(dir);
  assert.deepEqual(get(file).env, { ENABLE_CODEX: 'prior', ENABLE_CLAUDE_CODE: 'user-edit', AQE_MAX_BUDGET_USD: '17', EXTRA: 'keep' });
});
test('legacy provider env without exact receipts is preserved', (t) => {
  const dir = fixture(t); const file = path.join(dir, '.claude', 'settings.local.json');
  put(file, { env: { ENABLE_CODEX: 'true', AQE_MAX_BUDGET_USD: '17' } });
  const before = fs.readFileSync(file, 'utf8');
  assert.equal(undoProviders(dir).changed, false);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('router restore interruption leaves live file, backup and receipt available for retry', async (t) => {
  const { undoOwnedRouter, routerReceiptFile } = await import('../../src/lib/provider-ownership.mjs');
  const dir = fixture(t); const file = aqeRouterFile(dir);
  put(file, { userKey: 'original' }); applyAqeRouter(config(), dir);
  const before = fs.readFileSync(file, 'utf8'); const backup = fs.readFileSync(`${file}.bak`, 'utf8');
  const fsImpl = { ...fs, renameSync() { throw new Error('injected interrupted restore'); } };
  assert.throws(() => undoOwnedRouter(file, { fsImpl }), /interrupted restore/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(fs.readFileSync(`${file}.bak`, 'utf8'), backup);
  assert.ok(fs.existsSync(routerReceiptFile(file)));
  assert.equal(undoAqeRouter(dir).ok, true);
  assert.equal(fs.readFileSync(file, 'utf8'), backup);
});
test('unchanged successive router projections still remove a newly created file', (t) => {
  const dir = fixture(t); const file = aqeRouterFile(dir); const cfg = config();
  applyAqeRouter(cfg, dir);
  cfg.providers.aqeFallback[0].models = ['next-model']; applyAqeRouter(cfg, dir);
  assert.equal(undoAqeRouter(dir).ok, true);
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.existsSync(`${file}.bak`), false);
  applyAqeRouter(cfg, dir);
  assert.equal(undoAqeRouter(dir).ok, true);
});
test('legacy unchanged router marker does not prove ownership', (t) => {
  const dir = fixture(t); const file = aqeRouterFile(dir);
  put(file, { _managedBy: 'agentic-kit', defaultProvider: 'openai' });
  const before = fs.readFileSync(file, 'utf8');
  assert.equal(undoAqeRouter(dir).ok, false);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});
test('router rejects a stale preexisting backup even on the first managed projection', (t) => {
  const dir = fixture(t); const file = aqeRouterFile(dir);
  put(file, { userKey: 'current' }); put(`${file}.bak`, { userKey: 'ancient' });
  applyAqeRouter(config(), dir);
  assert.equal(undoAqeRouter(dir).ok, false);
  assert.equal(get(file).userKey, 'current');
});

test('malformed router receipt cannot authorize teardown', async (t) => {
  const { routerReceiptFile } = await import('../../src/lib/provider-ownership.mjs');
  const dir = fixture(t); const file = aqeRouterFile(dir);
  applyAqeRouter(config(), dir);
  put(routerReceiptFile(file), { version: 1, postimage: null, preimage: null });
  assert.equal(undoAqeRouter(dir).ok, false);
  assert.ok(fs.existsSync(file));
});
test('missing or symlinked original backup cannot authorize router restore', (t) => {
  const dir = fixture(t); const file = aqeRouterFile(dir);
  put(file, { userKey: 'original' }); applyAqeRouter(config(), dir);
  const backup = fs.readFileSync(`${file}.bak`); fs.rmSync(`${file}.bak`);
  assert.equal(undoAqeRouter(dir).ok, false);
  const other = path.join(dir, 'foreign-backup.json'); fs.writeFileSync(other, backup);
  fs.symlinkSync(other, `${file}.bak`);
  assert.equal(undoAqeRouter(dir).ok, false);
  assert.deepEqual(fs.readFileSync(other), backup);
});
test('provider env receipts retain original values across reconfiguration', (t) => {
  const dir = fixture(t); const file = path.join(dir, '.claude', 'settings.local.json');
  put(file, { env: { ENABLE_CODEX: 'original' } });
  const cfg = config(); applyHosts(cfg, dir);
  cfg.providers.maxBudgetUsd = 20; applyHosts(cfg, dir);
  assert.equal(undoProviders(dir).ok, true);
  assert.deepEqual(get(file).env, { ENABLE_CODEX: 'original' });
});
test('malformed env receipts preserve values', (t) => {
  const dir = fixture(t); const file = path.join(dir, '.claude', 'settings.local.json');
  applyHosts(config(), dir);
  const before = fs.readFileSync(file, 'utf8');
  put(`${file}.agentic-kit-env-ownership.json`, { version: 1, entries: { ENABLE_CODEX: { before: null, after: { present: true } } } });
  assert.equal(undoProviders(dir).changed, false);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('failed env projection and retry cannot claim the intermediate managed value as original', (t) => {
  const dir = fixture(t); const file = path.join(dir, '.claude', 'settings.local.json');
  put(file, { env: { ENABLE_CODEX: 'original' } });
  const cfg = config(); applyHosts(cfg, dir);
  const backup = fs.readFileSync(`${file}.bak`);
  fs.rmSync(`${file}.bak`); fs.mkdirSync(`${file}.bak`);
  cfg.integrations.hosts.codex = false; cfg.providers.aqeProvider = 'openai';
  assert.throws(() => applyHosts(cfg, dir), /unusable backup/);
  assert.equal(undoProviders(dir).ok, false, 'pending projection has no teardown authority');
  fs.rmdirSync(`${file}.bak`); fs.writeFileSync(`${file}.bak`, backup);
  applyHosts(cfg, dir);
  const before = fs.readFileSync(file, 'utf8');
  assert.equal(undoProviders(dir).ok, false, 'ambiguous preimage remains unresolved after retry');
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8')).env.ENABLE_CODEX, 'original');
});
