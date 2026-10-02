// tests/kit/purge-sandboxed-home.test.mjs
// #313 (exit release 4.0.0-alpha.61): `ak uninstall --purge` is proven here, not asserted. A real `ak`
// child process runs setup (and `host pick`) against a sandboxed HOME and project with fake CLIs, then
// `--purge --yes`, and the result is compared with a fingerprint taken before any of it.
//
// Kept on purpose, so the comparison names them instead of ignoring a folder:
//   - safety backups (`*.bak`, `*.bak.<ms>`): ak copies a user's own file before editing it, and a purge
//     keeps those copies because they are the user's content;
//   - the user data a default purge keeps: AQE store-merge archives and ~/.claude-flow/memory.
// Folders such as ~/.local/state, ~/.config and ~/.claude/skills exist in the baseline, as they do on a
// real machine, because an empty XDG or Claude folder is not state ak can prove it created.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { snapshot, spawnEnv, writeKitConfig, offlineKitConfig } from './helpers/home-sandbox.mjs';
import { tempDir } from './helpers/temp-dir.mjs';
import { installFakeClis, fakeNpmRoot } from './helpers/fake-clis.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BIN = path.join(ROOT, 'bin', 'agentic-kit.mjs');
const SETUP = ['setup', '--yes', '--minimal', '--aqe-embedding-mode', 'unmanaged', '--no-aqe',
  '--no-agent-browser', '--no-ruvnet-brain', '--no-security'];

const USER_CLAUDE_MD = '# My notes\n\nKeep me.\n';
const USER_CODEX_MD = '# My Codex notes\n\nKeep me too.\n';
const USER_CODEX_TOML = '[mcp_servers.mine]\ncommand = "node"\nargs = ["mine.mjs"]\n';
const ARCHIVE = 'archived store-merge backup';
const MEMORY = 'the user memories';

/** A realistic, populated HOME and project, fake CLIs, and the fingerprints taken before any ak command. */
function sandbox(t) {
  const root = tempDir('ak-purge-proof', t);
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  const bare = path.join(root, 'bare'); // no .git, so setup runs at machine scope
  const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
  fs.mkdirSync(path.join(project, '.git'), { recursive: true });
  fs.mkdirSync(bare, { recursive: true });
  for (const dir of ['.config', '.local/state', '.claude/skills']) fs.mkdirSync(path.join(home, dir), { recursive: true });
  if (process.platform === 'win32') fs.mkdirSync(path.join(home, 'AppData', 'Local'), { recursive: true }); // LOCALAPPDATA
  write(path.join(home, '.claude', 'CLAUDE.md'), USER_CLAUDE_MD);
  write(path.join(home, '.claude', 'skills', 'my-skill', 'SKILL.md'), '# my skill\n');
  write(path.join(home, '.codex', 'AGENTS.md'), USER_CODEX_MD);
  write(path.join(home, '.codex', 'config.toml'), USER_CODEX_TOML);
  write(path.join(home, '.local', 'state', 'agentic-kit', 'aqe-store-merge', 'backup-1', 'memory.db'), ARCHIVE);
  write(path.join(home, '.claude-flow', 'memory', 'memory.db'), MEMORY);
  const fakes = installFakeClis(root, { globalRoot: fakeNpmRoot(root), codexConfig: path.join(home, '.codex', 'config.toml') });
  const env = spawnEnv(home, {
    PATH: [fakes.bin, '/usr/bin', '/bin'].join(path.delimiter),
    npm_config_prefix: path.join(root, 'npm-prefix'),
    npm_config_cache: path.join(root, 'npm-cache'),
    RUVNET_BRAIN_KB: path.join(root, 'no-brain-kb'),
    AQE_EMBEDDER_ENDPOINT: '', AQE_EMBEDDER_TOKEN: '',
    NO_COLOR: '1',
  });
  // spawnEnv creates home/tmp, so the fingerprints come after it.
  const before = { home: snapshot(home), project: snapshot(project) };
  writeKitConfig(home, offlineKitConfig({ mcp: { register: false }, security: false }));
  const ak = (args, cwd) => {
    const run = spawnSync(process.execPath, [BIN, ...args], { cwd, env, encoding: 'utf8', timeout: 120_000 });
    return { status: run.status, out: `${run.stdout}\n${run.stderr}` };
  };
  const read = (...parts) => fs.readFileSync(path.join(home, ...parts), 'utf8');
  return { home, project, bare, before, fakes, ak, read };
}

/** Every path added (+), changed (~) or removed (-) between two snapshots, with forward slashes. */
function changes(before, after) {
  const out = [];
  for (const [key, hash] of after) {
    if (!before.has(key)) out.push(`+ ${key}`);
    else if (before.get(key) !== hash) out.push(`~ ${key}`);
  }
  for (const key of before.keys()) if (!after.has(key)) out.push(`- ${key}`);
  return out.map((line) => line.replaceAll('\\', '/'));
}

const SAFETY_BACKUP = /\.bak(\.\d+)?$/;
/** What a purge may leave: the safety backups, plus any path the caller names and justifies. */
const unexplained = (list, allowed = []) => list.filter((line) => !SAFETY_BACKUP.test(line) && !allowed.includes(line.slice(2)));

test('setup then --purge returns a populated HOME to its pre-setup fingerprint', (t) => {
  const s = sandbox(t);
  const setup = s.ak(SETUP, s.bare);
  assert.equal(setup.status, 0, setup.out);
  // Not vacuous: setup really wrote ak's footprint into the HOME it is about to be purged from.
  assert.match(s.read('.claude', 'CLAUDE.md'), /<!-- BEGIN ruflo-/);
  assert.ok(fs.existsSync(path.join(s.home, '.claude', 'skills', 'ruflo-token-audit', 'SKILL.md')), 'setup deployed its skill');
  assert.ok(fs.existsSync(path.join(s.home, '.config', 'agentic-kit', 'kit.json')), 'setup wrote kit.json');
  assert.notDeepEqual(snapshot(s.home), s.before.home, 'setup changed the HOME');

  const purge = s.ak(['uninstall', '--purge', '--yes'], s.bare);
  assert.equal(purge.status, 0, purge.out);

  assert.deepEqual(unexplained(changes(s.before.home, snapshot(s.home))), [],
    'a purged HOME differs from its pre-setup fingerprint only by safety backups');
  assert.equal(s.read('.claude', 'CLAUDE.md'), USER_CLAUDE_MD, 'the user\'s own CLAUDE.md is restored byte for byte');
  assert.equal(s.read('.codex', 'AGENTS.md'), USER_CODEX_MD, 'the user\'s own Codex AGENTS.md is restored byte for byte');
  assert.equal(s.read('.local', 'state', 'agentic-kit', 'aqe-store-merge', 'backup-1', 'memory.db'), ARCHIVE, 'AQE archives are kept');
  assert.equal(s.read('.claude-flow', 'memory', 'memory.db'), MEMORY, 'the Ruflo memory store is kept');
  assert.deepEqual(s.fakes.calls().filter((call) => /^npm view /.test(call)), [],
    'uninstall runs no version check afterwards, which would write a default kit.json back');
});

test('host wiring from `ak host pick` is removed by --purge from HOME and from the project', (t) => {
  const s = sandbox(t);
  assert.equal(s.ak(SETUP, s.bare).status, 0);
  const pick = s.ak(['host', 'pick', '--host', 'claude,codex', '--yes'], s.project);
  assert.equal(pick.status, 0, pick.out);
  // Not vacuous: Codex now carries ak's ruflo entry beside the user's own, and the project carries provider env.
  assert.match(s.read('.codex', 'config.toml'), /\[mcp_servers\.ruflo\]/,
    `Codex has no ruflo entry; fake CLI calls:\n${s.fakes.calls().join('\n')}\npick output:\n${pick.out}`);
  assert.match(s.read('.codex', 'config.toml'), /\[mcp_servers\.mine\]/);
  const projectSettings = path.join(s.project, '.claude', 'settings.local.json');
  assert.match(fs.readFileSync(projectSettings, 'utf8'), /ENABLE_CODEX/);

  const purge = s.ak(['uninstall', '--purge', '--yes'], s.project);
  assert.equal(purge.status, 0, purge.out);

  assert.equal(s.read('.codex', 'config.toml'), USER_CODEX_TOML, 'Codex keeps the user\'s entry and loses only ak\'s');
  assert.ok(s.fakes.calls().includes('codex mcp remove ruflo'), 'the Codex teardown ran');
  assert.deepEqual(unexplained(changes(s.before.home, snapshot(s.home))), [], 'HOME is back to its fingerprint but for backups');
  // The emptied project settings file stays (ak cannot prove it did not exist), with none of ak's keys in it.
  assert.deepEqual(unexplained(changes(s.before.project, snapshot(s.project)), ['.claude/', '.claude/settings.local.json']), [],
    'the project differs only by the emptied settings file and its backup');
  const left = JSON.parse(fs.readFileSync(projectSettings, 'utf8'));
  assert.deepEqual(Object.keys(left.env ?? {}).filter((key) => /^(ENABLE_|AQE_)/.test(key)), [], 'no ak-owned provider env remains');
});

test('--purge --dry-run after setup changes nothing and runs no teardown command', (t) => {
  const s = sandbox(t);
  assert.equal(s.ak(SETUP, s.bare).status, 0);
  const homeAfterSetup = snapshot(s.home);
  const callsAfterSetup = s.fakes.calls().length;
  const dry = s.ak(['uninstall', '--purge', '--dry-run', '--yes'], s.bare);
  assert.equal(dry.status, 0, dry.out);
  assert.match(dry.out, /\[dry-run\]/);
  assert.deepEqual(changes(homeAfterSetup, snapshot(s.home)), [], 'a dry run leaves the HOME exactly as setup left it');
  assert.deepEqual(s.fakes.calls().slice(callsAfterSetup).filter((call) => /uninstall -g|mcp remove|daemon stop/.test(call)), []);
});
