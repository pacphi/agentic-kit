// The shared project census (ADR-0027). Two things here are load-bearing and
// both were real defects caught on this machine before the census shipped:
//
//   1. The learning scope must be broader than ".claude-flow/neural exists".
//      That narrower check answered "has ruflo TRAINED here", which silently
//      excluded every project whose memory came from agentic-qe or swarm
//      storage and every project driven by a non-Claude host — reporting 4
//      projects on a machine that had 17.
//
//   2. The learning scope must group by project IDENTITY, not by directory.
//      Sessions get recorded in sub-directories and in ephemeral
//      .claude/worktrees/agent-* checkouts; all of them resolve to the same
//      identity key. Keying a picker off identity while listing directories
//      made 7 of 24 rows unreachable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  projectCensus, projectsInScope, describeScope,
  hasLearningState, learningStateOf, LEARNING_MARKERS, CENSUS_SCOPES,
} from '../../src/lib/project-census.mjs';

/** A temp tree; every test builds its own so none can observe another. */
function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ak-census-'));
}

/** A directory that looks like a git repo root to resolveProjectIdentity. */
function repo(root, name) {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  return dir;
}

function withMarkers(dir, ...markers) {
  for (const m of markers) fs.mkdirSync(path.join(dir, m), { recursive: true });
  return dir;
}

/** A discoverProjectSources stand-in over explicit rows. */
const fakeDiscover = (rows) => () => ({
  asOf: 0,
  projects: rows.map((r) => ({
    path: r.path,
    label: path.basename(r.path),
    hosts: r.hosts ?? ['claude'],
    origins: ['cwd'],
    exists: r.exists ?? true,
    isGitRepo: r.isGitRepo ?? true,
    lastSeenMs: r.lastSeenMs ?? 0,
    sessions: r.sessions ?? 1,
  })),
  everSeen: rows.length,
  onDisk: rows.filter((r) => r.exists !== false).length,
  gitRepos: rows.filter((r) => r.isGitRepo !== false).length,
  unresolved: 0,
  complete: true,
  method: 'test',
  sources: {},
});

// ── learningStateOf ──────────────────────────────────────────────────────────

test('every learning marker is detected, and reported by name', () => {
  const root = tmp();
  for (const marker of LEARNING_MARKERS) {
    const dir = withMarkers(repo(root, `p-${marker.dir}`), marker.dir);
    assert.deepEqual(learningStateOf(dir), [marker.dir],
      `${marker.dir} (${marker.what}) must count as learning state`);
    assert.equal(hasLearningState(dir), true);
  }
});

test('a project with no learning markers has none', () => {
  const dir = repo(tmp(), 'plain');
  assert.deepEqual(learningStateOf(dir), []);
  assert.equal(hasLearningState(dir), false);
});

test('agentic-qe or swarm state alone is enough — ruflo neural state is NOT required', () => {
  // The exact regression that made the panel report 4 instead of 17: a project
  // whose memory came from agentic-qe was invisible.
  const root = tmp();
  assert.equal(hasLearningState(withMarkers(repo(root, 'aqe-only'), '.agentic-qe')), true);
  assert.equal(hasLearningState(withMarkers(repo(root, 'swarm-only'), '.swarm')), true);
  // And .claude-flow WITHOUT a neural/ subdir now counts, where it used not to.
  assert.equal(hasLearningState(withMarkers(repo(root, 'flow-no-neural'), '.claude-flow')), true);
});

test('a marker that is a FILE, not a directory, is not learning state', () => {
  const dir = repo(tmp(), 'filey');
  fs.writeFileSync(path.join(dir, '.swarm'), 'not a store');
  assert.deepEqual(learningStateOf(dir), []);
});

test('learningStateOf is null-safe and never throws on an absent path', () => {
  for (const v of [undefined, null, '', 0]) assert.deepEqual(learningStateOf(v), []);
  assert.deepEqual(learningStateOf(path.join(tmp(), 'nope')), []);
});

// ── scopes ───────────────────────────────────────────────────────────────────

test('each scope narrows the census as its name says', () => {
  const root = tmp();
  const learn = withMarkers(repo(root, 'learn'), '.claude-flow');
  const plainRepo = repo(root, 'plain');
  const notRepo = fs.mkdirSync(path.join(root, 'loose'), { recursive: true }) || path.join(root, 'loose');
  const census = projectCensus({
    discover: fakeDiscover([
      { path: learn },
      { path: plainRepo },
      { path: notRepo, isGitRepo: false },
      { path: path.join(root, 'deleted'), exists: false, isGitRepo: false },
    ]),
  });
  assert.equal(projectsInScope(census, 'everSeen').length, 4, 'everSeen keeps deleted projects');
  assert.equal(projectsInScope(census, 'onDisk').length, 3);
  assert.equal(projectsInScope(census, 'gitRepos').length, 2);
  assert.equal(projectsInScope(census, 'learning').length, 1);
});

test('a vanished project is never probed for learning state', () => {
  const census = projectCensus({
    discover: fakeDiscover([{ path: '/nope/gone', exists: false }]),
  });
  assert.deepEqual(census.projects[0].learningState, [],
    'a path that is gone cannot be probed; [] is the honest reading');
  assert.equal(census.learning, 0);
});

test('an unknown scope yields nothing rather than everything', () => {
  const census = projectCensus({ discover: fakeDiscover([{ path: '/a' }]) });
  assert.deepEqual(projectsInScope(census, 'bogus'), []);
});

test('the directory-level counts are passed through untouched', () => {
  // ADR-0025: the System area measures DIRECTORIES on purpose. Folding those
  // would destroy the per-directory byte and line figures it exists to report.
  const root = tmp();
  const a = withMarkers(repo(root, 'a'), '.swarm');
  const census = projectCensus({
    discover: fakeDiscover([{ path: a }, { path: path.join(a, 'sub') }]),
  });
  assert.equal(census.everSeen, 2, 'two directories stay two directories');
  assert.equal(census.projects.length, 2);
});

// ── identity merging (the picker-breaking bug) ───────────────────────────────

test('a sub-directory of a repo is the SAME project as its root', () => {
  const root = tmp();
  const proj = withMarkers(repo(root, 'app'), '.claude-flow');
  const sub = path.join(proj, 'backend');
  fs.mkdirSync(sub, { recursive: true });
  withMarkers(sub, '.agentic-qe');

  const learning = projectsInScope(
    projectCensus({ discover: fakeDiscover([{ path: proj }, { path: sub }]) }),
    'learning',
  );
  assert.equal(learning.length, 1, 'one project, not two');
  assert.equal(learning[0].path, proj, 'anchored on the repo root, which is what readIntelHistory reads');
  assert.deepEqual(learning[0].paths.sort(), [proj, sub].sort(), 'both directories are still reported');
  assert.deepEqual(learning[0].learningState.sort(), ['.agentic-qe', '.claude-flow'],
    'the merged row unions the state found across every contributing directory');
});

test('an ephemeral agent worktree folds into its parent project', () => {
  const root = tmp();
  const proj = withMarkers(repo(root, 'app'), '.claude-flow');
  const wt = path.join(proj, '.claude', 'worktrees', 'agent-abc123');
  withMarkers(wt, '.claude-flow');

  const learning = projectsInScope(
    projectCensus({ discover: fakeDiscover([{ path: proj }, { path: wt }]) }),
    'learning',
  );
  assert.equal(learning.length, 1);
  assert.equal(learning[0].path, proj, 'never anchor a project on a throwaway worktree');
});

test('merged rows carry a unique identity key — the picker depends on it', () => {
  const root = tmp();
  const a = withMarkers(repo(root, 'a'), '.claude-flow');
  const b = withMarkers(repo(root, 'b'), '.swarm');
  const rows = projectsInScope(projectCensus({
    discover: fakeDiscover([
      { path: a }, { path: path.join(a, 'x') }, { path: path.join(a, '.claude', 'worktrees', 'agent-1') },
      { path: b }, { path: path.join(b, 'y') },
    ]),
  }), 'learning');
  const keys = new Set(rows.map((r) => r.identityKey));
  assert.equal(rows.length, 2);
  assert.equal(keys.size, rows.length, 'one row per identity, or the picker loses projects');
});

test('merging sums sessions and keeps the most recent sighting', () => {
  const root = tmp();
  const proj = withMarkers(repo(root, 'app'), '.claude-flow');
  const sub = withMarkers(path.join(proj, 'sub'), '.swarm');
  const [row] = projectsInScope(projectCensus({
    discover: fakeDiscover([
      { path: proj, sessions: 3, lastSeenMs: 100, hosts: ['claude'] },
      { path: sub, sessions: 4, lastSeenMs: 900, hosts: ['codex'] },
    ]),
  }), 'learning');
  assert.equal(row.sessions, 7);
  assert.equal(row.lastSeenMs, 900);
  assert.deepEqual(row.hosts.sort(), ['claude', 'codex'], 'a project is not single-host just because its root was');
});

test('census.learning agrees with the length of the learning scope', () => {
  // These are two different code paths and they drifted once; a count that
  // disagrees with its own list is the exact confusion the census exists to end.
  const root = tmp();
  const proj = withMarkers(repo(root, 'app'), '.claude-flow');
  const census = projectCensus({
    discover: fakeDiscover([{ path: proj }, { path: path.join(proj, 'sub') }]),
  });
  assert.equal(census.learning, projectsInScope(census, 'learning').length);
  assert.equal(census.learning, 1);
});

test('learning rows are ordered most-recently-seen first', () => {
  const root = tmp();
  const old = withMarkers(repo(root, 'old'), '.swarm');
  const recent = withMarkers(repo(root, 'recent'), '.swarm');
  const rows = projectsInScope(projectCensus({
    discover: fakeDiscover([{ path: old, lastSeenMs: 1 }, { path: recent, lastSeenMs: 999 }]),
  }), 'learning');
  assert.deepEqual(rows.map((r) => path.basename(r.path)), ['recent', 'old']);
});

// ── describeScope (the explainer) ────────────────────────────────────────────

test('every scope can explain itself', () => {
  for (const scope of CENSUS_SCOPES) {
    const note = describeScope(scope);
    assert.ok(note.length > 20, `${scope} has no usable explanation`);
  }
});

test('a windowed count says so, because that is why two counts legitimately differ', () => {
  assert.match(describeScope('onDisk', { windowLabel: '14d' }), /last 14d/);
  assert.doesNotMatch(describeScope('onDisk'), /last/);
});

test('the learning explanation names the markers and disclaims the host', () => {
  const note = describeScope('learning');
  for (const m of LEARNING_MARKERS) assert.ok(note.includes(m.dir), `explanation omits ${m.dir}`);
  assert.match(note, /whichever host/i, 'host-independence is the point of the widening');
});

test('an unknown scope explains nothing rather than inventing a description', () => {
  assert.equal(describeScope('bogus'), '');
});
