// tests/kit/real-state-tripwire.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  REPO_STATE_DIRS, realStateRoots, snapshotRoots, compareSnapshots, isStrict, formatReport,
} from '../../scripts/real-state-tripwire.mjs';
import { spawnEnv } from './helpers/home-sandbox.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'real-state-tripwire.mjs');
const tmp = (t, prefix) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test('POSIX roots: XDG bases, their defaults, the repo state folders and ak-owned user files', () => {
  const roots = realStateRoots({
    platform: 'linux', homedir: '/home/dev', repoRoot: '/src/kit',
    env: { XDG_CONFIG_HOME: '/x/cfg', XDG_STATE_HOME: '/x/state' },
  });
  const dirs = roots.map((r) => `${r.kind}:${r.dir}`);
  for (const want of [
    'config:/x/cfg/agentic-kit', 'config:/home/dev/.config/agentic-kit',
    'state:/x/state/agentic-kit', 'state:/home/dev/.local/state/agentic-kit',
    ...REPO_STATE_DIRS.map((d) => `repo:/src/kit/${d}`),
    'user-file:/home/dev/.claude/CLAUDE.md', 'user-file:/home/dev/.codex/AGENTS.md',
    'user-file:/x/cfg/opencode/AGENTS.md',
    'user-file:/home/dev/.claude/settings.json', 'user-file:/home/dev/.claude.json',
    'user-file:/home/dev/.codex/config.toml',
    'repo-file:/src/kit/CLAUDE.md', 'repo-file:/src/kit/AGENTS.md', 'repo-file:/src/kit/.mcp.json',
    'repo-file:/src/kit/.codex/config.toml',
  ]) assert.ok(dirs.includes(want), `missing ${want} in ${dirs.join(', ')}`);
});

test('Windows roots use APPDATA/LOCALAPPDATA and collapse case-insensitive duplicates', () => {
  const roots = realStateRoots({
    platform: 'win32', homedir: 'C:\\Users\\dev', repoRoot: 'C:\\src\\kit',
    env: { APPDATA: 'C:\\Users\\dev\\AppData\\Roaming', LOCALAPPDATA: 'c:\\users\\DEV\\appdata\\local' },
  });
  const dirs = roots.map((r) => `${r.kind}:${r.dir}`);
  assert.ok(dirs.includes('config:C:\\Users\\dev\\AppData\\Roaming\\agentic-kit'));
  assert.ok(dirs.includes('state:c:\\users\\DEV\\appdata\\local\\agentic-kit'));
  assert.equal(dirs.filter((d) => d.toLowerCase() === 'state:c:\\users\\dev\\appdata\\local\\agentic-kit').length, 1,
    'the LOCALAPPDATA root and the ~\\AppData\\Local fallback are one folder on Windows');
  assert.ok(dirs.includes('repo:C:\\src\\kit\\.claude'));
});

test('CLAUDE_CONFIG_DIR moves settings.json but not ~/.claude.json, which Claude Code keeps in the home folder', () => {
  const dirs = realStateRoots({
    platform: 'linux', homedir: '/home/dev', repoRoot: '/src/kit', env: { CLAUDE_CONFIG_DIR: '/cc' },
  }).map((r) => `${r.kind}:${r.dir}`);
  assert.ok(dirs.includes('user-file:/cc/settings.json'));
  assert.ok(dirs.includes('user-file:/home/dev/.claude.json'));
  assert.ok(!dirs.includes('user-file:/home/dev/.claude/settings.json'));
});

test('CODEX_HOME adds its files without dropping ~/.codex, which is where ak writes (src/lib/paths.mjs:58-60)', () => {
  const dirs = realStateRoots({
    platform: 'linux', homedir: '/home/dev', repoRoot: '/src/kit', env: { CODEX_HOME: '/cx' },
  }).map((r) => `${r.kind}:${r.dir}`);
  for (const want of ['user-file:/cx/AGENTS.md', 'user-file:/cx/config.toml',
    'user-file:/home/dev/.codex/AGENTS.md', 'user-file:/home/dev/.codex/config.toml']) {
    assert.ok(dirs.includes(want), `missing ${want}`);
  }
});

test('a rewritten repo-root guidance or MCP file is failing, even outside strict mode', (t) => {
  const home = tmp(t, 'ak-trip-repofile');
  const repo = path.join(home, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, 'AGENTS.md'), '# guidance\n');
  const roots = realStateRoots({ platform: process.platform, homedir: home, repoRoot: repo, env: {} });
  const before = snapshotRoots(roots);
  fs.writeFileSync(path.join(repo, 'AGENTS.md'), '# guidance\n<!-- injected block -->\n');
  fs.writeFileSync(path.join(repo, '.mcp.json'), '{}');
  const { failing, concurrent } = compareSnapshots(before, snapshotRoots(roots), { strict: false });
  assert.deepEqual(failing.map((c) => `${c.op} ${c.kind} ${c.rel}`).sort(), ['+ repo-file .mcp.json', '~ repo-file AGENTS.md']);
  assert.deepEqual(concurrent, []);
});

test('a created, removed or rewritten file is failing; an mtime-only touch is not', (t) => {
  const home = tmp(t, 'ak-trip');
  const cfg = path.join(home, '.config', 'agentic-kit');
  fs.mkdirSync(cfg, { recursive: true });
  fs.writeFileSync(path.join(cfg, 'kit.json'), '{}');
  fs.writeFileSync(path.join(cfg, 'gone.json'), '1');
  fs.writeFileSync(path.join(cfg, 'touched.json'), 'same');
  const roots = realStateRoots({ platform: process.platform, homedir: home, repoRoot: path.join(home, 'repo'), env: {} });
  const before = snapshotRoots(roots);
  fs.writeFileSync(path.join(cfg, 'kit.json'), '{"changed":true}');
  fs.rmSync(path.join(cfg, 'gone.json'));
  fs.writeFileSync(path.join(cfg, 'new.json'), 'x');
  const future = new Date(Date.now() + 60_000);
  fs.utimesSync(path.join(cfg, 'touched.json'), future, future);
  const { failing } = compareSnapshots(before, snapshotRoots(roots), { strict: true });
  assert.deepEqual(failing.map((c) => `${c.op} ${c.rel}`).sort(), ['+ new.json', '- gone.json', '~ kit.json']);
  const report = formatReport({ failing, concurrent: [] });
  assert.match(report, /3 path\(s\) changed/);
  assert.ok(report.includes(path.join(cfg, 'kit.json')), 'the report names the absolute path');
});

test('an empty folder a tool creates is a change (the opencode/ case)', (t) => {
  const home = tmp(t, 'ak-trip-dir');
  const state = path.join(home, '.local', 'state', 'agentic-kit');
  fs.mkdirSync(state, { recursive: true });
  const roots = realStateRoots({ platform: process.platform, homedir: home, repoRoot: path.join(home, 'repo'), env: {} });
  const before = snapshotRoots(roots);
  fs.mkdirSync(path.join(state, 'maintenance'));
  const { failing } = compareSnapshots(before, snapshotRoots(roots), { strict: true });
  assert.deepEqual(failing.map((c) => `${c.op} ${c.rel}`), ['+ maintenance/']);
});

test('developer mode moves live-session writers to "concurrent"; strict mode fails them', (t) => {
  const home = tmp(t, 'ak-trip-conc');
  const repo = path.join(home, 'repo');
  const cfg = path.join(home, '.config', 'agentic-kit');
  fs.mkdirSync(path.join(cfg, 'claude-context-windows'), { recursive: true });
  fs.mkdirSync(path.join(repo, '.swarm'), { recursive: true });
  fs.mkdirSync(path.join(repo, '.agentic-qe'), { recursive: true });
  const roots = realStateRoots({ platform: process.platform, homedir: home, repoRoot: repo, env: {} });
  const before = snapshotRoots(roots);
  fs.writeFileSync(path.join(cfg, 'claude-rate-limits.json'), '{}');
  fs.writeFileSync(path.join(cfg, 'claude-context-windows', 's1.json'), '[]');
  fs.writeFileSync(path.join(repo, '.swarm', 'memory.db-wal'), 'x');
  fs.writeFileSync(path.join(repo, '.agentic-qe', 'llm-config.json'), '{}');
  fs.writeFileSync(path.join(home, '.claude.json'), '{"numStartups":2}');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{}');
  const after = snapshotRoots(roots);
  const dev = compareSnapshots(before, after, { strict: false });
  assert.deepEqual(dev.failing.map((c) => c.rel).sort(), ['.agentic-qe/llm-config.json', 'settings.json'],
    'ak-owned files inside hook-churned folders, and Claude settings, stay failing');
  assert.deepEqual(dev.concurrent.map((c) => c.rel).sort(),
    ['.claude.json', '.swarm/memory.db-wal', 'claude-context-windows/s1.json', 'claude-rate-limits.json']);
  const strict = compareSnapshots(before, after, { strict: true });
  assert.equal(strict.concurrent.length, 0);
  assert.ok(strict.failing.some((c) => c.rel === 'claude-rate-limits.json'));
  assert.ok(strict.failing.some((c) => c.rel === '.claude.json'));
  assert.match(formatReport(dev), /concurrent writers \(not failing\)/);
});

test('Ruflo-created .claude-flow root and proven-config files are concurrent only in developer mode', (t) => {
  const home = tmp(t, 'ak-trip-ruflo');
  const repo = path.join(home, 'repo');
  fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
  const roots = realStateRoots({ platform: process.platform, homedir: home, repoRoot: repo, env: {} });
  const before = snapshotRoots(roots);
  fs.mkdirSync(path.join(repo, '.claude-flow'));
  fs.writeFileSync(path.join(repo, '.claude-flow', 'session.json'), '{}');
  fs.writeFileSync(path.join(repo, '.claude', 'proven-config.json'), '{}');
  fs.writeFileSync(path.join(repo, '.claude', '.proven-config-version'), 'v1');
  fs.writeFileSync(path.join(repo, '.claude-flow', 'config.json'), '{}');
  const after = snapshotRoots(roots);
  const dev = compareSnapshots(before, after, { strict: false });
  assert.deepEqual(dev.concurrent.map((c) => c.rel).sort(), [
    '.claude-flow/', '.claude-flow/session.json', '.claude/.proven-config-version', '.claude/proven-config.json',
  ].sort());
  assert.deepEqual(dev.failing.map((c) => c.rel), ['.claude-flow/config.json']);
  const strict = compareSnapshots(before, after, { strict: true });
  assert.deepEqual(strict.concurrent, []);
  assert.deepEqual(strict.failing.map((c) => c.rel).sort(), [
    '.claude-flow/', '.claude-flow/config.json', '.claude-flow/session.json',
    '.claude/.proven-config-version', '.claude/proven-config.json',
  ].sort());
});

test('removing the .claude-flow root is concurrent only in developer mode', (t) => {
  const home = tmp(t, 'ak-trip-ruflo-remove');
  const repo = path.join(home, 'repo');
  fs.mkdirSync(path.join(repo, '.claude-flow'), { recursive: true });
  const roots = realStateRoots({ platform: process.platform, homedir: home, repoRoot: repo, env: {} });
  const before = snapshotRoots(roots);
  fs.rmSync(path.join(repo, '.claude-flow'), { recursive: true });
  const after = snapshotRoots(roots);
  assert.deepEqual(compareSnapshots(before, after, { strict: false }).concurrent.map((c) => c.rel), ['.claude-flow/']);
  assert.deepEqual(compareSnapshots(before, after, { strict: true }).failing.map((c) => c.rel), ['.claude-flow/']);
});

test('CI and AK_TRIPWIRE_STRICT make the comparison strict', () => {
  assert.equal(isStrict({ CI: 'true' }), true);
  assert.equal(isStrict({ CI: '1' }), true);
  assert.equal(isStrict({ AK_TRIPWIRE_STRICT: '1' }), true);
  assert.equal(isStrict({}), false);
  assert.equal(isStrict({ CI: 'false' }), false);
});

test('an unreadable file is recorded, never thrown, and compares equal to itself', { skip: process.platform === 'win32' && 'chmod 000 does not deny reads on Windows' }, (t) => {
  const home = tmp(t, 'ak-trip-unread');
  const cfg = path.join(home, '.config', 'agentic-kit');
  fs.mkdirSync(cfg, { recursive: true });
  const locked = path.join(cfg, 'locked.json');
  fs.writeFileSync(locked, 'secret');
  fs.chmodSync(locked, 0o000); // the folder stays writable, so the tmp cleanup still removes it
  const roots = realStateRoots({ platform: process.platform, homedir: home, repoRoot: path.join(home, 'repo'), env: {} });
  const a = snapshotRoots(roots);
  const entry = [...a.values()].find((e) => e.rel === 'locked.json');
  if (process.getuid && process.getuid() === 0) return; // root reads anything
  assert.equal(entry.type, 'unreadable');
  assert.deepEqual(compareSnapshots(a, snapshotRoots(roots), { strict: true }).failing, []);
});

test('the CLI snapshot/compare pair exits 3 and names the changed path', (t) => {
  const home = tmp(t, 'ak-trip-cli');
  const repo = path.join(home, 'repo');
  fs.mkdirSync(repo);
  const env = spawnEnv(home, { CI: 'true', APPDATA: path.join(home, 'AppData', 'Roaming') });
  const out = path.join(home, 'before.json');
  const snap = spawnSync(process.execPath, [CLI, 'snapshot', out, '--repo', repo], { env, encoding: 'utf8' });
  assert.equal(snap.status, 0, snap.stderr);
  fs.mkdirSync(path.join(home, '.local', 'state', 'agentic-kit'), { recursive: true });
  fs.writeFileSync(path.join(home, '.local', 'state', 'agentic-kit', 'install-edits.json'), '{}');
  const cmp = spawnSync(process.execPath, [CLI, 'compare', out, '--repo', repo], { env, encoding: 'utf8' });
  assert.equal(cmp.status, 3, cmp.stdout + cmp.stderr);
  assert.match(cmp.stderr, /install-edits\.json/);
});
