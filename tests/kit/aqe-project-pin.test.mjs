// B5-D1/B5-D1a: AQE is pinned to the project root with three absolute values
// (AQE_PROJECT_ROOT, AQE_MEMORY_PATH, AQE_STORAGE_PATH) in the three project
// files, each under a receipt. Every test runs in its own temporary project.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from './helpers/temp-dir.mjs';
import {
  desiredAqePin, reconcileAqePin, AQE_PIN_RECEIPT, releaseAqePins, recordAqePinProject,
} from '../../src/lib/aqe-project-pin.mjs';
import memoryPin from '../../src/commands/status/sections/memory-pin.mjs';

const CODEX_AQE = '[mcp_servers.agentic-qe]\ncommand = "aqe-mcp"\nstartup_timeout_sec = 30\n\n'
  + '[mcp_servers.agentic-qe.env]\nAQE_MEMORY_PATH = ".agentic-qe/memory.db"\nAQE_V3_MODE = "true"\n\n'
  + '[shell_environment_policy.set]\nAQE_MEMORY_PATH = ".agentic-qe/memory.db"\n';

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
  const second = reconcileAqePin(cfg, root);
  assert.equal(second.changed, false, JSON.stringify(second.findings));
  assert.ok(second.findings.every((f) => f.status === 'converged'), JSON.stringify(second.findings));
});

test('AQE\'s own relative AQE_MEMORY_PATH in the project Codex env is replaced under the receipt, and the shell table is untouched', (t) => {
  const { root, write, cfg } = project(t);
  const codex = write('.codex/config.toml', CODEX_AQE);
  reconcileAqePin(cfg, root);
  const toml = fs.readFileSync(codex, 'utf8');
  const envTable = toml.slice(toml.indexOf('[mcp_servers.agentic-qe.env]'), toml.indexOf('[shell_environment_policy.set]'));
  assert.ok(envTable.includes(`AQE_MEMORY_PATH = ${JSON.stringify(path.join(root, '.agentic-qe', 'memory.db'))}`), envTable);
  assert.ok(!envTable.includes('".agentic-qe/memory.db"'), envTable);
  assert.ok(toml.endsWith('[shell_environment_policy.set]\nAQE_MEMORY_PATH = ".agentic-qe/memory.db"\n'), toml);
  const receipt = json(`${codex}${AQE_PIN_RECEIPT}`);
  assert.deepEqual(receipt.keys.AQE_MEMORY_PATH.before, { present: true, value: '.agentic-qe/memory.db' });
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
});

test('ak uninstall releases the pin in every recorded project, from any folder', (t) => {
  const { root, write, cfg } = project(t);
  const { settings } = seedAll(write);
  reconcileAqePin(cfg, root);
  recordAqePinProject(cfg, root);
  const elsewhere = tempDir('ak-aqe-pin-elsewhere', t);
  const result = releaseAqePins(cfg, { cwd: elsewhere });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(json(settings).env, { KEEP: 'x' });
  assert.deepEqual(cfg.integrations.ownership.aqePin.projects, {});
});

test('any other different value is preserved and reported as a hand fix naming the file', async (t) => {
  const { root, write, cfg } = project(t);
  const settings = write('.claude/settings.local.json', { env: { AQE_MEMORY_PATH: '/elsewhere/memory.db' } });
  const before = fs.readFileSync(settings, 'utf8');
  const result = reconcileAqePin(cfg, root);
  assert.equal(result.ok, true, 'a preserved value is a hand fix, not a failed sync (decision 13)');
  assert.equal(json(settings).env.AQE_MEMORY_PATH, '/elsewhere/memory.db');
  assert.notEqual(fs.readFileSync(settings, 'utf8'), before, 'the other two keys are still written');
  const rows = await memoryPin.collect({ cwd: root, cfg });
  const hand = rows.find((r) => r.repair === 'manual' && /AQE/.test(r.message));
  assert.ok(hand, JSON.stringify(rows));
  assert.match(hand.fix, /settings\.local\.json/);
});

test('a pin naming another root warns in the memory-pin row: re-run ak sync in this checkout', async (t) => {
  const { root, write, cfg } = project(t);
  const other = '/Users/someone/other-checkout';
  write('.claude/settings.local.json', { env: {
    AQE_PROJECT_ROOT: other, AQE_MEMORY_PATH: `${other}/.agentic-qe/memory.db`, AQE_STORAGE_PATH: `${other}/.agentic-qe`,
  } });
  const rows = await memoryPin.collect({ cwd: path.join(root), cfg });
  const foreign = rows.find((r) => r.message.includes(other));
  assert.ok(foreign, JSON.stringify(rows));
  assert.equal(foreign.level, 'warn');
  assert.equal(foreign.repair, 'manual');
  assert.match(foreign.fix, /re-run ak sync in this checkout/);
  assert.match(foreign.fix, /settings\.local\.json/);
});

test('a missing pin is a sync repair in the memory-pin row, read from the repository root', async (t) => {
  const { root, write, cfg } = project(t);
  seedAll(write);
  const sub = path.join(root, 'sub');
  fs.mkdirSync(sub);
  const rows = await memoryPin.collect({ cwd: sub, cfg });
  const missing = rows.find((r) => r.subsystem === 'aqe-pin');
  assert.ok(missing, JSON.stringify(rows));
  assert.equal(missing.level, 'warn');
  assert.equal(missing.repair, 'sync');
  assert.match(missing.message, /subfolder/);
  reconcileAqePin(cfg, sub);
  const after = await memoryPin.collect({ cwd: sub, cfg });
  assert.ok(!after.some((r) => r.subsystem === 'aqe-pin' && r.level === 'warn'), JSON.stringify(after));
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
