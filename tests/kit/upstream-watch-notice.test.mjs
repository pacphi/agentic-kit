// The upstream watch notice (spec 2026-09-28): a commit comment that mentions
// the maintainer, only for records that need them. Pure functions, no I/O.
import test from 'node:test';
import assert from 'node:assert/strict';

import { NOTICE_MAX, commitSafe, isActionRecord, renderNotice, sentence } from '../../scripts/upstream-watch/ledger.mjs';

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
  assert.equal(renderNotice({ records: [rec('stale'), rec('merged')], mention: 'pacphi', date: '2026-10-02', recordedAt: '2026-10-02T14:17:00Z' }), '');
  const records = [rec('stale'), rec('reply', { by: 'someone', at: '10:00:00Z' }), rec('released', { version: '1.0.0', branch: 'upstream/ruvnet-ruflo-1' }), rec('fired', { branch: 'upstream/ruvnet-ruflo-1', session: 'https://claude.ai/code/session_9' })];
  const body = renderNotice({ records, mention: 'pacphi', date: '2026-10-02', recordedAt: '2026-10-02T14:17:00Z' });
  const lines = body.split('\n');
  assert.equal(lines[0], '@pacphi upstream watch: 2 items need you (2026-10-02).');
  assert.match(body, /someone commented on `ruvnet\/ruflo#1`/);
  assert.match(body, /ak dispatches it on branch `upstream\/ruvnet-ruflo-1`\. Routine session: https:\/\/claude\.ai\/code\/session_9/);
  assert.doesNotMatch(body, /has had no upstream activity/, 'stale records stay in the ledger');
  // The hint selects by when a record was written, so it finds every record of this run.
  assert.match(body, /\nThe full record: `node scripts\/upstream-watch\.mjs ledger --recorded-since 2026-10-02T14:17:00Z`\n$/);
});

test('one action uses singular wording and the latest fired session for an id', () => {
  const records = [
    rec('released', { version: '1.0.0', branch: 'upstream/ruvnet-ruflo-1' }),
    rec('fired', { branch: 'upstream/ruvnet-ruflo-1', session: 'https://claude.ai/code/session_old' }),
    rec('fired', { branch: 'upstream/ruvnet-ruflo-1', session: 'https://claude.ai/code/session_new' }),
  ];
  const body = renderNotice({ records, mention: 'pacphi', date: '2026-10-02', recordedAt: '2026-10-02T14:17:00Z' });
  assert.match(body, /^@pacphi upstream watch: 1 item needs you/);
  assert.match(body, /Routine session: https:\/\/claude\.ai\/code\/session_new/);
  assert.doesNotMatch(body, /session_old/);
});

test('thread ids never autolink; only a dispatch pull request number does', () => {
  const body = renderNotice({ records: [rec('reply', { by: 'x', at: '10:00:00Z' }, 'a/b#5'), rec('dispatch-pr', { branch: 'upstream/a-b-5', pr: 261 }, 'a/b#5')], mention: 'pacphi', date: '2026-10-02', recordedAt: '2026-10-02T14:17:00Z' });
  const prose = body.replace(/`[^`]*`/g, '');
  assert.deepEqual(prose.match(/#\d+/g), ['#261']);
  assert.doesNotMatch(prose, /[\w.-]+\/[\w.-]+#\d/);
});

test('a notice too long for GitHub lists what fits and says how many more', () => {
  const records = Array.from({ length: 3000 }, (_, index) => rec('reply', { by: 'someone-with-a-long-login', at: '10:00:00Z' }, `owner/repo#${index + 1}`));
  const body = renderNotice({ records, mention: 'pacphi', date: '2026-10-02', recordedAt: '2026-10-02T14:17:00Z' });
  assert.ok(body.length <= NOTICE_MAX, String(body.length));
  assert.match(body, /\n\d+ more; see the ledger\.\n/);
  assert.ok(body.includes('`owner/repo#1`') && !body.includes('`owner/repo#3000`'));
  const items = records.filter(isActionRecord);
  const bullets = items.map((item) => `- ${sentence(item)}`);
  const head = `@pacphi upstream watch: ${items.length} items need you (2026-10-02).`;
  const foot = 'The full record: `node scripts/upstream-watch.mjs ledger --recorded-since 2026-10-02T14:17:00Z`';
  let expected;
  for (let count = bullets.length; count > 0; count--) {
    const more = bullets.length - count;
    const candidate = `${[head, '', ...bullets.slice(0, count), ...(more ? ['', `${more} more; see the ledger.`] : []), '', foot].join('\n')}\n`;
    if (candidate.length <= NOTICE_MAX) { expected = candidate; break; }
  }
  assert.equal(body, expected, 'the optimized truncation keeps the exact previous body');
});

// A commit message is plain text: GitHub turns `owner/repo#n` or `#n` there into
// a timeline reference, code span or not, so commit sentences spell ids out.
test('commitSafe writes thread and pull request ids so a commit message references nothing', () => {
  assert.equal(commitSafe('The fix for `ruvnet/ruflo#3194` (pull request `#3421`) is released.'), 'The fix for `ruvnet/ruflo no. 3194` (pull request `no. 3421`) is released.');
  assert.equal(commitSafe('Draft pull request #261 for `proffesor-for-testing/agentic-qe#617` is ready.'), 'Draft pull request no. 261 for `proffesor-for-testing/agentic-qe no. 617` is ready.');
  assert.equal(commitSafe('owner.name/repo_x-1#12 and #7'), 'owner.name/repo_x-1 no. 12 and no. 7');
  assert.equal(commitSafe('Every upstream thread is retired; nothing is left to watch.'), 'Every upstream thread is retired; nothing is left to watch.');
  assert.equal(commitSafe('session https://claude.ai/code/session_1.'), 'session https://claude.ai/code/session_1.');
});
