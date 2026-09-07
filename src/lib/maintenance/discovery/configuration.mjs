// ADR-0048 Discovery configuration — the curated automatic-source catalogue and
// the read/validate/write surface over `kit.json`'s `maintenance.discovery`
// intent (docs/design/maintenance-overhaul/discovery-and-scan-policy.md).
//
// This module never touches the filesystem beyond `validateRoot`'s bounded,
// injected probes: it reads and writes user INTENT, not scan results. Every
// mutating export returns `{ preview, commit() }` — nothing is saved until the
// caller calls `commit()` — matching MNT-DSC-003/004's preview-then-confirm
// contract. No import/export surface exists here by design (MNT-DSC-006).
import fs from 'node:fs';
import path from 'node:path';

import { opaqueId } from '../management/model.mjs';
import { readInstructionFileEvidence } from './instruction-files.mjs';

/** The curated automatic sources every fresh installation gets without any
 *  configuration (MNT-DSC-001). `inspects` is a one-line factual statement of
 *  what the source reads, shown in Discovery — never a path. */
/** Curated, source-level traversal policy for the filesystem host sources
 *  (MNT-DSC exclusions are coverage evidence, applied before content parsing).
 *  A host's user directory mixes capability sources (skills, agents, commands,
 *  plugins, hooks, instruction files, settings) with transcript, session,
 *  cache, and tool-state trees that are never capability placements and can
 *  run tens of thousands of entries deep. The names below are top-level
 *  directories under that host's user root that a discovery scan skips by
 *  NAME, so a stable host source can reach `complete` instead of stopping at
 *  a safety ceiling inside its own transcript history. `maxDepth` bounds the
 *  remaining walk relative to the host root. Neither weakens user
 *  exclusions, symlink, special-node, or ceiling safety. */
export const HOST_SOURCE_POLICY = Object.freeze({
  'claude-user': Object.freeze({
    skipDirs: Object.freeze(['projects', 'todos', 'shell-snapshots', 'statsig', 'file-history', 'debug',
      'session-env', 'sessions', 'local', 'ide', 'cache', 'paste-cache', 'downloads', 'backups', 'jobs',
      'daemon', 'chrome', 'feedback', 'history', 'live-monitor', 'security', 'metaharness', 'model-router',
      'ruvnet-brain', 'node_modules']),
    maxDepth: 6,
  }),
  'codex-user': Object.freeze({
    skipDirs: Object.freeze(['sessions', 'logs', 'log', 'cache', 'browser', 'computer-use', 'generated_images',
      'ambient-suggestions', 'dictation-history', 'mcp-oauth-locks', 'ipc', 'tmp', 'node_modules']),
    maxDepth: 6,
  }),
  'opencode-user': Object.freeze({
    skipDirs: Object.freeze(['node_modules', '.cache', 'cache', 'log', 'logs', 'storage', 'snapshot', 'repos', 'project']),
    maxDepth: 6,
  }),
  'hermes-user': Object.freeze({
    skipDirs: Object.freeze(['sessions', 'logs', 'log', 'cache', 'node_modules']),
    maxDepth: 6,
  }),
});

export const AUTOMATIC_SOURCES = Object.freeze([
  { id: 'claude-user', label: 'Claude user configuration', environmentKinds: ['macos', 'linux', 'windows', 'wsl'], defaultEnabled: true, inspects: 'Claude Code user-level configuration, skills, plugins, and hooks (transcript, session, and cache trees are skipped)' },
  { id: 'codex-user', label: 'Codex user configuration', environmentKinds: ['macos', 'linux', 'windows', 'wsl'], defaultEnabled: true, inspects: 'Codex user-level configuration, hooks, and AGENTS.md (session, log, and cache trees are skipped)' },
  { id: 'opencode-user', label: 'OpenCode user configuration', environmentKinds: ['macos', 'linux', 'windows', 'wsl'], defaultEnabled: true, inspects: 'OpenCode user-level configuration, agents, and skills (dependency and cache trees are skipped)' },
  { id: 'hermes-user', label: 'Hermes user configuration', environmentKinds: ['macos', 'linux', 'windows', 'wsl'], defaultEnabled: true, inspects: 'Hermes user-level configuration (session, log, and cache trees are skipped)' },
  { id: 'projects', label: 'Projects', environmentKinds: ['macos', 'linux', 'windows', 'wsl'], defaultEnabled: true, inspects: 'Every project a recorded host session has visited' },
  { id: 'runtimes', label: 'Runtimes', environmentKinds: ['macos', 'linux', 'windows', 'wsl'], defaultEnabled: true, inspects: 'Installed language and tool runtimes on PATH' },
  { id: 'package-managers', label: 'Package managers', environmentKinds: ['macos', 'linux', 'windows', 'wsl'], defaultEnabled: true, inspects: 'Installed package managers and their declared versions' },
  { id: 'ollama', label: 'Ollama', environmentKinds: ['macos', 'linux', 'windows', 'wsl'], defaultEnabled: true, inspects: 'The local Ollama model library, over loopback only' },
  { id: 'providers', label: 'Providers', environmentKinds: ['macos', 'linux', 'windows', 'wsl'], defaultEnabled: true, inspects: 'Configured LLM provider bindings and credential mechanisms' },
]);

const AUTOMATIC_SOURCE_IDS = new Set(AUTOMATIC_SOURCES.map((source) => source.id));
export const BOUNDARY_KINDS = Object.freeze(['network', 'removable', 'cloud-placeholder', 'wsl-boundary']);

const CLOUD_PLACEHOLDER_SEGMENTS = /(?:^|[\\/])(dropbox|onedrive|google drive|googledrive|icloud drive|icloud~|cloudDocs)(?:[\\/]|$)/iu;
const WSL_UNC_PATTERN = /^\\\\wsl(?:\$|\.localhost)\\/iu;

function plainSegments(root) {
  return root.split(/[\\/]+/u).filter(Boolean);
}

/** Best-effort, injectable classification of a root's filesystem boundary.
 *  Heuristic and conservative: an unrecognized root classifies as local (null)
 *  rather than guessing a boundary it cannot prove, matching the "excluded
 *  by default, opt-in per exact root" policy for the boundaries it CAN prove.
 *
 * @param {string} root
 * @param {{ fsImpl?: typeof fs, platform?: string }} [options]
 */
export function defaultClassifyBoundary(root, { platform = process.platform } = {}) {
  if (WSL_UNC_PATTERN.test(root)) return 'wsl-boundary';
  if (platform === 'win32' && /^\\\\[^\\]+\\[^\\]+/u.test(root)) return 'network';
  if (platform !== 'win32' && root.startsWith('//')) return 'network';
  if (CLOUD_PLACEHOLDER_SEGMENTS.test(root)) return 'cloud-placeholder';
  if (platform === 'darwin' && root.startsWith('/Volumes/')) return 'removable';
  if (platform === 'linux') {
    if (root.startsWith('/mnt/') || root.startsWith('/media/')) return 'removable';
    // A Linux root under WSL exposes the Windows host filesystem here.
    if (/^\/mnt\/[a-z]\//iu.test(root) && process.env?.WSL_DISTRO_NAME) return 'wsl-boundary';
  }
  return null;
}

function rejectRoot(reason) {
  return { valid: false, reason, boundary: null, requiresOptIn: false };
}

/** Validate a candidate discovery root. Absolute, lexically normalized, no
 *  traversal escape, not a symlink, and a real directory. A recognized
 *  boundary (network/removable/cloud-placeholder/host-WSL) is reported and
 *  requires exact per-root opt-in (MNT-DSC-008); it never widens any other
 *  safety constraint. */
export function validateRoot(root, {
  fsImpl = fs, platform = process.platform, classifyBoundary = defaultClassifyBoundary,
  includeNetwork = false,
} = {}) {
  if (typeof root !== 'string' || !root) return rejectRoot('root must be a non-empty string');
  if (!path.isAbsolute(root)) return rejectRoot('root must be an absolute path');
  // Checked on the RAW input, not the normalized form: `path.normalize` silently
  // collapses a `..` segment, which would resolve a traversal-looking root to a
  // different directory than the one written rather than refusing it.
  if (plainSegments(root).includes('..')) return rejectRoot('root must not escape via ..');
  const normalized = path.normalize(root);
  let stat;
  try { stat = fsImpl.lstatSync(normalized); }
  catch (error) { return rejectRoot(error?.code === 'ENOENT' ? 'root does not exist' : (error?.code ?? 'root unreadable')); }
  if (stat.isSymbolicLink()) return rejectRoot('root must not be a symlink; add its resolved target as a separate source');
  if (!stat.isDirectory()) return rejectRoot('root must be a directory');
  const boundary = classifyBoundary(normalized, { fsImpl, platform });
  if (boundary && !includeNetwork) {
    return {
      valid: false, reason: `root crosses a ${boundary} boundary and requires explicit opt-in`, boundary, requiresOptIn: true,
    };
  }
  return { valid: true, reason: null, boundary, requiresOptIn: false };
}

function emptyDiscovery() {
  return { automaticSources: {}, exactProjects: [], collectionRoots: [], exclusions: [] };
}

/** The curated automatic sources joined with the user's kit.json overrides. */
export function readDiscoveryConfiguration({ loadConfig }) {
  const cfg = loadConfig();
  const raw = { ...emptyDiscovery(), ...cfg.maintenance?.discovery };
  return {
    automaticSources: AUTOMATIC_SOURCES.map((source) => ({
      ...source,
      enabled: typeof raw.automaticSources?.[source.id] === 'boolean'
        ? raw.automaticSources[source.id] : source.defaultEnabled,
    })),
    exactProjects: Array.isArray(raw.exactProjects) ? raw.exactProjects : [],
    collectionRoots: Array.isArray(raw.collectionRoots) ? raw.collectionRoots : [],
    exclusions: Array.isArray(raw.exclusions) ? raw.exclusions : [],
  };
}

function currentDiscovery(loadConfig) {
  const cfg = loadConfig();
  return { ...emptyDiscovery(), ...cfg.maintenance?.discovery };
}

function summarize(discovery) {
  return {
    automaticSources: { ...discovery.automaticSources },
    exactProjects: discovery.exactProjects.map((entry) => ({ ...entry })),
    collectionRoots: discovery.collectionRoots.map((entry) => ({ ...entry })),
    exclusions: discovery.exclusions.map((entry) => ({ ...entry })),
  };
}

/** Build a `{ preview, commit() }` pair. `mutate` receives a deep-cloned
 *  current discovery block and returns the proposed next one; nothing is
 *  persisted until `commit()` runs, and `commit()` re-reads kit.json so a
 *  concurrent unrelated change is not clobbered. */
function preparePlan({ loadConfig, saveConfig }, mutate) {
  const before = currentDiscovery(loadConfig);
  const after = mutate(structuredClone(before));
  return {
    preview: { before: summarize(before), after: summarize(after) },
    commit() {
      const fresh = loadConfig();
      const nextConfig = { ...fresh, maintenance: { ...fresh.maintenance, discovery: after } };
      saveConfig(nextConfig);
      return after;
    },
  };
}

function assertKnownAutomaticSource(sourceId) {
  if (!AUTOMATIC_SOURCE_IDS.has(sourceId)) throw new TypeError(`unknown automatic source id: ${sourceId}`);
}

export function setAutomaticSource({ sourceId, enabled }, deps) {
  assertKnownAutomaticSource(sourceId);
  return preparePlan(deps, (discovery) => {
    discovery.automaticSources = { ...discovery.automaticSources, [sourceId]: Boolean(enabled) };
    return discovery;
  });
}

function assertValidatedRoot(root, deps) {
  const result = validateRoot(root, deps);
  if (!result.valid) throw new TypeError(`invalid discovery root: ${result.reason}`);
  return result;
}

export function addExactProject({ root }, deps) {
  assertValidatedRoot(root, deps);
  const sourceId = opaqueId('src', { kind: 'exact-project', root }, deps.installationKey);
  return preparePlan(deps, (discovery) => {
    if (!discovery.exactProjects.some((entry) => entry.root === root)) {
      discovery.exactProjects = [...discovery.exactProjects, { root, sourceId }];
    }
    return discovery;
  });
}

export function addCollectionRoot({ root, maxDepth = null, includeNetwork = false }, deps) {
  const validation = validateRoot(root, { ...deps, includeNetwork });
  if (!validation.valid) throw new TypeError(`invalid discovery root: ${validation.reason}`);
  const sourceId = opaqueId('src', { kind: 'collection-root', root }, deps.installationKey);
  return preparePlan(deps, (discovery) => {
    if (!discovery.collectionRoots.some((entry) => entry.root === root)) {
      discovery.collectionRoots = [...discovery.collectionRoots, {
        root, sourceId, maxDepth, includeNetwork: Boolean(includeNetwork),
      }];
    }
    return discovery;
  });
}

export function removeSource({ sourceId }, deps) {
  return preparePlan(deps, (discovery) => {
    discovery.exactProjects = discovery.exactProjects.filter((entry) => entry.sourceId !== sourceId);
    discovery.collectionRoots = discovery.collectionRoots.filter((entry) => entry.sourceId !== sourceId);
    if (AUTOMATIC_SOURCE_IDS.has(sourceId)) {
      discovery.automaticSources = { ...discovery.automaticSources, [sourceId]: false };
    }
    return discovery;
  });
}

export function addExclusion({ path: exclusionPath, recursive = false }, deps) {
  if (typeof exclusionPath !== 'string' || !path.isAbsolute(exclusionPath)) {
    throw new TypeError('exclusion path must be absolute');
  }
  const normalized = path.normalize(exclusionPath);
  const exclusionId = opaqueId('exc', { path: normalized, recursive: Boolean(recursive) }, deps.installationKey);
  return preparePlan(deps, (discovery) => {
    if (!discovery.exclusions.some((entry) => entry.path === normalized && entry.recursive === Boolean(recursive))) {
      discovery.exclusions = [...discovery.exclusions, { exclusionId, path: normalized, recursive: Boolean(recursive) }];
    }
    return discovery;
  });
}

export function removeExclusion({ exclusionId }, deps) {
  return preparePlan(deps, (discovery) => {
    discovery.exclusions = discovery.exclusions.filter((entry) => entry.exclusionId !== exclusionId);
    return discovery;
  });
}

const FILESYSTEM_HOST_SOURCE_HELPERS = Object.freeze({
  'claude-user': 'claudeDir', 'codex-user': 'codexDir', 'opencode-user': 'opencodeDir', 'hermes-user': 'hermesDir',
});
const NON_FILESYSTEM_AUTOMATIC_SOURCES = Object.freeze(['runtimes', 'package-managers', 'ollama', 'providers']);
const PLATFORM_TO_ENVIRONMENT_KIND = Object.freeze({ darwin: 'macos', linux: 'linux', win32: 'windows' });
/** Automatic sources have no owning environment identity of their own — a
 *  real one requires the projection layer's environment machinery. `'local'`
 *  names THIS machine's current environment as a stable, non-opaque sentinel
 *  a caller can compare or replace before handing entries to the orchestrator. */
const LOCAL_ENVIRONMENT_ID = 'local';

function environmentKindFor(platform) {
  if (platform === 'linux' && process.env?.WSL_DISTRO_NAME) return 'wsl';
  return PLATFORM_TO_ENVIRONMENT_KIND[platform] ?? null;
}

/** The same `{ automatic: <id> }` opaque-id material the shared fixtures use
 *  (tests/fixtures/maintenance/management-fixtures.mjs). An automatic
 *  source's bare curated id ('claude-user', 'ollama', …) is never used
 *  directly as `sourceId` — every SourceCoverage.sourceId in the shared
 *  contract must satisfy the opaque `src_` grammar, and a coverage row for
 *  an automatic source is exactly as reachable as one for a user-added
 *  source once it flows into `orchestrator.coverage()`. */
function automaticSourceId(id, installationKey) {
  return opaqueId('src', { automatic: id }, installationKey);
}

/** The one user-level instruction file each host reads from its own home
 *  directory — distinct from `project-detection.mjs`'s PROJECT-root
 *  candidates. Only claude-user and codex-user carry one today. */
const USER_LEVEL_INSTRUCTION_FILES = Object.freeze({
  'claude-user': { name: 'CLAUDE.md', host: 'claude' },
  'codex-user': { name: 'AGENTS.md', host: 'codex' },
});

/** A filesystem host source (claude-user, codex-user, opencode-user,
 *  hermes-user) whose path helper is not yet available on `paths` — hermes
 *  today — or whose resolved root has never been created resolves to
 *  `present:false` rather than being dropped from the list. claude-user and
 *  codex-user additionally carry `instructionFiles`, WITH an explicit
 *  `present` flag per file (unlike `projects()`'s per-project list, which
 *  only reports what it actually found) — the source itself, and its one
 *  instruction file, may each be absent independently. */
function resolveFilesystemHostSource(source, { paths, fsImpl, installationKey }) {
  const helperName = FILESYSTEM_HOST_SOURCE_HELPERS[source.id];
  const dirFn = paths?.[helperName];
  const policy = HOST_SOURCE_POLICY[source.id] ?? { skipDirs: [], maxDepth: null };
  const base = {
    sourceId: automaticSourceId(source.id, installationKey), kind: 'automatic',
    environmentId: LOCAL_ENVIRONMENT_ID, label: source.label, filesystem: true,
    skipDirs: [...policy.skipDirs], maxDepth: policy.maxDepth,
  };
  if (typeof dirFn !== 'function') return { ...base, root: null, present: false };
  const root = dirFn();
  let present;
  try { present = fsImpl.existsSync(root); } catch { present = false; }
  const candidate = USER_LEVEL_INSTRUCTION_FILES[source.id];
  if (!candidate) return { ...base, root, present };
  const evidence = readInstructionFileEvidence(path.join(root, candidate.name), { fsImpl });
  return {
    ...base,
    root,
    present,
    instructionFiles: [{
      name: candidate.name, host: candidate.host, present: evidence.present,
      ...(evidence.digest ? { digest: evidence.digest } : {}),
    }],
  };
}

/** `projects` expands into the user's OWN configured exact projects and
 *  collection roots — not the separate host-transcript "every project ever
 *  seen" catalogue, which is not a bounded filesystem root a scan can walk. */
function expandProjectsSource(configuration) {
  const exact = configuration.exactProjects.map((entry) => ({
    sourceId: entry.sourceId, kind: 'exact-project', root: entry.root, environmentId: LOCAL_ENVIRONMENT_ID, label: 'Project',
  }));
  const collections = configuration.collectionRoots.map((entry) => ({
    sourceId: entry.sourceId, kind: 'collection-root', root: entry.root, environmentId: LOCAL_ENVIRONMENT_ID, label: 'Collection root',
  }));
  return [...exact, ...collections];
}

function resolveOneAutomaticSource(source, {
  configuration, paths, fsImpl, installationKey,
}) {
  if (source.id === 'projects') return expandProjectsSource(configuration);
  if (FILESYSTEM_HOST_SOURCE_HELPERS[source.id]) {
    return [resolveFilesystemHostSource(source, { paths, fsImpl, installationKey })];
  }
  if (NON_FILESYSTEM_AUTOMATIC_SOURCES.includes(source.id)) {
    return [{
      sourceId: automaticSourceId(source.id, installationKey), kind: 'automatic', root: null,
      environmentId: LOCAL_ENVIRONMENT_ID, label: source.label, filesystem: false, present: true,
    }];
  }
  return [];
}

/**
 * Every ENABLED automatic source resolved into `listSources()`-shaped
 * entries an orchestrator can walk directly, gated by whether the source
 * applies to the CURRENT platform's environment kind. Roots that do not yet
 * exist (a filesystem host source never used on this machine) are returned
 * with `present:false` rather than dropped, so Discovery can show them as
 * real, inspectable-but-absent sources.
 *
 * `installationKey` is required: every SourceCoverage.sourceId in the shared
 * contract (src/lib/maintenance/management/model.mjs `assertManagementInventory`)
 * must satisfy the opaque `src_` grammar, and this is the one place that
 * mints identity for a curated automatic source (`{automatic: id}` — the
 * same material shape the shared fixtures already use).
 *
 * @param {{ configuration: ReturnType<typeof readDiscoveryConfiguration>,
 *   paths: { claudeDir?: () => string, codexDir?: () => string, opencodeDir?: () => string,
 *     hermesDir?: () => string }, platform?: string, fsImpl?: typeof fs,
 *   installationKey: string }} options
 */
export function resolveAutomaticSourceRoots({
  configuration, paths, platform = process.platform, fsImpl = fs, installationKey,
}) {
  if (typeof installationKey !== 'string' || installationKey.length < 16) {
    throw new TypeError('resolveAutomaticSourceRoots requires an installationKey');
  }
  const kind = environmentKindFor(platform);
  const out = [];
  for (const source of configuration.automaticSources) {
    if (!source.enabled) continue;
    if (kind && !source.environmentKinds.includes(kind)) continue;
    out.push(...resolveOneAutomaticSource(source, {
      configuration, paths, fsImpl, installationKey,
    }));
  }
  return out;
}

/** True when a configured exclusion covers `targetPath`: an exact match, or a
 *  recursive exclusion whose path is a lexical ancestor. Newly discovered
 *  descendants of a recursive exclusion remain covered automatically
 *  (MNT-DSC-005) because this is evaluated fresh against the live path, never
 *  against a cached project list. */
export function exclusionAppliesTo(configuration, targetPath) {
  const normalized = path.normalize(targetPath);
  const exclusions = Array.isArray(configuration?.exclusions) ? configuration.exclusions : [];
  return exclusions.some((entry) => {
    if (entry.path === normalized) return true;
    if (!entry.recursive) return false;
    const relative = path.relative(entry.path, normalized);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  });
}
