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

const HOME = sandboxHome('ak-setup');
const paths = await import('../../src/lib/paths.mjs');
const setup = await import('../../src/commands/setup.mjs');
const { loadKitConfig } = await import('../../src/lib/config.mjs');
assertSandboxed(paths, HOME);

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FLAGS = (over = {}) => ({
  'dry-run': false, yes: false, minimal: false, project: false,
  'no-aqe': false, 'no-ruvnet-brain': false, 'no-security': false,
  codex: false, opencode: false, reconfigure: false, ...over,
});

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
  } finally { process.chdir(cwd); }
  assertUnchanged(beforeHome, HOME, 'run_project --dry-run must not touch HOME');
  assertUnchanged(beforeProject, project, 'run_project --dry-run must not touch the project');
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

test('--dry-run reports what --codex/--primary-host WOULD do without enabling them', async () => {
  seedHome();
  const before = snapshot(HOME);
  const { result, out } = await captureLog(() =>
    setup.run({ flags: FLAGS({ 'dry-run': true, minimal: true, codex: true }), pkgRoot: PKG_ROOT }));
  assert.equal(result, 0);
  assert.match(out, /dry-run: --codex\/--primary-host would enable \+ install the codex host/);
  assert.equal(loadKitConfig().providers.hosts.codex, false,
    'a previewed --codex must not persist the host opt-in');
  assertUnchanged(before, HOME, '`ak setup --codex --dry-run` must not touch the filesystem');
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
    'no-security', 'codex', 'opencode', 'primary-host', 'reconfigure']) {
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
      assert.match(out, /restart opencode to load the hooks/, 'restart guidance after successful wiring');
    });
    const cfg = loadKitConfig();
    assert.equal(cfg.providers.hosts.opencode, true, 'enabled host persisted to kit.json');
    assert.equal(cfg.providers.opencodeMcp, 'ak', 'ownership marker persisted');
    const doc = JSON.parse(fs.readFileSync(path.join(ocHome(), 'opencode.json'), 'utf8'));
    assert.ok(doc.mcp['claude-flow'], 'claude-flow MCP wired');
    assert.ok(fs.existsSync(path.join(ocHome(), 'plugins', 'ruflo-hooks.js')), 'lifecycle plugin deployed');
    assert.ok(fs.existsSync(path.join(ocHome(), 'agents', 'coder.md')), 'agents converted');
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
  assert.match(out, /dry-run: --opencode would enable the opencode host/);
  assert.equal(loadKitConfig().providers.hosts.opencode, false, 'a previewed --opencode must not persist');
  assert.ok(!fs.existsSync(ocHome()), 'no opencode config home fabricated by a dry run');
  assertUnchanged(before, HOME, '`ak setup --opencode --dry-run` must not touch the filesystem');
});

test('ak setup --opencode with an ABSENT CLI never fabricates the config home', async () => {
  seedHome();
  paths._setGlobalRootForTest(fakeGlobalRoot(HOME, { ruflo: '9.9.9', 'agentic-qe': '9.9.9' }));
  // sandbox PATH has no opencode — have('opencode') is false.
  const { result, out } = await captureLog(() =>
    setup.run({ flags: FLAGS({ opencode: true, yes: true, minimal: true }), pkgRoot: PKG_ROOT }));
  assert.equal(result, 0, out);
  assert.match(out, /opencode: enabled but CLI not installed — wiring skipped/);
  assert.equal(loadKitConfig().providers.hosts.opencode, true,
    'the enablement intent is still persisted (sync completes it once installed)');
  assert.ok(!fs.existsSync(ocHome()), 'no config home created for a host that is not there');
});

test.after(() => rmrf(HOME));
