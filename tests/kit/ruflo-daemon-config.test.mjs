// ak-managed Ruflo daemon settings (Branch 3, Task 2.2). The daemon reads FLAT
// keys from <root>/.claude-flow/config.json once, in its constructor
// (worker-daemon.js:139-144, 354-416, Ruflo 3.46.1); `ruflo config set`
// writes nested keys and relocates the memory root (ruvnet/ruflo#3449), so ak
// edits the file itself. Start-on-use reads .claude/settings.json
// claudeFlow.daemon.autoStart (daemon-autostart.js:56-76), which `ruflo init`
// writes false. Temp project folders only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  IDLE_FIX_VERSION, applyRufloDaemon, desiredDaemonKeys, reconcileRufloDaemon, releaseRufloDaemon,
} from '../../src/lib/ruflo-daemon-config.mjs';
import { rufloConfigMemoryRoot } from '../../src/lib/ruflo-memory-config.mjs';

function tmpProject(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-ruflo-daemon-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const configFile = (root) => path.join(root, '.claude-flow', 'config.json');
const readConfig = (root) => JSON.parse(fs.readFileSync(configFile(root), 'utf8'));
const settingsFile = (root) => path.join(root, '.claude', 'settings.json');
function writeSettings(root, value) {
  fs.mkdirSync(path.dirname(settingsFile(root)), { recursive: true });
  fs.writeFileSync(settingsFile(root), JSON.stringify(value, null, 2));
}
const autoStart = (root) => JSON.parse(fs.readFileSync(settingsFile(root), 'utf8')).claudeFlow.daemon.autoStart;

test('the idle key is wanted only below the #3194 fix, the memory floor only on macOS', () => {
  assert.equal(IDLE_FIX_VERSION, '3.46.0');
  assert.deepEqual(desiredDaemonKeys({ rufloVersion: '3.45.0', platform: 'darwin' }),
    { 'daemon.idleSecs': 0, 'daemon.resourceThresholds.minFreeMemoryPercent': 0 });
  assert.deepEqual(desiredDaemonKeys({ rufloVersion: '3.45.0', platform: 'linux' }), { 'daemon.idleSecs': 0 });
  assert.deepEqual(desiredDaemonKeys({ rufloVersion: '3.46.1', platform: 'darwin' }),
    { 'daemon.resourceThresholds.minFreeMemoryPercent': 0 });
  assert.deepEqual(desiredDaemonKeys({ rufloVersion: '3.46.0', platform: 'win32' }), {});
  assert.deepEqual(desiredDaemonKeys({ rufloVersion: null, platform: 'linux' }), {}, 'an unknown version never gets the idle key');
});

test('below 3.46.0 on macOS both keys are flat in .claude-flow/config.json', (t) => {
  const root = tmpProject(t);
  const receipts = {};
  const r = reconcileRufloDaemon(root, { rufloVersion: '3.45.0', platform: 'darwin', receipts });
  assert.equal(r.config, 'written');
  assert.equal(r.changed, true);
  const cfg = readConfig(root);
  assert.deepEqual(cfg, { 'daemon.idleSecs': 0, 'daemon.resourceThresholds.minFreeMemoryPercent': 0 });
  assert.equal(cfg.daemon, undefined, 'never nested keys (ruvnet/ruflo#3449)');
  assert.deepEqual(receipts[path.resolve(root)].configKeys, cfg);
  assert.equal(receipts[path.resolve(root)].configCreated, true);
  assert.equal(reconcileRufloDaemon(root, { rufloVersion: '3.45.0', platform: 'darwin', receipts }).config, 'converged');
});

test('on 3.46.1 Linux nothing is written', (t) => {
  const root = tmpProject(t);
  const r = reconcileRufloDaemon(root, { rufloVersion: '3.46.1', platform: 'linux', receipts: {} });
  assert.equal(r.config, 'absent');
  assert.equal(r.changed, false);
  assert.equal(fs.existsSync(configFile(root)), false);
});

test('an upgrade to 3.46.0 removes only the idle key ak wrote', (t) => {
  const root = tmpProject(t);
  const receipts = {};
  reconcileRufloDaemon(root, { rufloVersion: '3.45.0', platform: 'darwin', receipts });
  fs.writeFileSync(configFile(root), JSON.stringify({ ...readConfig(root), providers: [] }));
  const r = reconcileRufloDaemon(root, { rufloVersion: '3.46.1', platform: 'darwin', receipts });
  assert.equal(r.config, 'removed');
  assert.deepEqual(readConfig(root), { 'daemon.resourceThresholds.minFreeMemoryPercent': 0, providers: [] });
  assert.deepEqual(receipts[path.resolve(root)].configKeys, { 'daemon.resourceThresholds.minFreeMemoryPercent': 0 });
});

test('an ak-created file left empty is deleted; a file ak did not create is kept', (t) => {
  const created = tmpProject(t);
  const receipts = {};
  reconcileRufloDaemon(created, { rufloVersion: '3.46.1', platform: 'darwin', receipts });
  assert.equal(reconcileRufloDaemon(created, { rufloVersion: '3.46.1', platform: 'linux', receipts }).config, 'removed');
  assert.equal(fs.existsSync(configFile(created)), false);
  assert.equal(receipts[path.resolve(created)], undefined, 'nothing owned, no receipt');

  const theirs = tmpProject(t);
  fs.mkdirSync(path.join(theirs, '.claude-flow'));
  fs.writeFileSync(configFile(theirs), '{}');
  const own = {};
  reconcileRufloDaemon(theirs, { rufloVersion: '3.46.1', platform: 'darwin', receipts: own });
  assert.equal(own[path.resolve(theirs)].configCreated, false);
  reconcileRufloDaemon(theirs, { rufloVersion: '3.46.1', platform: 'linux', receipts: own });
  assert.deepEqual(readConfig(theirs), {}, 'the file stays: it is a Ruflo project marker ak did not create');
});

test('a user value for a managed key is left alone', (t) => {
  const root = tmpProject(t);
  fs.mkdirSync(path.join(root, '.claude-flow'));
  fs.writeFileSync(configFile(root), JSON.stringify({ 'daemon.resourceThresholds.minFreeMemoryPercent': 2 }));
  const receipts = {};
  const r = reconcileRufloDaemon(root, { rufloVersion: '3.46.1', platform: 'darwin', receipts });
  assert.equal(r.config, 'user-managed');
  assert.equal(r.changed, false);
  assert.deepEqual(readConfig(root), { 'daemon.resourceThresholds.minFreeMemoryPercent': 2 });
});

test('a malformed, non-object or symlinked config.json is user-managed and untouched', (t) => {
  for (const content of ['{', '[]', '"x"']) {
    const root = tmpProject(t);
    fs.mkdirSync(path.join(root, '.claude-flow'));
    fs.writeFileSync(configFile(root), content);
    const r = reconcileRufloDaemon(root, { rufloVersion: '3.45.0', platform: 'darwin', receipts: {} });
    assert.equal(r.config, 'user-managed', content);
    assert.equal(fs.readFileSync(configFile(root), 'utf8'), content);
  }
  const root = tmpProject(t);
  const target = path.join(root, 'elsewhere.json');
  fs.writeFileSync(target, '{}');
  fs.mkdirSync(path.join(root, '.claude-flow'));
  fs.symlinkSync(target, configFile(root));
  assert.equal(reconcileRufloDaemon(root, { rufloVersion: '3.45.0', platform: 'darwin', receipts: {} }).config, 'user-managed');
  assert.equal(fs.readFileSync(target, 'utf8'), '{}');
});

test('YAML markers hold JSON creation in apply and preview without hiding user daemon values', (t) => {
  for (const extension of ['yaml', 'yml']) {
    const root = tmpProject(t);
    fs.mkdirSync(path.join(root, '.claude-flow'));
    const yaml = path.join(root, '.claude-flow', `config.${extension}`);
    fs.writeFileSync(yaml, 'daemon:\n  maxConcurrent: 7\n');
    writeSettings(root, { claudeFlow: { daemon: { autoStart: false } } });
    const receipts = {};
    const preview = reconcileRufloDaemon(root, { rufloVersion: '3.45.0', platform: 'darwin', receipts, dryRun: true });
    assert.equal(preview.config, 'user-managed');
    assert.equal(preview.held?.reason, 'yaml-shadow');
    assert.equal(preview.autostart, 'enabled');
    assert.deepEqual(receipts, {});
    const applied = reconcileRufloDaemon(root, { rufloVersion: '3.45.0', platform: 'darwin', receipts });
    assert.deepEqual({ config: applied.config, held: applied.held, changed: applied.changed },
      { config: preview.config, held: preview.held, changed: preview.changed });
    assert.equal(fs.existsSync(configFile(root)), false);
    assert.equal(fs.readFileSync(yaml, 'utf8'), 'daemon:\n  maxConcurrent: 7\n');
    assert.equal(autoStart(root), true);
  }
});

test('a root JSON config holds ineffective creation of lower-priority daemon JSON', (t) => {
  const root = tmpProject(t);
  fs.writeFileSync(path.join(root, 'claude-flow.config.json'), '{"daemon.maxConcurrent":7}');
  const result = reconcileRufloDaemon(root, { rufloVersion: '3.45.0', platform: 'darwin', receipts: {} });
  assert.equal(result.held?.reason, 'higher-priority-json');
  assert.equal(fs.existsSync(configFile(root)), false);
});

test('a symlinked .claude-flow directory cannot redirect daemon JSON edits outside the project', (t) => {
  const root = tmpProject(t);
  const target = tmpProject(t);
  fs.symlinkSync(target, path.join(root, '.claude-flow'));
  const receipts = {};
  const result = reconcileRufloDaemon(root, { rufloVersion: '3.45.0', platform: 'darwin', receipts });
  assert.equal(result.config, 'user-managed');
  assert.equal(result.held?.invalid, true);
  assert.equal(fs.existsSync(path.join(target, 'config.json')), false);
  assert.deepEqual(receipts, {});
  fs.writeFileSync(path.join(target, 'config.json'), '{}');
  const second = reconcileRufloDaemon(root, { rufloVersion: '3.45.0', platform: 'darwin', receipts });
  assert.equal(second.config, 'user-managed');
  assert.equal(fs.readFileSync(path.join(target, 'config.json'), 'utf8'), '{}');
});

test('root JSON becoming active holds new keys but permits receipted obsolete-key cleanup', (t) => {
  const root = tmpProject(t);
  const receipts = {};
  reconcileRufloDaemon(root, { rufloVersion: '3.45.0', platform: 'darwin', receipts });
  fs.writeFileSync(path.join(root, 'claude-flow.config.json'), '{"daemon.maxConcurrent":7}');
  const result = reconcileRufloDaemon(root, { rufloVersion: '3.46.1', platform: 'darwin', receipts });
  assert.equal(result.held?.reason, 'higher-priority-json');
  assert.deepEqual(readConfig(root), { 'daemon.resourceThresholds.minFreeMemoryPercent': 0 });
  assert.deepEqual(receipts[path.resolve(root)].configKeys,
    { 'daemon.resourceThresholds.minFreeMemoryPercent': 0 });
});

test('an existing JSON keeps its ownership rules beside YAML, and release exposes YAML again', (t) => {
  const root = tmpProject(t);
  const receipts = {};
  reconcileRufloDaemon(root, { rufloVersion: '3.45.0', platform: 'darwin', receipts });
  const yaml = path.join(root, '.claude-flow', 'config.yml');
  fs.writeFileSync(yaml, 'daemon:\n  maxConcurrent: 7\n');
  const preview = reconcileRufloDaemon(root, { rufloVersion: '3.46.1', platform: 'linux', receipts, dryRun: true });
  assert.equal(preview.config, 'removed');
  assert.equal(fs.existsSync(configFile(root)), true);
  assert.equal(reconcileRufloDaemon(root, { rufloVersion: '3.46.1', platform: 'linux', receipts }).config, 'removed');
  assert.equal(fs.existsSync(configFile(root)), false);
  assert.equal(fs.readFileSync(yaml, 'utf8'), 'daemon:\n  maxConcurrent: 7\n');
  assert.deepEqual(receipts, {});
});

test('a YAML hold stops repeated low-memory restarts while leaving the YAML and receipts alone', async (t) => {
  const root = rufloRepo(t);
  fs.writeFileSync(path.join(root, '.claude-flow', 'config.yaml'), 'daemon:\n  maxConcurrent: 7\n');
  fs.mkdirSync(path.join(root, '.claude-flow', 'logs'));
  fs.writeFileSync(path.join(root, '.claude-flow', 'logs', 'daemon.log'),
    `[${new Date().toISOString()}] [INFO] Worker consolidate deferred: Memory too low: 3.9% free\n`);
  const { calls, runner } = recorder();
  const cfg = { rufloDaemon: { receipts: {} } };
  const result = await applyRufloDaemon(root, { cfg, rufloVersion: '3.46.1', platform: 'darwin', runner, alive: () => true });
  assert.equal(result.restarted, false);
  assert.deepEqual(calls, []);
  assert.equal(fs.existsSync(configFile(root)), false);
  assert.deepEqual(cfg.rufloDaemon.receipts, {});
});

test('the memory pin still wins and .swarm stays the memory root', (t) => {
  const root = tmpProject(t);
  fs.writeFileSync(path.join(root, 'claude-flow.config.json'), JSON.stringify({ memory: { persistPath: '.swarm' } }));
  reconcileRufloDaemon(root, { rufloVersion: '3.45.0', platform: 'darwin', receipts: {} });
  assert.equal(rufloConfigMemoryRoot(root).resolved, path.join(root, '.swarm'));
  fs.rmSync(path.join(root, 'claude-flow.config.json'));
  assert.equal(rufloConfigMemoryRoot(root), null, 'the daemon-only file has no memory key: Ruflo falls back to <cwd>/.swarm');
});

test("init's autoStart:false becomes true with a receipt, and release restores it", (t) => {
  const root = tmpProject(t);
  writeSettings(root, { claudeFlow: { daemon: { autoStart: false }, other: 1 }, hooks: {} });
  const receipts = {};
  const r = reconcileRufloDaemon(root, { rufloVersion: '3.46.1', platform: 'darwin', receipts });
  assert.equal(r.autostart, 'enabled');
  assert.equal(autoStart(root), true);
  assert.equal(receipts[path.resolve(root)].autostartBefore, false);
  assert.equal(reconcileRufloDaemon(root, { rufloVersion: '3.46.1', platform: 'darwin', receipts }).autostart, 'converged');

  const released = releaseRufloDaemon(root, receipts);
  assert.equal(released.ok, true);
  assert.equal(autoStart(root), false, 'the old value is back');
  assert.equal(fs.existsSync(configFile(root)), false, 'the file ak created is gone');
  assert.equal(receipts[path.resolve(root)], undefined);
  const settings = JSON.parse(fs.readFileSync(settingsFile(root), 'utf8'));
  assert.equal(settings.claudeFlow.other, 1, 'other settings survive');
});

test('a true or absent autoStart is left alone and needs no receipt', (t) => {
  const root = tmpProject(t);
  writeSettings(root, { claudeFlow: { daemon: { autoStart: true } } });
  const receipts = {};
  assert.equal(reconcileRufloDaemon(root, { rufloVersion: '3.46.1', platform: 'linux', receipts }).autostart, 'converged');
  assert.equal(receipts[path.resolve(root)], undefined);
  const bare = tmpProject(t);
  assert.equal(reconcileRufloDaemon(bare, { rufloVersion: '3.46.1', platform: 'linux', receipts }).autostart, 'converged');
  assert.equal(fs.existsSync(settingsFile(bare)), false, 'no settings file is created');
});

test('kit.json rufloDaemon.autoStart:false leaves the setting alone, and turns back what ak changed', (t) => {
  const root = tmpProject(t);
  writeSettings(root, { claudeFlow: { daemon: { autoStart: false } } });
  const receipts = {};
  const r = reconcileRufloDaemon(root, { rufloVersion: '3.46.1', platform: 'linux', receipts, autoStart: false });
  assert.equal(r.autostart, 'user-managed');
  assert.equal(autoStart(root), false);
  reconcileRufloDaemon(root, { rufloVersion: '3.46.1', platform: 'linux', receipts });
  assert.equal(autoStart(root), true);
  const off = reconcileRufloDaemon(root, { rufloVersion: '3.46.1', platform: 'linux', receipts, autoStart: false });
  assert.equal(off.autostart, 'restored');
  assert.equal(autoStart(root), false);
});

test('a dry run reports the change and writes nothing', (t) => {
  const root = tmpProject(t);
  writeSettings(root, { claudeFlow: { daemon: { autoStart: false } } });
  const receipts = {};
  const r = reconcileRufloDaemon(root, { rufloVersion: '3.45.0', platform: 'darwin', receipts, dryRun: true });
  assert.deepEqual({ config: r.config, autostart: r.autostart, changed: r.changed }, { config: 'written', autostart: 'enabled', changed: true });
  assert.equal(fs.existsSync(configFile(root)), false);
  assert.equal(autoStart(root), false);
  assert.deepEqual(receipts, {});
});

test('reconcile never spawns ruflo', (t) => {
  const root = tmpProject(t);
  const runner = () => { throw new Error('reconcile must not run a command'); };
  const r = reconcileRufloDaemon(root, { rufloVersion: '3.45.0', platform: 'darwin', receipts: {}, runner });
  assert.equal(r.config, 'written');
});

// ── sync: converge the working project and restart a live daemon ───────────
// A Ruflo repository: .git, .claude-flow/ and Ruflo's durable project store.
function rufloRepo(t) {
  const root = tmpProject(t);
  fs.mkdirSync(path.join(root, '.git'));
  fs.mkdirSync(path.join(root, '.claude-flow'));
  fs.mkdirSync(path.join(root, '.swarm'));
  fs.writeFileSync(path.join(root, '.swarm', 'memory.db'), '');
  return root;
}
const recorder = () => {
  const calls = [];
  const runner = async (cmd, args, opts) => { calls.push([cmd, ...args, opts?.cwd]); return { code: 0, stdout: '', stderr: '' }; };
  return { calls, runner };
};

test('sync writes the settings and restarts a live daemon so it reads them', async (t) => {
  const root = rufloRepo(t);
  const cfg = { rufloDaemon: { receipts: {} } };
  const { calls, runner } = recorder();
  const r = await applyRufloDaemon(path.join(root), { cfg, rufloVersion: '3.46.1', platform: 'darwin', runner, alive: () => true });
  assert.equal(r.result.config, 'written');
  assert.equal(r.restarted, true);
  assert.deepEqual(calls, [['ruflo', 'daemon', 'stop', root], ['ruflo', 'daemon', 'start', root]]);
  assert.ok(cfg.rufloDaemon.receipts[path.resolve(root)], 'the receipt is recorded on the config');
  const again = recorder();
  const second = await applyRufloDaemon(root, { cfg, rufloVersion: '3.46.1', platform: 'darwin', runner: again.runner, alive: () => true });
  assert.equal(second.restarted, false);
  assert.deepEqual(again.calls, [], 'converged: nothing restarted');
});

test('sync never starts a daemon that was not running, and ignores a folder outside a Ruflo repository', async (t) => {
  const root = rufloRepo(t);
  const { calls, runner } = recorder();
  const r = await applyRufloDaemon(root, { cfg: { rufloDaemon: { receipts: {} } }, rufloVersion: '3.46.1', platform: 'darwin', runner, alive: () => false });
  assert.equal(r.restarted, false);
  assert.deepEqual(calls, []);
  const plain = tmpProject(t);
  assert.equal(await applyRufloDaemon(plain, { cfg: { rufloDaemon: { receipts: {} } }, rufloVersion: '3.46.1', platform: 'darwin', runner }), null);
  assert.equal(fs.existsSync(configFile(plain)), false);
});

test('a live daemon still deferring for low memory after the floor is set is restarted once', async (t) => {
  const root = rufloRepo(t);
  const cfg = { rufloDaemon: { receipts: {} } };
  reconcileRufloDaemon(root, { rufloVersion: '3.46.1', platform: 'darwin', receipts: cfg.rufloDaemon.receipts });
  fs.mkdirSync(path.join(root, '.claude-flow', 'logs'));
  fs.writeFileSync(path.join(root, '.claude-flow', 'logs', 'daemon.log'),
    `[${new Date().toISOString()}] [INFO] Worker consolidate deferred: Memory too low: 3.9% free\n`);
  const { calls, runner } = recorder();
  const r = await applyRufloDaemon(root, { cfg, rufloVersion: '3.46.1', platform: 'darwin', runner, alive: () => true });
  assert.equal(r.result.config, 'converged');
  assert.equal(r.restarted, true);
  assert.equal(calls.length, 2);
});

test('a daemon that deferred once and has since run the job is not restarted', async (t) => {
  const root = rufloRepo(t);
  const cfg = { rufloDaemon: { receipts: {} } };
  reconcileRufloDaemon(root, { rufloVersion: '3.46.1', platform: 'darwin', receipts: cfg.rufloDaemon.receipts });
  const deferredAt = Date.now() - 60 * 60_000;
  fs.mkdirSync(path.join(root, '.claude-flow', 'logs'));
  fs.writeFileSync(path.join(root, '.claude-flow', 'logs', 'daemon.log'),
    `[${new Date(deferredAt).toISOString()}] [INFO] Worker consolidate deferred: Memory too low: 3.9% free\n`);
  fs.mkdirSync(path.join(root, '.claude-flow', 'metrics'));
  fs.writeFileSync(path.join(root, '.claude-flow', 'metrics', 'consolidation.json'),
    JSON.stringify({ timestamp: new Date(deferredAt + 30 * 60_000).toISOString(), distillationEnabled: true }));
  const { calls, runner } = recorder();
  const r = await applyRufloDaemon(root, { cfg, rufloVersion: '3.46.1', platform: 'darwin', runner, alive: () => true });
  assert.equal(r.restarted, false);
  assert.deepEqual(calls, []);
});

test('a daemon deferring under a user-managed config.json is not restarted: sync changed nothing it reads', async (t) => {
  for (const content of ['{', JSON.stringify({ 'daemon.resourceThresholds.minFreeMemoryPercent': 2 })]) {
    const root = rufloRepo(t);
    fs.writeFileSync(configFile(root), content);
    fs.mkdirSync(path.join(root, '.claude-flow', 'logs'));
    fs.writeFileSync(path.join(root, '.claude-flow', 'logs', 'daemon.log'),
      `[${new Date().toISOString()}] [INFO] Worker consolidate deferred: Memory too low: 3.9% free\n`);
    const { calls, runner } = recorder();
    const r = await applyRufloDaemon(root, { cfg: { rufloDaemon: { receipts: {} } }, rufloVersion: '3.46.1', platform: 'darwin', runner, alive: () => true });
    assert.equal(r.result.config, 'user-managed', content);
    assert.equal(r.restarted, false, content);
    assert.deepEqual(calls, [], content);
    assert.equal(fs.readFileSync(configFile(root), 'utf8'), content);
  }
});

// F5 (Branch 3 fix round 2): Ruflo 3.46.1 treats a folder as a Ruflo project
// only with a durable marker (services/daemon-autostart.js:90-123, isRufloProject):
// .claude-flow/config.{yaml,yml,json}, claude-flow.config.json,
// .swarm/memory.db, settings.json `claudeFlow`, or a ruflo/claude-flow server in
// .mcp.json. A bare .claude-flow/ is not one: Ruflo's own startup migration can
// create it (see that function's comment). Writing .claude-flow/config.json there would itself make
// the folder a Ruflo project, so the next ruflo command would start a daemon.
function bareRepo(t) {
  const root = tmpProject(t);
  fs.mkdirSync(path.join(root, '.git'));
  fs.mkdirSync(path.join(root, '.claude-flow'));
  return root;
}

test('a repository with only a bare .claude-flow folder is not a Ruflo project: sync writes nothing there', async (t) => {
  const root = bareRepo(t);
  const { calls, runner } = recorder();
  const cfg = { rufloDaemon: { receipts: {} } };
  assert.equal(await applyRufloDaemon(root, { cfg, rufloVersion: '3.46.1', platform: 'darwin', runner, alive: () => true }), null);
  assert.equal(fs.existsSync(configFile(root)), false);
  assert.deepEqual(calls, []);
  assert.deepEqual(cfg.rufloDaemon.receipts, {});
});

test("each of Ruflo's durable markers makes the repository a Ruflo project", async (t) => {
  const markers = {
    'config.yaml': (root) => fs.writeFileSync(path.join(root, '.claude-flow', 'config.yaml'), ''),
    'config.yml': (root) => fs.writeFileSync(path.join(root, '.claude-flow', 'config.yml'), ''),
    'config.json': (root) => fs.writeFileSync(configFile(root), '{}'),
    'claude-flow.config.json': (root) => fs.writeFileSync(path.join(root, 'claude-flow.config.json'), '{}'),
    '.swarm/memory.db': (root) => {
      fs.mkdirSync(path.join(root, '.swarm'));
      fs.writeFileSync(path.join(root, '.swarm', 'memory.db'), '');
    },
    'settings claudeFlow': (root) => writeSettings(root, { claudeFlow: {} }),
    '.mcp.json ruflo': (root) => fs.writeFileSync(path.join(root, '.mcp.json'), JSON.stringify({ mcpServers: { ruflo: {} } })),
    '.mcp.json claude-flow': (root) => fs.writeFileSync(path.join(root, '.mcp.json'), JSON.stringify({ mcpServers: { 'claude-flow': {} } })),
  };
  for (const [name, mark] of Object.entries(markers)) {
    const root = bareRepo(t);
    mark(root);
    const r = await applyRufloDaemon(root, { cfg: { rufloDaemon: { receipts: {} } }, rufloVersion: '3.46.1', platform: 'darwin', dryRun: true });
    assert.equal(r?.root, root, name);
  }
  for (const [name, mark] of Object.entries({
    'settings without claudeFlow': (root) => writeSettings(root, { env: {} }),
    '.mcp.json without Ruflo': (root) => fs.writeFileSync(path.join(root, '.mcp.json'), JSON.stringify({ mcpServers: { other: {} } })),
    'malformed .mcp.json': (root) => fs.writeFileSync(path.join(root, '.mcp.json'), '{'),
  })) {
    const root = bareRepo(t);
    mark(root);
    assert.equal(await applyRufloDaemon(root, { cfg: { rufloDaemon: { receipts: {} } }, rufloVersion: '3.46.1', platform: 'darwin', dryRun: true }), null, name);
  }
});
