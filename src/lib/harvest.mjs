// harvest — the OPT-IN, FOREGROUND learning-WRITE path, through Ruflo's own verbs.
//
// ak facilitates what Ruflo does; it does not run a parallel copy. Harvest
// therefore drives only Ruflo's CLI, from the project memory root and with the
// project memory pin — the same launch contract every host uses — so a run from a
// subdirectory never creates stores in that subdirectory:
//   1. `ruflo hooks post-task --task-id <id> --success true` — records the task
//      outcome; Ruflo's hooks write their own memory store.
//   2. opt-in (`--distill`): `ruflo memory distill run --db <root>/.swarm/memory.db`
//      — Ruflo's memory distillation (its ADR-174): entries → episodes, reasoning
//      patterns and causal edges. The daemon's consolidate worker runs the same
//      pass on a schedule; this runs it once, now, in the foreground.
//
// It used to run `agentdb skill consolidate` through a standalone global agentdb
// CLI. That step read only `AGENTDB_PATH` or `./agentdb.db` — a store no Ruflo
// writer uses, so it consolidated nothing — and its install looped on every sync
// (#237 §3). It was retired with the standalone install (decision A in
// docs/audits/2026-09-26-issues-237-238-239-verification-and-decisions.md).
//
// NEVER starts a daemon, NEVER backgrounds anything. `runner` is injectable so
// `ak x verify harvest` can drive it against an isolated temporary store.
import { run } from './exec.mjs';
import * as paths from './paths.mjs';
import { memoryProjectRoot, projectMemoryEnv } from './ruflo-memory.mjs';

const DEFAULT_TASK_ID = 'ak-harvest';

// ANSI SGR stripper. The ESC byte is built via fromCharCode (not a literal
// control char in a regex) so this stays clean under eslint no-control-regex.
const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');
const stripAnsi = (s) => String(s == null ? '' : s).replace(ANSI, '');

const failTail = (r) =>
  `FAILED (${stripAnsi(r.stderr || `exit ${r.code}`).trim().split('\n').slice(-2).join(' ').slice(0, 200)})`;

/** Ruflo's distill command reports a no-op pass as `skipped: <reason>` and
 *  exits 0 (commands/memory-distill.js). Surface the reason, never "done". */
export function distillSkipReason(out) {
  const m = stripAnsi(out).match(/skipped:\s*(.+)/i);
  return m ? m[1].trim().slice(0, 200) : null;
}

/** The ordered write steps, all Ruflo verbs. Each: { name, cmd, args, desc, timeout }. */
export function planHarvest({ cwd = process.cwd(), distill = false, taskId = DEFAULT_TASK_ID } = {}) {
  const root = memoryProjectRoot(cwd);
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
      args: ['memory', 'distill', 'run', '--db', paths.projectMemoryDb(root)],
      desc: "run Ruflo's memory distillation on the project store",
      timeout: 600_000,
    });
  }
  return steps;
}

/**
 * Execute the harvest from the project memory root. With dryRun:true it runs
 * NOTHING and returns the planned steps. `env` is merged under the project
 * memory pin (verify uses it to isolate every store in a temporary directory).
 * Returns { ok, dryRun, root, steps:[{name, ok, skipped, detail}] }.
 * @param {{ runner?: Function, cwd?: string, dryRun?: boolean, distill?: boolean,
 *           env?: Record<string, string>, taskId?: string }} [o]
 */
export async function runHarvest({
  runner = run, cwd = process.cwd(), dryRun = false, distill = false, env = {}, taskId,
} = {}) {
  const root = memoryProjectRoot(cwd);
  const steps = planHarvest({ cwd: root, distill, ...(taskId ? { taskId } : {}) });

  if (dryRun) {
    return {
      ok: true, dryRun: true, root,
      steps: steps.map((s) => ({
        name: s.name, ok: true, skipped: false, detail: `would run: ${s.cmd} ${s.args.join(' ')}`,
      })),
    };
  }

  const runEnv = projectMemoryEnv(root, env);
  const results = [];
  for (const step of steps) {
    const r = await runner(step.cmd, step.args, { timeout: step.timeout, cwd: root, env: runEnv });
    const okStep = r.code === 0;
    const skip = okStep && step.name === 'distill-memory'
      ? distillSkipReason(`${r.stdout || ''}\n${r.stderr || ''}`) : null;
    const detail = !okStep ? failTail(r)
      : skip ? `Ruflo skipped distillation: ${skip}` : step.desc;
    results.push({ name: step.name, ok: okStep, skipped: !!skip, detail });
  }
  return { ok: results.every((s) => s.ok), dryRun: false, root, steps: results };
}
