// Install footprint — one HostInstallation per managed tool, the shared caches
// that sit next to them, the duplicate native builds nobody can see today, and
// the free-space denominator that keeps "3.8 GB" honest (ADR-0025 §4,
// docs/ddd/machine-footprint.md "Install footprint").
//
// The managed-tool list is DERIVED, not hand-maintained. There is no single
// upstream array of "everything ak manages": HOST_REGISTRY owns the frontier
// CLIs, ruflo/agentic-qe are npm globals named in versions.mjs, the brain KB is
// a filesystem install with its own module, and the kit is its own package. A
// fourth hand-written list would drift the moment a host is added, so this
// module composes those four authorities instead.
//
// Install METHOD granularity did not exist before this module: hostInstallState
// answers npm / external / absent only. Attribution here is a pure filesystem
// probe — resolve the bin on PATH, realpath it, match the resolved path against
// known manager prefixes — and it fails closed to 'external' ("detected, not
// attributable") rather than guessing. npm containment is tested FIRST because
// npm's own prefix is frequently inside a version manager (mise on this
// machine): an npm-installed package must not be misread as mise-installed.
//
// Everything here is metadata: dirents, lstat, statfs, and package.json
// version/name fields. No tool's source or data is ever read.
import fs from 'node:fs';
import path from 'node:path';
import { HOST_REGISTRY } from '../adapters/registries.mjs';
import {
  home, isWindows, globalRoot, npxCacheDir, claudeDir, codexPluginCacheDir,
} from '../paths.mjs';
import { installedVersion, KIT_PKG } from '../versions.mjs';
import { kbDir, present as brainPresent, installedVersion as brainVersion } from '../ruvnet-brain.mjs';
import { readJson } from '../settings.mjs';
import {
  walkTree, walkMeasurements, rootMeasurements, measured, unknown, sumMeasurements, statNode,
  hasValue,
} from './walk.mjs';

/** Install-method vocabulary. 'external' is the fail-closed value: the tool is
 *  really there, ak did not put it there, and the manager could not be
 *  attributed from the resolved path. 'installer' is a tool ak installs by
 *  running its own installer rather than through a package manager (the brain
 *  KB). 'unknown' means the probe itself could not run (no npm global root,
 *  unreadable PATH). */
export const INSTALL_METHODS = Object.freeze([
  'npm', 'mise', 'asdf', 'volta', 'nvm', 'homebrew', 'system',
  'installer', 'external', 'absent', 'unknown',
]);

// Ordered; first match wins. Deliberately conservative — a prefix that could
// belong to two managers is left to the 'external' fallthrough.
const METHOD_RULES = Object.freeze([
  { method: 'mise', rule: /[\\/]mise[\\/]/i },
  { method: 'asdf', rule: /[\\/]\.asdf[\\/]/ },
  { method: 'volta', rule: /[\\/]\.volta[\\/]/ },
  { method: 'nvm', rule: /[\\/]\.nvm[\\/]/ },
  { method: 'homebrew', rule: /[\\/](?:homebrew|Cellar|linuxbrew)[\\/]/ },
  { method: 'system', rule: /^(?:\/usr\/bin|\/bin|\/usr\/local\/bin)[\\/][^\\/]+$/ },
]);

/** Native addons are the sprawl this section exists to expose; a tree with
 *  hundreds of them is real (ruflo bundles several native stacks), but the
 *  payload still needs a ceiling. The COUNT stays exact past the cap. */
export const MAX_NATIVE_ADDONS_PER_TOOL = 512;
const NATIVE_EXT = '.node';

/** The brain's install root is the PARENT of its KB dir. Measuring `kbDir()`
 *  alone under-reported this machine's brain by 85%: 1.9 GB of active KB inside
 *  a 13.2 GB cache root whose bulk is dated `kb.bak-*` copies the installer left
 *  behind on previous updates, plus the embedding models and its jsonl ledgers.
 *
 *  Only the installer's own `…/ruvnet-brain/kb` layout is walked upward, and
 *  both segments must match. `RUVNET_BRAIN_KB` can relocate the KB anywhere —
 *  `/mnt/data/kb` would make the parent a directory the brain does not own, and
 *  billing a shared volume to the brain is a worse error than under-reporting
 *  it. An unrecognized layout stays measured at the KB dir, as before. */
export function brainRoot() {
  const kb = kbDir();
  const parent = path.dirname(kb);
  const owned = path.basename(kb) === 'kb' && path.basename(parent) === 'ruvnet-brain';
  return owned ? parent : kb;
}

/** Sub-rows for the brain's cache root, because the 85% that was invisible is
 *  not one number and must not become one: a user watching the figure jump from
 *  1.9 GB to 13.2 GB is owed the reason. Order matters — `kb.bak-…` is tested
 *  before nothing, but `kb` is matched by exact equality so a backup can never
 *  fall into the active-KB bucket. */
export const BRAIN_COMPONENTS = Object.freeze([
  { id: 'kb', label: 'Active knowledge base', match: (seg) => seg === 'kb' },
  { id: 'kb-backups', label: 'Superseded KB copies', match: (seg) => /^kb\.bak/i.test(seg) },
  { id: 'models', label: 'Embedding models', match: (seg) => seg === 'models' },
]);

/** Whatever no spec claimed. A breakdown whose parts do not add up to the whole
 *  is worse than no breakdown, so the remainder is always a row. */
const COMPONENT_REMAINDER = Object.freeze({
  id: 'other', label: 'Ledgers and loose files', match: () => true,
});

/** Attribute an install from a binary's REAL path. `globalRootDir`, when known,
 *  wins over every manager rule: a package under npm's global node_modules is
 *  npm-installed no matter which version manager owns the prefix. */
export function attributeInstallMethod(realPath, { globalRootDir = null } = {}) {
  if (!realPath) return 'absent';
  const resolved = path.resolve(realPath);
  if (globalRootDir && !path.relative(globalRootDir, resolved).startsWith('..')) return 'npm';
  if (/[\\/]node_modules[\\/]/.test(resolved)) return 'npm';
  for (const { method, rule } of METHOD_RULES) if (rule.test(resolved)) return method;
  return 'external';
}

/** First `bin` on PATH, realpath-resolved, or null. Pure filesystem: `which`
 *  costs a process per tool and the cheap tier runs on every dashboard read. */
export function resolveBinPath(bin, {
  env = process.env, windows = isWindows, fsImpl = fs,
} = {}) {
  if (!bin) return null;
  const dirs = String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
  const exts = windows
    ? ['', ...String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)]
    : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, bin + ext);
      try {
        const st = fsImpl.lstatSync(candidate);
        if (!st.isFile() && !st.isSymbolicLink()) continue;
        return fsImpl.realpathSync(candidate);
      } catch { /* not here: try the next PATH entry */ }
    }
  }
  return null;
}

/** The npm-managed package name that owns a native addon file, derived from its
 *  path (`.../node_modules/<pkg>/build/Release/x.node`, scoped names included).
 *  Null when the addon lives outside any node_modules — still inventoried, just
 *  not attributable to a package. */
export function nativeModuleName(file) {
  const parts = String(file).split(/[\\/]+/);
  const idx = parts.lastIndexOf('node_modules');
  if (idx < 0 || idx + 1 >= parts.length) return null;
  const first = parts[idx + 1];
  if (first.startsWith('@') && idx + 2 < parts.length) return `${first}/${parts[idx + 2]}`;
  return first;
}

function safeGlobalRoot() {
  // globalRoot() throws when npm's root cannot be determined (paths.mjs). That
  // is a legitimate machine state (npm absent), not a reason to fail the whole
  // System panel — every npm-rooted figure degrades to unknown instead.
  try {
    return { root: globalRoot(), reason: null };
  } catch {
    return { root: null, reason: 'npm global root undeterminable' };
  }
}

/** The managed-tool descriptors this collector measures, composed from the
 *  registry plus the modules that own the non-npm tools. `kind` says how the
 *  root is found, not how it was installed. */
export function managedTools({ pkgRoot = null, globalRootDir = null } = {}) {
  const npmRoot = (pkg) => (globalRootDir ? path.join(globalRootDir, pkg) : null);
  const tools = [
    { id: 'ruflo', label: 'ruflo', pkg: 'ruflo', bin: 'ruflo', kind: 'npm', root: npmRoot('ruflo') },
    {
      id: 'agentic-qe', label: 'agentic-qe', pkg: 'agentic-qe', bin: 'aqe',
      kind: 'npm', root: npmRoot('agentic-qe'),
    },
  ];
  for (const host of HOST_REGISTRY) {
    tools.push({
      id: host.id,
      label: host.label,
      pkg: host.install.npmPackage,
      bin: host.install.bin,
      kind: 'npm',
      root: npmRoot(host.install.npmPackage),
    });
  }
  tools.push({
    id: 'agentic-kit', label: 'agentic-kit', pkg: KIT_PKG, bin: 'ak',
    kind: 'self', root: pkgRoot || npmRoot(KIT_PKG),
  });
  tools.push({
    // Not an npm global: `npx ruvnet-brain` downloads an offline KB to a cache
    // dir and wires a user-scope Claude Code plugin, so its version comes from
    // the plugin manifest rather than npm. Its bytes are the WHOLE cache root's,
    // not the active KB's — see brainRoot() for what that cost the figure — and
    // the components say which part of the root they are.
    id: 'ruvnet-brain', label: 'RuvNet Brain', pkg: null, bin: null,
    kind: 'kb', root: brainRoot(), components: BRAIN_COMPONENTS,
  });
  return tools;
}

function toolVersion(desc) {
  try {
    if (desc.kind === 'kb') return brainVersion() ?? null;
    if (desc.kind === 'self' && desc.root) {
      return readJson(path.join(desc.root, 'package.json'), {})?.version ?? null;
    }
    return desc.pkg ? installedVersion(desc.pkg) : null;
  } catch {
    return null;
  }
}

/** Resolve a tool root through a symlink, ONCE, at the root itself. The walker
 *  never follows links found during traversal (that is how it escapes its root
 *  or cycles); a root the caller named explicitly is different — a dev install
 *  linked into npm's global tree (`npm link`) is a symlink, and refusing it
 *  would report the kit's own size as unmeasurable on every maintainer machine.
 *  The original path is retained so the row can say where it was linked from. */
function resolveRootPath(root, fsImpl) {
  if (!root) return { root: null, linkedFrom: null };
  try {
    const real = fsImpl.realpathSync(root);
    return { root: real, linkedFrom: real === root ? null : root };
  } catch {
    return { root, linkedFrom: null };
  }
}

function toolPresence(desc, fsImpl) {
  if (desc.kind === 'kb') {
    try { return brainPresent(); } catch { return false; }
  }
  if (!desc.root) return false;
  const manifest = statNode(path.join(desc.root, 'package.json'), { fsImpl });
  if (manifest.status === 'measured' && manifest.kind === 'file') return true;
  const dir = statNode(desc.root, { fsImpl });
  return dir.status === 'measured' && dir.kind === 'dir';
}

/** Bucket a tool tree's files by the top-level entry they live under, so a row
 *  can say WHY it is big instead of only how big. Buckets ride the SAME walk as
 *  the tree total — a second pass would double the I/O to answer one question,
 *  and two passes over a tree the installer rewrites nightly could disagree.
 *  Every component therefore inherits the walk's own provenance: a truncated or
 *  partly-degraded walk makes every component partial, and an unreadable root
 *  makes them unknown-with-reason rather than a set of tidy zeros. */
function componentBuckets(specs, root) {
  if (!specs?.length) return null;
  const state = [...specs, COMPONENT_REMAINDER].map((spec) => ({
    spec, bytes: 0, files: 0, newestMtimeMs: null, names: new Set(),
  }));
  const identity = (s) => ({
    id: s.spec.id,
    label: s.spec.label,
    // One matched entry has a path worth printing; a family (five dated backups)
    // or an empty bucket does not, and inventing one would name a directory that
    // holds only part of the figure.
    path: s.names.size === 1 ? path.join(root, [...s.names][0]) : null,
    entries: s.names.size,
  });
  return {
    add({ file, bytes, mtimeMs }) {
      const segment = path.relative(root, file).split(/[\\/]+/)[0] || '';
      const hit = state.find((s) => s.spec.match(segment));
      hit.bytes += bytes;
      hit.files += 1;
      hit.names.add(segment);
      if (hit.newestMtimeMs === null || mtimeMs > hit.newestMtimeMs) hit.newestMtimeMs = mtimeMs;
    },
    finalize({ asOf, partial }) {
      return state.map((s) => ({
        ...identity(s),
        bytes: measured(s.bytes, { asOf, partial }),
        files: measured(s.files, { asOf, partial }),
        newestMtimeMs: s.newestMtimeMs,
      }));
    },
    unmeasured(reason) {
      return state.map((s) => ({
        ...identity(s), bytes: unknown(reason), files: unknown(reason), newestMtimeMs: null,
      }));
    },
  };
}

/**
 * One HostInstallation. Shape:
 *   { tool, label, package, present, version, installMethod, root, linkedFrom,
 *     rootReason, bytes, files, newestMtimeMs, components[], nativeAddons[],
 *     nativeAddonCount, nativeAddonsTruncated, degraded[], complete }
 *
 * A tool that is genuinely not installed reports `measured(0)` bytes — zero is
 * the true size of an absent install. A tool that IS installed but whose root
 * ak cannot attribute (an externally-installed CLI: mise, brew, a native
 * installer) reports unknown-with-reason, never 0: ak does not own that tree
 * and refuses to claim a size for it.
 */
function collectTool(desc, ctx) {
  const { asOf, walk, limits, fsImpl, maxNativeAddons } = ctx;
  const { root: realRoot, linkedFrom } = resolveRootPath(desc.root, fsImpl);
  const resolved = { ...desc, root: realRoot };
  const present = toolPresence(resolved, fsImpl);
  const version = present ? toolVersion(resolved) : null;
  const base = {
    tool: desc.id,
    label: desc.label,
    package: desc.pkg,
    present,
    version,
    root: realRoot,
    linkedFrom,
    rootReason: null,
    components: [],
    nativeAddons: [],
    nativeAddonCount: 0,
    nativeAddonsTruncated: false,
    newestMtimeMs: null,
    degraded: [],
  };

  if (!present) {
    const binPath = desc.bin ? resolveBinPath(desc.bin, { fsImpl }) : null;
    if (!binPath) {
      return {
        ...base, installMethod: 'absent', root: null,
        bytes: measured(0, { asOf }), files: measured(0, { asOf }), complete: true,
      };
    }
    // Installed, but by something other than ak. MANAGED-TOOLS invariant 2
    // ("honest disowning"): report what is true — the method and the binary —
    // and refuse to invent a tree size for a layout ak does not own.
    const reason = 'external install: tree root not attributable';
    return {
      ...base,
      present: true,
      installMethod: attributeInstallMethod(binPath, { globalRootDir: ctx.globalRootDir }),
      root: binPath,
      rootReason: reason,
      bytes: unknown(reason),
      files: unknown(reason),
      complete: false,
    };
  }

  if (!realRoot) {
    const reason = ctx.globalRootReason || 'install root unknown';
    return {
      ...base, installMethod: 'unknown', bytes: unknown(reason), files: unknown(reason),
      rootReason: reason, complete: false,
    };
  }

  const addons = [];
  let addonCount = 0;
  const buckets = componentBuckets(desc.components, realRoot);
  const result = walk(realRoot, {
    ...limits,
    fsImpl,
    onFile: (entry) => {
      if (buckets) buckets.add(entry);
      const { file, name, bytes, mtimeMs } = entry;
      if (!name.endsWith(NATIVE_EXT)) return;
      addonCount += 1;
      if (addons.length < maxNativeAddons) {
        addons.push({ tool: desc.id, module: nativeModuleName(file), name, file, bytes, mtimeMs });
      }
    },
  });
  const { bytes, files } = walkMeasurements(result, { asOf });
  return {
    ...base,
    installMethod: desc.kind === 'kb' ? 'installer' : 'npm',
    bytes,
    files,
    newestMtimeMs: result.newestMtimeMs,
    components: !buckets ? []
      : hasValue(bytes) ? buckets.finalize({ asOf, partial: bytes.partial })
        : buckets.unmeasured(bytes.reason),
    nativeAddons: addons,
    nativeAddonCount: addonCount,
    nativeAddonsTruncated: addonCount > addons.length,
    degraded: result.degraded,
    complete: result.complete,
  };
}

/** The same native module compiled into more than one tree — sprawl that is
 *  invisible today. Grouped by module + addon filename, because two different
 *  addons inside one package are not duplicates of each other. `wastedBytes` is
 *  everything past the largest copy: the floor of what deduplication would
 *  return, stated conservatively. */
export function duplicateNativeBuilds(addons) {
  const groups = new Map();
  for (const addon of addons || []) {
    const key = `${addon.module ?? '(outside node_modules)'}::${addon.name}`;
    if (!groups.has(key)) {
      groups.set(key, { module: addon.module ?? null, addon: addon.name, copies: [] });
    }
    const group = groups.get(key);
    if (!group.copies.some((c) => c.file === addon.file)) {
      group.copies.push({ tool: addon.tool, file: addon.file, bytes: addon.bytes });
    }
  }
  return [...groups.values()]
    .filter((g) => g.copies.length > 1)
    .map((g) => {
      const total = g.copies.reduce((acc, c) => acc + c.bytes, 0);
      const largest = g.copies.reduce((acc, c) => Math.max(acc, c.bytes), 0);
      return { ...g, copyCount: g.copies.length, totalBytes: total, wastedBytes: total - largest };
    })
    .sort((a, b) => b.wastedBytes - a.wastedBytes);
}

/** One node per npx cache env (`<npm-cache>/_npx/<hash>`). Exported because the
 *  storage collector's reclaimable rows need exactly these figures — walking
 *  the cache twice would double the I/O to answer one question. Package NAMES
 *  come from the env's own package.json manifest; nothing else is read. */
export function npxEnvNodes({
  root = npxCacheDir(), walk = walkTree, limits = {}, asOf = null, fsImpl = fs,
} = {}) {
  let entries;
  try {
    entries = fsImpl.readdirSync(root, { withFileTypes: true });
  } catch (err) {
    const code = err?.code || 'io';
    return {
      root,
      presence: code === 'ENOENT' ? 'absent' : 'degraded',
      reason: code === 'ENOENT' ? null : code,
      envs: [],
    };
  }
  const envs = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const dir = path.join(root, entry.name);
    const result = walk(dir, { ...limits, fsImpl });
    const { bytes, files } = walkMeasurements(result, { asOf });
    const manifest = readJson(path.join(dir, 'package.json'), {}) ?? {};
    envs.push({
      id: entry.name,
      path: dir,
      packages: Object.keys(manifest.dependencies ?? {}),
      bytes,
      files,
      newestMtimeMs: result.newestMtimeMs,
      complete: result.complete,
    });
  }
  envs.sort((a, b) => (b.bytes.value ?? 0) - (a.bytes.value ?? 0));
  return { root, presence: 'present', reason: null, envs };
}

/** Playwright's browser cache has three platform locations and they are ONE
 *  cache, not three. Only two were listed, and the missing one was macOS's:
 *  `playwright install` writes to ~/Library/Caches/ms-playwright there, so a mac
 *  holding 1.86 GB of browser builds reported a measured zero — honest for the
 *  XDG path that genuinely does not exist, wrong for the question the row asks.
 *
 *  All three are probed and they collapse into a single row, because two of them
 *  can be real at once: a cache migrated between layouts leaves both, and on
 *  macOS ~/.cache is sometimes a symlink into ~/Library/Caches, which is the same
 *  directory reachable by two names. Candidates are realpath-collapsed first —
 *  resolving a root the collector named itself, exactly as resolveRootPath does
 *  for a linked tool root — so an aliased target is measured once, and the
 *  survivors sum into one figure instead of near-identical rows that a total
 *  would add together. When none exists the platform-canonical path is the one
 *  named, so the measured zero says where it looked. */
function playwrightCacheRoot({ env, platform, fsImpl }) {
  const mac = path.join(home, 'Library', 'Caches', 'ms-playwright');
  const xdg = path.join(home, '.cache', 'ms-playwright');
  const win = path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'ms-playwright');
  const candidates = platform === 'darwin' ? [mac, xdg, win]
    : platform === 'win32' ? [win, xdg, mac]
      : [xdg, mac, win];

  const seen = new Set();
  const found = [];
  for (const candidate of candidates) {
    let real;
    // realpath throws for a path that is not there; absence is what makes a
    // candidate not a location, so it is the probe as well as the resolution.
    try { real = fsImpl.realpathSync(candidate); } catch { continue; }
    if (seen.has(real)) continue;
    seen.add(real);
    found.push(real);
  }
  return {
    id: 'playwright',
    label: 'Playwright browsers',
    path: found[0] ?? candidates[0],
    paths: found.length ? found : [candidates[0]],
  };
}

/** Install-adjacent shared caches. Deliberately their OWN rows rather than
 *  smeared into a tool's tree: npx envs and browser binaries belong to no
 *  single tool, and hiding them inside one would misattribute the bytes. The
 *  brain KB is absent here on purpose — it is a managed tool with its own row.
 *
 *  `paths` is the measured set and `path` is the one to print; they differ only
 *  where a cache legitimately lives in more than one place (see
 *  playwrightCacheRoot). */
export function sharedCacheRoots({
  env = process.env, platform = process.platform, fsImpl = fs,
} = {}) {
  const single = (id, label, dir) => ({ id, label, path: dir, paths: [dir] });
  return [
    single('npx-envs', 'npx cache envs', npxCacheDir()),
    single('claude-plugins', 'Claude Code plugins', path.join(claudeDir(), 'plugins')),
    single('codex-plugins', 'Codex plugin cache', codexPluginCacheDir()),
    playwrightCacheRoot({ env, platform, fsImpl }),
    single('puppeteer', 'Puppeteer browsers', path.join(home, '.cache', 'puppeteer')),
  ];
}

/** One shared-cache row's figures. The single-location case is the exact
 *  rootMeasurements result, untouched: an errno on a lone root must reach the UI
 *  as that errno, and folding it through a sum would flatten it to "every input
 *  unmeasured". Only a genuinely multi-location cache merges, and it merges
 *  conservatively — present beats degraded beats absent, and an unreadable
 *  location makes the sum partial rather than silently dropping its bytes. */
function measureCacheRoot(cache, { walk, limits, fsImpl, asOf }) {
  const locations = cache.paths?.length ? cache.paths : [cache.path];
  const parts = locations.map((dir) => {
    const result = walk(dir, { ...limits, fsImpl });
    return { result, ...rootMeasurements(result, { asOf }) };
  });
  if (parts.length === 1) {
    const [only] = parts;
    return {
      presence: only.presence, bytes: only.bytes, files: only.files,
      newestMtimeMs: only.result.newestMtimeMs, complete: only.result.complete,
    };
  }
  const presence = parts.some((p) => p.presence === 'present') ? 'present'
    : parts.some((p) => p.presence === 'degraded') ? 'degraded' : 'absent';
  const mtimes = parts.map((p) => p.result.newestMtimeMs).filter((m) => m !== null);
  return {
    presence,
    bytes: sumMeasurements(parts.map((p) => p.bytes), { asOf }),
    files: sumMeasurements(parts.map((p) => p.files), { asOf }),
    newestMtimeMs: mtimes.length ? Math.max(...mtimes) : null,
    complete: parts.every((p) => p.result.complete !== false),
  };
}

/** The section's denominator: "the install is X GB" is meaningless without an
 *  "of Y free" beside it. statfs is a Node builtin (>=18.15) — no dependency,
 *  and it works on Windows too. Failure reports unknown, never 0. */
export function diskSpace(target = home, { fsImpl = fs } = {}) {
  try {
    const st = fsImpl.statfsSync(target);
    const block = Number(st.bsize);
    return {
      path: target,
      totalBytes: measured(block * Number(st.blocks)),
      freeBytes: measured(block * Number(st.bavail)),
    };
  } catch (err) {
    const reason = err?.code || 'statfs unavailable';
    return { path: target, totalBytes: unknown(reason), freeBytes: unknown(reason) };
  }
}

/**
 * The install section of a FootprintSnapshot.
 *
 * @param {{
 *   pkgRoot?: string|null, now?: () => number, walk?: typeof walkTree,
 *   limits?: object, diskPath?: string, maxNativeAddons?: number,
 *   includeCaches?: boolean, fsImpl?: typeof fs,
 * }} [options]
 * @returns {{
 *   asOf: number, globalRoot: string|null, globalRootReason: string|null,
 *   tools: object[], sharedCaches: object[], npxEnvs: object,
 *   duplicateNatives: object[], totals: object, disk: object, complete: boolean,
 * }}
 */
export function collectInstall({
  pkgRoot = null,
  now = Date.now,
  walk = walkTree,
  limits = {},
  diskPath = home,
  maxNativeAddons = MAX_NATIVE_ADDONS_PER_TOOL,
  includeCaches = true,
  fsImpl = fs,
} = {}) {
  const asOf = now();
  const { root: globalRootDir, reason: globalRootReason } = safeGlobalRoot();
  const ctx = { asOf, walk, limits, fsImpl, maxNativeAddons, globalRootDir, globalRootReason };

  const tools = managedTools({ pkgRoot, globalRootDir }).map((desc) => collectTool(desc, ctx));

  const sharedCaches = [];
  let npxEnvs = { root: npxCacheDir(), presence: 'unknown', reason: 'not collected', envs: [] };
  if (includeCaches) {
    for (const cache of sharedCacheRoots({ fsImpl })) {
      sharedCaches.push({ ...cache, ...measureCacheRoot(cache, { walk, limits, fsImpl, asOf }) });
    }
    npxEnvs = npxEnvNodes({ walk, limits, asOf, fsImpl });
  }

  const allAddons = tools.flatMap((t) => t.nativeAddons);
  const toolBytes = tools.map((t) => t.bytes);
  const cacheBytes = sharedCaches.map((c) => c.bytes);
  const complete = tools.every((t) => t.complete !== false)
    && sharedCaches.every((c) => c.complete !== false)
    && !tools.some((t) => t.nativeAddonsTruncated);

  return {
    asOf,
    globalRoot: globalRootDir,
    globalRootReason,
    tools,
    sharedCaches,
    npxEnvs,
    duplicateNatives: duplicateNativeBuilds(allAddons),
    totals: {
      installBytes: sumMeasurements(toolBytes, { asOf }),
      cacheBytes: sumMeasurements(cacheBytes, { asOf }),
      // Counts, not bytes: a truncated addon list still knows how many it saw.
      nativeAddons: measured(
        tools.reduce((acc, t) => acc + t.nativeAddonCount, 0),
        { asOf, partial: tools.some((t) => t.complete === false) },
      ),
      toolsPresent: measured(tools.filter((t) => t.present).length, { asOf }),
    },
    disk: diskSpace(diskPath, { fsImpl }),
    complete,
  };
}
