import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { _setGlobalRootForTest } from '../../src/lib/paths.mjs';
import { applyAqeRouter, aqeRouterFile } from '../../src/lib/providers.mjs';
import { tempDir } from './helpers/temp-dir.mjs';

function fakeAqe(t, version = '3.13.12') {
  const root = tempDir('ak-aqe-version', t);
  const pkg = path.join(root, 'agentic-qe');
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'agentic-qe', version }));
  _setGlobalRootForTest(root);
  t.after(() => _setGlobalRootForTest(undefined));
}

function project(t) {
  const dir = tempDir('ak-aqe-project', t);
  fs.mkdirSync(path.join(dir, '.git'));
  return dir;
}

const cfg = ({
  provider = null,
  chain = [{ provider: 'codex', models: ['gpt-5.6'] }],
} = {}) => ({
  aqe: true,
  integrations: { hosts: { claude: true, codex: false } },
  routing: { routes: {} },
  providers: { aqeProvider: provider, aqeFallback: chain },
});

const readRouter = (dir) => JSON.parse(fs.readFileSync(aqeRouterFile(dir), 'utf8'));

function assertByteAndMtimeStable(dir, run) {
  const file = aqeRouterFile(dir);
  const bytes = fs.readFileSync(file, 'utf8');
  const old = new Date('2001-01-01T00:00:00.000Z');
  fs.utimesSync(file, old, old);
  const beforeMtime = fs.statSync(file).mtimeMs;
  const converged = run();
  assert.equal(converged.changed, false, converged.detail);
  assert.equal(fs.readFileSync(file, 'utf8'), bytes);
  assert.equal(fs.statSync(file).mtimeMs, beforeMtime);
}

test('an empty fallback intent retires the managed chain and its derived default', (t) => {
  fakeAqe(t);
  const dir = project(t);
  const written = applyAqeRouter(cfg(), dir);
  assert.equal(written.ok, true, written.detail);
  const first = readRouter(dir);
  assert.equal(first.defaultProvider, 'codex');
  assert.equal(first._agenticKit.fallbackDefaultProvider.provider, 'codex');

  const cleared = applyAqeRouter(cfg({ chain: [] }), dir);
  const disk = readRouter(dir);
  assert.equal(cleared.ok, true, cleared.detail);
  assert.equal(cleared.changed, true);
  assert.equal(disk.fallbackChain, undefined, 'the managed fallback is retired');
  assert.equal(disk.defaultProvider, undefined, 'the fallback-derived default is retired');
  assert.equal(disk._agenticKit, undefined, 'the derived default receipt is retired');
  assert.deepEqual(disk.providers.codex, { enabled: true }, 'the activation remains available');

  assertByteAndMtimeStable(dir, () => applyAqeRouter(cfg({ chain: [] }), dir));
});

test('fallback retirement keeps a default the user chose from the old chain', (t) => {
  fakeAqe(t);
  const dir = project(t);
  const chain = [
    { provider: 'codex', models: ['gpt-5.6'] },
    { provider: 'ollama', models: ['qwen'] },
  ];
  assert.equal(applyAqeRouter(cfg({ chain }), dir).ok, true);

  const edited = readRouter(dir);
  edited.defaultProvider = 'ollama';
  fs.writeFileSync(aqeRouterFile(dir), JSON.stringify(edited, null, 2) + '\n');

  const cleared = applyAqeRouter(cfg({ chain: [] }), dir);
  const disk = readRouter(dir);
  assert.equal(cleared.ok, true, cleared.detail);
  assert.equal(disk.fallbackChain, undefined, 'the tagged fallback is retired');
  assert.equal(disk.defaultProvider, 'ollama', 'chain membership alone cannot claim a user replacement');
  assert.equal(disk._agenticKit, undefined, 'the stale fallback receipt is retired');

  assertByteAndMtimeStable(dir, () => applyAqeRouter(cfg({ chain: [] }), dir));
});

test('a malformed fallback receipt is relinquished without deleting user values or throwing', (t) => {
  fakeAqe(t);
  const dir = project(t);
  fs.mkdirSync(path.dirname(aqeRouterFile(dir)), { recursive: true });
  fs.writeFileSync(aqeRouterFile(dir), JSON.stringify({
    _managedBy: 'agentic-kit',
    _agenticKit: { fallbackDefaultProvider: 'not-a-receipt' },
    defaultProvider: 'ollama',
    providers: { ollama: { enabled: true, source: 'user' } },
  }));

  const result = applyAqeRouter({ providers: {}, routing: { routes: {} } }, dir);
  const disk = readRouter(dir);
  assert.equal(result.ok, true, result.detail);
  assert.equal(disk.defaultProvider, 'ollama', 'a malformed receipt cannot authorize deleting a user default');
  assert.deepEqual(disk.providers.ollama, { enabled: true, source: 'user' });
  assert.equal(disk._agenticKit, undefined, 'a malformed receipt proves no ownership and is dropped');
});

test('a router file that only holds receipts for removed external providers is left untouched', (t) => {
  fakeAqe(t);
  const dir = project(t);
  fs.mkdirSync(path.dirname(aqeRouterFile(dir)), { recursive: true });
  const file = aqeRouterFile(dir);
  fs.writeFileSync(file, JSON.stringify({
    _managedBy: 'agentic-kit',
    _agenticKit: {
      externalDefaultProvider: { provider: 'hermes', writtenHash: 'x' },
      externalProviders: { hermes: { writtenHash: 'x', providerWrittenHash: 'y' } },
    },
    defaultProvider: 'hermes',
    externalProviders: { hermes: { kind: 'cli', command: ['hermes'] } },
    providers: { hermes: { enabled: true } },
  }, null, 2) + '\n');
  const before = fs.readFileSync(file, 'utf8');

  const result = applyAqeRouter({ providers: {}, routing: { routes: {} } }, dir);
  assert.equal(result.ok, true, result.detail);
  assert.equal(result.changed, false);
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'removed external entries are inert data, never rewritten');
});
