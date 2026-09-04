import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { collectConsumers } from '../../src/lib/footprint/consumers.mjs';
import { npxEnvNodes } from '../../src/lib/footprint/install.mjs';
import { collectStorage, STORAGE_DEFAULTS } from '../../src/lib/footprint/storage.mjs';
import { walkTree } from '../../src/lib/footprint/walk.mjs';

function fixture(t, name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `ak-footprint-perf-${name}-`));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('allocated-size consumers reuse the walker stat instead of lstatting every file twice', (t) => {
  const root = fixture(t, 'allocated');
  fs.writeFileSync(path.join(root, 'one.bin'), Buffer.alloc(4096, 1));
  fs.writeFileSync(path.join(root, 'two.bin'), Buffer.alloc(8192, 2));

  let lstats = 0;
  const fsImpl = {
    ...fs,
    lstatSync(target, options) {
      lstats += 1;
      return fs.lstatSync(target, options);
    },
  };
  const expectedAllocated = ['one.bin', 'two.bin']
    .map((name) => fs.lstatSync(path.join(root, name)).blocks * 512)
    .reduce((total, bytes) => total + bytes, 0);

  const result = collectConsumers({
    roots: [{ id: 'allocated', label: 'allocated', path: root, allocation: 'blocks' }],
    fsImpl,
    platform: 'darwin',
    now: () => 1,
  });
  const row = result.rows.find((candidate) => candidate.id === 'allocated');

  assert.equal(row.bytes.value, expectedAllocated);
  assert.equal(row.basis, 'allocated-blocks');
  assert.equal(lstats, 3, 'one root and two files should each be lstatted exactly once');
});

test('storage reuses same-scan Install npx facts instead of walking every environment again', (t) => {
  const root = fixture(t, 'npx-adoption');
  const cache = path.join(root, 'npm-cache');
  const npxRoot = path.join(cache, '_npx');
  const env = path.join(npxRoot, 'fixture-env');
  const now = Date.now();
  fs.mkdirSync(path.join(env, 'node_modules', 'example'), { recursive: true });
  fs.writeFileSync(path.join(env, 'package.json'), JSON.stringify({ dependencies: { example: '1.0.0' } }));
  fs.writeFileSync(path.join(env, 'node_modules', 'example', 'index.js'), 'module.exports = 1;\n');
  for (const file of [path.join(env, 'package.json'), path.join(env, 'node_modules', 'example', 'index.js')]) {
    fs.utimesSync(file, new Date(now - 120 * 86_400_000), new Date(now - 120 * 86_400_000));
  }

  const previousCache = process.env.npm_config_cache;
  process.env.npm_config_cache = cache;
  t.after(() => {
    if (previousCache === undefined) delete process.env.npm_config_cache;
    else process.env.npm_config_cache = previousCache;
  });

  let installWalks = 0;
  const install = {
    asOf: now,
    npxEnvs: npxEnvNodes({
      root: npxRoot,
      asOf: now,
      walk(target, options) {
        installWalks += 1;
        return walkTree(target, options);
      },
    }),
  };
  let storageWalks = 0;
  const result = collectStorage({
    roots: [],
    projects: [],
    install,
    now: () => now,
    reclaim: { ...STORAGE_DEFAULTS },
    detectCaches: false,
    detectWorktrees: false,
    detectOrphanedTranscripts: false,
    walk(target, options) {
      storageWalks += 1;
      return walkTree(target, options);
    },
  });

  assert.equal(installWalks, 1, 'Install measures the one npx environment once');
  assert.equal(storageWalks, 0, 'Storage must consume Install evidence without a second tree walk');
  assert.equal(result.reclaimables.length, 1);
  assert.equal(result.reclaimables[0].path, env);
  assert.equal(result.reclaimables[0].basis.idle, true);
});

test('storage rejects npx evidence that is stale or not rooted at an immediate cache child', (t) => {
  const root = fixture(t, 'npx-fallback');
  const cache = path.join(root, 'npm-cache');
  const npxRoot = path.join(cache, '_npx');
  const env = path.join(npxRoot, 'fixture-env');
  const now = Date.now();
  fs.mkdirSync(env, { recursive: true });
  fs.writeFileSync(path.join(env, 'package.json'), JSON.stringify({ dependencies: { example: '1.0.0' } }));
  fs.utimesSync(path.join(env, 'package.json'), new Date(now - 120 * 86_400_000), new Date(now - 120 * 86_400_000));

  const previousCache = process.env.npm_config_cache;
  process.env.npm_config_cache = cache;
  t.after(() => {
    if (previousCache === undefined) delete process.env.npm_config_cache;
    else process.env.npm_config_cache = previousCache;
  });

  const facts = npxEnvNodes({ root: npxRoot, asOf: now });
  facts.envs[0] = { ...facts.envs[0], path: path.join(root, 'outside', facts.envs[0].id) };
  let fallbackWalks = 0;
  const result = collectStorage({
    roots: [],
    projects: [],
    install: { asOf: now, npxEnvs: facts },
    now: () => now,
    detectCaches: false,
    detectWorktrees: false,
    detectOrphanedTranscripts: false,
    walk(target, options) {
      fallbackWalks += 1;
      return walkTree(target, options);
    },
  });

  assert.equal(fallbackWalks, 1, 'untrusted reuse evidence must fall back to a fresh bounded walk');
  assert.equal(result.reclaimables[0].path, env);
});
