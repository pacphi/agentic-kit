import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  sandboxHome, assertSandboxed, sandboxProject, writeKitConfig,
  offlineKitConfig, fakeGlobalRoot, captureLog, snapshot, assertUnchanged,
} from './helpers/home-sandbox.mjs';

const sandbox = sandboxHome('ak-mcp-convergence');
const paths = await import('../../src/lib/paths.mjs');
assertSandboxed(paths, sandbox);
const sync = await import('../../src/commands/sync.mjs');
const setup = await import('../../src/commands/setup.mjs');
const { loadKitConfig } = await import('../../src/lib/config.mjs');
const { codexMcpTopology, repairCodexMcpTopology, register, claudeMcpTopology } = await import('../../src/lib/mcp.mjs');
const { ensureRufloMcpInCodex } = await import('../../src/lib/providers.mjs');
const { reconcileCodexMcp } = await import('../../src/lib/codex-mcp-reconcile.mjs');
const project = sandboxProject('ak-mcp-convergence');
const pkgRoot = path.resolve(import.meta.dirname, '../..');
const canonical = '[mcp_servers.ruflo]\ncommand = "ak"\nargs = ["x", "ruflo-mcp"]\n';
const legacy = '[mcp_servers.claude-flow]\ncommand = "ruflo"\nargs = ["mcp", "start"]\n';
const unrelated = '[mcp_servers.notes]\ncommand = "notes-server"\n';
const file = paths.codexConfigPath();
const inspect = () => codexMcpTopology({ cwd: project, home: sandbox });
let removals = 0;

function seed(source = canonical + legacy + unrelated) {
  writeKitConfig(sandbox, offlineKitConfig({
    aqe: false, security: false, agentdb: false,
    mcp: { register: false, excludeFamilies: [] },
    integrations: { version: 3, hosts: { claude: true, codex: true, opencode: false },
      bindings: [], ownership: { codex: { reverseMcp: 'ak' } } },
  }));
  paths._setGlobalRootForTest(fakeGlobalRoot(sandbox, { ruflo: '9.9.9' }));
  fs.mkdirSync(paths.codexDir(), { recursive: true });
  fs.writeFileSync(file, source);
  fs.writeFileSync(paths.claudeUserMcpPath(), JSON.stringify({ mcpServers: {} }));
  removals = 0;
}

async function repair(plan, cwd) {
  return repairCodexMcpTopology(plan, cwd, {
    inspect,
    runner: async (command, args) => {
      assert.equal(command, 'codex');
      assert.deepEqual(args, ['mcp', 'remove', 'claude-flow']);
      removals++;
      const source = fs.readFileSync(file, 'utf8');
      fs.writeFileSync(file, source.replace(/\[mcp_servers\.claude-flow\][\s\S]*?(?=\[mcp_servers\.|$)/, ''));
      return { code: 0, stdout: '', stderr: '' };
    },
  });
}

function rows() {
  return inspect().duplicateRuflo
    ? [{ subsystem: 'codex-mcp', level: 'warn', message: 'duplicate Ruflo transports', fix: 'ak sync repairs duplicates' }]
    : [];
}

async function run({ yes = false, confirm = async () => false, collectFn = rows, repairFn = repair } = {}) {
  const previous = process.cwd();
  process.chdir(project);
  try {
    return await captureLog(() => sync.run({
      pkgRoot, flags: { 'no-upgrade': true, yes, 'dry-run': false }, collectFn,
      confirmCodexRepair: confirm, inspectCodexTopology: inspect, repairCodexTopology: repairFn,
    }));
  } finally { process.chdir(previous); }
}

test('sync repairs an approved alias and remembers only the disclosed correction on later runs', async () => {
  seed();
  let prompts = 0;
  const first = await run({ confirm: async message => { prompts++; assert.match(message, /future|remember/i); return true; } });
  assert.equal(first.result, 0, first.out);
  assert.equal(prompts, 1);
  assert.equal(inspect().duplicateRuflo, false);
  assert.ok(fs.readFileSync(file, 'utf8').includes(unrelated));
  // An external upgrader restores the same recognized legacy transport.
  fs.appendFileSync(file, legacy);
  const second = await run({ confirm: async () => { throw new Error('must reuse explicit repair consent'); } });
  assert.equal(second.result, 0, second.out);
  assert.equal(inspect().duplicateRuflo, false);
  assert.equal(removals, 2);
  const third = await run();
  assert.equal(third.result, 0, third.out);
  assert.equal(removals, 2, 'already converged runs perform no removal');
});

test('declining repair leaves configuration and consent unchanged', async () => {
  seed();
  const before = snapshot(sandbox);
  const result = await run({ confirm: async () => false });
  assert.equal(result.result, 1);
  assertUnchanged(before, sandbox, 'declined repair');
  assert.equal(removals, 0);
});

test('remembered repair never consumes an alias with a custom environment', async () => {
  seed();
  assert.equal((await run({ yes: true })).result, 0);
  fs.appendFileSync(file, legacy + '[mcp_servers.claude-flow.env]\nPRIVATE_DB = "keep"\n');
  const before = fs.readFileSync(file, 'utf8');
  const result = await run();
  assert.equal(result.result, 1, result.out);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(removals, 1);
  assert.doesNotMatch(result.out, /converged —/);
});

test('sync repairs an approved alias recreated during later provisioning in the same run', async t => {
  seed();
  const step = sync.SYNC_STEPS.find(entry => entry.id === 'mcp');
  t.mock.method(step, 'when', subs => subs.has('mcp'));
  t.mock.method(step, 'run', async () => fs.writeFileSync(file, canonical + unrelated + legacy));
  let collects = 0;
  const result = await run({ yes: true, collectFn: () => {
    const observed = rows();
    return collects++ === 0 ? [...observed, { subsystem: 'mcp', level: 'warn', message: 'provisioning refresh', fix: 'refresh' }] : observed;
  } });
  assert.equal(result.result, 0, result.out);
  assert.equal(inspect().duplicateRuflo, false);
  assert.equal(removals, 1);
});

test('sync cannot report convergence when an unrepairable duplicate remains', async () => {
  seed(canonical + legacy + '[mcp_servers.claude-flow.env]\nPRIVATE_DB = "keep"\n');
  const result = await run({ yes: true });
  assert.equal(result.result, 1, result.out);
  assert.equal(removals, 0);
});

test('fresh dual-host Codex provisioning and repeated refresh retain one canonical connection', async () => {
  seed(unrelated);
  const cfg = loadKitConfig();
  let adds = 0;
  let claudeAdds = 0;
  const provisionClaude = () => register(cfg, {
    inspect: () => claudeMcpTopology({ cwd: project, home: sandbox }),
    runner: async (command, args) => {
      assert.equal(command, 'claude');
      assert.deepEqual(args, ['mcp', 'add', 'claude-flow', '-s', 'user', '--', 'ruflo', 'mcp', 'start']);
      fs.writeFileSync(paths.claudeUserMcpPath(), JSON.stringify({ mcpServers: {
        'claude-flow': { command: 'ruflo', args: ['mcp', 'start'] },
      } }));
      claudeAdds++;
      return { code: 0, stdout: '', stderr: '' };
    },
  });
  const provision = () => ensureRufloMcpInCodex(cfg, project, {
    haveFn: async () => true,
    inspect: () => {
      const entry = inspect().registrations.find(item => item.name === 'ruflo');
      return { registered: !!entry, owned: true, command: entry?.command, args: entry?.args };
    },
    runner: async (command, args) => {
      assert.equal(command, 'codex');
      assert.deepEqual(args, ['mcp', 'add', 'ruflo', '--', 'ak', 'x', 'ruflo-mcp']);
      fs.appendFileSync(file, canonical);
      adds++;
      return { code: 0, stdout: '', stderr: '' };
    },
  });
  for (let i = 0; i < 3; i++) {
    assert.equal(await provisionClaude(), true);
    assert.equal((await provision()).ok, true);
  }
  assert.equal(adds, 1);
  assert.equal(claudeAdds, 1);
  assert.deepEqual(claudeMcpTopology({ cwd: project, home: sandbox }).registrations.map(entry => entry.name), ['claude-flow']);
  assert.equal(inspect().registrations.some(entry => entry.name === 'claude-flow'), false);
  assert.equal(inspect().effectiveRufloRegistrations.length, 1);
  assert.ok(fs.readFileSync(file, 'utf8').includes(unrelated));
});

test('setup verifies and corrects an approved alias restored by project initialization', async () => {
  seed();
  const previous = process.cwd();
  process.chdir(project);
  let prompts = 0;
  try {
    const result = await captureLog(() => setup.run({
      pkgRoot, flags: { codex: true, project: true, yes: false },
      confirm: async () => { prompts++; return true; },
      inspectCodexTopology: inspect, repairCodexTopology: repair,
      machineSetup: async () => true,
      projectSetup: async () => { fs.writeFileSync(file, canonical + unrelated + legacy); return true; },
      finalizeSetup: async () => {},
    }));
    assert.equal(result.result, 0, result.out);
    assert.match(result.out, /future setup\/sync/);
    assert.equal(prompts, 1, 'setup disclosure includes the narrowly remembered repair');
    assert.equal(inspect().duplicateRuflo, false);
    assert.equal(removals, 1);
  } finally { process.chdir(previous); }
});

test('setup reports incomplete when provisioning introduces an unrecognized duplicate', async () => {
  seed(canonical);
  const previous = process.cwd();
  process.chdir(project);
  try {
    const result = await captureLog(() => setup.run({
      pkgRoot, flags: { codex: true, project: true, yes: true },
      confirm: async () => true,
      inspectCodexTopology: inspect, repairCodexTopology: repair,
      machineSetup: async () => true,
      projectSetup: async () => {
        fs.appendFileSync(file, legacy + '[mcp_servers.claude-flow.env]\nPRIVATE_DB = "keep"\n');
        return true;
      },
      finalizeSetup: async () => {},
    }));
    assert.equal(result.result, 1, result.out);
    assert.doesNotMatch(result.out, /setup complete/);
    assert.equal(removals, 0);
  } finally { process.chdir(previous); }
});

test('failed removal after provisioning does not create durable consent', async t => {
  seed();
  let provisioned = false;
  const step = sync.SYNC_STEPS.find(entry => entry.id === 'providers');
  if (step) t.mock.method(step, 'run', async () => { provisioned = true; });
  const result = await run({ yes: true, repairFn: async () => ({ ok: false, detail: 'fixture removal failed' }) });
  assert.equal(result.result, 1);
  assert.equal(loadKitConfig().integrations.ownership.codex.mcpRepairConsent, undefined);
  assert.equal(provisioned, true, 'legacy alias removal happens after provisioning');
});

test('post-provision repair preserves a lone alias when the replacement is missing', async () => {
  seed(legacy + unrelated);
  const source = fs.readFileSync(file, 'utf8');
  const result = await reconcileCodexMcp({ cfg: loadKitConfig(), cwd: project,
    yes: true, confirm: async () => true, inspect, repair });
  assert.equal(result.ok, false);
  assert.equal(removals, 0);
  assert.equal(fs.readFileSync(file, 'utf8'), source);
});

test('machine-only setup corrects a user alias when a canonical replacement already exists', async () => {
  seed();
  const result = await captureLog(() => setup.run({
    pkgRoot, flags: { codex: true, minimal: true, yes: true },
    confirm: async () => true,
    inspectCodexTopology: inspect, repairCodexTopology: repair,
    machineSetup: async () => true,
    projectSetup: async () => { throw new Error('machine-only setup must not initialize a project'); },
    finalizeSetup: async () => {},
  }));
  assert.equal(result.result, 0, result.out);
  assert.equal(inspect().duplicateRuflo, false);
  assert.equal(removals, 1);
});

test('upstream npx canonical transport participates in duplicate detection without expanding repair consent', () => {
  seed(legacy + '[mcp_servers.ruflo]\ncommand = "npx"\nargs = ["-y", "ruflo@latest", "mcp", "start"]\n');
  assert.equal(inspect().duplicateRuflo, true);
});

test('post-provision verification rejects an unrepairable recursive transport', async () => {
  seed(canonical + '[mcp_servers.codex]\ncommand = "codex"\nargs = ["mcp-server"]\nstartup_timeout_sec = 40\n');
  const result = await reconcileCodexMcp({ cfg: loadKitConfig(), cwd: project,
    yes: true, confirm: async () => true, inspect, repair });
  assert.equal(result.ok, false);
  assert.equal(removals, 0);
});

test('native repair refuses a Codex home that differs from the approved config', async () => {
  seed();
  const { codexMcpRepairPlan } = await import('../../src/lib/mcp.mjs');
  const before = snapshot(sandbox);
  const result = await repairCodexMcpTopology(codexMcpRepairPlan(inspect()), project, {
    inspect, codexHome: path.join(sandbox, 'another-profile'),
    runner: async () => { throw new Error('wrong configuration must never be mutated'); },
  });
  assert.equal(result.ok, false);
  assertUnchanged(before, sandbox, 'mismatched native Codex home');
});
