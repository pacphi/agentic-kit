// ak system — the machine footprint in the terminal (ADR-0025).
//
// The CLI twin of the dashboard's System area, driving the SAME composed
// collector (src/lib/footprint/index.mjs) over the same two tiers. Reading is
// cheap and always safe: the live process census, the individually-known files,
// and whatever the last machine measurement persisted, carried forward with
// THAT measurement's timestamp. The expensive walk runs only under
// --refresh=machine, through the shared refresh stages (ADR-0063), only when a
// human asked for it — never on open, never on a nudge (the nudge just says the
// figures are getting old).
//
// Every number on this page is a Measurement, and this file's whole job is to
// render one honestly. A measured zero prints as 0 because it IS zero. An
// unmeasured quantity prints the reason it is missing and NEVER a 0 (ADR-0023,
// machine-footprint invariant 2). A capped or partially-degraded walk prints
// with a `>=` because what it measured is a floor, not a total.
import {
  heading, info, warn, fail, dim, bold, humanOutputToStderr,
} from '../lib/output.mjs';
import { createSystemCollector } from '../lib/footprint/index.mjs';
import { UNKNOWN } from '../lib/footprint/walk.mjs';
import {
  REFRESH_OPTIONS, REFRESH_STRENGTHS, refreshRequestFromFlags, runRefresh, cliRefreshStages, printRefreshStage,
} from '../lib/refresh.mjs';

export const options = {
  json: { type: 'boolean', default: false },
  ...REFRESH_OPTIONS,
};

export const help = `ak system — what this stack occupies on your machine

Reads the cheap tier by default: the live agent-process census, the files that
grow fastest between measurements, and the last machine measurement's figures
carried forward with the date they were taken. --refresh=machine re-walks
install trees, storage, the cross-host catalog, and every discovered project,
then persists the result; --project-trees also measures the working trees of
your own projects. A bare --refresh (or --refresh=live) refreshes Maintenance
evidence and the inventory, then reprints this same snapshot — see
ak status --help for the shared stages and strengths.

Usage:
  ak system [--refresh[=live|machine]] [--project-trees] [--json]

Options:
  --refresh[=live|machine]  refresh first, then report (see above)
  --project-trees           with --refresh=machine: also measure the working
                            trees of your projects
  --json                    emit the snapshot payload verbatim — the same
                            shape /api/system serves; with --refresh it also
                            carries "refresh": each stage's outcome, and stage
                            lines go to stderr instead of stdout

The exit code is 1 when a refresh stage fails, and 2 for a usage error.

Examples:
  ak system                    install totals, runtime census, storage, catalog, projects
  ak system --refresh=machine  re-measure everything, then print it
  ak system --json             machine-readable snapshot (no refresh)
  ak system --refresh=machine --json  re-measure, then emit the fresh snapshot`;

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

/** Decimal units, matching the System design mock. */
function fmtBytes(n) {
  if (!Number.isFinite(n)) return String(n);
  let value = Math.abs(n);
  let unit = 0;
  while (value >= 1000 && unit < UNITS.length - 1) { value /= 1000; unit += 1; }
  const digits = unit === 0 ? 0 : value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${(n < 0 ? -value : value).toFixed(digits)} ${UNITS[unit]}`;
}

const fmtCount = (n) => (Number.isFinite(n) ? n.toLocaleString('en-US') : String(n));
const fmtPercent = (n) => (Number.isFinite(n) ? `${n.toFixed(1)}%` : String(n));

function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return String(ms);
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86_400)}d ${Math.floor((s % 86_400) / 3600)}h`;
}

const fmtAgo = (at, now) => (Number.isFinite(at) ? `${fmtDuration(now - at)} ago` : String(at));
const fmtStamp = (at) => (Number.isFinite(at)
  ? new Date(at).toISOString().replace('T', ' ').slice(0, 16)
  : 'unknown');

/**
 * Render a Measurement as a line value. An unknown carries its reason with it —
 * that reason is the whole point of the type, and dropping it here would leave
 * a bare "unknown" indistinguishable from a rendering bug.
 */
function meas(value, fmt = fmtCount) {
  if (!value || typeof value !== 'object') return dim('unknown — no measurement reported');
  if (value.status === UNKNOWN) return dim(`unknown — ${value.reason}`);
  return `${value.partial ? '>= ' : ''}${fmt(value.value)}`;
}

/**
 * Table cells cannot carry a reason: column widths are computed on the raw text,
 * so a long reason (or an ANSI escape) would wreck the alignment. The sink keeps
 * every distinct reason it swallowed and the caller prints them under the table,
 * so "unknown" in a cell is still traceable to why.
 */
function reasonSink() {
  const seen = new Set();
  return {
    cell(value, fmt = fmtCount) {
      if (!value || typeof value !== 'object') { seen.add('no measurement reported'); return 'unknown'; }
      if (value.status === UNKNOWN) { seen.add(value.reason); return 'unknown'; }
      return `${value.partial ? '>= ' : ''}${fmt(value.value)}`;
    },
    report(indent = '  ') {
      for (const reason of seen) console.log(`${indent}${dim(`unknown: ${reason}`)}`);
    },
  };
}

/** Left-aligned columns; the last column is never padded so lines do not carry
 *  trailing whitespace. Cells must be plain text (see reasonSink). */
function table(headers, rows, indent = '  ') {
  if (!rows.length) return;
  const widths = headers.map((header, i) => Math.max(
    header.length, ...rows.map((row) => String(row[i] ?? '').length),
  ));
  const line = (cells) => cells
    .map((cell, i) => (i === cells.length - 1 ? String(cell ?? '') : String(cell ?? '').padEnd(widths[i])))
    .join('  ')
    .trimEnd();
  console.log(`${indent}${dim(line(headers))}`);
  for (const row of rows) console.log(`${indent}${line(row)}`);
}

const field = (label, value) => console.log(`  ${dim(label.padEnd(16))}${value}`);

/** A deep section's provenance. Every figure inside it was taken at one instant
 *  and every one of them reads back as `carried-forward` (the section is always
 *  served from the persisted snapshot, even microseconds after --refresh=machine
 *  wrote it), so the scan date is stated ONCE here instead of on all several
 *  hundred lines — invariant 3 satisfied without burying the figures. */
function deepHeading(name, section) {
  const asOf = section?.asOf;
  return heading(`${name}${Number.isFinite(asOf) ? dim(`  — measured ${fmtStamp(asOf)}`) : ''}`);
}

function renderSummary(snapshot) {
  const { snapshot: snap, runtime, knownFiles } = snapshot;
  heading('ak system — machine footprint');
  field('platform', snapshot.platform);
  field('census', `${runtime?.ephemeral ? 'live' : 'reported'} · ${snapshot.generatedAt}`);
  const present = knownFiles?.nodes?.filter((node) => node.presence === 'present').length ?? 0;
  field('known files', `${present}/${knownFiles?.nodes?.length ?? 0} present`);
  if (!snap?.present) {
    field('machine measurement', dim(`never run — ${snap?.reason ?? 'no snapshot'}`));
  } else {
    const missing = snap.completeness?.missing ?? [];
    field('machine measurement', `${fmtStamp(snap.asOf)} (${fmtDuration(snap.ageMs)} ago)`
      + (missing.length ? dim(` · ${missing.join(', ')} not measured`) : ''));
  }
}

function renderInstall(install) {
  deepHeading('Install', install);
  if (!install) {
    info(dim('not measured yet — run: ak system --refresh=machine'));
    return;
  }
  field('tools present', meas(install.totals?.toolsPresent));
  field('install size', meas(install.totals?.installBytes, fmtBytes));
  field('shared caches', meas(install.totals?.cacheBytes, fmtBytes));
  field('native addons', meas(install.totals?.nativeAddons));
  field('disk', `${meas(install.disk?.freeBytes, fmtBytes)} free of `
    + `${meas(install.disk?.totalBytes, fmtBytes)}`);
  if (install.globalRootReason) field('npm root', dim(install.globalRootReason));

  const sink = reasonSink();
  const rows = (install.tools ?? []).map((tool) => [
    tool.label,
    tool.present ? (tool.version ? `v${tool.version}` : 'present') : 'absent',
    tool.installMethod,
    sink.cell(tool.bytes, fmtBytes),
    tool.managed === false
      ? `observed; updates via ${tool.updateOwner}${tool.rootReason ? ` · ${tool.rootReason}` : ''}`
      : (tool.rootReason ?? ''),
  ]);
  console.log('');
  table(['TOOL', 'VERSION', 'METHOD', 'SIZE', 'NOTE'], rows);
  sink.report();
  const browserCaches = (install.sharedCaches ?? []).filter((cache) => cache.runtime);
  if (browserCaches.length) {
    console.log('');
    const browserSink = reasonSink();
    table(['BROWSER PAYLOAD', 'READINESS', 'REVISION', 'CACHE', 'OWNER'], browserCaches.map((cache) => [
      cache.label,
      cache.payload?.status ?? 'unknown',
      cache.payload?.revision ?? cache.payload?.reason ?? '—',
      browserSink.cell(cache.bytes, fmtBytes),
      cache.updateOwner ?? 'upstream',
    ]));
    browserSink.report();
  }
  const dupes = install.duplicateNatives ?? [];
  if (dupes.length) info(`${dupes.length} native module(s) compiled into more than one tree`);
}

function renderRuntime(runtime) {
  heading(`Runtime${dim('  — live, never persisted')}`);
  if (!runtime) {
    info(dim('no census reported'));
    return;
  }
  field('processes', meas(runtime.totals?.processCount));
  field('memory (RSS)', meas(runtime.totals?.rssBytes, fmtBytes));
  field('cpu', meas(runtime.totals?.cpuPercent, fmtPercent));
  field('daemons', `${meas(runtime.daemons?.count)} running · ${meas(runtime.daemons?.staleCount)} stale`);
  field('machine', `${meas(runtime.machine?.physicalMemoryBytes, fmtBytes)} memory · `
    + `${meas(runtime.machine?.freeMemoryBytes, fmtBytes)} free · ${meas(runtime.machine?.cpuCount)} cores`);

  const census = runtime.processes;
  if (census?.status === UNKNOWN) {
    console.log(`  ${dim(`process table unavailable — ${census.reason}`)}`);
    return;
  }
  const rows = census?.value ?? [];
  if (!rows.length) {
    console.log(`  ${dim('no agent processes are running')}`);
    return;
  }
  const sink = reasonSink();
  console.log('');
  table(['HOST', 'PID', 'CPU', 'RSS', 'UPTIME', 'PROJECT'], rows.map((row) => [
    row.host,
    String(row.pid),
    sink.cell(row.cpuPercent, fmtPercent),
    sink.cell(row.rssBytes, fmtBytes),
    sink.cell(row.uptimeMs, fmtDuration),
    row.project?.status === UNKNOWN ? 'unattributed' : (row.project?.value?.label ?? 'unattributed'),
  ]));
  sink.report();
  // `project` degrades per process (a cwd the platform will not disclose); its
  // reason lives on the row, not in the numeric sink above.
  for (const reason of new Set(rows.filter((row) => row.project?.status === UNKNOWN)
    .map((row) => row.project.reason))) {
    console.log(`  ${dim(`unattributed: ${reason}`)}`);
  }
}

function renderStorage(storage) {
  deepHeading('Storage', storage);
  if (!storage) {
    info(dim('not measured yet — run: ak system --refresh=machine'));
    return;
  }
  field('total', `${meas(storage.totals?.bytes, fmtBytes)} · ${meas(storage.totals?.files)} files`);

  const sink = reasonSink();
  console.log('');
  table(['CATEGORY', 'SIZE', 'FILES'], (storage.categories ?? []).map((category) => [
    category.label,
    sink.cell(category.bytes, fmtBytes),
    sink.cell(category.files),
  ]));
  sink.report();

  const reclaimables = storage.reclaimables ?? [];
  if (reclaimables.length) {
    const advisory = reasonSink();
    console.log('');
    console.log(`  ${dim('reclaimable (advisory only — ak system removes nothing)')}`);
    table(['CANDIDATE', 'SIZE', 'CLEANUP'], reclaimables.map((row) => [
      row.label, advisory.cell(row.bytes, fmtBytes), row.cleanupHint ?? '—',
    ]));
    advisory.report();
  }
}

function renderCatalogEvidence(catalog) {
  const digestCoverage = catalog.overlaps?.digestCoverage;
  if (digestCoverage) {
    field('skill entrypoint evidence', `${fmtCount(digestCoverage.measured)} hashed · `
      + `${fmtCount(digestCoverage.unknown)} unknown · `
      + `${fmtCount(catalog.overlaps?.exactName?.length ?? 0)} exact-name overlap group(s)`);
  }
  for (const [host, source] of Object.entries(catalog.pluginSources ?? {})) {
    field(`${host} plugin inventory`, `${source.status} · ${source.authority}${source.reason ? ` · ${source.reason}` : ''}`);
  }
}

function renderCatalogPressure(catalog) {
  const sink = reasonSink();
  const pressureRows = [];
  for (const project of catalog.projects ?? []) {
    for (const host of catalog.hosts ?? []) {
      const facts = project.byHost?.[host];
      pressureRows.push([
        project.label, host,
        sink.cell(facts?.sources?.project?.skill),
        sink.cell(facts?.sources?.user?.skill),
        sink.cell(facts?.sources?.plugin?.skill),
        sink.cell(facts?.overlaps?.skillNames),
        sink.cell(facts?.overlaps?.skillDigests),
      ]);
    }
  }
  if (pressureRows.length) {
    console.log('');
    info(dim('project capability pressure (inventory only; context inclusion is host-owned and unknown)'));
    table(['PROJECT', 'HOST', 'PROJECT SKILLS', 'USER SKILLS', 'PLUGIN SKILLS', 'NAME OVERLAP', 'BODY OVERLAP'], pressureRows);
    sink.report();
    info(dim('read-only remediation: ak x skills plan --project <path>'));
  }
}

function renderCatalog(catalog) {
  deepHeading('Catalog', catalog);
  if (!catalog) {
    info(dim('not measured yet — run: ak system --refresh=machine'));
    return;
  }
  const kinds = catalog.kinds ?? [];
  field('deduplicated', kinds.map((kind) => `${meas(catalog.counts?.[kind])} ${kind}`).join(' · '));

  const sink = reasonSink();
  console.log('');
  table(['HOST', ...kinds.map((kind) => kind.toUpperCase())], (catalog.hosts ?? []).map((host) => [
    host, ...kinds.map((kind) => sink.cell(catalog.perHost?.[host]?.[kind])),
  ]));
  sink.report();
  renderCatalogEvidence(catalog);
  renderCatalogPressure(catalog);
  if (catalog.degraded?.length) info(dim(`unreadable surfaces: ${catalog.degraded.join(', ')}`));
  if (catalog.truncated?.length) {
    info(dim(`capped surfaces (counts are floors): ${catalog.truncated.join(', ')}`));
  }
}

function renderProjects(projects, now) {
  deepHeading('Projects', projects);
  if (!projects) {
    info(dim('not measured yet — run: ak system --refresh=machine'));
    return;
  }
  field('discovered', `${meas(projects.count)}${projects.truncated ? dim(' · list truncated') : ''}`);
  if (!projects.locMeasured) field('lines of code', dim('not measured in this scan'));

  const sink = reasonSink();
  console.log('');
  table(['PROJECT', 'SIZE', 'LOC', 'LAST ACTIVE'], (projects.projects ?? []).map((project) => [
    project.label,
    sink.cell(project.totalBytes, fmtBytes),
    sink.cell(project.loc?.total),
    sink.cell(project.lastActivity, (at) => fmtAgo(at, now)),
  ]));
  sink.report();
}

/** The staleness nudge — the ONLY thing that ever suggests a re-measure. It
 *  never triggers one: a machine measurement costs minutes, so it stays a
 *  human's decision. */
function renderNudge(snap) {
  if (!snap?.present) {
    info(`no machine measurement yet — run: ${bold('ak system --refresh=machine')}`);
  } else if (snap.stale) {
    warn(`machine figures are ${fmtDuration(snap.ageMs)} old — refresh with: ${bold('ak system --refresh=machine')}`);
  }
}

/** A refresh takes no positional. `ak system --refresh live` parses as a bare
 *  refresh plus the argument `live`, so it is refused rather than silently
 *  run at the wrong strength; a strength name gets its one-token spelling. */
function strayArgumentError(positionals) {
  const [first] = positionals;
  if (first === undefined) return null;
  const spelling = REFRESH_STRENGTHS.includes(first) ? ` — write --refresh=${first}` : '';
  return `unexpected argument '${first}'${spelling}`;
}

function usageError(message) {
  fail(`ak system: ${message}`);
  return 2;
}

/** The JSON summary of a refresh: each stage without its result (mirrors
 *  status.mjs — every command that takes --refresh reports the shared
 *  stages the same way). */
const refreshSummary = ({ strength, ok, stages }) => ({
  strength, ok, stages: stages.map(({ id, label, state, detail, elapsedMs }) => ({ id, label, state, detail, elapsedMs })),
});

/** Print the snapshot (or the one JSON object) and return the exit code: 1
 *  when a refresh stage failed, else 0. */
function report({ flags, snapshot, refresh, now }) {
  const code = refresh && !refresh.ok ? 1 : 0;

  if (flags.json) {
    const payload = refresh ? { ...snapshot, refresh: refreshSummary(refresh) } : snapshot;
    console.log(JSON.stringify(payload, null, 2));
    return code;
  }

  renderSummary(snapshot);
  renderInstall(snapshot.install);
  renderRuntime(snapshot.runtime);
  renderStorage(snapshot.storage);
  renderCatalog(snapshot.catalog);
  renderProjects(snapshot.projects, now());
  console.log('');
  renderNudge(snapshot.snapshot);
  return code;
}

/**
 * @param {{ flags: Record<string, any>, positionals?: string[], pkgRoot?: string,
 *           deps?: { collector?: ReturnType<typeof createSystemCollector>, cwd?: string,
 *                    now?: () => number, refreshStages?: Record<string, (ctx: any) => Promise<any>> } }} input
 */
export async function run({
  flags, positionals = [], pkgRoot, deps = {},
}) {
  // --only is shared with ak status, but system never renders live results,
  // so the checks' exit rule (ADR-0063) has nothing to report here.
  if (flags.only != null && [].concat(flags.only).length > 0) {
    return usageError('--only applies to ak status --refresh=live; ak system does not report live checks');
  }
  const request = refreshRequestFromFlags(flags);
  if ('error' in request) return usageError(request.error);

  const cwd = deps.cwd ?? process.cwd();
  const collector = deps.collector ?? createSystemCollector({ cwd });
  const now = deps.now ?? Date.now;

  if (!request.strength) {
    // The collector assembles the deep sections by spread, so the inferred
    // return type cannot name install/storage/catalog/projects. The wire
    // shape is the contract (ADR-0025); widening here reads it without
    // restating it.
    /** @type {Record<string, any>} */
    const snapshot = await collector.read();
    return report({ flags, snapshot, refresh: null, now });
  }

  const stray = strayArgumentError(positionals);
  if (stray) return usageError(stray);

  // The command's own collector, so the read below sees exactly what the
  // refresh's `machine` stage just persisted.
  const stages = deps.refreshStages ?? cliRefreshStages({ cwd, pkgRoot, deps: { collector } });
  const refresh = flags.json
    ? await humanOutputToStderr(() => runRefresh({ ...request, stages, onStage: undefined }))
    : await runRefresh({ ...request, stages, onStage: printRefreshStage });
  /** @type {Record<string, any>} */
  const snapshot = await collector.read();
  return report({ flags, snapshot, refresh, now });
}
