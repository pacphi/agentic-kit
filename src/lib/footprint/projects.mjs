// Project footprints — one row per project in the shared discovery catalog:
// approximate LOC by language, working-tree bytes, `.git` bytes, `node_modules`
// bytes, last activity, and the origin remote's web page when one exists.
//
// The three byte figures stay SEPARATE on purpose (ADR-0025): `node_modules`
// dominates and `.git` distorts, so folding either into the tree would let
// reinstallable overhead masquerade as "your project got big".
//
// LOC is APPROXIMATE by invariant 11 and says so in the payload: it is an
// extension-bucketed newline count with a stated exclusion list, produced by the
// kit's own bounded walker (zero runtime dependencies — no cloc, no tokei). Files
// are scanned through a fixed 64 KB buffer that is counted and discarded; no file
// content is ever retained or emitted.
//
// Discovery supplies PATHS ONLY (invariant 9). Every figure below is measured here.
import fs from 'node:fs';
import path from 'node:path';
import { parseRepoSlug } from '../admin-collect.mjs';
import { discoverRuvfloProjects } from '../dashboard/project-discovery.mjs';
import { walkTree, rootMeasurements, measured, unknown, sumMeasurements } from './walk.mjs';

/** Directories that are never code and never the user's work. Excluded from the
 *  tree walk, from LOC, and from the nested-`node_modules` search alike, so the
 *  three byte figures partition the project rather than overlapping it. */
const OVERHEAD_DIRS = new Set(['.git', 'node_modules']);

/** Vendored / generated / virtual-env trees. Excluded from LOC only: they are
 *  real bytes on disk (so they stay in treeBytes) but they are not lines the user
 *  wrote, and counting them would make the LOC figure meaningless. */
const LOC_EXCLUDED_DIRS = new Set([
  'node_modules', '.git', 'vendor', 'third_party', 'thirdparty', 'bower_components',
  'dist', 'build', 'out', 'target', '.next', '.nuxt', '.svelte-kit', 'coverage',
  '.venv', 'venv', '__pycache__', '.tox', '.mypy_cache', '.pytest_cache',
  '.gradle', '.idea', '.vscode', 'Pods', '.terraform', '.cache', '.turbo',
]);

/** Machine-generated manifests: text, enormous, and nobody's line count. */
const LOC_EXCLUDED_FILES = new Set([
  'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'npm-shrinkwrap.json',
  'Cargo.lock', 'poetry.lock', 'Gemfile.lock', 'composer.lock', 'go.sum', 'flake.lock',
]);

/** Extension → language bucket. An extension absent from this map is NOT counted
 *  — an unknown extension may be a binary, and guessing would inflate the total. */
const LANGUAGES = new Map(Object.entries({
  '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'javascript',
  '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
  '.rs': 'rust', '.go': 'go', '.py': 'python', '.rb': 'ruby', '.php': 'php',
  '.java': 'java', '.kt': 'kotlin', '.kts': 'kotlin', '.scala': 'scala', '.groovy': 'groovy',
  '.cs': 'csharp', '.fs': 'fsharp', '.swift': 'swift', '.m': 'objective-c', '.mm': 'objective-c',
  '.c': 'c', '.h': 'c', '.cc': 'cpp', '.cpp': 'cpp', '.cxx': 'cpp', '.hpp': 'cpp', '.hh': 'cpp',
  '.ex': 'elixir', '.exs': 'elixir', '.erl': 'erlang', '.hs': 'haskell', '.clj': 'clojure',
  '.lua': 'lua', '.dart': 'dart', '.zig': 'zig', '.nim': 'nim', '.pl': 'perl', '.r': 'r',
  '.sh': 'shell', '.bash': 'shell', '.zsh': 'shell', '.fish': 'shell', '.ps1': 'powershell',
  '.sql': 'sql', '.vue': 'vue', '.svelte': 'svelte',
  '.html': 'html', '.htm': 'html', '.css': 'css', '.scss': 'css', '.sass': 'css', '.less': 'css',
  '.md': 'markdown', '.mdx': 'markdown',
  '.json': 'config', '.yml': 'config', '.yaml': 'config', '.toml': 'config',
  '.ini': 'config', '.xml': 'config', '.proto': 'config', '.tf': 'config',
}));

/** Source trees nest far shallower than dependency trees; 12 covers a monorepo
 *  package's deepest source dir without letting a pathological tree run away. */
const LOC_MAX_DEPTH = 12;
/** Files above this are minified bundles, fixtures, or data dumps far more often
 *  than they are hand-written source. Skipped and reported, not counted. */
const LOC_MAX_FILE_BYTES = 2 * 1024 * 1024;
const READ_CHUNK = 64 * 1024;
/** Depth at which a workspace's nested `node_modules` still gets attributed. */
const NODE_MODULES_MAX_DEPTH = 6;

/** The exclusion list every consumer must be able to state alongside the figure
 *  (invariant 11). Deliberate exclusions are why LOC is approximate; they are NOT
 *  a failed measurement, so they never mark the count partial. */
export const LOC_EXCLUSIONS = Object.freeze([
  ...[...LOC_EXCLUDED_DIRS].sort().map((dir) => `${dir}/`),
  ...[...LOC_EXCLUDED_FILES].sort(),
  'files without a recognized source extension',
  'files containing NUL bytes (binary)',
  `files larger than ${LOC_MAX_FILE_BYTES} bytes`,
]);

// ── git remote ────────────────────────────────────────────────────────────────

/**
 * The `url` of a named remote in `.git/config` text. Ordered so `origin` always
 * wins; a repository with remotes but no `origin` still reports its remote rather
 * than claiming to be local-only, which would be a false negative.
 *
 * @param {string} source raw `.git/config` contents
 * @returns {{ name: string, url: string }|null}
 */
export function parseGitRemote(source) {
  const found = new Map();
  const section = /^\s*\[\s*remote\s+"([^"]+)"\s*\]\s*$/gm;
  let match;
  while ((match = section.exec(source)) !== null) {
    const rest = source.slice(section.lastIndex);
    const nextSection = rest.search(/^\s*\[/m);
    const body = nextSection < 0 ? rest : rest.slice(0, nextSection);
    const url = body.match(/^\s*url\s*=\s*(.+?)\s*$/m);
    if (url?.[1]) found.set(match[1], url[1]);
  }
  if (found.has('origin')) return { name: 'origin', url: found.get('origin') };
  const first = [...found.entries()][0];
  return first ? { name: first[0], url: first[1] } : null;
}

/** Forges whose repository page is `https://<host>/<owner>/<repo>`. */
const KNOWN_FORGES = new Map(Object.entries({
  'github.com': 'github',
  'gitlab.com': 'gitlab',
  'bitbucket.org': 'bitbucket',
  'codeberg.org': 'codeberg',
  'git.sr.ht': 'sourcehut',
}));

/** Hostname + scheme from any of the shapes parseRepoSlug already proves:
 *  git+https, ssh://, scp-shorthand, bare https. */
function remoteHost(rawUrl) {
  let s = rawUrl.trim();
  if (s.startsWith('git+')) s = s.slice(4);
  const scp = s.match(/^[^@/]+@([^:/]+):(.+)$/); // git@github.com:owner/repo
  if (scp) return { hostname: scp[1].toLowerCase(), scheme: null };
  try {
    const url = new URL(s);
    const scheme = url.protocol === 'https:' || url.protocol === 'http:' ? url.protocol.slice(0, -1) : null;
    return { hostname: url.hostname.toLowerCase().replace(/^www\./, ''), scheme };
  } catch { return { hostname: null, scheme: null }; }
}

/**
 * Describe a remote URL for the Projects table. A recognized forge or an
 * already-web-shaped self-hosted URL yields a `webUrl`; anything else yields the
 * remote unlinked. The URL is NEVER guessed and the kit never fetches it — the
 * link exists so the user's own browser can navigate there.
 *
 * @param {string} rawUrl
 * @param {string} [name] the remote's name (`origin`)
 * @returns {{ status: 'linked'|'unrecognized', name: string, raw: string,
 *             hostname: string|null, host: string|null, slug: string|null,
 *             webUrl: string|null }}
 */
export function describeRemote(rawUrl, name = 'origin') {
  const raw = String(rawUrl ?? '').trim();
  const { hostname, scheme } = remoteHost(raw);
  const slug = parseRepoSlug(raw);
  const forge = hostname ? KNOWN_FORGES.get(hostname) : null;
  const linkable = Boolean(slug && hostname && (forge || scheme));
  // A known forge is https by definition; a self-hosted remote keeps the scheme it
  // was already written with, so an http-only server is not silently upgraded.
  const webScheme = forge ? 'https' : scheme;
  return {
    status: linkable ? 'linked' : 'unrecognized',
    name,
    raw,
    hostname,
    host: forge ?? hostname,
    slug,
    webUrl: linkable ? `${webScheme}://${hostname}/${slug}` : null,
  };
}

/**
 * The remote row for one project. Absence is stated, never guessed: no `.git` or
 * no configured remote is an explicit `local-only`; an unreadable `.git/config`
 * is `unknown` with its errno, not a silent local-only.
 */
export function projectRemote(projectPath, { fsImpl = fs } = {}) {
  const configFile = path.join(projectPath, '.git', 'config');
  let source;
  try { source = fsImpl.readFileSync(configFile, 'utf8'); } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
      return { status: 'local-only', name: null, raw: null, hostname: null, host: null, slug: null, webUrl: null, reason: null };
    }
    return { status: 'unknown', name: null, raw: null, hostname: null, host: null, slug: null, webUrl: null, reason: error.code ?? 'EUNKNOWN' };
  }
  const remote = parseGitRemote(source);
  if (!remote) {
    return { status: 'local-only', name: null, raw: null, hostname: null, host: null, slug: null, webUrl: null, reason: null };
  }
  return { ...describeRemote(remote.url, remote.name), reason: null };
}

// ── lines of code ─────────────────────────────────────────────────────────────

/** Count newlines in one file through a fixed buffer. Returns null when the file
 *  is binary (a NUL byte in the first chunk) or unreadable — never 0, which would
 *  claim an empty file. Each chunk is counted and immediately overwritten; no file
 *  content is retained past this function or emitted anywhere. */
function countFileLines(file, size, fsImpl = fs) {
  let fd;
  try { fd = fsImpl.openSync(file, 'r'); } catch { return null; }
  try {
    const buffer = Buffer.allocUnsafe(READ_CHUNK);
    let lines = 0;
    let read = 0;
    let lastByte = 0;
    let offset = 0;
    let first = true;
    while ((read = fsImpl.readSync(fd, buffer, 0, READ_CHUNK, offset)) > 0) {
      // One NUL in the first chunk is the cheap, conventional binary test.
      if (first) { const nul = buffer.indexOf(0); if (nul >= 0 && nul < read) return null; }
      first = false;
      for (let i = 0; i < read; i++) if (buffer[i] === 0x0a) lines++;
      lastByte = buffer[read - 1];
      offset += read;
    }
    // A final line with no trailing newline still counts as a line.
    if (size > 0 && lastByte !== 0x0a) lines++;
    return lines;
  } catch { return null; }
  finally { try { fsImpl.closeSync(fd); } catch { /* fd already gone */ } }
}

/**
 * Approximate lines of code under `root`, bucketed by language, via the shared
 * bounded walker — so LOC inherits the same never-follow-symlinks rule, entry
 * caps, and degrade-this-node-only failure mode as every other figure here.
 *
 * `total` is `partial` only when a cap fired or a subtree was unreadable. The
 * exclusion list is a deliberate scope, not a failure, and never marks it partial
 * — which is precisely why the figure ships with `approximate` and `exclusions`
 * attached, so no consumer can render it as authoritative (invariant 11).
 *
 * @param {string} root
 * @param {{ walk?: Function, limits?: object, maxDepth?: number, asOf?: number|null,
 *           fsImpl?: typeof fs }} [options]
 * @returns {object} LocCount
 */
export function countLines(root, {
  walk = walkTree, limits = {}, maxDepth = LOC_MAX_DEPTH, asOf = null, fsImpl = fs,
} = {}) {
  const byLanguage = {};
  let total = 0;
  let files = 0;
  let skipped = 0;
  const languageOf = (name) => LANGUAGES.get(path.extname(name).toLowerCase());

  const result = walk(root, {
    maxDepth, ...limits, fsImpl,
    skipDir: (dir, name) => LOC_EXCLUDED_DIRS.has(name),
    acceptFile: (name) => !LOC_EXCLUDED_FILES.has(name) && Boolean(languageOf(name)),
    onFile: ({ file, name, bytes }) => {
      if (bytes > LOC_MAX_FILE_BYTES) { skipped++; return; }
      const lines = countFileLines(file, bytes, fsImpl);
      if (lines === null) { skipped++; return; }
      const language = languageOf(name);
      byLanguage[language] = (byLanguage[language] ?? 0) + lines;
      total += lines;
      files++;
    },
  });

  const base = { approximate: true, exclusions: [...LOC_EXCLUSIONS] };
  if (result.status === 'unknown') {
    return {
      ...base, total: unknown(result.reason), byLanguage: {}, files: null, skipped: 0,
      complete: false, degraded: result.degraded ?? [],
    };
  }
  return {
    ...base,
    total: measured(total, { asOf, partial: result.complete === false }),
    byLanguage,
    files,
    skipped,
    complete: result.complete !== false,
    degraded: result.degraded ?? [],
  };
}

// ── bytes ─────────────────────────────────────────────────────────────────────

/** One walked root as Measurements plus its newest mtime. `rootMeasurements`
 *  already draws the absent-vs-degraded line: a directory that does not exist
 *  holds a real, measured zero; one that could not be read stays unknown. */
function walkNode(walk, root, options) {
  const result = walk(root, options);
  return {
    ...rootMeasurements(result, { asOf: options.asOf ?? null }),
    newestMtimeMs: Number.isFinite(result.newestMtimeMs) ? result.newestMtimeMs : null,
    complete: result.complete !== false,
  };
}

/**
 * Top-most `node_modules` directories under `root`, bounded by depth. Nested
 * copies inside a found one are its own bytes, so the search never descends into
 * a hit — the roots returned partition rather than overlap.
 *
 * @param {string} root
 * @param {{ walk?: Function, maxDepth?: number, fsImpl?: typeof fs }} [options]
 * @returns {string[]}
 */
export function nodeModulesRoots(root, { walk = walkTree, maxDepth = NODE_MODULES_MAX_DEPTH, fsImpl = fs } = {}) {
  const roots = [];
  // `skipDir` is the walker's directory hook: recording a hit and pruning it in
  // one step is what keeps the roots non-overlapping, so their bytes sum cleanly.
  walk(root, {
    maxDepth, fsImpl,
    acceptFile: () => false, // directories are the subject here; no file work
    skipDir: (dir, name) => {
      if (name === 'node_modules') { if (roots.length < 256) roots.push(dir); return true; }
      return OVERHEAD_DIRS.has(name) || name.startsWith('.');
    },
  });
  return roots;
}

// ── assembly ──────────────────────────────────────────────────────────────────

/** The row for a project whose path could not be measured at all. Every figure is
 *  unknown-with-reason; none of them is 0, because nothing was measured. */
function missingProject(project, reason, presence = 'absent') {
  return {
    path: project.path,
    label: project.label,
    source: project.source ?? null,
    remote: { status: 'unknown', name: null, raw: null, hostname: null, host: null, slug: null, webUrl: null, reason },
    loc: { approximate: true, exclusions: [...LOC_EXCLUSIONS], total: unknown(reason),
      byLanguage: {}, files: null, skipped: 0, complete: false, degraded: [] },
    presence,
    treeBytes: unknown(reason),
    treeFiles: unknown(reason),
    gitBytes: unknown(reason),
    nodeModulesBytes: unknown(reason),
    nodeModulesRoots: [],
    totalBytes: unknown(reason),
    lastActivity: unknown(reason),
    treeExclusions: [...OVERHEAD_DIRS],
    complete: false,
  };
}

/** Progress callbacks belong to the UI; a throwing one is the UI's problem, not
 *  the scan's (the same contract usage-index's notify() keeps). */
function notify(onProgress, payload) {
  if (typeof onProgress !== 'function') return;
  try { onProgress(payload); } catch { /* never let a listener abort a scan */ }
}

/**
 * Measure one project. `walk` is the shared bounded walker; the project's path is
 * the only thing discovery contributes (invariant 9).
 *
 * @param {{ path: string, label: string, source?: string }} project
 * @param {{ walk?: Function, limits?: object, countLines?: Function, loc?: boolean,
 *           asOf?: number|null, fsImpl?: typeof fs }} [options]
 * @returns {object} ProjectFootprint
 */
export function measureProject(project, {
  walk = walkTree, limits = {}, countLines: countLinesImpl = countLines,
  loc = true, asOf = null, fsImpl = fs,
} = {}) {
  const root = project.path;
  const common = { ...limits, fsImpl, asOf };
  const tree = walkNode(walk, root, { ...common, skipDir: (dir, name) => OVERHEAD_DIRS.has(name) });

  // A project whose ROOT is gone or unreadable is not a project measuring zero
  // bytes — it is a project we could not measure. `rootMeasurements` turns an
  // absent root into a real 0, which is right for a missing `.git` or
  // `node_modules` and wrong for the project itself, so it is overridden here.
  if (tree.presence !== 'present') {
    // The remote is not probed either: a vanished path has no `.git/config`, and
    // reporting that as "local only" would invent a fact about a project we
    // cannot see.
    return missingProject(project, tree.presence === 'absent'
      ? 'project path no longer exists'
      : 'project root unreadable', tree.presence);
  }

  const git = walkNode(walk, path.join(root, '.git'), common);

  const moduleRoots = nodeModulesRoots(root, { walk, fsImpl });
  // An empty roots list is a real, measured zero — this project has no
  // node_modules — which is why it is stated explicitly rather than handed to
  // sumMeasurements, whose empty-list zero would mean the same thing by accident.
  const nodeModulesBytes = moduleRoots.length === 0
    ? measured(0, { asOf })
    : sumMeasurements(moduleRoots.map((dir) => walkNode(walk, dir, common).bytes), { asOf });

  return {
    path: root,
    label: project.label,
    source: project.source ?? null,
    remote: projectRemote(root, { fsImpl }),
    loc: loc
      ? countLinesImpl(root, { walk, limits, asOf, fsImpl })
      : { approximate: true, exclusions: [...LOC_EXCLUSIONS], total: unknown('not measured'),
          byLanguage: {}, files: null, skipped: 0, complete: false, degraded: [] },
    presence: tree.presence,
    treeBytes: tree.bytes,
    treeFiles: tree.files,
    gitBytes: git.bytes,
    nodeModulesBytes,
    nodeModulesRoots: moduleRoots,
    totalBytes: sumMeasurements([tree.bytes, git.bytes, nodeModulesBytes], { asOf }),
    // Working-tree mtime only: `.git` and `node_modules` churn on operations the
    // user did not perform, so including them would report a `pnpm install` as
    // "last active".
    lastActivity: tree.newestMtimeMs === null
      ? unknown('no readable working-tree entry')
      : measured(tree.newestMtimeMs, { asOf }),
    treeExclusions: [...OVERHEAD_DIRS],
    complete: tree.complete && git.complete,
  };
}

/**
 * ProjectFootprint rows for every project in the shared discovery catalog.
 *
 * @param {{ discover?: Function, walk?: Function, limits?: object, countLines?: Function,
 *           projects?: Array<{path: string, label: string}>|null, loc?: boolean,
 *           limit?: number|null, onProgress?: Function, now?: () => number,
 *           fsImpl?: typeof fs }} [options]
 * @returns {object} the ProjectFootprint section of a FootprintSnapshot
 */
export function collectProjects({
  discover = discoverRuvfloProjects,
  walk = walkTree,
  limits = {},
  countLines: countLinesImpl = countLines,
  projects = null,
  loc = true,
  limit = null,
  onProgress = null,
  now = Date.now,
  fsImpl = fs,
} = {}) {
  const asOf = now();
  let catalog;
  // Discovery is a candidate-path source; if it cannot run, this section reports
  // nothing rather than taking the rest of the snapshot down with it.
  let discoveryReason = null;
  try { catalog = projects ?? discover(); } catch (error) { catalog = []; discoveryReason = error?.code ?? 'discovery failed'; }
  const rows = Array.isArray(catalog) ? catalog : [];
  const selected = typeof limit === 'number' && limit >= 0 ? rows.slice(0, limit) : rows;

  const out = [];
  for (const project of selected) {
    if (!project?.path) continue;
    notify(onProgress, { scanned: out.length, total: selected.length, phase: 'project', path: project.path });
    out.push(measureProject(project, { walk, limits, countLines: countLinesImpl, loc, asOf, fsImpl }));
  }
  notify(onProgress, { scanned: out.length, total: selected.length, phase: 'done', path: null });

  return {
    asOf,
    projects: out,
    count: discoveryReason ? unknown(discoveryReason) : measured(rows.length, { asOf }),
    scanned: out.length,
    truncated: selected.length < rows.length,
    locMeasured: loc,
    complete: !discoveryReason && selected.length === rows.length && out.every((row) => row.complete),
  };
}
