// ak status — read-only dashboard. Each row: subsystem, level, message,
// and (for drift) a fix plus who performs it (`repair`: 'sync' or 'manual',
// see status/row.mjs). --json emits the raw rows; --hint (set by bare
// invocation) appends exactly one suggested next action.
import { glyph, dim, bold, warn } from '../lib/output.mjs';
import { loadRing, detectRegression } from '../lib/health-history.mjs';
import { loadKitConfig } from '../lib/config.mjs';
import { collectIntegrationFacts } from '../lib/providers.mjs';
import { companionLifecycleFor } from '../lib/adapters/companion-lifecycle-registry.mjs';
import { row } from './status/row.mjs';
import { renderHostDetailRows, admittedLifecycleFallbackRows } from './status/host-detail.mjs';
import { collectDejaVuRows } from './status/deja-vu.mjs';
import { SECTIONS_BEFORE_HOST_DETAIL, SECTIONS_AFTER_HOST_DETAIL } from './status/sections/index.mjs';

export { renderHostDetailRows, collectDejaVuRows };

export const options = {
  json: { type: 'boolean', default: false },
  deep: { type: 'boolean', default: false },
  hint: { type: 'boolean', default: false },
  refresh: { type: 'boolean', default: false },
  live: { type: 'boolean', default: false },
};

export const help = `ak status — read-only dashboard of what's true and what's drifted

Prints one row per subsystem (versions, natives, security, learning, providers,
…). Without --live it is read-only: it changes nothing and runs no live check;
it shows the last result \`ak sync\`, \`ak x verify\` or \`ak status --live\`
remembered, with its age. A bare \`ak\` runs this plus one suggested next action.
A row's "→" fix is what \`ak sync\` performs; "→ manual:" marks a step you run
yourself (sync never plans it). --json rows carry the same distinction as
\`repair\`: "sync", "manual", or null when there is no fix.

Usage: ak status [options]

Options:
  --deep      run the slower probes (spawns CLIs) for a fuller picture
  --json      emit the raw rows as JSON (suppresses the drift nudge)
  --refresh   re-probe ruflo component evidence
  --live      first run the quick, free live checks from \`ak x verify\` in
              parallel (AQE embedding request for a kit-managed backend, Codex
              MCP when Codex is enabled, provider wiring, security packages,
              deja-vu when enabled, and a memory round trip in a temp dir), each
              bounded by a timeout that reads inconclusive; remembers the
              results. A failed check is a warning, so the exit code is unchanged

Examples:
  ak status           quick dashboard
  ak status --deep    thorough check
  ak status --live    run the quick live checks, then report
  ak status --json    machine-readable rows`;

/** `--live`: the quick, free `ak x verify` checks, loaded only when asked for
 *  so plain status never pays for the verify suites. */
async function runDefaultLiveChecks({ cfg, cwd }) {
  const { runLiveChecks, liveChecksFor } = await import('./x/verify.mjs');
  return runLiveChecks({ cfg, cwd, checks: liveChecksFor(cfg) });
}

// Generalizes the HOST_DETAIL_RENDERERS contract (status/host-detail.mjs) to
// every section: a section owns its own error handling when it needs an
// exact message (most already carry their original try/catch verbatim), and
// this is the backstop for the rest — a thrown probe degrades to one warn
// row instead of taking down every row collect() hasn't pushed yet.
function defaultOnError(id, e) {
  return row(id, 'warn', `${id} check unavailable: ${e.message}`);
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

export async function collect({
  pkgRoot,
  cwd = process.cwd(),
  dejaVuAdapter = companionLifecycleFor('deja-vu'),
  dejaVuPlanOptions = {},
  refresh = false,
}) {
  const rows = [];
  const cfg = loadKitConfig();
  const integrationFacts = await collectIntegrationFacts({ cwd, cfg, refresh });
  const ctx = { cfg, cwd, pkgRoot, integrationFacts, refresh };

  await runSections(SECTIONS_BEFORE_HOST_DETAIL, ctx, rows);

  rows.push(...(await collectDejaVuRows({
    cfg, adapter: dejaVuAdapter, planOptions: dejaVuPlanOptions,
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

export async function run({ flags, pkgRoot, runLive = runDefaultLiveChecks }) {
  // Live checks run BEFORE collect(), never inside it: the dashboard calls
  // collect() and must stay probe-free.
  if (flags.live && !flags.json) console.log(dim('running live checks (quick, free; each bounded by a timeout)…'));
  const live = flags.live ? await runLive({ cfg: loadKitConfig(), cwd: process.cwd() }) : null;
  const rows = await collect({ pkgRoot, refresh: !!flags.refresh });
  const worst = rows.some((r) => r.level === 'fail') ? 'fail'
    : rows.some((r) => r.level === 'warn') ? 'warn' : 'ok';

  if (flags.json) {
    console.log(JSON.stringify({ overall: worst, rows, ...(live ? { live } : {}) }, null, 2));
    return worst === 'fail' ? 1 : 0;
  }

  console.log(bold('ak status'));
  let last = '';
  for (const r of rows) {
    const label = r.subsystem === last ? ' '.repeat(r.subsystem.length) : r.subsystem;
    last = r.subsystem;
    // A manual fix is labelled so nobody expects `ak sync` to perform it.
    const fix = r.fix ? dim(`  → ${r.repair === 'manual' ? 'manual: ' : ''}${r.fix}`) : '';
    console.log(`  ${glyph(r.level)} ${label.padEnd(11)} ${r.message}${fix}`);
  }

  // health-history: alarm on any backslide since the previous sync snapshot.
  for (const reg of detectRegression(loadRing(loadKitConfig()))) warn(`regression: ${reg.message}`);

  if (flags.hint) {
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
  return worst === 'fail' ? 1 : 0;
}
