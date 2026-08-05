// project-discovery.test.mjs — pins discoverRuvfloProjects()'s contract:
// the .claude-flow/neural filter, dedup-by-resolved-path with "both"
// tagging on overlap, most-recently-active-first sorting off
// .claude-flow/neural/stats.json's lastAdaptation, and the graceful skip of
// an observability record that carries no resolvable absolute path (which is
// what EVERY real record on this machine looks like — see the module's own
// header comment). Fixtures use fs.mkdtempSync isolated dirs, following
// live-tailer.test.mjs / dashboard-live-source.test.mjs conventions.
//
// registryWorkspaces() and resolveProjectLabel() are the real imports
// (dependency-injected per-test where a fixture-controlled sweep result is
// needed); the observability side is exercised BOTH through the real
// WorkspaceSnapshotStore against a fixture file (the realistic "skip" case)
// and through the readObservabilityRecords seam directly (the "both"-tag
// merge case that the real store's own sanitizer would otherwise make
// unreachable — see project-discovery.mjs's header comment for why).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverRuvfloProjects } from '../../src/lib/dashboard/project-discovery.mjs';

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ak-project-discovery-'));

// Source 3 (transcript scanning) defaults to this machine's REAL
// ~/.claude/projects and ~/.codex/sessions. Every test below that isn't
// specifically exercising source 3 must neutralize it with fresh empty temp
// dirs, or it would silently pick up whatever real projects happen to exist
// on the machine running the suite.
const noTranscripts = () => ({ claudeProjectsRoot: tempDir(), codexSessionsRoot: tempDir() });

const resolved = (candidate) => {
  try { return fs.realpathSync.native(candidate); }
  catch { return path.resolve(candidate); }
};

/** A project directory ruflo has (or hasn't) genuinely initialized. */
function makeProject(root, name, { neural = true, lastAdaptation } = {}) {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, '.claude-flow'), { recursive: true });
  if (neural) {
    fs.mkdirSync(path.join(dir, '.claude-flow', 'neural'), { recursive: true });
    if (lastAdaptation !== undefined) {
      fs.writeFileSync(
        path.join(dir, '.claude-flow', 'neural', 'stats.json'),
        JSON.stringify({ lastAdaptation }),
      );
    }
  }
  return dir;
}

/** A realistically-shaped session record for a fixture
 *  observability-workspaces.json — same shape as the real file on disk. */
function sampleSession({ workspace = {} } = {}) {
  return {
    sessionKey: 'claude:11111111-1111-1111-1111-111111111111',
    sessionId: '11111111-1111-1111-1111-111111111111',
    parentSessionId: null,
    host: 'claude',
    project: 'fixture-project',
    projectKey: 'project:0123456789abcdef',
    workspace: {
      key: null,
      repositoryLabel: 'fixture-project',
      directoryLabel: 'repo root',
      branchLabel: 'main',
      branchState: 'attached',
      changes: null,
      capturedAt: '2026-08-01T00:00:00.000Z',
      source: 'claude-source',
      confidence: 'observed',
      ...workspace,
    },
  };
}

function writeObservabilityFixture(file, sessions) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, sessions }));
}

// ── neural filter ────────────────────────────────────────────────────────

test('excludes a bare .claude-flow directory that has no neural/ subdir', () => {
  const root = tempDir();
  const withNeural = makeProject(root, 'has-neural', { lastAdaptation: 1 });
  const bare = makeProject(root, 'bare-claude-flow', { neural: false });

  const rows = discoverRuvfloProjects({
    registryWorkspaces: () => [withNeural, bare],
    readObservabilityRecords: () => [],
    ...noTranscripts(),
  });

  assert.deepEqual(rows.map((r) => r.path), [resolved(withNeural)]);
});

// ── dedup + "both" tagging ───────────────────────────────────────────────

test('dedups a path present in both sources, tagging it "both"', () => {
  const root = tempDir();
  const proj = makeProject(root, 'overlap-project', { lastAdaptation: 1 });

  const rows = discoverRuvfloProjects({
    registryWorkspaces: () => [proj],
    readObservabilityRecords: () => [sampleSession({ workspace: { directoryLabel: proj } })],
    ...noTranscripts(),
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].path, resolved(proj));
  assert.equal(rows[0].source, 'both');
});

test('a path found in only one source keeps that source\'s tag', () => {
  const root = tempDir();
  const registryOnly = makeProject(root, 'registry-only', { lastAdaptation: 1 });
  const observabilityOnly = makeProject(root, 'observability-only', { lastAdaptation: 2 });

  const rows = discoverRuvfloProjects({
    registryWorkspaces: () => [registryOnly],
    readObservabilityRecords: () => [sampleSession({ workspace: { directoryLabel: observabilityOnly } })],
    ...noTranscripts(),
  });

  const bySource = Object.fromEntries(rows.map((r) => [r.path, r.source]));
  assert.equal(bySource[resolved(registryOnly)], 'registry');
  assert.equal(bySource[resolved(observabilityOnly)], 'observability');
});

// ── sort order ───────────────────────────────────────────────────────────

test('sorts most-recently-active first, by .claude-flow/neural/stats.json lastAdaptation', () => {
  const root = tempDir();
  const stale = makeProject(root, 'stale', { lastAdaptation: 100 });
  const fresh = makeProject(root, 'fresh', { lastAdaptation: 5000 });
  const missingStats = makeProject(root, 'no-stats-file'); // neural/ exists, no stats.json → 0

  const rows = discoverRuvfloProjects({
    registryWorkspaces: () => [stale, fresh, missingStats],
    readObservabilityRecords: () => [],
    ...noTranscripts(),
  });

  assert.deepEqual(rows.map((r) => r.path), [resolved(fresh), resolved(stale), resolved(missingStats)]);
});

// ── graceful skip of an unresolvable source-2 entry ─────────────────────

test('skips a source-2 record with no resolvable absolute path, rather than fabricating one from its label', () => {
  const root = tempDir();
  const observabilityFile = path.join(root, 'observability-workspaces.json');
  // Realistically-shaped record: repositoryLabel/directoryLabel are sanitized
  // labels, never a path — exactly what every record in the real
  // ~/.config/agentic-kit/observability-workspaces.json looks like.
  writeObservabilityFixture(observabilityFile, [sampleSession()]);

  const rows = discoverRuvfloProjects({
    registryWorkspaces: () => [],
    observabilityFile,
    ...noTranscripts(),
  });

  assert.deepEqual(rows, []);
});

test('an entry whose label happens to collide with a real directory name is still skipped unless it is absolute', () => {
  const root = tempDir();
  const proj = makeProject(root, 'shouldnt-match', { lastAdaptation: 1 });
  const observabilityFile = path.join(root, 'observability-workspaces.json');
  // A relative directoryLabel that happens to match a real project's leaf
  // name must NOT be treated as if it resolved to that project.
  writeObservabilityFixture(observabilityFile, [
    sampleSession({ workspace: { directoryLabel: path.basename(proj) } }),
  ]);

  const rows = discoverRuvfloProjects({
    registryWorkspaces: () => [],
    observabilityFile,
    ...noTranscripts(),
  });

  assert.deepEqual(rows, []);
});

// ── labeling ─────────────────────────────────────────────────────────────

test('label is a short human-readable name, never a raw absolute path', () => {
  const root = tempDir();
  const proj = makeProject(root, 'labeled-project', { lastAdaptation: 1 });

  const [row] = discoverRuvfloProjects({
    registryWorkspaces: () => [proj],
    readObservabilityRecords: () => [],
    ...noTranscripts(),
  });

  assert.equal(row.label, 'labeled-project');
  assert.notEqual(row.label, row.path);
  assert.ok(!path.isAbsolute(row.label));
});

// ── real-import wiring (default parameters) ──────────────────────────────

test('with no overrides, wires to the real registryWorkspaces/resolveProjectLabel/WorkspaceSnapshotStore/transcript imports without throwing', () => {
  const rows = discoverRuvfloProjects();
  assert.ok(Array.isArray(rows));
  for (const row of rows) {
    assert.equal(typeof row.path, 'string');
    assert.equal(typeof row.label, 'string');
    assert.ok(['registry', 'observability', 'transcript', 'both'].includes(row.source));
  }
});

// ── source 3: real transcript content ───────────────────────────────────

/** A minimal, realistically-shaped Claude transcript line carrying cwd. */
function claudeTranscriptLine(cwd) {
  return JSON.stringify({ type: 'user', sessionId: 's1', cwd, message: { role: 'user', content: 'hi' } });
}

/** A minimal, realistically-shaped Codex session_meta line carrying
 *  payload.cwd (Codex nests cwd under payload, unlike Claude's flat cwd). */
function codexTranscriptLine(cwd) {
  return JSON.stringify({ type: 'session_meta', timestamp: '2026-08-05T00:00:00.000Z', payload: { session_id: 's1', cwd } });
}

test('source 3 finds a project from real Claude transcript content (flat cwd)', () => {
  const root = tempDir();
  const proj = makeProject(root, 'claude-only', { lastAdaptation: 1 });
  const claudeProjectsRoot = tempDir();
  const sessionDir = path.join(claudeProjectsRoot, 'some-encoded-name');
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, 'session.jsonl'), claudeTranscriptLine(proj) + '\n');

  const rows = discoverRuvfloProjects({
    registryWorkspaces: () => [],
    readObservabilityRecords: () => [],
    claudeProjectsRoot,
    codexSessionsRoot: tempDir(),
  });

  assert.deepEqual(rows.map((r) => r.path), [resolved(proj)]);
  assert.equal(rows[0].source, 'transcript');
});

test('source 3 finds a project from real Codex transcript content (nested payload.cwd)', () => {
  const root = tempDir();
  const proj = makeProject(root, 'codex-only', { lastAdaptation: 1 });
  const codexSessionsRoot = tempDir();
  const dayDir = path.join(codexSessionsRoot, '2026', '08', '05');
  fs.mkdirSync(dayDir, { recursive: true });
  fs.writeFileSync(path.join(dayDir, 'rollout-x.jsonl'), codexTranscriptLine(proj) + '\n');

  const rows = discoverRuvfloProjects({
    registryWorkspaces: () => [],
    readObservabilityRecords: () => [],
    claudeProjectsRoot: tempDir(),
    codexSessionsRoot,
  });

  assert.deepEqual(rows.map((r) => r.path), [resolved(proj)]);
  assert.equal(rows[0].source, 'transcript');
});

test('source 3 dedups against source 1, tagging the overlap "both"', () => {
  const root = tempDir();
  const proj = makeProject(root, 'overlap-with-transcript', { lastAdaptation: 1 });
  const claudeProjectsRoot = tempDir();
  const sessionDir = path.join(claudeProjectsRoot, 'enc');
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, 'session.jsonl'), claudeTranscriptLine(proj) + '\n');

  const rows = discoverRuvfloProjects({
    registryWorkspaces: () => [proj],
    readObservabilityRecords: () => [],
    claudeProjectsRoot,
    codexSessionsRoot: tempDir(),
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, 'both');
});

test('source 3 ignores a transcript cwd that has no .claude-flow/neural (same filter as the other sources)', () => {
  const root = tempDir();
  const notInitialized = path.join(root, 'never-ruflo-initialized');
  fs.mkdirSync(notInitialized, { recursive: true });
  const claudeProjectsRoot = tempDir();
  const sessionDir = path.join(claudeProjectsRoot, 'enc');
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, 'session.jsonl'), claudeTranscriptLine(notInitialized) + '\n');

  const rows = discoverRuvfloProjects({
    registryWorkspaces: () => [],
    readObservabilityRecords: () => [],
    claudeProjectsRoot,
    codexSessionsRoot: tempDir(),
  });

  assert.deepEqual(rows, []);
});
