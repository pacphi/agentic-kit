// ak system — the machine footprint in the terminal (ADR-0025).
//
// The CLI twin of the dashboard's System area, driving the SAME composed
// collector (src/lib/footprint/index.mjs) over the same two tiers. Reading is
// cheap and always safe: the live process census, the individually-known files,
// and whatever the last deep scan persisted, carried forward with THAT scan's
// timestamp. The expensive walk runs only under --deep, only when a human asked
// for it — never on open, never on a nudge (the nudge just says the figures are
// getting old).
//
// Every number on this page is a Measurement, and this file's whole job is to
// render one honestly. A measured zero prints as 0 because it IS zero. An
// unmeasured quantity prints the reason it is missing and NEVER a 0 (ADR-0023,
// machine-footprint invariant 2). A capped or partially-degraded walk prints
// with a `>=` because what it measured is a floor, not a total.
import { heading, info, ok, warn, dim, bold, withProgress } from '../lib/output.mjs';
import { createSystemCollector } from '../lib/footprint/index.mjs';
import { UNKNOWN } from '../lib/footprint/walk.mjs';

export const options = {
  json: { type: 'boolean', default: false },
  deep: { type: 'boolean', default: false },
};

export const help = `ak system — what this stack occupies on your machine

Reads the cheap tier by default: the live agent-process census, the files that
grow fastest between scans, and the last deep scan's figures carried forward with
the date they were taken. --deep re-walks install trees, storage, the cross-host
catalog, and every discovered project, then persists the result.

Usage:
  ak system [options]

Options:
  --deep    re-run the full scan now (minutes on a large machine), then persist it
  --json    emit the snapshot payload verbatim — the same shape /api/system serves

Examples:
  ak system              install totals, runtime census, storage, catalog, projects
  ak system --deep       re-measure everything, then print it
  ak system --json       machine-readable snapshot (no scan)
  ak system --deep --json  re-measure, then emit the fresh snapshot`;

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
 *  served from the persisted snapshot, even microseconds after --deep wrote it),
 *  so the scan date is stated ONCE here instead of on all several hundred lines
 *  — invariant 3 satisfied without burying the figures. */
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
    field('deep scan', dim(`never run — ${snap?.reason ?? 'no snapshot'}`));
  } else {
    const missing = snap.completeness?.missing ?? [];
    field('deep scan', `${fmtStamp(snap.asOf)} (${fmtDuration(snap.ageMs)} ago)`
      + (missing.length ? dim(` · ${missing.join(', ')} not measured`) : ''));
  }
}

function renderInstall(install) {
  deepHeading('Install', install);
  if (!install) {
    info(dim('not measured yet — run: ak system --deep'));
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
    info(dim('not measured yet — run: ak system --deep'));
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

function renderCatalog(catalog) {
  deepHeading('Catalog', catalog);
  if (!catalog) {
    info(dim('not measured yet — run: ak system --deep'));
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
  if (catalog.degraded?.length) info(dim(`unreadable surfaces: ${catalog.degraded.join(', ')}`));
  if (catalog.truncated?.length) {
    info(dim(`capped surfaces (counts are floors): ${catalog.truncated.join(', ')}`));
  }
}

function renderProjects(projects, now) {
  deepHeading('Projects', projects);
  if (!projects) {
    info(dim('not measured yet — run: ak system --deep'));
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

/** The staleness nudge — the ONLY thing that ever suggests a rescan. It never
 *  triggers one: a deep walk costs minutes, so it stays a human's decision. */
function renderNudge(snap) {
  if (!snap?.present) {
    info(`no deep scan on this machine yet — run: ${bold('ak system --deep')}`);
  } else if (snap.stale) {
    warn(`deep figures are ${fmtDuration(snap.ageMs)} old — refresh with: ${bold('ak system --deep')}`);
  }
}

/**
 * @param {{ flags: Record<string, any>,
 *           deps?: { collector?: ReturnType<typeof createSystemCollector>,
 *                    cwd?: string, now?: () => number } }} input
 */
export async function run({ flags, deps = {} }) {
  const collector = deps.collector ?? createSystemCollector({ cwd: deps.cwd ?? process.cwd() });
  const now = deps.now ?? Date.now;

  let scan = null;
  if (flags.deep) {
    // refreshDeep never rejects by contract; it reports failure in its result so
    // a partly-completed scan still yields the sections that DID finish.
    scan = await withProgress('deep scan', () => collector.refreshDeep(), {
      // The ticker owns a stdout line via \r-rewrites — it must never interleave
      // with a --json payload.
      tty: process.stdout.isTTY && !flags.json,
    });
  }

  // The collector assembles the deep sections by spread, so the inferred return
  // type cannot name install/storage/catalog/projects. The wire shape is the
  // contract (ADR-0025); widening here reads it without restating it.
  /** @type {Record<string, any>} */
  const snapshot = await collector.read();

  if (flags.json) {
    console.log(JSON.stringify(snapshot, null, 2));
    return scan && !scan.ok ? 1 : 0;
  }

  renderSummary(snapshot);
  if (scan) {
    if (scan.ok) ok(`deep scan complete in ${fmtDuration(snapshot.scan?.durationMs ?? 0)}`);
    else warn(`deep scan failed: ${scan.error}`);
    // A scan that measured everything but could not write the file is still a
    // successful measurement — say which of the two happened.
    if (scan.ok && scan.error) warn(scan.error);
  }
  renderInstall(snapshot.install);
  renderRuntime(snapshot.runtime);
  renderStorage(snapshot.storage);
  renderCatalog(snapshot.catalog);
  renderProjects(snapshot.projects, now());
  console.log('');
  renderNudge(snapshot.snapshot);
  return scan && !scan.ok ? 1 : 0;
}
