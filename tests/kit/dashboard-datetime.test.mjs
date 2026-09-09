import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatLocalDateTime, formatLocalDateTimeLong, formatLocalDateOrTime, shortSessionId,
} from '../../src/lib/dashboard/client/datetime.mjs';

const AT = '2026-09-03T16:10:15.342Z';

test('local date-time uses the requested locale and user timezone', () => {
  assert.equal(formatLocalDateTime(AT, {
    locale: 'en-US', timeZone: 'America/Los_Angeles',
  }), 'Sep 3, 2026 · 9:10 AM');
  assert.equal(formatLocalDateTime(AT, {
    locale: 'en-GB', timeZone: 'Europe/London',
  }), '3 Sept 2026 · 17:10');
});

test('long local date-time adds seconds and an explicit timezone for disclosure', () => {
  assert.match(formatLocalDateTimeLong(AT, {
    locale: 'en-US', timeZone: 'America/Los_Angeles',
  }), /^Sep 3, 2026 · 9:10:15 AM PDT$/);
});

test('invalid dates remain absent and native identifiers are shortened only for display', () => {
  assert.equal(formatLocalDateTime('not-a-date'), null);
  assert.equal(formatLocalDateTimeLong(null), null);
  assert.equal(shortSessionId('01a06808-ff7f-7ae1-96a1-510da7cf6277'), '…510da7cf6277');
  assert.equal(shortSessionId('orphan0001'), 'orphan0001');
  assert.equal(shortSessionId(''), '');
});

test('timezone conversion crosses calendar days and follows daylight saving time', () => {
  const options = { locale: 'en-US', timeZone: 'America/Los_Angeles' };
  assert.equal(formatLocalDateTimeLong('2026-01-01T01:00:00Z', options), 'Dec 31, 2025 · 5:00:00 PM PST');
  assert.equal(formatLocalDateTimeLong('2026-09-08T23:37:19.823Z', options), 'Sep 8, 2026 · 4:37:19 PM PDT');
  assert.equal(formatLocalDateTime(1e20), null);
});

test('published date-only commitments retain their day in every timezone', () => {
  for (const timeZone of ['America/Los_Angeles', 'Asia/Tokyo']) {
    assert.equal(formatLocalDateOrTime('2026-09-08', { locale: 'en-US', timeZone }), 'Sep 8, 2026');
  }
});
