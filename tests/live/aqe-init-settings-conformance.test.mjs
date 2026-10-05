// Opt-in conformance for agentic-qe#778 ("fix: repeated aqe init changes
// generated settings on an unchanged project"). It runs ak's own default,
// non-Codex init path (src/lib/aqe-guidance.mjs aqeInitArguments: `aqe init
// --auto`) three times with identical options on one unchanged disposable
// project and requires .claude/settings.json to come out byte- and
// mtime-identical after the first run, with no backup file left behind.
//
// On agentic-qe 3.14.4 and 3.14.5 this fails (2026-09-29, receipt
// docs/archive/2026-09-29-aqe-released-artifact-receipt.md): run 2 rewrites
// settings.json (adds a backup, changes domain/learning defaults) and run 3
// still changes `aqe.initialized`, so every run is a todo naming the defect.
// Once a release fixes it, run it strictly to prove the sunset:
//
//   AK_AQE_CONFORMANCE=1 [AK_AQE_CONFORMANCE_STRICT=1] \
//     node --test tests/live/aqe-init-settings-conformance.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const ENABLED = process.env.AK_AQE_CONFORMANCE === '1';
const STRICT = process.env.AK_AQE_CONFORMANCE_STRICT === '1';
const AQE_BIN = process.env.AQE_BIN ?? 'aqe';
const KNOWN_DEFECTS = 'agentic-qe 3.14.4 and 3.14.5 (agentic-qe#778): three same-option public `aqe init --auto` '
  + 'calls on an unchanged project each change .claude/settings.json; run 2 also writes a backup and changes '
  + 'domain/learning defaults, and run 3 still changes aqe.initialized';

function which(bin) {
  const found = spawnSync('/bin/sh', ['-c', `command -v ${bin}`], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  return found.status === 0 ? fs.realpathSync(found.stdout.trim()) : null;
}

function sha256(file) { return createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }

test('Agentic-QE leaves .claude/settings.json byte- and mtime-stable across repeated same-option aqe init --auto', {
  skip: ENABLED ? false : 'set AK_AQE_CONFORMANCE=1 to run the live AQE init-settings conformance',
  todo: STRICT ? false : KNOWN_DEFECTS,
  timeout: 600_000,
}, (t) => {
  if (process.platform === 'win32') { t.skip('POSIX conformance'); return; }
  const aqe = which(AQE_BIN);
  assert.ok(aqe, `${AQE_BIN} not on PATH`);
  const binDir = path.dirname(process.execPath);
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ak-aqe-778-')));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const project = path.join(temp, 'project');
  const home = path.join(temp, 'home');
  fs.mkdirSync(path.join(project, '.git'), { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(project, 'package.json'), '{"name":"ak-aqe-778","version":"1.0.0"}\n');
  const env = {
    PATH: [binDir, '/usr/bin', '/bin'].join(path.delimiter), HOME: home, TMPDIR: temp, TERM: 'dumb', NO_COLOR: '1',
    npm_config_prefix: path.join(temp, 'npm-global'), npm_config_cache: path.join(temp, 'npm-cache'),
  };
  const version = spawnSync(aqe, ['--version'], { encoding: 'utf8', env });
  t.diagnostic(`agentic-qe ${String(version.stdout).trim()} (${aqe})`);

  const settingsFile = path.join(project, '.claude', 'settings.json');
  const observations = [];
  for (let run = 1; run <= 3; run += 1) {
    const init = spawnSync(aqe, ['init', '--auto'], { cwd: project, encoding: 'utf8', timeout: 180_000, env });
    assert.equal(init.status, 0, `run ${run}: ${init.stdout}\n${init.stderr}`);
    assert.ok(fs.existsSync(settingsFile), `run ${run}: no .claude/settings.json`);
    observations.push({ run, hash: sha256(settingsFile), mtimeMs: fs.statSync(settingsFile).mtimeMs });
  }
  t.diagnostic(JSON.stringify(observations));
  const [first, ...rest] = observations;
  for (const observation of rest) {
    assert.equal(observation.hash, first.hash, `run ${observation.run} changed .claude/settings.json bytes`);
    assert.equal(observation.mtimeMs, first.mtimeMs, `run ${observation.run} rewrote .claude/settings.json`);
  }

  const claudeEntries = fs.readdirSync(path.join(project, '.claude'));
  const backups = claudeEntries.filter((name) => /backup|\.bak$/i.test(name));
  assert.deepEqual(backups, [], `aqe init left backup entries in .claude: ${backups.join(', ')}`);
});
