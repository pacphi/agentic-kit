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
  sandboxProject, writeKitConfig, offlineKitConfig,
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
  codex: false, reconfigure: false, ...over,
});

function seedHome(cfg = offlineKitConfig()) {
  rmrf(paths.claudeDir(), paths.configDir());
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
    'no-security', 'codex', 'primary-host', 'reconfigure']) {
    assert.ok(flag in setup.options, `--${flag} is documented in help but not parseable`);
    assert.match(setup.help, new RegExp(`--${flag}\\b`), `--${flag} is parseable but undocumented`);
  }
});

test.after(() => rmrf(HOME));
