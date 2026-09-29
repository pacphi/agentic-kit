// `record` (spec 2026-09-28): the ledger branch, the window, dedup, dispatch,
// one local commit and the notice. No network, no git.
import test from 'node:test';
import assert from 'node:assert/strict';

import { PermanentFetchError, retrying } from '../../scripts/upstream-watch/fetch.mjs';
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

test('retrying handles transient failures within the budget, but never retries auth or deterministic failures', async () => {
  let calls = 0;
  const waits = [];
  const fetcher = retrying({ auth: async () => { throw new Error('auth is not retried'); }, thread: async () => { calls += 1; if (calls < 3) throw new Error('HTTP 502'); return 'ok'; } }, { sleep: async (ms) => { waits.push(ms); } });
  assert.equal(await fetcher.thread('a/b#1'), 'ok');
  assert.deepEqual(waits, [2000, 10000]);
  await assert.rejects(fetcher.auth(), /auth is not retried/);
  let exhausted = 0;
  const always = retrying({ thread: async () => { exhausted++; throw new Error('HTTP 502'); } }, { delays: [1, 2], sleep: async (ms) => { waits.push(ms); } });
  await assert.rejects(always.thread('a/b#1'), /HTTP 502/);
  assert.equal(exhausted, 3);
  assert.deepEqual(waits, [2000, 10000, 1, 2]);
  let deterministic = 0;
  const invalid = retrying({ thread: async () => { deterministic++; throw new PermanentFetchError('no fixture'); } }, { sleep: async () => { assert.fail('deterministic failure slept'); } });
  await assert.rejects(invalid.thread('a/b#1'), /no fixture/);
  assert.equal(deterministic, 1);
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
    assert.match(result.notice.body, /\nThe full record: `node scripts\/upstream-watch\.mjs ledger --recorded-since 2026-09-26T23:00:00Z`\n$/);
    assert.deepEqual(result.dispatchErrors, []);
    assert.deepEqual(result.wouldFire, [], 'a real run lists nothing it would fire');
    assert.deepEqual(result.deferred, [], 'nothing deferred within the per-run cap');
  });
});

test('ledger commit sentences reference no issue or pull request; the notice keeps its ids', async () => {
  const release = { channel: 'npm', name: 'agentic-qe', minVersion: '3.13.10' };
  await withRegistryFile([entry('proffesor-for-testing/agentic-qe#617', { doneWhen: { state: 'closed-completed', release } }), entry('ruvnet/ruflo#3153', { relation: 'commented' })], async (file) => {
    const { result, ledgerStore } = await record(file, ['--since', '2026-09-03T00:00:00Z']);
    const { sentences } = ledgerStore.built[0];
    assert.ok(sentences.length >= 2 && sentences.some((text) => text.includes('proffesor-for-testing/agentic-qe no. 617')), sentences.join('\n'));
    for (const text of sentences) assert.doesNotMatch(text, /#\d/, text);
    assert.match(result.notice.body, /`proffesor-for-testing\/agentic-qe#617`/);
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

test('dry run fires nothing and builds nothing, and lists what would fire', async () => {
  const release = { channel: 'npm', name: 'agentic-qe', minVersion: '3.13.10' };
  await withRegistryFile([entry('proffesor-for-testing/agentic-qe#617', { doneWhen: { state: 'closed-completed', release } })], async (file) => {
    const { result, ledgerStore, dispatcher } = await record(file, ['--dry-run']);
    assert.deepEqual([dispatcher.fired, ledgerStore.built, result.commit], [[], [], null]);
    assert.ok(result.records.some((item) => item.event === 'released'));
    assert.ok(!result.records.some((item) => item.event === 'fired'));
    assert.deepEqual(result.wouldFire, [{ id: 'proffesor-for-testing/agentic-qe#617', version: '3.13.10', branch: 'upstream/proffesor-for-testing-agentic-qe-617' }]);
    const out = capture();
    await main(['record', '--dry-run', '--registry', file], { fetcher: fixtureFetcher(), ledgerStore: memoryLedger(), dispatcher: fakeDispatcher(), sleep: noSleep, stdout: out.stream, stderr: capture().stream, now: NOW });
    assert.match(out.text(), /\nWould fire proffesor-for-testing\/agentic-qe#617 3\.13\.10 upstream\/proffesor-for-testing-agentic-qe-617\n$/);
  });
});

test('a ledger commit that cannot be built after a firing keeps the session links', async () => {
  const release = { channel: 'npm', name: 'agentic-qe', minVersion: '3.13.10' };
  await withRegistryFile([entry('proffesor-for-testing/agentic-qe#617', { doneWhen: { state: 'closed-completed', release } })], async (file) => {
    const failing = { read: async () => ({ commit: null, records: [], checkedAt: null }), build: async () => { throw new Error('git hash-object failed: disk full'); } };
    const { code, result, err, dispatcher } = await record(file, [], { ledgerStore: failing });
    assert.equal(code, 3);
    assert.equal(dispatcher.fired.length, 1);
    assert.match(result.error, /Could not build the ledger commit: git hash-object failed: disk full/);
    assert.deepEqual(result.fired.map((item) => [item.event, item.fields.session]), [['fired', 'https://claude.ai/code/session_new']]);
    assert.deepEqual(result.wouldFire, []);
    assert.match(err, /Fired proffesor-for-testing\/agentic-qe#617 before the ledger commit failed: session https:\/\/claude\.ai\/code\/session_new/);
  });
});

test('record is blind (exit 3) when gh, the ledger, the registry or every upstream thread fails', async () => {
  await withRegistryFile([entry('ruvnet/ruflo#3153', { relation: 'commented' })], async (file) => {
    const offline = await record(file, [], { fetcher: fixtureFetcher({ authenticated: false }) });
    assert.deepEqual([offline.code, offline.result.blind, offline.ledgerStore.built, offline.result.wouldFire, offline.result.deferred, offline.result.fired], [3, true, [], [], [], []]);
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
    assert.equal(invalid.err.match(/upstream registry is/g)?.length, 1);
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

test('invalid registry takes precedence over a future --since', async () => {
  await withRegistryFile([entry('ruvnet/ruflo#3153', { status: 'done' })], async (file) => {
    const { code, result, err } = await record(file, ['--since', '2026-10-01T00:00:00Z']);
    assert.equal(code, 3);
    assert.equal(result.blind, true);
    assert.match(err, /upstream registry is invalid/);
    assert.doesNotMatch(err, /--since is in the future/);
  });
});

// Reuse the recorded release fact for distinct synthetic issue ids; all I/O is injected.
const backlog = () => [1, 2, 3, 4, 5].map((n) => entry(`proffesor-for-testing/agentic-qe#${n}`, { doneWhen: { state: 'closed-completed', release: { channel: 'npm', name: 'agentic-qe', minVersion: '3.13.10' } } }));
const backlogFetcher = () => {
  const fetcher = fixtureFetcher();
  return { ...fetcher, thread: async () => fetcher.thread('proffesor-for-testing/agentic-qe#617') };
};

test('advanced Checked-At preserves deferred releases for a later run', async () => {
  await withRegistryFile(backlog(), async (file) => {
    const first = await record(file, [], { fetcher: backlogFetcher() });
    assert.equal(first.code, 0);
    assert.equal(first.dispatcher.fired.length, 3);
    assert.deepEqual(first.result.deferred.map((item) => item.id), ['proffesor-for-testing/agentic-qe#4', 'proffesor-for-testing/agentic-qe#5']);
    const second = await record(file, [], { fetcher: backlogFetcher(), ledgerStore: memoryLedger({ commit: first.result.commit, records: first.result.records, checkedAt: first.result.checkedAt }), now: new Date('2026-09-27T23:00:00Z') });
    assert.equal(second.result.since, '2026-09-26T23:00:00Z');
    assert.equal(second.dispatcher.fired.length, 2);
    assert.deepEqual(second.result.records.map((item) => [item.id, item.event]), [['proffesor-for-testing/agentic-qe#4', 'fired'], ['proffesor-for-testing/agentic-qe#5', 'fired']]);
    assert.deepEqual(second.result.deferred, []);
  });
});

test('ledger build failure retains successful firings, dispatch errors and the deferred backlog', async () => {
  await withRegistryFile(backlog(), async (file) => {
    const dispatcher = fakeDispatcher();
    const fire = dispatcher.fire;
    dispatcher.fire = async (text) => { if (dispatcher.fired.length === 1) throw new Error('HTTP 503'); return fire(text); };
    const ledgerStore = { read: async () => ({ commit: null, records: [], checkedAt: null }), build: async () => { throw new Error('disk full'); } };
    const { code, result } = await record(file, [], { fetcher: backlogFetcher(), dispatcher, ledgerStore });
    assert.equal(code, 3);
    assert.equal(result.blind, true);
    assert.equal(result.fired.length, 1);
    assert.equal(result.fired[0].fields.session, 'https://claude.ai/code/session_new');
    assert.deepEqual(result.dispatchErrors, [{ id: 'proffesor-for-testing/agentic-qe#2', error: 'HTTP 503' }]);
    assert.deepEqual(result.deferred.map((item) => item.id), ['proffesor-for-testing/agentic-qe#3', 'proffesor-for-testing/agentic-qe#4', 'proffesor-for-testing/agentic-qe#5']);
  });
});

test('record dry run reports its bounded preview and deferred backlog in JSON and console', async () => {
  await withRegistryFile(backlog(), async (file) => {
    const preview = await record(file, ['--dry-run'], { fetcher: backlogFetcher() });
    assert.equal(preview.result.wouldFire.length, 3);
    assert.equal(preview.result.deferred.length, 2);
    assert.deepEqual(preview.dispatcher.fired, []);
    assert.deepEqual(preview.ledgerStore.built, []);
    const out = capture();
    const code = await main(['record', '--dry-run', '--registry', file], { fetcher: backlogFetcher(), ledgerStore: memoryLedger(), dispatcher: fakeDispatcher(), sleep: async () => { assert.fail('preview slept'); }, stdout: out.stream, stderr: capture().stream, now: NOW });
    assert.equal(code, 0);
    assert.equal(out.text().match(/^Would fire /gm)?.length, 3);
    assert.equal(out.text().match(/^Deferred /gm)?.length, 2);
  });
});
