// Dispatch of released upstream fixes (spec 2026-09-28): which threads fire
// the routine, the trigger call, the firing limits and the draft pull request
// it opened. Fake exec and fetch only; no network.
import test from 'node:test';
import assert from 'node:assert/strict';

import { eventLine } from '../../scripts/upstream-watch/classify.mjs';
import { FIRE_HEADERS, FIRE_URL, PR_OBSERVE_DAYS, SAME_REPO_PR, createDispatcher, dispatch } from '../../scripts/upstream-watch/dispatch.mjs';

const NOW = new Date('2026-10-02T14:17:00Z');
const RECORDED_AT = '2026-10-02T14:17:00Z';
const ID = 'proffesor-for-testing/agentic-qe#617';
const BRANCH = 'upstream/proffesor-for-testing-agentic-qe-617';
const released = eventLine('UPSTREAM-WATCH', ID, 'released', '2026-08-06', { version: '3.13.10', branch: BRANCH });
const fired = (recordedAt, session = 'https://claude.ai/code/session_1') => ({
  line: `UPSTREAM-WATCH ${ID} fired ${recordedAt.slice(0, 10)} branch=${BRANCH} session=${session}`,
  id: ID, event: 'fired', date: recordedAt.slice(0, 10), fields: { branch: BRANCH, session }, recordedAt,
});

function fakeDispatcher({ exists = false, pr = null, session = 'https://claude.ai/code/session_new', fireError = null } = {}) {
  const calls = { fire: [], exists: [], pr: [] };
  return {
    calls,
    branchExists: async (branch) => { calls.exists.push(branch); return exists; },
    openPullRequest: async (repo, branch) => { calls.pr.push([repo, branch]); return pr; },
    fire: async (text) => { calls.fire.push(text); if (fireError) throw new Error(fireError); return session; },
  };
}
const run = (dispatcher, records = [], { dryRun, list = [released], eligibleIds = new Set([ID]), now = NOW } = {}) => dispatch({ released: list, records, dispatcher, repo: 'pacphi/agentic-kit', sentinel: 'UPSTREAM-WATCH', now, recordedAt: RECORDED_AT, dryRun, eligibleIds });
const NOTHING = { records: [], errors: [], wouldFire: [] };

test('a released fix without a branch fires once and is recorded with its session', async () => {
  const dispatcher = fakeDispatcher();
  const result = await run(dispatcher);
  assert.deepEqual(dispatcher.calls.fire, [`${ID} 3.13.10 ${BRANCH}`]);
  assert.deepEqual(result.errors, []);
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].line, `UPSTREAM-WATCH ${ID} fired 2026-10-02 branch=${BRANCH} session=https://claude.ai/code/session_new`);
  assert.deepEqual(result.records[0].fields, { branch: BRANCH, session: 'https://claude.ai/code/session_new' });
});

test('an existing branch is never fired, and a closed dispatch pull request stays quiet', async () => {
  const dispatcher = fakeDispatcher({ exists: true, pr: null });
  const result = await run(dispatcher, [fired('2026-09-20T14:17:00Z')]);
  assert.deepEqual(dispatcher.calls.fire, []);
  assert.deepEqual(result, NOTHING);
});

test('a firing within three days waits; after three days it fires again; after two it fails', async () => {
  const recent = fakeDispatcher();
  assert.deepEqual(await run(recent, [fired('2026-10-01T14:17:00Z')]), NOTHING);
  assert.deepEqual(recent.calls.fire, []);
  const later = fakeDispatcher();
  const second = await run(later, [fired('2026-09-28T14:17:00Z')]);
  assert.equal(later.calls.fire.length, 1);
  assert.equal(second.records[0].event, 'fired');
  const spent = fakeDispatcher();
  const failed = await run(spent, [fired('2026-09-20T14:17:00Z', 'https://claude.ai/code/session_a'), fired('2026-09-25T14:17:00Z', 'https://claude.ai/code/session_b')]);
  assert.deepEqual(spent.calls.fire, []);
  assert.equal(failed.errors.length, 1);
  assert.match(failed.errors[0].error, /did not complete after 2 firings; see https:\/\/claude\.ai\/code\/session_a and https:\/\/claude\.ai\/code\/session_b/);
  const tooSoon = fakeDispatcher();
  const stillFailed = await run(tooSoon, [fired('2026-09-20T14:17:00Z', 'https://claude.ai/code/session_a'), fired('2026-10-01T14:17:00Z', 'https://claude.ai/code/session_b')]);
  assert.deepEqual(tooSoon.calls.fire, []);
  assert.equal(stillFailed.errors.length, 1);
  assert.match(stillFailed.errors[0].error, /did not complete after 2 firings; see https:\/\/claude\.ai\/code\/session_a and https:\/\/claude\.ai\/code\/session_b/);
});

test('a failed trigger call is an error and records nothing', async () => {
  const result = await run(fakeDispatcher({ fireError: 'UPSTREAM_DISPATCH_TOKEN is not set' }));
  assert.deepEqual(result.records, []);
  assert.deepEqual(result.errors, [{ id: ID, error: 'UPSTREAM_DISPATCH_TOKEN is not set' }]);
});

test('a dry run lists what would fire, calls no trigger and records no firing', async () => {
  const dispatcher = fakeDispatcher();
  const result = await run(dispatcher, [], { dryRun: true });
  assert.deepEqual(dispatcher.calls.fire, []);
  assert.deepEqual(dispatcher.calls.exists, [BRANCH], 'the branch check still runs');
  assert.deepEqual(result, { records: [], errors: [], wouldFire: [{ id: ID, version: '3.13.10', branch: BRANCH }] });
  const spent = await run(fakeDispatcher(), [fired('2026-09-20T14:17:00Z', 'https://claude.ai/code/session_a'), fired('2026-09-25T14:17:00Z', 'https://claude.ai/code/session_b')], { dryRun: true });
  assert.deepEqual([spent.wouldFire, spent.errors.length], [[], 1], 'the firing limit is still an error');
  const lookup = fakeDispatcher({ exists: true, pr: 261 });
  const pr = await run(lookup, [fired('2026-10-01T14:17:00Z')], { dryRun: true });
  assert.deepEqual(lookup.calls.pr, [['pacphi/agentic-kit', BRANCH]]);
  assert.deepEqual([pr.records.map((item) => item.event), pr.wouldFire], [['dispatch-pr'], []]);
  assert.deepEqual((await run(fakeDispatcher())).wouldFire, [], 'a real run lists nothing it would fire');
});

test('a fired record without fields is an error for its id, not a crash', async () => {
  const malformed = { line: `UPSTREAM-WATCH ${ID} fired 2026-10-01`, id: ID, event: 'fired', date: '2026-10-01', recordedAt: '2026-10-01T14:17:00Z' };
  const dispatcher = fakeDispatcher({ exists: true, pr: 261 });
  const result = await run(dispatcher, [malformed], { list: [] });
  assert.deepEqual(result.records, []);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].id, ID);
});

test('a fired branch with an open pull request records dispatch-pr once', async () => {
  const dispatcher = fakeDispatcher({ exists: true, pr: 261 });
  const result = await run(dispatcher, [fired('2026-10-01T14:17:00Z')]);
  assert.deepEqual(dispatcher.calls.pr, [['pacphi/agentic-kit', BRANCH]]);
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].line, `UPSTREAM-WATCH ${ID} dispatch-pr 2026-10-02 branch=${BRANCH} pr=261`);
  const done = { ...result.records[0] };
  const again = fakeDispatcher({ exists: true, pr: 261 });
  assert.deepEqual(await run(again, [fired('2026-10-01T14:17:00Z'), done]), NOTHING);
  assert.deepEqual(again.calls.pr, []);
});

test('PR observation stops on ineligible status or seven days after latest firing', async () => {
  assert.equal(PR_OBSERVE_DAYS, 7);
  const first = fired('2026-09-20T14:17:00Z');
  const latest = fired('2026-09-26T14:17:00Z');
  const inactive = fakeDispatcher({ exists: true, pr: 261 });
  assert.deepEqual(await run(inactive, [latest], { list: [], eligibleIds: new Set() }), NOTHING);
  assert.deepEqual(inactive.calls.pr, []);
  const before = fakeDispatcher({ exists: true, pr: 261 });
  const inside = await run(before, [first, latest], { list: [], now: new Date('2026-10-03T14:16:59Z') });
  assert.equal(inside.records[0].event, 'dispatch-pr');
  assert.deepEqual(before.calls.pr, [['pacphi/agentic-kit', BRANCH]]);
  const boundary = fakeDispatcher({ exists: true, pr: 261 });
  assert.deepEqual(await run(boundary, [first, latest], { list: [], now: new Date('2026-10-03T14:17:00Z'), dryRun: true }), NOTHING);
  assert.deepEqual(boundary.calls.pr, []);
});

test('the trigger call sends the payload with the documented headers and never prints the token', async () => {
  const requests = [];
  const fetchImpl = async (url, init) => { requests.push({ url, init }); return { status: 200, json: async () => ({ claude_code_session_url: 'https://claude.ai/code/session_x' }) }; };
  const env = { UPSTREAM_DISPATCH_ROUTINE: 'trig_01LmNVKJ4K86joHPvvPtc7yx', UPSTREAM_DISPATCH_TOKEN: 'sk-secret-token' };
  const session = await createDispatcher({ fetchImpl, env }).fire(`${ID} 3.13.10 ${BRANCH}`);
  assert.equal(session, 'https://claude.ai/code/session_x');
  assert.equal(requests[0].url, FIRE_URL('trig_01LmNVKJ4K86joHPvvPtc7yx'));
  assert.equal(requests[0].url, 'https://api.anthropic.com/v1/claude_code/routines/trig_01LmNVKJ4K86joHPvvPtc7yx/fire');
  assert.equal(requests[0].init.method, 'POST');
  assert.deepEqual(requests[0].init.headers, { ...FIRE_HEADERS, authorization: 'Bearer sk-secret-token' });
  assert.equal(FIRE_HEADERS['anthropic-beta'], 'experimental-cc-routine-2026-04-01');
  assert.equal(FIRE_HEADERS['anthropic-version'], '2023-06-01');
  assert.deepEqual(JSON.parse(requests[0].init.body), { text: `${ID} 3.13.10 ${BRANCH}` });
  assert.ok(requests[0].init.signal instanceof AbortSignal, 'the call carries a timeout signal');
  assert.equal(requests[0].init.signal.aborted, false);
  const hung = async () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); };
  await assert.rejects(createDispatcher({ fetchImpl: hung, env }).fire('x'), /aborted due to timeout/);
  const refused = async () => ({ status: 401, json: async () => ({ error: 'no' }) });
  const error = await createDispatcher({ fetchImpl: refused, env }).fire('x').catch((failure) => failure);
  assert.match(error.message, /HTTP 401/);
  assert.doesNotMatch(error.message, /sk-secret-token/);
  await assert.rejects(createDispatcher({ fetchImpl, env: { ...env, UPSTREAM_DISPATCH_TOKEN: '' } }).fire('x'), /UPSTREAM_DISPATCH_TOKEN is not set/);
  await assert.rejects(createDispatcher({ fetchImpl, env: { ...env, UPSTREAM_DISPATCH_ROUTINE: 'nope' } }).fire('x'), /UPSTREAM_DISPATCH_ROUTINE/);
  const empty = async () => ({ status: 200, json: async () => ({}) });
  await assert.rejects(createDispatcher({ fetchImpl: empty, env }).fire('x'), /without a session/);
});

test('branch and pull request lookups use git and gh without a shell', async () => {
  const calls = [];
  const exec = async (command, args) => {
    calls.push([command, ...args]);
    if (command === 'git') return { status: args.includes('upstream/missing') ? 2 : 0, stdout: '', stderr: '' };
    return { status: 0, stdout: '261\n', stderr: '' };
  };
  const dispatcher = createDispatcher({ exec });
  assert.equal(await dispatcher.branchExists(BRANCH), true);
  assert.equal(await dispatcher.branchExists('upstream/missing'), false);
  assert.equal(await dispatcher.openPullRequest('pacphi/agentic-kit', BRANCH), 261);
  assert.deepEqual(calls[0], ['git', 'ls-remote', '--exit-code', '--heads', 'origin', BRANCH]);
  assert.deepEqual(calls[2], ['gh', 'pr', 'list', '--repo', 'pacphi/agentic-kit', '--head', BRANCH, '--state', 'open', '--json', 'number,isCrossRepository', '--jq', SAME_REPO_PR]);
  await assert.rejects(dispatcher.branchExists('main'), /not a dispatch branch/);
  const broken = createDispatcher({ exec: async () => ({ status: 128, stdout: '', stderr: 'fatal: no remote' }) });
  await assert.rejects(broken.branchExists(BRANCH), /fatal: no remote/);
});

// `--head` matches the branch name in any fork, so gh filters out pull
// requests from other repositories before taking the first number.
test('a pull request from a fork is never taken for the dispatch pull request', async () => {
  assert.equal(SAME_REPO_PR, '[.[] | select(.isCrossRepository | not)][0].number // empty');
  assert.match(SAME_REPO_PR, /select\(\.isCrossRepository \| not\)/);
  const calls = [];
  // Only a fork's pull request is open on the branch: gh's --jq leaves nothing.
  const forkOnly = async (command, args) => { calls.push([command, ...args]); return { status: 0, stdout: '\n', stderr: '' }; };
  assert.equal(await createDispatcher({ exec: forkOnly }).openPullRequest('pacphi/agentic-kit', BRANCH), null);
  assert.deepEqual(calls[0].slice(-4), ['--json', 'number,isCrossRepository', '--jq', SAME_REPO_PR]);
});
