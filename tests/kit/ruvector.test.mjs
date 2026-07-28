// ruvector — drift management for a global CLI ak deliberately does NOT own.
//
// The whole contract is asymmetric on purpose: ak REPORTS drift and (opt-in)
// upgrades, but never installs. An absent ruvector must therefore produce no
// status row, which is what structurally prevents `ak sync` from installing a
// tool the user never asked for — sync's plan is exactly the rows carrying a
// `fix`, so "no row" is the enforcement mechanism, not just a display choice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  sandboxHome, assertSandboxed, rmrf, sandboxProject, writeKitConfig,
  offlineKitConfig, fakeGlobalRoot,
} from './helpers/home-sandbox.mjs';

const HOME = sandboxHome('ak-ruvector');
const paths = await import('../../src/lib/paths.mjs');
const ruvector = await import('../../src/lib/ruvector.mjs');
const status = await import('../../src/commands/status.mjs');
assertSandboxed(paths, HOME);

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PROJECT = sandboxProject('ak-ruvector');

/** Seed HOME + a fake npm global root. `ruvectorCache` pre-fills the TTL window
 *  so drift() never reaches npm (the suite must be hermetic and offline).
 *  `registered` writes the user-scope MCP entry that gates the whole surface —
 *  ak only manages a ruvector the user actually wired up themselves. */
function seedHome({ pkgs = {}, ruvectorCache, extra = {}, registered = false } = {}) {
  rmrf(paths.claudeDir(), paths.configDir());
  fs.mkdirSync(paths.claudeDir(), { recursive: true });
  fs.writeFileSync(paths.claudeMdPath(), '# machine notes\n');
  const cfg = offlineKitConfig(extra);
  if (ruvectorCache) cfg.versionCheck = { ...cfg.versionCheck, ruvector: { last: Date.now(), ...ruvectorCache } };
  writeKitConfig(HOME, cfg);
  if (registered) {
    fs.writeFileSync(paths.claudeUserMcpPath(),
      JSON.stringify({ mcpServers: { ruvector: { command: 'npx', args: ['-y', 'ruvector', 'mcp', 'start'] } } }));
  } else {
    fs.rmSync(paths.claudeUserMcpPath(), { force: true });
  }
  paths._setGlobalRootForTest(fakeGlobalRoot(HOME, { ruflo: '9.9.9', 'agentic-qe': '9.9.9', ...pkgs }));
}

const collect = () => status.collect({ pkgRoot: PKG_ROOT, cwd: PROJECT });
const ruvectorRows = (rows) => rows.filter((r) => r.subsystem === 'ruvector');

// ── presence detection ──────────────────────────────────────────────────────

test('present() is false when no global ruvector is installed', () => {
  seedHome();
  assert.equal(ruvector.present(), false);
});

test('present() is true once ruvector appears in the npm global root', () => {
  seedHome({ pkgs: { ruvector: '1.2.0' } });
  assert.equal(ruvector.present(), true);
});

test('the managed package name is the bare `ruvector` global', () => {
  assert.equal(ruvector.RUVECTOR_PKG, 'ruvector');
});

// ── managed(): the opt-in gate, as one predicate ───────────────────────────

test('managed() requires BOTH registration and the kit.json opt-out being unset', () => {
  // Registration is the user's signal that they wired ruvector up themselves;
  // kit.json is their escape hatch. Either one alone must not enable management.
  seedHome({ pkgs: { ruvector: '1.2.0' } });
  assert.equal(ruvector.managed(), false, 'installed but unregistered is not managed');

  seedHome({ pkgs: { ruvector: '1.2.0' }, registered: true });
  assert.equal(ruvector.managed(), true, 'registered and not opted out');

  seedHome({ pkgs: { ruvector: '1.2.0' }, registered: true, extra: { ruvector: false } });
  assert.equal(ruvector.managed(), false, 'the kit.json escape hatch wins over registration');
});

test('managed() is false on a machine with no ruvector anywhere', () => {
  seedHome();
  assert.equal(ruvector.managed(), false);
});

// ── classifyDrift (pure) ────────────────────────────────────────────────────

test('classifyDrift reports an absent install as neither present nor outdated', () => {
  const d = ruvector.classifyDrift({ installed: null, latest: '2.0.0' });
  assert.equal(d.present, false);
  assert.equal(d.outdated, false, 'ak never claims an uninstalled tool is out of date');
});

test('classifyDrift flags a genuinely older install as outdated', () => {
  const d = ruvector.classifyDrift({ installed: '1.2.0', latest: '1.3.0' });
  assert.equal(d.present, true);
  assert.equal(d.outdated, true);
  assert.equal(d.installed, '1.2.0');
  assert.equal(d.latest, '1.3.0');
});

test('classifyDrift treats an unknown latest as unknown, never as up-to-date drift', () => {
  // npm unreachable / offline. Reporting `outdated: true` here would plan an
  // upgrade on no evidence; reporting a confident "latest" would be a lie.
  const d = ruvector.classifyDrift({ installed: '1.2.0', latest: null });
  assert.equal(d.outdated, false);
  assert.equal(d.latest, null);
});

test('classifyDrift does not flag an install at or ahead of latest', () => {
  assert.equal(ruvector.classifyDrift({ installed: '1.3.0', latest: '1.3.0' }).outdated, false);
  assert.equal(ruvector.classifyDrift({ installed: '1.4.0', latest: '1.3.0' }).outdated, false,
    'a locally-ahead build is not drift');
});

test('classifyDrift orders versions numerically, not lexically', () => {
  // A lexical compare ranks 1.9.0 above 1.10.0 and would silently miss the bump.
  assert.equal(ruvector.classifyDrift({ installed: '1.9.0', latest: '1.10.0' }).outdated, true);
});

// ── drift() — TTL-cached, and free when ruvector is absent ─────────────────

test('drift() short-circuits with no network probe when ruvector is absent', async () => {
  // PATH in the sandbox contains nothing invokable, so any `npm view` would
  // ENOENT — this asserts the absent path never even tries.
  seedHome();
  const d = await ruvector.drift();
  assert.equal(d.present, false);
  assert.equal(d.latest, null);
});

test('drift() serves a fresh TTL cache instead of hitting npm', async () => {
  seedHome({ pkgs: { ruvector: '1.2.0' }, ruvectorCache: { latest: '1.5.0' } });
  const d = await ruvector.drift();
  assert.equal(d.present, true);
  assert.equal(d.installed, '1.2.0');
  assert.equal(d.latest, '1.5.0', 'cached latest used');
  assert.equal(d.outdated, true);
});

// ── `ak status` rows ────────────────────────────────────────────────────────

test('ak status says NOTHING about an unregistered ruvector, installed or not', async () => {
  // The opt-in guarantee. ak manages ruvector only for a user who wired it up as
  // an MCP server themselves; registration is that signal. Since sync plans
  // exactly the rows carrying a `fix`, "no row" is what makes it structurally
  // impossible for ak to install or touch a ruvector nobody asked it to manage.
  seedHome();
  assert.deepEqual(ruvectorRows(await collect()), [], 'absent and unregistered');

  seedHome({ pkgs: { ruvector: '1.2.0' }, ruvectorCache: { latest: '1.5.0' } });
  assert.deepEqual(ruvectorRows(await collect()), [],
    'installed but never registered — still none of ak\'s business');
});

test('ak status warns on drift once ruvector is registered, and plans an upgrade', async () => {
  seedHome({ pkgs: { ruvector: '1.2.0' }, ruvectorCache: { latest: '1.5.0' }, registered: true });
  const [row] = ruvectorRows(await collect());
  assert.ok(row, 'a drifted, registered ruvector must surface');
  assert.equal(row.level, 'warn');
  assert.match(row.message, /1\.2\.0/);
  assert.match(row.message, /1\.5\.0/);
  assert.ok(row.fix, 'a warn row must tell sync what to do');
  assert.match(row.fix, /upgrade/i, 'and the action is an UPGRADE, never an install');
});

test('ak status reports a current registered ruvector as ok with no planned action', async () => {
  seedHome({ pkgs: { ruvector: '1.5.0' }, ruvectorCache: { latest: '1.5.0' }, registered: true });
  const [row] = ruvectorRows(await collect());
  assert.equal(row.level, 'ok');
  assert.equal(row.fix, null, 'nothing to do — sync must not act');
});

test('a registered ruvector with no global CLI is info, never an install plan', async () => {
  // The MCP server runs via `npx -y ruvector mcp start`, so registration does not
  // imply a global install — and ak must not invent one.
  seedHome({ registered: true });
  const [row] = ruvectorRows(await collect());
  assert.ok(row, 'registration is worth reporting');
  assert.equal(row.level, 'info');
  assert.equal(row.fix, null, 'ak never installs the global CLI');
});

test('kit.json ruvector:false downgrades a registered ruvector to an unactionable info row', async () => {
  // A user who does not want ak touching their hand-managed CLI keeps the
  // visibility but loses the plan entry.
  seedHome({ pkgs: { ruvector: '1.2.0' }, ruvectorCache: { latest: '1.5.0' }, extra: { ruvector: false }, registered: true });
  const [row] = ruvectorRows(await collect());
  assert.equal(row.level, 'info');
  assert.equal(row.fix, null, 'a disabled subsystem must never be planned by sync');
});

test('a drifted ruvector never plans an INSTALL, only an upgrade of what exists', async () => {
  seedHome({ pkgs: { ruvector: '1.2.0' }, ruvectorCache: { latest: '1.5.0' }, registered: true });
  const [row] = ruvectorRows(await collect());
  assert.ok(!/\binstall\b/i.test(row.fix), `fix must not offer to install: ${row.fix}`);
});

test('the row describes the CLI, never claiming the MCP server runs that version', async () => {
  // Honesty pin. The registered command is typically `npx -y ruvector mcp start`,
  // so upgrading the global package does not necessarily change what the server
  // executes. The row must scope its claim to the CLI it can actually see —
  // asserting the server is on that version would be exactly the kind of
  // confident-but-wrong signal these two issues were filed about.
  seedHome({ pkgs: { ruvector: '1.2.0' }, ruvectorCache: { latest: '1.5.0' }, registered: true });
  const [row] = ruvectorRows(await collect());
  assert.match(row.message, /ruvector CLI/, 'the claim is scoped to the CLI');
  assert.ok(!/server (is )?(on|at|running) 1\.2\.0/i.test(row.message),
    `must not claim the MCP server runs the CLI version: ${row.message}`);
  assert.ok(!/\bMCP server (is )?(outdated|stale)\b/i.test(row.message),
    `must not extend the drift claim to the server: ${row.message}`);
});

test.after(() => rmrf(HOME, PROJECT));
