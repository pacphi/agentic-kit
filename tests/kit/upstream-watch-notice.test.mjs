// The upstream watch notice (spec 2026-09-28): a commit comment that mentions
// the maintainer, only for records that need them. Pure functions, no I/O.
import test from 'node:test';
import assert from 'node:assert/strict';

import { NOTICE_MAX, isActionRecord, renderNotice, sentence } from '../../scripts/upstream-watch/ledger.mjs';

const rec = (event, fields = {}, id = 'ruvnet/ruflo#1') => ({ line: `UPSTREAM-WATCH ${id} ${event} 2026-10-02`, id, event, date: '2026-10-02', fields, recordedAt: '2026-10-02T14:17:00Z' });

test('only records that need the maintainer are action items', () => {
  const action = [rec('reply', { by: 'x', at: '10:00:00Z' }), rec('released', { version: '1.0.0', branch: 'upstream/ruvnet-ruflo-1' }), rec('dispatch-pr', { branch: 'upstream/ruvnet-ruflo-1', pr: 261 }), rec('reopened', { status: 'released' }), rec('closed', { reason: 'not_planned' }), rec('retest-due', {}, 'ruflo-hooks-1'), rec('idle', {}, 'registry')];
  const quiet = [rec('acknowledged', { by: 'bot' }), rec('closed', { reason: 'completed' }), rec('merged'), rec('stale'), rec('retire-proposed'), rec('released', { version: '1.0.0' }), rec('fired', { branch: 'upstream/ruvnet-ruflo-1', session: 'https://claude.ai/code/session_1' })];
  for (const item of action) assert.equal(isActionRecord(item), true, item.event);
  for (const item of quiet) assert.equal(isActionRecord(item), false, `${item.event} ${JSON.stringify(item.fields)}`);
});

test('the new record kinds have plain sentences; released names the dispatch branch', () => {
  assert.equal(sentence(rec('fired', { branch: 'upstream/ruvnet-ruflo-1', session: 'https://claude.ai/code/session_1' })), 'Dispatch for `ruvnet/ruflo#1` fired on 2026-10-02 (branch `upstream/ruvnet-ruflo-1`); session https://claude.ai/code/session_1.');
  assert.equal(sentence(rec('dispatch-pr', { branch: 'upstream/ruvnet-ruflo-1', pr: 261 })), 'Draft pull request #261 for `ruvnet/ruflo#1` is ready for review (branch `upstream/ruvnet-ruflo-1`).');
  assert.equal(sentence(rec('released', { version: '3.47.0', pr: 12, branch: 'upstream/ruvnet-ruflo-1' })), 'The fix for `ruvnet/ruflo#1` (pull request `#12`) is released in 3.47.0 (2026-10-02); ak dispatches it on branch `upstream/ruvnet-ruflo-1`.');
});

test('a quiet run has no notice; an action run mentions the maintainer first', () => {
  assert.equal(renderNotice({ records: [rec('stale'), rec('merged')], mention: 'pacphi', date: '2026-10-02' }), '');
  const records = [rec('stale'), rec('reply', { by: 'someone', at: '10:00:00Z' }), rec('released', { version: '1.0.0', branch: 'upstream/ruvnet-ruflo-1' }), rec('fired', { branch: 'upstream/ruvnet-ruflo-1', session: 'https://claude.ai/code/session_9' })];
  const body = renderNotice({ records, mention: 'pacphi', date: '2026-10-02' });
  const lines = body.split('\n');
  assert.equal(lines[0], '@pacphi upstream watch: 2 items need you (2026-10-02).');
  assert.match(body, /someone commented on `ruvnet\/ruflo#1`/);
  assert.match(body, /ak dispatches it on branch `upstream\/ruvnet-ruflo-1`\. Routine session: https:\/\/claude\.ai\/code\/session_9/);
  assert.doesNotMatch(body, /has had no upstream activity/, 'stale records stay in the ledger');
  assert.match(body, /`node scripts\/upstream-watch\.mjs ledger --since 2026-10-02`\n$/);
});

test('thread ids never autolink; only a dispatch pull request number does', () => {
  const body = renderNotice({ records: [rec('reply', { by: 'x', at: '10:00:00Z' }, 'a/b#5'), rec('dispatch-pr', { branch: 'upstream/a-b-5', pr: 261 }, 'a/b#5')], mention: 'pacphi', date: '2026-10-02' });
  const prose = body.replace(/`[^`]*`/g, '');
  assert.deepEqual(prose.match(/#\d+/g), ['#261']);
  assert.doesNotMatch(prose, /[\w.-]+\/[\w.-]+#\d/);
});

test('a notice too long for GitHub lists what fits and says how many more', () => {
  const records = Array.from({ length: 3000 }, (_, index) => rec('reply', { by: 'someone-with-a-long-login', at: '10:00:00Z' }, `owner/repo#${index + 1}`));
  const body = renderNotice({ records, mention: 'pacphi', date: '2026-10-02' });
  assert.ok(body.length <= NOTICE_MAX, String(body.length));
  assert.match(body, /\n\d+ more; see the ledger\.\n/);
  assert.ok(body.includes('`owner/repo#1`') && !body.includes('`owner/repo#3000`'));
});
