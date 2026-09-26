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
  CITATION_DIRS, canonicalRepo, findCitations, scanCitations, unregisteredCitations,
} from '../../scripts/upstream-watch/citations.mjs';

const now = () => new Date('2026-09-27T12:00:00Z');
const document = () => JSON.parse(fs.readFileSync(UPSTREAM_REGISTRY_FILE, 'utf8'));
const ids = (text) => findCitations(text).map((citation) => citation.id);
// Synthetic fixture ids a test uses on purpose; each must still be cited where listed.
const SYNTHETIC = new Map([['ruvnet/ruflo#9001', ['tests/kit/conformance-tiers.test.mjs']]]);
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
  assert.ok(registry.watch.length > 60);
  assert.equal(registry.watchPolicy.staleAfterDays, 90);
  assert.equal(registry.watchPolicy.dispatch.merge, 'never');
  const constraints = loadUpstreamConstraints({ now });
  assert.equal(constraints.registryStatus, 'valid');
  assert.equal(constraints.watch, undefined, 'the hook audit projection does not carry the watch list');
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

test('every watched-repository thread cited in tracked source is registered', () => {
  const citations = new Map([...scanCitations({ root: process.cwd(), dirs: CITATION_DIRS })]
    .map(([id, files]) => [id, files.filter((file) => !SELF_CITING.some((prefix) => file.startsWith(prefix)))])
    .filter(([, files]) => files.length));
  const missing = unregisteredCitations(document().watch.map((item) => item.id), citations, SYNTHETIC);
  assert.deepEqual(missing, [], `register these in ${path.relative(process.cwd(), UPSTREAM_REGISTRY_FILE)} watch:\n${
    missing.map((item) => `${item.id} (${item.files.join(', ')})`).join('\n')}`);
  for (const [id, files] of SYNTHETIC) {
    for (const file of files) assert.ok((citations.get(id) ?? []).includes(file), `${id} is no longer cited in ${file}; drop it from SYNTHETIC`);
  }
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
