// The registry's `watch` list: its shape (validated by the shipped loader),
// its link to the constraints, and the guard that fails when tracked source
// cites a watched-repository thread the list does not register.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { UPSTREAM_REGISTRY_FILE, loadUpstreamConstraints, loadUpstreamRegistry } from '../../src/lib/hook-audit/upstream.mjs';
import {
  CITATION_DIRS, USER_DOC_EXEMPT, canonicalRepo, findCitations, scanCitations, unregisteredCitations, userFacingDocs,
} from '../../scripts/upstream-watch/citations.mjs';

const document = () => JSON.parse(fs.readFileSync(UPSTREAM_REGISTRY_FILE, 'utf8'));
// The clock follows the registry's last state re-read, so a weekly re-check is a data-only change.
const now = () => new Date(`${document().lastCheckedAt}T12:00:00Z`);
const ids = (text) => findCitations(text).map((citation) => citation.id);
// Synthetic fixture ids a test uses on purpose; each must still be cited where listed.
const SYNTHETIC = new Map([
  ['ruvnet/ruflo#9001', ['tests/kit/conformance-tiers.test.mjs']],
  // A placeholder id in an example command, not a real thread.
  ['ruvnet/ruflo#1234', ['docs/AUTHORING-HOST-ADAPTERS.md']],
]);
// The watch tooling's own tests and fixtures spell citations as data.
const SELF_CITING = ['tests/kit/upstream-watch-', 'tests/fixtures/upstream-watch/'];

function withRegistry(mutate, run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-watch-'));
  try {
    const doc = document();
    mutate(doc);
    const file = path.join(root, 'registry.json');
    fs.writeFileSync(file, JSON.stringify(doc));
    return run(loadUpstreamRegistry({ file, now }));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const entry = (doc, id) => doc.watch.find((item) => item.id === id);
const errorsOf = (mutate) => withRegistry(mutate, (result) => result.errors.join('\n'));

test('the registry carries the watch list and stays valid for the hook audit', () => {
  const registry = loadUpstreamRegistry({ now });
  assert.equal(registry.registryStatus, 'valid', registry.errors.join('\n'));
  // A second schema bump (another branch) must show up here rather than merge silently.
  assert.equal(document().schemaVersion, 6);
  assert.ok(registry.watch.length > 60);
  assert.equal(registry.watchPolicy.staleAfterDays, 90);
  assert.equal(registry.watchPolicy.dispatch.merge, 'never');
  const constraints = loadUpstreamConstraints({ now });
  assert.equal(constraints.registryStatus, 'valid');
  assert.equal(constraints.watch, undefined, 'the hook audit projection does not carry the watch list');
});

test('the ledger is issue #243 in the ledger repository', () => {
  const { ledger } = loadUpstreamRegistry({ now }).watchPolicy;
  assert.deepEqual({ repo: ledger.repo, issue: ledger.issue, issueTitle: ledger.issueTitle }, { repo: 'pacphi/agentic-kit', issue: 243, issueTitle: 'Upstream watch' });
  assert.match(errorsOf((doc) => { doc.watchPolicy.ledger.issue = 0; }), /watchPolicy\.ledger/);
  assert.match(errorsOf((doc) => { delete doc.watchPolicy.ledger.issue; }), /watchPolicy\.ledger/);
});

test('ruflo#3153 records that its third-party comments were reviewed', () => {
  const history = entry(document(), 'ruvnet/ruflo#3153').history;
  assert.ok(history.some((item) => item.event === 'reviewed' && item.date === '2026-09-27' && /sparkling/.test(item.note)));
  assert.equal(loadUpstreamRegistry({ now }).registryStatus, 'valid');
});

test('watch entries are rejected with their id when malformed', () => {
  const errors = errorsOf((doc) => {
    const item = entry(doc, 'ruvnet/ruflo#3194');
    Object.assign(item, { status: 'done', relation: 'authored', url: 'https://github.com/ruvnet/ruflo/pull/3194', extra: 1 });
    item.history = [{ date: '2026-02-30', event: 'registered' }];
  });
  for (const field of ['status', 'relation', 'url', 'date', 'extra']) {
    assert.match(errors, new RegExp(`ruvnet/ruflo#3194.*${field}`), field);
  }
});

test('mapping ties kitImpact and adjustment together', () => {
  const errors = errorsOf((doc) => {
    Object.assign(entry(doc, 'ruvnet/ruflo#3448'), { kitImpact: { refs: ['x'], files: [] } });
    Object.assign(entry(doc, 'ruvnet/ruflo#3194'), { kitImpact: null });
    Object.assign(entry(doc, 'ruvnet/ruflo#2935'), { kitImpact: { refs: [], files: [] } });
  });
  assert.match(errors, /ruvnet\/ruflo#3448.*unmapped/);
  assert.match(errors, /ruvnet\/ruflo#3194.*kitImpact/);
  assert.match(errors, /ruvnet\/ruflo#2935.*kitImpact/);
});

test('release gates, history order, duplicates and dependencies are checked', () => {
  const errors = errorsOf((doc) => {
    entry(doc, 'ruvnet/ruflo#3194').doneWhen.release = { channel: 'pypi', name: '', minVersion: 'soon' };
    entry(doc, 'ruvnet/ruflo#2670').history.reverse();
    entry(doc, 'ruvnet/ruflo#3449').dependency = 'left-pad';
    doc.watch.push({ ...entry(doc, 'ruvnet/ruflo#3193'), id: 'RUVNET/ruflo#3193' });
  });
  assert.match(errors, /ruvnet\/ruflo#3194.*release/);
  assert.match(errors, /ruvnet\/ruflo#2670.*history/);
  assert.match(errors, /ruvnet\/ruflo#3449.*dependency/);
  assert.match(errors, /duplicate/i);
});

test('a release gate may name its tag spelling', () => {
  const errors = errorsOf((doc) => { entry(doc, 'ruvnet/ruflo#3194').doneWhen.release.tagPattern = 'v-no-placeholder'; });
  assert.match(errors, /ruvnet\/ruflo#3194.*tagPattern/);
  assert.match(errorsOf((doc) => { entry(doc, 'ruvnet/ruflo#3194').doneWhen.release.tagPatern = 'v{version}'; }), /ruvnet\/ruflo#3194.*release/);
  const codex = document().watch.filter((item) => item.id.startsWith('openai/codex#') && item.doneWhen.release);
  assert.ok(codex.length > 0);
  assert.ok(codex.every((item) => item.doneWhen.release.tagPattern === 'rust-v{version}'));
});

test('AgentDB threads gate on what Ruflo bundles', () => {
  const agentdb = document().watch.filter((item) => item.id.startsWith('ruvnet/agentdb#'));
  assert.equal(agentdb.length, 3);
  for (const item of agentdb) {
    assert.equal(item.dependency, 'ruflo');
    assert.deepEqual(item.doneWhen.release.bundledBy, ['ruflo', '@claude-flow/cli']);
  }
  const errors = errorsOf((doc) => { entry(doc, 'ruvnet/agentdb#26').doneWhen.release.bundledBy = []; });
  assert.match(errors, /ruvnet\/agentdb#26.*bundledBy/);
  assert.match(errorsOf((doc) => { entry(doc, 'ruvnet/agentdb#26').doneWhen.release.bundledBy = ['ruflo', 'x y']; }), /ruvnet\/agentdb#26.*bundledBy/);
});

test('constraints and watch entries point at each other', () => {
  const unlinked = errorsOf((doc) => { entry(doc, 'ruvnet/ruflo#3167').constraintIds = []; });
  assert.match(unlinked, /ruflo-3\.38\.21-init-suppression-flags.*ruvnet\/ruflo#3167/);
  const missing = errorsOf((doc) => { doc.watch = doc.watch.filter((item) => item.id !== 'openai/codex#19679'); });
  assert.match(missing, /codex-0\.152\.1-skill-context-budget.*openai\/codex#19679/);
  const unknown = errorsOf((doc) => { entry(doc, 'ruvnet/ruflo#3194').constraintIds = ['no-such-constraint']; });
  assert.match(unknown, /ruvnet\/ruflo#3194.*no-such-constraint/);
});

test('tracking entries live in the ledger repository and track registered threads', () => {
  const errors = errorsOf((doc) => {
    entry(doc, 'pacphi/agentic-kit#240').tracks.push('ruvnet/ruflo#1');
    entry(doc, 'ruvnet/ruflo#3194').tracks = ['ruvnet/ruflo#3196'];
  });
  assert.match(errors, /pacphi\/agentic-kit#240.*ruvnet\/ruflo#1/);
  assert.match(errors, /ruvnet\/ruflo#3194.*tracks/);
  const tracking = document().watch.filter((item) => item.relation === 'tracking').map((item) => item.id).sort();
  assert.deepEqual(tracking, ['pacphi/agentic-kit#213', 'pacphi/agentic-kit#240']);
});

test('the tracking issues carry their whole upstream remainder', () => {
  const doc = document();
  const t213 = entry(doc, 'pacphi/agentic-kit#213');
  assert.deepEqual([...t213.tracks].sort(), ['ruvnet/ruflo#3196', 'ruvnet/ruflo#3446', 'ruvnet/ruflo#3450']);
  assert.ok(t213.history.some((item) => item.event === 'commented' && item.date === '2026-09-27'));
  for (const id of ['ruvnet/ruflo#2786', 'ruvnet/ruflo#3143', 'ruvnet/ruflo#2889', 'ruvnet/ruflo#3195']) assert.ok(entry(doc, id), id);
  // Two stores are deliberate (ruflo#2786): a unified path would be a red flag, not the fix ak waits for.
  assert.doesNotMatch(entry(doc, 'ruvnet/ruflo#3196').adjustment, /routes MCP memory operations to the CLI database/);
  assert.match(entry(doc, 'ruvnet/ruflo#3196').adjustment, /preservation or migration/);
  const t240 = entry(doc, 'pacphi/agentic-kit#240');
  assert.deepEqual([...t240.tracks].sort(), ['proffesor-for-testing/agentic-qe#574', 'proffesor-for-testing/agentic-qe#719']);
  assert.match(t240.adjustment, /agentic-qe#574/);
  assert.ok(t240.kitImpact.files.includes('src/lib/aqe-readiness.mjs'));
});

test('stale threads are mapped to what ak carries, or retired with a reason', () => {
  const doc = document();
  const clear = entry(doc, 'openai/codex#16045');
  assert.equal(clear.mapping, 'mapped');
  assert.deepEqual(clear.kitImpact.files, ['src/lib/host-health-connected.mjs']);
  assert.equal(clear.status, 'watching');
  const statusLine = entry(doc, 'openai/codex#16921');
  assert.equal(statusLine.status, 'retired');
  assert.match(statusLine.history.at(-1).note, /openai\/codex#17827/);
  const watched = entry(doc, 'openai/codex#17827');
  assert.equal(watched.status, 'watching');
  assert.equal(watched.adjustment, statusLine.adjustment);
  const groups = entry(doc, 'ruvnet/ruflo#952');
  assert.equal(groups.status, 'watching');
  assert.match(groups.adjustment, /execution/);
});

test('an invalid watch list makes the whole registry invalid for the hook audit too', () => {
  withRegistry((doc) => { entry(doc, 'ruvnet/ruflo#3194').status = 'done'; }, (result) => {
    assert.equal(result.registryStatus, 'invalid');
  });
});

test('canonicalRepo maps renamed repositories and rejects unwatched ones', () => {
  assert.equal(canonicalRepo('ruvnet', 'claude-flow'), 'ruvnet/ruflo');
  assert.equal(canonicalRepo('ruvnet', 'ruvector'), 'ruvnet/RuVector');
  assert.equal(canonicalRepo('sst', 'opencode'), 'anomalyco/opencode');
  assert.equal(canonicalRepo('nousresearch', 'hermes-agent'), 'NousResearch/hermes-agent');
  assert.equal(canonicalRepo('Vercel-Labs', 'agent-browser'), 'vercel-labs/agent-browser');
  assert.equal(canonicalRepo('ollama', 'ollama'), null);
  assert.equal(canonicalRepo('pacphi', 'agentic-kit'), null);
});

test('findCitations recognizes URLs, qualified ids, aliases and continuations', () => {
  assert.deepEqual(ids('see https://github.com/ruvnet/ruflo/issues/2670 for context'), ['ruvnet/ruflo#2670']);
  assert.deepEqual(findCitations('https://github.com/openai/codex/pull/18169').map((c) => c.kind), ['pr']);
  assert.deepEqual(ids('ruvnet/claude-flow#2962 and sst/opencode#38266'), ['ruvnet/ruflo#2962', 'anomalyco/opencode#38266']);
  assert.deepEqual(ids('Ruflo #3163; AQE #654; aqe PR #564'), [
    'ruvnet/ruflo#3163', 'proffesor-for-testing/agentic-qe#654', 'proffesor-for-testing/agentic-qe#564',
  ]);
  assert.deepEqual(ids('openai/codex #16921/#17827'), ['openai/codex#16921', 'openai/codex#17827']);
  assert.deepEqual(ids('filed as ruflo#3415–#3417'), ['ruvnet/ruflo#3415', 'ruvnet/ruflo#3416', 'ruvnet/ruflo#3417']);
  assert.deepEqual(ids('(ruflo#3196, #213)'), ['ruvnet/ruflo#3196']);
  assert.deepEqual(ids('upstream #2221 and pacphi/agentic-kit#240 and @claude-flow/codex#1'), []);
});

test('every watched-repository thread cited in tracked source or user-facing docs is registered', () => {
  const dirs = [...CITATION_DIRS, ...userFacingDocs(process.cwd())];
  const citations = new Map([...scanCitations({ root: process.cwd(), dirs })]
    .map(([id, files]) => [id, files.filter((file) => !SELF_CITING.some((prefix) => file.startsWith(prefix)))])
    .filter(([, files]) => files.length));
  const missing = unregisteredCitations(document().watch.map((item) => item.id), citations, SYNTHETIC);
  assert.deepEqual(missing, [], `register these in ${path.relative(process.cwd(), UPSTREAM_REGISTRY_FILE)} watch:\n${
    missing.map((item) => `${item.id} (${item.files.join(', ')})`).join('\n')}`);
  for (const [id, files] of SYNTHETIC) {
    for (const file of files) assert.ok((citations.get(id) ?? []).includes(file), `${id} is no longer cited in ${file}; drop it from SYNTHETIC`);
  }
});

test('user-facing docs are scanned; history and research are exempt by name', () => {
  const docs = userFacingDocs(process.cwd());
  assert.ok(docs.includes('README.md') && docs.includes('docs/HOST-SUPPORT.md') && docs.includes('docs/UPSTREAM-WATCH.md'));
  for (const [file, reason] of USER_DOC_EXEMPT) {
    assert.ok(!docs.includes(file), file);
    assert.ok(fs.existsSync(file), `${file} no longer exists; drop its exemption`);
    assert.match(reason, /\w/);
  }
  assert.ok(docs.every((file) => file === 'README.md' || /^docs\/[^/]+\.md$/.test(file)), 'only top-level guides; ADRs, audits, plans and research are history');
});

test('every kit file a watch entry names exists and still cites the thread', () => {
  const stale = document().watch.flatMap((item) => (item.kitImpact?.files ?? []).filter((file) => {
    if (!fs.existsSync(file)) return true;
    const content = fs.readFileSync(file, 'utf8');
    // A recognized citation, or a bare "#n" recorded by hand ("upstream #2221").
    return !findCitations(content).some((citation) => citation.id === item.id)
      && !new RegExp(`#${item.id.split('#')[1]}\\b`).test(content);
  }).map((file) => `${item.id}: ${file}`));
  assert.deepEqual(stale, [], 'the citation moved or was removed; update the entry');
});

test('every registered id is in a watched repository, spelled canonically', () => {
  const wrong = document().watch.filter((item) => item.relation !== 'tracking').filter((item) => {
    const [owner, repo] = item.id.split('#')[0].split('/');
    return canonicalRepo(owner, repo) !== `${owner}/${repo}`;
  }).map((item) => item.id);
  assert.deepEqual(wrong, []);
});

// docs-04: an upstream issue ak files is watched from the day it is filed,
// even before any source cites it (the citation guard cannot see it then).
// The audit record's list of filed upstream evidence is the source of truth.
test('every upstream thread the audit record lists as filed is registered', () => {
  const audit = fs.readFileSync('docs/audits/2026-09-26-issues-237-238-239-verification-and-decisions.md', 'utf8');
  const start = audit.indexOf('### Item 6 — new upstream evidence');
  const item6 = audit.slice(start, audit.indexOf('\n### ', start + 1));
  const filed = [...new Set(ids(item6))];
  assert.ok(filed.length >= 5, `found only ${filed.length} threads in Item 6`);
  const registered = new Set(document().watch.map((entry) => entry.id));
  assert.deepEqual(filed.filter((id) => !registered.has(id)), []);
});
