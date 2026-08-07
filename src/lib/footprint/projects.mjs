// Project footprints — one row per project this machine has had a session with:
// approximate LOC by language, working-tree bytes, `.git` bytes, `node_modules`
// bytes, last activity, and the origin remote's web page when one exists.
//
// TWO POPULATIONS, deliberately not the same number. The TABLE covers projects
// that still exist on disk, because those are the only ones a byte or LOC figure
// can be taken of at all. The KPI counts, carried alongside it, cover every
// project ever seen — including the ones that have since been deleted, which is
// exactly the fact a "how many projects has this machine touched" question is
// asking about. `project-sources.mjs` produces both; a consumer that renders
// only one of them must say which (`method` travels with the payload for that).
//
// The three byte figures stay SEPARATE on purpose (ADR-0025): `node_modules`
// dominates and `.git` distorts, so folding either into the tree would let
// reinstallable overhead masquerade as "your project got big".
//
// WHAT A PROJECT IS MADE OF comes from the stack registry (`stack-detect.mjs`),
// not from a map kept here. Two kinds of fact come back and they are kept apart:
//
//   languages  carry LINES — an extension is what a line belongs to, so these are
//              what the stacked bar renders;
//   stack      (frameworks / SDKs / tools) carries PRESENCE ONLY and is never
//              given a line count. React does not own lines, the .tsx files do,
//              and putting both on one proportional bar would count the same bytes
//              twice. The field is structurally absent from the payload, so no
//              surface can make that mistake by accident.
//
// LOC is APPROXIMATE by invariant 11 and says so in the payload: it is an
// extension-bucketed newline count with a stated exclusion list, produced by the
// kit's own bounded walker (zero runtime dependencies — no cloc, no tokei). An
// extension the registry does not map is NEVER counted — the top unmapped
// extensions on a real machine are .jsonl/.png/.jar/.dll, i.e. data and binaries,
// and counting them would corrupt the figure. They are carried through BY NAME
// instead, as the unrecognized tail, so "Other" renders as a named to-do rather
// than a shrug.
//
// Discovery supplies PATHS ONLY (invariant 9). Every figure below is measured here.
import fs from 'node:fs';
import path from 'node:path';
import { parseRepoSlug } from '../admin-collect.mjs';
import { discoverProjectSources } from './project-sources.mjs';
import { detectStack, STACK_EXCLUSIONS } from './stack-detect.mjs';
import { STACK_REGISTRY_VERSION } from './stack-registry.mjs';
import {
  walkTree, rootMeasurements, measured, statNode, UNKNOWN, unknown, sumMeasurements,
} from './walk.mjs';

/** Directories that are never code and never the user's work. Excluded from the
 *  tree walk, from LOC, and from the nested-`node_modules` search alike, so the
 *  three byte figures partition the project rather than overlapping it. */
const OVERHEAD_DIRS = new Set(['.git', 'node_modules']);

/** Depth at which a workspace's nested `node_modules` still gets attributed. */
const NODE_MODULES_MAX_DEPTH = 6;

/** The exclusion list every consumer must be able to state alongside the figure
 *  (invariant 11). Deliberate exclusions are why LOC is approximate; they are NOT
 *  a failed measurement, so they never mark the count partial.
 *
 *  Retained under its original name for existing consumers: the list is now
 *  STATED BY THE REGISTRY-BACKED DETECTOR rather than assembled here, so the
 *  exclusions a project row prints and the ones the scan actually applied cannot
 *  drift apart. */
export const LOC_EXCLUSIONS = STACK_EXCLUSIONS;

/** Aggregate tail caps, matching stack-detect's per-project ones: a machine-wide
 *  to-do list longer than this is not read, and the totals beside it state what
 *  the slice left out. */
const SECTION_TAIL_EXTENSIONS = 40;
const SECTION_TAIL_DEPENDENCIES = 50;

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
  // Stat before read: a cloud provider's evicted placeholder (real size, zero
  // allocated blocks) stats instantly but blocks forever on open, waiting for a
  // provider that may be signed out. `unknown` with a stated reason is the
  // honest answer — inventing `local-only` would claim this repo has no remote.
  try {
    const st = fsImpl.lstatSync(configFile);
    if (st.blocks === 0 && st.size > 0) {
      return { status: 'unknown', name: null, raw: null, hostname: null, host: null, slug: null, webUrl: null, reason: 'cloud placeholder (not materialized)' };
    }
  } catch { /* the read below reports the errno; one stat failure decides nothing */ }
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

// ── lines of code, and what the lines are written in ──────────────────────────
//
// Both sections below are PROJECTIONS of one `detectStack()` pass. The pass is
// run once per project and split here rather than measured twice: a second walk
// would double the I/O of the most expensive part of the scan to re-derive facts
// the first walk already held.

/** Was there a measurement at all? `detectStack` reports an unwalkable root with
 *  an unknown `totalLines` and empty lists — and an empty list of languages is
 *  indistinguishable from "this project has none" unless the caller checks. */
const stackMeasured = (detected) => Boolean(detected?.totalLines)
  && detected.totalLines.status !== UNKNOWN;

/**
 * The LOC projection: lines and only lines.
 *
 * `byLanguage` (bucket id → lines) is kept for the surfaces that already read it;
 * `languages` is the ranked, registry-described form the stacked bar renders,
 * each row carrying the palette SLOT the registry assigned rather than a colour.
 * Both come from the same detection, so they cannot disagree.
 *
 * `total` is `partial` only when a cap fired or a subtree was unreadable — the
 * exclusion list is a deliberate scope, not a failure, which is precisely why the
 * figure ships with `approximate` and `exclusions` attached (invariant 11).
 */
function locFromStack(detected) {
  const base = {
    approximate: true,
    exclusions: [...STACK_EXCLUSIONS],
    registryVersion: detected?.registryVersion ?? STACK_REGISTRY_VERSION,
  };
  if (!stackMeasured(detected)) {
    return {
      ...base,
      total: detected?.totalLines ?? unknown('not measured'),
      byLanguage: null,
      languages: null,
      files: null,
      skipped: 0,
      complete: false,
      degraded: detected?.degraded ?? [],
    };
  }
  const languages = detected.languages ?? [];
  const byLanguage = {};
  for (const row of languages) byLanguage[row.id] = row.lines;
  return {
    ...base,
    total: detected.totalLines,
    byLanguage,
    // Ranked by lines already; copied so a consumer cannot mutate the detection.
    languages: languages.map((row) => ({ ...row })),
    files: detected.files,
    skipped: detected.skipped ?? 0,
    // The WALK's completeness, read off the measurement the walk stamped. A
    // manifest that would not parse is a stack fact, not a line-count fact:
    // `detected.complete` folds both in, so it is the wrong signal here.
    complete: detected.totalLines?.partial !== true,
    degraded: detected.degraded ?? [],
  };
}

/**
 * The stack projection: PRESENCE, never lines.
 *
 * `items` are frameworks / SDKs / tools, each with the `kind` it was registered
 * under and the `via` that matched it. None of them carries a line count and none
 * ever may — see this file's header.
 *
 * `unrecognized` is the tail the registry could not name: extensions ranked by
 * file count, and declared dependencies that matched no entry. It is the whole
 * reason an unmapped extension can be excluded from LOC without vanishing.
 */
function stackFromDetection(detected) {
  const base = { registryVersion: detected?.registryVersion ?? STACK_REGISTRY_VERSION };
  if (!stackMeasured(detected)) {
    return {
      ...base,
      status: 'unknown',
      reason: detected?.totalLines?.reason ?? 'not measured',
      // Null, not `[]`: an empty list would state that this project declares no
      // frameworks, which is a measurement nobody took (invariant 2).
      items: null,
      manifests: null,
      nonSource: null,
      unrecognized: null,
      complete: false,
      degraded: detected?.degraded ?? [],
    };
  }
  return {
    ...base,
    status: 'measured',
    reason: null,
    items: (detected.stack ?? []).map((row) => ({ ...row })),
    manifests: (detected.manifests ?? []).map((row) => ({ ...row })),
    nonSource: { ...(detected.nonSource ?? { files: null, bytes: null }) },
    unrecognized: {
      extensions: (detected.unrecognized?.extensions ?? []).map((row) => ({ ...row })),
      extensionsTotal: detected.unrecognized?.extensionsTotal ?? null,
      dependencies: (detected.unrecognized?.dependencies ?? []).map((row) => ({ ...row })),
      dependenciesTotal: detected.unrecognized?.dependenciesTotal ?? null,
    },
    complete: detected.complete !== false,
    degraded: detected.degraded ?? [],
  };
}

/** The not-measured LOC shape. `loc: false` skips the walk entirely, so every
 *  figure is unknown-with-reason — never a zero, which would claim an empty
 *  project (invariant 2). */
const locNotMeasured = (reason) => locFromStack({ totalLines: unknown(reason) });

/** The not-measured stack shape, for the same reason. */
const stackNotMeasured = (reason) => stackFromDetection({ totalLines: unknown(reason) });

/**
 * Approximate lines of code under `root`, bucketed by language.
 *
 * A LOC-only projection of one `detectStack()` pass with the manifest reads
 * switched off, for a caller that wants the count without the stack. Everything
 * it inherits — never-follow-symlinks, depth and entry caps, the
 * degrade-this-node-only failure mode, and which extensions are counted at all —
 * comes from the shared walker and the registry, not from this module.
 *
 * @param {string} root
 * @param {{ walk?: Function, limits?: object, asOf?: number|null,
 *           detect?: Function, fsImpl?: typeof fs }} [options]
 * @returns {object} LocCount
 */
export function countLines(root, {
  walk = walkTree, limits = {}, asOf = null, detect = detectStack, fsImpl = fs,
} = {}) {
  return locFromStack(detect(root, { walk, limits, asOf, fsImpl, manifests: false }));
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
    hosts: Array.isArray(project.hosts) ? [...project.hosts] : null,
    remote: { status: 'unknown', name: null, raw: null, hostname: null, host: null, slug: null, webUrl: null, reason },
    loc: locNotMeasured(reason),
    stack: stackNotMeasured(reason),
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
 * the only thing discovery contributes (invariant 9) — `hosts` rides along as
 * attribution (which hosts saw this project), never as a measurement.
 *
 * @param {{ path: string, label: string, source?: string, hosts?: string[] }} project
 * @param {{ walk?: Function, limits?: object, detect?: Function, loc?: boolean,
 *           asOf?: number|null, fsImpl?: typeof fs }} [options]
 *   `loc: false` skips the stack pass entirely — the expensive part of a project
 *   row — and both `loc` and `stack` then report unknown rather than empty.
 * @returns {object} ProjectFootprint
 */
export function measureProject(project, {
  walk = walkTree, limits = {}, detect = detectStack,
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

  // ONE detection pass, split into its two projections below: lines belong to
  // languages, presence belongs to frameworks/SDKs/tools, and the tail names what
  // neither could claim.
  const detected = loc ? detect(root, { walk, limits, asOf, fsImpl }) : null;

  return {
    path: root,
    label: project.label,
    source: project.source ?? null,
    hosts: Array.isArray(project.hosts) ? [...project.hosts] : null,
    remote: projectRemote(root, { fsImpl }),
    loc: detected ? locFromStack(detected) : locNotMeasured('not measured'),
    stack: detected ? stackFromDetection(detected) : stackNotMeasured('not measured'),
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

/** everSeen / onDisk / gitRepos for an EXPLICITLY supplied catalog, which carries
 *  no existence facts of its own. Two lstats per row — negligible next to the
 *  tree walk that follows, and the alternative is a KPI that cannot be stated. */
function summarizeCatalog(rows, fsImpl) {
  let onDisk = 0;
  let gitRepos = 0;
  for (const row of rows) {
    if (!row?.path) continue;
    const node = statNode(row.path, { fsImpl });
    if (node.status === UNKNOWN || node.kind !== 'dir') continue;
    onDisk += 1;
    // A linked worktree's `.git` is a FILE, not a directory; checking only for a
    // directory would undercount every worktree on the machine.
    const git = statNode(path.join(row.path, '.git'), { fsImpl });
    if (git.status !== UNKNOWN && (git.kind === 'dir' || git.kind === 'file')) gitRepos += 1;
  }
  return { everSeen: rows.length, onDisk, gitRepos, unresolved: 0, complete: true };
}

/** A `discoverProjectSources()` PAYLOAD rather than a plain catalog array.
 *  Accepted wherever a catalog is, so a caller holding the payload — which is the
 *  only thing that carries everSeen/onDisk/gitRepos and the per-row `exists` flag
 *  — does not have to take it apart and lose them on the way in. */
function isSourcesPayload(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Array.isArray(value.projects);
}

/**
 * The machine-wide unrecognized tail: every extension and declared dependency the
 * registry could not name, merged across projects and ranked.
 *
 * Per project the tail is a curiosity; merged it is the to-do list a release
 * closes, which is the whole reason an unmapped extension is excluded from LOC
 * rather than guessed at. A total is stated only when it is a true distinct count
 * — if any project's own list was capped, the merged count is a floor and says so
 * with `null` rather than a smaller number presented as complete.
 */
function aggregateUnrecognized(rows) {
  const extensions = new Map();
  const dependencies = new Map();
  let extensionsPartial = false;
  let dependenciesPartial = false;
  let measuredRows = 0;

  for (const row of rows) {
    const tail = row?.stack?.unrecognized;
    if (!tail) continue;
    measuredRows += 1;
    if (tail.extensionsTotal === null || tail.extensionsTotal > tail.extensions.length) {
      extensionsPartial = true;
    }
    if (tail.dependenciesTotal === null || tail.dependenciesTotal > tail.dependencies.length) {
      dependenciesPartial = true;
    }
    for (const entry of tail.extensions) {
      const held = extensions.get(entry.ext);
      if (held) {
        held.files += entry.files;
        held.bytes += entry.bytes;
        held.projects += 1;
      } else {
        extensions.set(entry.ext, { ext: entry.ext, files: entry.files, bytes: entry.bytes, projects: 1 });
      }
    }
    for (const entry of tail.dependencies) {
      const key = `${entry.manifest} ${entry.name.toLowerCase()}`;
      const held = dependencies.get(key);
      if (held) held.projects += 1;
      else dependencies.set(key, { name: entry.name, manifest: entry.manifest, projects: 1 });
    }
  }

  const rankedExtensions = [...extensions.values()]
    .sort((a, b) => b.files - a.files || a.ext.localeCompare(b.ext));
  const rankedDependencies = [...dependencies.values()]
    .sort((a, b) => b.projects - a.projects
      || a.manifest.localeCompare(b.manifest) || a.name.localeCompare(b.name));

  return {
    projectsMeasured: measuredRows,
    extensions: rankedExtensions.slice(0, SECTION_TAIL_EXTENSIONS),
    extensionsTotal: extensionsPartial ? null : rankedExtensions.length,
    dependencies: rankedDependencies.slice(0, SECTION_TAIL_DEPENDENCIES),
    dependenciesTotal: dependenciesPartial ? null : rankedDependencies.length,
  };
}

/**
 * ProjectFootprint rows for every project that still exists on disk, plus the
 * ever-seen / on-disk / git-repo counts the Summary KPI states together.
 *
 * The TABLE is the on-disk subset by necessity — a deleted project has no bytes
 * and no lines to count — while `everSeen` keeps the deleted ones, because the
 * count of projects this machine has touched is a different question from the
 * count it can still measure. Rendering either number alone without saying which
 * one it is would misreport both, which is why `method` ships with them.
 *
 * @param {{ discover?: Function, sources?: object|null, walk?: Function, limits?: object,
 *           detect?: Function, projects?: Array<{path: string, label: string}>|object|null,
 *           loc?: boolean, limit?: number|null, onProgress?: Function,
 *           now?: () => number, fsImpl?: typeof fs }} [options]
 *   `sources` is an already-resolved `discoverProjectSources()` payload, so a
 *   caller that shares discovery with another collector pays for the transcript
 *   sweep once. `projects` takes EITHER shape: an explicit catalog ARRAY, whose
 *   rows are measured exactly as given because the caller — not discovery — chose
 *   them and the on-disk filter therefore does not apply; or a discovery PAYLOAD,
 *   which is read exactly as `sources` is, on-disk filter and KPI counts included.
 * @returns {object} the ProjectFootprint section of a FootprintSnapshot
 */
export function collectProjects({
  discover = discoverProjectSources,
  sources = null,
  walk = walkTree,
  limits = {},
  detect = detectStack,
  projects = null,
  loc = true,
  limit = null,
  onProgress = null,
  now = Date.now,
  fsImpl = fs,
} = {}) {
  const asOf = now();
  // Discovery is a candidate-path source; if it cannot run, this section reports
  // nothing rather than taking the rest of the snapshot down with it.
  let discoveryReason = null;
  let catalog;
  let counts;
  if (Array.isArray(projects)) {
    catalog = projects;
    counts = summarizeCatalog(projects, fsImpl);
  } else {
    try {
      const payload = (isSourcesPayload(projects) ? projects : sources) ?? discover({ fsImpl });
      // Only projects that still exist can be walked, so only they become rows —
      // the vanished ones survive in `everSeen`, not as unmeasurable table rows.
      catalog = (payload?.projects ?? []).filter((project) => project?.exists);
      counts = {
        everSeen: payload?.everSeen ?? 0,
        onDisk: payload?.onDisk ?? 0,
        gitRepos: payload?.gitRepos ?? 0,
        unresolved: payload?.unresolved ?? 0,
        complete: payload?.complete !== false,
        method: payload?.method ?? null,
        sources: payload?.sources ?? null,
      };
    } catch (error) {
      catalog = [];
      discoveryReason = error?.code ?? 'discovery failed';
    }
  }
  const rows = Array.isArray(catalog) ? catalog : [];
  const selected = typeof limit === 'number' && limit >= 0 ? rows.slice(0, limit) : rows;

  const out = [];
  for (const project of selected) {
    if (!project?.path) continue;
    notify(onProgress, { scanned: out.length, total: selected.length, phase: 'project', path: project.path });
    out.push(measureProject(project, { walk, limits, detect, loc, asOf, fsImpl }));
  }
  notify(onProgress, { scanned: out.length, total: selected.length, phase: 'done', path: null });

  // A count whose sweep hit an unreadable transcript or an unrecoverable project
  // directory is a FLOOR, not a total — `partial` is what makes a surface render
  // it as "≥ N" instead of quietly overstating certainty.
  const partial = counts ? counts.complete === false : false;
  const kpi = (value) => (discoveryReason ? unknown(discoveryReason) : measured(value, { asOf, partial }));

  return {
    asOf,
    projects: out,
    // Retained under its original name for existing consumers; it has always
    // meant "how many projects discovery found", which is now everSeen.
    count: kpi(counts?.everSeen ?? 0),
    everSeen: kpi(counts?.everSeen ?? 0),
    onDisk: kpi(counts?.onDisk ?? 0),
    gitRepos: kpi(counts?.gitRepos ?? 0),
    unresolved: counts?.unresolved ?? 0,
    method: counts?.method ?? null,
    sources: counts?.sources ?? null,
    scanned: out.length,
    truncated: selected.length < rows.length,
    locMeasured: loc,
    // Which catalog produced the language and stack facts in every row above. A
    // figure that moves between releases can then be explained by the registry
    // that changed rather than by the machine that did not.
    registryVersion: STACK_REGISTRY_VERSION,
    // The machine-wide to-do list: what the registry saw and could not name.
    // Stated as `null` when nothing was scanned, because an empty tail from an
    // unmeasured scan would read as "the registry knows everything here".
    unrecognized: loc ? aggregateUnrecognized(out) : null,
    complete: !discoveryReason && !partial && selected.length === rows.length
      && out.every((row) => row.complete),
  };
}
