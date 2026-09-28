// Where Codex's Ruflo memory goes (audit 2026-09-26 Addendum 2, problem 2,
// choice C). `ak x ruflo-mcp` starts Ruflo in the Git repository Codex works in;
// a plain work folder keeps its own .swarm; but the filesystem root, the home
// folder itself, a temporary root and a tool's own folder (~/.codex, ~/.claude,
// ~/.config, ~/Library/Application Support, %APPDATA%) route to ONE user-level
// store, pinned through CLAUDE_FLOW_MEMORY_PATH and CLAUDE_FLOW_DB_PATH. Every
// test here passes a sandbox home: the real ~/.claude-flow is never touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { rufloMemoryLocation, rufloMcpLaunch, memoryProjectRoot } from '../../src/lib/ruflo-memory.mjs';
import projectMemory from '../../src/commands/status/sections/project-memory.mjs';
import userMemory from '../../src/commands/status/sections/user-memory.mjs';

function sandbox(t) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ak-memory-home-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}
const mkdir = (dir) => { fs.mkdirSync(dir, { recursive: true }); return fs.realpathSync(dir); };
const userStore = (home) => path.join(home, '.claude-flow', 'memory');
const cfg = { agentBrowser: false };

function rufloStore(file, entries = 1) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE memory_entries (id TEXT PRIMARY KEY, namespace TEXT, status TEXT)');
  for (let i = 0; i < entries; i += 1) db.prepare('INSERT INTO memory_entries VALUES (?, ?, ?)').run(String(i), 'default', 'active');
  db.close();
}

test('a Git repository and a plain work folder keep their own .swarm', (t) => {
  const home = sandbox(t);
  const repo = mkdir(path.join(home, 'work', 'repo'));
  fs.mkdirSync(path.join(repo, '.git'));
  const nested = mkdir(path.join(repo, 'src', 'deep'));
  assert.deepEqual(rufloMemoryLocation(nested, { home }), {
    kind: 'project', root: repo, dir: path.join(repo, '.swarm'), db: path.join(repo, '.swarm', 'memory.db'), reason: null,
  });
  const plain = mkdir(path.join(home, 'notes'));
  assert.equal(rufloMemoryLocation(plain, { home }).kind, 'folder');
  assert.equal(rufloMemoryLocation(plain, { home }).root, plain);
});

test('a disposable folder under the temporary root is a plain work folder (the memory proof stays isolated)', (t) => {
  const home = sandbox(t);
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ak-verify-like-')));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const location = rufloMemoryLocation(scratch, { home });
  assert.equal(location.kind, 'folder');
  assert.equal(location.root, scratch);
  const launch = rufloMcpLaunch(scratch, {}, { cfg, rufloVersion: '3.45.0', home });
  assert.equal(launch.cwd, scratch);
  assert.equal(launch.env.CLAUDE_FLOW_DB_PATH, path.join(scratch, '.swarm', 'memory.db'));
  assert.equal(launch.env.CLAUDE_FLOW_MEMORY_PATH, undefined, 'a project launch adds no memory-root override');
});

// security-verify-memory-user-store: Windows' default %TEMP% lies inside
// %LOCALAPPDATA% (a tool folder), and a POSIX TMPDIR can lie inside ~/.cache.
// A disposable project below the temporary root is still ordinary work: it
// must keep its own store, or the memory proof writes its proof rows into
// the real user-level store.
test('a disposable folder below a temporary root inside a tool folder keeps its own store', (t) => {
  const home = sandbox(t);
  const local = path.join(home, 'AppData', 'Local');
  const winTemp = mkdir(path.join(local, 'Temp'));
  const winScratch = mkdir(path.join(winTemp, 'agentic-kit-memory-x'));
  const win = rufloMemoryLocation(winScratch, { home, platform: 'win32', env: { LOCALAPPDATA: local, TEMP: winTemp, TMP: winTemp } });
  assert.equal(win.kind, 'folder', JSON.stringify(win));
  assert.equal(win.root, winScratch);
  assert.equal(rufloMemoryLocation(winTemp, { home, platform: 'win32', env: { LOCALAPPDATA: local, TEMP: winTemp } }).kind, 'user',
    'the temporary root itself still routes to the user-level store');

  const posixTemp = mkdir(path.join(home, '.cache', 'tmp'));
  const scratch = mkdir(path.join(posixTemp, 'agentic-kit-memory-y'));
  const env = { TMPDIR: posixTemp };
  const launch = rufloMcpLaunch(scratch, env, { cfg, rufloVersion: '3.45.0', home });
  assert.equal(launch.location.kind, 'folder', JSON.stringify(launch.location));
  assert.equal(launch.cwd, scratch);
  assert.equal(launch.env.CLAUDE_FLOW_DB_PATH, path.join(scratch, '.swarm', 'memory.db'));
  assert.equal(launch.env.CLAUDE_FLOW_MEMORY_PATH, undefined);
});

test('the filesystem root, the home folder and a temporary root use the one user-level store', (t) => {
  const home = sandbox(t);
  for (const [cwd, reason] of [
    [path.parse(home).root, /filesystem root/],
    [home, /home folder/],
    [os.tmpdir(), /temporary folder/],
  ]) {
    const location = rufloMemoryLocation(cwd, { home });
    assert.equal(location.kind, 'user', cwd);
    assert.equal(location.dir, userStore(home));
    assert.equal(location.db, path.join(userStore(home), 'memory.db'));
    assert.match(location.reason, reason);
  }
});

test('tool-internal folders use the user-level store, Git repository or not', (t) => {
  const home = sandbox(t);
  const chatgpt = mkdir(path.join(home, '.codex', '.chatgpt-projects', 'g-p-demo'));
  assert.equal(rufloMemoryLocation(chatgpt, { home }).kind, 'user');
  assert.match(rufloMemoryLocation(chatgpt, { home }).reason, /\.codex/);
  const marketplace = mkdir(path.join(home, '.claude', 'plugins', 'marketplaces', 'ruflo'));
  fs.mkdirSync(path.join(marketplace, '.git'));
  assert.equal(rufloMemoryLocation(marketplace, { home }).kind, 'user', 'a clone inside ~/.claude is still a tool folder');
  const config = mkdir(path.join(home, '.config', 'opencode'));
  assert.equal(rufloMemoryLocation(config, { home }).kind, 'user');
  const support = mkdir(path.join(home, 'Library', 'Application Support', 'Codex'));
  assert.equal(rufloMemoryLocation(support, { home, platform: 'darwin' }).kind, 'user');
  const custom = mkdir(path.join(home, 'custom-codex-home', 'sessions'));
  assert.equal(rufloMemoryLocation(custom, { home, env: { CODEX_HOME: path.join(home, 'custom-codex-home') } }).kind, 'user',
    'CODEX_HOME is honored');
  const appData = mkdir(path.join(home, 'AppData', 'Roaming', 'Code'));
  assert.equal(rufloMemoryLocation(appData, { home, platform: 'win32', env: { APPDATA: path.join(home, 'AppData', 'Roaming') } }).kind, 'user');
});

// Windows, simulated with path.win32 on any host (the Windows CI runner runs
// the tests above with the real path module). The XDG-style folders are tool
// folders there too: cross-platform CLIs keep them under %USERPROFILE%
// (Claude Code's native installer uses ~\.local\bin, xdg-basedir tools use
// ~\.config), and the ubiquitous language lists them for every platform.
// Windows paths compare case-insensitively, so another spelling of the home
// folder or of %TEMP% is still that folder.
test('Windows path rules: XDG-style tool folders, case-insensitive home and temporary roots (path.win32)', () => {
  const home = 'C:\\Users\\Me';
  const local = 'C:\\Users\\Me\\AppData\\Local';
  const env = { APPDATA: 'C:\\Users\\Me\\AppData\\Roaming', LOCALAPPDATA: local, TEMP: `${local}\\Temp`, TMP: `${local}\\Temp` };
  const at = (cwd, extra = {}) => rufloMemoryLocation(cwd, { home, env: { ...env, ...extra }, platform: 'win32', p: path.win32 });
  const userStore = 'C:\\Users\\Me\\.claude-flow\\memory';
  for (const [cwd, reason] of [
    ['C:\\Users\\Me\\.config\\opencode', /inside ~\/\.config,/],
    ['C:\\Users\\Me\\.local\\share\\claude', /inside ~\/\.local,/],
    ['C:\\Users\\Me\\.cache\\huggingface', /inside ~\/\.cache,/],
    ['C:\\Users\\Me\\.codex\\.chatgpt-projects\\g-p-demo', /inside ~\/\.codex,/],
    ['C:\\Users\\Me\\AppData\\Roaming\\Code', /inside ~\/AppData/],
    ['c:\\users\\me\\.CONFIG\\opencode', /inside ~\/\.config,/],
    ['c:\\users\\me', /the home folder/],
    ['C:\\USERS\\ME\\APPDATA\\LOCAL\\TEMP', /temporary folder/],
    ['D:\\', /filesystem root/],
  ]) {
    const location = at(cwd);
    assert.equal(location.kind, 'user', cwd);
    assert.match(location.reason, reason, cwd);
    assert.deepEqual([location.dir, location.db], [userStore, `${userStore}\\memory.db`], cwd);
  }
  assert.equal(at('D:\\xdg\\config\\tool', { XDG_CONFIG_HOME: 'D:\\xdg\\config' }).kind, 'user', 'an XDG override counts on Windows too');

  for (const cwd of ['C:\\Users\\Me\\AppData\\Local\\Temp\\agentic-kit-memory-x', 'c:\\users\\me\\appdata\\local\\temp\\agentic-kit-memory-x', 'D:\\work\\proj']) {
    const location = at(cwd);
    assert.equal(location.kind, 'folder', `${cwd}: ${location.reason}`);
    assert.deepEqual([location.root, location.db], [cwd, `${cwd}\\.swarm\\memory.db`]);
  }
});

test('a Git repository at the home folder does not pull a plain subfolder into ~/.swarm', (t) => {
  const home = sandbox(t);
  fs.mkdirSync(path.join(home, '.git'));
  const work = mkdir(path.join(home, 'work', 'scratch'));
  const location = rufloMemoryLocation(work, { home });
  assert.equal(location.kind, 'folder', 'the dotfiles repository root is the home folder, so the folder keeps its own store');
  assert.equal(location.root, work);
  assert.equal(memoryProjectRoot(work, { home }), work, 'every ak launch contract agrees with the launcher');
  assert.equal(rufloMemoryLocation(home, { home }).kind, 'user');
});

test('the launcher pins both memory variables to the user-level store and starts Ruflo inside it', (t) => {
  const home = sandbox(t);
  const launch = rufloMcpLaunch(home, { CLAUDE_FLOW_DB_PATH: '/.swarm/memory.db', KEEP: 'yes' }, { cfg, rufloVersion: '3.45.0', home });
  assert.equal(launch.command, 'ruflo');
  assert.deepEqual(launch.args, ['mcp', 'start']);
  assert.equal(launch.cwd, userStore(home), 'cwd-relative files (agentdb.rvf, ruvector.db) land beside the store, not in the home folder');
  assert.equal(launch.env.CLAUDE_FLOW_MEMORY_PATH, userStore(home));
  assert.equal(launch.env.CLAUDE_FLOW_DB_PATH, path.join(userStore(home), 'memory.db'));
  assert.equal(launch.env.KEEP, 'yes');
  assert.equal(launch.location.kind, 'user');
  assert.equal(fs.existsSync(userStore(home)), false, 'building the launch spec creates nothing');
});

test('status outside a project names the launcher\'s user-level store instead of walking the folder', async (t) => {
  const home = sandbox(t);
  rufloStore(path.join(home, '.swarm', 'memory.db'));
  const rows = await projectMemory.collect({ cwd: home, home });
  assert.ok(!rows.some((r) => /canonical project store/.test(r.message)), 'the home folder is not a project');
  const launcher = rows.find((r) => /ak x ruflo-mcp/.test(r.message));
  assert.ok(launcher, JSON.stringify(rows.map((r) => r.message)));
  assert.equal(launcher.level, 'info');
  assert.equal(launcher.fix, null);
  assert.ok(launcher.message.includes(userStore(home)), launcher.message);
  assert.match(launcher.message, /home folder/);
  assert.match(launcher.message, /Claude Code's and Codex's Ruflo launcher/);
  assert.doesNotMatch(launcher.message, /unchanged/, 'Claude Code now starts through the launcher too (B3-D1)');
});

test('status reports the user-level store and stray stores outside projects, for information only', async (t) => {
  const home = sandbox(t);
  assert.deepEqual(await userMemory.collect({ home, env: {} }), [], 'nothing to report on a clean machine');
  rufloStore(path.join(userStore(home), 'memory.db'), 3);
  rufloStore(path.join(home, '.swarm', 'memory.db'));
  rufloStore(path.join(home, '.codex', '.chatgpt-projects', 'g-p-a', '.swarm', 'agentdb-memory.db'));
  rufloStore(path.join(home, '.codex', '.chatgpt-projects', 'g-p-b', '.swarm', 'memory.db'));
  const rows = await userMemory.collect({ home, env: {} });
  assert.ok(rows.every((r) => r.subsystem === 'memory' && r.level === 'info' && r.fix === null), JSON.stringify(rows));
  const store = rows.find((r) => /user-level store/.test(r.message));
  assert.ok(store.message.includes(userStore(home)));
  assert.match(store.message, /memory\.db: 3 active entries/);
  assert.match(store.message, /Claude Code's and Codex's Ruflo launcher outside projects/);
  const strays = rows.filter((r) => /stray/.test(r.message));
  assert.equal(strays.length, 1, 'one row lists every stray store outside projects');
  assert.match(strays[0].message, /~\/\.swarm/);
  assert.match(strays[0].message, /2 under ~\/\.codex\/\.chatgpt-projects/);
  assert.match(strays[0].message, /leaves them in place/);
});

test('Claude mode from the home folder pins both memory variables to the user-level store', (t) => {
  const home = sandbox(t);
  const launch = rufloMcpLaunch(home, { RUFLO_INTELLIGENCE_MODE: 'fast' }, { cfg, rufloVersion: '3.46.1', home, host: 'claude' });
  assert.equal(launch.location.kind, 'user');
  assert.equal(launch.cwd, userStore(home));
  assert.equal(launch.env.CLAUDE_FLOW_MEMORY_PATH, userStore(home));
  assert.equal(launch.env.CLAUDE_FLOW_DB_PATH, path.join(userStore(home), 'memory.db'));
  assert.equal(launch.env.RUFLO_INTELLIGENCE_MODE, 'fast');
});
