// `ak x provider status` is read-only (detect + report), so — unlike `pick`,
// which can trigger real installs/network calls — it's safe to exercise via a
// real CLI spawn. HOME/XDG_CONFIG_HOME (POSIX) and USERPROFILE/APPDATA
// (Windows) are all pointed at a throwaway sandbox so this never touches the
// real machine's kit.json or ~/.claude — src/lib/paths.mjs's configBase()
// reads APPDATA (not XDG_CONFIG_HOME) on win32, so both must be set or the
// sandbox is silently bypassed there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DUAL_ROLE_TIP, JUDGE_BIAS_TIP } from '../../src/lib/providers.mjs';

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../bin/agentic-kit.mjs');

function sandbox({ hosts }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-prov-cli-home-'));
  const cfgDir = path.join(home, '.config', 'agentic-kit');
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(path.join(cfgDir, 'kit.json'), JSON.stringify({ providers: { hosts } }));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-prov-cli-proj-'));
  fs.mkdirSync(path.join(project, '.git'));
  return { home, project };
}

function rm(...dirs) {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
}

function ak(args, { cwd, home }) {
  const cfgDir = path.join(home, '.config');
  return spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    cwd,
    env: {
      ...process.env,
      NO_COLOR: '1',
      HOME: home,
      USERPROFILE: home, // Windows os.homedir() reads USERPROFILE, not HOME
      XDG_CONFIG_HOME: cfgDir,
      APPDATA: cfgDir, // Windows configBase() reads APPDATA, not XDG_CONFIG_HOME
    },
  });
}

test('ak x provider status prints the dual-host guidance tips once both hosts are enabled', () => {
  const { home, project } = sandbox({ hosts: { claude: true, codex: true } });
  const r = ak(['x', 'provider', 'status'], { cwd: project, home });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes(DUAL_ROLE_TIP), 'dual-role tip printed');
  assert.ok(r.stdout.includes(JUDGE_BIAS_TIP), 'judge-bias tip printed');
  rm(home, project);
});

test('ak x provider status omits the dual-host guidance tips with only one host enabled', () => {
  const { home, project } = sandbox({ hosts: { claude: true, codex: false } });
  const r = ak(['x', 'provider', 'status'], { cwd: project, home });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.stdout.includes(DUAL_ROLE_TIP), 'dual-role tip withheld');
  assert.ok(!r.stdout.includes(JUDGE_BIAS_TIP), 'judge-bias tip withheld');
  rm(home, project);
});
