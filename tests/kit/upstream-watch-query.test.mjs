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

test('the fetcher reads the last successful watch run from the Actions API', async () => {
  const calls = [];
  const exec = async (command, args) => {
    calls.push([command, ...args]);
    return { status: 0, stdout: JSON.stringify({ workflow_runs: [{ run_started_at: '2026-10-01T14:21:00Z', html_url: 'https://github.com/pacphi/agentic-kit/actions/runs/1' }] }), stderr: '' };
  };
  assert.deepEqual(await createFetcher({ exec }).lastRun('pacphi/agentic-kit'), { at: '2026-10-01T14:21:00Z', url: 'https://github.com/pacphi/agentic-kit/actions/runs/1' });
  assert.deepEqual(calls[0], ['gh', 'api', 'repos/pacphi/agentic-kit/actions/workflows/upstream-watch.yml/runs?status=success&per_page=1']);
  const none = async () => ({ status: 0, stdout: '{"workflow_runs":[]}', stderr: '' });
  assert.equal(await createFetcher({ exec: none }).lastRun('pacphi/agentic-kit'), null);
});

test('report shows the last successful run and warns after 48 hours or when unknown', async () => {
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
    assert.match(fresh.text, /last successful watch run 2026-09-26T01:18:00Z \(21\.7 hours ago\)/);
    assert.doesNotMatch(fresh.text, /warning/);
    const stale = await run(async () => ({ at: '2026-09-24T14:21:00Z', url: 'u' }));
    assert.match(stale.text, /warning: the watch has not succeeded for more than 48 hours/);
    const unknown = await run(async () => { throw new Error('HTTP 403'); });
    assert.deepEqual(unknown.report.lastRun, { error: 'HTTP 403' });
    assert.match(unknown.text, /warning: the last successful watch run could not be read \(HTTP 403\)/);
  });
});
