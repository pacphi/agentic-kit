// The upstream watch's ledger branch (spec 2026-09-28): git plumbing only, no
// checkout, index or local branch changes. Fake exec for argument vectors and
// errors; a real bare repository for the round trip. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  LEDGER_FILE, LEDGER_README, createLedgerStore, parseRecords, runWithInput, serializeRecords, toRecord,
} from '../../scripts/upstream-watch/ledger-branch.mjs';
import { spawnEnv } from './helpers/home-sandbox.mjs';

const NOW = new Date('2026-09-29T14:20:00Z');
const record = (line, extra = {}) => ({ line, id: 'ruvnet/ruflo#1', event: 'stale', date: '2026-01-01', fields: {}, recordedAt: '2026-09-28T14:17:00Z', ...extra });

function fakeExec(answers) {
  const calls = [];
  const exec = async (command, args, options = {}) => {
    calls.push({ command, args, input: options.input ?? null });
    const answer = answers.shift();
    assert.ok(answer, `unexpected call: ${command} ${args.join(' ')}`);
    return { status: 0, stdout: '', stderr: '', error: null, ...answer };
  };
  return { exec, calls };
}

test('toRecord keeps the line and drops null fields', () => {
  const event = { line: 'UPSTREAM-WATCH a/b#1 released 2026-09-26 version=1.0.0', id: 'a/b#1', event: 'released', date: '2026-09-26', fields: { version: '1.0.0', pr: null, branch: undefined } };
  assert.deepEqual(toRecord(event, '2026-09-29T14:17:00Z'), { line: event.line, id: 'a/b#1', event: 'released', date: '2026-09-26', fields: { version: '1.0.0' }, recordedAt: '2026-09-29T14:17:00Z' });
});

test('records round-trip through ndjson and a malformed line names its number', () => {
  const records = [record('UPSTREAM-WATCH a 1'), record('UPSTREAM-WATCH a 2')];
  assert.deepEqual(parseRecords(serializeRecords(records)), records);
  assert.equal(serializeRecords([]), '');
  assert.throws(() => parseRecords(`${JSON.stringify(records[0])}\n{not json\n`), /events\.ndjson line 2 is not JSON/);
  assert.throws(() => parseRecords('{"id":"x"}\n'), /events\.ndjson line 1 has no ledger line/);
});

test('a record without its id, event, date, fields or UTC recordedAt is not a ledger record', () => {
  const good = record('UPSTREAM-WATCH a 1');
  const broken = [
    { ...good, id: undefined }, { ...good, event: 3 }, { ...good, date: null }, { ...good, fields: undefined },
    { ...good, fields: [] }, { ...good, fields: 'x=1' }, { ...good, recordedAt: undefined },
    { ...good, recordedAt: '2026-09-28' }, { ...good, recordedAt: '2026-09-28T14:17:00+02:00' }, { ...good, recordedAt: '2026-13-45T99:17:00Z' },
  ];
  for (const item of broken) {
    assert.throws(() => parseRecords(`${JSON.stringify(good)}\n${JSON.stringify(item)}\n`), /events\.ndjson line 2 is not a ledger record/, JSON.stringify(item));
  }
  assert.deepEqual(parseRecords(`${JSON.stringify(good)}\n`), [good]);
});

// ls-remote's exit code, not git's (translatable) message, says the branch is absent.
test('an absent ledger branch reads as an empty ledger without a fetch', async () => {
  const { exec, calls } = fakeExec([{ status: 2 }]);
  const ledger = await createLedgerStore({ exec, cwd: '/repo' }).read('upstream-watch-ledger', { now: NOW });
  assert.deepEqual(ledger, { commit: null, records: [], checkedAt: null });
  assert.deepEqual(calls.map((call) => call.args), [['ls-remote', '--exit-code', '--heads', 'origin', 'upstream-watch-ledger']]);
});

test('runWithInput reports a spawn failure without rejecting', async () => {
  const result = await runWithInput('ak-missing-command-for-test', []);
  assert.equal(result.status, null);
  assert.equal(result.error?.code, 'ENOENT');
});

test('read reports failures from rev-parse, show and log', async () => {
  for (const failedCommand of ['rev-parse', 'show', 'log']) {
    const sha = 'a'.repeat(40);
    const responses = [
      { stdout: `${sha}\trefs/heads/upstream-watch-ledger\n` }, {},
      { stdout: `${sha}\n` }, { stdout: '' }, { stdout: '' },
    ];
    const index = { 'rev-parse': 2, show: 3, log: 4 }[failedCommand];
    responses[index] = { status: 128, stderr: `${failedCommand} failed` };
    const { exec, calls } = fakeExec(responses);
    await assert.rejects(createLedgerStore({ exec }).read('upstream-watch-ledger', { now: NOW }), new RegExp(`git ${failedCommand} failed: ${failedCommand} failed`));
    assert.equal(calls.at(-1).args[0], failedCommand);
  }
});

test('read rejects an invalid branch before any git call', async () => {
  const { exec, calls } = fakeExec([]);
  await assert.rejects(createLedgerStore({ exec }).read('../ledger'), /not a branch name/);
  assert.equal(calls.length, 0);
});

test('a failed ls-remote or fetch throws', async () => {
  const lookup = fakeExec([{ status: 128, stderr: 'fatal: unable to access: HTTP 403\n' }]);
  await assert.rejects(createLedgerStore({ exec: lookup.exec }).read('upstream-watch-ledger', { now: NOW }), /git ls-remote origin upstream-watch-ledger failed: fatal: unable to access/);
  assert.equal(lookup.calls.length, 1);
  const { exec, calls } = fakeExec([{ status: 0, stdout: `${'a'.repeat(40)}\trefs/heads/upstream-watch-ledger\n` }, { status: 128, stderr: "fatal: couldn't find remote ref refs/heads/upstream-watch-ledger\n" }]);
  await assert.rejects(createLedgerStore({ exec }).read('upstream-watch-ledger', { now: NOW }), /git fetch origin upstream-watch-ledger failed: fatal: couldn't find remote ref/);
  assert.deepEqual(calls[1].args, ['fetch', '--no-tags', 'origin', '+refs/heads/upstream-watch-ledger:refs/remotes/origin/upstream-watch-ledger']);
});

test('read returns the tip, the records and a past Checked-At; a future Checked-At is absent', async () => {
  const sha = 'a'.repeat(40);
  const body = serializeRecords([record('UPSTREAM-WATCH a 1')]);
  const answers = (trailer) => [{ stdout: `${sha}\trefs/heads/upstream-watch-ledger\n` }, {}, { stdout: `${sha}\n` }, { stdout: body }, { stdout: `${trailer}\n` }];
  const past = fakeExec(answers('2026-09-28T14:17:00Z'));
  const ledger = await createLedgerStore({ exec: past.exec }).read('upstream-watch-ledger', { now: NOW });
  assert.deepEqual(ledger, { commit: sha, records: [record('UPSTREAM-WATCH a 1')], checkedAt: '2026-09-28T14:17:00Z' });
  assert.deepEqual(past.calls.map((call) => call.args[0]), ['ls-remote', 'fetch', 'rev-parse', 'show', 'log']);
  assert.deepEqual(past.calls[3].args, ['show', `${sha}:events.ndjson`]);
  const future = fakeExec(answers('2026-10-02T00:00:00Z'));
  assert.equal((await createLedgerStore({ exec: future.exec }).read('upstream-watch-ledger', { now: NOW })).checkedAt, null);
  const garbage = fakeExec(answers('yesterday'));
  assert.equal((await createLedgerStore({ exec: garbage.exec }).read('upstream-watch-ledger', { now: NOW })).checkedAt, null);
});

test('build writes blobs, a sorted tree and a commit with the Checked-At trailer, changing no ref', async () => {
  const [readme, events, tree, commit] = ['1', '2', '3', '4'].map((digit) => digit.repeat(40));
  const { exec, calls } = fakeExec([{ stdout: `${readme}\n` }, { stdout: `${events}\n` }, { stdout: `${tree}\n` }, { stdout: `${commit}\n` }]);
  const parent = 'f'.repeat(40);
  const records = [record('UPSTREAM-WATCH a 1')];
  const sha = await createLedgerStore({ exec }).build({ parent, records, checkedAt: '2026-09-29T14:17:00Z', subject: 'upstream-watch: 1 new record', sentences: ['One sentence.'] });
  assert.equal(sha, commit);
  assert.deepEqual(calls.map((call) => call.args), [
    ['hash-object', '-w', '--stdin'], ['hash-object', '-w', '--stdin'], ['mktree'], ['commit-tree', tree, '-p', parent, '-F', '-'],
  ]);
  assert.equal(calls[0].input, LEDGER_README);
  assert.equal(calls[1].input, serializeRecords(records));
  assert.equal(calls[2].input, `100644 blob ${readme}\tREADME.md\n100644 blob ${events}\t${LEDGER_FILE}\n`);
  assert.equal(calls[3].input, 'upstream-watch: 1 new record\n\nOne sentence.\n\nChecked-At: 2026-09-29T14:17:00Z\n');
  assert.ok(calls.every((call) => call.command === 'git' && !['update-ref', 'push', 'checkout', 'branch'].includes(call.args[0])));
});

test('build refuses a bad parent or time before running git', async () => {
  const { exec, calls } = fakeExec([]);
  const store = createLedgerStore({ exec });
  await assert.rejects(store.build({ parent: 'HEAD', records: [], checkedAt: '2026-09-29T14:17:00Z', subject: 's' }), /not a commit: HEAD/);
  await assert.rejects(store.build({ parent: null, records: [], checkedAt: '2026-09-29', subject: 's' }), /not a UTC time/);
  assert.equal(calls.length, 0);
});

// Regression for a CI-only failure (ubuntu-latest, node 26): a child that
// exits before draining a large stdin payload closes the pipe's read end
// mid-write. Without an error listener on child.stdin, the resulting EPIPE
// is an unhandled stream error — an uncaughtException that can surface async,
// after whichever test happens to be running at that moment already ended.
// A payload past the OS pipe buffer (~64KB) forces the write to block on
// drain long enough for the child's exit to land mid-write, every run.
test('runWithInput resolves cleanly when the child exits before consuming a large stdin payload', async () => {
  const bigInput = 'x'.repeat(2 * 1024 * 1024);
  const result = await runWithInput(process.execPath, ['-e', 'process.exit(0)'], { input: bigInput });
  assert.equal(result.error, null);
  assert.equal(typeof result.status, 'number');
});

test('round trip through a real bare repository: absent, first commit, second commit', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-ledger-branch-'));
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  // git runs with a throwaway home, so the developer's global config (for
  // example commit.gpgSign, which commit-tree honors) is never read.
  const env = spawnEnv(home, {
    GIT_CONFIG_NOSYSTEM: '1',
    ...(process.platform === 'win32' ? {} : { GIT_CONFIG_GLOBAL: os.devNull }),
  });
  const git = (cwd, ...args) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8', env });
    assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
  };
  try {
    const origin = path.join(root, 'origin.git');
    const work = path.join(root, 'work');
    git(root, 'init', '-q', '--bare', origin);
    git(root, 'init', '-q', work);
    git(work, 'config', 'user.name', 'test');
    git(work, 'config', 'user.email', 'test@example.invalid');
    git(work, 'remote', 'add', 'origin', origin);
    const store = createLedgerStore({
      cwd: work,
      exec: (command, args, options) => runWithInput(command, args, { ...options, env }),
    });
    assert.deepEqual(await store.read('upstream-watch-ledger', { now: NOW }), { commit: null, records: [], checkedAt: null });
    const first = await store.build({ parent: null, records: [record('UPSTREAM-WATCH a 1')], checkedAt: '2026-09-28T14:17:00Z', subject: 'upstream-watch: 1 new record', sentences: ['First.'] });
    git(work, 'push', '-q', 'origin', `${first}:refs/heads/upstream-watch-ledger`);
    const read1 = await store.read('upstream-watch-ledger', { now: NOW });
    assert.deepEqual([read1.commit, read1.records.length, read1.checkedAt], [first, 1, '2026-09-28T14:17:00Z']);
    assert.equal(git(work, 'show', `${first}:README.md`), LEDGER_README.trim());
    const second = await store.build({ parent: first, records: [...read1.records, record('UPSTREAM-WATCH a 2')], checkedAt: '2026-09-29T14:17:00Z', subject: 'upstream-watch: 1 new record' });
    git(work, 'push', '-q', 'origin', `${second}:refs/heads/upstream-watch-ledger`);
    const read2 = await store.read('upstream-watch-ledger', { now: NOW });
    assert.deepEqual(read2.records.map((item) => item.line), ['UPSTREAM-WATCH a 1', 'UPSTREAM-WATCH a 2']);
    assert.equal(git(work, 'rev-list', '--count', second), '2');
    assert.equal(git(work, 'branch', '--list'), '', 'no local branch was created');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
