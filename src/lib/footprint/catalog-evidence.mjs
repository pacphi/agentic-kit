// Evidence helpers for the machine-footprint catalog. This module may inspect
// bounded metadata and compute digests, but it never returns artifact bodies.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { measured, unknown } from './walk.mjs';

export const CATALOG_ARTIFACT_MAX_BYTES = 1024 * 1024;

export function pluginRefParts(ref) {
  const value = String(ref ?? '');
  const at = value.lastIndexOf('@');
  if (at <= 0 || at >= value.length - 1) {
    return { ref: value, name: value, marketplace: null };
  }
  return { ref: value, name: value.slice(0, at), marketplace: value.slice(at + 1) };
}

/** SHA-256 a small regular file. The bytes die here; only bounded metadata and
 * the digest leave this function. Symlinks and oversized files stay explicit
 * unknowns rather than being followed or silently omitted.
 * @param {string} file
 * @param {{ fsImpl?: typeof fs, asOf?: number|null, maxBytes?: number }} [options] */
export function artifactDigest(file, {
  fsImpl = fs, asOf = null, maxBytes = CATALOG_ARTIFACT_MAX_BYTES,
} = {}) {
  try {
    const stat = fsImpl.lstatSync(file);
    if (stat.isSymbolicLink()) return unknown('artifact is a symlink');
    if (!stat.isFile()) return unknown('artifact is not a regular file');
    if (stat.size > maxBytes) return unknown(`artifact exceeds ${maxBytes} byte digest limit`);
    const bytes = fsImpl.readFileSync(file);
    if (bytes.length > maxBytes) return unknown(`artifact exceeds ${maxBytes} byte digest limit`);
    return measured(createHash('sha256').update(bytes).digest('hex'), { asOf });
  } catch (error) {
    return unknown(error?.code ?? 'io');
  }
}

/** Hash a complete, bounded directory definition. Relative paths, node kind,
 * mode, size and file hashes participate; bodies and member paths do not leave
 * the collector. A symlink, special node or cap makes equality unknown. */
export function artifactTreeDigest(root, {
  fsImpl = fs, asOf = null, maxEntries = 512,
  maxFileBytes = CATALOG_ARTIFACT_MAX_BYTES, maxTotalBytes = 8 * CATALOG_ARTIFACT_MAX_BYTES,
} = {}) {
  const records = [];
  const files = [];
  let totalBytes = 0;
  let failure = null;
  const visit = (current, relative = '') => {
    if (failure) return;
    let stat;
    try { stat = fsImpl.lstatSync(current); } catch (error) {
      failure = error?.code ?? 'io'; return;
    }
    if (stat.isSymbolicLink()) { failure = 'artifact tree contains a symlink'; return; }
    if (records.length >= maxEntries) { failure = `artifact tree exceeds ${maxEntries} entry limit`; return; }
    const mode = stat.mode & 0o777;
    if (stat.isDirectory()) {
      records.push({ path: relative || '.', kind: 'directory', mode });
      let names;
      try { names = fsImpl.readdirSync(current).map(String).sort(); } catch (error) {
        failure = error?.code ?? 'io'; return;
      }
      for (const name of names) visit(path.join(current, name), relative ? `${relative}/${name}` : name);
      return;
    }
    if (!stat.isFile()) { failure = 'artifact tree contains a special file'; return; }
    if (stat.size > maxFileBytes || totalBytes + stat.size > maxTotalBytes) {
      failure = 'artifact tree exceeds byte digest limit'; return;
    }
    let bytes;
    try { bytes = fsImpl.readFileSync(current); } catch (error) {
      failure = error?.code ?? 'io'; return;
    }
    totalBytes += bytes.length;
    files.push(current);
    records.push({
      path: relative, kind: 'file', mode, size: bytes.length,
      digest: createHash('sha256').update(bytes).digest('hex'),
    });
  };
  visit(root);
  if (failure) return { ...unknown(failure), files: [] };
  return {
    ...measured(createHash('sha256').update(JSON.stringify(records)).digest('hex'), { asOf }),
    files,
  };
}

function commandJson(binary, args, run) {
  let result;
  try {
    result = run(binary, args, {
      encoding: 'utf8', timeout: 15_000, maxBuffer: 8 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NO_COLOR: '1' },
    });
  } catch (error) {
    return { status: 'degraded', reason: error?.code ?? error?.message ?? 'spawn failed', plugins: [] };
  }
  if (result?.error?.code === 'ENOENT') return { status: 'unsupported', reason: 'binary not installed', plugins: [] };
  if (result?.error) return { status: 'degraded', reason: result.error.code ?? result.error.message, plugins: [] };
  if (result?.status !== 0) {
    return { status: 'degraded', reason: `command exited ${String(result?.status)}`, plugins: [] };
  }
  try {
    return { status: 'ok', reason: null, value: JSON.parse(result.stdout), plugins: [] };
  } catch {
    return { status: 'degraded', reason: 'command returned invalid JSON', plugins: [] };
  }
}

function normalizeClaude(result) {
  if (result.status !== 'ok') return { ...result, source: 'claude plugin list --json' };
  if (!Array.isArray(result.value)) {
    return { status: 'degraded', reason: 'unexpected Claude plugin-list schema', plugins: [],
      source: 'claude plugin list --json' };
  }
  return {
    status: 'ok', reason: null, source: 'claude plugin list --json',
    plugins: result.value.flatMap((row) => {
      if (!row || typeof row.id !== 'string' || !row.id) return [];
      const parts = pluginRefParts(row.id);
      return [{
        ...parts,
        version: typeof row.version === 'string' ? row.version : null,
        enabled: typeof row.enabled === 'boolean' ? row.enabled : null,
        scope: typeof row.scope === 'string' ? row.scope : 'unknown',
        root: typeof row.installPath === 'string' && path.isAbsolute(row.installPath) ? row.installPath : null,
        installedAt: typeof row.installedAt === 'string' ? row.installedAt : null,
        lastUpdated: typeof row.lastUpdated === 'string' ? row.lastUpdated : null,
        evidence: 'native',
      }];
    }),
  };
}

function normalizeCodex(result) {
  if (result.status !== 'ok') return { ...result, source: 'codex plugin list --json' };
  const rows = Array.isArray(result.value?.installed) ? result.value.installed : null;
  if (!rows) {
    return { status: 'degraded', reason: 'unexpected Codex plugin-list schema', plugins: [],
      source: 'codex plugin list --json' };
  }
  return {
    status: 'ok', reason: null, source: 'codex plugin list --json',
    plugins: rows.flatMap((row) => {
      if (!row || typeof row.pluginId !== 'string' || !row.pluginId) return [];
      const parts = pluginRefParts(row.pluginId);
      return [{
        ...parts,
        version: typeof row.version === 'string' ? row.version : null,
        enabled: typeof row.enabled === 'boolean' ? row.enabled : null,
        scope: 'user',
        // Native Codex reports the marketplace source tree, not necessarily the
        // installed cache generation. catalog.mjs joins the inspected cache root
        // separately and never treats this path as a cleanup target.
        root: null,
        sourceKind: typeof row.source?.source === 'string' ? row.source.source : 'unknown',
        installPolicy: typeof row.installPolicy === 'string' ? row.installPolicy : null,
        authPolicy: typeof row.authPolicy === 'string' ? row.authPolicy : null,
        evidence: 'native',
      }];
    }),
  };
}

/** Read-only native plugin inventory. This is called only by a deep scan using
 * the real filesystem; fixture-backed unit collectors retain deterministic
 * manifest/config fallbacks. */
export function collectNativePluginInventory({ run = spawnSync } = {}) {
  return {
    claude: normalizeClaude(commandJson('claude', ['plugin', 'list', '--json'], run)),
    codex: normalizeCodex(commandJson('codex', ['plugin', 'list', '--json'], run)),
  };
}

function matchingPresence(item, { host, scope, project }) {
  return (item.presence ?? []).some((presence) => presence.host === host
    && presence.scope === scope
    && (scope !== 'project' || presence.project === project));
}

function scopedCount(items, surfaces, { host, kind, scope, project, asOf }) {
  const relevant = surfaces.filter((surface) => surface.host === host
    && surface.kind === kind && surface.scope === scope
    && (scope !== 'project' || surface.project === project));
  if (!relevant.length) return unknown(`${scope} ${kind} surface is not supported for ${host}`);
  const readable = relevant.filter((surface) => surface.status !== 'degraded');
  if (!readable.length) return unknown(relevant.map((surface) => surface.reason).filter(Boolean).join('; ') || 'unreadable');
  const value = items.filter((item) => item.kind === kind
    && matchingPresence(item, { host, scope, project })).length;
  const partial = relevant.some((surface) => surface.status === 'degraded' || surface.partial);
  return measured(value, { asOf, partial });
}

function digestValue(presence) {
  return presence?.digest?.value && presence.digest.status !== 'unknown' ? presence.digest.value : null;
}

function overlapMeasurement(projectItems, sharedItems, field, asOf) {
  const projectValues = new Set(projectItems.map(field).filter(Boolean));
  const sharedValues = new Set(sharedItems.map(field).filter(Boolean));
  let overlap = 0;
  for (const value of projectValues) if (sharedValues.has(value)) overlap++;
  const missing = [...projectItems, ...sharedItems].some((entry) => !field(entry));
  return measured(overlap, { asOf, partial: missing });
}

function skillOccurrences(items, host, scopes, project) {
  const out = [];
  for (const item of items.filter((candidate) => candidate.kind === 'skill')) {
    for (const presence of item.presence ?? []) {
      if (presence.host !== host || !scopes.includes(presence.scope)) continue;
      if (presence.scope === 'project' && presence.project !== project) continue;
      out.push({ name: item.capabilityName ?? item.name, digest: digestValue(presence) });
    }
  }
  return out;
}

/** Project-oriented contribution and overlap read model. User/plugin counts are
 * repeated intentionally: they are the shared capabilities a project sees in
 * addition to its own tree. No host context-cutoff claim is inferred. */
export function buildProjectPressure({ items, surfaces, projects, launchingProject, hosts, kinds, asOf }) {
  const launching = launchingProject ? path.resolve(launchingProject) : null;
  return [...new Set((projects ?? []).filter(Boolean).map((project) => path.resolve(project)))]
    .sort().map((project) => {
      const byHost = {};
      const guidance = [];
      for (const host of hosts) {
        const sources = {};
        for (const scope of ['project', 'user', 'plugin']) {
          sources[scope] = Object.fromEntries(kinds.map((kind) => [kind,
            scopedCount(items, surfaces, { host, kind, scope, project, asOf })]));
        }
        const projectSkills = skillOccurrences(items, host, ['project'], project);
        const sharedSkills = skillOccurrences(items, host, ['user', 'plugin'], project);
        const nameOverlap = overlapMeasurement(projectSkills, sharedSkills, (entry) => entry.name, asOf);
        const digestOverlap = overlapMeasurement(projectSkills, sharedSkills, (entry) => entry.digest, asOf);
        byHost[host] = { sources, overlaps: { skillNames: nameOverlap, skillDigests: digestOverlap } };
        if (projectSkills.length) {
          guidance.push({
            host, code: 'project-skill-contribution', level: nameOverlap.value ? 'review' : 'info',
            message: `${projectSkills.length} project-scoped skill${projectSkills.length === 1 ? '' : 's'} observed; ${nameOverlap.value} name overlap${nameOverlap.value === 1 ? '' : 's'} with user/plugin sources`,
            nextCommand: `ak x skills plan --project ${JSON.stringify(project)}`,
          });
        }
      }
      const relevant = surfaces.filter((surface) => ['user', 'plugin'].includes(surface.scope)
        || (surface.scope === 'project' && surface.project === project));
      const gaps = relevant.filter((surface) => surface.status === 'degraded' || surface.partial)
        .map((surface) => ({ surface: surface.id, reason: surface.reason ?? 'partial' }));
      return {
        project, label: path.basename(project) || project, launching: project === launching, byHost, guidance,
        complete: gaps.length === 0, gaps,
        contextInclusion: {
          status: 'unknown',
          reason: 'host-owned context inclusion and cutoff are not exposed by this catalog',
        },
      };
    });
}

function sourceStamp(at, fsImpl) {
  try {
    const stat = fsImpl.lstatSync(at);
    return {
      path: at, present: true,
      kind: stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : stat.isSymbolicLink() ? 'symlink' : 'other',
      bytes: stat.isFile() ? stat.size : null, mtimeMs: stat.mtimeMs,
    };
  } catch (error) {
    return { path: at, present: false, kind: null, bytes: null, mtimeMs: null, reason: error?.code ?? 'io' };
  }
}

/** Persist bounded stat-only probes so the cheap tier can notice likely catalog
 * drift without re-reading bodies or triggering a deep scan.
 * @param {{ surfaces?: any[], items?: any[], fsImpl?: typeof fs, maxPaths?: number }} [options] */
export function buildCatalogSourceStamps({ surfaces, items, fsImpl = fs, maxPaths = 512 } = {}) {
  const activeSurfaces = (surfaces ?? []).filter((surface) => surface.status !== 'absent')
    .map((surface) => surface.path);
  const artifacts = (items ?? []).flatMap((item) => item.presence ?? [])
    .map((presence) => presence.sourceFile).filter(Boolean);
  const paths = [...new Set([...activeSurfaces, ...artifacts])].sort();
  return {
    entries: paths.slice(0, maxPaths).map((at) => sourceStamp(at, fsImpl)),
    partial: paths.length > maxPaths,
    observedPaths: Math.min(paths.length, maxPaths),
    totalCandidatePaths: paths.length,
    limitation: 'stat probes detect watched path changes; unobserved nested content requires a deep rescan',
  };
}

export function probeCatalogDrift(baseline, { fsImpl = fs, asOf = Date.now() } = {}) {
  if (!baseline || !Array.isArray(baseline.entries)) {
    return { status: 'unknown', changed: [], checkedAt: asOf, partial: true, reason: 'no catalog source-stamp baseline' };
  }
  const changed = [];
  let unreadable = 0;
  for (const before of baseline.entries) {
    const after = sourceStamp(before.path, fsImpl);
    if (after.reason && after.reason !== 'ENOENT') unreadable++;
    if (before.present !== after.present || before.kind !== after.kind
      || before.bytes !== after.bytes || before.mtimeMs !== after.mtimeMs) {
      changed.push({ path: before.path, before, after });
    }
  }
  return {
    status: changed.length ? 'changed' : 'unchanged-at-probes', changed,
    checkedAt: asOf, partial: baseline.partial === true || unreadable > 0,
    reason: changed.length ? 'watched catalog sources changed since the deep scan'
      : baseline.limitation ?? 'nested content was not revalidated',
  };
}
