// The rolling Ruflo support window (ADR-0041 §7): the newest six minors,
// never fewer than the minors first published in the last 30 days. Computed
// from release dates `ak sync` remembers in kit.json; a plain read never
// calls the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeSupportWindow, minorFirstPublished, recordRufloReleaseDates, rememberedSupportWindow, supportWindowPolicy,
} from '../../src/lib/ruflo-support-window.mjs';

const TIME = {
  created: '2020-01-01T00:00:00Z', modified: '2026-09-27T00:00:00Z',
  '3.38.0': '2026-08-11T22:43:21Z', '3.38.2': '2026-08-13T00:00:00Z', '3.39.0': '2026-09-08T16:52:33Z',
  '3.40.0': '2026-09-09T23:10:35Z', '3.41.0': '2026-09-10T11:59:59Z', '3.42.0': '2026-09-15T00:50:39Z',
  '3.43.0': '2026-09-23T15:05:58Z', '3.44.0': '2026-09-23T18:47:33Z', '3.45.0': '2026-09-24T22:54:53Z',
  '3.46.0-alpha.1': '2026-09-20T00:00:00Z', '3.46.0': '2026-09-26T22:34:55Z', '3.46.1': '2026-09-27T01:00:00Z',
};
const NOW = Date.parse('2026-09-27T12:00:00Z');
const POLICY = { newestMinors: 6, minDays: 30 };

test('first publish per minor ignores prereleases and metadata keys', () => {
  const minors = minorFirstPublished(TIME);
  assert.equal(minors['3.46'], '2026-09-26T22:34:55Z', 'the 3.46.0-alpha.1 prerelease does not open 3.46');
  assert.equal(minors['3.38'], '2026-08-11T22:43:21Z', 'the earliest patch of a minor wins');
  assert.equal(minors.created, undefined);
  assert.equal(minors.modified, undefined);
  assert.deepEqual(minorFirstPublished(null), {});
});

test('30-day rule widens n-5: today the floor is 3.39.0, not 3.41.0', () => {
  const window = computeSupportWindow({ firstPublished: minorFirstPublished(TIME), now: NOW, ...POLICY });
  assert.equal(window.floor, '3.39.0');
  assert.deepEqual(window.minors, ['3.46', '3.45', '3.44', '3.43', '3.42', '3.41', '3.40', '3.39']);
});

test('after a quiet month n-5 alone decides', () => {
  const window = computeSupportWindow({
    firstPublished: minorFirstPublished(TIME), now: Date.parse('2026-12-01T00:00:00Z'), ...POLICY,
  });
  assert.equal(window.floor, '3.41.0');
});

test('fewer minors than the window keeps every known minor', () => {
  const window = computeSupportWindow({
    firstPublished: { '3.45': '2026-09-24T22:54:53Z', '3.46': '2026-09-26T22:34:55Z' }, now: NOW, ...POLICY,
  });
  assert.equal(window.floor, '3.45.0');
});

test('no release dates give null, never a guess', () => {
  assert.equal(computeSupportWindow({ firstPublished: {}, now: NOW, ...POLICY }), null);
  assert.equal(rememberedSupportWindow({}, { now: NOW, policy: POLICY }), null);
  assert.equal(rememberedSupportWindow({ versionCheck: { rufloMinors: { observedAt: 1 } } }, { now: NOW, policy: POLICY }), null);
});

test('the remembered window carries when the dates were observed', () => {
  const cfg = { versionCheck: { rufloMinors: { observedAt: NOW - 3_600_000, firstPublished: minorFirstPublished(TIME) } } };
  const window = rememberedSupportWindow(cfg, { now: NOW, policy: POLICY });
  assert.equal(window.floor, '3.39.0');
  assert.equal(window.observedAt, NOW - 3_600_000);
});

test('recording release dates runs one npm view and keeps the old value on failure', async () => {
  const calls = [];
  const cfg = { versionCheck: { seen: { ruflo: '3.46.1' } } };
  const ok = await recordRufloReleaseDates({
    cfg, now: () => NOW,
    runner: async (command, args, options) => {
      calls.push({ command, args, options });
      return { code: 0, stdout: JSON.stringify(TIME), stderr: '' };
    },
  });
  assert.equal(ok, true);
  assert.deepEqual(calls, [{ command: 'npm', args: ['view', 'ruflo', 'time', '--json'], options: { timeout: 20_000 } }]);
  assert.equal(cfg.versionCheck.rufloMinors.observedAt, NOW);
  assert.equal(cfg.versionCheck.rufloMinors.firstPublished['3.39'], '2026-09-08T16:52:33Z');
  assert.deepEqual(cfg.versionCheck.seen, { ruflo: '3.46.1' }, 'other version-check facts are kept');

  const before = structuredClone(cfg.versionCheck.rufloMinors);
  for (const result of [
    { code: 1, stdout: '', stderr: 'E404' },
    { code: 0, stdout: 'not json', stderr: '' },
    { code: 0, stdout: '{"created":"2020-01-01T00:00:00Z"}', stderr: '' },
  ]) {
    assert.equal(await recordRufloReleaseDates({ cfg, now: () => NOW + 1, runner: async () => result }), false);
    assert.deepEqual(cfg.versionCheck.rufloMinors, before);
  }
});

test('the policy comes from the registry', () => {
  assert.deepEqual(supportWindowPolicy(), POLICY);
});
