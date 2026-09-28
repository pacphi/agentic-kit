// ak status — read-only dashboard. Each row: subsystem, level, message,
// and (for drift) a fix plus who performs it (`repair`: 'sync' or 'manual',
// see status/row.mjs). --json emits the raw rows; --hint (set by bare
// invocation) appends exactly one suggested next action. --refresh[=live|machine]
// runs the shared refresh stages first (ADR-0063) and reports the rows its
// local re-check collected; --only names the live checks to run (ADR-0055).
import { glyph, dim, bold, ok, warn, fail, humanOutputToStderr, sanitizeForTerminal } from '../lib/output.mjs';
import {
  REFRESH_OPTIONS, REFRESH_STRENGTHS, refreshRequestFromFlags, runRefresh, cliRefreshStages, printRefreshStage,
  formatElapsed,
} from '../lib/refresh.mjs';
import { loadRing, detectRegression } from '../lib/health-history.mjs';
import { loadKitConfig } from '../lib/config.mjs';
import { collectIntegrationFacts } from '../lib/providers.mjs';
import { globalRoot } from '../lib/paths.mjs';
import { companionLifecycleFor } from '../lib/adapters/companion-lifecycle-registry.mjs';
import { row } from './status/row.mjs';
import { renderHostDetailRows, admittedLifecycleFallbackRows } from './status/host-detail.mjs';
import { collectDejaVuRows } from './status/deja-vu.mjs';
import { SECTIONS_BEFORE_HOST_DETAIL, SECTIONS_AFTER_HOST_DETAIL } from './status/sections/index.mjs';

export { renderHostDetailRows, collectDejaVuRows };

export const options = {
  json: { type: 'boolean', default: false },
  hint: { type: 'boolean', default: false },
  ...REFRESH_OPTIONS,
};

export const help = `ak status — read-only dashboard of what's true and what's drifted

Prints one row per subsystem (versions, natives, security, learning, providers,
…). Without --refresh it changes no configuration and runs no live check; it
shows the last result \`ak sync\` or \`ak status --refresh=live\` remembered,
with its age. It may refresh its own local evidence cache under
\`<state>/agentic-kit/evidence/\` so later checks stay fast. A bare \`ak\` runs
this plus one suggested next action.
A row's "→" fix is what \`ak sync\` performs; "→ manual:" marks a step you run
yourself (sync never plans it). --json rows carry the same distinction as
\`repair\`: "sync", "manual", or null when there is no fix.

Usage: ak status [--json] [--refresh[=live|machine]] [--project-trees]
                 [--only CHECK[,CHECK...]]

Options:
  --json                    emit the raw rows as JSON (suppresses the drift
                            nudge); with --refresh the JSON also lists each
                            stage under "refresh", no stage lines print, and
                            anything a stage itself prints goes to stderr;
                            with --refresh=live it also carries "live", each
                            check's result and the lines it printed
  --refresh[=live|machine]  refresh first, then report (the strengths below)
  --project-trees           with --refresh=machine: also measure the working
                            trees of your projects
  --only CHECK[,CHECK...]   with --refresh=live: run exactly these checks
                            (comma-separated or repeated) instead of the quick
                            set, and print each check's own lines under it

Refresh strengths (each runs its stages in this order, one line per stage):
  --refresh          Refreshing Maintenance evidence, Rebuilding the inventory,
                     Re-checking local evidence and versions (re-probes the
                     cached evidence a plain \`ak status\` reuses: ruflo
                     components, native runtime, host setup, deja-vu, version
                     drift and the rest)
  --refresh=live     the same, plus Running live checks before the re-check:
                     the quick, free checks below that apply, in parallel,
                     each bounded by a minute that reads inconclusive, one
                     line per check; the results are remembered
  --refresh=machine  Measuring the machine first (minutes: it walks the disk),
                     then the --refresh stages, rebuilding the inventory from
                     the new measurement; it runs no live checks
The Maintenance and inventory stages save what they find under
\`<state>/agentic-kit/maintenance/\`. A failed machine measurement skips those
two stages; the local re-check always runs.

Live checks (quick and free):
  aqe-embedding  the AQE live embedding request (a backend the kit manages)
  mcp            Codex MCP initialize/tools-list (when Codex is enabled)
  providers      kit config matches installed CLIs; ruflo/aqe see the wiring
                 (checked from the project root, whatever folder you run in)
  security       security packages load; defend flags injection, passes clean
  deja-vu        content-free structural proof of CLI, doctor, wiring and
                 index (when deja-vu is enabled or ak owns it)
  memory         store, retrieve and purge a value in a temporary folder
Slow proofs run only when named with --only, up to six minutes each:
  learning       train a cycle in a temporary folder; assert patterns persist
  harvest        record an outcome and distill through Ruflo, in an isolated
                 store
  aqe            storage, embedding configuration and provenance, and the
                 browser payload
  memory-routes  the memory round trip, plus whether CLI and MCP see each
                 other's writes (remembered as the memory check)
A named check runs even when it would not apply; its result is remembered only
when it applies. learning and harvest are never remembered.

The exit code is 1 when a row fails or a refresh stage fails, and 2 for a
usage error. A failed live check is a warning and leaves the exit code as it
was. With --only, only the named checks decide the exit code: 1 when one
failed, was inconclusive or did not run, else 0; rows and stage failures still
print and appear in --json.

Examples:
  ak status                    quick dashboard
  ak status --refresh          re-check the cached evidence, then report
  ak status --refresh=live     also run the quick live checks, then report
  ak status --refresh=machine  also measure the machine (slow), then report
  ak status --refresh=live --only security,memory
                               run two checks; exit 1 unless both pass
  ak status --refresh=live --only learning
                               the slow learning proof
  ak status --json             machine-readable rows`;

// Generalizes the HOST_DETAIL_RENDERERS contract (status/host-detail.mjs) to
// every section: a section owns its own error handling when it needs an
// exact message (most already carry their original try/catch verbatim), and
// this is the backstop for the rest — a thrown probe degrades to one warn
// row instead of taking down every row collect() hasn't pushed yet.
function defaultOnError(id, e) {
  return row(id, 'warn', `${id} check unavailable: ${e.message}`);
}

/** The worst level across every row: 'fail' if any row failed, else 'warn' if
 *  any warned, else 'ok'. Shared by `run()`'s own exit-code decision and by
 *  dashboard-server.mjs's in-process /api/status provider, which has no CLI
 *  process around it to derive an exit code from. */
export function worstLevel(rows) {
  return rows.some((r) => r.level === 'fail') ? 'fail'
    : rows.some((r) => r.level === 'warn') ? 'warn' : 'ok';
}

async function runSections(sections, ctx, rows) {
  for (const section of sections) {
    try {
      rows.push(...(await section.collect(ctx)));
    } catch (e) {
      rows.push(defaultOnError(section.id, e));
    }
  }
}

/** `versionEvidence` carries version results a caller already holds (ak sync's
 *  cache-only reads for the parts --skip names, and its --dry-run preview,
 *  ADR-0063); the versions, self, ruvnet-brain and ruvector sections use them
 *  instead of looking up their own.
 *  @param {{ pkgRoot?: string, cwd?: string, dejaVuAdapter?: any, dejaVuPlanOptions?: Record<string, any>, refresh?: boolean, record?: boolean,
 *   versionEvidence?: { drift?: any[], self?: any, brain?: any, ruvector?: any, cfg?: any } }} opts */
export async function collect({
  pkgRoot,
  cwd = process.cwd(),
  dejaVuAdapter = companionLifecycleFor('deja-vu'),
  dejaVuPlanOptions = {},
  refresh = false,
  record = true,
  versionEvidence,
}) {
  const rows = [];
  const cfg = loadKitConfig();
  // Accurate provenance: 'status-refresh' only when the caller actually asked
  // for a refresh — a plain status call recording evidence should not claim
  // to be a refresh it never performed.
  const source = refresh ? 'status-refresh' : 'status';
  // globalRoot() defaults refresh:false/record:false (paths.mjs: it is the
  // single most transitively-called function in the codebase, reached from
  // dozens of non-status contexts that must never persist evidence as a side
  // effect). Warming its in-process memo HERE, once, with THIS call's real
  // refresh/record, is what lets every other bare `globalRoot()` call below
  // (however deep — natives, versions, providers, daemons, …) reuse the memo
  // for free while still letting a plain `ak status` persist for a later
  // process to reuse, and `--refresh` force a fresh read. A throw here (no
  // npm, no resolvable fallback) is swallowed: the sections that actually
  // need the value report it individually rather than failing the whole row set.
  try { globalRoot({ refresh, record, source }); } catch { /* reported per-section */ }
  const integrationFacts = await collectIntegrationFacts({
    cwd, cfg, refresh, record, source,
  });
  const ctx = {
    cfg, cwd, pkgRoot, integrationFacts, refresh, record, source, versionEvidence,
  };

  await runSections(SECTIONS_BEFORE_HOST_DETAIL, ctx, rows);

  rows.push(...(await collectDejaVuRows({
    cfg, adapter: dejaVuAdapter, planOptions: dejaVuPlanOptions, refresh, record, source,
  })));

  // Per-host status DETAIL rows (opencode.json wiring, lifecycle bridge,
  // converted agents, platform skill, …) — the host-neutral counterpart of
  // the codex-mcp rows above. Dispatches through HOST_DETAIL_RENDERERS; only
  // a host both enabled AND registered there produces rows (enabled-but-
  // absent is the CLI-presence branch inside its own renderer, sourced from
  // the shared facts snapshot — no extra probing here or in the loop).
  rows.push(...(await renderHostDetailRows({ cfg, pkgRoot, facts: integrationFacts })));
  rows.push(...admittedLifecycleFallbackRows(cfg));

  await runSections(SECTIONS_AFTER_HOST_DETAIL, ctx, rows);

  return rows;
}

/**
 * Run the refresh stages, then take the rows from the local re-check. Live
 * checks run as a stage, never inside collect(): the dashboard calls
 * collect() and must stay probe-free. A failed re-check falls back to the
 * plain rows and says so in one more row.
 */
async function refreshedRows({ request, stages, pkgRoot, onStage }) {
  const refresh = await runRefresh({ ...request, stages, onStage });
  const local = refresh.stages.find(({ id }) => id === 'local');
  let rows = local?.result;
  if (local?.state !== 'done' || !Array.isArray(rows)) {
    rows = await collect({ pkgRoot, refresh: false });
    rows.push(row('refresh', 'warn', `local re-check failed: ${local?.detail ?? 'no rows'}`));
  }
  const live = refresh.stages.find(({ id }) => id === 'live')?.result ?? null;
  return { rows, refresh, live };
}

const entryGlyph = (level) => (level === 'info' ? dim('ℹ') : glyph(level));

const NOT_REMEMBERED = 'not remembered: this check does not apply to your setup';

/** One line per live check; with --only, the lines each check printed are
 *  indented under it (its heading is the check line itself). A named check
 *  that does not apply says its result was not remembered. */
function printLiveChecks(results, { detail }) {
  for (const { id, status, reason, elapsedMs = 0, entries = [], applies } of results) {
    const notes = [reason, applies === false ? NOT_REMEMBERED : null].filter(Boolean).join('; ');
    (status === 'passed' ? ok : warn)(`${id} ${status} (${formatElapsed(elapsedMs)})${notes ? ` — ${notes}` : ''}`);
    if (!detail) continue;
    for (const { level, text } of entries) {
      if (level !== 'heading') console.log(`    ${entryGlyph(level)} ${sanitizeForTerminal(text)}`);
    }
  }
}

/** The human renderer: the shared stage lines, with the live checks' own
 *  lines printed under the live stage's line. The live stage is wrapped to
 *  keep its results, which the stage events do not carry. */
function humanStages(stages, { only }) {
  if (typeof stages.live !== 'function') return { stages, onStage: printRefreshStage };
  let results = null;
  const live = async (ctx) => {
    const outcome = await stages.live(ctx);
    results = outcome?.result;
    return outcome;
  };
  const onStage = (event) => {
    printRefreshStage(event);
    if (event.id === 'live' && event.state === 'done' && Array.isArray(results)) {
      printLiveChecks(results, { detail: only.length > 0 });
    }
  };
  return { stages: { ...stages, live }, onStage };
}

/** Under --json with a refresh, every human line (stage output, warnings)
 *  goes to stderr while the stages run, so stdout carries one JSON object. */
async function runRefreshed({ flags, pkgRoot, request, deps }) {
  const stages = deps.refreshStages ?? cliRefreshStages({ cwd: process.cwd(), pkgRoot });
  if (!flags.json) {
    const human = humanStages(stages, request);
    return report(flags, await refreshedRows({ request, pkgRoot, ...human }), request);
  }
  return report(flags, await humanOutputToStderr(() => refreshedRows({ request, stages, pkgRoot, onStage: undefined })), request);
}

/** A refresh takes no positional. `ak status --refresh live` parses as a bare
 *  refresh plus the argument `live`, so it is refused rather than silently
 *  run at the wrong strength; a strength name gets its one-token spelling. */
function strayArgumentError(positionals) {
  const [first] = positionals;
  if (first === undefined) return null;
  const spelling = REFRESH_STRENGTHS.includes(first) ? ` — write --refresh=${first}` : '';
  return `unexpected argument '${first}'${spelling}`;
}

/** @param {{ flags: Record<string, any>, positionals?: string[], pkgRoot?: string,
 *   deps?: { refreshStages?: Record<string, Function> } }} input */
export async function run({ flags, positionals = [], pkgRoot, deps = {} }) {
  const request = refreshRequestFromFlags(flags);
  if ('error' in request) return usageError(request.error);
  if (!request.strength) return report(flags, { rows: await collect({ pkgRoot, refresh: false }) });
  const stray = strayArgumentError(positionals);
  if (stray) return usageError(stray);
  return runRefreshed({ flags, pkgRoot, request, deps });
}

function usageError(message) {
  fail(`ak status: ${message}`);
  return 2;
}

/** The JSON summary of a refresh: each stage without its result. */
const refreshSummary = ({ strength, ok, stages }) => ({
  strength, ok, stages: stages.map(({ id, label, state, detail, elapsedMs }) => ({ id, label, state, detail, elapsedMs })),
});

/** Whether a check `--only` named did not pass (failed, inconclusive, or no
 *  result at all). */
const namedCheckFailed = (only, live) => only.some((id) => live?.find((r) => r.id === id)?.status !== 'passed');

/** Print the rows (or the one JSON object) and return the exit code. With
 *  --only the named checks alone decide it: 1 when one did not pass, else 0
 *  (rows and failed stages still print and reach --json). Without it: 1 when a
 *  row fails or a refresh stage failed, else 0; a failed live check is a
 *  warning only. */
function report(flags, { rows, refresh = null, live = null }, { only = [] } = {}) {
  const worst = worstLevel(rows);
  const code = only.length > 0
    ? (namedCheckFailed(only, live) ? 1 : 0)
    : (worst === 'fail' || (refresh && !refresh.ok) ? 1 : 0);

  if (flags.json) {
    console.log(JSON.stringify({
      overall: worst, rows, ...(refresh ? { refresh: refreshSummary(refresh) } : {}), ...(live ? { live } : {}),
    }, null, 2));
    return code;
  }

  printRows(rows);
  // health-history: alarm on any backslide since the previous sync snapshot.
  for (const reg of detectRegression(loadRing(loadKitConfig()))) warn(`regression: ${reg.message}`);
  if (flags.hint) printHint(rows, worst);
  return code;
}

function printRows(rows) {
  console.log(bold('ak status'));
  let last = '';
  for (const r of rows) {
    const label = r.subsystem === last ? ' '.repeat(r.subsystem.length) : r.subsystem;
    last = r.subsystem;
    // A manual fix is labelled so nobody expects `ak sync` to perform it.
    const fix = r.fix ? dim(`  → ${r.repair === 'manual' ? 'manual: ' : ''}${r.fix}`) : '';
    console.log(`  ${glyph(r.level)} ${label.padEnd(11)} ${r.message}${fix}`);
  }
}

/** --hint: exactly one suggested next action. */
function printHint(rows, worst) {
  const bySync = rows.filter((r) => r.fix && r.repair !== 'manual');
  const manual = rows.filter((r) => r.fix && r.repair === 'manual');
  console.log('');
  if (worst === 'ok') console.log(`${glyph('ok')} all healthy — nothing to do`);
  else if (!bySync.length && manual.length) {
    console.log(`${manual.length} item(s) need attention — run the "→ manual:" step(s) above yourself; ak sync does not perform them`);
  } else {
    const more = manual.length ? dim(` · ${manual.length} more need a manual step (→ manual:)`) : '';
    console.log(`${bySync.length} item(s) need attention — run: ${bold('ak sync')}${worst === 'fail' ? '' : dim('  (or --dry-run to preview)')}${more}`);
  }
  console.log(dim('📊 ak dashboard — open the local web dashboard (http://127.0.0.1:7431)'));
}
