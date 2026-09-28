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

function sandbox(cfg = offlineKitConfig()) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-host-dry-home-'));
  writeKitConfig(home, cfg);
  const project = sandboxProject('ak-host-dry');
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

test('ak host pick --dry-run previews and writes nothing', () => {
  const sb = sandbox();
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
  rmrf(sb.home, sb.project);
});

test('ak host pick --dry-run never prompts (no TTY, no --yes, still exits clean)', () => {
  const sb = sandbox();
  const r = ak(sb, 'host', 'pick', '--host', 'claude,codex', '--dry-run');
  assert.equal(r.status, 0, r.all);
  assert.match(r.all, /dry run/i);
  rmrf(sb.home, sb.project);
});

test('bare ak host pick --dry-run (no other flag) never opens the interactive prompt', () => {
  const sb = sandbox();
  const r = ak(sb, 'host', 'pick', '--dry-run');
  assert.equal(r.status, 0, r.all);
  assert.match(r.all, /dry run/i);
  assert.doesNotMatch(r.all, /Enable which ruflo host/);
  rmrf(sb.home, sb.project);
});

test('ak host off --dry-run previews and writes nothing', () => {
  const sb = sandbox(divergedConfig());
  const beforeHome = snapshot(sb.home);
  const beforeProject = snapshot(sb.project);
  const r = ak(sb, 'host', 'off', '--dry-run');
  assert.equal(r.status, 0, r.all);
  assert.match(r.all, /dry run/i);
  assert.match(r.all, /would disable/i);
  assertUnchanged(beforeHome, sb.home, '`ak host off --dry-run` must not touch HOME');
  assertUnchanged(beforeProject, sb.project, '`ak host off --dry-run` must not touch the project');
  rmrf(sb.home, sb.project);
});

test('ak host reset-routes --dry-run --yes previews the activities it would reset and writes nothing', () => {
  const sb = sandbox(divergedConfig());
  const beforeHome = snapshot(sb.home);
  const beforeProject = snapshot(sb.project);
  const r = ak(sb, 'host', 'reset-routes', '--dry-run', '--yes');
  assert.equal(r.status, 0, r.all);
  assert.match(r.all, /dry run/i);
  assert.match(r.all, /would reset 1 route\(s\)/i);
  assert.match(r.all, /architecture/);
  assertUnchanged(beforeHome, sb.home, '`ak host reset-routes --dry-run` must not touch HOME');
  assertUnchanged(beforeProject, sb.project, '`ak host reset-routes --dry-run` must not touch the project');
  rmrf(sb.home, sb.project);
});

test('ak host reset-routes --dry-run never prompts, even with no --activity and no --yes', () => {
  const sb = sandbox(divergedConfig());
  const r = ak(sb, 'host', 'reset-routes', '--dry-run');
  assert.equal(r.status, 0, r.all);
  assert.match(r.all, /dry run/i);
  assert.doesNotMatch(r.all, /reset which activities\?/);
  rmrf(sb.home, sb.project);
});

test('ak host reset-routes --dry-run with nothing diverged is the existing no-op message', () => {
  const sb = sandbox();
  const r = ak(sb, 'host', 'reset-routes', '--dry-run');
  assert.equal(r.status, 0, r.all);
  assert.match(r.all, /no seeded routes diverge/i);
  rmrf(sb.home, sb.project);
});

test('ak host adapters list --dry-run refuses: adapters has no preview', () => {
  const sb = sandbox();
  const r = ak(sb, 'host', 'adapters', 'list', '--dry-run');
  assert.equal(r.status, 2, r.all);
  assert.match(r.all, /ak host adapters has no preview; run it without --dry-run/);
  rmrf(sb.home, sb.project);
});

test('the reset-routes subcommand help documents the name and description on separate, aligned lines', () => {
  const sb = sandbox();
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
  rmrf(sb.home, sb.project);
});

test('ak host --help documents --dry-run for pick, off and reset-routes', () => {
  const sb = sandbox();
  const r = ak(sb, 'host', '--help');
  assert.equal(r.status, 0, r.all);
  const pickBlock = r.stdout.slice(r.stdout.indexOf('  pick'), r.stdout.indexOf('  reset-routes'));
  assert.match(pickBlock, /--dry-run/);
  const resetBlock = r.stdout.slice(r.stdout.indexOf('  reset-routes'), r.stdout.indexOf('  off'));
  assert.match(resetBlock, /--dry-run/);
  const offBlock = r.stdout.slice(r.stdout.indexOf('  off'), r.stdout.indexOf('  check-connection'));
  assert.match(offBlock, /--dry-run/);
  rmrf(sb.home, sb.project);
});

test('DEFAULT_ROUTES fixture sanity: architecture has a current default distinct from the seeded pin', () => {
  assert.notEqual(DEFAULT_ROUTES.architecture.model, 'claude-opus-4-8');
});
