// Opt-in conformance for agentic-qe#655 (constraint
// agentic-qe-3.14.0-codex-guidance-policy). It runs ak's own path: a full
// `aqe init --auto --with-codex --codex-guidance <mode>` through the `aqe`
// command (src/lib/aqe-guidance.mjs, src/commands/setup.mjs), for full, compact
// and none, in disposable projects that already hold a user AGENTS.md. Each mode
// must select its guidance on its own, keep the user's text byte for byte outside
// AQE's sentinel, be idempotent over two runs, report the owned bytes it wrote in
// its --json receipt, and pass `aqe platform verify codex --codex-guidance <mode>`.
//
// On agentic-qe 3.14.4 it fails (2026-09-27, Branch 5 report b5-655-conformance),
// so every mode is a todo naming the defects: the run reports them without
// failing. Once a release fixes them, run it strictly to prove the sunset:
//
//   AK_AQE_CONFORMANCE=1 [AK_AQE_CONFORMANCE_STRICT=1] \
//     node --test tests/live/aqe-codex-guidance-conformance.test.mjs
//
// Sandbox (the full init runs `npm install -g vibium`, AQE/dist/init/phases/
// 09-assets.js): HOME, TMPDIR, the npm prefix and cache, and mise's data, state and
// cache folders all lie in the test's own temporary folder; the browser download
// is skipped; aqe and node are called by absolute path.
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
const KNOWN_DEFECTS = 'agentic-qe 3.14.4 (upstream issue drafted, not yet filed): --codex-guidance full writes no block when AGENTS.md '
  + 'already exists; compact adds bytes outside its sentinel; through the aqe command resolvePackageRoot() misses the package, so '
  + 'no Codex hooks or skills install and platform verify fails; platform verify exits 0 on failed checks';
const BEGIN = '<!-- BEGIN AGENTIC-QE CODEX -->';
const BLOCK = /<!-- BEGIN AGENTIC-QE CODEX -->[\s\S]*?<!-- END AGENTIC-QE CODEX -->(?:\r?\n)?/g;
const USER_TEXT = '# Project notes\n\nUser-owned line that AQE must keep.\n';

/** The absolute path of `bin` on PATH, not resolved: ak runs AQE through its `aqe`
 *  symlink, and AQE's Codex installer behaves differently when started as
 *  `node dist/cli/bundle.js`, so the link itself must run. */
function which(bin) {
  const found = spawnSync('/bin/sh', ['-c', `command -v ${bin}`], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  return found.status === 0 ? path.resolve(found.stdout.trim()) : null;
}

/** sha256 of AGENTS.md and every file under .codex and .agents. */
function manifest(project) {
  const out = {};
  const add = (file) => { out[path.relative(project, file)] = createHash('sha256').update(fs.readFileSync(file)).digest('hex'); };
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full); else if (entry.isFile()) add(full);
    }
  };
  if (fs.existsSync(path.join(project, 'AGENTS.md'))) add(path.join(project, 'AGENTS.md'));
  walk(path.join(project, '.codex'));
  walk(path.join(project, '.agents'));
  return out;
}

/** The last JSON object AQE printed (its --json receipt), or null. */
function receiptOf(stdout) {
  const lines = String(stdout).split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!lines[i].startsWith('{')) continue;
    try { return JSON.parse(lines.slice(i).join('\n')); } catch { /* an earlier line may start it */ }
  }
  return null;
}

for (const mode of ['full', 'compact', 'none']) {
  test(`Agentic-QE selects ${mode} Codex guidance on ak's path, keeps user text, is idempotent and verifies`, {
    skip: ENABLED ? false : 'set AK_AQE_CONFORMANCE=1 to run the live AQE Codex guidance conformance',
    todo: STRICT ? false : KNOWN_DEFECTS,
    timeout: 900_000,
  }, (t) => {
    if (process.platform === 'win32') { t.skip('POSIX conformance'); return; }
    const aqe = which(AQE_BIN);
    assert.ok(aqe, `${AQE_BIN} not on PATH`);
    const binDir = path.dirname(process.execPath);
    const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `ak-aqe-655-${mode}-`)));
    t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
    const project = path.join(temp, 'project');
    const home = path.join(temp, 'home');
    fs.mkdirSync(path.join(project, '.git'), { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(project, 'package.json'), `{"name":"ak-aqe-655-${mode}","version":"1.0.0"}\n`);
    fs.writeFileSync(path.join(project, 'AGENTS.md'), USER_TEXT);
    const env = {
      PATH: [binDir, '/usr/bin', '/bin'].join(path.delimiter), HOME: home, TMPDIR: temp, TERM: 'dumb', NO_COLOR: '1',
      npm_config_prefix: path.join(temp, 'npm-global'), npm_config_cache: path.join(temp, 'npm-cache'),
      MISE_DATA_DIR: path.join(temp, 'mise-data'), MISE_STATE_DIR: path.join(temp, 'mise-state'), MISE_CACHE_DIR: path.join(temp, 'mise-cache'),
      VIBIUM_SKIP_BROWSER_DOWNLOAD: '1',
    };
    const version = spawnSync(aqe, ['--version'], { encoding: 'utf8', env });
    t.diagnostic(`agentic-qe ${String(version.stdout).trim()} (${aqe})`);
    const init = (extra = []) => spawnSync(aqe, ['init', '--auto', '--with-codex', '--codex-guidance', mode, ...extra], {
      cwd: project, encoding: 'utf8', timeout: 600_000, env,
    });

    const first = init();
    assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
    const after1 = manifest(project);
    const second = init();
    assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);
    assert.deepEqual(manifest(project), after1, 'a second init changed AGENTS.md, .codex or .agents');

    const agents = fs.readFileSync(path.join(project, 'AGENTS.md'), 'utf8');
    const blocks = agents.match(BLOCK) ?? [];
    t.diagnostic(`AGENTS.md ${Buffer.byteLength(agents)} bytes, ${blocks.length} AQE block(s)`);
    assert.equal(agents.replace(BLOCK, ''), USER_TEXT, 'text outside AQE\'s sentinel is exactly the user\'s');
    assert.equal(blocks.length, mode === 'none' ? 0 : 1, `${mode} selected its own guidance block`);
    if (mode !== 'none') assert.ok(blocks[0].startsWith(BEGIN));

    const third = init(['--json']);
    assert.equal(third.status, 0, `${third.stdout}\n${third.stderr}`);
    assert.deepEqual(manifest(project), after1, 'the --json run changed the Codex surfaces');
    const receipt = receiptOf(third.stdout);
    assert.ok(receipt, `no --json receipt in: ${String(third.stdout).slice(-400)}`);
    const owned = blocks.reduce((sum, block) => sum + Buffer.byteLength(block), 0);
    // AQE/dist/init/orchestrator.js:160 reports it under summary.codexGuidance.
    const guidance = receipt.summary?.codexGuidance;
    const shown = String(JSON.stringify(guidance ?? receipt.summary ?? receipt)).slice(0, 400);
    assert.equal(guidance?.policy, mode, `receipt: ${shown}`);
    assert.equal(guidance?.ownedBytes, owned, `receipt ${shown} vs measured ${owned}`);

    const verify = spawnSync(aqe, ['platform', 'verify', 'codex', '--codex-guidance', mode], { cwd: project, encoding: 'utf8', timeout: 120_000, env });
    const fails = String(verify.stdout).split('\n').filter((line) => /\[fail\]/i.test(line)).map((line) => line.trim());
    t.diagnostic(`platform verify exit ${verify.status}; ${fails.length} failed check(s)`);
    assert.deepEqual(fails, [], 'aqe platform verify codex reports failed checks');
    assert.equal(verify.status, 0, String(verify.stderr));
    for (const file of ['.codex/hooks.json', ...['aqe-plan-quality', 'aqe-plan-work', 'aqe-research', 'aqe-review-quality', 'aqe-test-change'].map((s) => `.agents/skills/${s}`)]) {
      assert.ok(fs.existsSync(path.join(project, file)), `${file} was not installed`);
    }
  });
}
