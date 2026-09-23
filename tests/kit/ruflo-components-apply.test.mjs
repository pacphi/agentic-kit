import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ensureTypesafePackage, removeTypesafePackage, ensureFunnel, releaseFunnel, reconcileRufloComponents,
  rufloProjectRoot,
} from '../../src/lib/ruflo-components/apply.mjs';

const cfg = () => ({ integrations: { ownership: {} }, rufloComponents: { typesafePicker: true, funnel: false } });
// This fs-error repro relies on a chmod'd read-only directory actually blocking mkdirSync with
// EACCES: on win32 chmod only toggles the read-only attribute and does not enforce this, and a
// root process bypasses permission bits entirely, so the assertion would never see the failure.
const POSIX_PERMS_ONLY = (process.platform === 'win32' || process.getuid?.() === 0)
  ? { skip: 'EACCES-from-chmod repro requires a non-root POSIX process' }
  : {};
function recorder(responses) {
  const calls = [];
  const runner = async (cmd, args) => { calls.push([cmd, ...args].join(' ')); return responses(cmd, args) ?? { code: 0, stdout: '', stderr: '' }; };
  return { calls, runner };
}

test('typesafe installs globally with the reviewed policy and records a receipt', async () => {
  const c = cfg();
  const { calls, runner } = recorder(() => null);
  // Stateful resolver: the pre-install check must see "not present" (null) so the
  // install path actually runs, then "now resolvable" (0.1.0) once npm has finished.
  let n = 0;
  const result = await ensureTypesafePackage(c, { runner, resolveVersion: () => (n++ ? '0.1.0' : null), rufloVersion: '3.44.0' });
  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  assert.match(calls[0], /^npm install -g .*--allow-scripts=.* @ruvector\/typesafe$/);
  assert.deepEqual(c.integrations.ownership.rufloComponents.typesafePackage,
    { owner: 'agentic-kit', package: '@ruvector/typesafe', version: '0.1.0' });
});

test('typesafe install is skipped when already resolvable and never on old ruflo', async () => {
  const { calls, runner } = recorder(() => null);
  assert.equal((await ensureTypesafePackage(cfg(), { runner, resolveVersion: () => '0.1.0', rufloVersion: '3.44.0', preinstalled: true })).changed, false);
  assert.equal((await ensureTypesafePackage(cfg(), { runner, resolveVersion: () => null, rufloVersion: '3.42.0' })).ok, true);
  assert.equal(calls.length, 0);
});

test('install that does not resolve from ruflo afterwards is blocked', async () => {
  const { runner } = recorder(() => null);
  const result = await ensureTypesafePackage(cfg(), { runner, resolveVersion: () => null, rufloVersion: '3.44.0' });
  assert.equal(result.ok, false);
  assert.match(result.detail, /does not resolve from ruflo/);
});

test('package removal requires ak\'s receipt', async () => {
  const { calls, runner } = recorder(() => null);
  assert.match((await removeTypesafePackage(cfg(), { runner })).detail, /not installed by agentic-kit/);
  assert.equal(calls.length, 0);
});

test('funnel disable is recorded and release re-enables only what ak disabled', async () => {
  const c = cfg();
  // ruflo answers `funnel status --json`; parseFunnel is JSON-first. `ruflo funnel disable`
  // records the decision as "user" regardless of who ran the command (it cannot tell ak's
  // own call apart from an interactive one) — the fixture mirrors that.
  const { calls, runner } = recorder((cmd, args) => (args[1] === 'status'
    ? {
      code: 0,
      stdout: JSON.stringify(calls.some((x) => x.endsWith('funnel disable'))
        ? { enabled: false, decidedBy: 'user' }
        : { enabled: true, decidedBy: 'package-default' }),
      stderr: '',
    }
    : null));
  assert.equal((await ensureFunnel(c, { runner })).changed, true);
  assert.equal(c.integrations.ownership.rufloComponents.funnelDisabled, true);
  await releaseFunnel(c, { runner });
  assert.ok(calls.includes('ruflo funnel enable'));
});

test('funnel already disabled by the user is not recorded as ak-owned', async () => {
  const c = cfg();
  const { calls, runner } = recorder((cmd, args) => (args[1] === 'status'
    ? { code: 0, stdout: JSON.stringify({ enabled: false, decidedBy: 'user' }), stderr: '' }
    : null));
  assert.equal((await ensureFunnel(c, { runner })).changed, false);
  assert.equal(c.integrations.ownership.rufloComponents?.funnelDisabled, undefined);
  await releaseFunnel(c, { runner });
  assert.equal(calls.includes('ruflo funnel enable'), false);
});

// --- Hermetic reconcile ---------------------------------------------------

const fx = (name) => fs.readFileSync(new URL(`../fixtures/ruflo-components/${name}`, import.meta.url), 'utf8');
const fullCfg = () => ({
  integrations: { hosts: { claude: true }, ownership: {} },
  rufloComponents: {
    typesafePicker: false, minilmPicker: true, mcpGovernance: { maxCallsPerMinute: 120 },
    learningProfile: 'balanced', turnCredit: true, memoryFix2887: true, funnel: true,
  },
});
const fakeRuflo = async (cmd, args) => {
  const a = args.join(' ');
  if (a.startsWith('doctor --component typesafe')) return { code: 0, stdout: fx('doctor-typesafe-3.43.0.txt'), stderr: '' };
  if (a.startsWith('doctor --component metaharness')) return { code: 0, stdout: fx('doctor-metaharness-3.43.0.txt'), stderr: '' };
  if (a.startsWith('hooks intelligence')) return { code: 0, stdout: fx('intelligence-stats-3.43.0.txt'), stderr: '' };
  if (a.startsWith('neural status')) return { code: 0, stdout: fx('neural-status-3.43.0.txt'), stderr: '' };
  if (a.startsWith('hooks route')) return { code: 0, stdout: 'routed embedder=minilm', stderr: '' };
  if (a.startsWith('funnel status')) return { code: 0, stdout: fx('funnel-status-3.43.0.txt'), stderr: '' };
  return { code: 0, stdout: '', stderr: '' };
};

test('reconcile: dry run writes nothing; real run writes policy and env and classifies', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-rc-reconcile-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const root = path.join(tmp, 'proj');
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  // A ruflo project also needs .claude-flow/ (controller ruling: rufloProjectRoot),
  // or the project-scope mcpGovernance policy below is correctly never reached.
  fs.mkdirSync(path.join(root, '.claude-flow'), { recursive: true });
  const opts = {
    cwd: root, runner: fakeRuflo, rufloVersion: '3.44.0',
    userSettingsFile: path.join(tmp, 'home', 'settings.json'), evidenceFile: path.join(tmp, 'state', 'evidence.json'),
  };
  const before = fs.readdirSync(root);
  const dryCfg = fullCfg();
  const dryCfgBefore = structuredClone(dryCfg);
  const dry = await reconcileRufloComponents(dryCfg, { ...opts, dryRun: true });
  assert.equal(dry.changed, true);
  assert.deepEqual(fs.readdirSync(root), before);
  assert.equal(fs.existsSync(opts.userSettingsFile), false);
  assert.equal(fs.existsSync(opts.evidenceFile), false);
  assert.deepEqual(dryCfg, dryCfgBefore);

  const cfgReal = fullCfg();
  const real = await reconcileRufloComponents(cfgReal, opts);
  assert.ok(fs.existsSync(path.join(root, '.harness', 'mcp-policy.json')));
  assert.equal(JSON.parse(fs.readFileSync(opts.userSettingsFile, 'utf8')).env.CLAUDE_FLOW_ROUTER_EMBEDDER, 'minilm');
  const byId = (id) => real.snapshot.components.find((c) => c.id === id);
  assert.equal(byId('minilmPicker').state.id, 'active');
  assert.notEqual(byId('mcpGovernance').state.id, 'blocked');
  assert.equal(byId('typesafePicker').state.id, 'user-managed');
});

test('reconcile: Codex enabled but unverifiable marks an otherwise-active minilm picker partial', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-rc-codex-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const fakeRunner = async (cmd, args) => {
    const a = args.join(' ');
    if (a.startsWith('hooks route')) return { code: 0, stdout: 'routed embedder=minilm', stderr: '' };
    if (a.startsWith('funnel status')) return { code: 0, stdout: JSON.stringify({ enabled: true, decidedBy: 'package-default' }), stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const codexCfg = {
    integrations: { hosts: { claude: true, codex: true }, ownership: {} },
    rufloComponents: {
      typesafePicker: false, minilmPicker: true, mcpGovernance: false,
      learningProfile: false, turnCredit: false, memoryFix2887: false, funnel: true,
    },
  };
  const result = await reconcileRufloComponents(codexCfg, {
    cwd: tmp, runner: fakeRunner, rufloVersion: '3.44.0',
    userSettingsFile: path.join(tmp, 'home', 'settings.json'), evidenceFile: path.join(tmp, 'state', 'evidence.json'),
  });
  const minilm = result.snapshot.components.find((c) => c.id === 'minilmPicker');
  assert.equal(minilm.state.id, 'partial');
  assert.match(minilm.state.meaning, /Codex hooks/);
});

test('reconcile: a foreign policy file (e.g. from MetaHarness or Agentic-QE) is left alone, never enforced, and reported user-managed', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-rc-foreign-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const root = path.join(tmp, 'proj');
  fs.mkdirSync(path.join(root, '.harness'), { recursive: true });
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  fs.mkdirSync(path.join(root, '.claude-flow'), { recursive: true });
  const foreign = JSON.stringify({ auditLog: true, maxToolCallsPerTurn: 8 });
  fs.writeFileSync(path.join(root, '.harness', 'mcp-policy.json'), foreign);
  const opts = {
    cwd: root, runner: fakeRuflo, rufloVersion: '3.44.0',
    userSettingsFile: path.join(tmp, 'home', 'settings.json'), evidenceFile: path.join(tmp, 'state', 'evidence.json'),
  };
  const result = await reconcileRufloComponents(fullCfg(), opts);
  assert.equal(fs.readFileSync(path.join(root, '.harness', 'mcp-policy.json'), 'utf8'), foreign);
  const local = `${path.join(root, '.claude', 'settings.local.json')}`;
  assert.equal(fs.existsSync(local), false);
  const gov = result.snapshot.components.find((c) => c.id === 'mcpGovernance');
  assert.equal(gov.state.id, 'user-managed');
  assert.match(gov.state.meaning, /This project has its own \.harness\/mcp-policy\.json, so ak leaves enforcement off\./);
});

test('reconcile: an fs error while reconciling the policy is caught and reported blocked, never thrown', POSIX_PERMS_ONLY, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-rc-policy-fs-error-'));
  t.after(() => { fs.chmodSync(path.join(tmp, 'proj'), 0o755); fs.rmSync(tmp, { recursive: true, force: true }); });
  const root = path.join(tmp, 'proj');
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  fs.mkdirSync(path.join(root, '.claude-flow'), { recursive: true });
  fs.chmodSync(root, 0o555); // read-only: reconcilePolicy's mkdirSync('.harness') throws EACCES.
  const opts = {
    cwd: root, runner: fakeRuflo, rufloVersion: '3.44.0',
    userSettingsFile: path.join(tmp, 'home', 'settings.json'), evidenceFile: path.join(tmp, 'state', 'evidence.json'),
  };
  const result = await reconcileRufloComponents(fullCfg(), opts);
  const entry = result.results.find((r) => r.id === 'mcpGovernance');
  assert.equal(entry.ok, false);
  assert.equal(entry.changed, false);
  assert.equal(typeof entry.detail, 'string');
  const gov = result.snapshot.components.find((c) => c.id === 'mcpGovernance');
  assert.equal(gov.state.id, 'blocked');
});

// --- Controller ruling: rufloProjectRoot (a ruflo project needs .claude-flow/, not
// merely an ancestor .git) --------------------------------------------------------

test('rufloProjectRoot requires BOTH a git root and .claude-flow/', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-rc-project-root-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  assert.equal(rufloProjectRoot(tmp), null, 'no .git at all is not a project');
  fs.mkdirSync(path.join(tmp, '.git'), { recursive: true });
  assert.equal(rufloProjectRoot(tmp), null, 'a git repo without .claude-flow/ is not (yet) a ruflo project');
  fs.mkdirSync(path.join(tmp, '.claude-flow'), { recursive: true });
  assert.ok(rufloProjectRoot(tmp), 'a git repo WITH .claude-flow/ is a ruflo project');
  assert.equal(path.basename(rufloProjectRoot(tmp)), path.basename(tmp));
});

test('reconcile: a git repo without .claude-flow/ used as a machine-scope cwd never receives project targets', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-rc-home-like-repo-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  // Simulates the exact hazard: `run_machine` reconciles from paths.home, which
  // could itself be (or sit under) an unrelated dotfiles git repo.
  fs.mkdirSync(path.join(tmp, '.git'), { recursive: true });
  const opts = {
    cwd: tmp, runner: fakeRuflo, rufloVersion: '3.44.0',
    userSettingsFile: path.join(tmp, 'settings.json'), evidenceFile: path.join(tmp, 'state', 'evidence.json'),
  };
  const result = await reconcileRufloComponents(fullCfg(), opts);
  assert.equal(fs.existsSync(path.join(tmp, '.harness')), false,
    'no project (no .claude-flow/) must never receive a .harness/mcp-policy.json');
  assert.equal(result.results.some((r) => r.id === 'mcpGovernance'), false,
    'mcpGovernance is not even attempted without a real project root');
});

test('reconcile: the SAME repo, once it has .claude-flow/, is a project and receives the policy', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-rc-home-becomes-project-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  fs.mkdirSync(path.join(tmp, '.git'), { recursive: true });
  fs.mkdirSync(path.join(tmp, '.claude-flow'), { recursive: true });
  const opts = {
    cwd: tmp, runner: fakeRuflo, rufloVersion: '3.44.0',
    userSettingsFile: path.join(tmp, 'settings.json'), evidenceFile: path.join(tmp, 'state', 'evidence.json'),
  };
  const result = await reconcileRufloComponents(fullCfg(), opts);
  assert.ok(fs.existsSync(path.join(tmp, '.harness', 'mcp-policy.json')));
  assert.ok(result.results.some((r) => r.id === 'mcpGovernance'));
});

test('reconcile: an explicit projectRoot: null forces machine scope only, even from inside a real ruflo project', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-rc-explicit-null-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const root = path.join(tmp, 'proj');
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  fs.mkdirSync(path.join(root, '.claude-flow'), { recursive: true });
  const opts = {
    cwd: root, projectRoot: null, runner: fakeRuflo, rufloVersion: '3.44.0',
    userSettingsFile: path.join(tmp, 'home', 'settings.json'), evidenceFile: path.join(tmp, 'state', 'evidence.json'),
  };
  const result = await reconcileRufloComponents(fullCfg(), opts);
  assert.equal(fs.existsSync(path.join(root, '.harness')), false,
    'an explicit projectRoot: null must win over what cwd would otherwise resolve to');
  assert.equal(result.results.some((r) => r.id === 'mcpGovernance'), false);
});
