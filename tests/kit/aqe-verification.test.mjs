import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyAqeStartup } from '../../src/lib/aqe-readiness.mjs';
import { aqeVerificationPassed } from '../../src/lib/aqe-verification.mjs';

test('a live lock does not hide an independent storage error', () => {
  assert.equal(classifyAqeStartup({ code: 0, stderr: 'locked by a live process; FsyncFailed' }).status, 'failed');
});
// AQE 3.14.3 emitted this exact sequence under a live lock. The released 3.14.4
// artifact omits FsyncFailed in macOS and Linux conformance probes; old output fails closed.
const OLD_LIVE_OWNER_CONTENTION = [
  '[RVF] /p/.agentic-qe/patterns.rvf is locked by a live process (pid 70149) — not breaking the lock; degrading to SQLite for this run.',
  '[RVF] /p/.agentic-qe/patterns.rvf is unusable but its lock is held by a live process — leaving it alone and degrading to SQLite for this run.',
  '[RVF] Shared adapter init failed: RVF error 0x0303: FsyncFailed',
].join('\n');

test('old live-owner FsyncFailed sequence fails closed and blocks verification', () => {
  const startup = classifyAqeStartup({ code: 0, stdout: '', stderr: OLD_LIVE_OWNER_CONTENTION });
  assert.deepEqual(startup, { status: 'failed', reason: 'RVF backend failed' });
  assert.equal(aqeVerificationPassed(startup, { status: 'passed', corpus: { status: 'healthy' } }), false);
});
test('FsyncFailed fails with or without partial live-lock lines', () => {
  const [locked, unusable, fsync] = OLD_LIVE_OWNER_CONTENTION.split('\n');
  for (const stderr of [fsync, `${locked}\n${fsync}`, `${unusable}\n${fsync}`]) {
    assert.equal(classifyAqeStartup({ code: 0, stderr }).status, 'failed', stderr);
  }
  assert.equal(classifyAqeStartup({ code: 1, stderr: OLD_LIVE_OWNER_CONTENTION }).status, 'failed');
});
test('FsyncFailed takes precedence over failed embedding initialization', () => {
  const stderr = `${OLD_LIVE_OWNER_CONTENTION}\nReasoningBank prewarm failed`;
  assert.equal(classifyAqeStartup({ code: 0, stderr }).status, 'failed');
});
test('a live lock does not hide failed embedding initialization', () => {
  assert.equal(classifyAqeStartup({ code: 0, stderr: 'locked by a live process; prewarm failed' }).status, 'degraded');
});
test('ordinary live lock remains busy with owner health and RVF integrity unknown', () => {
  const startup = classifyAqeStartup({ code: 0, stderr: '[RVF] locked by a live process; 0x0300: LockHeld; degrading to SQLite' });
  assert.equal(startup.status, 'busy');
  assert.match(startup.reason, /SQLite fallback observed/);
  assert.match(startup.reason, /owner health and RVF integrity unverified/);
  assert.equal(aqeVerificationPassed(startup, { status: 'passed', corpus: { status: 'healthy' } }), true);
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
