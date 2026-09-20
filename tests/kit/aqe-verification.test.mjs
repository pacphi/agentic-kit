import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyAqeStartup } from '../../src/lib/aqe-readiness.mjs';
import { aqeVerificationPassed } from '../../src/lib/aqe-verification.mjs';

test('a live lock does not hide an independent storage error', () => {
  assert.equal(classifyAqeStartup({ code: 0, stderr: 'locked by a live process; FsyncFailed' }).status, 'failed');
});
test('a live lock does not hide failed embedding initialization', () => {
  assert.equal(classifyAqeStartup({ code: 0, stderr: 'locked by a live process; prewarm failed' }).status, 'degraded');
});
test('busy RVF permits qualified semantic proof when corpus is verified', () => {
  assert.equal(aqeVerificationPassed({ status: 'busy' }, { status: 'passed', corpus: { status: 'healthy' } }), true);
});
test('backend smoke alone does not certify legacy or incompatible vectors', () => {
  for (const status of ['unverified', 'vector_space_mismatch', 'unavailable']) {
    assert.equal(aqeVerificationPassed({ status: 'observed' }, { status: 'passed', corpus: { status } }), false);
  }
});
test('hard storage failure blocks verification even when semantic backend passes', () => {
  assert.equal(aqeVerificationPassed({ status: 'failed' }, { status: 'passed', corpus: { status: 'healthy' } }), false);
});
