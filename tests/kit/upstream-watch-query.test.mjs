// `ledger` queries the recorded ledger; `report` shows when the watch last
// succeeded (spec 2026-09-28). In-memory ledger and fixture fetcher only.
import test from 'node:test';
import assert from 'node:assert/strict';

import { createFetcher } from '../../scripts/upstream-watch/fetch.mjs';
import { main } from '../../scripts/upstream-watch.mjs';
import { NOW, capture, entry, fixtureFetcher, withRegistryFile } from './upstream-watch-fixtures.mjs';

const rec = (id, event, date) => ({ line: `UPSTREAM-WATCH ${id} ${event} ${date}`, id, event, date, fields: {}, recordedAt: `${date}T14:17:00Z` });
const RECORDS = [rec('a/b#1', 'reply', '2026-09-20'), rec('a/b#1', 'closed', '2026-09-24'), rec('c/d#2', 'reply', '2026-09-25')];
const store = { read: async () => ({ commit: 'c'.repeat(40), records: RECORDS, checkedAt: '2026-09-25T14:17:00Z' }), build: async () => { throw new Error('not called'); } };
const watch = () => [entry('ruvnet/ruflo#3153', { relation: 'commented' })];

const query = async (file, argv, ledgerStore = store) => {
  const out = capture();
  const err = capture();
  const code = await main(['ledger', '--registry', file, ...argv], { ledgerStore, stdout: out.stream, stderr: err.stream, now: NOW });
  return { code, out: out.text(), err: err.text() };
};

test('ledger filters by id, event and date, as lines or JSON', async () => {
  await withRegistryFile(watch(), async (file) => {
    assert.equal((await query(file, [])).out, `${RECORDS.map((item) => item.line).join('\n')}\n`);
    assert.equal((await query(file, ['--id', 'a/b#1', '--event', 'reply'])).out, `${RECORDS[0].line}\n`);
    assert.equal((await query(file, ['--since', '2026-09-24'])).out, `${RECORDS[1].line}\n${RECORDS[2].line}\n`);
    const json = JSON.parse((await query(file, ['--event', 'reply', '--json'])).out);
    assert.deepEqual([json.commit, json.checkedAt, json.records.length], ['c'.repeat(40), '2026-09-25T14:17:00Z', 2]);
    assert.equal((await query(file, ['--id', 'x/y#9'])).out, 'No matching records.\n');
    assert.equal((await query(file, ['--event', 'nonsense'])).code, 2);
    const broken = { read: async () => { throw new Error('HTTP 403'); } };
    const failed = await query(file, [], broken);
    assert.equal(failed.code, 3);
    assert.match(failed.err, /Could not read the ledger branch upstream-watch-ledger: HTTP 403/);
  });
});

const at = (id, event, date, recordedAt) => ({ ...rec(id, event, date), recordedAt });
const WRITTEN = [at('a/b#1', 'reply', '2026-09-20', '2026-09-25T14:17:00Z'), at('a/b#1', 'stale', '2026-09-24', '2026-09-24T14:17:00Z'), at('c/d#2', 'released', '2026-09-25', '2026-09-25T14:17:00Z')];
const written = { read: async () => ({ commit: 'c'.repeat(40), records: WRITTEN, checkedAt: '2026-09-25T14:17:00Z' }), build: async () => { throw new Error('not called'); } };

test('ledger --recorded-since filters on when a record was written; --since on its date', async () => {
  await withRegistryFile(watch(), async (file) => {
    assert.equal((await query(file, ['--recorded-since', '2026-09-25T14:17:00Z'], written)).out, `${WRITTEN[0].line}\n${WRITTEN[2].line}\n`);
    assert.equal((await query(file, ['--recorded-since', '2026-09-25T16:17:00+02:00'], written)).out, `${WRITTEN[0].line}\n${WRITTEN[2].line}\n`, 'compared as times');
    assert.equal((await query(file, ['--recorded-since', '2026-09-25T14:17:01Z'], written)).out, 'No matching records.\n');
    assert.equal((await query(file, ['--since', '2026-09-24'], written)).out, `${WRITTEN[1].line}\n${WRITTEN[2].line}\n`);
    assert.equal((await query(file, ['--recorded-since', '2026-09-24', '--event', 'stale'], written)).out, `${WRITTEN[1].line}\n`);
    const bad = await query(file, ['--recorded-since', 'yesterday'], written);
    assert.equal(bad.code, 2);
    assert.match(bad.err, /--recorded-since must be an ISO date or date-time/);
  });
});

test('--recorded-since belongs to ledger only', async () => {
  await withRegistryFile(watch(), async (file) => {
    const err = capture();
    assert.equal(await main(['check', '--since', '2026-09-24', '--recorded-since', '2026-09-24', '--registry', file], { fetcher: fixtureFetcher(), stdout: capture().stream, stderr: err.stream, now: NOW }), 2);
    assert.match(err.text(), /unknown option --recorded-since/);
  });
});

test('ledger fails visibly on an invalid registry without reading the ledger', async () => {
  await withRegistryFile([entry('ruvnet/ruflo#3153', { status: 'done' })], async (file) => {
    let reads = 0;
    const result = await query(file, [], { read: async () => { reads++; throw new Error('unexpected read'); } });
    assert.equal(result.code, 3);
    assert.equal(reads, 0);
    assert.match(result.err, /upstream registry is invalid/);
    assert.doesNotMatch(result.out, /No report/);
  });
});

test('the fetcher reads the last successful scheduled watch run from the Actions API', async () => {
  const calls = [];
  const exec = async (command, args) => {
    calls.push([command, ...args]);
    return { status: 0, stdout: JSON.stringify({ workflow_runs: [{ run_started_at: '2026-10-01T14:21:00Z', html_url: 'https://github.com/pacphi/agentic-kit/actions/runs/1' }] }), stderr: '' };
  };
  assert.deepEqual(await createFetcher({ exec }).lastRun('pacphi/agentic-kit'), { at: '2026-10-01T14:21:00Z', url: 'https://github.com/pacphi/agentic-kit/actions/runs/1' });
  // Scheduled runs only: pull request previews and manual dry runs also succeed.
  assert.deepEqual(calls[0], ['gh', 'api', 'repos/pacphi/agentic-kit/actions/workflows/upstream-watch.yml/runs?status=success&event=schedule&per_page=1']);
  const none = async () => ({ status: 0, stdout: '{"workflow_runs":[]}', stderr: '' });
  assert.equal(await createFetcher({ exec: none }).lastRun('pacphi/agentic-kit'), null);
});

test('report shows the last successful scheduled run and warns after 48 hours, when unknown or when there is none', async () => {
  await withRegistryFile(watch(), async (file) => {
    const run = async (lastRun) => {
      const fetcher = { ...fixtureFetcher(), lastRun };
      const json = capture();
      await main(['report', '--json', '--registry', file], { fetcher, stdout: json.stream, stderr: capture().stream, now: NOW });
      const text = capture();
      await main(['report', '--registry', file], { fetcher, stdout: text.stream, stderr: capture().stream, now: NOW });
      return { report: JSON.parse(json.text()), text: text.text() };
    };
    const fresh = await run(async () => ({ at: '2026-09-26T01:18:00Z', url: 'u' }));
    assert.deepEqual(fresh.report.lastRun, { at: '2026-09-26T01:18:00Z', ageHours: 21.7, url: 'u' });
    assert.match(fresh.text, /last successful scheduled watch run 2026-09-26T01:18:00Z \(21\.7 hours ago\)/);
    assert.doesNotMatch(fresh.text, /warning/);
    const stale = await run(async () => ({ at: '2026-09-24T14:21:00Z', url: 'u' }));
    assert.match(stale.text, /warning: the watch has not succeeded for more than 48 hours/);
    const unknown = await run(async () => { throw new Error('HTTP 403'); });
    assert.deepEqual(unknown.report.lastRun, { error: 'HTTP 403' });
    assert.match(unknown.text, /warning: the last successful scheduled watch run could not be read \(HTTP 403\)/);
    const none = await run(async () => null);
    assert.equal(none.report.lastRun, null);
    assert.match(none.text, /\n {2}warning: no successful scheduled watch run found\n/);
  });
});
