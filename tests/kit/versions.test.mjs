// cmpVersions — the prerelease-aware comparator behind drift detection and
// kit self-update. The old comparator was prerelease-insensitive, which made
// 4.0.0-alpha.1 vs 4.0.0-alpha.0 compare equal and self-update impossible.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cmpVersions, isValidSemver, latestVersion, releaseObservationLabel } from '../../src/lib/versions.mjs';

test('release labels should disclose cached observations and missing timestamps', () => {
  assert.equal(releaseObservationLabel({ latestSource: 'cache', latestObservedAt: 1788919211591 }),
    'cache; observed 2026-09-09T02:00:11.591Z');
  assert.equal(releaseObservationLabel({ latestSource: 'cache-fallback', latestObservedAt: null }),
    'cache-fallback; observed time unknown');
});

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
  assert.equal(await latestVersion('ruflo', 'latest', {
    runner, timeout: 5_000,
  }), null);
  assert.deepEqual(calls, [{
    command: 'npm',
    args: ['view', 'ruflo@latest', 'version'],
    options: { timeout: 5_000 },
  }]);
});

// ── The Ruflo support-window row (ADR-0041 §7) ─────────────────────────────
// The row reads remembered release dates only; the drift report is stubbed so
// the only process a plain read could start would be the window's own lookup.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import versionsSection from '../../src/commands/status/sections/versions.mjs';

const WINDOW_NOW = Date.parse('2026-09-27T12:00:00Z');
const OBSERVED = Date.parse('2026-09-27T09:00:00Z');
const REMEMBERED = {
  versionCheck: {
    rufloMinors: {
      observedAt: OBSERVED,
      firstPublished: {
        3.38: '2026-08-11T22:43:21Z', 3.39: '2026-09-08T16:52:33Z', '3.40': '2026-09-09T23:10:35Z',
        3.41: '2026-09-10T11:59:59Z', 3.42: '2026-09-15T00:50:39Z', 3.43: '2026-09-23T15:05:58Z',
        3.44: '2026-09-23T18:47:33Z', 3.45: '2026-09-24T22:54:53Z', 3.46: '2026-09-26T22:34:55Z',
      },
    },
  },
};

/** Collect the versions section with a fake `npm` first on PATH that records any call. */
async function windowRows(installed, cfg) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-window-bin-'));
  const marker = path.join(bin, 'npm-called');
  fs.writeFileSync(path.join(bin, 'npm'), `#!/bin/sh\necho "$@" >> "${marker}"\nexit 1\n`, { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${oldPath}`;
  try {
    const rows = await versionsSection.collect({
      drift: async () => [{ pkg: 'ruflo', installed, latest: '3.46.1', latestSource: 'cache', latestObservedAt: OBSERVED, outdated: installed !== '3.46.1' }],
      loadConfig: () => cfg,
      now: () => WINDOW_NOW,
    });
    return { rows, npmCalled: fs.existsSync(marker) };
  } finally {
    process.env.PATH = oldPath;
    fs.rmSync(bin, { recursive: true, force: true });
  }
}
const windowRow = (rows) => rows.find((r) => r.subsystem === 'versions' && /support window/.test(r.message));

test('a Ruflo inside the remembered window is reported as supported', async () => {
  const { rows } = await windowRows('3.46.1', REMEMBERED);
  const r = windowRow(rows);
  assert.equal(r.level, 'info');
  assert.equal(r.message, 'Ruflo 3.46.1 is inside the support window (3.39.0 and newer; release dates observed 2026-09-27T09:00:00.000Z)');
  assert.equal(r.fix, null);
});

test('a Ruflo below the window is unsupported and sync repairs it', async () => {
  const { rows } = await windowRows('3.38.2', REMEMBERED);
  const r = windowRow(rows);
  assert.equal(r.level, 'fail');
  assert.match(r.message, /unsupported/);
  assert.match(r.message, /below the support window \(3\.39\.0 and newer/);
  assert.equal(r.fix, 'sync upgrades Ruflo into the support window');
  assert.equal(r.repair, 'sync');
});

test('with no remembered release dates the window is unknown and nothing calls npm', async () => {
  const { rows, npmCalled } = await windowRows('3.46.1', {});
  const r = windowRow(rows);
  assert.equal(r.level, 'info');
  assert.equal(r.message, "Ruflo support window not yet known: run ak sync to record Ruflo's release dates");
  assert.equal(r.fix, null, 'an info pointer, never a sync step that would stop daemons');
  assert.equal(npmCalled, false);
  assert.doesNotMatch(r.message, /unsupported/);
});

test('no window row when Ruflo is not installed', async () => {
  const { rows } = await windowRows(null, REMEMBERED);
  assert.equal(windowRow(rows), undefined);
});
