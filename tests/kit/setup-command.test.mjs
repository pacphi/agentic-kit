// `ak setup` — the most machine-mutating command in the kit (global npm
// installs, ~/.claude/CLAUDE.md rewrites, MCP registration, project init).
// Only the --dry-run surface is exercisable in a test: a real run installs
// packages and spawns ruflo/claude/aqe. That is exactly the surface worth
// pinning, because "--dry-run: print the plan; change nothing" is a promise
// users rely on before letting this loose on their machine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  sandboxHome, assertSandboxed, snapshot, assertUnchanged, captureLog, rmrf,
  sandboxProject, writeKitConfig, offlineKitConfig, fakeGlobalRoot,
} from './helpers/home-sandbox.mjs';
import { HOST_REGISTRY } from '../../src/lib/adapters/registries.mjs';

const HOME = sandboxHome('ak-setup');
const paths = await import('../../src/lib/paths.mjs');
const setup = await import('../../src/commands/setup.mjs');
const { loadKitConfig } = await import('../../src/lib/config.mjs');
assertSandboxed(paths, HOME);

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FLAGS = (over = {}) => ({
  'dry-run': false, yes: false, minimal: false, project: false,
  'no-aqe': false, 'no-ruvnet-brain': false, 'no-security': false,
  codex: false, opencode: false, reconfigure: false,
  'with-deja-vu': false, 'deja-vu-mode': undefined, 'no-deja-vu': false, ...over,
});

const dejaVuPlan = ({ mode = 'mcp', hosts = ['claude'] } = {}) => ({
  changed: true,
  warnings: [],
  operations: [
    {
      id: 'package-install', kind: 'package-install', command: 'npm', version: '0.19.0',
      args: ['install', '-g', '@vshulcz/deja-vu@0.19.0', '--no-audit', '--no-fund'],
    },
    ...hosts.map((host) => ({
      id: `target-install-${host}`, kind: 'target-install', command: 'deja', host, mode,
      args: ['install', ({ claude: { mcp: 'claude-code', auto: 'claude-auto' }, codex: { mcp: 'codex', auto: 'codex-auto' }, opencode: { mcp: 'opencode', auto: 'opencode-auto' } })[host][mode], '--no-guidance', '--no-index'],
    })),
    { id: 'index', kind: 'index', command: 'deja', args: ['index'] },
  ],
});

function fakeDejaVu(events = [], { mode = 'mcp', hosts = ['claude'], applyResult } = {}) {
  const facts = {
    desired: { enabled: true, mode, hosts, indexOnSetup: true },
    install: { version: null },
  };
  const plan = dejaVuPlan({ mode, hosts });
  return {
    id: 'deja-vu',
    async detect() { events.push('detect'); return facts; },
    async plan() { events.push('plan'); return plan; },
    async apply({ cfg }) {
      events.push('apply');
      cfg.integrations.ownership ??= {};
      cfg.integrations.ownership.dejaVu = { install: { owner: 'agentic-kit', written: { version: '0.19.0' } } };
      return applyResult ?? { ok: true, actions: plan.operations, warnings: [], errors: [] };
    },
  };
}

function seedHome(cfg = offlineKitConfig()) {
  rmrf(paths.claudeDir(), paths.configDir(), path.join(HOME, '.config', 'opencode'));
  fs.mkdirSync(paths.claudeDir(), { recursive: true });
  fs.writeFileSync(paths.claudeMdPath(), '# my machine notes\n');
  writeKitConfig(HOME, cfg);
}

test('run_machine --dry-run announces the plan and writes nothing', async () => {
  seedHome();
  const before = snapshot(HOME);
  const { result, out } = await captureLog(() =>
    setup.run_machine({ flags: FLAGS({ 'dry-run': true }), pkgRoot: PKG_ROOT, cfg: loadKitConfig() }));
  assert.equal(result, true, 'dry-run machine setup reports success');
  assert.match(out, /dry-run: would ensure packages/);
  assertUnchanged(before, HOME, 'run_machine --dry-run must not touch the filesystem');
});

test('run_project --dry-run announces the plan and touches neither home nor project', async () => {
  seedHome();
  const project = sandboxProject('ak-setup');
  const beforeHome = snapshot(HOME);
  const beforeProject = snapshot(project);
  const cwd = process.cwd();
  process.chdir(project);
  try {
    const { result, out } = await captureLog(() =>
      setup.run_project({ flags: FLAGS({ 'dry-run': true }), cfg: loadKitConfig() }));
    assert.equal(result, true);
    assert.match(out, /dry-run: would init, sanitize, pin DB path/);
    for (const entry of setup.PROJECT_PERMISSION_MANIFEST) assert.ok(out.includes(entry.rule));
  } finally { process.chdir(cwd); }
  assertUnchanged(beforeHome, HOME, 'run_project --dry-run must not touch HOME');
  assertUnchanged(beforeProject, project, 'run_project --dry-run must not touch the project');
  rmrf(project);
});

test('project init delegates without overlapping machine guidance, Codex, or skill registration', () => {
  assert.deepEqual(setup.RUFLO_PROJECT_INIT_ARGS, [
    'init', '--full', '--force', '--no-global', '--no-codex-detect', '--no-skills-sh',
    '--format', 'json',
  ]);
  assert.deepEqual(setup.RUFLO_PROJECT_INIT_ENV, { RUFLO_NO_SKILLS_SH: '1' });
});

test('project permission manifest omits AQE grants when AQE is disabled', () => {
  assert.equal(setup.projectPermissionManifest({ aqe: true }).length, 7);
  assert.deepEqual(setup.projectPermissionManifest({ aqe: false }).map((entry) => entry.owner),
    ['ruflo', 'ruflo', 'ruflo', 'ruflo']);
});

// F-04: the authorized/disclosed set is the UNION across every enabled
// host's trust manifest, not claude's alone — otherwise a second host's own
// project-scope auto-approve rule reads as "undisclosed" and
// removeUndisclosedPermissions would strip it (and fail setup). Driven
// through the same synthetic-host `hosts` seam trust-manifest.test.mjs uses
// for host-registry-construction tests, so no change to registries.mjs is
// needed to prove it.
test('projectPermissionManifest unions a second enabled host\'s auto-approve rules', () => {
  const future = {
    id: 'grok', label: 'Grok CLI',
    trust: {
      approvalPolicy: 'managed',
      changes: [{
        id: 'grok-auto-approve', kind: 'auto-approve', scope: 'project',
        owner: 'agentic-kit', value: 'Bash(grok *)', effect: 'allow the Grok CLI',
        operations: ['setup'], features: ['project'],
      }],
    },
  };
  const cfg = { aqe: true, ruvnetBrain: true, integrations: { hosts: { claude: true, grok: true } } };
  const manifest = setup.projectPermissionManifest(cfg, { hosts: [...HOST_REGISTRY, future] });
  const rules = manifest.map((entry) => entry.rule);
  assert.ok(rules.includes('Bash(grok *)'), 'the second host\'s auto-approve rule must be disclosed, not dropped');
  assert.ok(rules.includes('mcp__claude-flow__*'), 'claude\'s own rules must still be present alongside it (a union, not a swap)');

  // and the union must survive removeUndisclosedPermissions as authorized —
  // a second host's disclosed rule must never be stripped as an intruder.
  const project = sandboxProject('ak-setup-second-host-permission');
  const file = path.join(project, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ permissions: { allow: ['Bash(grok *)'] } }, null, 2));
  const removed = setup.removeUndisclosedPermissions(file, new Set(), new Set(rules));
  assert.deepEqual(removed, [], 'a disclosed second-host rule must never be stripped as undisclosed');
  rmrf(project);
});

test('projectPermissionManifest at only claude enabled is unchanged from the pre-F-04 claude-only manifest', () => {
  // byte-identical for the default (claude-only) machine: the union with an
  // empty "other hosts" set is exactly what trustChangesForHost('claude',
  // {kind:'auto-approve'}) produced before this rework.
  assert.deepEqual(setup.projectPermissionManifest({ aqe: true }), setup.PROJECT_PERMISSION_MANIFEST);
});

test('permission verification removes only newly introduced undisclosed grants', () => {
  const project = sandboxProject('ak-setup-permissions');
  const file = path.join(project, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ permissions: { allow: [
    'Bash(user-owned:*)', 'mcp__claude-flow__*', 'Bash(unexpected:*)',
  ] } }, null, 2));
  const removed = setup.removeUndisclosedPermissions(
    file, new Set(['Bash(user-owned:*)']), new Set(['mcp__claude-flow__*']),
  );
  assert.deepEqual(removed, ['Bash(unexpected:*)']);
  const allow = JSON.parse(fs.readFileSync(file, 'utf8')).permissions.allow;
  assert.deepEqual(allow, ['Bash(user-owned:*)', 'mcp__claude-flow__*']);
  rmrf(project);
});

test('declining the permission preflight stops before machine or project mutation', async () => {
  seedHome();
  const project = sandboxProject('ak-setup-decline');
  const beforeHome = snapshot(HOME);
  const beforeProject = snapshot(project);
  const cwd = process.cwd();
  process.chdir(project);
  try {
    const { result, out } = await captureLog(() => setup.run({
      flags: FLAGS(), pkgRoot: PKG_ROOT, confirm: async () => false,
    }));
    assert.equal(result, 0);
    assert.match(out, /setup cancelled before machine, user, or project changes/);
  } finally { process.chdir(cwd); }
  assertUnchanged(beforeHome, HOME, 'declined permission preflight must not touch HOME');
  assertUnchanged(beforeProject, project, 'declined permission preflight must not touch the project');
  rmrf(project);
});

// Regression: `run()` saved kit.json unconditionally after run_machine, so
// `ak setup --dry-run` CREATED ~/.config/agentic-kit/kit.json on a machine that
// had never been set up — a filesystem change from a command that promises none.
test('ak setup --dry-run does not create kit.json on a fresh machine', async () => {
  rmrf(paths.claudeDir(), paths.configDir());
  const before = snapshot(HOME);
  const { result } = await captureLog(() =>
    setup.run({ flags: FLAGS({ 'dry-run': true, minimal: true }), pkgRoot: PKG_ROOT }));
  assert.equal(result, 0);
  assert.equal(fs.existsSync(paths.kitConfigPath()), false,
    '--dry-run must not create kit.json');
  assertUnchanged(before, HOME, '`ak setup --dry-run --minimal` must not touch the filesystem');
});

test('ak setup --dry-run does not rewrite an EXISTING kit.json', async () => {
  seedHome(offlineKitConfig({ aqe: false, mcp: { register: false, excludeFamilies: ['wasm'] } }));
  const before = fs.readFileSync(paths.kitConfigPath(), 'utf8');
  await captureLog(() => setup.run({ flags: FLAGS({ 'dry-run': true, minimal: true }), pkgRoot: PKG_ROOT }));
  assert.equal(fs.readFileSync(paths.kitConfigPath(), 'utf8'), before,
    'a previewed setup must leave the user\'s saved preferences byte-identical');
});

test('deja-vu flags validate before config mutation or companion probing', async () => {
  seedHome();
  const before = snapshot(HOME);
  const events = [];
  const adapter = fakeDejaVu(events);
  for (const flags of [
    FLAGS({ 'with-deja-vu': true, 'no-deja-vu': true, minimal: true }),
    FLAGS({ 'with-deja-vu': true, 'deja-vu-mode': 'ambient', minimal: true }),
    FLAGS({ 'deja-vu-mode': 'auto', minimal: true }),
  ]) {
    const { result } = await captureLog(() => setup.run({ flags, pkgRoot: PKG_ROOT, dejaVuLifecycle: adapter }));
    assert.equal(result, 2);
  }
  assert.deepEqual(events, []);
  assertUnchanged(before, HOME, 'invalid deja-vu flags must precede every mutation and probe');
});

test('default and --no-deja-vu setup perform zero companion probes', async () => {
  for (const extra of [{}, { 'no-deja-vu': true }]) {
    seedHome();
    const events = [];
    const { result } = await captureLog(() => setup.run({
      flags: FLAGS({ 'dry-run': true, minimal: true, ...extra }), pkgRoot: PKG_ROOT,
      dejaVuLifecycle: fakeDejaVu(events),
    }));
    assert.equal(result, 0);
    assert.deepEqual(events, []);
  }
});

test('deja-vu opt-in snapshots only explicitly enabled Kit hosts after host flags', () => {
  seedHome();
  const cfg = loadKitConfig();
  cfg.integrations.hosts = { claude: true, codex: true, opencode: false };
  const changed = setup.applySetupDejaVuFlags(cfg, FLAGS({
    'with-deja-vu': true, 'deja-vu-mode': 'auto',
  }));
  assert.equal(changed.changed, true);
  assert.deepEqual(cfg.integrations.tools.dejaVu, {
    enabled: true, mode: 'auto', hosts: ['claude', 'codex'], indexOnSetup: true,
  });
});

test('deja-vu trust is disclosed after bounded detection/plan and before any mutation', async () => {
  seedHome();
  const before = snapshot(HOME);
  const events = [];
  const adapter = fakeDejaVu(events, { mode: 'auto' });
  const { result, out } = await captureLog(() => setup.run({
    flags: FLAGS({ minimal: true, 'with-deja-vu': true, 'deja-vu-mode': 'auto' }),
    pkgRoot: PKG_ROOT,
    dejaVuLifecycle: adapter,
    confirm: async () => {
      events.push('confirm');
      assertUnchanged(before, HOME, 'trust confirmation must precede every setup mutation');
      return false;
    },
  }));
  assert.equal(result, 0);
  assert.deepEqual(events, ['detect', 'plan', 'confirm']);
  assert.match(out, /@vshulcz\/deja-vu@0\.19\.0/);
  assert.match(out, /companion-target: claude-auto/);
  assert.match(out, /PreToolUse command\/edit/);
  assert.match(out, /plaintext global deja-vu index with best-effort redaction/);
  assert.match(out, /deja doctor --json --offline \(schema v2\)/);
  assert.doesNotMatch(out, /\/Users\//);
  assertUnchanged(before, HOME, 'declined companion consent must write nothing');
});

test('deja-vu dry-run detects and plans exact bounded operations but applies and writes nothing', async () => {
  seedHome();
  const before = snapshot(HOME);
  const events = [];
  const { result, out } = await captureLog(() => setup.run({
    flags: FLAGS({ 'dry-run': true, minimal: true, 'with-deja-vu': true }),
    pkgRoot: PKG_ROOT, dejaVuLifecycle: fakeDejaVu(events),
  }));
  assert.equal(result, 0);
  assert.deepEqual(events, ['detect', 'plan']);
  assert.match(out, /package-install, target-install, index/);
  assert.doesNotMatch(out, /deja warmup|deja update|--all|--auto\b/);
  assertUnchanged(before, HOME, 'companion dry-run must not persist intent or mutate files');
});

test('partial deja-vu apply failure persists explicit intent and ownership receipt', async () => {
  seedHome();
  const cfg = loadKitConfig();
  setup.applySetupDejaVuFlags(cfg, FLAGS({ 'with-deja-vu': true }));
  const events = [];
  const adapter = fakeDejaVu(events, {
    applyResult: { ok: false, actions: [{ id: 'package-install', status: 'ok' }], warnings: [], errors: ['target-install-failed'] },
  });
  const preflight = await setup.preflightSetupDejaVu(cfg, adapter);
  const { result, out } = await captureLog(() => setup.applySetupDejaVu(cfg, preflight, adapter));
  assert.equal(result, false);
  assert.match(out, /saved intent\/ownership for safe retry/);
  const saved = loadKitConfig();
  assert.equal(saved.integrations.tools.dejaVu.enabled, true);
  assert.equal(saved.integrations.ownership.dejaVu.install.written.version, '0.19.0');
});

test('post-host preflight is fresh and adds wiring for a host installed during machine setup', async () => {
  seedHome();
  const cfg = loadKitConfig();
  setup.applySetupDejaVuFlags(cfg, FLAGS({ 'with-deja-vu': true }));
  let detections = 0;
  let appliedPlan;
  const adapter = {
    id: 'deja-vu',
    async detect() {
      detections += 1;
      return { install: { version: '0.19.0' }, hostPresent: detections > 1 };
    },
    async plan({ facts }) {
      return {
        changed: facts.hostPresent,
        warnings: [],
        operations: facts.hostPresent ? [{
          id: 'target-install-claude', kind: 'target-install', command: 'deja',
          host: 'claude', mode: 'mcp', args: ['install', 'claude-code', '--no-guidance', '--no-index'],
        }] : [],
      };
    },
    async apply({ plan }) {
      appliedPlan = plan;
      return { ok: true, actions: plan.operations, warnings: [], errors: [] };
    },
  };
  const initial = await setup.preflightSetupDejaVu(cfg, adapter);
  assert.deepEqual(initial.plan.operations, []);
  const result = await setup.finishSetupDejaVu(cfg, initial, adapter);
  assert.equal(result, true);
  assert.equal(detections, 2);
  assert.equal(appliedPlan.operations[0].args[1], 'claude-code');
});

test('--no-deja-vu previews removal of only receipt-owned target wiring', async () => {
  seedHome(offlineKitConfig({
    integrations: {
      version: 1,
      hosts: { claude: true, codex: false, opencode: false }, bindings: [],
      tools: { dejaVu: { enabled: true, mode: 'mcp', hosts: ['claude'], indexOnSetup: true } },
      ownership: { dejaVu: { targets: { claude: { owner: 'agentic-kit', mode: 'mcp' } } } },
    },
  }));
  const before = snapshot(HOME);
  const events = [];
  const removal = {
    id: 'deja-vu',
    async detect() { events.push('detect'); return { install: { version: '0.19.0' } }; },
    async plan() {
      events.push('plan');
      return { changed: true, warnings: [], operations: [{
        id: 'target-remove-claude', kind: 'target-remove', command: 'deja',
        host: 'claude', mode: 'mcp', args: ['uninstall', 'claude-code', '--no-guidance', '--no-index'],
      }] };
    },
    async apply() { events.push('apply'); return { ok: true, actions: [], warnings: [], errors: [] }; },
  };
  const { result, out } = await captureLog(() => setup.run({
    flags: FLAGS({ 'dry-run': true, minimal: true, 'no-deja-vu': true }),
    pkgRoot: PKG_ROOT, dejaVuLifecycle: removal,
  }));
  assert.equal(result, 0);
  assert.deepEqual(events, ['detect', 'plan']);
  assert.match(out, /companion-target-removal: claude-code/);
  assert.match(out, /preserve the npm package, transcripts, and index/);
  assert.doesNotMatch(out, /npm-package|history-index/);
  assertUnchanged(before, HOME, 'removal dry-run must remain read-only');
});

test('post-host replan failure persists intent and refuses companion apply', async () => {
  seedHome();
  const cfg = loadKitConfig();
  setup.applySetupDejaVuFlags(cfg, FLAGS({ 'with-deja-vu': true }));
  let plans = 0;
  let applies = 0;
  const adapter = {
    id: 'deja-vu',
    async detect() { return { install: { version: '0.19.0' } }; },
    async plan() {
      plans += 1;
      return plans === 1
        ? { changed: false, operations: [], warnings: [] }
        : { changed: false, operations: [], warnings: [], error: 'doctor-schema-invalid' };
    },
    async apply() { applies += 1; return { ok: true, actions: [], warnings: [], errors: [] }; },
  };
  const initial = await setup.preflightSetupDejaVu(cfg, adapter);
  const { result, out } = await captureLog(() => setup.finishSetupDejaVu(cfg, initial, adapter));
  assert.equal(result, false);
  assert.equal(applies, 0);
  assert.match(out, /saved intent\/ownership for safe retry/);
  assert.equal(loadKitConfig().integrations.tools.dejaVu.enabled, true);
});

test('--dry-run reports what --codex/--primary-host WOULD do without enabling them', async () => {
  seedHome();
  const before = snapshot(HOME);
  const { result, out } = await captureLog(() =>
    setup.run({ flags: FLAGS({ 'dry-run': true, minimal: true, codex: true }), pkgRoot: PKG_ROOT }));
  assert.equal(result, 0);
  assert.match(out, /dry-run: --codex\/--primary-host would enable \+ install the codex host/);
  assert.equal(loadKitConfig().integrations.hosts.codex, false,
    'a previewed --codex must not persist the host opt-in');
  assertUnchanged(before, HOME, '`ak setup --codex --dry-run` must not touch the filesystem');
});

test('--codex project dry-run discloses current registrations while preserving Codex policy', async () => {
  seedHome();
  const project = sandboxProject('ak-setup-codex-trust');
  const cwd = process.cwd();
  process.chdir(project);
  try {
    const { result, out } = await captureLog(() =>
      setup.run({ flags: FLAGS({ 'dry-run': true, codex: true }), pkgRoot: PKG_ROOT }));
    assert.equal(result, 0);
    assert.match(out, /OpenAI Codex — approval\/sandbox policy unchanged/);
    assert.doesNotMatch(out, /codex mcp-server|mcp__codex__codex/);
    assert.match(out, /\[user\] mcp-registration: ak x ruflo-mcp/);
  } finally { process.chdir(cwd); rmrf(project); }
});

test('--minimal skips project setup even inside a git repo', async () => {
  seedHome();
  const project = sandboxProject('ak-setup-min');
  const cwd = process.cwd();
  process.chdir(project);
  try {
    const { out } = await captureLog(() =>
      setup.run({ flags: FLAGS({ 'dry-run': true, minimal: true }), pkgRoot: PKG_ROOT }));
    assert.ok(!out.includes('project setup —'), '--minimal must not enter project scope');
  } finally { process.chdir(cwd); }
  rmrf(project);
});

test('a git repo cwd auto-selects project scope; a bare directory does not', async () => {
  seedHome();
  const project = sandboxProject('ak-setup-auto');
  const bare = fs.mkdtempSync(path.join(HOME, 'bare-'));
  const cwd = process.cwd();
  try {
    process.chdir(project);
    const inRepo = await captureLog(() =>
      setup.run({ flags: FLAGS({ 'dry-run': true }), pkgRoot: PKG_ROOT }));
    assert.match(inRepo.out, /project setup —/, 'a .git directory selects project scope');

    process.chdir(bare);
    const outside = await captureLog(() =>
      setup.run({ flags: FLAGS({ 'dry-run': true }), pkgRoot: PKG_ROOT }));
    assert.match(outside.out, /not inside a project \(no \.git here\)/);
    assert.ok(!outside.out.includes('project setup —'));
  } finally { process.chdir(cwd); }
  rmrf(project);
});

test('--project forces project scope outside a git repo', async () => {
  seedHome();
  const bare = fs.mkdtempSync(path.join(HOME, 'bare-forced-'));
  const cwd = process.cwd();
  process.chdir(bare);
  try {
    const { out } = await captureLog(() =>
      setup.run({ flags: FLAGS({ 'dry-run': true, project: true }), pkgRoot: PKG_ROOT }));
    assert.match(out, /project setup —/);
  } finally { process.chdir(cwd); }
});

test('every documented flag is declared in the parser options', () => {
  for (const flag of ['dry-run', 'yes', 'minimal', 'project', 'no-aqe', 'no-ruvnet-brain',
    'no-agent-browser', 'no-security', 'codex', 'opencode', 'with-deja-vu', 'deja-vu-mode', 'no-deja-vu',
    'primary-host', 'reconfigure']) {
    assert.ok(flag in setup.options, `--${flag} is documented in help but not parseable`);
    assert.match(setup.help, new RegExp(`--${flag}\\b`), `--${flag} is parseable but undocumented`);
  }
});

// ── --opencode (the third host's bootstrap path) ─────────────────────────────
// Command-level orchestration: the flag persists the enabled host, the shared
// opencode stack runs only when the CLI is actually present (an absent CLI
// never fabricates ~/.config/opencode), and successful wiring prints the
// restart guidance. In-process against the sandboxed HOME; a fake `opencode`
// shim on PATH plays the installed CLI.

/** Prepend a fake `opencode` bin to PATH for the duration of `fn`. The sandbox
 *  PATH is a single nonexistent dir, so /usr/bin:/bin are re-added for the
 *  `which` probe itself — npm stays unresolvable, keeping the test offline. */
async function withOpencodeCli(fn) {
  const bin = path.join(HOME, `fake-bin-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'opencode'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'opencode.cmd'), '@echo off\r\nexit /b 0\r\n');
  fs.writeFileSync(path.join(bin, 'opencode.ps1'), 'exit 0\r\n');
  const prev = process.env.PATH;
  process.env.PATH = [bin, '/usr/bin', '/bin'].join(path.delimiter);
  try { return await fn(); } finally { process.env.PATH = prev; rmrf(bin); }
}

/** A fixture ruflo catalog for agent conversion (RUFLO_REPO). */
function seedCatalog() {
  const root = path.join(HOME, 'catalog');
  rmrf(root);
  fs.mkdirSync(path.join(root, '.claude', 'agents'), { recursive: true });
  fs.mkdirSync(path.join(root, '.claude', 'skills', 'a-skill'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '9.9.9' }));
  fs.writeFileSync(path.join(root, '.claude', 'agents', 'coder.md'),
    '---\nname: coder\ndescription: Implementation specialist\n---\n\nBody.\n');
  fs.writeFileSync(path.join(root, 'SKILL.md'), '---\nname: ruflo\ndescription: platform\n---\n\n# Ruflo\n');
  return root;
}

const ocHome = () => path.join(HOME, '.config', 'opencode');

test('ak setup --opencode --yes persists the host and wires it via the shared stack when the CLI is present', async () => {
  seedHome();
  // ruflo/agentic-qe "installed" so machine scope skips the npm upgrade path.
  paths._setGlobalRootForTest(fakeGlobalRoot(HOME, { ruflo: '9.9.9', 'agentic-qe': '9.9.9' }));
  const catalog = seedCatalog();
  const prevRepo = process.env.RUFLO_REPO;
  process.env.RUFLO_REPO = catalog;
  try {
    await withOpencodeCli(async () => {
      const { result, out } = await captureLog(() =>
        setup.run({ flags: FLAGS({ opencode: true, yes: true, minimal: true }), pkgRoot: PKG_ROOT }));
      assert.equal(result, 0, out);
      assert.match(out, /restart opencode to load the Agentic Kit hooks, compact gateway, and MCP connections/,
        'restart guidance after successful wiring');
      assert.match(out, /opencode gateway:/, 'setup reports the compact gateway explicitly');
    });
    const cfg = loadKitConfig();
    assert.equal(cfg.integrations.hosts.opencode, true, 'enabled host persisted to kit.json');
    assert.equal(cfg.integrations.ownership.opencode.mcp, 'ak', 'ownership marker persisted');
    const doc = JSON.parse(fs.readFileSync(path.join(ocHome(), 'opencode.json'), 'utf8'));
    assert.ok(doc.mcp['claude-flow'], 'claude-flow MCP wired');
    assert.ok(fs.existsSync(path.join(ocHome(), 'plugins', 'ruflo-hooks.js')), 'lifecycle plugin deployed');
    assert.ok(fs.existsSync(path.join(ocHome(), 'plugins', 'ruflo-gateway.js')), 'lazy gateway deployed');
    assert.ok(fs.existsSync(path.join(ocHome(), 'agents', 'ak-specialist.md')), 'specialist dispatcher deployed');
    assert.equal(fs.existsSync(path.join(ocHome(), 'agents', 'coder.md')), false,
      'eager agent catalogue is not projected into the initial task description');
    assert.ok(fs.existsSync(path.join(ocHome(), 'skills', 'ruflo', 'SKILL.md')), 'platform skill deployed');
    // guidance blocks land NOW, not on the next reconcile (codex-review #18)
    const agentsMd = path.join(ocHome(), 'AGENTS.md');
    assert.ok(fs.existsSync(agentsMd) && fs.readFileSync(agentsMd, 'utf8').includes('BEGIN ruflo-'),
      'opencode AGENTS.md guidance blocks written during setup');
  } finally {
    if (prevRepo === undefined) delete process.env.RUFLO_REPO;
    else process.env.RUFLO_REPO = prevRepo;
  }
});

test('ak setup --opencode --dry-run writes nothing anywhere (kit.json, opencode home, artifacts)', async () => {
  seedHome();
  const before = snapshot(HOME);
  const { result, out } = await captureLog(() =>
    setup.run({ flags: FLAGS({ 'dry-run': true, minimal: true, opencode: true }), pkgRoot: PKG_ROOT }));
  assert.equal(result, 0);
  assert.match(out, /OpenCode — approval policy receives the listed grants/);
  for (const pattern of ['claude-flow_*', 'claude_flow_*', 'ruvnet-brain_*', 'ruvnet_brain_*']) {
    assert.ok(out.includes(`[user] auto-approve: ${pattern}`), `missing disclosure for ${pattern}`);
  }
  assert.match(out, /dry-run: --opencode would enable the opencode host/);
  assert.equal(loadKitConfig().integrations.hosts.opencode, false, 'a previewed --opencode must not persist');
  assert.ok(!fs.existsSync(ocHome()), 'no opencode config home fabricated by a dry run');
  assertUnchanged(before, HOME, '`ak setup --opencode --dry-run` must not touch the filesystem');
});

test('declining OpenCode trust stops a minimal setup before user-scope mutation', async () => {
  seedHome();
  const before = snapshot(HOME);
  const { result, out } = await captureLog(() => setup.run({
    flags: FLAGS({ minimal: true, opencode: true }), pkgRoot: PKG_ROOT,
    confirm: async () => false,
  }));
  assert.equal(result, 0);
  assert.match(out, /setup cancelled before machine, user, or project changes/);
  assertUnchanged(before, HOME, 'declined OpenCode trust must not touch HOME');
});

test('ak setup --opencode fails honestly and deploys nothing when JSONC is refused', async () => {
  seedHome();
  paths._setGlobalRootForTest(fakeGlobalRoot(HOME, { ruflo: '9.9.9', 'agentic-qe': '9.9.9' }));
  fs.mkdirSync(ocHome(), { recursive: true });
  fs.writeFileSync(path.join(ocHome(), 'opencode.json'), '{\n// legal JSONC\n"mcp": {}\n}\n');
  const { result, out } = await withOpencodeCli(() => captureLog(() =>
    setup.run({ flags: FLAGS({ opencode: true, yes: true, minimal: true }), pkgRoot: PKG_ROOT })));
  assert.equal(result, 1);
  assert.match(out, /plugin\/gateway\/agents\/skill\/guidance skipped/);
  assert.doesNotMatch(out, /restart opencode|setup complete/);
  for (const surface of ['plugins', 'agents', 'skills', 'AGENTS.md']) {
    assert.equal(fs.existsSync(path.join(ocHome(), surface)), false, `${surface} must not be deployed`);
  }
});

test('ak setup --opencode with an ABSENT CLI never fabricates the config home', async () => {
  seedHome();
  paths._setGlobalRootForTest(fakeGlobalRoot(HOME, { ruflo: '9.9.9', 'agentic-qe': '9.9.9' }));
  // sandbox PATH has no opencode — have('opencode') is false.
  const { result, out } = await captureLog(() =>
    setup.run({ flags: FLAGS({ opencode: true, yes: true, minimal: true }), pkgRoot: PKG_ROOT }));
  assert.equal(result, 0, out);
  assert.match(out, /opencode: enabled but CLI not installed — wiring skipped/);
  assert.equal(loadKitConfig().integrations.hosts.opencode, true,
    'the enablement intent is still persisted (sync completes it once installed)');
  assert.ok(!fs.existsSync(ocHome()), 'no config home created for a host that is not there');
});

test.after(() => rmrf(HOME));
