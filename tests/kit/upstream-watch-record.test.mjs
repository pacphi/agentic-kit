// `record` (spec 2026-09-28): the ledger branch, the window, dedup, dispatch,
// one local commit and the notice. No network, no git.
import test from 'node:test';
import assert from 'node:assert/strict';

import { retrying } from '../../scripts/upstream-watch/fetch.mjs';
import { isActionRecord } from '../../scripts/upstream-watch/ledger.mjs';
import { main } from '../../scripts/upstream-watch.mjs';
import {
  NOW, capture, entry, fakeDispatcher, fixtureFetcher, memoryLedger, noSleep, withRegistryFile,
} from './upstream-watch-fixtures.mjs';

async function record(file, argv, { fetcher = fixtureFetcher(), ledgerStore = memoryLedger(), dispatcher = fakeDispatcher(), now = NOW } = {}) {
  const out = capture();
  const err = capture();
  const code = await main(['record', '--json', '--registry', file, ...argv], { fetcher, ledgerStore, dispatcher, sleep: noSleep, stdout: out.stream, stderr: err.stream, now });
  return { code, result: out.text() ? JSON.parse(out.text()) : null, err: err.text(), ledgerStore, dispatcher };
}

test('retrying retries every method but auth, then gives up', async () => {
  let calls = 0;
  const waits = [];
  const fetcher = retrying({ auth: async () => { throw new Error('auth is not retried'); }, thread: async () => { calls += 1; if (calls < 3) throw new Error('HTTP 502'); return 'ok'; } }, { sleep: async (ms) => { waits.push(ms); } });
  assert.equal(await fetcher.thread('a/b#1'), 'ok');
  assert.deepEqual(waits, [2000, 10000]);
  await assert.rejects(fetcher.auth(), /auth is not retried/);
  const always = retrying({ thread: async () => { throw new Error('HTTP 404'); } }, { sleep: noSleep });
  await assert.rejects(always.thread('a/b#1'), /HTTP 404/);
});

test('record on an absent ledger starts from --since, commits every record and prints the notice', async () => {
  await withRegistryFile([entry('ruvnet/ruflo#3153', { relation: 'commented' })], async (file) => {
    const { code, result, ledgerStore } = await record(file, ['--since', '2026-09-03T00:00:00Z']);
    assert.equal(code, 0);
    assert.deepEqual([result.since, result.sinceSource, result.checkedAt, result.blind], ['2026-09-03T00:00:00Z', 'flag', '2026-09-26T23:00:00Z', false]);
    assert.ok(result.records.length >= 1 && result.records.every((item) => item.line.startsWith('UPSTREAM-WATCH ') && item.recordedAt === '2026-09-26T23:00:00Z'));
    assert.equal(ledgerStore.built.length, 1);
    assert.equal(ledgerStore.built[0].parent, null);
    assert.equal(ledgerStore.built[0].checkedAt, '2026-09-26T23:00:00Z');
    assert.equal(ledgerStore.built[0].records.length, result.records.length);
    assert.match(ledgerStore.built[0].subject, /^upstream-watch: \d+ new records?$/);
    assert.equal(result.commit, 'c'.repeat(40));
    assert.equal(result.notice.post, result.records.some(isActionRecord));
    if (result.notice.post) assert.match(result.notice.body, /^@pacphi upstream watch: /);
  });
});

test('record run twice the same day records nothing new, notifies nothing and fires nothing', async () => {
  const release = { channel: 'npm', name: 'agentic-qe', minVersion: '3.13.10' };
  await withRegistryFile([entry('proffesor-for-testing/agentic-qe#617', { doneWhen: { state: 'closed-completed', release } })], async (file) => {
    const first = await record(file, []);
    assert.equal(first.dispatcher.fired.length, 1);
    assert.ok(first.result.records.some((item) => item.event === 'fired'));
    const second = await record(file, [], { ledgerStore: memoryLedger({ commit: 'c'.repeat(40), records: first.result.records, checkedAt: first.result.checkedAt }), now: new Date('2026-09-26T23:30:00Z') });
    assert.deepEqual([second.result.records, second.result.commit, second.result.notice.post], [[], null, false]);
    assert.equal(second.dispatcher.fired.length, 0, 'fired within three days');
    assert.equal(second.result.sinceSource, 'ledger');
  });
});

test('a released fix fires the routine with its id, version and branch, and the notice links the session', async () => {
  const release = { channel: 'npm', name: 'agentic-qe', minVersion: '3.13.10' };
  await withRegistryFile([entry('proffesor-for-testing/agentic-qe#617', { doneWhen: { state: 'closed-completed', release } })], async (file) => {
    const { result, dispatcher } = await record(file, []);
    assert.deepEqual(dispatcher.fired, ['proffesor-for-testing/agentic-qe#617 3.13.10 upstream/proffesor-for-testing-agentic-qe-617']);
    assert.match(result.notice.body, /^@pacphi upstream watch: /);
    assert.match(result.notice.body, /Routine session: https:\/\/claude\.ai\/code\/session_new/);
    assert.deepEqual(result.dispatchErrors, []);
  });
});

test('missing token keeps the records: the dispatch error is reported, the commit still built', async () => {
  const release = { channel: 'npm', name: 'agentic-qe', minVersion: '3.13.10' };
  await withRegistryFile([entry('proffesor-for-testing/agentic-qe#617', { doneWhen: { state: 'closed-completed', release } })], async (file) => {
    const { code, result, ledgerStore, err } = await record(file, [], { dispatcher: fakeDispatcher({ fireError: 'UPSTREAM_DISPATCH_TOKEN is not set' }) });
    assert.equal(code, 0);
    assert.deepEqual(result.dispatchErrors, [{ id: 'proffesor-for-testing/agentic-qe#617', error: 'UPSTREAM_DISPATCH_TOKEN is not set' }]);
    assert.ok(result.records.some((item) => item.event === 'released'));
    assert.ok(!result.records.some((item) => item.event === 'fired'));
    assert.equal(ledgerStore.built.length, 1);
    assert.match(err, /Dispatch proffesor-for-testing\/agentic-qe#617: UPSTREAM_DISPATCH_TOKEN is not set/);
  });
});

test('partial failure holds the window: what was read is recorded, Checked-At stays', async () => {
  await withRegistryFile([entry('ruvnet/ruflo#3153', { relation: 'commented' }), entry('stuinfla/ruvnet-brain#331', { dependency: 'ruvnet-brain' })], async (file) => {
    const ledgerStore = memoryLedger({ commit: 'a'.repeat(40), records: [], checkedAt: '2026-09-03T00:00:00Z' });
    const { result } = await record(file, [], { fetcher: fixtureFetcher({ failing: new Set(['stuinfla/ruvnet-brain#331']) }), ledgerStore });
    assert.deepEqual(result.fetchErrors.map((item) => item.id), ['stuinfla/ruvnet-brain#331']);
    assert.equal(result.checkedAt, '2026-09-03T00:00:00Z');
    assert.equal(ledgerStore.built[0].checkedAt, '2026-09-03T00:00:00Z');
    assert.equal(ledgerStore.built[0].parent, 'a'.repeat(40));
    assert.ok(result.records.every((item) => item.id !== 'stuinfla/ruvnet-brain#331'));
  });
});

test('a read that fails once is retried and counts as read', async () => {
  await withRegistryFile([entry('ruvnet/ruflo#3153', { relation: 'commented' })], async (file) => {
    const { result } = await record(file, ['--since', '2026-09-03T00:00:00Z'], { fetcher: fixtureFetcher({ flaky: new Map([['ruvnet/ruflo#3153', 1]]) }) });
    assert.deepEqual(result.fetchErrors, []);
    assert.equal(result.checkedAt, '2026-09-26T23:00:00Z');
  });
});

test('dry run fires nothing and builds nothing', async () => {
  const release = { channel: 'npm', name: 'agentic-qe', minVersion: '3.13.10' };
  await withRegistryFile([entry('proffesor-for-testing/agentic-qe#617', { doneWhen: { state: 'closed-completed', release } })], async (file) => {
    const { result, ledgerStore, dispatcher } = await record(file, ['--dry-run']);
    assert.deepEqual([dispatcher.fired, ledgerStore.built, result.commit], [[], [], null]);
    assert.ok(result.records.some((item) => item.event === 'released'));
  });
});

test('record is blind (exit 3) when gh, the ledger, the registry or every upstream thread fails', async () => {
  await withRegistryFile([entry('ruvnet/ruflo#3153', { relation: 'commented' })], async (file) => {
    const offline = await record(file, [], { fetcher: fixtureFetcher({ authenticated: false }) });
    assert.deepEqual([offline.code, offline.result.blind, offline.ledgerStore.built], [3, true, []]);
    const broken = { read: async () => { throw new Error('events.ndjson line 2 is not JSON'); }, build: async () => { throw new Error('not called'); } };
    const unreadable = await record(file, [], { ledgerStore: broken });
    assert.equal(unreadable.code, 3);
    assert.match(unreadable.result.error, /Could not read the ledger branch upstream-watch-ledger: events\.ndjson line 2 is not JSON/);
    const allFailing = await record(file, [], { fetcher: fixtureFetcher({ failing: new Set(['ruvnet/ruflo#3153']) }) });
    assert.deepEqual([allFailing.code, allFailing.result.blind, allFailing.ledgerStore.built], [3, true, []]);
  });
  await withRegistryFile([entry('ruvnet/ruflo#3153', { status: 'done' })], async (file) => {
    const invalid = await record(file, []);
    assert.equal(invalid.code, 3);
    assert.deepEqual([invalid.result.blind, invalid.result.records, invalid.result.commit], [true, [], null]);
    assert.match(invalid.result.error, /registry/);
  });
});

test('a run that reads only the home repository is blind', async () => {
  const own = entry('pacphi/agentic-kit#240', { relation: 'tracking', dependency: null, tracks: ['ruvnet/ruflo#3153'], doneWhen: { state: 'closed-completed', release: null } });
  const scoped = { ...fixtureFetcher(), thread: async (id) => {
    if (id.startsWith('pacphi/agentic-kit#')) return { issue: { number: 240, state: 'open', title: 't', user: { login: 'pacphi' }, created_at: '2026-09-20T00:00:00Z', updated_at: '2026-09-20T00:00:00Z', comments: 0 }, comments: [] };
    throw new Error('HTTP 403');
  } };
  await withRegistryFile([own, entry('ruvnet/ruflo#3153', { relation: 'commented' })], async (file) => {
    const { code, result } = await record(file, [], { fetcher: scoped });
    assert.deepEqual([code, result.blind], [3, true]);
  });
});

test('future --since is a usage error', async () => {
  await withRegistryFile([entry('ruvnet/ruflo#3153', { relation: 'commented' })], async (file) => {
    const { code, err } = await record(file, ['--since', '2026-10-01T00:00:00Z']);
    assert.equal(code, 2);
    assert.match(err, /--since is in the future/);
  });
});
