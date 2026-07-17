// x harvest — opt-in, FOREGROUND, budget-gated learning-WRITE.
//
// DEFAULT-SAFE: does NOTHING that writes unless the kit.json opt-in flag
// (`harvest: true`) is set. Off by default it explains how to enable and exits 0.
// --dry-run prints the plan and exits 0 (writes nothing) regardless of opt-in.
// Only opt-in ON + no --dry-run executes the two grounded verbs, in the
// foreground. It NEVER starts a daemon and NEVER backgrounds anything.
import { loadKitConfig } from '../../lib/config.mjs';
import { planHarvest, runHarvest } from '../../lib/harvest.mjs';
import { ok, fail, warn, info, dim, heading } from '../../lib/output.mjs';

export const options = {
  'dry-run': { type: 'boolean', default: false },
  json: { type: 'boolean', default: false },
};

export const help = `ak x harvest — opt-in, foreground learning-WRITE (no daemon, ever)

Records this session's outcome into ruflo's SONA store and consolidates
accumulated episodes into durable skills, then reports the REAL data the tools
hand back (skills created/updated, avg reward).

It drives ONLY grounded, present CLIs, foreground and in order:
  1. ruflo hooks post-task --task-id <id> --success true
  2. agentdb skill consolidate <minAttempts> <minReward> <days> true
     (skipped with a note if agentdb isn't installed — run \`ak sync\`)

OPT-IN + SAFE BY DEFAULT: it writes to your learning stores, so it is OFF
until you enable it. With opt-in off it only explains how to turn it on.

Usage: ak x harvest [options]

Options:
  --dry-run   print the plan and exit — writes nothing (works with opt-in off)
  --json      emit the plan/result as JSON

Enable it:
  set "harvest": true in ~/.config/agentic-kit/kit.json, then re-run

Examples:
  ak x harvest --dry-run    preview the two verbs (no writes)
  ak x harvest              run the write path (only when opted in)`;

export async function run({ flags }) {
  const cwd = process.cwd();
  const cfg = loadKitConfig();
  const enabled = cfg.harvest === true;

  // --dry-run: show the plan, run nothing — regardless of opt-in state.
  if (flags['dry-run']) {
    const steps = planHarvest();
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
  const res = await runHarvest({ cwd });
  if (flags.json) {
    console.log(JSON.stringify(res, null, 2));
    return res.ok ? 0 : 1;
  }
  heading('ak x harvest — learning write (foreground)');
  for (const s of res.steps) {
    if (s.skipped) warn(`${s.name}: ${s.detail}`);
    else (s.ok ? ok : fail)(`${s.name}: ${s.detail}`);
  }
  const h = res.harvested;
  if (h && (h.skillsCreated || h.skillsUpdated)) {
    info(`harvested: ${h.skillsCreated} skill(s) created, ${h.skillsUpdated} updated` +
      (h.avgReward != null ? ` · avg reward ${h.avgReward}` : ''));
  } else if (!res.agentdb) {
    warn('no skills consolidated — agentdb CLI absent; run `ak sync` to install it, then re-harvest.');
  } else {
    info('no new skills this pass (no episodes cleared the thresholds yet).');
  }
  return res.ok ? 0 : 1;
}
