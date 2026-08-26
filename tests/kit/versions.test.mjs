// cmpVersions — the prerelease-aware comparator behind drift detection and
// kit self-update. The old comparator was prerelease-insensitive, which made
// 4.0.0-alpha.1 vs 4.0.0-alpha.0 compare equal and self-update impossible.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cmpVersions, isValidSemver, latestVersion } from '../../src/lib/versions.mjs';

const newer = (a, b) => cmpVersions(a, b) > 0;

test('core versions compare numerically', () => {
  assert.equal(newer('4.0.1', '4.0.0'), true);
  assert.equal(newer('4.1.0', '4.0.9'), true);
  assert.equal(newer('3.29.0', '3.28.0'), true);
  assert.equal(newer('3.28.0', '3.29.0'), false);
  assert.equal(newer('10.0.0', '9.9.9'), true); // numeric, not lexicographic
});

test('equal versions are not newer', () => {
  assert.equal(cmpVersions('4.0.0', '4.0.0'), 0);
  assert.equal(cmpVersions('4.0.0-alpha.1', '4.0.0-alpha.1'), 0);
});

test('release outranks any prerelease of the same core', () => {
  assert.equal(newer('4.0.0', '4.0.0-alpha.1'), true);
  assert.equal(newer('4.0.0-rc.9', '4.0.0'), false);
});

test('prerelease increments compare (the alpha.0 → alpha.1 case)', () => {
  assert.equal(newer('4.0.0-alpha.1', '4.0.0-alpha.0'), true);
  assert.equal(newer('4.0.0-alpha.0', '4.0.0-alpha.1'), false);
});

test('numeric prerelease identifiers compare numerically', () => {
  assert.equal(newer('4.0.0-alpha.10', '4.0.0-alpha.9'), true);
});

test('prerelease channels compare lexically (alpha < beta < rc)', () => {
  assert.equal(newer('4.0.0-beta.0', '4.0.0-alpha.9'), true);
  assert.equal(newer('4.0.0-rc.0', '4.0.0-beta.9'), true);
});

test('numeric prerelease identifiers rank below alphanumeric ones', () => {
  assert.equal(newer('4.0.0-alpha', '4.0.0-1'), true); // semver §11.4.3
});

test('shorter prerelease list ranks below a longer prefix-equal one', () => {
  assert.equal(newer('4.0.0-alpha.1', '4.0.0-alpha'), true); // semver §11.4.4
});

test('higher core wins regardless of prerelease', () => {
  assert.equal(newer('4.0.1-alpha.0', '4.0.0'), true);
});

test('command-boundary SemVer validation accepts only strict SemVer 2.0 values', () => {
  for (const value of ['0.19.0', '1.2.3-rc.1', '1.2.3+build.7', '1.2.3-0']) {
    assert.equal(isValidSemver(value), true, value);
  }
  for (const value of [
    '', 'v0.19.0', '1.2', '1.2.3.4', '01.2.3', '1.02.3', '1.2.03',
    '1.2.3-01', '1.2.3-', '1.2.3+bad!', '1.2.3\n--unsafe', null,
  ]) assert.equal(isValidSemver(value), false, String(value));
});

test('latestVersion uses literal npm argv, honors its deadline, and rejects unsafe output', async () => {
  const calls = [];
  const runner = async (command, args, options) => {
    calls.push({ command, args, options });
    return { code: 0, stdout: '0.20.0 --unsafe\n', stderr: '' };
  };
  assert.equal(await latestVersion('@vshulcz/deja-vu', 'latest', {
    runner, timeout: 5_000,
  }), null);
  assert.deepEqual(calls, [{
    command: 'npm',
    args: ['view', '@vshulcz/deja-vu@latest', 'version'],
    options: { timeout: 5_000 },
  }]);
});
