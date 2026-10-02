// harvest — the OPT-IN, FOREGROUND learning-WRITE path, through Ruflo's own verbs.
//
// ak facilitates what Ruflo does; it does not run a parallel copy. Harvest
// therefore drives only Ruflo's CLI, from the store ak's launcher picks for the
// folder (the repository root; outside any project, the one user-level store)
// and with that store's memory pin — the same launch contract every host uses —
// so a run from a subdirectory never creates stores in that subdirectory:
//   1. `ruflo hooks post-task --task-id <id> --success true` — records the task
//      outcome; Ruflo's hooks write their own memory store.
//   2. opt-in (`--distill`): `ruflo memory distill run --db <store>/memory.db`
//      — Ruflo's memory distillation (its ADR-174): entries → episodes, reasoning
//      patterns and causal edges. The daemon's consolidate worker runs the same
//      pass on a schedule; this runs it once, now, in the foreground.
//
// It used to run `agentdb skill consolidate` through a standalone global agentdb
// CLI. That step read only `AGENTDB_PATH` or `./agentdb.db` — a store no Ruflo
// writer uses, so it consolidated nothing — and its install looped on every sync
// (#237 §3). It was retired with the standalone install (decision A in
// docs/archive/2026-09-26-plan-issues-237-238-239-verification-and-decisions.md).
//
// NEVER starts a daemon, NEVER backgrounds anything. `runner` is injectable so
// `ak status --refresh=live --only harvest` can drive it against an isolated
// temporary store.
import fs from 'node:fs';
import path from 'node:path';
import { run } from './exec.mjs';
import * as paths from './paths.mjs';
import { rufloMemoryLocation } from './ruflo-memory.mjs';

const DEFAULT_TASK_ID = 'ak-harvest';

/** Where harvest runs and which store it pins: the store ak's launcher uses
 *  from `cwd` (rufloMemoryLocation: the repository, else the folder, else the
 *  one flat user-level store, B3-D1). An explicit `root` (a live check's
 *  isolated store) is a project root: `<root>/.swarm/memory.db`. */
function harvestLocation(cwd, root) {
  if (root) return { kind: 'project', root, dir: path.join(root, '.swarm'), db: paths.projectMemoryDb(root) };
  return rufloMemoryLocation(cwd);
}

/** The memory pin for a location: the user-level store has no project root to
 *  derive agentdb-memory.db from, so its memory root is pinned as well. */
const memoryPin = (location) => (location.kind === 'user'
  ? { CLAUDE_FLOW_MEMORY_PATH: location.dir, CLAUDE_FLOW_DB_PATH: location.db }
  : { CLAUDE_FLOW_DB_PATH: location.db });

// ANSI SGR stripper. The ESC byte is built via fromCharCode (not a literal
// control char in a regex) so this stays clean under eslint no-control-regex.
const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');
const stripAnsi = (s) => String(s == null ? '' : s).replace(ANSI, '');

const failTail = (r) =>
  `FAILED (${stripAnsi(r.stderr || `exit ${r.code}`).trim().split('\n').slice(-2).join(' ').slice(0, 200)})`;

/** Ruflo's distill command reports every skipped pass as a `skipped: <reason>`
 *  line and exits 0 (commands/memory-distill.js). Surface the reason, never
 *  "done". Only a line that starts with it counts: a result list can hold
 *  a "skipped: <n>" entry of its own. */
export function distillSkipReason(out) {
  const m = stripAnsi(out).match(/^skipped:\s*(.+)$/im);
  return m ? m[1].trim().slice(0, 200) : null;
}

// The skip reasons that mean "nothing to distill yet" (@claude-flow/cli 3.45.0
// services/memory-distillation.js): no store, no entries, or AgentDB's target
// tables not created yet. Every fresh store takes the last path, including
// `ak status --refresh=live --only harvest`'s isolated one, so it stays a
// warning. Any other
// reason (an exception, a corrupt store, no native SQLite, a judge this run
// did not enable) means distillation could not run.
const NOTHING_TO_DISTILL = [/^no-db$/, /^no memory_entries$/, /^target table \S+ missing\b/];

/** Whether a distill skip reason means Ruflo could not run the pass. */
export function distillSkipFailed(reason) {
  return !NOTHING_TO_DISTILL.some((re) => re.test(reason));
}

/** The ordered write steps, all Ruflo verbs. Each: { name, cmd, args, desc, timeout }.
 *  `root` overrides the project memory root derived from `cwd` (verify's
 *  isolated store, which must never resolve to an enclosing repository). */
export function planHarvest({ cwd = process.cwd(), root = undefined, distill = false, taskId = DEFAULT_TASK_ID } = {}) {
  const location = harvestLocation(cwd, root);
  const steps = [{
    name: 'record-outcome',
    cmd: 'ruflo',
    args: ['hooks', 'post-task', '--task-id', String(taskId), '--success', 'true'],
    desc: "record the task outcome through Ruflo's hooks",
    timeout: 120_000,
  }];
  if (distill) {
    steps.push({
      name: 'distill-memory',
      cmd: 'ruflo',
      args: ['memory', 'distill', 'run', '--db', location.db],
      desc: `run Ruflo's memory distillation on the ${location.kind === 'user' ? 'user-level' : 'project'} store`,
      timeout: 600_000,
    });
  }
  return steps;
}

/**
 * Execute the harvest from the project memory root. With dryRun:true it runs
 * NOTHING and returns the planned steps. `env` is merged under the project
 * memory pin, and `root` overrides the root derived from `cwd` (verify passes
 * both to isolate every store in a temporary directory).
 * Returns { ok, dryRun, root, steps:[{name, ok, skipped, detail}] }.
 * @param {{ runner?: Function, cwd?: string, root?: string, dryRun?: boolean, distill?: boolean,
 *           env?: Record<string, string>, taskId?: string }} [o]
 */
export async function runHarvest({
  runner = run, cwd = process.cwd(), root = undefined, dryRun = false, distill = false, env = {}, taskId,
} = {}) {
  const location = harvestLocation(cwd, root);
  const steps = planHarvest({ cwd, root, distill, ...(taskId ? { taskId } : {}) });

  if (dryRun) {
    return {
      ok: true, dryRun: true, root: location.root,
      steps: steps.map((s) => ({
        name: s.name, ok: true, skipped: false, detail: `would run: ${s.cmd} ${s.args.join(' ')}`,
      })),
    };
  }

  const runEnv = { ...env, ...memoryPin(location) };
  if (location.kind === 'user') {
    try { fs.mkdirSync(location.root, { recursive: true }); } catch { /* the runner reports a missing cwd */ }
  }
  const results = [];
  for (const step of steps) {
    const r = await runner(step.cmd, step.args, { timeout: step.timeout, cwd: location.root, env: runEnv });
    const exited = r.code === 0;
    const skip = exited && step.name === 'distill-memory'
      ? distillSkipReason(`${r.stdout || ''}\n${r.stderr || ''}`) : null;
    const couldNotRun = !!skip && distillSkipFailed(skip);
    const detail = !exited ? failTail(r)
      : couldNotRun ? `FAILED (Ruflo could not distill: ${skip})`
        : skip ? `Ruflo skipped distillation: ${skip}` : step.desc;
    results.push({ name: step.name, ok: exited && !couldNotRun, skipped: !!skip && !couldNotRun, detail });
  }
  return { ok: results.every((s) => s.ok), dryRun: false, root: location.root, steps: results };
}
