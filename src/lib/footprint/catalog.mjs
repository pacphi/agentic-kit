// Catalog inventory — the deduplicated set of skills, agents, commands, plugins,
// and MCP servers actually deployed across hosts, each with a per-host presence
// matrix (which host carries it, observed from which surface).
//
// OBSERVED inventory only (ADR-0025 invariant 10): this module reports what is on
// disk per host surface and never reads, mirrors, or upgrades Integration
// management's desired state.
//
// Counting is by NAME — directory entries, manifest keys, TOML table names. Item
// bodies are never parsed (invariant 1). Directory surfaces go through the shared
// bounded walker, which is why nothing here follows a symlink or escapes a root;
// the manifest surfaces are single-file reads of keys, the same spawn-free seam
// mcp.mjs already uses because `claude mcp list` health-checks every server and
// has no stable schema.
//
// The single content read is the managed-block sentinel scan on guidance files,
// which ADR-0025's config-surface row explicitly sanctions; it retains a count
// and nothing else.
import fs from 'node:fs';
import path from 'node:path';
import {
  claudeDir, claudeSettingsPath, claudeUserMcpPath,
  codexDir, codexConfigPath,
  opencodeDir, opencodeConfigPath,
  projectSettings, projectSettingsLocal, repoRoot,
} from '../paths.mjs';
import { readJson } from '../settings.mjs';
import { inspectCodexPlugins } from '../codex-plugins.mjs';
import { registry, blocksForTarget, guidanceTargets, hasBlock } from '../blocks.mjs';
import { walkTree, statNode, measured, unknown } from './walk.mjs';

/** Per-surface name cap. A capped surface reports truncated — its count is then a
 *  floor, never a total. */
const MAX_NAMES = 4096;

export const CATALOG_KINDS = ['skill', 'agent', 'command', 'plugin', 'mcpServer'];
export const CATALOG_HOSTS = ['claude', 'codex', 'opencode'];

/** Any BEGIN sentinel, kit-managed or not — the count of foreign or orphaned
 *  blocks is the interesting half of "what is deployed in my guidance files". */
const SENTINEL_RE = /^<!-- BEGIN [^>]+ -->$/gm;

// ── surface readings ──────────────────────────────────────────────────────────

/**
 * One surface's names plus how the read went, in the same three-valued vocabulary
 * usage-index's rootHealth uses: 'ok' (read it), 'absent' (nothing there — a real
 * zero), 'degraded' (could not look — unknown, never zero). `partial` marks a
 * count that is a floor because a cap fired or a subtree was unreadable.
 * @typedef {{ status: 'ok'|'absent'|'degraded', reason: string|null,
 *             names: string[], partial: boolean, truncated: boolean }} SurfaceReading
 */

const emptyReading = (status, reason) => ({ status, reason, names: [], partial: false, truncated: false });

/**
 * Names below `root`, one per file the walker accepts. `nameOf` turns the accepted
 * file's path into the catalog name — the ':'-joined relative path a host uses to
 * namespace nested entries.
 *
 * Scope is enforced with `skipDir` rather than `maxDepth` on purpose: a catalog
 * surface is a shallow name space, and everything below it is an item's own
 * reference material, not another item. Pruning it is a deliberate scope (the
 * walker does not call that truncation), whereas a depth cap would mark every
 * skill that ships a `references/` folder as an incomplete measurement.
 */
function readNames(root, { accept, nameOf, dirDepth, walk = walkTree, limits = {}, fsImpl = fs }) {
  const names = [];
  const result = walk(root, {
    ...limits, fsImpl,
    skipDir: (dir, name, depth) => depth > dirDepth,
    acceptFile: (name) => accept(name),
    onFile: ({ file }) => {
      if (names.length >= MAX_NAMES) return;
      const name = nameOf(file);
      if (name) names.push(name);
    },
  });
  if (result.status === 'unknown') {
    return emptyReading(result.reason === 'ENOENT' ? 'absent' : 'degraded', result.reason);
  }
  const truncated = Boolean(result.truncated) || names.length >= MAX_NAMES;
  return {
    status: 'ok',
    reason: result.degraded?.[0]?.reason ?? null,
    names,
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
  ...opts,
});

/** `*.md` entries below `root`. A README documents the surface rather than being
 *  an entry on it, so it is excluded instead of counted as a command. */
const readMarkdownNames = (root, opts = {}) => readNames(root, {
  dirDepth: 3,
  accept: (name) => name.endsWith('.md') && !/^readme\.md$/i.test(name),
  nameOf: (file) => relativeName(root, file, { strip: '.md' }),
  ...opts,
});

/** Top-level files with one of `exts`, named by basename without the extension. */
const readFileStems = (root, exts, opts = {}) => readNames(root, {
  dirDepth: 0,
  accept: (name) => exts.includes(path.extname(name)),
  nameOf: (file) => path.basename(file, path.extname(file)),
  ...opts,
});

/** Keys of one object inside a JSON manifest. */
function readManifestKeys(file, pick, { fsImpl = fs } = {}) {
  const head = statNode(file, { fsImpl });
  if (head.status === 'unknown') {
    return emptyReading(head.reason === 'ENOENT' ? 'absent' : 'degraded', head.reason);
  }
  const doc = readJson(file, null);
  if (doc === null) return emptyReading('degraded', 'EPARSE');
  const bag = pick(doc);
  if (!bag || typeof bag !== 'object') return { ...emptyReading('ok', null), names: [] };
  return { status: 'ok', reason: null, names: Object.keys(bag), partial: false, truncated: false };
}

/** TOML table names under `section` — the same regex-over-source approach
 *  codex-plugins' enabledPluginRefs uses, because codex owns config.toml and this
 *  kit only ever observes it. Exported for tests. */
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
  return { status: 'ok', reason: null, names: tomlTableNames(source, section), partial: false, truncated: false };
}

/** Claude's installed-plugin manifest: `{ plugins: { "<id>@<marketplace>": [ … ] } }`.
 *  Returns the plugin ids plus the newest install root per id — the roots the
 *  plugin-provided skill/agent/command surfaces hang off. */
function readClaudePlugins(file, { fsImpl = fs } = {}) {
  const head = statNode(file, { fsImpl });
  if (head.status === 'unknown') {
    return { ...emptyReading(head.reason === 'ENOENT' ? 'absent' : 'degraded', head.reason), roots: [] };
  }
  const doc = readJson(file, null);
  if (doc === null) return { ...emptyReading('degraded', 'EPARSE'), roots: [] };
  const names = [];
  const roots = [];
  for (const [ref, installs] of Object.entries(doc?.plugins ?? {})) {
    const id = ref.includes('@') ? ref.slice(0, ref.lastIndexOf('@')) : ref;
    names.push(id);
    const newest = (Array.isArray(installs) ? installs : []).at(-1);
    if (newest?.installPath) roots.push({ id, root: newest.installPath });
  }
  return { status: 'ok', reason: null, names, partial: false, truncated: false, roots };
}

// ── surface specs ─────────────────────────────────────────────────────────────

/**
 * Every catalog surface this machine could carry, as data. A surface that does
 * not exist reads 'absent' and contributes a real zero — which is why a host's
 * documented-but-unused convention (codex prompts, opencode commands) is safe to
 * list: it costs one stat and can never fabricate an entry.
 */
function surfaceSpecs(roots, io) {
  const { claudeRoot, claudeMcpFile, codexRoot, codexConfigFile, opencodeRoot, opencodeConfigFile,
    cwd, projects } = roots;
  const at = (base, ...rest) => path.join(base, ...rest);
  const specs = [];

  // claude — user scope
  specs.push({ id: 'claude-skills', host: 'claude', kind: 'skill', path: at(claudeRoot, 'skills'),
    read: (p) => readMarkerDirs(p, 'SKILL.md', io) });
  specs.push({ id: 'claude-agents', host: 'claude', kind: 'agent', path: at(claudeRoot, 'agents'),
    read: (p) => readMarkdownNames(p, io) });
  specs.push({ id: 'claude-commands', host: 'claude', kind: 'command', path: at(claudeRoot, 'commands'),
    read: (p) => readMarkdownNames(p, io) });
  specs.push({ id: 'claude-plugins', host: 'claude', kind: 'plugin',
    path: at(claudeRoot, 'plugins', 'installed_plugins.json'),
    read: (p) => readClaudePlugins(p, io) });
  specs.push({ id: 'claude-user-mcp', host: 'claude', kind: 'mcpServer', path: claudeMcpFile,
    read: (p) => readManifestKeys(p, (d) => d?.mcpServers, io) });

  // claude — project scope. The repo root is the same seam mcp.mjs's codexMcpStatus
  // reads; outside a repo there is simply no project surface to report.
  const projectRoot = repoRoot(cwd);
  if (projectRoot) {
    specs.push({ id: 'claude-project-mcp', host: 'claude', kind: 'mcpServer',
      path: at(projectRoot, '.mcp.json'), read: (p) => readManifestKeys(p, (d) => d?.mcpServers, io) });
  }

  // Project-scoped skills, agents and commands, across the launching repository
  // plus EVERY project the host census has observed on this machine. A fresh
  // repository has no transcript yet, so the launching root is load-bearing.
  //
  // A catalog that reads user scope plus one repo answers "what can I use right
  // here", which is not the question this panel asks: it is the machine's
  // deployed inventory, and a skill defined in one repo is as installed as one
  // in ~/.claude. Deduplication by (kind, name) means a name defined in five
  // projects is still one row, so the list grows with distinct NAMES rather
  // than with project count.
  //
  // Costs four stats per project against an already-bounded project list; a
  // project directory that is gone simply reads absent. Resolve and deduplicate
  // because the launching repository normally also appears in the census.
  const catalogProjects = [...new Set([
    projectRoot,
    ...(projects ?? []),
  ].filter(Boolean).map((project) => path.resolve(project)))];
  for (const project of catalogProjects) {
    const root = at(project, '.claude');
    specs.push({ id: `claude-project-skills:${project}`, host: 'claude', kind: 'skill',
      path: at(root, 'skills'), read: (p) => readMarkerDirs(p, 'SKILL.md', io) });
    specs.push({ id: `claude-project-agents:${project}`, host: 'claude', kind: 'agent',
      path: at(root, 'agents'), read: (p) => readMarkdownNames(p, io) });
    specs.push({ id: `claude-project-commands:${project}`, host: 'claude', kind: 'command',
      path: at(root, 'commands'), read: (p) => readMarkdownNames(p, io) });
    specs.push({ id: `codex-project-skills:${project}`, host: 'codex', kind: 'skill',
      path: at(project, '.agents', 'skills'), read: (p) => readMarkerDirs(p, 'SKILL.md', io) });
  }

  // codex
  specs.push({ id: 'codex-skills', host: 'codex', kind: 'skill', path: at(codexRoot, 'skills'),
    read: (p) => readMarkerDirs(p, 'SKILL.md', io) });
  specs.push({ id: 'codex-prompts', host: 'codex', kind: 'command', path: at(codexRoot, 'prompts'),
    read: (p) => readMarkdownNames(p, io) });
  specs.push({ id: 'codex-mcp', host: 'codex', kind: 'mcpServer', path: codexConfigFile,
    read: (p) => readTomlTables(p, 'mcp_servers', io) });

  // opencode
  specs.push({ id: 'opencode-agents', host: 'opencode', kind: 'agent', path: at(opencodeRoot, 'agents'),
    read: (p) => readMarkdownNames(p, io) });
  specs.push({ id: 'opencode-skills', host: 'opencode', kind: 'skill', path: at(opencodeRoot, 'skills'),
    read: (p) => readMarkerDirs(p, 'SKILL.md', io) });
  specs.push({ id: 'opencode-commands', host: 'opencode', kind: 'command', path: at(opencodeRoot, 'command'),
    read: (p) => readMarkdownNames(p, io) });
  specs.push({ id: 'opencode-plugins', host: 'opencode', kind: 'plugin', path: at(opencodeRoot, 'plugins'),
    read: (p) => readFileStems(p, ['.js', '.mjs', '.cjs', '.ts'], io) });
  specs.push({ id: 'opencode-mcp', host: 'opencode', kind: 'mcpServer', path: opencodeConfigFile,
    read: (p) => readManifestKeys(p, (d) => d?.mcp, io) });

  return specs;
}

/**
 * Sub-surfaces contributed by an installed plugin's own cache directory. Names are
 * namespaced `<plugin>:<entry>` — the convention the hosts themselves use, and
 * what keeps a plugin's `migrate` command distinct from a user's.
 *
 * Two layouts are in the wild and both are read: content at the plugin root
 * (`skills/`) and content under a nested `.claude/` (the same shape opencode's
 * catalogSource probes for on a ruflo checkout). A plugin using one layout reports
 * the other absent; an item found in both dedupes to one row with two presence
 * entries.
 */
function pluginSubSurfaces(host, pluginId, root, idPrefix, io) {
  const specs = [];
  for (const [tag, base] of [['', root], ['dot', path.join(root, '.claude')]]) {
    const id = (kind) => `${idPrefix}:${pluginId}:${tag ? `${tag}-` : ''}${kind}`;
    specs.push({ id: id('skills'), host, kind: 'skill', path: path.join(base, 'skills'),
      prefix: pluginId, read: (p) => readMarkerDirs(p, 'SKILL.md', io) });
    specs.push({ id: id('agents'), host, kind: 'agent', path: path.join(base, 'agents'),
      prefix: pluginId, read: (p) => readMarkdownNames(p, io) });
    specs.push({ id: id('commands'), host, kind: 'command', path: path.join(base, 'commands'),
      prefix: pluginId, read: (p) => readMarkdownNames(p, io) });
  }
  // A plugin may ship its own MCP servers; those are registered under the
  // plugin's identity, not the user's, so they carry the plugin namespace too.
  specs.push({ id: `${idPrefix}:${pluginId}:mcp`, host, kind: 'mcpServer',
    path: path.join(root, '.mcp.json'), prefix: pluginId,
    read: (p) => readManifestKeys(p, (d) => d?.mcpServers, io) });
  return specs;
}

// ── config surface ────────────────────────────────────────────────────────────

/** Size of a known file. A missing file is a measured zero flagged
 *  `present: false`, so a renderer says "not present" rather than printing 0 B. */
function fileSize(file, { asOf = null, fsImpl = fs } = {}) {
  const node = statNode(file, { fsImpl });
  if (node.status === 'unknown') {
    return node.reason === 'ENOENT'
      ? { ...measured(0, { asOf }), present: false, mtimeMs: null, path: file }
      : { ...unknown(node.reason), present: null, mtimeMs: null, path: file };
  }
  return { ...measured(node.bytes ?? 0, { asOf }), present: true, mtimeMs: node.mtimeMs, path: file };
}

/**
 * The config-surface row: how many managed blocks each guidance file carries and
 * how big the settings files are. Guidance files are the one place this domain
 * reads content, and it reads only sentinel LINES — `hasBlock` answers "is this
 * registry slug present" and the sentinel regex counts BEGIN markers. No prose,
 * no block bodies, nothing retained past the count.
 *
 * @param {{ cwd?: string, cfg?: { customBlocks?: object[] }, asOf?: number|null,
 *           extraSettingsFiles?: Array<{ id: string, label: string, path: string }>,
 *           fsImpl?: typeof fs }} [options]
 */
export function collectConfigSurface({
  cwd = process.cwd(),
  cfg = /** @type {{ customBlocks?: object[] }} */ ({}),
  asOf = null,
  extraSettingsFiles = [],
  fsImpl = fs,
} = {}) {
  const rows = registry(cfg?.customBlocks ?? []);
  const guidance = [];
  for (const target of guidanceTargets({ cwd })) {
    const bytes = fileSize(target.file, { asOf, fsImpl });
    const expected = blocksForTarget(rows, target.name);
    let content;
    try { content = fsImpl.readFileSync(target.file, 'utf8'); } catch (error) {
      const absent = error.code === 'ENOENT';
      guidance.push({
        name: target.name, label: target.label, path: target.file, bytes,
        managed: absent ? measured(0, { asOf }) : unknown(error.code ?? 'io'),
        observed: absent ? measured(0, { asOf }) : unknown(error.code ?? 'io'),
        expected: expected.length,
        slugs: [],
      });
      continue;
    }
    const present = expected.filter((row) => hasBlock(content, row.slug));
    const observed = (content.match(SENTINEL_RE) ?? []).length;
    guidance.push({
      name: target.name,
      label: target.label,
      path: target.file,
      bytes,
      managed: measured(present.length, { asOf }),
      observed: measured(observed, { asOf }),
      expected: expected.length,
      slugs: present.map((row) => row.slug),
    });
    // `content` dies with this iteration: the counts above are the whole payload,
    // and no prose from a guidance file leaves this scope.
  }

  const projectRoot = repoRoot(cwd);
  const settings = [
    { id: 'claude-settings', label: '~/.claude/settings.json', file: claudeSettingsPath() },
    { id: 'claude-user-mcp', label: '~/.claude.json', file: claudeUserMcpPath() },
    { id: 'codex-config', label: '~/.codex/config.toml', file: codexConfigPath() },
    { id: 'opencode-config', label: 'opencode.json', file: opencodeConfigPath() },
  ];
  if (projectRoot) {
    settings.push({ id: 'project-settings', label: '.claude/settings.json', file: projectSettings(projectRoot) });
    settings.push({ id: 'project-settings-local', label: '.claude/settings.local.json', file: projectSettingsLocal(projectRoot) });
  }
  for (const extra of extraSettingsFiles) settings.push({ id: extra.id, label: extra.label, file: extra.path });

  return {
    guidance,
    settings: settings.map((row) => ({ id: row.id, label: row.label, ...fileSize(row.file, { asOf, fsImpl }) })),
  };
}

// ── assembly ──────────────────────────────────────────────────────────────────

/** Dedup key. Case and surrounding whitespace are presentation, not identity;
 *  kind is part of the key because a `tester` agent and a `tester` command are two
 *  different deployed things. */
const itemKey = (kind, name) => `${kind}::${name.trim().toLowerCase()}`;

/**
 * Additional catalog specs contributed by installed plugins' own cache
 * directories, discovered from the plugin manifests themselves (Claude's
 * `installed_plugins.json`, codex's inspected plugin cache) rather than
 * hardcoded. A codex read failure is that host's problem, not this catalog's —
 * it must never take the rest of the specs down with it.
 */
function pluginSurfaceSpecs({ claudeRoot, codexConfigFile, inspectCodexPlugins: inspect, io }) {
  const specs = [];
  const claudePlugins = readClaudePlugins(path.join(claudeRoot, 'plugins', 'installed_plugins.json'), io);
  for (const { id, root } of claudePlugins.roots) {
    specs.push(...pluginSubSurfaces('claude', id, root, 'claude-plugin', io));
  }
  let codexPlugins = { configPresent: false, plugins: [] };
  try { codexPlugins = inspect({ configFile: codexConfigFile }) ?? codexPlugins; }
  catch { codexPlugins = { configPresent: false, plugins: [] }; }
  for (const plugin of codexPlugins.plugins ?? []) {
    if (!plugin?.root || !plugin?.ref) continue;
    const id = plugin.ref.includes('@') ? plugin.ref.slice(0, plugin.ref.lastIndexOf('@')) : plugin.ref;
    specs.push(...pluginSubSurfaces('codex', id, plugin.root, 'codex-plugin', io));
  }
  // Codex's enabled refs ARE that host's plugin inventory.
  const enabled = (codexPlugins.plugins ?? []).map((plugin) => plugin?.ref).filter(Boolean);
  specs.push({
    id: 'codex-plugins', host: 'codex', kind: 'plugin', path: codexConfigFile,
    read: () => (codexPlugins.configPresent === false
      ? emptyReading('absent', 'ENOENT')
      : { status: 'ok', reason: null, names: enabled, partial: false, truncated: false }),
  });
  return specs;
}

/** Add one spec's names to the deduplicated CatalogItem map. A plugin-sourced
 *  name carries its plugin's namespace prefix, exactly as the surface declared. */
function mergeCatalogItem(items, spec, raw) {
  const name = spec.prefix ? `${spec.prefix}:${raw}` : raw;
  const key = itemKey(spec.kind, name);
  let item = items.get(key);
  if (!item) {
    item = { key, kind: spec.kind, name, hosts: [], presence: [] };
    items.set(key, item);
  }
  if (!item.hosts.includes(spec.host)) item.hosts.push(spec.host);
  item.presence.push({ host: spec.host, surface: spec.id, path: spec.path });
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
      path: spec.path,
      status: reading.status,
      reason: reading.reason ?? null,
      partial: Boolean(reading.partial),
      truncated: Boolean(reading.truncated),
      // A degraded surface has NO count: we did not look, so there is no number.
      count: reading.status === 'degraded' ? null : reading.names.length,
    });
    if (reading.status === 'degraded') continue;
    for (const raw of reading.names) mergeCatalogItem(items, spec, raw);
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
  return [...items.values()].sort((a, b) => (a.kind === b.kind
    ? a.name.localeCompare(b.name)
    : CATALOG_KINDS.indexOf(a.kind) - CATALOG_KINDS.indexOf(b.kind)));
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
 *           codexConfigFile?: string, opencodeRoot?: string, opencodeConfigFile?: string,
 *           cwd?: string, projects?: string[], cfg?: object, now?: () => number, walk?: Function,
 *           limits?: object, fsImpl?: typeof fs,
 *           inspectCodexPlugins?: Function, includePluginSurfaces?: boolean }} [options]
 * @returns {object} CatalogInventory
 */
export function collectCatalog({
  claudeRoot = claudeDir(),
  claudeMcpFile = claudeUserMcpPath(),
  codexRoot = codexDir(),
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
  includePluginSurfaces = true,
} = {}) {
  const asOf = now();
  const io = { walk, limits, fsImpl };
  const roots = { claudeRoot, claudeMcpFile, codexRoot, codexConfigFile, opencodeRoot, opencodeConfigFile,
    cwd, projects };
  const specs = surfaceSpecs(roots, io);
  if (includePluginSurfaces) {
    specs.push(...pluginSurfaceSpecs({ claudeRoot, codexConfigFile, inspectCodexPlugins: inspectCodexPluginsImpl, io }));
  }

  const { items, surfaces } = readCatalogSurfaces(specs);
  const { incomplete, incompleteByHost } = trackIncompleteness(surfaces);
  const list = sortCatalogItems(items);
  const counts = tallyCatalogCounts(list, asOf, incomplete);
  const perHost = tallyCatalogPerHost(list, asOf, incompleteByHost);
  const degraded = surfaces.filter((surface) => surface.status === 'degraded').map((surface) => surface.id);
  const truncated = surfaces.filter((surface) => surface.truncated).map((surface) => surface.id);

  return {
    asOf,
    hosts: CATALOG_HOSTS,
    kinds: CATALOG_KINDS,
    items: list,
    counts,
    perHost,
    surfaces,
    config: collectConfigSurface({ cwd, cfg, asOf, fsImpl }),
    complete: degraded.length === 0 && truncated.length === 0,
    degraded,
    truncated,
  };
}
