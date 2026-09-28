import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyAqeStartup } from '../../src/lib/aqe-readiness.mjs';
import { aqeVerificationPassed } from '../../src/lib/aqe-verification.mjs';

test('a live lock does not hide an independent storage error', () => {
  assert.equal(classifyAqeStartup({ code: 0, stderr: 'locked by a live process; FsyncFailed' }).status, 'failed');
});
// TEMPORARY (remove with the rule in classifyAqeStartup, pacphi/agentic-kit#240): the
// exact stderr agentic-qe 3.14.3 emits when a healthy patterns.rvf is held by a live
// owner (captured from a fixture; store and lock bytes were unchanged). The FsyncFailed
// comes from a create attempt AQE should not make (agentic-qe#574). Remove this test
// when a released agentic-qe fixes agentic-qe#574 and that release is the kit's floor;
// agentic-qe#719 (in 3.14.4) is a partial fix and does not remove it.
const LIVE_OWNER_CONTENTION = [
  '[RVF] /p/.agentic-qe/patterns.rvf is locked by a live process (pid 70149) — not breaking the lock; degrading to SQLite for this run.',
  '[RVF] /p/.agentic-qe/patterns.rvf is unusable but its lock is held by a live process — leaving it alone and degrading to SQLite for this run.',
  '[RVF] Shared adapter init failed: RVF error 0x0303: FsyncFailed',
].join('\n');

test('live-owner lock contention reads as busy, not a storage failure (agentic-qe#574)', () => {
  const startup = classifyAqeStartup({ code: 0, stdout: '', stderr: LIVE_OWNER_CONTENTION });
  assert.equal(startup.status, 'busy');
  assert.match(startup.reason, /another live process/);
  assert.match(startup.reason, /integrity unverified/);
  assert.equal(aqeVerificationPassed(startup, { status: 'passed', corpus: { status: 'healthy' } }), true);
});
test('the contention rule needs all three lines; a partial match still fails', () => {
  const [locked, unusable, fsync] = LIVE_OWNER_CONTENTION.split('\n');
  for (const stderr of [fsync, `${locked}\n${fsync}`, `${unusable}\n${fsync}`]) {
    assert.equal(classifyAqeStartup({ code: 0, stderr }).status, 'failed', stderr);
  }
  assert.equal(classifyAqeStartup({ code: 1, stderr: LIVE_OWNER_CONTENTION }).status, 'failed');
});
test('live-owner contention does not hide failed embedding initialization', () => {
  const stderr = `${LIVE_OWNER_CONTENTION}\nReasoningBank prewarm failed`;
  assert.equal(classifyAqeStartup({ code: 0, stderr }).status, 'degraded');
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
