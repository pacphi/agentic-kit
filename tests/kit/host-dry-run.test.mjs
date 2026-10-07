// `ak host --dry-run`: `pick`, `off` and `reset-routes` print a preview
// and stop before any write; `adapters` has no meaningful preview to give and
// refuses outright. Every write-avoiding path is proven the same way — a
// content-addressed snapshot of the sandbox HOME and project before the run,
// asserted byte-identical after (home-sandbox.mjs's `assertUnchanged`), so a
// regression that sneaks a write in anywhere is caught without having to
// name every file it could touch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  spawnEnv, sandboxProject, writeKitConfig, offlineKitConfig, snapshot, assertUnchanged, rmrf,
} from './helpers/home-sandbox.mjs';
import { DEFAULT_ROUTES } from '../../src/lib/routing.mjs';

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../bin/agentic-kit.mjs');

/** A diverged seeded route (like provider-refresh-cli.test.mjs's fixture) so
 *  `reset-routes --dry-run` has something to preview. */
const divergedConfig = () => offlineKitConfig({
  integrations: { version: 2, hosts: { claude: true, codex: true, opencode: false }, bindings: [] },
  routing: {
    version: 1,
    primaryHost: 'claude',
    routes: { architecture: { host: 'claude', model: 'claude-opus-4-8', provenance: 'seeded' } },
  },
});

/** Registers its own cleanup with `t.after` immediately after each mkdtemp
 *  (the house pattern — see tests/kit/codex-usage-diagnostic.test.mjs), so a
 *  failing assertion still removes the fixture instead of leaving
 *  `ak-host-dry-{home,proj}-*` behind under the OS temp dir. */
function sandbox(t, cfg = offlineKitConfig()) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-host-dry-home-'));
  t.after(() => rmrf(home));
  writeKitConfig(home, cfg);
  const project = sandboxProject('ak-host-dry');
  t.after(() => rmrf(project));
  const env = spawnEnv(home, {
    NO_COLOR: '1',
    XDG_CONFIG_HOME: path.join(home, '.config'),
    APPDATA: path.join(home, '.config'),
    // Nothing invokable: pick/off never attempt a real install/detect probe
    // once the dry-run branch returns, but this keeps every path hermetic
    // even if that changes later.
    PATH: path.join(home, 'no-such-bin'),
  });
  return { home, project, env };
}

function ak(sb, ...args) {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd: sb.project, env: sb.env, encoding: 'utf8' });
  return { ...r, all: `${r.stdout}${r.stderr}` };
}

const readKit = (home) => fs.readFileSync(path.join(home, '.config', 'agentic-kit', 'kit.json'), 'utf8');

for (const args of [
  ['host', 'status'], ['host'], ['x', 'host'],
]) {
  test(`ak ${args.join(' ')} --dry-run --json reports status without recording evidence`, (t) => {
    const sb = sandbox(t);
    const beforeHome = snapshot(sb.home);
    const beforeProject = snapshot(sb.project);
    const r = ak(sb, ...args, '--dry-run', '--json');
    assert.equal(r.status, 0, r.all);
    const out = JSON.parse(r.stdout);
    assert.deepEqual(Object.keys(out), ['scope', 'config', 'hosts', 'providers']);
    assert.ok(out.hosts.claude);
    assertUnchanged(beforeHome, sb.home, 'status preview must not write host evidence or config');
    assertUnchanged(beforeProject, sb.project, 'status preview must not write project files');
  });
}

test('ak host pick --dry-run previews and writes nothing', (t) => {
  const sb = sandbox(t);
  const beforeHome = snapshot(sb.home);
  const beforeProject = snapshot(sb.project);
  const beforeKit = readKit(sb.home);
  const r = ak(sb, 'host', 'pick', '--host', 'claude,codex', '--dry-run', '--yes');
  assert.equal(r.status, 0, r.all);
  assert.match(r.all, /dry run/i);
  assert.match(r.all, /claude/);
  assert.match(r.all, /codex/);
  assert.equal(readKit(sb.home), beforeKit, 'kit.json is untouched');
  assertUnchanged(beforeHome, sb.home, '`ak host pick --dry-run` must not touch HOME');
  assertUnchanged(beforeProject, sb.project, '`ak host pick --dry-run` must not touch the project');
});

test('ak host pick --dry-run never prompts (no TTY, no --yes, still exits clean)', (t) => {
  const sb = sandbox(t);
  const r = ak(sb, 'host', 'pick', '--host', 'claude,codex', '--dry-run');
  assert.equal(r.status, 0, r.all);
  assert.match(r.all, /dry run/i);
});

test('bare ak host pick --dry-run (no other flag) never opens the interactive prompt', (t) => {
  const sb = sandbox(t);
  const r = ak(sb, 'host', 'pick', '--dry-run');
  assert.equal(r.status, 0, r.all);
  assert.match(r.all, /dry run/i);
  assert.doesNotMatch(r.all, /Enable which ruflo host/);
});

test('bare ak host pick --dry-run discloses it is previewing the current configuration', (t) => {
  const sb = sandbox(t);
  const r = ak(sb, 'host', 'pick', '--dry-run');
  assert.equal(r.status, 0, r.all);
  assert.match(r.all, /previewing the current configuration/i);
  assert.match(r.all, /interactive `ak host pick`/i);
});

test('ak host pick --dry-run with an explicit --host does not carry the previewing-current disclosure', (t) => {
  const sb = sandbox(t);
  const r = ak(sb, 'host', 'pick', '--host', 'claude,codex', '--dry-run', '--yes');
  assert.equal(r.status, 0, r.all);
  assert.doesNotMatch(r.all, /previewing the current configuration/i);
});

test('ak host pick --dry-run --json carries previewOfCurrent, true only with no explicit choice', (t) => {
  const sb = sandbox(t);
  const bare = ak(sb, 'host', 'pick', '--dry-run', '--json');
  assert.equal(bare.status, 0, bare.all);
  const bareJson = JSON.parse(bare.stdout);
  assert.equal(bareJson.dryRun, true);
  assert.equal(bareJson.previewOfCurrent, true);
  assert.doesNotMatch(bare.stdout, /previewing the current configuration/i, 'the disclosure is a field under --json, never text');

  const explicit = ak(sb, 'host', 'pick', '--host', 'claude,codex', '--dry-run', '--yes', '--json');
  assert.equal(explicit.status, 0, explicit.all);
  const explicitJson = JSON.parse(explicit.stdout);
  assert.equal(explicitJson.previewOfCurrent, false);
});

test('host pick refusal and x host alias dry-run emit one JSON object without writes', (t) => {
  const sb = sandbox(t);
  const beforeHome = snapshot(sb.home);
  const beforeProject = snapshot(sb.project);
  for (const command of ['host', 'x']) {
    const args = command === 'x' ? ['x', 'host'] : ['host'];
    const r = ak(sb, ...args, 'pick', '--host', 'claude,opencdoe', '--dry-run', '--json');
    assert.equal(r.status, 2, r.all);
    const out = JSON.parse(r.stdout);
    assert.deepEqual(Object.keys(out), ['error', 'exitCode']);
    assert.equal(out.exitCode, 2);
    assert.match(out.error, /unknown host\(s\): opencdoe/);
    assert.match(r.stderr, /unknown host\(s\): opencdoe/);
  }
  assertUnchanged(beforeHome, sb.home, 'refused picks must not touch HOME');
  assertUnchanged(beforeProject, sb.project, 'refused picks must not touch the project');
});

test('host off dry-run JSON previews teardown and preserves configuration', (t) => {
  const sb = sandbox(t, divergedConfig());
  const beforeHome = snapshot(sb.home);
  const beforeProject = snapshot(sb.project);
  const r = ak(sb, 'host', 'off', '--dry-run', '--json');
  assert.equal(r.status, 0, r.all);
  const out = JSON.parse(r.stdout);
  assert.equal(out.dryRun, true);
  assert.deepEqual(out.wouldDisable, ['claude', 'codex']);
  assert.equal(out.primaryHost, 'claude');
  assert.deepEqual(out.wouldClear, ['aqe provider/fallback', 'ruflo providers', 'activity routing']);
  assert.equal(out.wouldStripManagedProviderEnv, true);
  assert.equal(out.wouldRestoreOrRemoveManagedAqeConfig, true);
  assert.equal(out.wouldReconcileOpencodeGuidance, true);
  assert.equal(out.wouldTeardownOpencode, false);
  assert.equal(out.wouldRemoveManagedCodexMcp, false);
  assert.match(r.stderr, /dry run/i);
  assertUnchanged(beforeHome, sb.home, 'off preview must not touch HOME');
  assertUnchanged(beforeProject, sb.project, 'off preview must not touch the project');
});

test('host reset-routes dry-run JSON reports selected and empty routes without writes', (t) => {
  const sb = sandbox(t, divergedConfig());
  const beforeHome = snapshot(sb.home);
  const beforeProject = snapshot(sb.project);
  const selected = ak(sb, 'host', 'reset-routes', '--activity', 'architecture', '--dry-run', '--json');
  assert.equal(selected.status, 0, selected.all);
  assert.deepEqual(JSON.parse(selected.stdout), { dryRun: true, activities: ['architecture'] });
  const empty = ak(sb, 'host', 'reset-routes', '--activity', 'design', '--dry-run', '--json');
  assert.equal(empty.status, 0, empty.all);
  assert.deepEqual(JSON.parse(empty.stdout), { dryRun: true, activities: [] });
  const invalid = ak(sb, 'host', 'reset-routes', '--activity', 'not-an-activity', '--dry-run', '--json');
  assert.equal(invalid.status, 0, invalid.all);
  assert.deepEqual(JSON.parse(invalid.stdout), { dryRun: true, activities: [] });
  assert.match(invalid.stderr, /unknown activity 'not-an-activity'/);
  assertUnchanged(beforeHome, sb.home, 'route previews must not touch HOME');
  assertUnchanged(beforeProject, sb.project, 'route previews must not touch the project');
});

test('host reset-routes dry-run JSON reports no divergence as an empty preview', (t) => {
  const sb = sandbox(t);
  const beforeHome = snapshot(sb.home);
  const beforeProject = snapshot(sb.project);
  const r = ak(sb, 'host', 'reset-routes', '--dry-run', '--json');
  assert.equal(r.status, 0, r.all);
  assert.deepEqual(JSON.parse(r.stdout), { dryRun: true, activities: [] });
  assertUnchanged(beforeHome, sb.home, 'no-op route preview must not touch HOME');
  assertUnchanged(beforeProject, sb.project, 'no-op route preview must not touch the project');
});

test('ak host off --dry-run previews and writes nothing', (t) => {
  const sb = sandbox(t, divergedConfig());
  const beforeHome = snapshot(sb.home);
  const beforeProject = snapshot(sb.project);
  const r = ak(sb, 'host', 'off', '--dry-run');
  assert.equal(r.status, 0, r.all);
  assert.match(r.all, /dry run/i);
  assert.match(r.all, /would disable/i);
  assert.match(r.all, /would reconcile the opencode AGENTS\.md guidance blocks/i, 'the guidance-file strip step must be listed too');
  assertUnchanged(beforeHome, sb.home, '`ak host off --dry-run` must not touch HOME');
  assertUnchanged(beforeProject, sb.project, '`ak host off --dry-run` must not touch the project');
});

test('ak host reset-routes --dry-run --yes previews the activities it would reset and writes nothing', (t) => {
  const sb = sandbox(t, divergedConfig());
  const beforeHome = snapshot(sb.home);
  const beforeProject = snapshot(sb.project);
  const r = ak(sb, 'host', 'reset-routes', '--dry-run', '--yes');
  assert.equal(r.status, 0, r.all);
  assert.match(r.all, /dry run/i);
  assert.match(r.all, /would reset 1 route\(s\)/i);
  assert.match(r.all, /architecture/);
  assertUnchanged(beforeHome, sb.home, '`ak host reset-routes --dry-run` must not touch HOME');
  assertUnchanged(beforeProject, sb.project, '`ak host reset-routes --dry-run` must not touch the project');
});

test('ak host reset-routes --dry-run never prompts, even with no --activity and no --yes', (t) => {
  const sb = sandbox(t, divergedConfig());
  const r = ak(sb, 'host', 'reset-routes', '--dry-run');
  assert.equal(r.status, 0, r.all);
  assert.match(r.all, /dry run/i);
  assert.doesNotMatch(r.all, /reset which activities\?/);
});

test('ak host reset-routes --dry-run with nothing diverged is the existing no-op message', (t) => {
  const sb = sandbox(t);
  const r = ak(sb, 'host', 'reset-routes', '--dry-run');
  assert.equal(r.status, 0, r.all);
  assert.match(r.all, /no seeded routes diverge/i);
});

test('the reset-routes subcommand help documents the name and description on separate, aligned lines', (t) => {
  const sb = sandbox(t);
  const r = ak(sb, 'host', '--help');
  assert.equal(r.status, 0, r.all);
  const lines = r.stdout.split('\n');
  const nameIdx = lines.findIndex((l) => /^ {2}reset-routes\s*$/.test(l));
  assert.ok(nameIdx >= 0, `reset-routes must be on its own line:\n${r.stdout}`);
  const descIdx = nameIdx + 1;
  assert.match(lines[descIdx], /^ {13}\S/, `description must start at the same column as every other continuation line:\n${lines[descIdx]}`);
  // Every other subcommand's wrapped continuation lines already use this
  // column — reset-routes must match it exactly, not just start indented.
  const otherContinuation = lines.find((l) => /^ {13}installed \(with the complete/.test(l));
  assert.ok(otherContinuation, 'fixture assumption: status\' continuation line is at column 13');
});

test('ak host --help documents --dry-run for pick, off and reset-routes', (t) => {
  const sb = sandbox(t);
  const r = ak(sb, 'host', '--help');
  assert.equal(r.status, 0, r.all);
  const pickBlock = r.stdout.slice(r.stdout.indexOf('  pick'), r.stdout.indexOf('  reset-routes'));
  assert.match(pickBlock, /--dry-run/);
  const resetBlock = r.stdout.slice(r.stdout.indexOf('  reset-routes'), r.stdout.indexOf('  off'));
  assert.match(resetBlock, /--dry-run/);
  const offBlock = r.stdout.slice(r.stdout.indexOf('  off'), r.stdout.indexOf('  check-connection'));
  assert.match(offBlock, /--dry-run/);
});

test('DEFAULT_ROUTES fixture sanity: architecture has a current default distinct from the seeded pin', () => {
  assert.notEqual(DEFAULT_ROUTES.architecture.model, 'claude-opus-4-8');
});
