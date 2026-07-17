// harvest — the OPT-IN, FOREGROUND, budget-gated learning-WRITE path.
//
// Where `sync`/heal.mjs converge *installs*, harvest converges *learning*: it
// records the session's outcome into ruflo's SONA store and consolidates
// accumulated episodes into durable skills, then reports the REAL data the
// tools hand back. It drives ONLY grounded, present CLIs (verified live against
// the installed binaries — not a doc, not a mock):
//   1. `ruflo hooks post-task --task-id <id> --success true`  — record a SONA
//      trajectory/outcome (ruflo's real signature; -q/--quality also exists).
//   2. `agentdb skill consolidate <minAttempts> <minReward> <days> true`  —
//      promote qualifying episodes into skills. Real output looks like:
//        "✅ Created 1 new skills, updated 0 existing skills in 11ms"
//      We PARSE that into { created, updated, avgReward } — the harvested value.
//
// agentdb is a managed-but-optional dependency (see agentdb.mjs). If it isn't
// installed, its step is SKIPPED with an honest note (never faked) and the user
// is pointed at `ak sync` to install it.
//
// NEVER starts a daemon, NEVER backgrounds anything. `runner` is injectable so
// `ak x verify harvest` can drive it against a sandbox cwd — the parsers below
// are pure and are unit-tested against REAL captured tool output, no stubs.
import { run } from './exec.mjs';
import { present as adbPresent } from './agentdb.mjs';

// Conservative defaults. agentdb's own consolidate default is (3, 0.7, 7); we
// match it so harvest promotes only well-evidenced episodes.
const DEFAULTS = { taskId: 'ak-harvest', minAttempts: 3, minReward: 0.7, days: 7 };

// ANSI SGR stripper. The ESC byte is built via fromCharCode (not a literal
// control char in a regex) so this stays clean under eslint no-control-regex.
const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');
const stripAnsi = (s) => String(s == null ? '' : s).replace(ANSI, '');

const failTail = (r) =>
  `FAILED (${(r.stderr || `exit ${r.code}`).trim().split('\n').slice(-2).join(' ').slice(0, 200)})`;

/** Pure parser over the REAL `agentdb skill consolidate` output. Returns the
 *  harvested counts + avg reward, or nulls when the line is absent. */
export function parseConsolidate(out) {
  const s = stripAnsi(out);
  const m = s.match(/Created\s+(\d+)\s+new\s+skills?,\s*updated\s+(\d+)\s+existing\s+skills?/i);
  const avg = s.match(/Avg Reward:\s*([\d.]+)/i);
  return {
    created: m ? Number(m[1]) : null,
    updated: m ? Number(m[2]) : null,
    avgReward: avg ? Number(avg[1]) : null,
    noEpisodes: /No episodes met the criteria/i.test(s),
  };
}

/** Pure parser over `agentdb reflexion store` — the seeding acknowledgement. */
export function parseStored(out) {
  const m = stripAnsi(out).match(/Stored episode #(\d+)/i);
  return { episode: m ? Number(m[1]) : null };
}

/** The ordered write steps. Each: { name, tool, cmd, args, desc, parse }.
 *  `tool:'agentdb'` steps are skipped when agentdb is absent. Pure. */
export function planHarvest(opts = {}) {
  const { taskId, minAttempts, minReward, days } = { ...DEFAULTS, ...opts };
  return [
    {
      name: 'record-outcome',
      tool: 'ruflo',
      cmd: 'ruflo',
      args: ['hooks', 'post-task', '--task-id', String(taskId), '--success', 'true'],
      desc: 'record a SONA trajectory/outcome for this task',
      parse: null,
    },
    {
      name: 'consolidate-skills',
      tool: 'agentdb',
      cmd: 'agentdb',
      args: ['skill', 'consolidate', String(minAttempts), String(minReward), String(days), 'true'],
      desc: 'consolidate qualifying episodes into durable skills',
      parse: 'consolidate',
    },
  ];
}

/**
 * Execute the harvest, capturing and parsing the tools' REAL output.
 * Foreground only — never spawns a daemon. With dryRun:true it runs NOTHING and
 * returns the planned steps. Returns:
 *   { ok, dryRun, agentdb, steps:[{name,ok,skipped,evidence,detail}], harvested }
 * where harvested = { skillsCreated, skillsUpdated, avgReward } aggregated from
 * the parsed consolidate output.
 * @param {{ runner?: Function, cwd?: string, dryRun?: boolean, taskId?: string,
 *           minAttempts?: number, minReward?: number, days?: number }} [o]
 */
export async function runHarvest({ runner = run, cwd = process.cwd(), dryRun = false, ...opts } = {}) {
  const steps = planHarvest(opts);
  const haveAdb = adbPresent();

  if (dryRun) {
    return {
      ok: true, dryRun: true, agentdb: haveAdb, harvested: null,
      steps: steps.map((s) => ({
        name: s.name, ok: true, skipped: s.tool === 'agentdb' && !haveAdb,
        detail: (s.tool === 'agentdb' && !haveAdb)
          ? 'would SKIP — agentdb not installed (ak sync installs it)'
          : `would run: ${s.cmd} ${s.args.join(' ')}`,
      })),
    };
  }

  const results = [];
  const harvested = { skillsCreated: 0, skillsUpdated: 0, avgReward: null };
  for (const step of steps) {
    if (step.tool === 'agentdb' && !haveAdb) {
      results.push({ name: step.name, ok: true, skipped: true, evidence: null,
        detail: 'agentdb not installed — skipped (run `ak sync` to install its CLI)' });
      continue;
    }
    const r = await runner(step.cmd, step.args, { timeout: 120_000, cwd });
    const okStep = r.code === 0;
    let evidence = null;
    let detail;
    if (okStep && step.parse === 'consolidate') {
      evidence = parseConsolidate(`${r.stdout || ''}\n${r.stderr || ''}`);
      if (evidence.created != null) {
        harvested.skillsCreated += evidence.created;
        harvested.skillsUpdated += evidence.updated || 0;
        if (evidence.avgReward != null) harvested.avgReward = evidence.avgReward;
      }
      detail = evidence.noEpisodes
        ? 'no episodes qualified yet (nothing to consolidate)'
        : `created ${evidence.created ?? '?'} skill(s), updated ${evidence.updated ?? '?'}` +
          (evidence.avgReward != null ? ` · avg reward ${evidence.avgReward}` : '');
    } else {
      detail = okStep ? step.desc : failTail(r);
    }
    results.push({ name: step.name, ok: okStep, skipped: false, evidence, detail });
  }

  const ran = results.filter((s) => !s.skipped);
  return { ok: ran.every((s) => s.ok), dryRun: false, agentdb: haveAdb, steps: results, harvested };
}
