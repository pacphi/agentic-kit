import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatLocalDateTime, formatLocalDateTimeLong, shortSessionId,
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
