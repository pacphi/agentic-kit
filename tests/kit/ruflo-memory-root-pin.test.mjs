// Registering a provider must never move or hide project memory (audit
// Addendum 2, problem 1; ruvnet/ruflo#3193). Ruflo 3.45.0's `providers
// configure` creates claude-flow.config.json from its defaults when a project
// has no Ruflo JSON configuration (`ruflo init` writes only config.yaml), and
// those defaults carry memory.persistPath "./data/memory", which getMemoryRoot
// honors: the CLI then reports "Database not found" and .swarm/memory.db is
// orphaned. The stub runners below reproduce ConfigFileManager's lookup and
// write rules (services/config-file-manager.js, commands/providers.js, 3.45.0).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { applyProviders } from '../../src/lib/providers.mjs';
import section from '../../src/commands/status/sections/project-memory.mjs';

const RUFLO_DEFAULT_MEMORY = Object.freeze({
  backend: 'hybrid', persistPath: './data/memory', cacheSize: 1000, enableHNSW: true, vectorDimension: 384,
});
const CONFIG_FILES = ['claude-flow.config.json', path.join('.claude-flow', 'config.json')];

function project(t, { yaml = true, memoryEntries = 1 } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ak-memory-pin-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, '.git'));
  if (yaml) {
    fs.mkdirSync(path.join(dir, '.claude-flow'));
    fs.writeFileSync(path.join(dir, '.claude-flow', 'config.yaml'), 'memory:\n  persistPath: .claude-flow/data\n');
  }
  if (memoryEntries !== null) {
    fs.mkdirSync(path.join(dir, '.swarm'));
    const db = new DatabaseSync(path.join(dir, '.swarm', 'memory.db'));
    db.exec('CREATE TABLE memory_entries (namespace TEXT, key TEXT, status TEXT)');
    for (let i = 0; i < memoryEntries; i += 1) db.exec(`INSERT INTO memory_entries VALUES ('ns', 'k${i}', 'active')`);
    db.close();
  }
  return dir;
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

/** Ruflo's ConfigFileManager: the first project file, else an existing
 *  CLAUDE_FLOW_CONFIG file, else a new claude-flow.config.json from defaults.
 *  `overwriteMemory` models a future Ruflo that rewrites memory settings even
 *  in an existing file. */
function rufloStub({ env = {}, overwriteMemory = false } = {}) {
  const calls = [];
  const runner = async (bin, args, opts) => {
    calls.push({ bin, args, cwd: opts.cwd });
    const cwd = opts.cwd;
    const envFile = env.CLAUDE_FLOW_CONFIG ? path.resolve(cwd, env.CLAUDE_FLOW_CONFIG) : null;
    const found = CONFIG_FILES.map((name) => path.join(cwd, name)).find((file) => fs.existsSync(file))
      ?? (envFile && fs.existsSync(envFile) ? envFile : null);
    const config = found
      ? readJson(found)
      : { version: '3.5', agents: { providers: [] }, memory: { ...RUFLO_DEFAULT_MEMORY } };
    if (overwriteMemory) config.memory = { ...RUFLO_DEFAULT_MEMORY };
    config.agents ??= {};
    config.agents.providers ??= [];
    const provider = args[args.indexOf('-p') + 1];
    let entry = config.agents.providers.find((p) => p.name === provider);
    if (!entry) { entry = { name: provider, enabled: true }; config.agents.providers.push(entry); }
    if (args.includes('-m')) entry.model = args[args.indexOf('-m') + 1];
    fs.writeFileSync(found ?? path.join(cwd, 'claude-flow.config.json'), `${JSON.stringify(config, null, 2)}\n`);
    return { code: 0, stdout: '', stderr: '' };
  };
  return { runner, calls };
}

const cfgWith = (...models) => ({ providers: { models } });
const deps = (runner, env = {}) => ({ haveFn: async () => true, runner, versionFn: () => '3.45.0', env });

test('registering a provider in a project with only config.yaml keeps Ruflo memory in .swarm', async (t) => {
  const cwd = project(t);
  const { runner } = rufloStub();
  const result = await applyProviders(cfgWith({ id: 'openrouter', model: 'z-ai/glm-5.2' }), cwd, deps(runner));
  assert.equal(result.ok, true);
  assert.equal(result.status, 'ok');
  const written = readJson(path.join(cwd, 'claude-flow.config.json'));
  assert.equal(written.memory?.persistPath, '.swarm', 'the pin ak wrote survives Ruflo adding its keys');
  assert.equal(path.resolve(cwd, written.memory.persistPath), path.join(cwd, '.swarm'));
  assert.deepEqual(written.agents.providers.map((p) => p.name), ['openrouter'], 'the provider is still registered');
  const rows = await section.collect({ cwd });
  assert.ok(!rows.some((r) => /points Ruflo memory/.test(r.message)), 'no orphaned-store warning after a pinned registration');
});

test('an existing Ruflo JSON configuration is used as it is: ak writes no pin', async (t) => {
  const cwd = project(t);
  const file = path.join(cwd, '.claude-flow', 'config.json');
  fs.writeFileSync(file, JSON.stringify({ agents: { providers: [] } }));
  const { runner } = rufloStub();
  await applyProviders(cfgWith({ id: 'ollama', model: 'qwen3.6:27b' }), cwd, deps(runner));
  assert.equal(fs.existsSync(path.join(cwd, 'claude-flow.config.json')), false);
  assert.equal(readJson(file).memory, undefined, 'Ruflo only added its provider');
});

test('a CLAUDE_FLOW_CONFIG file keeps receiving Ruflo\'s provider writes: no project pin shadows it', async (t) => {
  const cwd = project(t);
  const envFile = path.join(cwd, 'my-ruflo.json');
  fs.writeFileSync(envFile, JSON.stringify({ agents: { providers: [] } }));
  const env = { CLAUDE_FLOW_CONFIG: envFile };
  const { runner } = rufloStub({ env });
  await applyProviders(cfgWith({ id: 'openrouter', model: 'z-ai/glm-5.2' }), cwd, deps(runner, env));
  assert.equal(fs.existsSync(path.join(cwd, 'claude-flow.config.json')), false);
  assert.deepEqual(readJson(envFile).agents.providers.map((p) => p.name), ['openrouter']);
});

test('no configured providers writes no Ruflo configuration at all', async (t) => {
  const cwd = project(t);
  const { runner, calls } = rufloStub();
  const result = await applyProviders(cfgWith(), cwd, deps(runner));
  assert.equal(result.detail, 'no providers configured');
  assert.equal(calls.length, 0);
  assert.equal(fs.existsSync(path.join(cwd, 'claude-flow.config.json')), false);
});

test('a Ruflo that overwrites the pin gets it restored, and the remaining providers are skipped', async (t) => {
  const cwd = project(t);
  const { runner, calls } = rufloStub({ overwriteMemory: true });
  const result = await applyProviders(cfgWith(
    { id: 'openrouter', model: 'z-ai/glm-5.2' },
    { id: 'ollama', model: 'qwen3.6:27b' },
  ), cwd, deps(runner));
  assert.equal(calls.length, 1, 'registration stops once Ruflo moved the memory root');
  const written = readJson(path.join(cwd, 'claude-flow.config.json'));
  assert.equal(written.memory.persistPath, '.swarm', 'ak put its pin back');
  assert.deepEqual(written.agents.providers.map((p) => p.name), ['openrouter'], 'what Ruflo registered is kept');
  assert.equal(result.status, 'degraded');
  assert.match(result.detail, /openrouter/);
  assert.match(result.detail, /ollama\(skipped/);
  assert.match(result.detail, /ruvnet\/ruflo#3193/);
  assert.match(result.detail, /restored/);
});

test('when the pin cannot be written, registration is skipped rather than moving memory', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async (t) => {
  const cwd = project(t, { yaml: false });
  const { runner, calls } = rufloStub();
  fs.chmodSync(cwd, 0o555);
  let result;
  try {
    result = await applyProviders(cfgWith({ id: 'openrouter', model: 'z-ai/glm-5.2' }), cwd, deps(runner));
  } finally {
    fs.chmodSync(cwd, 0o755);
  }
  assert.equal(calls.length, 0, 'Ruflo is never asked to write its defaults');
  assert.equal(result.status, 'degraded');
  assert.equal(result.ok, false);
  assert.match(result.detail, /skipped: could not pin Ruflo's memory root/);
  assert.match(result.detail, /ruvnet\/ruflo#3193/);
});

test('status warns when a Ruflo JSON configuration points memory away from a populated .swarm store', async (t) => {
  const cwd = project(t);
  fs.writeFileSync(path.join(cwd, 'claude-flow.config.json'), JSON.stringify({ memory: { ...RUFLO_DEFAULT_MEMORY } }));
  const rows = await section.collect({ cwd });
  const orphan = rows.find((r) => /points Ruflo memory/.test(r.message));
  assert.ok(orphan, 'the orphaned store is reported');
  assert.equal(orphan.level, 'warn');
  assert.equal(orphan.fix, null, 'a manual decision: ak never edits a configuration it did not write');
  assert.match(orphan.message, /claude-flow\.config\.json/);
  assert.match(orphan.message, /\.\/data\/memory/);
  assert.match(orphan.message, /1 entry/);
  assert.match(orphan.message, /"\.swarm"/, 'names the value that points Ruflo back');
  assert.match(orphan.message, /ruvnet\/ruflo#3193/);
});

test('the orphan check follows Ruflo\'s own lookup: a file without a memory path falls through to the next', async (t) => {
  const cwd = project(t);
  fs.writeFileSync(path.join(cwd, 'claude-flow.config.json'), JSON.stringify({ agents: { providers: [] } }));
  fs.writeFileSync(path.join(cwd, '.claude-flow', 'config.json'), JSON.stringify({ memory: { path: 'elsewhere' } }));
  const orphan = (await section.collect({ cwd })).find((r) => /points Ruflo memory/.test(r.message));
  assert.ok(orphan);
  assert.match(orphan.message, /\.claude-flow\/config\.json/);
  assert.match(orphan.message, /memory\.path/);
});

test('no warning when the configuration keeps .swarm, or when .swarm holds no entries', async (t) => {
  const pinned = project(t);
  fs.writeFileSync(path.join(pinned, 'claude-flow.config.json'), JSON.stringify({ memory: { persistPath: '.swarm' } }));
  assert.ok(!(await section.collect({ cwd: pinned })).some((r) => /points Ruflo memory/.test(r.message)));
  const absolute = project(t);
  fs.writeFileSync(path.join(absolute, 'claude-flow.config.json'),
    JSON.stringify({ memory: { persistPath: path.join(absolute, '.swarm') } }));
  assert.ok(!(await section.collect({ cwd: absolute })).some((r) => /points Ruflo memory/.test(r.message)));
  const empty = project(t, { memoryEntries: 0 });
  fs.writeFileSync(path.join(empty, 'claude-flow.config.json'), JSON.stringify({ memory: { ...RUFLO_DEFAULT_MEMORY } }));
  assert.ok(!(await section.collect({ cwd: empty })).some((r) => /points Ruflo memory/.test(r.message)));
});
