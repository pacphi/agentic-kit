import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { supportsNodeRuntime, nodeRuntimeError } from '../../src/lib/node-runtime.mjs';

for (const version of ['18.20.0', '22.0.0', '22.5.0', '22.12.0', '22.12.99', '23.0.0', '23.3.99', '22.13.0-rc.1', '', 'bogus']) {
  test(`runtime rejects unsupported Node ${version}`, () => {
    assert.equal(supportsNodeRuntime(version), false);
    assert.match(nodeRuntimeError(version), /22\.13\.0/);
  });
}
for (const version of ['22.13.0', '22.13.1', '22.99.0', '23.4.0', '24.0.0', '26.0.0']) {
  test(`runtime admits Node ${version}`, () => {
    assert.equal(supportsNodeRuntime(version), true);
    assert.equal(nodeRuntimeError(version), null);
  });
}
test('CLI rejects early Node before dispatching SQLite commands', () => {
  const cli = fileURLToPath(new URL('../../bin/agentic-kit.mjs', import.meta.url));
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `Object.defineProperty(process.versions, 'node', { value: '22.12.0' }); process.argv = ['node', ${JSON.stringify(cli)}, 'status', '--json']; await import(${JSON.stringify(new URL('../../bin/agentic-kit.mjs', import.meta.url).href)});`], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /22\.13\.0/);
  assert.doesNotMatch(result.stderr, /ERR_UNKNOWN_BUILTIN_MODULE|at file:/);
  assert.equal(result.stdout, '');
});
