// x harvest — opt-in, FOREGROUND learning-WRITE through Ruflo's own verbs.
//
// DEFAULT-SAFE: does NOTHING that writes unless the kit.json opt-in flag
// (`harvest: true`) is set. Off by default it explains how to enable and exits 0.
// --dry-run prints the plan and exits 0 (writes nothing) regardless of opt-in.
// Only opt-in ON + no --dry-run executes, in the foreground, from the project
// memory root. It NEVER starts a daemon and NEVER backgrounds anything.
import { loadKitConfig } from '../../lib/config.mjs';
import { planHarvest, runHarvest } from '../../lib/harvest.mjs';
import { ok, fail, warn, info, dim, heading, reportFailure } from '../../lib/output.mjs';

export const options = {
  'dry-run': { type: 'boolean', default: false },
  distill: { type: 'boolean', default: false },
  json: { type: 'boolean', default: false },
};

export const help = `ak x harvest — opt-in, foreground learning-WRITE (no daemon, ever)

Records this session's outcome through Ruflo's own hooks, and on request runs
Ruflo's memory distillation once. Every step is a Ruflo command run from the
project root with the project memory pin, so running it from a subdirectory
writes the project's stores, never new ones beside you.

Steps, foreground and in order:
  1. ruflo hooks post-task --task-id ak-harvest --success true
  2. with --distill: ruflo memory distill run --db <project>/.swarm/memory.db
     (the same pass Ruflo's daemon schedules; reports a skipped pass as skipped)

OPT-IN + SAFE BY DEFAULT: it writes to your learning stores, so it is OFF
until you enable it. With opt-in off it only explains how to turn it on.

Usage: ak x harvest [options]

Options:
  --dry-run   print the plan and exit — writes nothing (works with opt-in off)
  --distill   also run Ruflo's memory distillation on the project store
  --json      emit the plan/result as JSON

Enable it:
  set "harvest": true in ~/.config/agentic-kit/kit.json, then re-run

Examples:
  ak x harvest --dry-run             preview the steps (no writes)
  ak x harvest                       record the outcome (only when opted in)
  ak x harvest --distill             record, then distill the project store`;

export async function run({ flags, positionals = [] }) {
  if (positionals.length) {
    const error = `unexpected argument '${positionals[0]}'`;
    reportFailure({ json: flags.json, payload: { error, exitCode: 2 }, human: () => warn(error) });
    return 2;
  }
  const cwd = process.cwd();
  const cfg = loadKitConfig();
  const enabled = cfg.harvest === true;
  const distill = flags.distill === true;

  // --dry-run: show the plan, run nothing — regardless of opt-in state.
  if (flags['dry-run']) {
    const steps = planHarvest({ cwd, distill });
    if (flags.json) {
      console.log(JSON.stringify({ dryRun: true, optIn: enabled, steps }, null, 2));
      return 0;
    }
    heading('ak x harvest — plan (dry-run · nothing runs)');
    for (const s of steps) info(`${s.name}: ${s.cmd} ${s.args.join(' ')} ${dim('— ' + s.desc)}`);
    if (!enabled) info('opt-in is OFF — set "harvest": true in kit.json to actually run this.');
    return 0;
  }

  // Default-safe gate: opt-in OFF → explain, write nothing.
  if (!enabled) {
    if (flags.json) {
      console.log(JSON.stringify({ ranWrites: false, optIn: false }, null, 2));
      return 0;
    }
    info('ak x harvest is opt-in — it WRITES to your learning stores and is OFF by default.');
    info('Enable it: set "harvest": true in ~/.config/agentic-kit/kit.json, then re-run.');
    info('Preview it now without writing: ak x harvest --dry-run');
    return 0;
  }

  // Opted in, no --dry-run: execute foreground.
  const res = await runHarvest({ cwd, distill });
  if (flags.json) {
    console.log(JSON.stringify(res, null, 2));
    return res.ok ? 0 : 1;
  }
  heading('ak x harvest — learning write (foreground)');
  for (const s of res.steps) {
    if (s.skipped) warn(`${s.name}: ${s.detail}`);
    else (s.ok ? ok : fail)(`${s.name}: ${s.detail}`);
  }
  if (!distill) info('distillation not requested — add --distill to run it now.');
  return res.ok ? 0 : 1;
}
