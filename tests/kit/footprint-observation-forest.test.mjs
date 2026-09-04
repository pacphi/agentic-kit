import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { observeWalkForest } from '../../src/lib/footprint/observation-forest.mjs';
import { instrumentWalkTree, walkTree } from '../../src/lib/footprint/walk.mjs';

function fixture(t, name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `ak-observation-forest-${name}-`));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function comparable(result) {
  return { ...result, root: path.resolve(result.root) };
}

test('one physical forest walk preserves independent virtual walk results', (t) => {
  const root = fixture(t, 'equivalence');
  fs.mkdirSync(path.join(root, 'keep', 'nested'), { recursive: true });
  fs.mkdirSync(path.join(root, 'vendor', 'nested'), { recursive: true });
  fs.writeFileSync(path.join(root, 'root.js'), 'root\n');
  fs.writeFileSync(path.join(root, 'keep', 'one.js'), 'one\n');
  fs.writeFileSync(path.join(root, 'keep', 'two.txt'), 'two\n');
  fs.writeFileSync(path.join(root, 'keep', 'nested', 'deep.js'), 'deep\n');
  fs.writeFileSync(path.join(root, 'vendor', 'nested', 'ignored.js'), 'ignored\n');

  const specs = () => [
    { skipDir: (_dir, name) => name === 'vendor' },
    { maxDepth: 1, acceptFile: (name) => name.endsWith('.js') },
    { maxEntries: 4, acceptFile: () => false },
  ];
  const expected = specs().map((options) => walkTree(root, options));
  let physicalWalks = 0;
  const walk = instrumentWalkTree({ before: () => { physicalWalks += 1; } });

  const actual = observeWalkForest(root, specs(), { walk, fsImpl: fs });

  assert.deepEqual(actual.map(comparable), expected.map(comparable));
  assert.equal(physicalWalks, 1);
});

test('a pruned virtual walk stays complete when its sibling degrades', (t) => {
  const root = fixture(t, 'independent-degradation');
  const denied = path.join(root, 'generated');
  fs.mkdirSync(denied, { recursive: true });
  fs.writeFileSync(path.join(root, 'source.js'), 'source\n');
  fs.writeFileSync(path.join(denied, 'output.js'), 'output\n');
  const fsImpl = {
    ...fs,
    readdirSync(target, options) {
      if (path.resolve(target) === path.resolve(denied)) {
        throw Object.assign(new Error('fixture denial'), { code: 'EACCES' });
      }
      return fs.readdirSync(target, options);
    },
  };
  const specs = [
    { skipDir: (_dir, name) => name === 'generated' },
    {},
  ];
  const expected = specs.map((options) => walkTree(root, { ...options, fsImpl }));

  const actual = observeWalkForest(root, specs, { walk: walkTree, fsImpl });

  assert.deepEqual(actual, expected);
  assert.equal(actual[0].complete, true);
  assert.equal(actual[1].complete, false);
  assert.equal(actual[1].degraded[0]?.reason, 'EACCES');
});

test('forest callbacks retain independent acceptance and traversal order', (t) => {
  const root = fixture(t, 'callbacks');
  fs.mkdirSync(path.join(root, 'a'), { recursive: true });
  fs.writeFileSync(path.join(root, 'root.txt'), 'root\n');
  fs.writeFileSync(path.join(root, 'a', 'one.js'), 'one\n');
  fs.writeFileSync(path.join(root, 'a', 'two.txt'), 'two\n');
  const expectedFiles = [];
  const actualFiles = [];
  const spec = (sink) => ({
    acceptFile: (name) => name.endsWith('.txt'),
    onFile: ({ file }) => sink.push(path.relative(root, file)),
  });
  const expected = walkTree(root, spec(expectedFiles));

  const [actual] = observeWalkForest(root, [spec(actualFiles)], { walk: walkTree, fsImpl: fs });

  assert.deepEqual(actual, expected);
  assert.deepEqual(actualFiles, expectedFiles);
});
