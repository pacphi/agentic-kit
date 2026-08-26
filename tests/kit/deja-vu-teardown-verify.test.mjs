// deja-vu teardown and verification are deliberately narrower than the other
// deep suites: verification is content-free, and deletion is limited to one
// doctor-reported, canonical derived index path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  sandboxHome, assertSandboxed, snapshot, assertUnchanged, captureLog, rmrf,
  writeKitConfig,
} from './helpers/home-sandbox.mjs';

const HOME = sandboxHome('ak-deja-teardown-verify');
const paths = await import('../../src/lib/paths.mjs');
const uninstall = await import('../../src/commands/uninstall.mjs');
const verify = await import('../../src/commands/x/verify.mjs');
const { createDejaVuLifecycleAdapter } = await import('../../src/lib/adapters/deja-vu.mjs');
assertSandboxed(paths, HOME);

const doctor = (indexPath, extra = {}) => ({
  schema_version: 2,
  stores: [],
  index: { state: 'ok', stale_stores: 0, path: indexPath },
  mcp: [],
  sqlite3: { state: 'ok' },
  version: { state: 'offline', current: '0.19.0' },
  policy: {
    state: 'default', indexed_sessions: 0,
    activations: { search: { withheld: 0 }, mcp: { withheld: 0 }, auto: { withheld: 0 } },
  },
  sync: { state: 'ok', peers: [] },
  ...extra,
});

const cfg = ({ enabled = true, ownership } = {}) => ({
  aqe: false,
  ruvnetBrain: false,
  integrations: {
    version: 3,
    hosts: { claude: false, codex: false, opencode: false },
    bindings: [],
    tools: { dejaVu: { enabled, mode: 'mcp', hosts: ['claude'], indexOnSetup: true } },
    ...(ownership ? { ownership: { dejaVu: ownership } } : {}),
  },
  routing: { version: 1, primaryHost: 'claude', routes: {} },
  providers: {},
});

function lifecycleAdapter({ facts, undo } = {}) {
  const calls = [];
  const adapter = {
    id: 'deja-vu',
    async detect(request) { calls.push(['detect', request]); return facts ?? {}; },
    async plan() { return { changed: false, operations: [] }; },
    async apply() { return { ok: true, changed: false }; },
    async verify(request) {
      calls.push(['verify', request]);
      return { ok: true, changed: false, facts: facts ?? {}, errors: [] };
    },
    async undo(request) {
      calls.push(['undo', request]);
      return undo ? undo(request) : { ok: true, changed: false, configChanged: false, errors: [] };
    },
  };
  return { adapter, calls };
}

test('help exposes explicit deja-vu teardown scopes and the content-free verify suite', () => {
  assert.match(uninstall.help, /--remove-deja-vu\s+uninstall the Kit-owned deja-vu package/);
  assert.match(uninstall.help, /--purge-deja-vu-data\s+delete only the derived deja-vu index/);
  assert.match(verify.help, /deja-vu\s+content-free structural proof/);
});

test('deja-vu verify cleanly skips disabled, unowned integration without probing it', async () => {
  const { adapter, calls } = lifecycleAdapter();
  const { result, out } = await captureLog(() => verify.verifyDejaVu({
    cfg: cfg({ enabled: false }), adapter,
  }));
  assert.equal(result, true);
  assert.deepEqual(calls, []);
  assert.match(out, /disabled and unowned — skipped/);
});

test('deja-vu verify emits only bounded structural facts and never raw upstream content', async () => {
  const sentinel = 'SECRET transcript /Users/alice/.claude/projects/acme/session.jsonl';
  const facts = {
    desired: { enabled: true, mode: 'auto', hosts: ['claude'] },
    install: { binaryPresent: true, version: '0.19.0', supported: true, ownership: 'agentic-kit' },
    doctor: { state: 'ok', reason: sentinel, schemaVersion: 2 },
    index: { state: 'ok', staleStores: 0, raw: sentinel },
    targets: {
      claude: { selected: true, satisfied: true, desiredTarget: 'claude-auto', raw: sentinel },
      codex: { selected: false, satisfied: false },
      opencode: { selected: false, satisfied: false },
    },
  };
  const { adapter, calls } = lifecycleAdapter({ facts });
  const { result, out } = await captureLog(() => verify.verifyDejaVu({ cfg: cfg(), adapter }));
  assert.equal(result, true);
  assert.deepEqual(calls.map(([name]) => name), ['detect', 'verify']);
  assert.match(out, /doctor schema v2 and bounded component health: ok/);
  assert.match(out, /index state: ok/);
  assert.match(out, /claude-auto: wired/);
  assert.doesNotMatch(out, /SECRET|\/Users\/alice|session\.jsonl/);
  assert.doesNotMatch(out, /search|recall|query|notes/i,
    'the structural proof must not claim or invite content retrieval');
});

test('deja-vu verify fails recognized unhealthy doctor components despite exit-zero schema', async () => {
  const facts = {
    desired: { enabled: true, mode: 'mcp', hosts: ['claude'], indexOnSetup: true },
    install: { binaryPresent: true, version: '0.19.0', supported: true, ownership: 'external' },
    doctor: {
      state: 'ok', reason: null, schemaVersion: 2,
      health: { state: 'degraded', storeIssues: 1, sqlite: 'missing', policy: 'unreadable', sync: 'ok' },
    },
    index: { state: 'ok', staleStores: 0 },
    targets: { claude: { selected: true, satisfied: true, desiredTarget: 'claude-code' } },
  };
  const { adapter } = lifecycleAdapter({ facts });
  adapter.verify = async () => ({
    ok: false, changed: false, facts, errors: ['deja-doctor-components-degraded'],
  });
  const { result, out } = await captureLog(() => verify.verifyDejaVu({ cfg: cfg(), adapter }));
  assert.equal(result, false);
  assert.match(out, /bounded component health is degraded/);
  assert.doesNotMatch(out, /sqlite|policy|private|path/);
});

test('deja-vu verify fails closed on incompatible schema or unhealthy index without leaking errors', async () => {
  const sentinel = '/private/transcripts/secret.jsonl';
  const facts = {
    desired: { enabled: true, mode: 'mcp', hosts: ['claude'] },
    install: { binaryPresent: true, version: '0.19.0', supported: true, ownership: 'external' },
    doctor: { state: 'degraded', reason: sentinel, schemaVersion: 3 },
    index: { state: 'stale-readonly', staleStores: 1 },
    targets: { claude: { selected: true, satisfied: true, desiredTarget: 'claude-code' } },
  };
  const { adapter } = lifecycleAdapter({ facts });
  adapter.verify = async () => ({ ok: false, changed: false, facts, errors: [sentinel] });
  const { result, out } = await captureLog(() => verify.verifyDejaVu({ cfg: cfg(), adapter }));
  assert.equal(result, false);
  assert.match(out, /doctor schema incompatible or unavailable/);
  assert.match(out, /index state: stale-readonly/);
  assert.doesNotMatch(out, /private|transcripts|secret\.jsonl/);
});

test('disabled but owned deja-vu reports a missing index structurally without requiring it', async () => {
  const facts = {
    desired: { enabled: false, mode: 'mcp', hosts: [], indexOnSetup: true },
    install: { binaryPresent: true, version: 'v0.19.0', supported: true, ownership: 'agentic-kit' },
    doctor: { state: 'ok', reason: null, schemaVersion: 2 },
    index: { state: 'missing', staleStores: 0 },
    targets: {},
  };
  const { adapter } = lifecycleAdapter({ facts });
  const owned = { install: { owner: 'agentic-kit' }, targets: {} };
  const { result, out } = await captureLog(() => verify.verifyDejaVu({
    cfg: cfg({ enabled: false, ownership: owned }), adapter,
  }));
  assert.equal(result, true);
  assert.match(out, /CLI\/package v0\.19\.0/);
  assert.doesNotMatch(out, /vv0\.19\.0/);
  assert.match(out, /index state: missing/);
});

test('derived-index purge runs only doctor --json --offline and preserves every source/config surface', async () => {
  const index = path.join(HOME, '.cache', 'deja', 'index.db');
  const protectedFiles = [
    path.join(HOME, '.config', 'deja', 'policy.json'),
    path.join(HOME, '.config', 'deja', 'peers.json'),
    path.join(HOME, '.claude', 'projects', 'session.jsonl'),
    path.join(HOME, '.codex', 'sessions', 'session.jsonl'),
  ];
  fs.mkdirSync(index, { recursive: true });
  fs.writeFileSync(path.join(index, 'derived.sqlite'), 'derived');
  const adjacentSidecars = [
    path.join(path.dirname(index), '.usage.jsonl'),
    path.join(path.dirname(index), '.injection.jsonl'),
  ];
  for (const file of adjacentSidecars) fs.writeFileSync(file, 'PRIVATE-SIDECAR');
  for (const file of protectedFiles) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'PRIVATE-SENTINEL');
  }
  const calls = [];
  const runner = async (command, args) => {
    calls.push([command, ...args]);
    return { code: 0, stdout: JSON.stringify(doctor(index, { private: 'PRIVATE-SENTINEL' })), stderr: '' };
  };
  const result = await uninstall.purgeDejaVuIndex({ runner, homeDir: HOME });
  assert.deepEqual(calls, [['deja', 'doctor', '--json', '--offline']]);
  assert.deepEqual(result, { ok: true, changed: true, reason: null });
  assert.ok(!fs.existsSync(index), 'only the derived index is deleted');
  for (const file of protectedFiles) assert.equal(fs.readFileSync(file, 'utf8'), 'PRIVATE-SENTINEL');
  for (const file of adjacentSidecars) assert.equal(fs.readFileSync(file, 'utf8'), 'PRIVATE-SIDECAR');
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|session|policy|peers|index\.db/);
});

test('derived-index purge rejects outside paths and symlink escapes without exposing either path', async () => {
  const outside = path.join(HOME, 'outside', 'index.db');
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'keep'), 'outside');
  let result = await uninstall.purgeDejaVuIndex({
    runner: async () => ({ code: 0, stdout: JSON.stringify(doctor(outside)), stderr: '' }),
    homeDir: HOME,
  });
  assert.equal(result.ok, false);
  assert.ok(fs.existsSync(path.join(outside, 'keep')));
  assert.ok(!JSON.stringify(result).includes(outside), 'the rejected candidate is not returned');
  assert.doesNotMatch(JSON.stringify(result), /index\.db/);

  const target = path.join(HOME, '.claude', 'projects', 'index.db');
  const link = path.join(HOME, '.cache', 'deja', 'index.db');
  fs.mkdirSync(target, { recursive: true });
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.writeFileSync(path.join(target, 'keep'), 'source transcript');
  fs.symlinkSync(target, link, 'dir');
  result = await uninstall.purgeDejaVuIndex({
    runner: async () => ({ code: 0, stdout: JSON.stringify(doctor(link)), stderr: '' }),
    homeDir: HOME,
  });
  assert.equal(result.ok, false);
  assert.ok(fs.existsSync(path.join(target, 'keep')), 'symlink target must survive');
  assert.ok(fs.lstatSync(link).isSymbolicLink(), 'rejected symlink itself survives');
  assert.doesNotMatch(JSON.stringify(result), /\.claude|projects|index\.db/);
  fs.unlinkSync(link);
  rmrf(target);
});

test('derived-index purge dry-run validates but changes nothing', async () => {
  const index = path.join(HOME, '.cache', 'deja', 'index.db');
  fs.mkdirSync(index, { recursive: true });
  fs.writeFileSync(path.join(index, 'keep'), 'derived');
  const before = snapshot(HOME);
  const result = await uninstall.purgeDejaVuIndex({
    runner: async () => ({ code: 0, stdout: JSON.stringify(doctor(index)), stderr: '' }),
    homeDir: HOME, dryRun: true,
  });
  assert.deepEqual(result, { ok: true, changed: false, reason: 'dry-run' });
  assertUnchanged(before, HOME, 'deja-vu data purge dry-run');
  rmrf(index);
});

test('derived-index purge accepts only the exact v0.19 DEJA_INDEX_DIR override', async () => {
  const parent = path.join(HOME, 'private-indexes');
  const index = path.join(parent, 'custom-name');
  const sibling = path.join(parent, 'keep-me');
  fs.mkdirSync(index, { recursive: true });
  fs.mkdirSync(sibling, { recursive: true });
  fs.writeFileSync(path.join(index, 'derived.sqlite'), 'derived');
  fs.writeFileSync(path.join(sibling, 'user.txt'), 'preserved');
  const result = await uninstall.purgeDejaVuIndex({
    homeDir: HOME,
    env: { DEJA_INDEX_DIR: index },
    runner: async () => ({ code: 0, stdout: JSON.stringify(doctor(index)), stderr: '' }),
  });
  assert.deepEqual(result, { ok: true, changed: true, reason: null });
  assert.equal(fs.existsSync(index), false);
  assert.equal(fs.readFileSync(path.join(sibling, 'user.txt'), 'utf8'), 'preserved');
});

test('derived-index purge refuses a regular file even when it is named index.db', async () => {
  const index = path.join(HOME, '.cache', 'deja', 'index.db');
  fs.mkdirSync(path.dirname(index), { recursive: true });
  fs.writeFileSync(index, 'not an index directory');
  const result = await uninstall.purgeDejaVuIndex({
    runner: async () => ({ code: 0, stdout: JSON.stringify(doctor(index)), stderr: '' }),
    homeDir: HOME,
  });
  assert.deepEqual(result, { ok: false, changed: false, reason: 'path-not-directory' });
  assert.equal(fs.readFileSync(index, 'utf8'), 'not an index directory');
  fs.rmSync(index);
});

test('default uninstall consumes only Kit-owned target receipts and preserves package/data', async () => {
  const ownership = {
    install: { owner: 'agentic-kit', method: 'npm', package: '@vshulcz/deja-vu', written: { version: '0.19.0' } },
    targets: { claude: { owner: 'agentic-kit', host: 'claude', mode: 'mcp' } },
  };
  writeKitConfig(HOME, cfg({ ownership }));
  const index = path.join(HOME, '.cache', 'deja', 'index.db');
  fs.mkdirSync(index, { recursive: true });
  const { adapter, calls } = lifecycleAdapter({
    undo: ({ cfg: current, options }) => {
      assert.equal(options.removePackage, false);
      delete current.integrations.ownership.dejaVu.targets;
      return { ok: true, changed: true, configChanged: true, actions: [{ id: 'target-remove-claude' }], errors: [] };
    },
  });
  let purges = 0;
  const { result } = await captureLog(() => uninstall.run({
    flags: { yes: true }, deps: { dejaAdapter: adapter, purgeDejaVuIndex: async () => { purges++; } },
  }));
  assert.equal(result, 0);
  assert.deepEqual(calls.map(([name]) => name), ['detect', 'undo']);
  assert.equal(purges, 0);
  assert.ok(fs.existsSync(index), 'general uninstall preserves derived data');
  const saved = JSON.parse(fs.readFileSync(paths.kitConfigPath(), 'utf8'));
  assert.ok(saved.integrations.ownership.dejaVu.install, 'package ownership receipt remains');
  assert.equal(saved.integrations.ownership.dejaVu.targets, undefined, 'successfully removed target receipt is consumed');
});

test('uninstall preserves an externally-owned deja-vu installation and never invokes lifecycle undo', async () => {
  writeKitConfig(HOME, cfg({ enabled: true }));
  const { adapter, calls } = lifecycleAdapter();
  const { result, out } = await captureLog(() => uninstall.run({
    flags: { yes: true, 'remove-deja-vu': true }, deps: { dejaAdapter: adapter },
  }));
  assert.equal(result, 0);
  assert.deepEqual(calls, []);
  assert.match(out, /deja-vu package preserved — no Kit ownership receipt/);
});

test('plain --purge never implies deja-vu package or data removal', async () => {
  const ownership = {
    install: { owner: 'agentic-kit', method: 'npm', package: '@vshulcz/deja-vu', written: { version: '0.19.0' } },
    targets: {},
  };
  writeKitConfig(HOME, cfg({ ownership }));
  const { adapter, calls } = lifecycleAdapter({
    undo: ({ options }) => {
      assert.equal(options.removePackage, false);
      return { ok: true, changed: false, configChanged: false, errors: [] };
    },
  });
  let purges = 0;
  const { result } = await captureLog(() => uninstall.run({
    flags: { yes: true, purge: true },
    deps: { dejaAdapter: adapter, purgeDejaVuIndex: async () => { purges++; return { ok: true }; } },
  }));
  assert.equal(result, 0);
  assert.equal(calls.find(([name]) => name === 'undo')[1].options.removePackage, false);
  assert.equal(purges, 0);
  assert.ok(!fs.existsSync(paths.kitConfigPath()), 'ordinary Kit purge still removes Kit configuration');
});

test('partial target teardown retains updated receipts and blocks package, data, and kit.json purge', async () => {
  const ownership = {
    install: { owner: 'agentic-kit', method: 'npm', package: '@vshulcz/deja-vu', written: { version: '0.19.0' } },
    targets: {
      claude: { owner: 'agentic-kit', host: 'claude', mode: 'mcp' },
      codex: { owner: 'agentic-kit', host: 'codex', mode: 'auto' },
    },
  };
  writeKitConfig(HOME, cfg({ ownership }));
  const { adapter } = lifecycleAdapter({
    undo: ({ cfg: current, options }) => {
      assert.equal(options.removePackage, false);
      delete current.integrations.ownership.dejaVu.targets.claude;
      return { ok: false, changed: true, configChanged: true, errors: ['codex-target-remove-failed'] };
    },
  });
  let purges = 0;
  const { result, out } = await captureLog(() => uninstall.run({
    flags: { yes: true, purge: true, 'remove-deja-vu': true, 'purge-deja-vu-data': true },
    deps: { dejaAdapter: adapter, purgeDejaVuIndex: async () => { purges++; return { ok: true }; } },
  }));
  assert.equal(result, 1);
  assert.equal(purges, 0, 'data purge is blocked after incomplete ownership teardown');
  assert.ok(fs.existsSync(paths.kitConfigPath()), 'recovery receipts survive general purge');
  const saved = JSON.parse(fs.readFileSync(paths.kitConfigPath(), 'utf8'));
  assert.equal(saved.integrations.ownership.dejaVu.targets.claude, undefined);
  assert.ok(saved.integrations.ownership.dejaVu.targets.codex);
  assert.ok(saved.integrations.ownership.dejaVu.install);
  assert.doesNotMatch(out, /codex-target-remove-failed/, 'raw lifecycle errors are not rendered');
});

test('a failed data purge retains the owned package so doctor remains available for retry', async () => {
  const ownership = {
    install: { owner: 'agentic-kit', method: 'npm', package: '@vshulcz/deja-vu', written: { version: '0.19.0' } },
    targets: {},
  };
  writeKitConfig(HOME, cfg({ ownership }));
  const { adapter, calls } = lifecycleAdapter({
    undo: () => ({ ok: true, changed: false, configChanged: false, errors: [] }),
  });
  const { result, out } = await captureLog(() => uninstall.run({
    flags: { yes: true, 'remove-deja-vu': true, 'purge-deja-vu-data': true },
    deps: {
      dejaAdapter: adapter,
      purgeDejaVuIndex: async () => ({ ok: false, changed: false, reason: 'path-symlink' }),
    },
  }));
  assert.equal(result, 1);
  assert.deepEqual(calls.filter(([name]) => name === 'undo').map(([, request]) => request.options.removePackage),
    [false], 'package-removal phase must not run after data validation failure');
  const saved = JSON.parse(fs.readFileSync(paths.kitConfigPath(), 'utf8'));
  assert.ok(saved.integrations.ownership.dejaVu.install);
  assert.match(out, /package retained because target\/data teardown is incomplete/);
});

test('combined removal orders real lifecycle target undo, one purge doctor, then npm uninstall', async () => {
  const index = path.join(HOME, '.cache', 'deja', 'index.db');
  fs.mkdirSync(index, { recursive: true });
  fs.writeFileSync(path.join(index, 'derived.sqlite'), 'derived');
  const signature = createHash('sha256')
    .update(JSON.stringify({
      mcp: true, auto: false,
      mcpProjection: 'a'.repeat(64), autoProjection: null,
    })).digest('hex');
  const ownership = {
    install: {
      owner: 'agentic-kit', method: 'npm', package: '@vshulcz/deja-vu',
      prior: null, written: { version: '0.19.0' },
    },
    targets: {
      claude: {
        owner: 'agentic-kit', host: 'claude', target: 'claude-code', mode: 'mcp',
        prior: { state: 'absent' },
        written: {
          state: 'wired', mode: 'mcp', mechanism: 'direct-cli',
          precision: 'projection-sha256-v1', signature,
        },
      },
    },
  };
  writeKitConfig(HOME, cfg({ ownership }));
  const timeline = [];
  const state = { binary: true, npmVersion: '0.19.0', target: true };
  const doctorResult = () => ({ code: 0, stdout: JSON.stringify(doctor(index)), stderr: '' });
  const runner = async (command, args) => {
    if (command === 'deja' && args[0] === 'doctor') {
      timeline.push('lifecycle-doctor');
      return doctorResult();
    }
    if (command === 'deja' && args[0] === 'uninstall') {
      assert.deepEqual(args, ['uninstall', 'claude-code', '--no-guidance', '--no-index']);
      timeline.push('target-uninstall');
      state.target = false;
      return { code: 0, stdout: '', stderr: '' };
    }
    if (command === 'npm' && args[0] === 'uninstall') {
      timeline.push('package-uninstall');
      state.binary = false;
      state.npmVersion = null;
      return { code: 0, stdout: '', stderr: '' };
    }
    return { code: 1, stdout: '', stderr: '' };
  };
  const adapter = createDejaVuLifecycleAdapter({
    runner,
    haveFn: async (bin) => bin === 'deja' ? state.binary : bin === 'claude',
    packageVersionFn: async () => state.npmVersion,
    targetObserver: async () => ({
      claude: { direct: { mcp: state.target, auto: false }, projection: { mcp: state.target ? 'a'.repeat(64) : null, auto: null }, plugin: { present: false, auto: false } },
      codex: { direct: { mcp: false, auto: false }, projection: { mcp: null, auto: null }, plugin: { present: false, auto: false } },
      opencode: { direct: { mcp: false, auto: false }, projection: { mcp: null, auto: null }, plugin: { present: false, auto: false } },
    }),
  });
  const purge = (options) => uninstall.purgeDejaVuIndex({
    ...options,
    runner: async (command, args) => {
      timeline.push('purge-doctor');
      assert.deepEqual([command, ...args], ['deja', 'doctor', '--json', '--offline']);
      return doctorResult();
    },
  });
  const { result } = await captureLog(() => uninstall.run({
    flags: { yes: true, 'remove-deja-vu': true, 'purge-deja-vu-data': true },
    deps: { dejaAdapter: adapter, purgeDejaVuIndex: purge },
  }));
  assert.equal(result, 0);
  assert.equal(timeline.filter((event) => event === 'purge-doctor').length, 1);
  assert.ok(timeline.indexOf('target-uninstall') < timeline.indexOf('purge-doctor'));
  assert.ok(timeline.indexOf('purge-doctor') < timeline.indexOf('package-uninstall'));
  assert.ok(!fs.existsSync(index));
});

test('deja-vu uninstall dry-run invokes neither lifecycle nor data purge and changes nothing', async () => {
  const ownership = {
    install: { owner: 'agentic-kit', method: 'npm', package: '@vshulcz/deja-vu', written: { version: '0.19.0' } },
    targets: { claude: { owner: 'agentic-kit', host: 'claude', mode: 'mcp' } },
  };
  writeKitConfig(HOME, cfg({ ownership }));
  const before = snapshot(HOME);
  const { adapter, calls } = lifecycleAdapter();
  let purges = 0;
  const { result, out } = await captureLog(() => uninstall.run({
    flags: { yes: true, 'dry-run': true, 'remove-deja-vu': true, 'purge-deja-vu-data': true },
    deps: {
      dejaAdapter: adapter,
      purgeDejaVuIndex: async ({ dryRun }) => {
        purges++;
        assert.equal(dryRun, true);
        return { ok: true, changed: false, reason: 'dry-run' };
      },
    },
  }));
  assert.equal(result, 0);
  assert.deepEqual(calls, []);
  assert.equal(purges, 1);
  assert.match(out, /\[dry-run\] remove Kit-owned deja-vu target wiring/);
  assert.match(out, /\[dry-run\] uninstall Kit-owned deja-vu package/);
  assert.match(out, /\[dry-run\] validated deja-vu derived index; would delete it \(path withheld\)/);
  assertUnchanged(before, HOME, 'deja-vu uninstall dry-run');
});

test.after(() => rmrf(HOME));
