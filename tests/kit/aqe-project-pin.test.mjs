// B5-D1/B5-D1a/B5-D1b (retired, agentic-qe#735): `reconcileAqePin` can still pin the
// project root with three absolute values (AQE_PROJECT_ROOT, AQE_MEMORY_PATH,
// AQE_STORAGE_PATH) in the three project files, each under a receipt (the project
// Codex config holds two targets: the agentic-qe env table and
// [shell_environment_policy.set]) — exercised directly here so release and
// migration still work — but no production caller writes a new pin; sync and setup release
// one an older ak wrote only when that is safe (tests/kit/aqe-pin-release-gate.test.mjs). Every test runs in its own
// temporary project.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { tempDir } from './helpers/temp-dir.mjs';
import {
  desiredAqePin, reconcileAqePin, AQE_PIN_RECEIPT, AQE_SHELL_PIN_RECEIPT, releaseAqePins, recordAqePinProject,
} from '../../src/lib/aqe-project-pin.mjs';
import memoryPin from '../../src/commands/status/sections/memory-pin.mjs';

const CODEX_AQE = '[mcp_servers.agentic-qe]\ncommand = "aqe-mcp"\nstartup_timeout_sec = 30\n\n'
  + '[mcp_servers.agentic-qe.env]\nAQE_MEMORY_PATH = ".agentic-qe/memory.db"\nAQE_V3_MODE = "true"\n\n'
  + '[shell_environment_policy]\ninherit = "core"\n\n'
  + '[shell_environment_policy.set]\nAQE_MEMORY_PATH = ".agentic-qe/memory.db"\nAQE_V3_MODE = "true"\n';
const SHELL_TABLE = '[shell_environment_policy.set]';

function project(t, { aqe = true, codex = true } = {}) {
  const root = tempDir('ak-aqe-pin', t);
  fs.mkdirSync(path.join(root, '.git'));
  if (aqe) fs.mkdirSync(path.join(root, '.agentic-qe'));
  const write = (rel, value) => {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n');
    return file;
  };
  const cfg = { aqe: true, integrations: { hosts: { claude: true, codex } } };
  return { root, write, cfg };
}
const json = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const pinOf = (root) => ({
  AQE_PROJECT_ROOT: root,
  AQE_MEMORY_PATH: path.join(root, '.agentic-qe', 'memory.db'),
  AQE_STORAGE_PATH: path.join(root, '.agentic-qe'),
});

function seedAll(write) {
  const settings = write('.claude/settings.local.json', { env: { KEEP: 'x' } });
  const mcp = write('.mcp.json', { mcpServers: { 'agentic-qe': { command: 'aqe-mcp', args: [], env: { NODE_ENV: 'production' } } } });
  const codex = write('.codex/config.toml', CODEX_AQE);
  return { settings, mcp, codex };
}

test('desiredAqePin gives three absolute values under the real root', (t) => {
  const { root } = project(t);
  assert.deepEqual(desiredAqePin(root), pinOf(fs.realpathSync(root)));
});

test('desiredAqePin builds Windows paths with path.win32', () => {
  const pin = desiredAqePin('C:\\work\\proj', { pathApi: path.win32, realpath: (p) => p });
  assert.deepEqual(pin, {
    AQE_PROJECT_ROOT: 'C:\\work\\proj',
    AQE_MEMORY_PATH: 'C:\\work\\proj\\.agentic-qe\\memory.db',
    AQE_STORAGE_PATH: 'C:\\work\\proj\\.agentic-qe',
  });
});

test('all three targets gain the absolute pin with receipts; a second run changes nothing', (t) => {
  const { root, write, cfg } = project(t);
  const { settings, mcp, codex } = seedAll(write);
  const first = reconcileAqePin(cfg, root);
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.changed, true);
  const want = pinOf(root);
  assert.deepEqual(json(settings).env, { KEEP: 'x', ...want });
  assert.deepEqual(json(mcp).mcpServers['agentic-qe'].env, { NODE_ENV: 'production', ...want });
  const toml = fs.readFileSync(codex, 'utf8');
  for (const [key, value] of Object.entries(want)) assert.ok(toml.includes(`${key} = ${JSON.stringify(value)}`), `${key} in ${toml}`);
  for (const file of [settings, mcp, codex]) assert.ok(fs.existsSync(`${file}${AQE_PIN_RECEIPT}`), `${file} receipt`);
  assert.ok(fs.existsSync(`${codex}${AQE_SHELL_PIN_RECEIPT}`), 'shell table receipt');
  const shell = toml.slice(toml.indexOf(SHELL_TABLE));
  for (const [key, value] of Object.entries(want)) assert.ok(shell.includes(`${key} = ${JSON.stringify(value)}`), `${key} in ${shell}`);
  assert.equal(first.findings.length, 4, JSON.stringify(first.findings));
  const second = reconcileAqePin(cfg, root);
  assert.equal(second.changed, false, JSON.stringify(second.findings));
  assert.ok(second.findings.every((f) => f.status === 'converged'), JSON.stringify(second.findings));
});

test('AQE\'s own relative AQE_MEMORY_PATH in both project Codex tables is replaced under the receipts; other keys stay', (t) => {
  const { root, write, cfg } = project(t);
  const codex = write('.codex/config.toml', CODEX_AQE);
  const result = reconcileAqePin(cfg, root);
  assert.equal(result.ok, true, JSON.stringify(result));
  const toml = fs.readFileSync(codex, 'utf8');
  const absolute = `AQE_MEMORY_PATH = ${JSON.stringify(path.join(root, '.agentic-qe', 'memory.db'))}`;
  const envTable = toml.slice(toml.indexOf('[mcp_servers.agentic-qe.env]'), toml.indexOf('[shell_environment_policy]'));
  assert.ok(envTable.includes(absolute), envTable);
  assert.ok(!envTable.includes('".agentic-qe/memory.db"'), envTable);
  const shell = toml.slice(toml.indexOf(SHELL_TABLE));
  assert.ok(shell.includes(absolute), shell);
  assert.ok(!shell.includes('".agentic-qe/memory.db"'), shell);
  assert.ok(shell.includes('AQE_V3_MODE = "true"'), shell);
  assert.ok(toml.includes('[shell_environment_policy]\ninherit = "core"\n\n'), toml);
  const receipt = json(`${codex}${AQE_PIN_RECEIPT}`);
  assert.deepEqual(receipt.keys.AQE_MEMORY_PATH.before, { present: true, value: '.agentic-qe/memory.db' });
  const shellReceipt = json(`${codex}${AQE_SHELL_PIN_RECEIPT}`);
  assert.deepEqual(shellReceipt.keys.AQE_MEMORY_PATH.before, { present: true, value: '.agentic-qe/memory.db' });
  assert.deepEqual(shellReceipt.keys.AQE_PROJECT_ROOT.before, { present: false });
  const second = reconcileAqePin(cfg, root);
  assert.equal(second.changed, false, JSON.stringify(second.findings));
  assert.equal(fs.readFileSync(codex, 'utf8'), toml);
});

test('the shell table is pinned when it exists even without an AQE registration, and never created from nothing', (t) => {
  const { root, write, cfg } = project(t);
  const only = '[shell_environment_policy.set]\nAQE_MEMORY_PATH = ".agentic-qe/memory.db"\nOTHER = "1"\n';
  const codex = write('.codex/config.toml', only);
  reconcileAqePin(cfg, root);
  const toml = fs.readFileSync(codex, 'utf8');
  for (const [key, value] of Object.entries(pinOf(root))) assert.ok(toml.includes(`${key} = ${JSON.stringify(value)}`), toml);
  assert.ok(toml.includes('OTHER = "1"'), toml);
  assert.equal(reconcileAqePin(cfg, root, { enabled: false }).ok, true);
  assert.equal(fs.readFileSync(codex, 'utf8'), only);
  const bare = project(t);
  const plain = bare.write('.codex/config.toml', 'model = "x"\n');
  reconcileAqePin(bare.cfg, bare.root);
  assert.equal(fs.readFileSync(plain, 'utf8'), 'model = "x"\n');
  assert.equal(fs.existsSync(`${plain}${AQE_SHELL_PIN_RECEIPT}`), false);
});

test('with AQE\'s Codex registration and no shell table, a shell table is added and removed again on release', (t) => {
  const { root, write, cfg } = project(t);
  const source = '[mcp_servers.agentic-qe]\ncommand = "aqe-mcp"\n';
  const codex = write('.codex/config.toml', source);
  reconcileAqePin(cfg, root);
  const toml = fs.readFileSync(codex, 'utf8');
  const shell = toml.slice(toml.indexOf(SHELL_TABLE));
  assert.ok(shell.startsWith(SHELL_TABLE), toml);
  for (const [key, value] of Object.entries(pinOf(root))) assert.ok(shell.includes(`${key} = ${JSON.stringify(value)}`), shell);
  assert.ok(toml.includes('[mcp_servers.agentic-qe.env]'), 'the env table is added too');
  reconcileAqePin(cfg, root, { enabled: false });
  // Review minor 1/2: both tables ak added are gone again, byte for byte.
  assert.equal(fs.readFileSync(codex, 'utf8'), source);
});

test('a table ak added keeps its header on release when the user wrote into it', (t) => {
  const { root, write, cfg } = project(t);
  const source = '[mcp_servers.agentic-qe]\ncommand = "aqe-mcp"\n';
  const codex = write('.codex/config.toml', source);
  reconcileAqePin(cfg, root);
  fs.appendFileSync(codex, 'MINE = "1"\n');
  reconcileAqePin(cfg, root, { enabled: false });
  const released = fs.readFileSync(codex, 'utf8');
  assert.ok(released.includes(`${SHELL_TABLE}\nMINE = "1"\n`), released);
  assert.ok(!released.includes('AQE_PROJECT_ROOT'), released);
});

test('a settings.local.json ak created is removed on release when nothing else is in it; one the user had stays', (t) => {
  const { root, cfg } = project(t, { codex: false });
  const settings = path.join(root, '.claude', 'settings.local.json');
  reconcileAqePin(cfg, root);
  assert.deepEqual(json(settings).env, pinOf(root));
  reconcileAqePin(cfg, root, { enabled: false });
  assert.equal(fs.existsSync(settings), false, 'no {} file left behind');
  assert.deepEqual(fs.readdirSync(path.join(root, '.claude')), [], 'no receipt or backup left behind');
  reconcileAqePin(cfg, root);
  const doc = json(settings); doc.permissions = { allow: [] };
  fs.writeFileSync(settings, JSON.stringify(doc, null, 2) + '\n');
  reconcileAqePin(cfg, root, { enabled: false });
  assert.deepEqual(json(settings), { permissions: { allow: [] } }, 'a file with the user\'s own content stays');
  const kept = project(t, { codex: false });
  const own = kept.write('.claude/settings.local.json', '{}\n');
  reconcileAqePin(kept.cfg, kept.root);
  reconcileAqePin(kept.cfg, kept.root, { enabled: false });
  assert.equal(fs.readFileSync(own, 'utf8'), '{}\n', 'a file ak did not create is never removed');
});

test('ak keeps at most its newest pin backup per file (review minor 3)', (t) => {
  const { root, write, cfg } = project(t);
  const { settings, mcp, codex } = seedAll(write);
  for (let i = 0; i < 3; i += 1) {
    reconcileAqePin(cfg, root);
    const doc = json(settings); doc.env[`N${i}`] = 'x'; delete doc.env.AQE_PROJECT_ROOT;
    fs.writeFileSync(settings, JSON.stringify(doc, null, 2) + '\n');
  }
  reconcileAqePin(cfg, root, { enabled: false });
  for (const file of [settings, mcp, codex]) {
    const backups = fs.readdirSync(path.dirname(file)).filter((name) => name.startsWith(`${path.basename(file)}.ak-aqe-pin-backup.`));
    assert.ok(backups.length <= 1, `${file}: ${backups.join(', ')}`);
  }
  const other = `${settings}.ak-aqe-backup.keep`;
  fs.writeFileSync(other, 'another projection\'s backup');
  reconcileAqePin(cfg, root);
  assert.ok(fs.existsSync(other), 'only the pin\'s own backups are pruned');
});

test('a foreign shell-table value is preserved, never rewritten', (t) => {
  const { root, write, cfg } = project(t);
  const source = '[mcp_servers.agentic-qe]\ncommand = "aqe-mcp"\n\n[shell_environment_policy.set]\nAQE_MEMORY_PATH = "/elsewhere/memory.db"\n';
  const codex = write('.codex/config.toml', source);
  const result = reconcileAqePin(cfg, root);
  assert.equal(result.ok, true);
  const toml = fs.readFileSync(codex, 'utf8');
  assert.ok(toml.slice(toml.indexOf(SHELL_TABLE)).includes('AQE_MEMORY_PATH = "/elsewhere/memory.db"'), toml);
  const shellFinding = result.findings.find((f) => f.kind === 'shell');
  assert.ok(shellFinding.conflicts.some((c) => c.key === 'AQE_MEMORY_PATH'), JSON.stringify(shellFinding));
});

test('an inline or dotted shell environment set is preserved as a hand fix, never rewritten', (t) => {
  for (const source of [
    '[mcp_servers.agentic-qe]\ncommand = "aqe-mcp"\n\n[shell_environment_policy]\nset = { AQE_MEMORY_PATH = ".agentic-qe/memory.db" }\n',
    'shell_environment_policy.set.AQE_MEMORY_PATH = ".agentic-qe/memory.db"\n\n[mcp_servers.agentic-qe]\ncommand = "aqe-mcp"\n',
    '[mcp_servers.agentic-qe]\ncommand = "aqe-mcp"\n\n[shell_environment_policy.set]\n"AQE_MEMORY_PATH" = ".agentic-qe/memory.db"\n',
  ]) {
    const { root, write, cfg } = project(t);
    const codex = write('.codex/config.toml', source);
    const result = reconcileAqePin(cfg, root);
    assert.equal(result.ok, true);
    const shellFinding = result.findings.find((f) => f.kind === 'shell');
    assert.equal(shellFinding.status, 'conflict', source);
    const toml = fs.readFileSync(codex, 'utf8');
    assert.ok(toml.includes('.agentic-qe/memory.db'), toml);
    assert.equal(fs.existsSync(`${codex}${AQE_SHELL_PIN_RECEIPT}`), false);
  }
});

test('AQE re-init after an upgrade puts its relative AQE_MEMORY_PATH back: ak takes it back under the receipt (review M4)', (t) => {
  const { root, write, cfg } = project(t);
  const { settings, codex } = seedAll(write);
  const original = fs.readFileSync(codex, 'utf8');
  reconcileAqePin(cfg, root);
  // AQE's mergeExistingTomlConfig (AQE/dist/init/codex-installer.js:316-330) drops the
  // agentic-qe tables and appends its own with the relative value; settings-merge.js:142
  // writes the same value into Claude settings.
  const absolute = JSON.stringify(path.join(root, '.agentic-qe', 'memory.db'));
  fs.writeFileSync(codex, fs.readFileSync(codex, 'utf8').replaceAll(`AQE_MEMORY_PATH = ${absolute}`, 'AQE_MEMORY_PATH = ".agentic-qe/memory.db"'));
  const doc = json(settings); doc.env.AQE_MEMORY_PATH = '.agentic-qe/memory.db';
  fs.writeFileSync(settings, JSON.stringify(doc, null, 2) + '\n');
  const again = reconcileAqePin(cfg, root);
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.deepEqual(again.findings.flatMap((f) => f.conflicts), [], 'AQE\'s own value is not a user edit');
  const toml = fs.readFileSync(codex, 'utf8');
  assert.ok(!toml.includes('".agentic-qe/memory.db"'), toml);
  assert.equal(json(settings).env.AQE_MEMORY_PATH, path.join(root, '.agentic-qe', 'memory.db'));
  assert.deepEqual(json(`${codex}${AQE_PIN_RECEIPT}`).keys.AQE_MEMORY_PATH.before, { present: true, value: '.agentic-qe/memory.db' }, 'the receipt keeps the first before-state');
  // Released right after such a re-init, the file is AQE's again with no receipt left.
  fs.writeFileSync(codex, fs.readFileSync(codex, 'utf8').replaceAll(`AQE_MEMORY_PATH = ${absolute}`, 'AQE_MEMORY_PATH = ".agentic-qe/memory.db"'));
  const released = reconcileAqePin(cfg, root, { enabled: false });
  assert.equal(released.ok, true, JSON.stringify(released));
  assert.equal(fs.readFileSync(codex, 'utf8'), original);
  assert.equal(fs.existsSync(`${codex}${AQE_PIN_RECEIPT}`), false);
  // Any other value is still a user edit, preserved.
  reconcileAqePin(cfg, root);
  const edited = json(settings); edited.env.AQE_MEMORY_PATH = '/mine/memory.db';
  fs.writeFileSync(settings, JSON.stringify(edited, null, 2) + '\n');
  const kept = reconcileAqePin(cfg, root);
  assert.ok(kept.findings.some((f) => f.conflicts.some((c) => /user-edited/.test(c.reason))), JSON.stringify(kept.findings));
  assert.equal(json(settings).env.AQE_MEMORY_PATH, '/mine/memory.db');
});

test('releasing the pin restores the receipted before-state, AQE\'s relative value included', (t) => {
  const { root, write, cfg } = project(t);
  const { settings, mcp, codex } = seedAll(write);
  const before = [settings, mcp, codex].map((f) => fs.readFileSync(f, 'utf8'));
  reconcileAqePin(cfg, root);
  const released = reconcileAqePin(cfg, root, { enabled: false });
  assert.equal(released.ok, true, JSON.stringify(released));
  assert.deepEqual(json(settings), JSON.parse(before[0]));
  assert.deepEqual(json(mcp), JSON.parse(before[1]));
  assert.equal(fs.readFileSync(codex, 'utf8'), before[2]);
  for (const file of [settings, mcp, codex]) assert.equal(fs.existsSync(`${file}${AQE_PIN_RECEIPT}`), false);
  assert.equal(fs.existsSync(`${codex}${AQE_SHELL_PIN_RECEIPT}`), false);
});

test('ak uninstall releases the pin in every recorded project, from any folder', (t) => {
  const { root, write, cfg } = project(t);
  const { settings, codex } = seedAll(write);
  reconcileAqePin(cfg, root);
  recordAqePinProject(cfg, root);
  const elsewhere = tempDir('ak-aqe-pin-elsewhere', t);
  const result = releaseAqePins(cfg, { cwd: elsewhere });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(json(settings).env, { KEEP: 'x' });
  assert.equal(fs.readFileSync(codex, 'utf8'), CODEX_AQE, 'both Codex tables restored, AQE\'s relative values included');
  assert.equal(fs.existsSync(`${codex}${AQE_SHELL_PIN_RECEIPT}`), false);
  assert.deepEqual(cfg.integrations.ownership.aqePin.projects, {});
});

test('a different pre-existing value is preserved, not overwritten (decision 13)', (t) => {
  const { root, write, cfg } = project(t);
  const settings = write('.claude/settings.local.json', { env: { AQE_MEMORY_PATH: '/elsewhere/memory.db' } });
  const before = fs.readFileSync(settings, 'utf8');
  const result = reconcileAqePin(cfg, root);
  assert.equal(result.ok, true, 'a preserved value is a hand fix, not a failed sync (decision 13)');
  assert.equal(json(settings).env.AQE_MEMORY_PATH, '/elsewhere/memory.db');
  assert.notEqual(fs.readFileSync(settings, 'utf8'), before, 'the other two keys are still written');
});

// agentic-qe#735: released agentic-qe (>=3.14.5) resolves AQE_PROJECT_ROOT, the
// memory database and the storage folder from a subfolder on its own (dist/kernel
// /project-root.js's findProjectRoot, read by dist/learning/embedder-identity-store.js
// and dist/init/token-bootstrap.js), so ak's callers (sync, setup, status) now pass
// `enabled: false`: the pin is never written going forward, only released where an
// older ak version left one.
test('ak no longer writes the pin: a project with .agentic-qe gets nothing new, and a receipted pin from before the fix is released', (t) => {
  const { root, write, cfg } = project(t);
  const { settings, mcp, codex } = seedAll(write);
  const before = [settings, mcp, codex].map((f) => fs.readFileSync(f, 'utf8'));
  const first = reconcileAqePin(cfg, root, { enabled: false });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.changed, false);
  assert.equal(first.active, false);
  assert.deepEqual([settings, mcp, codex].map((f) => fs.readFileSync(f, 'utf8')), before);
  reconcileAqePin(cfg, root);
  assert.notDeepEqual([settings, mcp, codex].map((f) => fs.readFileSync(f, 'utf8')), before);
  const released = reconcileAqePin(cfg, root, { enabled: false });
  assert.equal(released.ok, true, JSON.stringify(released));
  assert.deepEqual([settings, mcp, codex].map((f) => fs.readFileSync(f, 'utf8')), before);
  for (const file of [settings, mcp, codex]) assert.equal(fs.existsSync(`${file}${AQE_PIN_RECEIPT}`), false);
});

test('status reports no aqe-pin rows once the pin can be released, even with a stale receipted pin present', async (t) => {
  const { root, write, cfg } = project(t);
  seedAll(write);
  reconcileAqePin(cfg, root);
  const aqePin = { version: '3.14.7', find: () => ({ strays: [], complete: true }) };
  const rows = await memoryPin.collect({ cwd: root, cfg: { ...cfg, aqe: true }, aqePin });
  const pinAwareRows = rows.filter((r) => r.subsystem === 'aqe-pin');
  assert.deepEqual(pinAwareRows, [], JSON.stringify(rows));
});

test('outside a repository, or without .agentic-qe, nothing is written', (t) => {
  const { root, write, cfg } = project(t, { aqe: false });
  const { settings, mcp, codex } = seedAll(write);
  const before = [settings, mcp, codex].map((f) => fs.readFileSync(f, 'utf8'));
  assert.equal(reconcileAqePin(cfg, root).changed, false);
  assert.deepEqual([settings, mcp, codex].map((f) => fs.readFileSync(f, 'utf8')), before);
  const bare = tempDir('ak-aqe-pin-norepo', t);
  fs.mkdirSync(path.join(bare, '.agentic-qe'));
  const outside = reconcileAqePin(cfg, bare);
  assert.equal(outside.changed, false);
  assert.equal(outside.root, null);
  assert.deepEqual(fs.readdirSync(bare), ['.agentic-qe']);
});

test('dry run plans without writing', (t) => {
  const { root, write, cfg } = project(t);
  const { settings } = seedAll(write);
  const before = fs.readFileSync(settings, 'utf8');
  assert.equal(reconcileAqePin(cfg, root, { dryRun: true }).changed, true);
  assert.equal(fs.readFileSync(settings, 'utf8'), before);
  assert.equal(fs.existsSync(`${settings}${AQE_PIN_RECEIPT}`), false);
});

test('the user-level Codex config is never a target, and a disabled host is skipped', (t) => {
  const { root, write, cfg } = project(t, { codex: false });
  const { codex } = seedAll(write);
  const before = fs.readFileSync(codex, 'utf8');
  const result = reconcileAqePin(cfg, root);
  assert.equal(fs.readFileSync(codex, 'utf8'), before);
  assert.ok(result.findings.every((f) => f.file.startsWith(root + path.sep)), JSON.stringify(result.findings));
});

test('an unrecognized AQE transport in .mcp.json is preserved as a hand fix', (t) => {
  const { root, write, cfg } = project(t);
  const mcp = write('.mcp.json', { mcpServers: { 'agentic-qe': { command: 'bash', args: ['-c', 'aqe-mcp'] } } });
  const before = fs.readFileSync(mcp, 'utf8');
  const result = reconcileAqePin(cfg, root);
  assert.equal(result.ok, true);
  assert.equal(fs.readFileSync(mcp, 'utf8'), before);
  const finding = result.findings.find((f) => f.file === mcp);
  assert.equal(finding.status, 'conflict');
  assert.match(finding.reason, /unrecognized AQE MCP transport/);
});

// Maintainer decision B5-M5 (review M5): a pin target git tracks is never pinned; a
// committed absolute path would point teammates' AQE at a path their machines lack.
const gitEnv = (home) => ({ PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' });
function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', env: gitEnv(root) });
  assert.equal(result.status, 0, result.stderr);
}
const haveGit = spawnSync('git', ['--version'], { stdio: 'ignore', env: { PATH: process.env.PATH } }).status === 0;

test('git-tracked .mcp.json and .codex/config.toml are skipped; settings.local.json is pinned', { skip: !haveGit }, (t) => {
  const { root, write, cfg } = project(t);
  fs.rmSync(path.join(root, '.git'), { recursive: true });
  git(root, ['init', '-q']);
  const { settings, mcp, codex } = seedAll(write);
  git(root, ['add', '--', '.mcp.json', '.codex/config.toml']);
  const before = [mcp, codex].map((f) => fs.readFileSync(f, 'utf8'));
  const result = reconcileAqePin(cfg, root);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual([mcp, codex].map((f) => fs.readFileSync(f, 'utf8')), before, 'tracked files are not written');
  for (const f of [mcp, codex]) assert.equal(fs.existsSync(`${f}${AQE_PIN_RECEIPT}`), false);
  assert.deepEqual(json(settings).env, { KEEP: 'x', ...pinOf(root) }, 'settings.local.json is always pinned');
  const tracked = result.findings.filter((f) => f.status === 'tracked').map((f) => path.relative(root, f.file).split(path.sep).join('/'));
  assert.deepEqual([...new Set(tracked)].sort(), ['.codex/config.toml', '.mcp.json']);
});

test('a pin ak wrote before the file was tracked is released under its receipt', { skip: !haveGit }, (t) => {
  const { root, write, cfg } = project(t);
  fs.rmSync(path.join(root, '.git'), { recursive: true });
  git(root, ['init', '-q']);
  const { mcp } = seedAll(write);
  const original = fs.readFileSync(mcp, 'utf8');
  reconcileAqePin(cfg, root);
  assert.ok(fs.readFileSync(mcp, 'utf8').includes('AQE_PROJECT_ROOT'), 'untracked in a repository: pinned as before');
  git(root, ['add', '--', '.mcp.json']);
  const result = reconcileAqePin(cfg, root);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(json(mcp), JSON.parse(original));
  assert.equal(fs.existsSync(`${mcp}${AQE_PIN_RECEIPT}`), false);
});
