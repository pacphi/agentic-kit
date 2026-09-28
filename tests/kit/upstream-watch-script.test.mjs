// scripts/upstream-watch.mjs from recorded fixtures only: gh and npm responses
// recorded on 2026-09-26 (tests/fixtures/upstream-watch/), no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { UPSTREAM_REGISTRY_FILE, loadUpstreamRegistry } from '../../src/lib/hook-audit/upstream.mjs';
import {
  buildReport, candidateVersions, classifyEntry, compareVersions, confirmationStart, ledgerEvents, maxVersion, releaseFacts, tagRefs, withoutRecorded,
} from '../../scripts/upstream-watch/classify.mjs';
import { createFetcher, mapLimit } from '../../scripts/upstream-watch/fetch.mjs';
import { renderEvents, renderReport } from '../../scripts/upstream-watch/render.mjs';
import { sentence } from '../../scripts/upstream-watch/ledger.mjs';
import { main } from '../../scripts/upstream-watch.mjs';

const FIXTURES = path.resolve('tests/fixtures/upstream-watch');
const threads = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'threads.json'), 'utf8')).threads;
const npm = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'npm.json'), 'utf8')).packages;
const loggedOut = fs.readFileSync(path.join(FIXTURES, 'gh-auth-status-logged-out.txt'), 'utf8');
const { lastCheckedAt } = JSON.parse(fs.readFileSync(UPSTREAM_REGISTRY_FILE, 'utf8'));
const real = loadUpstreamRegistry({ now: () => new Date(`${lastCheckedAt}T12:00:00Z`) });
const NOW = new Date('2026-09-26T23:00:00Z');
const clone = (value) => JSON.parse(JSON.stringify(value));

function entry(id, overrides = {}) {
  const [repo, n] = id.split('#');
  const pr = overrides.kind === 'pr';
  return {
    id, url: `https://github.com/${repo}/${pr ? 'pull' : 'issues'}/${n}`, relation: 'filed', kind: 'issue', title: `title of ${id}`,
    dependency: repo.endsWith('agentic-qe') ? 'agentic-qe' : 'ruflo',
    doneWhen: { state: pr ? 'merged' : 'closed-completed', release: { channel: 'npm', name: repo.endsWith('agentic-qe') ? 'agentic-qe' : 'ruflo', minVersion: null } },
    mapping: 'mapped', kitImpact: { refs: ['a plan ref'], files: [] }, adjustment: 'the ak change', status: 'watching',
    constraintIds: [], history: [{ date: '2026-09-26', event: 'registered' }], ...overrides,
  };
}

function registryWith(watch, constraints = []) {
  return {
    registryStatus: 'valid', errors: [], lastVerifiedAt: '2026-09-26', lastCheckedAt: '2026-09-26', watchPolicy: clone(real.watchPolicy),
    dependencyPolicies: real.dependencyPolicies, constraints, watch,
  };
}

const context = { policy: real.watchPolicy, dependencyPolicies: real.dependencyPolicies, now: NOW };
const live = (id, release) => ({ thread: clone(threads[id]), release });
const agenticQe = releaseFacts('npm', npm['agentic-qe']);

test('compareVersions follows semver precedence, prereleases included', () => {
  assert.equal(compareVersions('3.14.3', '3.14.1'), 1);
  assert.equal(compareVersions('3.13.10', '3.13.9'), 1);
  assert.equal(compareVersions('3.0.0-alpha.20', '3.0.0'), -1);
  assert.equal(compareVersions('3.0.0-alpha.9', '3.0.0-alpha.20'), -1);
  assert.equal(compareVersions('3.45.0', '3.45.0'), 0);
});

test('a comment from someone else after our last word needs our reply', () => {
  const result = classifyEntry(entry('ruvnet/ruflo#3153', { relation: 'commented' }), live('ruvnet/ruflo#3153'), context);
  assert.ok(result.groups.includes('needs-reply'));
  assert.deepEqual([...new Set(result.replies.map((reply) => reply.by))], ['sparkling']);
  assert.equal(result.replies.length, 4, 'only the comments after our 2026-09-02 comment');
});

test('a reviewed history line clears the comments before it, not later ones', () => {
  const reviewed = entry('ruvnet/ruflo#3153', { relation: 'commented', history: [
    { date: '2026-09-02', event: 'commented' }, { date: '2026-09-27', event: 'reviewed', note: 'four scope corrections; nothing asked of ak' },
  ] });
  const quiet = classifyEntry(reviewed, live('ruvnet/ruflo#3153'), context);
  assert.ok(!quiet.groups.includes('needs-reply'));
  assert.deepEqual(quiet.replies, []);
  assert.equal(quiet.lastHistoryDate, '2026-09-02', 'reading a thread does not re-date its ledger lines');
  const thread = clone(threads['ruvnet/ruflo#3153']);
  thread.comments.push({ ...thread.comments.at(-1), id: 1, created_at: '2026-09-28T09:00:00Z', user: { login: 'sparkling', type: 'User' }, body: 'A question for agentic-kit?' });
  const later = classifyEntry(reviewed, { thread }, { ...context, now: new Date('2026-09-29T00:00:00Z') });
  assert.ok(later.groups.includes('needs-reply'));
  assert.deepEqual(later.replies.map((reply) => reply.at), ['2026-09-28T09:00:00Z']);
});

test('an automated acknowledgement is shown as acknowledged, not as a reply we owe', () => {
  const result = classifyEntry(entry('stuinfla/ruvnet-brain#331', { dependency: 'ruvnet-brain' }), live('stuinfla/ruvnet-brain#331'), context);
  assert.deepEqual(result.replies, []);
  assert.equal(result.acknowledgements[0].by, 'stuinfla');
  assert.ok(result.groups.includes('waiting'));
});

test('our own later comment answers the thread', () => {
  const result = classifyEntry(entry('ruvnet/ruflo#3046'), live('ruvnet/ruflo#3046'), context);
  assert.ok(!result.groups.includes('needs-reply'));
});

test('bot comments never need a reply, whichever signal marks them', () => {
  const recorded = threads['openai/codex#20140'].comments.find((comment) => comment.user.login.endsWith('[bot]'));
  const late = { ...recorded, created_at: '2026-09-20T00:00:00Z' };
  // Derived from the recorded bot comment: each variant carries only one bot signal.
  const variants = [
    { ...late, performed_via_github_app: null },
    { ...late, user: { login: 'release-helper', type: 'User' } },
  ];
  for (const comment of variants) {
    const thread = clone(threads['ruvnet/ruflo#952']);
    thread.comments.push(comment);
    const result = classifyEntry(entry('ruvnet/ruflo#952', { relation: 'commented' }), { thread }, context);
    assert.deepEqual(result.replies, [], JSON.stringify(comment.user));
  }
});

test('a thread without upstream activity for the stale limit is stale, not waiting', () => {
  const result = classifyEntry(entry('ruvnet/ruflo#952', { relation: 'commented' }), live('ruvnet/ruflo#952'), context);
  assert.ok(result.groups.includes('stale'));
  assert.ok(!result.groups.includes('waiting'));
  assert.equal(result.lastUpstreamActivityAt.slice(0, 10), '2026-01-16');
});

test('a fix in a published release with a pending ak change is released and actionable', () => {
  const release = { channel: 'npm', name: 'agentic-qe', minVersion: '3.13.10' };
  const target = entry('proffesor-for-testing/agentic-qe#617', { doneWhen: { state: 'closed-completed', release } });
  const result = classifyEntry(target, live('proffesor-for-testing/agentic-qe#617', agenticQe), context);
  assert.ok(result.groups.includes('released-actionable'));
  assert.equal(result.release.version, '3.13.10');
  assert.equal(result.dispatch.branch, 'upstream/proffesor-for-testing-agentic-qe-617');
  assert.equal(result.dispatch.pullRequest, 'draft');
  assert.equal(result.dispatch.merge, 'never');
  assert.match(result.dispatch.removalProof, /conformance/);
});

const rufloFacts = { versions: [
  { version: '3.45.0', publishedAt: '2026-09-24T22:54:53.174Z' },
  { version: '3.46.0', publishedAt: '2026-09-26T22:34:55.241Z' },
  { version: '3.46.1', publishedAt: '2026-09-26T23:27:22.133Z' },
], latest: '3.46.1' };
const closedThread = (id, closedAt) => ({ issue: { number: Number(id.split('#')[1]), state: 'closed', state_reason: 'completed', closed_at: closedAt, created_at: '2026-09-01T00:00:00Z', updated_at: closedAt, user: { login: 'pacphi' } }, comments: [] });
const change = { repo: 'ruvnet/ruflo', pr: 3421, sha: 'e45eeead28855b4f06b4afd184ffb408269ca2f8', mergedAt: '2026-09-26T22:31:22Z' };

test('a release is actionable only when it contains the merged fixing pull request', () => {
  const confirmation = { changes: [change], checks: [{ version: '3.46.0', ref: 'v3.46.0', contained: true }] };
  const result = classifyEntry(entry('ruvnet/ruflo#3194'), { thread: closedThread('ruvnet/ruflo#3194', '2026-09-26T22:31:23Z'), release: rufloFacts, confirmation }, context);
  assert.ok(result.groups.includes('released-actionable'));
  assert.equal(result.release.confirmed, true);
  assert.equal(result.release.version, '3.46.0');
  assert.equal(result.release.date, '2026-09-26');
  assert.equal(result.release.change.pr, 3421);
  assert.match(result.release.basis, /PR #3421 is in v3\.46\.0/);
});

test('without proof the first release after the fix is unconfirmed, not actionable', () => {
  for (const confirmation of [null, { changes: [], checks: [] }, { changes: [change], checks: [{ version: '3.46.0', ref: null, contained: null }] }]) {
    const result = classifyEntry(entry('ruvnet/ruflo#3194'), { thread: closedThread('ruvnet/ruflo#3194', '2026-09-26T22:31:23Z'), release: rufloFacts, confirmation }, context);
    assert.deepEqual(result.groups.filter((group) => /^(released|release|fixed)/.test(group)), ['release-unconfirmed'], JSON.stringify(confirmation));
    assert.equal(result.release.version, '3.46.0');
    assert.equal(result.dispatch, null, 'an unconfirmed release is never dispatched');
  }
  // 3.46.0 was shown not to contain the fix, so the release left unproven is 3.46.1.
  const ruledOut = { changes: [change], checks: [{ version: '3.46.0', ref: 'v3.46.0', contained: false }, { version: '3.46.1', ref: null, contained: null }] };
  const result = classifyEntry(entry('ruvnet/ruflo#3194'), { thread: closedThread('ruvnet/ruflo#3194', '2026-09-26T22:31:23Z'), release: rufloFacts, confirmation: ruledOut }, context);
  assert.ok(result.groups.includes('release-unconfirmed'));
  assert.equal(result.release.version, '3.46.1');
  assert.equal(result.release.date, '2026-09-26');
  assert.match(result.release.basis, /PR #3421 is in ruflo 3\.46\.1$/);
  assert.match(renderReport(buildReport(registryWith([entry('ruvnet/ruflo#3194')]), new Map([['ruvnet/ruflo#3194', { thread: closedThread('ruvnet/ruflo#3194', '2026-09-26T22:31:23Z'), release: rufloFacts, confirmation: ruledOut }]]), { now: NOW })),
    /3\.46\.1 \(2026-09-26\) is the first release after the fix not ruled out/);
});

test('a fix no checked release contains is fixed but unreleased', () => {
  const confirmation = { changes: [change], checks: [
    { version: '3.46.0', ref: 'v3.46.0', contained: false }, { version: '3.46.1', ref: 'v3.46.1', contained: false },
  ] };
  const result = classifyEntry(entry('ruvnet/ruflo#3194'), { thread: closedThread('ruvnet/ruflo#3194', '2026-09-26T22:31:23Z'), release: rufloFacts, confirmation }, context);
  assert.ok(result.groups.includes('fixed-unreleased'));
  assert.ok(!result.groups.includes('released-actionable'));
  assert.match(result.release.basis, /contains PR #3421/);
});

// Probe A: the fixing pull request merged before 3.46.0, but the issue was closed a day later.
const closedLate = () => closedThread('ruvnet/ruflo#3194', '2026-09-27T22:00:00Z');

test('the release walk starts when the fixing change merged, not when the issue closed', () => {
  const confirmation = { changes: [change], checks: [{ version: '3.46.0', ref: 'v3.46.0', contained: true }] };
  const result = classifyEntry(entry('ruvnet/ruflo#3194'), { thread: closedLate(), release: rufloFacts, confirmation }, context);
  assert.ok(result.groups.includes('released-actionable'), JSON.stringify(result.release));
  assert.equal(result.release.version, '3.46.0');
  assert.equal(confirmationStart(result.upstream.fixedAt, confirmation), '2026-09-26T22:31:22Z');
  assert.equal(confirmationStart('2026-09-27T22:00:00Z', { changes: [{ ...change, mergedAt: null }], checks: [] }), '2026-09-27T22:00:00Z', 'a closing commit: the close time');
  assert.equal(confirmationStart('2026-09-27T22:00:00Z', null), '2026-09-27T22:00:00Z');
});

test('collect walks the releases after the fixing merge, even when the issue closed later', async () => {
  const calls = [];
  const fetcher = {
    auth: async () => ({ ok: true }),
    thread: async () => closedLate(),
    release: async () => rufloFacts,
    fixingChanges: async () => [change],
    contains: async (repo, refs) => { calls.push(refs[0]); return { ref: refs[0], contained: true }; },
  };
  await withRegistryFile([entry('ruvnet/ruflo#3194')], async (file) => {
    const out = capture();
    await main(['report', '--json', '--registry', file], { fetcher, stdout: out.stream, stderr: capture().stream, now: new Date('2026-09-28T00:00:00Z') });
    const report = JSON.parse(out.text());
    assert.deepEqual(report.groups.find((group) => group.key === 'released-actionable').items.map((item) => item.version ?? item.release.version), ['3.46.0']);
  }, { supportWindow: false });
  assert.deepEqual(calls, ['v3.46.0']);
});

// Walk the releases through main with a fetcher whose tags contain the fix from `containing` on.
async function walkReleases(facts, containing) {
  const calls = [];
  const fetcher = {
    auth: async () => ({ ok: true }),
    thread: async () => closedThread('ruvnet/ruflo#3194', '2026-01-01T00:00:00Z'),
    release: async () => facts,
    fixingChanges: async () => [{ ...change, mergedAt: '2026-01-01T00:00:00Z' }],
    contains: async (repo, refs) => {
      const version = refs[0].slice(1);
      calls.push(version);
      return { ref: refs[0], contained: containing.includes(version) };
    },
  };
  let report;
  await withRegistryFile([entry('ruvnet/ruflo#3194')], async (file) => {
    const out = capture();
    await main(['report', '--json', '--registry', file], { fetcher, stdout: out.stream, stderr: capture().stream, now: NOW });
    report = JSON.parse(out.text());
  }, { supportWindow: false });
  return { calls, result: report.entries.find((item) => item.id === 'ruvnet/ruflo#3194') };
}
const releasesUpTo = (count, extra = []) => {
  const versions = Array.from({ length: count }, (_, index) => ({ version: `1.0.${index + 1}`, publishedAt: `2026-02-${String(index + 1).padStart(2, '0')}T00:00:00Z` }));
  return { versions: [...versions, ...extra], latest: versions.at(-1).version };
};

test('a fix first shipped after the first five releases is still found (probe B)', async () => {
  const { calls, result } = await walkReleases(releasesUpTo(6), ['1.0.6']);
  assert.ok(result.groups.includes('released-actionable'), JSON.stringify(result.release));
  assert.equal(result.release.version, '1.0.6');
  assert.deepEqual(calls, ['1.0.1', '1.0.2', '1.0.3', '1.0.4', '1.0.5', '1.0.6']);
});

test('past the window the released version is the oldest containing one, and stays so', async () => {
  const later = ['1.0.7', '1.0.8', '1.0.9'];
  const eight = await walkReleases(releasesUpTo(8), later);
  assert.equal(eight.result.release.version, '1.0.7');
  assert.deepEqual(eight.calls, ['1.0.1', '1.0.2', '1.0.3', '1.0.4', '1.0.5', '1.0.8', '1.0.6', '1.0.7'], 'the newest is checked, then the gap oldest first');
  const nine = await walkReleases(releasesUpTo(9), later);
  assert.equal(nine.result.release.version, '1.0.7', 'a newer release does not change the released line');
});

test('when the newest release lacks the fix, it is fixed but unreleased after one extra check', async () => {
  const { calls, result } = await walkReleases(releasesUpTo(8), []);
  assert.ok(result.groups.includes('fixed-unreleased'), JSON.stringify(result.release));
  assert.deepEqual(calls, ['1.0.1', '1.0.2', '1.0.3', '1.0.4', '1.0.5', '1.0.8']);
  assert.match(result.release.basis, /1\.0\.8/);
});

test('the newest release is the latest one, not a backport published after it', async () => {
  // A backport on an older line is published last but is not what ak installs.
  const facts = releasesUpTo(7, [{ version: '0.9.9', publishedAt: '2026-03-01T00:00:00Z' }]);
  const { calls, result } = await walkReleases(facts, ['1.0.7']);
  assert.equal(result.release.version, '1.0.7');
  assert.deepEqual(calls, ['1.0.1', '1.0.2', '1.0.3', '1.0.4', '1.0.5', '1.0.7', '1.0.6']);
});

test('candidateVersions walks releases after the fix, oldest first, bounded', () => {
  assert.deepEqual(candidateVersions('2026-09-26T22:31:23Z', rufloFacts).map((item) => item.version), ['3.46.0', '3.46.1']);
  assert.equal(candidateVersions('2026-01-01T00:00:00Z', rufloFacts, 2).length, 2);
  const withPrerelease = { versions: [...rufloFacts.versions, { version: '3.47.0-alpha.1', publishedAt: '2026-09-25T00:00:00Z' }], latest: '3.46.1' };
  assert.deepEqual(candidateVersions('2026-09-24T00:00:00Z', withPrerelease).map((item) => item.version), ['3.45.0', '3.46.0', '3.46.1'], 'stable only while latest is stable');
  assert.deepEqual(tagRefs({ channel: 'npm', name: 'ruflo', minVersion: null }, '3.46.0'), ['v3.46.0', '3.46.0']);
  assert.deepEqual(tagRefs({ channel: 'npm', name: '@openai/codex', minVersion: null, tagPattern: 'rust-v{version}' }, '0.153.4'), ['rust-v0.153.4']);
});

test('the released ledger line names the fixing pull request, never "candidate"', () => {
  const confirmation = { changes: [change], checks: [{ version: '3.46.0', ref: 'v3.46.0', contained: true }] };
  const registry = registryWith([entry('ruvnet/ruflo#3194')]);
  const report = buildReport(registry, new Map([['ruvnet/ruflo#3194', { thread: closedThread('ruvnet/ruflo#3194', '2026-09-26T22:31:23Z'), release: rufloFacts, confirmation }]]), { now: NOW });
  const line = ledgerEvents(report, registry, { since: '2026-09-26T00:00:00Z' }).find((event) => event.event === 'released').line;
  assert.equal(line, 'UPSTREAM-WATCH ruvnet/ruflo#3194 released 2026-09-26 version=3.46.0 pr=3421 branch=upstream/ruvnet-ruflo-3194');
  const byCommit = { changes: [{ repo: 'ruvnet/ruflo', pr: null, sha: 'abc1234abc1234abc1234abc1234abc1234abc12' }], checks: [{ version: '3.46.0', ref: 'v3.46.0', contained: true }] };
  const committed = buildReport(registry, new Map([['ruvnet/ruflo#3194', { thread: closedThread('ruvnet/ruflo#3194', '2026-09-26T22:31:23Z'), release: rufloFacts, confirmation: byCommit }]]), { now: NOW });
  assert.match(ledgerEvents(committed, registry, { since: '2026-09-26T00:00:00Z' }).find((event) => event.event === 'released').line, / version=3\.46\.0 commit=abc1234 branch=/);
  const unconfirmed = buildReport(registry, new Map([['ruvnet/ruflo#3194', { thread: closedThread('ruvnet/ruflo#3194', '2026-09-26T22:31:23Z'), release: rufloFacts, confirmation: null }]]), { now: NOW });
  assert.ok(!ledgerEvents(unconfirmed, registry, { since: '2026-09-26T00:00:00Z' }).some((event) => event.event === 'released'), 'only a confirmed release is a released line');
  assert.match(renderReport(unconfirmed), /Released, fix not confirmed[\s\S]*3\.46\.0 \(2026-09-26\) is the first release after the fix not ruled out/);
});

test('collect confirms through the fetcher with bounded, read-only calls', async () => {
  const calls = [];
  const fetcher = {
    auth: async () => ({ ok: true }),
    thread: async (id) => closedThread(id, '2026-09-26T22:31:23Z'),
    release: async () => rufloFacts,
    fixingChanges: async (id) => { calls.push(`changes ${id}`); return [change]; },
    contains: async (repo, refs) => { calls.push(`contains ${refs[0]}`); return { ref: refs[0], contained: refs[0] === 'v3.46.0' }; },
  };
  await withRegistryFile([entry('ruvnet/ruflo#3194')], async (file) => {
    const out = capture();
    await main(['report', '--json', '--registry', file], { fetcher, stdout: out.stream, stderr: capture().stream, now: NOW });
    const report = JSON.parse(out.text());
    assert.deepEqual(report.groups.find((group) => group.key === 'released-actionable').items.map((item) => item.id), ['ruvnet/ruflo#3194']);
  }, { supportWindow: false });
  assert.deepEqual(calls, ['changes ruvnet/ruflo#3194', 'contains v3.46.0'], 'stops at the first containing version');
});

test('a confirmation failure is "Could not check", never "not contained"', async () => {
  const fetcher = {
    auth: async () => ({ ok: true }),
    thread: async (id) => closedThread(id, '2026-09-26T22:31:23Z'),
    release: async () => rufloFacts,
    fixingChanges: async () => [change],
    contains: async () => { throw new Error('gh api repos/ruvnet/ruflo/compare failed: API rate limit exceeded (HTTP 403)'); },
  };
  await withRegistryFile([entry('ruvnet/ruflo#3194')], async (file) => {
    const out = capture();
    await main(['report', '--json', '--registry', file], { fetcher, stdout: out.stream, stderr: capture().stream, now: NOW });
    const report = JSON.parse(out.text());
    assert.deepEqual(report.groups.find((group) => group.key === 'unchecked').items.map((item) => item.id), ['ruvnet/ruflo#3194']);
    assert.equal(report.counts['fixed-unreleased'], 0);
    assert.match(report.fetchErrors[0].error, /rate limit/);
  });
});

test('a failed confirmation keeps the thread: check still emits its closed line', async () => {
  const fetcher = {
    auth: async () => ({ ok: true }),
    thread: async (id) => closedThread(id, '2026-09-26T22:31:23Z'),
    release: async () => rufloFacts,
    fixingChanges: async () => { throw new Error('gh api graphql failed: API rate limit exceeded (HTTP 403)'); },
    contains: async () => ({ ref: null, contained: null }),
  };
  await withRegistryFile([entry('ruvnet/ruflo#3194')], async (file) => {
    const json = capture();
    await main(['check', '--since', '2026-09-26T00:00:00Z', '--json', '--registry', file], { fetcher, stdout: json.stream, stderr: capture().stream, now: NOW });
    const result = JSON.parse(json.text());
    assert.deepEqual(result.events.map((event) => event.line), ['UPSTREAM-WATCH ruvnet/ruflo#3194 closed 2026-09-26 reason=completed']);
    assert.match(result.fetchErrors[0].error, /rate limit/);
    const report = capture();
    await main(['report', '--json', '--registry', file], { fetcher, stdout: report.stream, stderr: capture().stream, now: NOW });
    const target = JSON.parse(report.text()).entries.find((item) => item.id === 'ruvnet/ruflo#3194');
    assert.ok(target.groups.includes('unchecked'));
    assert.equal(target.release.released, null);
    assert.match(target.release.basis, /could not confirm .*rate limit/);
    assert.equal(target.upstream.state, 'closed', 'the thread already read is kept');
    const text = capture();
    const err = capture();
    await main(['check', '--since', '2026-09-26T00:00:00Z', '--registry', file], { fetcher, stdout: text.stream, stderr: err.stream, now: NOW });
    assert.ok(text.text().split('\n').filter(Boolean).every((line) => line.startsWith('UPSTREAM-WATCH ')), 'stdout stays ledger lines only');
    assert.match(err.text(), /Could not check ruvnet\/ruflo#3194: .*rate limit/);
  });
});

test('a closed fix no published release contains is fixed but unreleased', () => {
  const release = { channel: 'npm', name: 'agentic-qe', minVersion: '9.9.9' };
  const target = entry('proffesor-for-testing/agentic-qe#617', { doneWhen: { state: 'closed-completed', release } });
  const result = classifyEntry(target, live('proffesor-for-testing/agentic-qe#617', agenticQe), context);
  assert.deepEqual(result.groups.filter((group) => group.startsWith('fixed') || group.startsWith('released')), ['fixed-unreleased']);
});

test('a registry status change covers the comments before it', () => {
  const pending = classifyEntry(entry('proffesor-for-testing/agentic-qe#617'), live('proffesor-for-testing/agentic-qe#617', agenticQe), context);
  assert.ok(pending.groups.includes('needs-reply'), 'the post-close comment is after our issue body');
  const processed = entry('proffesor-for-testing/agentic-qe#617', {
    status: 'released', history: [{ date: '2026-09-26', event: 'registered' }, { date: '2026-09-26', event: 'released' }],
  });
  const result = classifyEntry(processed, live('proffesor-for-testing/agentic-qe#617'), context);
  assert.ok(!result.groups.includes('needs-reply'));
  assert.ok(result.groups.includes('workaround-carried'));
  assert.match(result.dispatch.branch, /^upstream\//);
});

test('a merged pull request is fixed; reopened and not-planned threads are called out', () => {
  const ruflo = releaseFacts('npm', npm.ruflo);
  const merged = classifyEntry(entry('ruvnet/ruflo#2986', { kind: 'pr', relation: 'filed' }), live('ruvnet/ruflo#2986', ruflo), context);
  assert.equal(merged.upstream.fixed, true);
  assert.ok(merged.groups.includes('release-unconfirmed'), 'without a confirmation the release is unconfirmed');
  const first = candidateVersions(merged.upstream.fixedAt, ruflo)[0].version;
  const confirmation = { changes: [{ repo: 'ruvnet/ruflo', pr: 2986, sha: '0123456789abcdef0123456789abcdef01234567' }], checks: [{ version: first, ref: `v${first}`, contained: true }] };
  const confirmed = classifyEntry(entry('ruvnet/ruflo#2986', { kind: 'pr', relation: 'filed' }), { ...live('ruvnet/ruflo#2986', ruflo), confirmation }, context);
  assert.ok(confirmed.groups.includes('released-actionable'));
  const reopened = classifyEntry(entry('ruvnet/ruflo#2885', { status: 'released' }), live('ruvnet/ruflo#2885'), context);
  assert.ok(reopened.groups.includes('reopened'));
  const thread = clone(threads['openai/codex#20140']);
  thread.issue.state_reason = 'not_planned';
  const notPlanned = classifyEntry(entry('openai/codex#20140', { relation: 'referenced', mapping: 'unmapped', kitImpact: null, adjustment: null }), { thread }, context);
  assert.ok(notPlanned.groups.includes('not-planned'));
  assert.ok(notPlanned.groups.includes('ready-to-retire'));
});

// ADR-0041 §7: a workaround comes out only once the oldest supported Ruflo has the fix.
test('a released Ruflo fix above the support-window floor waits for the window', () => {
  const gated = (minVersion) => entry('ruvnet/ruflo#3167', {
    status: 'released', history: [{ date: '2026-09-26', event: 'registered' }, { date: '2026-09-26', event: 'released' }],
    doneWhen: { state: 'closed-completed', release: { channel: 'npm', name: 'ruflo', minVersion } },
  });
  const windowed = { ...context, supportFloor: '3.39.0' };
  const held = classifyEntry(gated('3.46.0'), null, windowed);
  assert.ok(held.groups.includes('waiting-for-window'), held.groups.join(','));
  assert.ok(!held.groups.includes('workaround-carried'));
  assert.equal(held.dispatch, null);
  assert.deepEqual(held.window, { floor: '3.39.0', needs: '3.46.0' });
  const ready = classifyEntry(gated('3.32.2'), null, windowed);
  assert.ok(!ready.groups.includes('waiting-for-window'));
  assert.match(ready.dispatch.branch, /^upstream\/ruvnet-ruflo-3167$/);
  const unknownFloor = classifyEntry(gated('3.46.0'), null, context);
  assert.ok(!unknownFloor.groups.includes('waiting-for-window'), 'no remembered floor: nothing is held');
});

test('a release confirmed from the fixing change is held for the window too', () => {
  const confirmation = { changes: [change], checks: [{ version: '3.46.0', ref: 'v3.46.0', contained: true }] };
  const registry = registryWith([entry('ruvnet/ruflo#3194')]);
  const report = buildReport(registry, new Map([['ruvnet/ruflo#3194', { thread: closedThread('ruvnet/ruflo#3194', '2026-09-26T22:31:23Z'), release: rufloFacts, confirmation }]]),
    { now: NOW, supportFloor: '3.41.0' });
  const held = report.entries[0];
  assert.ok(held.groups.includes('waiting-for-window'), held.groups.join(','));
  assert.ok(!held.groups.includes('released-actionable'));
  assert.deepEqual(held.window, { floor: '3.41.0', needs: '3.46.0' });
  assert.equal(held.dispatch, null);
  const line = ledgerEvents(report, registry, { since: '2026-09-26T00:00:00Z' }).find((event) => event.event === 'released').line;
  assert.equal(line, 'UPSTREAM-WATCH ruvnet/ruflo#3194 released 2026-09-26 version=3.46.0 pr=3421');
});

test('a newly released Ruflo fix above the floor records the release without a dispatch branch', () => {
  const pending = entry('ruvnet/ruflo#2986', {
    kind: 'pr', doneWhen: { state: 'merged', release: { channel: 'npm', name: 'ruflo', minVersion: '3.38.2' } },
  });
  const registry = registryWith([pending]);
  const report = buildReport(registry, new Map([['ruvnet/ruflo#2986', live('ruvnet/ruflo#2986', releaseFacts('npm', npm.ruflo))]]),
    { now: NOW, supportFloor: '3.30.0' });
  const held = report.entries[0];
  assert.deepEqual(held.groups.filter((group) => ['released-actionable', 'waiting-for-window'].includes(group)), ['waiting-for-window']);
  assert.equal(report.counts['waiting-for-window'], 1);
  const released = ledgerEvents(report, registry, { since: '2026-09-25T00:00:00Z' }).find((event) => event.event === 'released');
  assert.match(released.line, /released \S+ version=3\.38\.2$/);
  assert.match(renderReport(report), /Released, waiting for the support window[\s\S]*oldest supported Ruflo is 3\.30\.0/);
});

test('the watch computes the support-window floor from the npm release dates it fetches', async () => {
  const fixed = entry('ruvnet/ruflo#3167', {
    status: 'released', doneWhen: { state: 'closed-completed', release: { channel: 'npm', name: 'ruflo', minVersion: '9.0.0' } },
  });
  await withRegistryFile([fixed], async (file) => {
    const out = capture();
    const fetcher = { ...fixtureFetcher(), thread: async () => { throw new Error('offline thread'); } };
    assert.equal(await main(['report', '--json', '--registry', file], { fetcher, stdout: out.stream, stderr: capture().stream, now: NOW }), 0);
    const report = JSON.parse(out.text());
    assert.match(report.supportWindow.floor, /^3\.\d+\.0$/);
    assert.ok(report.entries.find((item) => item.id === 'ruvnet/ruflo#3167').groups.includes('waiting-for-window'));
  });
});

test('the report counts groups, lists constraints past retest and never watches retired entries', () => {
  const registry = registryWith([
    entry('ruvnet/ruflo#3153', { relation: 'commented' }),
    entry('ruvnet/ruflo#952', { relation: 'commented', mapping: 'unmapped', kitImpact: null, adjustment: null }),
    entry('ruvnet/ruflo#2239', { status: 'retired' }),
  ], [{ id: 'c-due', dependency: 'ruflo', nextRetestAt: '2026-09-09', issue: 'https://github.com/ruvnet/ruflo/issues/3153' }]);
  const report = buildReport(registry, new Map([['ruvnet/ruflo#3153', live('ruvnet/ruflo#3153')], ['ruvnet/ruflo#952', live('ruvnet/ruflo#952')]]), { now: NOW });
  assert.equal(report.mode, 'live');
  assert.equal(report.counts['needs-reply'], 1);
  assert.equal(report.counts.stale, 1);
  assert.equal(report.counts.unmapped, 1);
  assert.equal(report.counts['constraints-due'], 1);
  assert.equal(report.registry.statuses.retired, 1);
  assert.ok(!report.entries.some((item) => item.id === 'ruvnet/ruflo#2239'));
  assert.equal(report.nothingToWatch, false);
});

test('offline, the report falls back to what the registry records', () => {
  const registry = registryWith([entry('ruvnet/ruflo#2670', { status: 'released' }), entry('ruvnet/ruflo#2239', { status: 'adopted' })]);
  const report = buildReport(registry, new Map(), { now: NOW, offline: 'gh is not authenticated' });
  assert.equal(report.mode, 'offline');
  assert.equal(report.counts['workaround-carried'], 1);
  assert.equal(report.counts['ready-to-retire'], 1);
  assert.equal(report.counts['needs-reply'], 0);
});

test('ledger events use the sentinel, stable dates, and skip lines already recorded', () => {
  const registry = registryWith([
    entry('ruvnet/ruflo#3153', { relation: 'commented' }),
    entry('proffesor-for-testing/agentic-qe#617', { doneWhen: { state: 'closed-completed', release: { channel: 'npm', name: 'agentic-qe', minVersion: '3.13.10' } } }),
  ], [{ id: 'c-due', dependency: 'ruflo', nextRetestAt: '2026-09-09' }]);
  const report = buildReport(registry, new Map([
    ['ruvnet/ruflo#3153', live('ruvnet/ruflo#3153')],
    ['proffesor-for-testing/agentic-qe#617', live('proffesor-for-testing/agentic-qe#617', agenticQe)],
  ]), { now: NOW });
  const events = ledgerEvents(report, registry, { since: '2026-09-03T00:00:00Z' });
  const lines = events.map((event) => event.line);
  // One line per comment: two replies by one person on one day stay two ledger lines.
  assert.ok(lines.includes('UPSTREAM-WATCH ruvnet/ruflo#3153 reply 2026-09-03 by=sparkling at=08:54:07Z'), lines.join('\n'));
  const sameDay = ledgerEvents(report, registry, { since: '2026-09-02T00:00:00Z' }).filter((event) => event.event === 'reply' && event.date === '2026-09-02');
  assert.equal(new Set(sameDay.map((event) => event.line)).size, 3);
  assert.ok(!lines.some((line) => line.includes('reply 2026-09-02')), 'replies before --since are not events');
  const released = lines.find((line) => line.includes(' released '));
  assert.match(released, /^UPSTREAM-WATCH proffesor-for-testing\/agentic-qe#617 released 2026-08-06 version=3\.13\.10 branch=upstream\//);
  assert.ok(lines.includes('UPSTREAM-WATCH c-due retest-due 2026-09-09'));
  const again = ledgerEvents(report, registry, { since: '2026-09-03T00:00:00Z' });
  assert.deepEqual(again.map((event) => event.line), lines, 'the same facts produce the same lines');
  const ledger = `Some prose\n  ${released}\n`;
  assert.ok(!withoutRecorded(events, ledger).some((event) => event.line === released));
  assert.equal(withoutRecorded(events, ledger).length, events.length - 1);
});

test('nothing left to watch is reported once every entry is retired', () => {
  // The idle line dates from the last state re-read, not the last conformance run.
  const registry = { ...registryWith([entry('ruvnet/ruflo#2239', { status: 'retired' })]), lastVerifiedAt: '2026-09-20' };
  const report = buildReport(registry, new Map(), { now: NOW });
  assert.equal(report.nothingToWatch, true);
  assert.equal(report.registry.lastCheckedAt, '2026-09-26');
  assert.deepEqual(ledgerEvents(report, registry, { since: NOW.toISOString() }).map((event) => event.line), ['UPSTREAM-WATCH registry idle 2026-09-26']);
});

test('mapLimit keeps results in order and never exceeds its concurrency', async () => {
  let active = 0;
  let peak = 0;
  const results = await mapLimit([5, 1, 4, 2, 3, 0], 2, async (value) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, value));
    active--;
    return value * 10;
  });
  assert.deepEqual(results, [50, 10, 40, 20, 30, 0]);
  assert.equal(peak, 2);
});

function fakeExec(responses) {
  const calls = [];
  const exec = async (command, args) => {
    calls.push([command, ...args].join(' '));
    for (const [pattern, response] of responses) if (pattern.test([command, ...args].join(' '))) return response;
    return { status: 1, stdout: '', stderr: 'unexpected call' };
  };
  return { exec, calls };
}

test('the fetcher explains an unauthenticated or missing gh plainly', async () => {
  // `gh auth status` calls an injected or installation token invalid while
  // `gh api` works with it (cloud routine run cse_01Xb8wcBL8h335pxUeQ9sbnQ),
  // so the probe is a call any token can make.
  const { exec: signedOutExec, calls } = fakeExec([[/^gh api rate_limit/, { status: 4, stdout: '', stderr: loggedOut }]]);
  const auth = await createFetcher({ exec: signedOutExec }).auth();
  assert.equal(auth.ok, false);
  assert.match(auth.message, /gh auth login|GH_TOKEN/);
  assert.ok(calls.every((call) => !call.startsWith('gh auth')), calls.join('\n'));
  const tokenOnly = createFetcher({ exec: fakeExec([[/^gh api rate_limit/, { status: 0, stdout: '5000\n', stderr: '' }]]).exec });
  assert.deepEqual(await tokenOnly.auth(), { ok: true });
  const missing = createFetcher({ exec: async () => ({ status: null, stdout: '', stderr: '', error: Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }) }) });
  assert.match((await missing.auth()).message, /not installed/);
});

test('the fetcher reads a thread and its paginated comments through gh api', async () => {
  const fixture = threads['ruvnet/ruflo#3046'];
  const { exec, calls } = fakeExec([
    // `--paginate --jq '.[]'` prints one comment per line across every page.
    [/issues\/3046\/comments/, { status: 0, stdout: `${fixture.comments.map((comment) => JSON.stringify(comment)).join('\n')}\n`, stderr: '' }],
    [/issues\/3046$/, { status: 0, stdout: JSON.stringify(fixture.issue), stderr: '' }],
    [/^npm view agentic-qe/, { status: 0, stdout: JSON.stringify(npm['agentic-qe']), stderr: '' }],
  ]);
  const fetcher = createFetcher({ exec });
  const thread = await fetcher.thread('ruvnet/ruflo#3046');
  assert.equal(thread.issue.number, 3046);
  assert.equal(thread.comments.length, fixture.comments.length);
  // gh 2.45 (apt on Ubuntu 24.04) has no --slurp; --jq '.[]' works on every gh 2.x.
  const comments = calls.find((call) => call.includes('/comments'));
  assert.ok(comments.includes('--paginate') && comments.includes("--jq .[]") && !comments.includes('--slurp'), comments);
  assert.equal((await fetcher.release({ channel: 'npm', name: 'agentic-qe' })).latest, '3.14.3');
  await assert.rejects(fetcher.thread('ruvnet/ruflo#1'), /unexpected call/);
});

const confirmations = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'confirmations.json'), 'utf8'));

test('fixingChanges keeps only merged pull requests into the default branch', async () => {
  const { exec, calls } = fakeExec([
    [/^gh api graphql .*number=3167/, { status: 0, stdout: JSON.stringify(confirmations.graphql['ruvnet/ruflo#3167']), stderr: '' }],
  ]);
  // #3167 also lists the unmerged PR #3373 among its closing references.
  const changes = await createFetcher({ exec }).fixingChanges('ruvnet/ruflo#3167');
  assert.deepEqual(changes, [{ repo: 'ruvnet/ruflo', pr: 3434, sha: '856249ed7e35e604fa58a3b93179570d7998b9d3', mergedAt: '2026-09-26T22:31:21Z' }]);
  assert.ok(calls.every((call) => call.startsWith('gh api graphql')), 'read-only: graphql query only');
});

test('fixingChanges drops an off-branch merge and falls back to the closing commit', async () => {
  const recorded = clone(confirmations.graphql['ruvnet/ruflo#3194']);
  const issue = recorded.data.repository.issueOrPullRequest;
  issue.closedByPullRequestsReferences.nodes[0].baseRefName = 'release/3.x';
  issue.timelineItems.nodes = [{ closer: { __typename: 'Commit', oid: 'abc1234abc1234abc1234abc1234abc1234abc12' } }];
  const { exec } = fakeExec([[/^gh api graphql/, { status: 0, stdout: JSON.stringify(recorded), stderr: '' }]]);
  assert.deepEqual(await createFetcher({ exec }).fixingChanges('ruvnet/ruflo#3194'),
    [{ repo: 'ruvnet/ruflo', pr: null, sha: 'abc1234abc1234abc1234abc1234abc1234abc12', mergedAt: null }], 'a closing commit lands when the thread closes');
});

test('fixingChanges: unmerged, off-branch or hand-closed threads have no fixing change', async () => {
  const offBranch = clone(confirmations.graphql['ruvnet/ruflo#3194']);
  const issue = offBranch.data.repository.issueOrPullRequest;
  issue.closedByPullRequestsReferences.nodes[0].baseRefName = 'release/3.x';
  issue.timelineItems.nodes[0].closer.baseRefName = 'release/3.x';
  const byHand = clone(confirmations.graphql['ruvnet/ruflo#3194']);
  byHand.data.repository.issueOrPullRequest.closedByPullRequestsReferences.nodes = [];
  byHand.data.repository.issueOrPullRequest.timelineItems.nodes = [{ closer: null }];
  const unmerged = clone(confirmations.graphql['ruvnet/ruflo#3167']);
  unmerged.data.repository.issueOrPullRequest.closedByPullRequestsReferences.nodes.splice(1);
  unmerged.data.repository.issueOrPullRequest.timelineItems.nodes = [];
  const openPr = { data: { repository: { defaultBranchRef: { name: 'main' }, issueOrPullRequest: {
    __typename: 'PullRequest', number: 3373, merged: false, baseRefName: 'main', mergeCommit: null, repository: { nameWithOwner: 'ruvnet/ruflo' },
  } } } };
  for (const recorded of [offBranch, byHand, unmerged, openPr]) {
    const { exec } = fakeExec([[/^gh api graphql/, { status: 0, stdout: JSON.stringify(recorded), stderr: '' }]]);
    assert.deepEqual(await createFetcher({ exec }).fixingChanges('ruvnet/ruflo#3194'), []);
  }
  const mergedPr = clone(openPr);
  Object.assign(mergedPr.data.repository.issueOrPullRequest, { number: 3434, merged: true, mergedAt: '2026-09-26T22:31:21Z', mergeCommit: { oid: '856249ed7e35e604fa58a3b93179570d7998b9d3' } });
  const { exec } = fakeExec([[/^gh api graphql/, { status: 0, stdout: JSON.stringify(mergedPr), stderr: '' }]]);
  assert.deepEqual(await createFetcher({ exec }).fixingChanges('ruvnet/ruflo#3434'),
    [{ repo: 'ruvnet/ruflo', pr: 3434, sha: '856249ed7e35e604fa58a3b93179570d7998b9d3', mergedAt: '2026-09-26T22:31:21Z' }]);
});

test('contains: behind or identical is contained, a missing tag is unknown, other failures throw', async () => {
  const sha = '856249ed7e35e604fa58a3b93179570d7998b9d3';
  const behind = JSON.stringify(confirmations.compare[`ruvnet/ruflo v3.46.0...${sha}`]);
  const { exec, calls } = fakeExec([
    [/compare\/v3\.46\.0\.\.\./, { status: 0, stdout: behind, stderr: '' }],
    [/compare\/v3\.46\.1\.\.\./, { status: 0, stdout: JSON.stringify({ status: 'identical', ahead_by: 0, behind_by: 0 }), stderr: '' }],
    [/compare\/v3\.45\.0\.\.\./, { status: 0, stdout: JSON.stringify({ status: 'ahead', ahead_by: 3, behind_by: 0 }), stderr: '' }],
    [/compare\/v3\.44\.0\.\.\./, { status: 0, stdout: JSON.stringify({ status: 'diverged', ahead_by: 3, behind_by: 2 }), stderr: '' }],
    [/compare\/(?:3\.46\.0|v9\.9\.9|9\.9\.9)\.\.\./, { status: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' }],
    [/compare\/v7\.7\.7\.\.\./, { status: 1, stdout: '', stderr: 'gh: API rate limit exceeded (HTTP 403)' }],
  ]);
  const fetcher = createFetcher({ exec });
  assert.deepEqual(await fetcher.contains('ruvnet/ruflo', ['v3.46.0', '3.46.0'], sha), { ref: 'v3.46.0', contained: true });
  assert.deepEqual(await fetcher.contains('ruvnet/ruflo', ['v3.46.1'], sha), { ref: 'v3.46.1', contained: true });
  assert.deepEqual(await fetcher.contains('ruvnet/ruflo', ['v3.45.0'], sha), { ref: 'v3.45.0', contained: false });
  assert.deepEqual(await fetcher.contains('ruvnet/ruflo', ['v3.44.0'], sha), { ref: 'v3.44.0', contained: false });
  assert.deepEqual(await fetcher.contains('ruvnet/ruflo', ['v9.9.9', '9.9.9'], sha), { ref: null, contained: null });
  await assert.rejects(fetcher.contains('ruvnet/ruflo', ['v7.7.7'], sha), /rate limit/);
  await assert.rejects(fetcher.contains('ruvnet/ruflo', ['v1.0.0'], 'not-a-sha'), /not a commit/);
  await assert.rejects(fetcher.contains('ruvnet/ruflo', ['v1.0.0;rm'], sha), /not a tag name/);
  assert.ok(calls.every((call) => call.startsWith('gh api repos/ruvnet/ruflo/compare/')), 'read-only: compare only');
});

test('bundled resolves the agentdb version the newest Ruflo installs', async () => {
  const manifests = {
    'ruflo@3.46.1': { name: 'ruflo', version: '3.46.1', dependencies: { '@claude-flow/cli': '^3.33.0' } },
    '@claude-flow/cli@3.46.1': { name: '@claude-flow/cli', version: '3.46.1', dependencies: {}, optionalDependencies: { agentdb: '^3.0.0-alpha.17' } },
  };
  const { exec, calls } = fakeExec([
    [/^npm view ruflo version --json$/, { status: 0, stdout: '"3.46.1"', stderr: '' }],
    [/^npm view ruflo@3\.46\.1 --json$/, { status: 0, stdout: JSON.stringify(manifests['ruflo@3.46.1']), stderr: '' }],
    [/^npm view @claude-flow\/cli@\^3\.33\.0 version --json$/, { status: 0, stdout: '["3.45.0","3.46.0","3.46.1"]', stderr: '' }],
    [/^npm view @claude-flow\/cli@3\.46\.1 --json$/, { status: 0, stdout: JSON.stringify(manifests['@claude-flow/cli@3.46.1']), stderr: '' }],
    [/^npm view agentdb@\^3\.0\.0-alpha\.17 version --json$/, { status: 0, stdout: '["3.0.0-alpha.9","3.0.0-alpha.20","3.0.0-alpha.17"]', stderr: '' }],
  ]);
  const result = await createFetcher({ exec }).bundled(['ruflo', '@claude-flow/cli'], 'agentdb');
  assert.deepEqual(result, { carrier: 'ruflo', carrierVersion: '3.46.1', version: '3.0.0-alpha.20', basis: 'ruflo 3.46.1 → @claude-flow/cli 3.46.1 → agentdb 3.0.0-alpha.20' });
  assert.ok(calls.every((call) => call.startsWith('npm view ')), 'read-only: npm view only');
});

test('a single npm range match is a bare string; a missing dependency is reported, not thrown', async () => {
  assert.equal(maxVersion('3.0.0-alpha.20'), '3.0.0-alpha.20');
  assert.equal(maxVersion(['3.0.0-alpha.9', '3.0.0-alpha.20']), '3.0.0-alpha.20');
  assert.equal(maxVersion([]), null);
  const { exec } = fakeExec([
    [/^npm view ruflo version --json$/, { status: 0, stdout: '"9.0.0"', stderr: '' }],
    [/^npm view ruflo@9\.0\.0 --json$/, { status: 0, stdout: JSON.stringify({ name: 'ruflo', version: '9.0.0', dependencies: {} }), stderr: '' }],
  ]);
  const result = await createFetcher({ exec }).bundled(['ruflo', '@claude-flow/cli'], 'agentdb');
  assert.equal(result.version, null);
  assert.match(result.basis, /ruflo 9\.0\.0 does not depend on @claude-flow\/cli/);
  const noMatch = fakeExec([
    [/^npm view ruflo version --json$/, { status: 0, stdout: '"3.46.1"', stderr: '' }],
    [/^npm view ruflo@3\.46\.1 --json$/, { status: 0, stdout: JSON.stringify({ name: 'ruflo', version: '3.46.1', dependencies: { agentdb: '^99.0.0' } }), stderr: '' }],
    [/^npm view agentdb@\^99\.0\.0 version --json$/, { status: 1, stdout: '', stderr: 'npm error code E404\nnpm error 404 No match found for version ^99.0.0' }],
  ]);
  const none = await createFetcher({ exec: noMatch.exec }).bundled(['ruflo'], 'agentdb');
  assert.equal(none.version, null);
  assert.match(none.basis, /no published agentdb satisfies \^99\.0\.0/);
  const offline = fakeExec([[/^npm view ruflo version --json$/, { status: 1, stdout: '', stderr: 'npm error code ENOTFOUND' }]]);
  await assert.rejects(createFetcher({ exec: offline.exec }).bundled(['ruflo'], 'agentdb'), /ENOTFOUND/);
  await assert.rejects(createFetcher({ exec: offline.exec }).bundled(['ruflo;rm'], 'agentdb'), /not a package name/);
});

test('an AgentDB fix is released only when the newest Ruflo bundles a fixed agentdb', () => {
  const gate = { channel: 'npm', name: 'agentdb', minVersion: '3.0.0-alpha.21', bundledBy: ['ruflo', '@claude-flow/cli'] };
  const target = entry('ruvnet/agentdb#26', { dependency: 'ruflo', doneWhen: { state: 'closed-completed', release: gate } });
  const agentdb = { versions: [{ version: '3.0.0-alpha.21', publishedAt: '2026-10-01T00:00:00Z' }], latest: '3.0.0-alpha.21' };
  const thread = closedThread('ruvnet/agentdb#26', '2026-09-30T00:00:00Z');
  const behind = classifyEntry(target, { thread, release: agentdb, bundle: { carrier: 'ruflo', carrierVersion: '3.46.1', version: '3.0.0-alpha.20', basis: 'x' } }, context);
  assert.ok(behind.groups.includes('fixed-unreleased'));
  assert.match(behind.release.basis, /ruflo 3\.46\.1 bundles agentdb 3\.0\.0-alpha\.20/);
  const bundled = classifyEntry(target, { thread, release: agentdb, bundle: { carrier: 'ruflo', carrierVersion: '3.47.0', version: '3.0.0-alpha.21', basis: 'x' } }, context);
  assert.ok(bundled.groups.includes('released-actionable'));
  assert.equal(bundled.release.version, '3.0.0-alpha.21', 'the version is the fixed agentdb, which no Ruflo release changes');
  assert.equal(bundled.release.carrierVersion, '3.47.0', 'the Ruflo that bundles it stays in the report');
  assert.match(bundled.release.basis, /ruflo 3\.47\.0 bundles agentdb 3\.0\.0-alpha\.21/);
  assert.equal(bundled.release.date, '2026-10-01');
  const unknown = classifyEntry(target, { thread, release: agentdb, bundle: null }, context);
  assert.ok(unknown.groups.includes('unchecked'));
  // An agentdb publish alone (no recorded or confirmed fixed version) never counts as released.
  const open = { ...gate, minVersion: null };
  const unproven = classifyEntry(entry('ruvnet/agentdb#26', { dependency: 'ruflo', doneWhen: { state: 'closed-completed', release: open } }),
    { thread, release: agentdb, confirmation: { changes: [], checks: [] }, bundle: { carrier: 'ruflo', carrierVersion: '3.47.0', version: '3.0.0-alpha.21', basis: 'x' } }, context);
  assert.ok(unproven.groups.includes('release-unconfirmed'));
  assert.match(unproven.release.basis, /ruflo 3\.47\.0 bundles agentdb 3\.0\.0-alpha\.21/);
});

test('a new Ruflo release does not change an AgentDB released ledger line', () => {
  const gate = { channel: 'npm', name: 'agentdb', minVersion: '3.0.0-alpha.21', bundledBy: ['ruflo', '@claude-flow/cli'] };
  const registry = registryWith([entry('ruvnet/agentdb#26', { dependency: 'ruflo', doneWhen: { state: 'closed-completed', release: gate } })]);
  const agentdb = { versions: [{ version: '3.0.0-alpha.21', publishedAt: '2026-10-01T00:00:00Z' }], latest: '3.0.0-alpha.21' };
  const lineWith = (carrierVersion) => {
    const bundle = { carrier: 'ruflo', carrierVersion, version: '3.0.0-alpha.21', basis: 'x' };
    const report = buildReport(registry, new Map([['ruvnet/agentdb#26', { thread: closedThread('ruvnet/agentdb#26', '2026-09-30T00:00:00Z'), release: agentdb, bundle }]]), { now: NOW });
    return ledgerEvents(report, registry, { since: '2026-09-26T00:00:00Z' }).find((event) => event.event === 'released').line;
  };
  assert.equal(lineWith('3.47.0'), 'UPSTREAM-WATCH ruvnet/agentdb#26 released 2026-10-01 version=3.0.0-alpha.21 branch=upstream/ruvnet-agentdb-26');
  assert.equal(lineWith('3.47.1'), lineWith('3.47.0'), 'one recorded line covers every later Ruflo');
});

test('bundled can start from a given carrier version: what the support-window floor installs', async () => {
  const { exec, calls } = fakeExec([
    [/^npm view ruflo@3\.39\.0 --json$/, { status: 0, stdout: JSON.stringify({ name: 'ruflo', version: '3.39.0', dependencies: { '@claude-flow/cli': '~3.39.0' } }), stderr: '' }],
    [/^npm view @claude-flow\/cli@~3\.39\.0 version --json$/, { status: 0, stdout: '["3.39.0","3.39.2"]', stderr: '' }],
    [/^npm view @claude-flow\/cli@3\.39\.2 --json$/, { status: 0, stdout: JSON.stringify({ name: '@claude-flow/cli', version: '3.39.2', optionalDependencies: { agentdb: '3.0.0-alpha.17' } }), stderr: '' }],
    [/^npm view agentdb@3\.0\.0-alpha\.17 version --json$/, { status: 0, stdout: '"3.0.0-alpha.17"', stderr: '' }],
  ]);
  const fetcher = createFetcher({ exec });
  const result = await fetcher.bundled(['ruflo', '@claude-flow/cli'], 'agentdb', '3.39.0');
  assert.deepEqual(result, { carrier: 'ruflo', carrierVersion: '3.39.0', version: '3.0.0-alpha.17', basis: 'ruflo 3.39.0 → @claude-flow/cli 3.39.2 → agentdb 3.0.0-alpha.17' });
  assert.ok(!calls.includes('npm view ruflo version --json'), 'the given version replaces the newest');
  await assert.rejects(fetcher.bundled(['ruflo'], 'agentdb', '3.39.0;rm'), /not a version/);
  const missing = fakeExec([[/^npm view ruflo@3\.39\.0 --json$/, { status: 1, stdout: '', stderr: 'npm error code E404' }]]);
  await assert.rejects(createFetcher({ exec: missing.exec }).bundled(['ruflo'], 'agentdb', '3.39.0'), /E404/);
});

// Decision B3-D5: an AgentDB fix delivered through Ruflo counts only when the
// oldest supported Ruflo (the support-window floor) bundles a fixed agentdb.
test('an AgentDB fix waits until the oldest supported Ruflo bundles it', () => {
  const gate = { channel: 'npm', name: 'agentdb', minVersion: '3.0.0-alpha.21', bundledBy: ['ruflo', '@claude-flow/cli'] };
  const registry = registryWith([entry('ruvnet/agentdb#26', { dependency: 'ruflo', doneWhen: { state: 'closed-completed', release: gate } })]);
  const agentdb = { versions: [{ version: '3.0.0-alpha.21', publishedAt: '2026-10-01T00:00:00Z' }], latest: '3.0.0-alpha.21' };
  const thread = closedThread('ruvnet/agentdb#26', '2026-09-30T00:00:00Z');
  const reportWith = (carrierVersion, floorVersion) => {
    const state = { thread, release: agentdb, bundle: { carrier: 'ruflo', carrierVersion, version: '3.0.0-alpha.21', basis: 'x' } };
    if (floorVersion !== undefined) state.floorBundle = { carrier: 'ruflo', carrierVersion: '3.41.0', version: floorVersion, basis: 'y' };
    return buildReport(registry, new Map([['ruvnet/agentdb#26', state]]), { now: NOW, supportFloor: '3.41.0' });
  };
  const lineOf = (report) => ledgerEvents(report, registry, { since: '2026-09-26T00:00:00Z' }).find((event) => event.event === 'released')?.line;
  const held = reportWith('3.47.0', '3.0.0-alpha.20');
  const item = held.entries[0];
  assert.ok(item.groups.includes('waiting-for-window'), item.groups.join(','));
  assert.ok(!item.groups.includes('released-actionable'));
  assert.equal(item.dispatch, null);
  assert.deepEqual(item.window, { floor: '3.41.0', needs: 'agentdb 3.0.0-alpha.21', floorBundles: 'agentdb 3.0.0-alpha.20' });
  assert.match(renderReport(held), /the oldest supported Ruflo, 3\.41\.0, bundles agentdb 3\.0\.0-alpha\.20/);
  assert.equal(lineOf(held), 'UPSTREAM-WATCH ruvnet/agentdb#26 released 2026-10-01 version=3.0.0-alpha.21');
  assert.equal(lineOf(reportWith('3.47.1', '3.0.0-alpha.20')), lineOf(held), 'a newer Ruflo does not change the held line');
  const released = reportWith('3.47.0', '3.0.0-alpha.21');
  assert.ok(released.entries[0].groups.includes('released-actionable'));
  assert.equal(released.entries[0].window, undefined);
  assert.equal(lineOf(released), 'UPSTREAM-WATCH ruvnet/agentdb#26 released 2026-10-01 version=3.0.0-alpha.21 branch=upstream/ruvnet-agentdb-26');
  assert.equal(lineOf(reportWith('3.47.1', '3.0.0-alpha.22')), lineOf(released), 'the released line stays stable');
  // The floor's bundle could not be resolved: "Could not check", never released.
  const unresolved = reportWith('3.47.0', undefined).entries[0];
  assert.ok(unresolved.groups.includes('unchecked'), unresolved.groups.join(','));
  assert.ok(!unresolved.groups.includes('released-actionable'));
  assert.match(unresolved.release.basis, /could not resolve the agentdb that ruflo 3\.41\.0 bundles/);
});

test('an AgentDB entry recorded as released still waits for the floor to bundle the fix', () => {
  const gate = { channel: 'npm', name: 'agentdb', minVersion: '3.0.0-alpha.21', bundledBy: ['ruflo', '@claude-flow/cli'] };
  const recorded = entry('ruvnet/agentdb#26', {
    dependency: 'ruflo', status: 'released', history: [{ date: '2026-09-26', event: 'registered' }, { date: '2026-10-01', event: 'released' }],
    doneWhen: { state: 'closed-completed', release: gate },
  });
  const windowed = { ...context, supportFloor: '3.41.0' };
  const thread = closedThread('ruvnet/agentdb#26', '2026-09-30T00:00:00Z');
  const held = classifyEntry(recorded, { thread, floorBundle: { carrier: 'ruflo', carrierVersion: '3.41.0', version: '3.0.0-alpha.20', basis: 'y' } }, windowed);
  assert.ok(held.groups.includes('waiting-for-window'), held.groups.join(','));
  assert.ok(!held.groups.includes('workaround-carried'));
  assert.equal(held.dispatch, null);
  const ready = classifyEntry(recorded, { thread, floorBundle: { carrier: 'ruflo', carrierVersion: '3.41.0', version: '3.0.0-alpha.21', basis: 'y' } }, windowed);
  assert.ok(ready.groups.includes('workaround-carried'), ready.groups.join(','));
  assert.match(ready.dispatch.branch, /^upstream\/ruvnet-agentdb-26$/);
});

test('the watch resolves what the floor Ruflo bundles, with the same "Could not check" handling', async () => {
  const gate = { channel: 'npm', name: 'agentdb', minVersion: '3.0.0-alpha.21', bundledBy: ['ruflo', '@claude-flow/cli'] };
  const agentdb = { versions: [{ version: '3.0.0-alpha.21', publishedAt: '2026-09-26T00:00:00Z' }], latest: '3.0.0-alpha.21' };
  const calls = [];
  const fetcher = (floorBundle) => ({
    auth: async () => ({ ok: true }),
    thread: async (id) => closedThread(id, '2026-09-25T00:00:00Z'),
    release: async ({ name }) => (name === 'ruflo' ? releaseFacts('npm', npm.ruflo) : agentdb),
    fixingChanges: async () => [],
    contains: async () => ({ ref: null, contained: null }),
    bundled: async (chain, name, at) => {
      calls.push(`${chain.join('>')}>${name}${at ? `@${at}` : ''}`);
      return at ? floorBundle(at) : { carrier: 'ruflo', carrierVersion: '3.47.0', version: '3.0.0-alpha.21', basis: 'x' };
    },
  });
  await withRegistryFile([entry('ruvnet/agentdb#26', { dependency: 'ruflo', doneWhen: { state: 'closed-completed', release: gate } })], async (file) => {
    const out = capture();
    await main(['report', '--json', '--registry', file], {
      fetcher: fetcher((at) => ({ carrier: 'ruflo', carrierVersion: at, version: '3.0.0-alpha.20', basis: 'y' })), stdout: out.stream, stderr: capture().stream, now: NOW,
    });
    const report = JSON.parse(out.text());
    const floor = report.supportWindow.floor;
    assert.match(floor, /^3\.\d+\.0$/);
    assert.deepEqual(calls, ['ruflo>@claude-flow/cli>agentdb', `ruflo>@claude-flow/cli>agentdb@${floor}`]);
    assert.deepEqual(report.groups.find((group) => group.key === 'waiting-for-window').items.map((item) => item.id), ['ruvnet/agentdb#26']);
    assert.equal(report.counts['released-actionable'], 0);
    const failed = capture();
    await main(['report', '--json', '--registry', file], {
      fetcher: fetcher(() => { throw new Error('npm view ruflo failed: ETIMEDOUT'); }), stdout: failed.stream, stderr: capture().stream, now: NOW,
    });
    const broken = JSON.parse(failed.text());
    assert.deepEqual(broken.groups.find((group) => group.key === 'unchecked').items.map((item) => item.id), ['ruvnet/agentdb#26']);
    assert.equal(broken.counts['released-actionable'] + broken.counts['waiting-for-window'], 0);
    assert.ok(broken.fetchErrors.some((item) => item.id === 'ruvnet/agentdb#26' && /ETIMEDOUT/.test(item.error)));
  });
});

test('collect resolves each bundling chain once and reports a failure as "Could not check"', async () => {
  const gate = { channel: 'npm', name: 'agentdb', minVersion: '3.0.0-alpha.21', bundledBy: ['ruflo', '@claude-flow/cli'] };
  const agentdbEntry = (id) => entry(id, { dependency: 'ruflo', doneWhen: { state: 'closed-completed', release: gate } });
  const agentdb = { versions: [{ version: '3.0.0-alpha.21', publishedAt: '2026-09-26T00:00:00Z' }], latest: '3.0.0-alpha.21' };
  const calls = [];
  const fetcher = (result) => ({
    auth: async () => ({ ok: true }),
    thread: async (id) => closedThread(id, '2026-09-25T00:00:00Z'),
    release: async () => agentdb,
    fixingChanges: async () => [],
    contains: async () => ({ ref: null, contained: null }),
    bundled: async (chain, name) => { calls.push(`${chain.join('>')}>${name}`); return result(); },
  });
  await withRegistryFile([agentdbEntry('ruvnet/agentdb#26'), agentdbEntry('ruvnet/agentdb#27')], async (file) => {
    const out = capture();
    await main(['report', '--json', '--registry', file], { fetcher: fetcher(() => ({ carrier: 'ruflo', carrierVersion: '3.47.0', version: '3.0.0-alpha.21', basis: 'x' })), stdout: out.stream, stderr: capture().stream, now: NOW });
    assert.deepEqual(JSON.parse(out.text()).groups.find((group) => group.key === 'released-actionable').items.map((item) => item.id), ['ruvnet/agentdb#26', 'ruvnet/agentdb#27']);
    assert.deepEqual(calls, ['ruflo>@claude-flow/cli>agentdb'], 'one resolution per chain');
    const failed = capture();
    await main(['report', '--json', '--registry', file], { fetcher: fetcher(() => { throw new Error('npm view ruflo failed: ETIMEDOUT'); }), stdout: failed.stream, stderr: capture().stream, now: NOW });
    const report = JSON.parse(failed.text());
    assert.deepEqual(report.groups.find((group) => group.key === 'unchecked').items.map((item) => item.id), ['ruvnet/agentdb#26', 'ruvnet/agentdb#27']);
    assert.ok(report.fetchErrors.some((item) => /ETIMEDOUT/.test(item.error)));
  // Its fake npm has no Ruflo release dates, so no window floor; this test is about the chain.
  }, { supportWindow: false });
  // Without a recorded minVersion (every live agentdb gate), a failed resolution is still "Could not check".
  const unrecorded = entry('ruvnet/agentdb#28', { dependency: 'ruflo', doneWhen: { state: 'closed-completed', release: { ...gate, minVersion: null } } });
  await withRegistryFile([unrecorded], async (file) => {
    const failed = capture();
    await main(['report', '--json', '--registry', file], { fetcher: fetcher(() => { throw new Error('npm view ruflo failed: ETIMEDOUT'); }), stdout: failed.stream, stderr: capture().stream, now: NOW });
    const report = JSON.parse(failed.text());
    assert.deepEqual(report.groups.find((group) => group.key === 'unchecked').items.map((item) => item.id), ['ruvnet/agentdb#28']);
    assert.equal(report.counts['release-unconfirmed'], 0);
    assert.match(report.entries.find((item) => item.id === 'ruvnet/agentdb#28').release.basis, /could not resolve the agentdb that ruflo bundles/);
  });
});

function fixtureFetcher({ authenticated = true } = {}) {
  return {
    auth: async () => (authenticated ? { ok: true } : { ok: false, message: 'gh is not authenticated; run `gh auth login`, then re-run.' }),
    thread: async (id) => {
      if (!threads[id]) throw new Error(`no fixture for ${id}`);
      return clone(threads[id]);
    },
    release: async ({ name }) => {
      if (!npm[name]) throw new Error(`no fixture for ${name}`);
      return releaseFacts('npm', npm[name]);
    },
    fixingChanges: async () => [],
    contains: async () => ({ ref: null, contained: null }),
    bundled: async () => null,
  };
}

// `supportWindow: false` drops the Ruflo support window, so a test about
// release confirmation is not also held for the window (ADR-0041 §7).
async function withRegistryFile(watch, run, { supportWindow = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-watch-cli-'));
  try {
    const document = JSON.parse(fs.readFileSync(UPSTREAM_REGISTRY_FILE, 'utf8'));
    document.watch = watch;
    if (!supportWindow) for (const policy of document.dependencyPolicies) delete policy.supportWindow;
    // Pin the verification window around NOW instead of inheriting the live registry's dates.
    document.lastVerifiedAt = '2026-09-26';
    document.lastCheckedAt = '2026-09-26';
    for (const constraint of document.constraints) constraint.nextRetestAt = '2026-10-03';
    // Every constraint issue needs a watch entry; retired ones are never fetched.
    for (const constraint of document.constraints.filter((item) => item.issue)) {
      const id = constraint.issue.replace('https://github.com/', '').replace('/issues/', '#');
      const existing = watch.find((item) => item.id === id);
      if (existing) {
        existing.constraintIds = [...existing.constraintIds, constraint.id];
        continue;
      }
      watch.push(entry(id, {
        status: 'retired', dependency: constraint.dependency, constraintIds: [constraint.id],
        doneWhen: { state: 'closed-completed', release: null },
      }));
    }
    const file = path.join(root, 'registry.json');
    fs.writeFileSync(file, JSON.stringify(document));
    return await run(file);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function capture() {
  const out = [];
  return { stream: { write: (chunk) => { out.push(String(chunk)); return true; } }, text: () => out.join('') };
}

test('usage errors exit 2; everything else exits 0', async () => {
  for (const argv of [[], ['frobnicate'], ['check'], ['check', '--since', 'yesterday'], ['report', '--concurrency', '0'], ['report', '--wat'], ['comment'], ['check', '--since', '2026-09-26', '--ledger', 'x']]) {
    const err = capture();
    assert.equal(await main(argv, { fetcher: fixtureFetcher(), stdout: capture().stream, stderr: err.stream, now: NOW }), 2, argv.join(' '));
    assert.match(err.text(), /usage: node scripts\/upstream-watch\.mjs/i);
  }
});

test('report --json from recorded fixtures, then the plain-text report', async () => {
  await withRegistryFile([entry('ruvnet/ruflo#3153', { relation: 'commented' }), entry('stuinfla/ruvnet-brain#331', { dependency: 'ruvnet-brain' })], async (file) => {
    const out = capture();
    assert.equal(await main(['report', '--json', '--registry', file], { fetcher: fixtureFetcher(), stdout: out.stream, stderr: capture().stream, now: NOW }), 0);
    const report = JSON.parse(out.text());
    assert.equal(report.mode, 'live');
    assert.equal(report.counts['needs-reply'], 1);
    assert.equal(report.counts.waiting, 1);
    const text = capture();
    assert.equal(await main(['report', '--registry', file], { fetcher: fixtureFetcher(), stdout: text.stream, stderr: capture().stream, now: NOW }), 0);
    const lines = text.text().split('\n');
    assert.match(lines[0], /^Upstream watch/);
    assert.match(lines[1], /last checked 2026-09-26, last verified 2026-09-26/);
    assert.ok(text.text().indexOf('Needs our reply') < text.text().indexOf('https://github.com/ruvnet/ruflo/issues/3153'), 'counts come before items');
    assert.match(text.text(), /acknowledged by stuinfla/);
  });
});

test('an unauthenticated gh degrades to the registry-only report and still exits 0', async () => {
  await withRegistryFile([entry('ruvnet/ruflo#2670', { status: 'released' })], async (file) => {
    const out = capture();
    const err = capture();
    assert.equal(await main(['report', '--registry', file], { fetcher: fixtureFetcher({ authenticated: false }), stdout: out.stream, stderr: err.stream, now: NOW }), 0);
    assert.match(err.text(), /gh auth login/);
    assert.match(out.text(), /offline/);
    assert.match(out.text(), /ruvnet\/ruflo#2670/);
  });
});

test('check --since prints sentinel lines', async () => {
  await withRegistryFile([entry('ruvnet/ruflo#3153', { relation: 'commented' })], async (file) => {
    const out = capture();
    assert.equal(await main(['check', '--since', '2026-09-03T00:00:00Z', '--registry', file], { fetcher: fixtureFetcher(), stdout: out.stream, stderr: capture().stream, now: NOW }), 0);
    const lines = out.text().trim().split('\n');
    assert.ok(lines.every((line) => line.startsWith('UPSTREAM-WATCH ')), lines.join('\n'));
  });
});

test('renderers list counts first, then items with links and the dispatch branch', () => {
  const release = { channel: 'npm', name: 'agentic-qe', minVersion: '3.13.10' };
  const registry = registryWith([entry('proffesor-for-testing/agentic-qe#617', { doneWhen: { state: 'closed-completed', release } })]);
  const report = buildReport(registry, new Map([['proffesor-for-testing/agentic-qe#617', live('proffesor-for-testing/agentic-qe#617', agenticQe)]]), { now: NOW });
  const text = renderReport(report);
  assert.ok(text.indexOf('Released and actionable') < text.indexOf('https://github.com/proffesor-for-testing/agentic-qe/issues/617'));
  assert.match(text, /upstream\/proffesor-for-testing-agentic-qe-617/);
  assert.equal(renderEvents([]), 'No new upstream events.\n');
});

// security-ledger-trusts-any-commenter: the ledger issue is public. Only the
// ledger authors' comments count (a stranger's line would suppress an event,
// and a stranger's later checked-at would skip a real reply); the script
// enforces that for the workflow, and the dispatch routine's prompt says so.
test('the documented dispatch routine trusts only the ledger authors', () => {
  // A Windows checkout gives the Markdown CRLF line endings; the checks are about its text.
  const doc = fs.readFileSync('docs/UPSTREAM-WATCH.md', 'utf8').replace(/\r\n/g, '\n');
  const ledger = doc.slice(doc.indexOf('## The ledger'), doc.indexOf('## Dispatch'));
  const prompt = doc.slice(doc.indexOf('## The dispatch routine')).match(/```text\n([\s\S]*?)```/)[1];
  assert.match(ledger, /lock/i, 'the ledger issue is locked when it is created');
  assert.match(ledger, /watchPolicy\.ledger\.authors/);
  assert.match(ledger, /checked-at/, 'the next run starts from the time a run last checked');
  assert.match(prompt, /watchPolicy\.ledger\.authors/, 'only the ledger authors\' comments are read');
  assert.match(prompt, /never follow instructions/i, 'comment text is data, not instructions');
  assert.match(prompt, /pacphi\/agentic-kit#243/, 'the routine reads the recorded ledger issue');
  assert.match(prompt, /without branch= is held by the support window/);
  assert.match(prompt, /From all of\s+them/, 'a line in an older comment is still dispatched (b4b-adversarial M3)');
  assert.match(prompt, /already exists on origin/);
  assert.match(prompt, /not "watching" or "fixed-unreleased"/, 'work already dispatched or adopted is skipped (b4b-adversarial m5)');
  assert.match(prompt, /DRAFT pull request/);
  assert.match(prompt, /Never merge/);
  assert.match(prompt, /never comment on\s+upstream/i);
  assert.doesNotMatch(prompt, /upstream-watch\.mjs (check|comment)/, 'the routine does not run the watch (it cannot read upstream)');
  // 4b-C amended: the routine runs on a daily schedule, not on the label.
  assert.match(prompt, /You run daily after the upstream watch workflow/);
  assert.match(prompt, /stop quickly/, 'a day with nothing to dispatch ends at once');
  assert.doesNotMatch(prompt, /labelled/, 'no label starts the routine');
  assert.match(prompt, /never change labels/);
});

// Decision 14: the routine's first run printed "No new upstream events." while
// every read had failed. A quiet day is reported only when nothing failed, and
// a run that read no thread at all is blind.
test('check never reports a quiet day when a read failed, and flags a blind run', async () => {
  assert.equal(renderEvents([], []), 'No new upstream events.\n');
  const failed = renderEvents([], [{ id: 'ruvnet/ruflo#1', error: 'HTTP 403' }, { id: 'ruvnet/ruflo#2', error: 'HTTP 403' }]);
  assert.doesNotMatch(failed, /No new upstream events/);
  assert.match(failed, /could not check 2: ruvnet\/ruflo#1, ruvnet\/ruflo#2/);
  const broken = { ...fixtureFetcher(), thread: async (id) => { if (id === 'ruvnet/ruflo#3153') throw new Error('HTTP 403'); return clone(threads[id]); } };
  await withRegistryFile([entry('ruvnet/ruflo#3153', { relation: 'commented' })], async (file) => {
    const text = capture();
    await main(['check', '--since', '2026-09-26T00:00:00Z', '--registry', file], { fetcher: broken, stdout: text.stream, stderr: capture().stream, now: NOW });
    assert.doesNotMatch(text.text(), /No new upstream events/);
    const json = capture();
    await main(['check', '--since', '2026-09-26T00:00:00Z', '--json', '--registry', file], { fetcher: broken, stdout: json.stream, stderr: capture().stream, now: NOW });
    assert.equal(JSON.parse(json.text()).blind, true);
  });
  await withRegistryFile([entry('ruvnet/ruflo#3153', { relation: 'commented' }), entry('ruvnet/ruflo#3046', { relation: 'commented' })], async (file) => {
    const json = capture();
    await main(['check', '--since', '2026-09-26T00:00:00Z', '--json', '--registry', file], { fetcher: broken, stdout: json.stream, stderr: capture().stream, now: NOW });
    const result = JSON.parse(json.text());
    assert.equal(result.blind, false, 'one thread read is not blind');
    assert.ok(result.fetchErrors.some((item) => item.id === 'ruvnet/ruflo#3153'));
  });
  const offline = capture();
  await withRegistryFile([entry('ruvnet/ruflo#3153')], async (file) => {
    await main(['check', '--since', '2026-09-26T00:00:00Z', '--json', '--registry', file], { fetcher: fixtureFetcher({ authenticated: false }), stdout: offline.stream, stderr: capture().stream, now: NOW });
  });
  assert.equal(JSON.parse(offline.text()).blind, true, 'gh unusable is blind');
});

test('every ledger event has a plain sentence', () => {
  const at = (event, fields = {}, id = 'ruvnet/ruflo#1') => sentence({ id, event, date: '2026-09-27', fields });
  assert.equal(at('reply', { by: 'someone', at: '10:00:00Z' }), 'someone commented on `ruvnet/ruflo#1` on 2026-09-27 at 10:00:00Z; check whether it needs our reply.');
  assert.match(at('acknowledged', { by: 'bot' }), /automated acknowledgement/);
  assert.equal(at('closed', { reason: 'completed' }), '`ruvnet/ruflo#1` was closed upstream on 2026-09-27 (completed).');
  assert.match(at('merged'), /merged upstream on 2026-09-27/);
  assert.match(at('released', { version: '3.47.0', pr: 12, branch: 'upstream/ruvnet-ruflo-1' }), /\(pull request `#12`\) is released in 3\.47\.0 \(2026-09-27\); ak dispatches it on branch `upstream\/ruvnet-ruflo-1`\./);
  assert.match(at('released', { version: '3.47.0', commit: 'abc1234' }), /\(commit `abc1234`\).*keeps its workaround/);
  assert.match(at('reopened', { status: 'released' }), /open upstream again while the registry says released/);
  assert.match(at('stale'), /no upstream activity since 2026-09-27/);
  assert.match(at('retire-proposed'), /can be retired/);
  assert.match(at('retest-due', {}, 'ruflo-hooks-1'), /^Constraint `ruflo-hooks-1` was due for a retest on 2026-09-27\.$/);
  assert.match(at('idle', {}, 'registry'), /nothing is left to watch/);
});

// b4b-adversarial M2: a failed read of Ruflo's release dates leaves the
// support-window floor unknown. The workflow dispatches without a human, so
// an unknown floor holds every Ruflo-carried fix instead of releasing it.
test('an unknown support-window floor holds Ruflo-carried fixes', async () => {
  const confirmation = { changes: [change], checks: [{ version: '3.46.0', ref: 'v3.46.0', contained: true }] };
  const registry = registryWith([entry('ruvnet/ruflo#3194')]);
  const liveMap = new Map([['ruvnet/ruflo#3194', { thread: closedThread('ruvnet/ruflo#3194', '2026-09-26T22:31:23Z'), release: rufloFacts, confirmation }]]);
  const report = buildReport(registry, liveMap, { now: NOW, supportFloor: null, floorUnknown: true });
  const held = report.entries[0];
  assert.ok(held.groups.includes('waiting-for-window'), held.groups.join(','));
  assert.equal(held.dispatch, null);
  assert.deepEqual(held.window, { floor: null, needs: '3.46.0' });
  assert.match(renderReport(report), /the oldest supported Ruflo could not be read/);
  const line = ledgerEvents(report, registry, { since: '2026-09-26T00:00:00Z' }).find((event) => event.event === 'released').line;
  assert.doesNotMatch(line, /branch=/);
  // No window policy at all still holds nothing.
  assert.ok(!buildReport(registry, liveMap, { now: NOW }).entries[0].groups.includes('waiting-for-window'));
  // The script marks the floor unknown when Ruflo's release dates cannot be read.
  const failing = { ...fixtureFetcher(), release: async ({ name }) => { if (name === 'ruflo') throw new Error('npm view ruflo failed: ETIMEDOUT'); return releaseFacts('npm', npm[name]); } };
  await withRegistryFile([entry('ruvnet/ruflo#3153', { relation: 'commented' })], async (file) => {
    const out = capture();
    await main(['report', '--json', '--registry', file], { fetcher: failing, stdout: out.stream, stderr: capture().stream, now: NOW });
    assert.deepEqual(JSON.parse(out.text()).supportWindow, { floor: null, unknown: true });
  });
});

// b4b-adversarial m1: plain `owner/repo#n` or `#n` in the sentences would
// autolink (a bare #3421 points at this repository) and mention upstream threads.
test('the sentences keep thread ids and pull request numbers out of autolinks', () => {
  const text = sentence({ id: 'ruvnet/ruflo#3194', event: 'released', date: '2026-09-26', fields: { version: '3.46.0', pr: 3421, branch: 'upstream/ruvnet-ruflo-3194' } });
  assert.equal(text, 'The fix for `ruvnet/ruflo#3194` (pull request `#3421`) is released in 3.46.0 (2026-09-26); ak dispatches it on branch `upstream/ruvnet-ruflo-3194`.');
});
