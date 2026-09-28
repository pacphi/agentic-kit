// Opt-in conformance for agentic-qe#654 (constraint
// agentic-qe-3.14.0-stop-hook-generator, sunset after this passed on 3.14.4).
// The installed Agentic-QE generates Claude Code lifecycle hooks in a disposable
// project; they must run through a deterministic runner (no npx or npm exec on
// the hot path), declare timeouts in seconds, and every Stop hook must exit 0
// within its budget with the npm registry unreachable and npx off PATH.
//
//   AK_AQE_CONFORMANCE=1 env -i PATH="$PATH" HOME=<scratch> TMPDIR=<scratch> \
//     node --test tests/live/aqe-stop-hook-conformance.test.mjs
//
// `aqe init` runs with --minimal (without it AQE installs vibium globally,
// AQE/dist/init/phases/09-assets.js) and an npm prefix inside the scratch folder.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const ENABLED = process.env.AK_AQE_CONFORMANCE === '1';
const AQE_BIN = process.env.AQE_BIN ?? 'aqe';

function which(bin) {
  const found = spawnSync('/bin/sh', ['-c', `command -v ${bin}`], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  return found.status === 0 ? fs.realpathSync(found.stdout.trim()) : null;
}

function hooksOf(settings) {
  return Object.entries(settings.hooks ?? {}).flatMap(([event, groups]) => groups.flatMap((group) => (group.hooks ?? [])
    .map((hook) => ({ event, matcher: group.matcher ?? '', ...hook }))));
}

test('Agentic-QE generates npx-free Claude hooks with seconds timeouts, and its Stop hooks pass offline', {
  skip: ENABLED ? false : 'set AK_AQE_CONFORMANCE=1 to run the live AQE Stop-hook conformance',
  timeout: 300_000,
}, (t) => {
  if (process.platform === 'win32') { t.skip('POSIX shell conformance'); return; }
  const aqe = which(AQE_BIN);
  assert.ok(aqe, `${AQE_BIN} not on PATH`);
  const version = spawnSync(aqe, ['--version'], { encoding: 'utf8', env: { PATH: process.env.PATH, NO_COLOR: '1' } });
  assert.equal(version.status, 0, version.stderr);
  t.diagnostic(`agentic-qe ${version.stdout.trim()}`);

  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ak-aqe-654-')));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const project = path.join(temp, 'project');
  const home = path.join(temp, 'home');
  fs.mkdirSync(path.join(project, '.git'), { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(project, 'package.json'), '{"name":"ak-aqe-654","version":"1.0.0"}\n');
  const base = {
    HOME: home, TMPDIR: temp, TERM: 'dumb', NO_COLOR: '1',
    npm_config_prefix: path.join(temp, 'npm-global'), npm_config_cache: path.join(temp, 'npm-cache'),
    AQE_PROJECT_ROOT: project, AQE_MEMORY_PATH: path.join(project, '.agentic-qe', 'memory.db'),
    AQE_STORAGE_PATH: path.join(project, '.agentic-qe'),
  };
  const init = spawnSync(aqe, ['init', '--auto', '--minimal'], {
    cwd: project, encoding: 'utf8', timeout: 180_000, env: { PATH: process.env.PATH, ...base },
  });
  assert.equal(init.status, 0, `${init.stdout}\n${init.stderr}`);

  const settings = JSON.parse(fs.readFileSync(path.join(project, '.claude', 'settings.json'), 'utf8'));
  const hooks = hooksOf(settings);
  assert.ok(hooks.length > 0, 'aqe init wrote no Claude Code hooks');
  for (const hook of hooks) {
    assert.doesNotMatch(String(hook.command), /\bnpx\b|\bnpm\s+exec\b/, `${hook.event} hook uses a package runner: ${hook.command}`);
    assert.ok(Number.isFinite(hook.timeout) && hook.timeout > 0 && hook.timeout < 1000,
      `${hook.event} hook timeout ${hook.timeout} is not in seconds`);
  }

  // Offline: npm cannot reach the registry and npx is not on PATH.
  const bin = path.join(temp, 'bin');
  fs.mkdirSync(bin);
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  fs.symlinkSync(aqe, path.join(bin, 'aqe'));
  const offline = { PATH: [bin, '/usr/bin', '/bin'].join(path.delimiter), ...base, CLAUDE_PROJECT_DIR: project, npm_config_offline: 'true' };
  const npx = spawnSync('/bin/sh', ['-c', 'command -v npx'], { encoding: 'utf8', env: offline });
  assert.notEqual(npx.status, 0, `npx still on the offline PATH: ${npx.stdout}`);

  const stops = hooks.filter((hook) => hook.event === 'Stop');
  assert.ok(stops.length > 0, 'aqe init wrote no Stop hook');
  const payload = JSON.stringify({ session_id: 'ak-654', transcript_path: path.join(temp, 'transcript.jsonl'), hook_event_name: 'Stop', stop_hook_active: false });
  for (const hook of stops) {
    const started = Date.now();
    const run = spawnSync('/bin/sh', ['-c', hook.command], {
      cwd: project, input: payload, encoding: 'utf8', timeout: hook.timeout * 1000, env: offline,
    });
    const elapsed = Date.now() - started;
    t.diagnostic(`Stop ${hook.command} -> exit ${run.status} in ${elapsed} ms (budget ${hook.timeout} s); `
      + `stdout ${JSON.stringify(String(run.stdout).trim().slice(0, 160))}; stderr ${JSON.stringify(String(run.stderr).trim().slice(-160))}`);
    assert.equal(run.signal, null, `Stop hook exceeded its ${hook.timeout} s budget: ${hook.command}`);
    assert.equal(run.status, 0, `Stop hook failed: ${hook.command}\n${run.stdout}\n${run.stderr}`);
    assert.ok(elapsed < hook.timeout * 1000, `Stop hook took ${elapsed} ms of a ${hook.timeout} s budget`);
  }
});
