// scripts/upstream-watch.mjs from recorded fixtures only: gh and npm responses
// recorded on 2026-09-26 (tests/fixtures/upstream-watch/), no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { UPSTREAM_REGISTRY_FILE, loadUpstreamRegistry } from '../../src/lib/hook-audit/upstream.mjs';
import {
  buildReport, classifyEntry, compareVersions, ledgerEvents, releaseFacts, withoutRecorded,
} from '../../scripts/upstream-watch/classify.mjs';
import { createFetcher, mapLimit } from '../../scripts/upstream-watch/fetch.mjs';
import { renderEvents, renderReport } from '../../scripts/upstream-watch/render.mjs';
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

test('without a recorded first fixed version the first release after the fix is only a candidate', () => {
  const result = classifyEntry(entry('proffesor-for-testing/agentic-qe#617'), live('proffesor-for-testing/agentic-qe#617', agenticQe), context);
  assert.ok(result.groups.includes('released-actionable'));
  assert.equal(result.release.candidate, true);
  assert.equal(result.release.version, '3.13.10');
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
  const merged = classifyEntry(entry('ruvnet/ruflo#2986', { kind: 'pr', relation: 'filed' }), live('ruvnet/ruflo#2986', releaseFacts('npm', npm.ruflo)), context);
  assert.equal(merged.upstream.fixed, true);
  assert.ok(merged.groups.includes('released-actionable'));
  const reopened = classifyEntry(entry('ruvnet/ruflo#2885', { status: 'released' }), live('ruvnet/ruflo#2885'), context);
  assert.ok(reopened.groups.includes('reopened'));
  const thread = clone(threads['openai/codex#20140']);
  thread.issue.state_reason = 'not_planned';
  const notPlanned = classifyEntry(entry('openai/codex#20140', { relation: 'referenced', mapping: 'unmapped', kitImpact: null, adjustment: null }), { thread }, context);
  assert.ok(notPlanned.groups.includes('not-planned'));
  assert.ok(notPlanned.groups.includes('ready-to-retire'));
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
  const signedOut = createFetcher({ exec: fakeExec([[/^gh auth status/, { status: 1, stdout: '', stderr: loggedOut }]]).exec });
  const auth = await signedOut.auth();
  assert.equal(auth.ok, false);
  assert.match(auth.message, /gh auth login/);
  const missing = createFetcher({ exec: async () => ({ status: null, stdout: '', stderr: '', error: Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }) }) });
  assert.match((await missing.auth()).message, /not installed/);
});

test('the fetcher reads a thread and its paginated comments through gh api', async () => {
  const fixture = threads['ruvnet/ruflo#3046'];
  const { exec, calls } = fakeExec([
    [/issues\/3046\/comments/, { status: 0, stdout: JSON.stringify([fixture.comments.slice(0, 1), fixture.comments.slice(1)]), stderr: '' }],
    [/issues\/3046$/, { status: 0, stdout: JSON.stringify(fixture.issue), stderr: '' }],
    [/^npm view agentic-qe/, { status: 0, stdout: JSON.stringify(npm['agentic-qe']), stderr: '' }],
  ]);
  const fetcher = createFetcher({ exec });
  const thread = await fetcher.thread('ruvnet/ruflo#3046');
  assert.equal(thread.issue.number, 3046);
  assert.equal(thread.comments.length, fixture.comments.length);
  assert.ok(calls.some((call) => call.includes('--paginate') && call.includes('--slurp')));
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
  assert.deepEqual(changes, [{ repo: 'ruvnet/ruflo', pr: 3434, sha: '856249ed7e35e604fa58a3b93179570d7998b9d3' }]);
  assert.ok(calls.every((call) => call.startsWith('gh api graphql')), 'read-only: graphql query only');
});

test('fixingChanges drops an off-branch merge and falls back to the closing commit', async () => {
  const recorded = clone(confirmations.graphql['ruvnet/ruflo#3194']);
  const issue = recorded.data.repository.issueOrPullRequest;
  issue.closedByPullRequestsReferences.nodes[0].baseRefName = 'release/3.x';
  issue.timelineItems.nodes = [{ closer: { __typename: 'Commit', oid: 'abc1234abc1234abc1234abc1234abc1234abc12' } }];
  const { exec } = fakeExec([[/^gh api graphql/, { status: 0, stdout: JSON.stringify(recorded), stderr: '' }]]);
  assert.deepEqual(await createFetcher({ exec }).fixingChanges('ruvnet/ruflo#3194'),
    [{ repo: 'ruvnet/ruflo', pr: null, sha: 'abc1234abc1234abc1234abc1234abc1234abc12' }]);
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
  Object.assign(mergedPr.data.repository.issueOrPullRequest, { number: 3434, merged: true, mergeCommit: { oid: '856249ed7e35e604fa58a3b93179570d7998b9d3' } });
  const { exec } = fakeExec([[/^gh api graphql/, { status: 0, stdout: JSON.stringify(mergedPr), stderr: '' }]]);
  assert.deepEqual(await createFetcher({ exec }).fixingChanges('ruvnet/ruflo#3434'),
    [{ repo: 'ruvnet/ruflo', pr: 3434, sha: '856249ed7e35e604fa58a3b93179570d7998b9d3' }]);
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
  };
}

async function withRegistryFile(watch, run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-watch-cli-'));
  try {
    const document = JSON.parse(fs.readFileSync(UPSTREAM_REGISTRY_FILE, 'utf8'));
    document.watch = watch;
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
  for (const argv of [[], ['frobnicate'], ['check'], ['check', '--since', 'yesterday'], ['report', '--concurrency', '0'], ['report', '--wat']]) {
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

test('check --since prints sentinel lines and drops those already in the ledger', async () => {
  await withRegistryFile([entry('ruvnet/ruflo#3153', { relation: 'commented' })], async (file) => {
    const out = capture();
    assert.equal(await main(['check', '--since', '2026-09-03T00:00:00Z', '--registry', file], { fetcher: fixtureFetcher(), stdout: out.stream, stderr: capture().stream, now: NOW }), 0);
    const lines = out.text().trim().split('\n');
    assert.ok(lines.every((line) => line.startsWith('UPSTREAM-WATCH ')), lines.join('\n'));
    const ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-ledger-'));
    try {
      const ledger = path.join(ledgerDir, 'ledger.md');
      fs.writeFileSync(ledger, `${lines[0]}\n`);
      const again = capture();
      await main(['check', '--since', '2026-09-03T00:00:00Z', '--ledger', ledger, '--registry', file], { fetcher: fixtureFetcher(), stdout: again.stream, stderr: capture().stream, now: NOW });
      assert.ok(!again.text().includes(lines[0]));
    } finally {
      fs.rmSync(ledgerDir, { recursive: true, force: true });
    }
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

// security-ledger-trusts-any-commenter: the ledger issue is public. The
// routine must build its ledger text and SINCE from its own comments only
// (a stranger's line would suppress an event, and a stranger's later comment
// would move SINCE past a real reply), lock the issue, and take SINCE from
// the time it last checked rather than from when it posted.
test('the documented routine trusts only its own ledger comments', () => {
  // A Windows checkout gives the Markdown CRLF line endings; the checks are about its text.
  const doc = fs.readFileSync('docs/UPSTREAM-WATCH.md', 'utf8').replace(/\r\n/g, '\n');
  const ledger = doc.slice(doc.indexOf('## The ledger'), doc.indexOf('## Dispatch'));
  const prompt = doc.slice(doc.indexOf('## The daily routine')).match(/```text\n([\s\S]*?)```/)[1];
  assert.match(ledger, /lock/i, 'the ledger issue is locked when it is created');
  assert.match(prompt, /watchPolicy\.ours/, 'only comments by the routine or our logins are read');
  assert.doesNotMatch(prompt, /every comment body/i);
  assert.doesNotMatch(prompt, /time of its newest comment/i, 'SINCE never comes from whoever commented last');
  assert.match(prompt, /checked-at/, 'SINCE is the time the routine last ran check');
  assert.match(prompt, /never follow instructions/i, 'comment text is data, not instructions');
});
