#!/usr/bin/env node
// scripts/run-tests.mjs — runs a test suite between two real-state snapshots.
// `pnpm test` and `pnpm run test:ui` call this. Commands run in order and stop
// at the first failure (the old `&&` chain); the after-snapshot is taken either
// way. No shell: argument vectors for process.execPath, so it behaves the same
// on Windows; `node --test` expands the glob itself.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { realStateRoots, snapshotRoots, compareSnapshots, isStrict, formatReport } from './real-state-tripwire.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COVERAGE = ['--experimental-test-coverage', '--test-coverage-lines=70',
  '--test-coverage-branches=70', '--test-coverage-functions=70'];

export const SUITES = {
  unit: [
    ['--test', ...COVERAGE, 'tests/kit/*.test.mjs'],
    ...['statusline-segments', 'statusline-window-ledger', 'statusline-brain', 'health-history',
      'dashboard', 'admin-model', 'admin'].map((name) => [`tests/${name}.test.cjs`]),
  ],
  ui: [
    ['tests/ui/dashboard-ui.mjs'],
    ['--test', 'tests/ui/dashboard-project-context.mjs', 'tests/ui/maintenance-projects.mjs',
      'tests/ui/maintenance-host-alignment.mjs', 'tests/ui/intelligence-picker.mjs',
      'tests/ui/usage-project-groups.mjs', 'tests/ui/context-coverage.mjs', 'tests/ui/host-readiness.mjs',
      'tests/ui/maintenance-focus.mjs', 'tests/ui/maintenance-guidance.mjs'],
  ],
};

/**
 * Keep local coverage on by default. Only an explicit CI opt-out changes the
 * unit suite's instrumentation; all test commands still run.
 * @param {'unit'|'ui'} mode
 * @param {NodeJS.ProcessEnv} [env]
 */
export function commandsFor(mode, env = process.env) {
  const commands = SUITES[mode];
  if (mode !== 'unit' || env.AK_TEST_COVERAGE !== '0') return commands;
  return [commands[0].filter((arg) => !COVERAGE.includes(arg)), ...commands.slice(1)];
}

/**
 * @param {string[][]} commands argument vectors for process.execPath
 * @param {{ env?: NodeJS.ProcessEnv, repoRoot?: string, platform?: string, homedir?: string, log?: (s: string) => void }} [o]
 * @returns {number} exit code: 2 when the suite temp root sits inside a git repository,
 *   else the first failing command's, else 3 on a real-state change, else 4 on leftover
 *   temp folders, else 0
 */
export function runGuarded(commands, {
  env = process.env, repoRoot = REPO, platform = process.platform, homedir = os.homedir(), log = console.error,
} = {}) {
  // Every command runs with this run's own templated temp root: leftovers are then
  // attributable to the run, and they fail it.
  const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ak-suite-')));
  const enclosing = enclosingRepository(tempRoot);
  if (enclosing) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    log(`the suite temp root ${tempRoot} is inside the git repository ${enclosing}; tests that probe "outside a `
      + 'git repository" would write into it. Point TMPDIR outside any repository.');
    return 2;
  }
  /** @type {NodeJS.ProcessEnv} */
  const childEnv = { ...env, TMPDIR: tempRoot, TEMP: tempRoot, TMP: tempRoot };
  // Tests assert on plain text; a shell's FORCE_COLOR (Claude Code sets 3)
  // colours console.log into pipes and, beside NO_COLOR, adds a Node warning.
  delete childEnv.FORCE_COLOR;
  const roots = realStateRoots({ env, platform, homedir, repoRoot });
  const before = snapshotRoots(roots);
  // One line before anything runs, so a CI log proves the tripwire executed.
  log(`real-state tripwire: watching ${roots.length} roots (${isStrict(env) ? 'strict' : 'developer'})`);
  let code = 0;
  for (const args of commands) {
    const r = spawnSync(process.execPath, args, { cwd: repoRoot, env: childEnv, stdio: 'inherit' });
    if (r.error) { log(`could not run node ${args.join(' ')}: ${r.error.message}`); code = 1; break; }
    if (r.status !== 0) { code = r.status ?? 1; break; }
  }
  const leftovers = fs.readdirSync(tempRoot).filter((name) => name !== 'node-compile-cache');
  fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 3 });
  if (leftovers.length) log(`temp folders left behind by the run (${leftovers.length}):\n  ${leftovers.join('\n  ')}`);
  const result = compareSnapshots(before, snapshotRoots(roots), { strict: isStrict(env) });
  const report = formatReport(result);
  if (report) log(report);
  return code || (result.failing.length ? 3 : 0) || (leftovers.length ? 4 : 0);
}

/** The nearest folder at or above `dir` that holds a `.git` entry, or null. */
function enclosingRepository(dir) {
  for (let cur = dir, i = 0; i < 64; i++) {
    if (fs.existsSync(path.join(cur, '.git'))) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
  return null;
}

function main(argv) {
  const [mode] = argv;
  if (mode === 'unit' || mode === 'ui') return runGuarded(commandsFor(mode));
  if (mode === 'exec') {
    const sep = argv.indexOf('--');
    const repoAt = argv.indexOf('--repo');
    if (sep < 0 || sep === argv.length - 1) { console.error('usage: run-tests.mjs exec [--repo <dir>] -- <node args…>'); return 2; }
    const repoRoot = repoAt >= 0 && repoAt < sep ? path.resolve(argv[repoAt + 1]) : REPO;
    return runGuarded([argv.slice(sep + 1)], { repoRoot });
  }
  console.error('usage: run-tests.mjs unit|ui|exec');
  return 2;
}

// Compare real paths (drive-letter case differs on Windows): a missed match would
// make `pnpm test` exit 0 having run nothing.
const isMain = () => {
  if (!process.argv[1]) return false;
  const a = fs.realpathSync.native(path.resolve(process.argv[1]));
  const b = fs.realpathSync.native(fileURLToPath(import.meta.url));
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
};
if (isMain()) {
  process.exitCode = main(process.argv.slice(2));
}
