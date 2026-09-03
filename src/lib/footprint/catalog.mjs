// Read-only CatalogInventory v2 (ADR-0025): canonical standalone/plugin identity,
// per-source occurrences, and bounded entrypoint digests. Bodies never leave the
// collector; traversal never follows a symlink or escapes a declared root.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  claudeDir, claudeUserMcpPath,
  codexDir, codexConfigPath, home,
  opencodeDir, opencodeConfigPath,
} from '../paths.mjs';
import { readJson } from '../settings.mjs';
import { inspectCodexPlugins } from '../codex-plugins.mjs';
import { walkTree, statNode, measured } from './walk.mjs';
import {
  artifactDigest, artifactTreeDigest, buildCatalogSourceStamps, buildProjectPressure, collectNativePluginInventory, pluginRefParts,
} from './catalog-evidence.mjs';
import { collectConfigSurface } from './catalog-config.mjs';
import { inspectProjectArtifacts, summarizeArtifactTracking } from './catalog-project-evidence.mjs';
import { catalogSurfaceSpecs, pluginCapabilitySpecs } from './catalog-surfaces.mjs';

export { collectConfigSurface } from './catalog-config.mjs';

/** A capped surface reports a floor, never a total. */
const MAX_NAMES = 4096;
const ARTIFACT_FILES = Symbol('catalogArtifactFiles');
const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
};

export const CATALOG_KINDS = ['skill', 'agent', 'command', 'plugin', 'mcpServer'];
export const CATALOG_HOSTS = ['claude', 'codex', 'opencode'];

// ── surface readings ──────────────────────────────────────────────────────────

/**
 * One surface's names plus how the read went, in the same three-valued vocabulary
 * usage-index's rootHealth uses: 'ok' (read it), 'absent' (nothing there — a real
 * zero), 'degraded' (could not look — unknown, never zero). `partial` marks a
 * count that is a floor because a cap fired or a subtree was unreadable.
 * @typedef {{ status: 'ok'|'absent'|'degraded', reason: string|null,
 *             names: string[], entries?: object[], partial: boolean, truncated: boolean }} SurfaceReading
 */

const emptyReading = (status, reason) => ({
  status, reason, names: [], entries: [], partial: false, truncated: false,
});

/** Read accepted names without descending into an item's reference material. */
function readNames(root, {
  accept, nameOf, entryOf = null, dirDepth, walk = walkTree, limits = {}, fsImpl = fs,
}) {
  const names = [];
  const entries = [];
  const result = walk(root, {
    ...limits, fsImpl,
    skipDir: (dir, name, depth) => depth > dirDepth,
    acceptFile: (name) => accept(name),
    onFile: ({ file }) => {
      if (names.length >= MAX_NAMES) return;
      const name = nameOf(file);
      if (name) {
        names.push(name);
        entries.push({ name, ...(entryOf ? entryOf(file, name) : {}) });
      }
    },
  });
  if (result.status === 'unknown') {
    return emptyReading(result.reason === 'ENOENT' ? 'absent' : 'degraded', result.reason);
  }
  const truncated = Boolean(result.truncated) || names.length >= MAX_NAMES;
  return {
    status: 'ok',
    reason: result.degraded?.[0]?.reason ?? null,
    names, entries,
    partial: result.complete === false || truncated,
    truncated,
  };
}

/** ':'-joined path of `file` relative to `root`, minus a trailing extension. */
function relativeName(root, file, { strip = '' } = {}) {
  let rel = path.relative(root, file);
  if (!rel || rel.startsWith('..')) return null;
  if (strip && rel.endsWith(strip)) rel = rel.slice(0, -strip.length);
  return rel.split(path.sep).filter(Boolean).join(':');
}

/** Directories carrying `marker` (SKILL.md), named by their path below `root`.
 *  Two directory levels: a bare `<skill>/` and a namespaced `<plugin>/<skill>/`. */
const readMarkerDirs = (root, marker, opts = {}) => readNames(root, {
  dirDepth: 2,
  accept: (name) => name === marker,
  nameOf: (file) => relativeName(root, path.dirname(file)),
  entryOf: (file) => {
    const definition = artifactTreeDigest(path.dirname(file), opts);
    return {
      itemPath: path.dirname(file), sourceFile: file,
      digest: artifactDigest(file, opts), definition: { ...definition, files: undefined },
      artifactFiles: definition.files ?? [],
    };
  },
  ...opts,
});

/** Markdown entries; README documents the surface and is not an entry. */
const readMarkdownNames = (root, opts = {}) => readNames(root, {
  dirDepth: 3,
  accept: (name) => name.endsWith('.md') && !/^readme\.md$/i.test(name),
  nameOf: (file) => relativeName(root, file, { strip: '.md' }),
  entryOf: (file) => ({ itemPath: file, sourceFile: file, digest: artifactDigest(file, opts),
    definition: artifactDigest(file, opts), artifactFiles: [file] }),
  ...opts,
});

/** Top-level files with one of `exts`, named by basename without the extension. */
const readFileStems = (root, exts, opts = {}) => readNames(root, {
  dirDepth: 0,
  accept: (name) => exts.includes(path.extname(name)),
  nameOf: (file) => path.basename(file, path.extname(file)),
  entryOf: (file) => ({ itemPath: file, sourceFile: file, digest: artifactDigest(file, opts),
    definition: artifactDigest(file, opts), artifactFiles: [file] }),
  ...opts,
});

/** Keys of one object inside a JSON manifest. */
function readManifestKeys(file, pick, { fsImpl = fs } = {}) {
  const head = statNode(file, { fsImpl });
  if (head.status === 'unknown') {
    return emptyReading(head.reason === 'ENOENT' ? 'absent' : 'degraded', head.reason);
  }
  let doc;
  try { doc = JSON.parse(fsImpl.readFileSync(file, 'utf8')); }
  catch { return emptyReading('degraded', 'EPARSE'); }
  const bag = pick(doc);
  if (!bag || typeof bag !== 'object') return { ...emptyReading('ok', null), names: [] };
  const names = Object.keys(bag);
  const configDigest = (value) => measured(createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex'));
  return { status: 'ok', reason: null, names, entries: names.map((name) => ({
    name, itemPath: file, sourceFile: file, digest: configDigest(bag[name]),
    definition: configDigest(bag[name]), artifactFiles: [file],
  })), partial: false, truncated: false };
}

/** TOML table names under `section`, exported for tests. */
export function tomlTableNames(source, section) {
  const names = [];
  const re = new RegExp(
    `^\\[\\s*${section}\\s*\\.\\s*(?:"((?:[^"\\\\]|\\\\.)+)"|'([^']+)'|([A-Za-z0-9_.\\-]+))\\s*\\]\\s*$`,
    'gm',
  );
  let match;
  while ((match = re.exec(source)) !== null) {
    const quoted = match[1];
    names.push(quoted ? quoted.replace(/\\"/g, '"').replace(/\\\\/g, '\\') : (match[2] ?? match[3]));
  }
  return names;
}

function readTomlTables(file, section, { fsImpl = fs } = {}) {
  let source;
  try { source = fsImpl.readFileSync(file, 'utf8'); } catch (error) {
    return emptyReading(error.code === 'ENOENT' ? 'absent' : 'degraded', error.code ?? 'io');
  }
  const names = tomlTableNames(source, section);
  const headers = [...source.matchAll(/^[ \t]*\[(?!\[)([^\]\n]+)\][ \t]*(?:#.*)?$/gm)];
  const digestFor = (name) => {
    const quoted = `${section}."${name.replace(/"/g, '\\"')}"`;
    const bare = `${section}.${name}`;
    const blocks = headers.flatMap((header, index) => {
      const table = header[1].trim();
      const isBase = table === bare || table === quoted;
      const isChild = table.startsWith(`${bare}.`) || table.startsWith(`${quoted}.`);
      if (!isBase && !isChild) return [];
      const body = source.slice(header.index + header[0].length, headers[index + 1]?.index ?? source.length);
      const suffix = isBase ? '' : table.slice((table.startsWith(quoted) ? quoted : bare).length);
      const lines = body.split(/\r?\n/).map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#')).sort();
      return [{ suffix, lines }];
    }).sort((a, b) => a.suffix.localeCompare(b.suffix));
    return measured(createHash('sha256').update(JSON.stringify(blocks)).digest('hex'));
  };
  return { status: 'ok', reason: null, names, entries: names.map((name) => ({
    name, itemPath: file, sourceFile: file, digest: digestFor(name), definition: digestFor(name), artifactFiles: [file],
  })), partial: false, truncated: false };
}

/** Claude's installed-plugin manifest and newest install root per full ref. */
function readClaudePlugins(file, { fsImpl = fs } = {}) {
  const head = statNode(file, { fsImpl });
  if (head.status === 'unknown') {
    return { ...emptyReading(head.reason === 'ENOENT' ? 'absent' : 'degraded', head.reason), roots: [] };
  }
  const doc = readJson(file, null);
  if (doc === null) return { ...emptyReading('degraded', 'EPARSE'), roots: [] };
  const names = [];
  const entries = [];
  const roots = [];
  for (const [ref, installs] of Object.entries(doc?.plugins ?? {})) {
    const parts = pluginRefParts(ref);
    names.push(ref);
    const newest = (Array.isArray(installs) ? installs : []).at(-1);
    const plugin = {
      ...parts,
      version: typeof newest?.version === 'string' ? newest.version : null,
      enabled: null,
      scope: typeof newest?.scope === 'string' ? newest.scope : 'unknown',
      root: typeof newest?.installPath === 'string' ? newest.installPath : null,
      installedAt: typeof newest?.installedAt === 'string' ? newest.installedAt : null,
      lastUpdated: typeof newest?.lastUpdated === 'string' ? newest.lastUpdated : null,
      evidence: 'manifest',
    };
    entries.push({ name: ref, plugin });
    if (plugin.root) roots.push(plugin);
  }
  return { status: 'ok', reason: null, names, entries, partial: false, truncated: false, roots };
}

// ── assembly ──────────────────────────────────────────────────────────────────

/** Dedup key. Case and surrounding whitespace are presentation, not identity;
 *  kind is part of the key because a `tester` agent and a `tester` command are two
 *  different deployed things. */
const itemKey = (kind, name) => `${kind}::${name.trim().toLowerCase()}`;
const fallbackInventoryStatus = (configPresent) => (configPresent === false ? 'degraded' : 'partial');

/** Plugin inventories plus enabled plugins' capability surfaces. */
function pluginSurfaceSpecs({
  claudeRoot, codexConfigFile, inspectCodexPlugins: inspect, io, readers,
  nativePlugins, includeComponents,
}) {
  const specs = [];
  const sources = {};
  const claudeFallback = readClaudePlugins(path.join(claudeRoot, 'plugins', 'installed_plugins.json'), io);
  const fallbackByRef = new Map(claudeFallback.entries.map((entry) => [entry.name, entry.plugin]));
  let codexPlugins = { configPresent: false, plugins: [] };
  try { codexPlugins = inspect({ configFile: codexConfigFile }) ?? codexPlugins; }
  catch { codexPlugins = { configPresent: false, plugins: [] }; }
  const codexByRef = new Map((codexPlugins.plugins ?? [])
    .filter((plugin) => plugin?.ref).map((plugin) => [plugin.ref, plugin]));

  const inventory = {};
  const nativeClaude = nativePlugins?.claude;
  if (nativeClaude?.status === 'ok') {
    inventory.claude = nativeClaude.plugins.map((plugin) => ({
      ...plugin, root: plugin.root ?? fallbackByRef.get(plugin.ref)?.root ?? null,
    }));
    sources.claude = { status: 'ok', authority: 'host-native', source: nativeClaude.source, reason: null };
  } else {
    inventory.claude = claudeFallback.entries.map((entry) => entry.plugin);
    sources.claude = {
      status: claudeFallback.status === 'degraded' ? 'degraded' : 'partial', authority: 'manifest-fallback',
      source: 'installed_plugins.json', reason: nativeClaude?.reason ?? claudeFallback.reason ?? 'native inventory not measured',
    };
  }
  const nativeCodex = nativePlugins?.codex;
  if (nativeCodex?.status === 'ok') {
    inventory.codex = nativeCodex.plugins.map((plugin) => ({
      ...plugin,
      root: codexByRef.get(plugin.ref)?.root ?? null,
      cacheGeneration: codexByRef.get(plugin.ref)?.version ?? null,
    }));
    sources.codex = { status: 'ok', authority: 'host-native', source: nativeCodex.source, reason: null };
  } else {
    inventory.codex = [...codexByRef.entries()].map(([ref, plugin]) => ({
      ...pluginRefParts(ref), version: plugin.version ?? null, cacheGeneration: plugin.version ?? null,
      root: plugin.root ?? null, enabled: true, scope: 'user', evidence: 'config-cache-fallback',
    }));
    sources.codex = {
      status: fallbackInventoryStatus(codexPlugins.configPresent), authority: 'config-cache-fallback',
      source: 'config.toml + plugin cache', reason: nativeCodex?.reason ?? 'native inventory not measured',
    };
  }

  for (const host of ['claude', 'codex']) {
    const plugins = inventory[host];
    const source = sources[host];
    specs.push({
      id: `${host}-plugins`, host, kind: 'plugin', scope: 'plugin',
      path: host === 'claude' ? path.join(claudeRoot, 'plugins', 'installed_plugins.json') : codexConfigFile,
      read: () => ({
        status: source.status === 'degraded' ? 'degraded' : 'ok', reason: source.reason,
        names: plugins.map((plugin) => plugin.ref),
        entries: plugins.map((plugin) => ({ name: plugin.ref, plugin })),
        partial: source.status === 'partial', truncated: false,
      }),
    });
    if (!includeComponents) continue;
    for (const plugin of plugins) {
      if (!plugin?.root || !plugin?.ref || plugin.enabled === false) continue;
      specs.push(...pluginCapabilitySpecs(host, plugin, plugin.root, readers, io));
    }
  }
  return { specs, sources };
}

/** Add one spec's names to the deduplicated CatalogItem map. A plugin-sourced
 *  name carries its plugin's namespace prefix, exactly as the surface declared. */
function mergeCatalogItem(items, spec, entry) {
  const raw = entry.name;
  const name = spec.prefix ? `${spec.prefix}:${raw}` : raw;
  const key = spec.provider
    ? itemKey(spec.kind, `plugin:${spec.provider.ref}:${raw}`)
    : itemKey(spec.kind, name);
  let item = items.get(key);
  if (!item) {
    item = {
      key, canonicalId: key, kind: spec.kind, name,
      capabilityName: raw, pluginRef: spec.provider?.ref ?? null,
      hosts: [], sourceScopes: [], presence: [],
    };
    items.set(key, item);
  }
  if (!item.hosts.includes(spec.host)) item.hosts.push(spec.host);
  if (!item.sourceScopes.includes(spec.scope)) item.sourceScopes.push(spec.scope);
  const provider = spec.provider ? {
    ref: spec.provider.ref, name: spec.provider.name, marketplace: spec.provider.marketplace,
    version: spec.provider.version ?? null, cacheGeneration: spec.provider.cacheGeneration ?? null,
    enabled: spec.provider.enabled ?? null, evidence: spec.provider.evidence ?? null,
  } : null;
  const presence = {
    host: spec.host, surface: spec.id, path: spec.path,
    itemPath: entry.itemPath ?? null, sourceFile: entry.sourceFile ?? null,
    scope: spec.scope ?? 'unknown', project: spec.project ?? null,
    provider, plugin: entry.plugin ?? null, digest: entry.digest ?? null,
    definition: entry.definition ?? entry.digest ?? null,
  };
  Object.defineProperty(presence, ARTIFACT_FILES, { value: entry.artifactFiles ?? [], enumerable: false });
  item.presence.push(presence);
}

function addProjectTracking(items, inspect) {
  const byProject = new Map();
  for (const item of items.values()) for (const presence of item.presence) {
    if (presence.scope !== 'project' || !presence.project) continue;
    const files = presence[ARTIFACT_FILES];
    if (!files.length) continue;
    if (!byProject.has(presence.project)) byProject.set(presence.project, []);
    byProject.get(presence.project).push({ presence, files });
  }
  for (const [project, occurrences] of byProject) {
    const files = [...new Set(occurrences.flatMap((entry) => entry.files))];
    let facts;
    try { facts = inspect(project, files); } catch { facts = new Map(); }
    for (const occurrence of occurrences) {
      occurrence.presence.tracking = summarizeArtifactTracking(occurrence.files, facts);
    }
  }
}

/** Read every spec once, folding hits into deduplicated CatalogItems and
 *  per-surface status rows in the same pass. */
function readCatalogSurfaces(specs) {
  const items = new Map();
  const surfaces = [];
  for (const spec of specs) {
    const reading = spec.read(spec.path);
    surfaces.push({
      id: spec.id,
      host: spec.host,
      kind: spec.kind,
      scope: spec.scope ?? 'unknown',
      project: spec.project ?? null,
      provider: spec.provider ? { ref: spec.provider.ref, version: spec.provider.version ?? null } : null,
      path: spec.path,
      status: reading.status,
      reason: reading.reason ?? null,
      partial: Boolean(reading.partial),
      truncated: Boolean(reading.truncated),
      // A degraded surface has NO count: we did not look, so there is no number.
      count: reading.status === 'degraded' ? null : reading.names.length,
    });
    if (reading.status === 'degraded') continue;
    for (const entry of reading.entries ?? reading.names.map((name) => ({ name }))) {
      mergeCatalogItem(items, spec, entry);
    }
  }
  return { items, surfaces };
}

/** Which kinds — overall, and per host — a degraded or capped surface touched.
 *  Feeds the `partial` flag on each count below, never a silent omission. */
function trackIncompleteness(surfaces) {
  const incomplete = new Set();
  const incompleteByHost = new Set();
  for (const surface of surfaces) {
    if (surface.status !== 'degraded' && !surface.partial) continue;
    incomplete.add(surface.kind);
    incompleteByHost.add(`${surface.host}::${surface.kind}`);
  }
  return { incomplete, incompleteByHost };
}

/** Deduplicated items, ranked by kind (in the documented CATALOG_KINDS order)
 *  then by name. */
function sortCatalogItems(items) {
  const list = [...items.values()];
  for (const item of list) {
    const digests = item.presence.map((presence) => presence.digest?.value).filter(Boolean);
    const unique = [...new Set(digests)];
    item.digestCoverage = {
      measured: digests.length,
      unknown: item.presence.length - digests.length,
      unique: unique.length,
      exactMatch: digests.length > 1 && unique.length === 1,
    };
    item.variantCount = Math.max(unique.length, unique.length ? 1 : 0);
  }
  return list.sort((a, b) => (a.kind === b.kind
    ? a.name.localeCompare(b.name)
    : CATALOG_KINDS.indexOf(a.kind) - CATALOG_KINDS.indexOf(b.kind)));
}

function buildOverlapGroups(list) {
  const nameGroups = new Map();
  const digestGroups = new Map();
  for (const item of list.filter((candidate) => candidate.kind === 'skill')) {
    const name = item.capabilityName.trim().toLowerCase();
    if (!nameGroups.has(name)) nameGroups.set(name, []);
    nameGroups.get(name).push(item);
    for (const digest of new Set(item.presence.map((presence) => presence.digest?.value).filter(Boolean))) {
      if (!digestGroups.has(digest)) digestGroups.set(digest, []);
      digestGroups.get(digest).push(item);
    }
  }
  const mapGroups = (groups, field) => [...groups.entries()].flatMap(([value, items]) => {
    const occurrences = items.reduce((sum, item) => sum + item.presence.length, 0);
    if (items.length < 2 && occurrences < 2) return [];
    return [{ [field]: value, itemKeys: items.map((item) => item.key), occurrences }];
  });
  const measuredDigests = list.filter((item) => item.kind === 'skill')
    .flatMap((item) => item.presence).filter((presence) => presence.digest?.value).length;
  const total = list.filter((item) => item.kind === 'skill')
    .reduce((sum, item) => sum + item.presence.length, 0);
  return {
    exactName: mapGroups(nameGroups, 'name'),
    exactEntrypointDigest: mapGroups(digestGroups, 'digest'),
    digestCoverage: { measured: measuredDigests, unknown: total - measuredDigests, partial: measuredDigests < total },
  };
}

/** Total count per kind, `partial` when any surface feeding that kind was
 *  unreadable or capped. */
function tallyCatalogCounts(list, asOf, incomplete) {
  const counts = {};
  for (const kind of CATALOG_KINDS) {
    const value = list.filter((item) => item.kind === kind).length;
    counts[kind] = measured(value, { asOf, partial: incomplete.has(kind) });
  }
  return counts;
}

/** The same tally, sliced per host. */
function tallyCatalogPerHost(list, asOf, incompleteByHost) {
  const perHost = {};
  for (const host of CATALOG_HOSTS) {
    perHost[host] = {};
    for (const kind of CATALOG_KINDS) {
      const value = list.filter((item) => item.kind === kind && item.hosts.includes(host)).length;
      perHost[host][kind] = measured(value, { asOf, partial: incompleteByHost.has(`${host}::${kind}`) });
    }
  }
  return perHost;
}

/**
 * Read every host catalog surface and fold it into deduplicated CatalogItems.
 *
 * A count is `partial` when any surface feeding it was unreadable or capped: the
 * value is then a measured LOWER BOUND. Calling it complete would overstate the
 * evidence; calling it unknown would throw away what was actually observed.
 *
 * @param {{ claudeRoot?: string, claudeMcpFile?: string, codexRoot?: string,
 *           agentsRoot?: string,
 *           codexConfigFile?: string, opencodeRoot?: string, opencodeConfigFile?: string,
 *           cwd?: string, projects?: string[], cfg?: object, now?: () => number, walk?: Function,
 *           limits?: object, fsImpl?: typeof fs,
 *           inspectCodexPlugins?: Function, collectNativePlugins?: Function,
 *           nativePlugins?: object, includePluginSurfaces?: boolean }} [options]
 * @returns {object} CatalogInventory
 */
export function collectCatalog({
  claudeRoot = claudeDir(),
  claudeMcpFile = claudeUserMcpPath(),
  codexRoot = codexDir(),
  agentsRoot = path.join(home, '.agents'),
  codexConfigFile = codexConfigPath(),
  opencodeRoot = opencodeDir(),
  opencodeConfigFile = opencodeConfigPath(),
  cwd = process.cwd(),
  // On-disk project paths from the shared census (ADR-0027). Absent → user
  // scope plus the launching repo only, exactly as before.
  projects = [],
  cfg = {},
  now = Date.now,
  walk = walkTree,
  limits = {},
  fsImpl = fs,
  inspectCodexPlugins: inspectCodexPluginsImpl = inspectCodexPlugins,
  collectNativePlugins = collectNativePluginInventory,
  nativePlugins = null,
  includePluginSurfaces = true,
  inspectProjectArtifacts: inspectProjectArtifactsImpl = inspectProjectArtifacts,
} = {}) {
  const asOf = now();
  const io = { walk, limits, fsImpl };
  const roots = { claudeRoot, claudeMcpFile, codexRoot, agentsRoot, codexConfigFile, opencodeRoot, opencodeConfigFile,
    cwd, projects };
  const readers = {
    marker: readMarkerDirs, markdown: readMarkdownNames, stems: readFileStems,
    manifest: readManifestKeys, toml: readTomlTables,
  };
  const base = catalogSurfaceSpecs(roots, readers, io);
  const observedNative = nativePlugins ?? (fsImpl === fs ? collectNativePlugins() : null);
  const plugins = pluginSurfaceSpecs({
    claudeRoot, codexConfigFile, inspectCodexPlugins: inspectCodexPluginsImpl, io, readers,
    nativePlugins: observedNative, includeComponents: includePluginSurfaces,
  });
  const specs = [...base.specs, ...plugins.specs];

  const { items, surfaces } = readCatalogSurfaces(specs);
  addProjectTracking(items, inspectProjectArtifactsImpl);
  const { incomplete, incompleteByHost } = trackIncompleteness(surfaces);
  const list = sortCatalogItems(items);
  const counts = tallyCatalogCounts(list, asOf, incomplete);
  const perHost = tallyCatalogPerHost(list, asOf, incompleteByHost);
  const degraded = surfaces.filter((surface) => surface.status === 'degraded').map((surface) => surface.id);
  const truncated = surfaces.filter((surface) => surface.truncated).map((surface) => surface.id);
  const partial = surfaces.filter((surface) => surface.partial).map((surface) => surface.id);

  return {
    schemaVersion: 3,
    asOf,
    hosts: CATALOG_HOSTS,
    kinds: CATALOG_KINDS,
    items: list,
    counts,
    perHost,
    surfaces,
    scopes: ['user', 'project', 'plugin'],
    pluginSources: plugins.sources,
    sourceStamps: buildCatalogSourceStamps({ surfaces, items: list, fsImpl }),
    overlaps: buildOverlapGroups(list),
    projects: buildProjectPressure({
      items: list, surfaces, projects: base.catalogProjects, launchingProject: base.launchingProject,
      hosts: CATALOG_HOSTS, kinds: CATALOG_KINDS, asOf,
    }),
    config: collectConfigSurface({ cwd, cfg, asOf, fsImpl }),
    complete: degraded.length === 0 && truncated.length === 0 && partial.length === 0,
    degraded,
    truncated,
    partial,
  };
}
