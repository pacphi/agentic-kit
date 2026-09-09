// Opt-in installed-artifact proof. No model calls or consumer src/tests needed.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import path from 'node:path';
import { globalRoot } from '../../src/lib/paths.mjs';

const bin = process.env.AQE_COURT_BIN ?? 'aqe-court-referee';
function run(args) {
  const result = spawnSync(bin, args, { encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return JSON.parse(result.stdout);
}

test('published referee validates canonical package config', () => {
  const config = path.join(globalRoot(), 'agentic-qe/assets/skills/qe-court/config.json');
  assert.deepEqual(run(['validate-config', config]), { valid: true, violations: [] });
});

for (const oracle of ['overturn-catches-mutant', 'overturn-disabled', 'writer-not-juror',
  'vendor-diversity', 'doe-score-gate', 'verdict-classes']) {
  test(`published referee oracle: ${oracle}`, () => {
    assert.deepEqual(run(['self-test', oracle]), { oracle, passed: true });
  });
}
