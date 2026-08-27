// ak status — read-only dashboard. Each row: subsystem, level, message,
// and (for drift) what `sync` would do. --json emits the raw rows; --hint
// (set by bare invocation) appends exactly one suggested next action.
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
};

export const help = `ak status — read-only dashboard of what's true and what's drifted

Prints one row per subsystem (versions, natives, security, learning, providers,
…). Read-only: it never changes anything. A bare \`ak\` runs this plus one
suggested next action.

Usage: ak status [options]

Options:
  --deep    run the slower probes (spawns CLIs) for a fuller picture
  --json    emit the raw rows as JSON (suppresses the drift nudge)

Examples:
  ak status           quick dashboard
  ak status --deep    thorough check
  ak status --json    machine-readable rows`;

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
}) {
  const rows = [];
  const cfg = loadKitConfig();
  const integrationFacts = await collectIntegrationFacts({ cwd, cfg });
  const ctx = { cfg, cwd, pkgRoot, integrationFacts };

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

export async function run({ flags, pkgRoot }) {
  const rows = await collect({ pkgRoot });
  const worst = rows.some((r) => r.level === 'fail') ? 'fail'
    : rows.some((r) => r.level === 'warn') ? 'warn' : 'ok';

  if (flags.json) {
    console.log(JSON.stringify({ overall: worst, rows }, null, 2));
    return worst === 'fail' ? 1 : 0;
  }

  console.log(bold('ak status'));
  let last = '';
  for (const r of rows) {
    const label = r.subsystem === last ? ' '.repeat(r.subsystem.length) : r.subsystem;
    last = r.subsystem;
    console.log(`  ${glyph(r.level)} ${label.padEnd(11)} ${r.message}${r.fix ? dim(`  → ${r.fix}`) : ''}`);
  }

  // health-history: alarm on any backslide since the previous sync snapshot.
  for (const reg of detectRegression(loadRing(loadKitConfig()))) warn(`regression: ${reg.message}`);

  if (flags.hint) {
    const actionable = rows.filter((r) => r.fix);
    console.log('');
    if (worst === 'ok') console.log(`${glyph('ok')} all healthy — nothing to do`);
    else console.log(`${actionable.length} item(s) need attention — run: ${bold('ak sync')}${worst === 'fail' ? '' : dim('  (or --dry-run to preview)')}`);
    console.log(dim('📊 ak dashboard — open the local web dashboard (http://127.0.0.1:7431)'));
  }
  return worst === 'fail' ? 1 : 0;
}
