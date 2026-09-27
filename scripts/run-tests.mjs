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
      'tests/ui/usage-project-groups.mjs', 'tests/ui/context-coverage.mjs', 'tests/ui/host-readiness.mjs'],
  ],
};

/**
 * @param {string[][]} commands argument vectors for process.execPath
 * @param {{ env?: NodeJS.ProcessEnv, repoRoot?: string, platform?: string, homedir?: string, log?: (s: string) => void }} [o]
 * @returns {number} exit code: the first failing command's, else 3 on a real-state change, else 0
 */
export function runGuarded(commands, {
  env = process.env, repoRoot = REPO, platform = process.platform, homedir = os.homedir(), log = console.error,
} = {}) {
  const roots = realStateRoots({ env, platform, homedir, repoRoot });
  const before = snapshotRoots(roots);
  // One line before anything runs, so a CI log proves the tripwire executed.
  log(`real-state tripwire: watching ${roots.length} roots (${isStrict(env) ? 'strict' : 'developer'})`);
  let code = 0;
  for (const args of commands) {
    const r = spawnSync(process.execPath, args, { cwd: repoRoot, env, stdio: 'inherit' });
    if (r.error) { log(`could not run node ${args.join(' ')}: ${r.error.message}`); code = 1; break; }
    if (r.status !== 0) { code = r.status ?? 1; break; }
  }
  const result = compareSnapshots(before, snapshotRoots(roots), { strict: isStrict(env) });
  const report = formatReport(result);
  if (report) log(report);
  return code || (result.failing.length ? 3 : 0);
}

function main(argv) {
  const [mode] = argv;
  if (mode === 'unit' || mode === 'ui') return runGuarded(SUITES[mode]);
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
