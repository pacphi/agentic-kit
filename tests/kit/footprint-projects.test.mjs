// Project accounting for the System area: `project-sources.mjs` (every project
// any host ever recorded a session in) and the `collectProjects` rows built on
// top of it.
//
// The contract under test is that TWO POPULATIONS stay distinct and stay
// honest. `everSeen` counts projects including the ones that have since been
// deleted — the deletions are the question, not noise — while the table only
// carries the on-disk subset, because a directory that is gone has no bytes and
// no lines to measure. A test that let those two numbers collapse into one
// would be signing off on the exact misreport this accounting exists to fix.
//
// Every fixture lives under mkdtempSync and every collector is handed explicit
// roots, so nothing here can reach the developer's real ~/.claude or ~/.codex
// and pass by accident against whatever happens to be installed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  HEAD_MAX_LINES, PROJECT_SOURCE_HOSTS, PROJECT_SOURCE_METHOD,
  decodeClaudeProjectDir, discoverProjectSources, firstCwd, firstSessionMetadata, scanOpencodeDirectories,
  scanTranscriptCwds,
} from '../../src/lib/footprint/project-sources.mjs';
import { collectProjects } from '../../src/lib/footprint/projects.mjs';

/** A fixture root that is removed when the test ends, whatever the outcome.
 *  Realpath'd up front: macOS /tmp is a symlink to /private/tmp, and the
 *  de-duplication under test resolves real paths, so a raw mkdtemp path would
 *  make every assertion compare two spellings of the same directory. */
// The encoding this module decodes is `/`-rooted — every separator became `-`,
// so the name begins with one. Windows paths carry a drive prefix instead, which
// the decoder refuses by design, so a test that builds a `/`-rooted encoding is
// only meaningful on POSIX.
const POSIX_ONLY = process.platform === 'win32';

function fixture(t, name) {
  // realpathSync.NATIVE, matching what the collectors canonicalise with. The JS
  // realpath leaves a Windows 8.3 short name alone (C:\Users\RUNNER~1\...) while the
  // native one resolves it to the long form the code under test produces
  // (C:\Users\runneradmin\...). Same directory, two spellings — and every path
  // assertion in this file compared one against the other on Windows only.
  const real = fs.realpathSync.native ?? fs.realpathSync;
  const dir = real(fs.mkdtempSync(path.join(os.tmpdir(), `ak-fp-projects-${name}-`)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

/** One Claude transcript: flat `cwd` on its own records. */
const claudeTranscript = (root, dirName, file, cwd) => write(
  path.join(root, dirName, file),
  `${JSON.stringify({ type: 'user', cwd })}\n${JSON.stringify({ type: 'assistant' })}\n`,
);

/** One Codex rollout: `payload.cwd` on the record that opens it. */
const codexTranscript = (root, rel, cwd) => write(
  path.join(root, rel),
  `${JSON.stringify({ type: 'session_meta', payload: { cwd } })}\n`,
);

const label = (target) => path.basename(target);
const noOpencode = () => (
  { host: 'opencode', root: null, status: 'absent', reason: null, sessions: 0, sightings: [], complete: true }
);

test('a cwd is read from either host shape, and only from the head', () => {
  assert.equal(firstCwd([JSON.stringify({ cwd: '/a/b' })], 'claude'), '/a/b');
  // A Claude-shaped record read as Codex yields nothing: the shapes are not
  // interchangeable and guessing across them would invent attributions.
  assert.equal(firstCwd([JSON.stringify({ cwd: '/a/b' })], 'codex'), null);
  assert.equal(
    firstCwd([JSON.stringify({ type: 'turn_context', payload: { cwd: '/c/d' } })], 'codex'), '/c/d');
  // A truncated final line in a head window is expected, not a failure.
  assert.equal(firstCwd(['{"cwd":"/x', JSON.stringify({ cwd: '/y' })], 'claude'), '/y');
  assert.equal(firstCwd([], 'claude'), null);
  assert.equal(firstCwd(null, 'claude'), null);
  assert.equal(firstCwd([JSON.stringify({ cwd: '' })], 'claude'), null);
});

test('bounded transcript metadata normalizes native identity and start time without prompt content', () => {
  const codex = firstSessionMetadata([
    '{"truncated":',
    JSON.stringify({
      timestamp: '2026-09-03T16:10:25.468Z', type: 'session_meta',
      payload: {
        id: '01a06808-ff7f-7ae1-96a1-510da7cf6277',
        timestamp: '2026-09-03T16:10:15.342Z', cwd: '/repos/agentic-kit',
      },
    }),
  ], 'codex');
  assert.deepEqual(codex, {
    cwd: '/repos/agentic-kit',
    nativeId: '01a06808-ff7f-7ae1-96a1-510da7cf6277',
    startedAt: '2026-09-03T16:10:15.342Z',
    timeBasis: 'started',
  });

  const claude = firstSessionMetadata([
    JSON.stringify({
      type: 'queue-operation', sessionId: '8b5fdc77-788f-4857-9b16-1cbac2a717e9',
      cwd: '/repos/boon-worthy', timestamp: '2026-09-03T06:57:27.087Z',
    }),
    JSON.stringify({ type: 'ai-title', aiTitle: 'sensitive conversation title' }),
  ], 'claude');
  assert.deepEqual(claude, {
    cwd: '/repos/boon-worthy',
    nativeId: '8b5fdc77-788f-4857-9b16-1cbac2a717e9',
    startedAt: '2026-09-03T06:57:27.087Z',
    timeBasis: 'first-event',
  }, 'the System inventory must not surface a prompt-derived title');
});

test('Codex metadata latches its first session_meta and rejects timezone-less instants', () => {
  const result = firstSessionMetadata([
    JSON.stringify({ type: 'session_meta', payload: { id: 'own', timestamp: '2026-09-03T09:10:15' } }),
    JSON.stringify({ type: 'session_meta', payload: { id: 'replayed-parent', timestamp: '2026-09-04T10:00:00Z' } }),
  ], 'codex');
  assert.equal(result.nativeId, 'own');
  assert.equal(result.startedAt, null, 'a timezone-less wall clock is not an absolute instant');
});

test('the encoded Claude directory decodes only against the real filesystem', { skip: POSIX_ONLY }, (t) => {
  const root = fixture(t, 'decode');
  // `agentic-kit` and `agentic/kit` encode IDENTICALLY, so the decode is only
  // safe because the filesystem decides which one exists.
  fs.mkdirSync(path.join(root, 'ai', 'agentic-kit'), { recursive: true });
  const encoded = path.join(root, 'ai', 'agentic-kit').split(path.sep).join('-');
  assert.equal(decodeClaudeProjectDir(encoded), path.join(root, 'ai', 'agentic-kit'));

  // A dotted directory is the other separator the encoding swallows.
  fs.mkdirSync(path.join(root, '.claude', 'x'), { recursive: true });
  const dotted = path.join(root, '.claude', 'x').split(path.sep).join('-');
  assert.equal(decodeClaudeProjectDir(dotted), path.join(root, '.claude', 'x'));

  // A project whose directory is GONE cannot be recovered — stated as null, not
  // guessed at, which is what makes `everSeen` a floor rather than a fiction.
  assert.equal(decodeClaudeProjectDir(`${root.split(path.sep).join('-')}-vanished`), null);
});

// The decoder's refusal contract, asserted on EVERY platform. On Windows this is
// the whole of its observable behaviour: the encoding it decodes is `/`-rooted,
// a Windows path carries a drive prefix instead, and the decoder documents that
// as undecodable. The test above builds a `/`-rooted encoding Windows never
// produces, so running it there tested the platform rather than the decoder.
test('a name that is not a POSIX-absolute encoding is refused, on every platform', () => {
  assert.equal(decodeClaudeProjectDir('not-absolute'), null);
  assert.equal(decodeClaudeProjectDir(''), null);
  assert.equal(decodeClaudeProjectDir(null), null);
  assert.equal(decodeClaudeProjectDir('C:-Users-me-proj'), null, 'a Windows drive prefix is not decodable');
});

test('one project touched by two hosts is ONE project, resolved through symlinks', (t) => {
  const root = fixture(t, 'dedup');
  const real = path.join(root, 'work', 'shared-repo');
  fs.mkdirSync(path.join(real, '.git'), { recursive: true });
  const link = path.join(root, 'link-to-shared');
  fs.symlinkSync(real, link, 'dir');

  const claudeRoot = path.join(root, 'claude-projects');
  const codexRoot = path.join(root, 'codex-sessions');
  // Same project, three spellings: the real path, a symlinked path, and a
  // second Claude session in the same directory.
  claudeTranscript(claudeRoot, '-work-shared-repo', 'a.jsonl', real);
  claudeTranscript(claudeRoot, '-work-shared-repo', 'b.jsonl', link);
  codexTranscript(codexRoot, path.join('2026', '08', '06', 'r.jsonl'), real);

  const found = discoverProjectSources({
    claudeRoot, codexRoot, resolveLabel: label,
    scanOpencode: noOpencode, now: () => 1_700_000_000_000,
  });

  assert.equal(found.everSeen, 1, JSON.stringify(found.projects, null, 2));
  assert.equal(found.onDisk, 1);
  assert.equal(found.gitRepos, 1);
  assert.deepEqual(found.projects[0].hosts, ['claude', 'codex']);
  assert.equal(found.projects[0].path, real);
  assert.equal(found.projects[0].sessions, 3);
  assert.equal(found.projects[0].exists, true);
  assert.equal(found.method, PROJECT_SOURCE_METHOD);
  assert.deepEqual(Object.keys(found.sources).sort(), [...PROJECT_SOURCE_HOSTS].sort());
});

test('a project that no longer exists is counted in everSeen and never in the table', (t) => {
  const root = fixture(t, 'vanished');
  const alive = path.join(root, 'alive');
  fs.mkdirSync(path.join(alive, '.git'), { recursive: true });
  write(path.join(alive, '.git', 'config'),
    '[remote "origin"]\n\turl = https://github.com/pacphi/alive.git\n');
  const gone = path.join(root, 'deleted-last-week');

  const claudeRoot = path.join(root, 'claude-projects');
  claudeTranscript(claudeRoot, '-alive', 'a.jsonl', alive);
  claudeTranscript(claudeRoot, '-deleted-last-week', 'b.jsonl', gone);

  const sources = discoverProjectSources({
    claudeRoot,
    codexRoot: path.join(root, 'no-codex'),
    resolveLabel: label,
    scanOpencode: noOpencode,
    now: () => 1_700_000_000_000,
  });
  assert.equal(sources.everSeen, 2);
  assert.equal(sources.onDisk, 1);
  assert.equal(sources.gitRepos, 1);
  // The vanished project keeps its row in DISCOVERY — that is where the fact
  // that it existed lives — and is honestly marked as not on disk.
  const vanished = sources.projects.find((p) => p.path === gone);
  assert.equal(vanished.exists, false);
  assert.equal(vanished.isGitRepo, false);
  // An absent codex root is an ABSENCE (that host was never used here), not a
  // failed measurement, so it must not make the counts a floor.
  assert.equal(sources.sources.codex.status, 'absent');
  assert.equal(sources.complete, true);

  const section = collectProjects({
    sources, loc: false, now: () => 1_700_000_000_000,
  });
  assert.equal(section.projects.length, 1, 'only the measurable project becomes a row');
  assert.equal(section.projects[0].path, alive);
  assert.equal(section.everSeen.value, 2);
  assert.equal(section.onDisk.value, 1);
  assert.equal(section.gitRepos.value, 1);
  // `count` keeps its original meaning for existing consumers: how many
  // projects discovery found.
  assert.equal(section.count.value, section.everSeen.value);
  assert.equal(section.method, PROJECT_SOURCE_METHOD);
  assert.equal(section.everSeen.partial, false);
  assert.deepEqual(section.projects[0].hosts, ['claude']);
});

test('an unreadable transcript makes the counts a floor, never a smaller total', (t) => {
  const root = fixture(t, 'floor');
  const claudeRoot = path.join(root, 'claude-projects');
  claudeTranscript(claudeRoot, '-p', 'a.jsonl', path.join(root, 'p'));

  // `null` from the head reader is "could not read at all", which is distinct
  // from an empty file — an empty file is a real, readable zero lines.
  const unreadable = scanTranscriptCwds(claudeRoot, 'claude', { readHead: () => null });
  assert.equal(unreadable.files, 1);
  assert.equal(unreadable.unreadable, 1);
  assert.equal(unreadable.withCwd, 0);
  assert.equal(unreadable.complete, false);

  const empty = scanTranscriptCwds(claudeRoot, 'claude', { readHead: () => [] });
  assert.equal(empty.empty, 1);
  assert.equal(empty.unreadable, 0);
  assert.equal(empty.complete, true);

  // A directory group with no cwd anywhere and no recoverable path is the other
  // way the list becomes a floor.
  const lost = scanTranscriptCwds(claudeRoot, 'claude', {
    readHead: () => ['{}'], decodeDir: () => null,
  });
  assert.equal(lost.withoutCwd, 1);
  assert.equal(lost.unresolved, 1);
  assert.equal(lost.complete, false);

  const section = collectProjects({
    discover: () => ({
      projects: [], everSeen: 4, onDisk: 0, gitRepos: 0, unresolved: 1,
      complete: false, method: PROJECT_SOURCE_METHOD, sources: {},
    }),
    loc: false,
    now: () => 1_700_000_000_000,
  });
  assert.equal(section.everSeen.value, 4);
  assert.equal(section.everSeen.partial, true, 'an incomplete sweep renders as ">= N"');
  assert.equal(section.unresolved, 1);
  assert.equal(section.complete, false);
});

// POSIX-only for the same reason as the decode test: the encoded directory
// name is built with path.sep, which on Windows yields a drive-prefixed form
// the decoder refuses by design, so the recovery it asserts cannot happen there.
test('a group with no cwd anywhere is recovered from its encoded directory name', { skip: POSIX_ONLY }, (t) => {
  const root = fixture(t, 'recover');
  const project = path.join(root, 'quiet-project');
  fs.mkdirSync(project, { recursive: true });
  const claudeRoot = path.join(root, 'claude-projects');
  const encoded = project.split(path.sep).join('-');
  // No cwd record anywhere in this group — the directory name is the only
  // evidence left, and it is only usable because the directory still exists.
  write(path.join(claudeRoot, encoded, 'a.jsonl'), `${JSON.stringify({ type: 'user' })}\n`);

  const scan = scanTranscriptCwds(claudeRoot, 'claude', {
    decodeDir: (name) => decodeClaudeProjectDir(name),
  });
  assert.equal(scan.withCwd, 0);
  assert.equal(scan.recoveredFromDirName, 1);
  assert.equal(scan.unresolved, 0);
  assert.deepEqual(scan.sightings.map((s) => s.origin), ['encoded-dir']);
  assert.equal(scan.sightings[0].cwd, project);
  assert.equal(scan.complete, true);
});

test('OpenCode sessions come from the store, and a broken store degrades with its reason', () => {
  const rows = [
    { directory: '/w/one', sessions: 3, lastMs: 1_700_000_000_000 },
    { directory: '/w/two', sessions: 1, lastMs: null },
  ];
  const ok = scanOpencodeDirectories({
    dbFile: '/nowhere/opencode.db',
    withDb: () => ({ ok: true, value: rows }),
  });
  assert.equal(ok.status, 'ok');
  assert.equal(ok.sessions, 4);
  assert.deepEqual(ok.sightings.map((s) => s.weight), [3, 1]);
  assert.equal(ok.complete, true);

  const absent = scanOpencodeDirectories({
    dbFile: '/nowhere/opencode.db',
    withDb: () => ({ ok: false, error: { kind: 'absent' } }),
  });
  assert.equal(absent.status, 'absent');
  assert.equal(absent.complete, true, 'never used here is a real zero, not a failure');

  const broken = scanOpencodeDirectories({
    dbFile: '/nowhere/opencode.db',
    withDb: () => ({ ok: false, error: { kind: 'io', message: 'SQLITE_CORRUPT' } }),
  });
  assert.equal(broken.status, 'degraded');
  assert.equal(broken.reason, 'SQLITE_CORRUPT');
  assert.equal(broken.complete, false);
});

test('an OpenCode-only project joins the same de-duplicated list', (t) => {
  const root = fixture(t, 'opencode');
  const shared = path.join(root, 'shared');
  const oc = path.join(root, 'opencode-only');
  fs.mkdirSync(shared, { recursive: true });
  fs.mkdirSync(oc, { recursive: true });
  const claudeRoot = path.join(root, 'claude-projects');
  claudeTranscript(claudeRoot, '-shared', 'a.jsonl', shared);

  const found = discoverProjectSources({
    claudeRoot,
    codexRoot: path.join(root, 'no-codex'),
    resolveLabel: label,
    scanOpencode: () => ({
      host: 'opencode', root: 'db', status: 'ok', reason: null, sessions: 5, complete: true,
      sightings: [
        { cwd: shared, mtimeMs: 2, origin: 'cwd', weight: 2 },
        { cwd: oc, mtimeMs: 1, origin: 'cwd', weight: 3 },
      ],
    }),
    now: () => 1_700_000_000_000,
  });
  assert.equal(found.everSeen, 2);
  const sharedRow = found.projects.find((p) => p.path === shared);
  assert.deepEqual(sharedRow.hosts, ['claude', 'opencode']);
  assert.equal(sharedRow.sessions, 3, 'the OpenCode row carries its own session weight');
  assert.deepEqual(found.projects.find((p) => p.path === oc).hosts, ['opencode']);
});

test('an explicit catalog preserves discovery counts while measuring only its hosted session rows', (t) => {
  const root = fixture(t, 'explicit');
  const alive = path.join(root, 'alive');
  fs.mkdirSync(path.join(alive, '.git'), { recursive: true });
  write(path.join(alive, '.git', 'config'),
    '[remote "origin"]\n\turl = https://github.com/pacphi/alive.git\n');

  const section = collectProjects({
    projects: [
      { path: alive, label: 'alive', hosts: ['claude'] },
      { path: path.join(root, 'gone'), label: 'gone', hosts: ['codex'] },
    ],
    loc: false,
    now: () => 1_700_000_000_000,
  });
  // The caller still defines the KPI population, but a missing or unlinked
  // directory is counted as an exclusion rather than receiving deep walks.
  assert.equal(section.projects.length, 1);
  assert.equal(section.projects[0].path, alive);
  assert.equal(section.everSeen.value, 2);
  assert.equal(section.onDisk.value, 1);
  assert.equal(section.gitRepos.value, 1);
  assert.equal(section.population.excluded.total, 1);
  assert.equal(section.population.excluded.byRemoteStatus.localOnly, 1);
  assert.equal(section.method, null, 'an explicit catalog has no discovery method to state');
});

test('discovery that throws reports unknown counts, never zeros', () => {
  const section = collectProjects({
    discover: () => { const error = new Error('nope'); error.code = 'EACCES'; throw error; },
    loc: false,
    now: () => 1_700_000_000_000,
  });
  assert.equal(section.projects.length, 0);
  for (const key of ['count', 'everSeen', 'onDisk', 'gitRepos']) {
    assert.equal(section[key].value, null, `${key} must not fabricate a 0`);
    assert.equal(section[key].status, 'unknown');
    assert.equal(section[key].reason, 'EACCES');
  }
  assert.equal(section.complete, false);
});

test('only the head of a transcript is read, and the budget is stated', (t) => {
  const root = fixture(t, 'head');
  const claudeRoot = path.join(root, 'claude-projects');
  // The cwd sits far past the line budget: a session records its cwd in its
  // opening records or not at all, so reading further would cost the whole
  // corpus to learn nothing.
  const filler = `${JSON.stringify({ type: 'assistant' })}\n`.repeat(HEAD_MAX_LINES + 10);
  write(path.join(claudeRoot, '-late', 'a.jsonl'),
    `${filler}${JSON.stringify({ cwd: path.join(root, 'late') })}\n`);

  const scan = scanTranscriptCwds(claudeRoot, 'claude', { decodeDir: () => null });
  assert.equal(scan.withCwd, 0);
  assert.equal(scan.withoutCwd, 1);

  // The same file is found when the budget is widened — proving the miss above
  // is the bound doing its job rather than a parser bug.
  const wide = scanTranscriptCwds(claudeRoot, 'claude', { maxLines: HEAD_MAX_LINES + 20 });
  assert.equal(wide.withCwd, 1);
});
