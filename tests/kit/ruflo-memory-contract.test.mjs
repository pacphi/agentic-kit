// Which Ruflo interface reads which project-memory file is stated only for the
// exact @claude-flow/cli release and platform where it was observed (issue #213).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryRoutingObserved, twoStoreMessage, OBSERVED_ROUTING } from '../../src/lib/ruflo-memory-contract.mjs';

test('only exactly observed release and platform pairs are claimed', () => {
  assert.deepEqual(OBSERVED_ROUTING, [
    { version: '3.42.4', platform: 'darwin' },
    { version: '3.45.0', platform: 'darwin' },
  ]);
  assert.equal(memoryRoutingObserved('3.42.4', 'darwin'), true);
  assert.equal(memoryRoutingObserved('3.45.0', 'darwin'), true);
});

test('neighbouring, prerelease, build-tagged and malformed versions are never claimed', () => {
  for (const v of ['3.42.3', '3.42.5', '3.41.2', '3.43.0', '3.44.0', '3.44.9', '3.45.1', '3.46.0', '4.0.0',
    '3.42.4-alpha.1', '3.42.4-rc.1', '3.42.4+meta', '3.45.0-alpha.1', '3.45.0+build.7',
    'v3.42.4', 'v3.45.0', '3.42', '3.45', '3.42.4.1', 'latest', '', null, undefined, 3.424]) {
    assert.equal(memoryRoutingObserved(v, 'darwin'), false, String(v));
  }
});

test('an observed release on an unobserved platform is not claimed', () => {
  for (const version of ['3.42.4', '3.45.0']) {
    for (const platform of ['linux', 'win32', 'freebsd']) {
      assert.equal(memoryRoutingObserved(version, platform), false, `${version} on ${platform}`);
    }
  }
});

test('the platform defaults to the running process', () => {
  assert.equal(memoryRoutingObserved('3.45.0'), process.platform === 'darwin');
});

test('the observed message is conditional on the native bridge and never says "on your install"', () => {
  for (const version of ['3.42.4', '3.45.0']) {
    const message = twoStoreMessage(version, 'darwin');
    assert.match(message, /native bridge/);
    assert.doesNotMatch(message, /your install/);
  }
  assert.match(twoStoreMessage('3.45.1', 'darwin'), /needs separate verification/);
});
