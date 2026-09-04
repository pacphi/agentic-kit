// Storage breakdown — the category → host → project → session tree, and the
// derived views over the same walk (trailing-30d growth, top-N giants) (ADR-0025
// §4, docs/ddd/machine-footprint.md "Storage breakdown").
//
// The reclaimable-space ADVISORY half of this domain — `collectReclaimables` and
// everything it composes — lives in storage-reclaim.mjs (orchestration + shared
// plumbing) and storage-reclaim-detectors.mjs (the per-accumulation-pattern
// detectors: superseded snapshots, regenerable caches, browser revisions,
// runtime versions, orphaned transcripts, orphaned worktrees), split out here by
// natural seam (2026-08 complexity program, ADR-0037) once this file passed
// 1,000 lines. Both are re-exported below so every existing import of
// `storage.mjs` keeps working unchanged.
//
// This module is ADVISORY ONLY by invariant 4: there is no delete, prune, or
// cleanup verb anywhere in this domain, and none may be added. `Reclaimable
// Candidate` rows carry a path, a size, and a rationale — a `cleanupHint` names
// the CLI that already owns the removal, and that string is documentation, not
// a command this module runs. npx.mjs's pruneNpxStale is deliberately NOT
// imported; only its read-only scanNpxStale is.
//
// SAFETY IS A FIELD, NOT A TONE OF VOICE. Every reclaim candidate carries
// `safety`: 'regenerable' (the owning tool refetches it on demand — the npm
// content cache, the Homebrew download cache, the brain's superseded KB copies)
// or 'review' (plausible but NOT safe to state as removable — mise has eight
// node entries on this machine and some of them are the aliases a live
// toolchain resolves through; a browser revision may still be pinned by an
// installed package). A review row is a pointer at something to look at, never
// a figure to sweep, and `summarizeReclaimables` totals the two tiers
// SEPARATELY on purpose: a combined "you could free N" that mixes them would be
// the honest-measurement contract broken at the last mile.
//
// `bytesMeaning` says what the bytes on a row are: 'candidate' (the bytes the
// row is actually about) or 'installed' (what is on disk, offered as context on
// a review row that has no defensible candidate subset — the mise rows).
//
// Absent candidate = absent. A cache root that does not exist, a family with no
// superseded members, a walk that measured a real zero: none of those produce a
// row. Only something that IS there is listed, so an empty advisory panel means
// "nothing crossed a threshold" rather than "nothing was looked at".
//
// Metadata only (invariant 1). Every figure comes from dirents, lstat sizes and
// mtimes. A transcript's contents are never opened — which is also why codex
// transcripts have no project attribution here: codex rollout PATHS are dated,
// not project-scoped, and the project lives inside the file. That reads as an
// honest "unattributable", never as a guess and never as a zero.
//
// One deliberate exception, narrow and documented: orphaned-worktree detection
// (storage-reclaim-detectors.mjs) reads `<repo>/.git/worktrees/<name>/gitdir`,
// which holds a single filesystem PATH. That is the same class of datum as
// `.git/config`'s remote URL, which ADR-0025 §7 already sanctions, and it is the
// only way an orphaned worktree can be identified at all. Bounded to 4 KB,
// parsed as a path and nothing else, and skipped entirely when
// `detectWorktrees` is false.
import fs from 'node:fs';
import path from 'node:path';
import { home, claudeDir, codexDir, configDir } from '../paths.mjs';
import { defaultOpencodeDbPath } from '../usage-opencode.mjs';
import { decodeClaudeProjectDir } from './project-sources.mjs';
import {
  walkTree, rootMeasurements, measured, unknown, sumMeasurements,
} from './walk.mjs';
import { collectReclaimables, summarizeReclaimables } from './storage-reclaim.mjs';

export const STORAGE_CATEGORIES = Object.freeze([
  'transcripts', 'ledgers-and-logs', 'learning-stores', 'kit-caches',
]);

export const STORAGE_DEFAULTS = Object.freeze({
  growthDays: 30,
  topN: 10,
  // A codex sessions root holds one file per session and years of them; the
  // tree needs a ceiling that keeps the payload renderable. The remainder is
  // folded into one aggregate child so the parent's total still adds up.
  maxChildren: 200,
  transcriptAgeDays: 180,
  npxEnvIdleDays: 90,
  worktreeIdleDays: 90,
  maxWorktreeWalks: 32,
  // How many members of one family (dated KB copies, browser revisions, runtime
  // versions) are walked. A family that exceeds it reports what it measured as a
  // floor rather than walking an unbounded number of trees.
  maxFamilyWalks: 64,
  samplePaths: 5,
});

/** Host ledger and log files that are named by generation
 *  (`state_5.sqlite`, `logs_2.sqlite`, plus their -wal/-shm siblings). Matching
 *  the family rather than one name is deliberate: codex bumps the generation
 *  suffix on schema changes and leaves the old file behind. */
const CODEX_LEDGER_RE = /^[a-z_]+_\d+\.sqlite(?:-wal|-shm)?$/;
const OPENCODE_STORE_RE = /^opencode\.db(?:-wal|-shm)?$/;
const flatDir = () => true;

/**
 * @typedef {{
 *   id: string, category: string, host: string, label: string, path: string,
 *   layout: 'claude-projects'|'flat-sessions'|'tree',
 *   project?: string, projectPath?: string,
 *   acceptFile?: (name: string) => boolean,
 *   skipDir?: (dir: string, name: string, depth: number) => boolean,
 * }} StorageRoot
 */

/**
 * The known roots this domain measures, one descriptor per node.
 *
 * `layout` decides how leaves are derived:
 *   claude-projects  `<root>/<encoded-cwd>/<session>.jsonl` — project from the
 *                    directory name, session from the file.
 *   flat-sessions    session leaves with no path-derivable project (codex
 *                    rollouts, the opencode store).
 *   tree             no leaves; the root is the node, files aggregate into it.
 *
 * `projects`, when supplied, adds the per-project learning stores. Passing null
 * (the default) means "no project catalog was supplied" — that category then
 * reports unknown rather than a fabricated zero; passing `[]` means a catalog
 * was supplied and was genuinely empty, which is a measured zero.
 *
 * @returns {StorageRoot[]}
 */
export function defaultStorageRoots({ env = process.env, projects = null } = {}) {
  const stateRoot = env.XDG_STATE_HOME || path.join(home, '.local', 'state');
  const opencodeData = path.dirname(defaultOpencodeDbPath());
  const claude = (name) => path.join(claudeDir(), name);
  const codex = (name) => path.join(codexDir(), name);

  /** @type {StorageRoot[]} */
  const roots = [
    {
      id: 'claude-transcripts', category: 'transcripts', host: 'claude',
      label: 'session transcripts', path: claude('projects'), layout: 'claude-projects',
    },
    {
      id: 'codex-transcripts', category: 'transcripts', host: 'codex',
      label: 'session rollouts', path: codex('sessions'), layout: 'flat-sessions',
    },
    {
      id: 'opencode-store', category: 'transcripts', host: 'opencode',
      label: 'session store', path: opencodeData, layout: 'flat-sessions',
      acceptFile: (name) => OPENCODE_STORE_RE.test(name), skipDir: flatDir,
    },
    {
      id: 'codex-ledgers', category: 'ledgers-and-logs', host: 'codex',
      label: 'thread ledgers', path: codexDir(), layout: 'tree',
      acceptFile: (name) => CODEX_LEDGER_RE.test(name), skipDir: flatDir,
    },
    {
      id: 'codex-history', category: 'ledgers-and-logs', host: 'codex',
      label: 'history.jsonl', path: codex('history.jsonl'), layout: 'tree',
    },
    {
      id: 'codex-shell-snapshots', category: 'ledgers-and-logs', host: 'codex',
      label: 'shell snapshots', path: codex('shell_snapshots'), layout: 'tree',
    },
    {
      id: 'claude-logs', category: 'ledgers-and-logs', host: 'claude',
      label: 'logs', path: claude('logs'), layout: 'tree',
    },
    {
      id: 'claude-debug', category: 'ledgers-and-logs', host: 'claude',
      label: 'debug', path: claude('debug'), layout: 'tree',
    },
    {
      id: 'claude-telemetry', category: 'ledgers-and-logs', host: 'claude',
      label: 'telemetry', path: claude('telemetry'), layout: 'tree',
    },
    {
      id: 'claude-statsig', category: 'ledgers-and-logs', host: 'claude',
      label: 'statsig', path: claude('statsig'), layout: 'tree',
    },
    {
      id: 'claude-shell-snapshots', category: 'ledgers-and-logs', host: 'claude',
      label: 'shell snapshots', path: claude('shell-snapshots'), layout: 'tree',
    },
    {
      id: 'claude-history', category: 'ledgers-and-logs', host: 'claude',
      label: 'history.jsonl', path: claude('history.jsonl'), layout: 'tree',
    },
    {
      id: 'opencode-logs', category: 'ledgers-and-logs', host: 'opencode',
      label: 'logs', path: path.join(opencodeData, 'log'), layout: 'tree',
    },
    {
      id: 'ak-runtime-debug', category: 'ledgers-and-logs', host: 'agentic-kit',
      label: 'runtime-debug.log',
      path: path.join(stateRoot, 'agentic-kit', 'runtime-debug.log'), layout: 'tree',
    },
    {
      id: 'ak-config', category: 'kit-caches', host: 'agentic-kit',
      label: 'config, indexes & snapshots', path: configDir(), layout: 'tree',
    },
    {
      id: 'claude-cache', category: 'kit-caches', host: 'claude',
      label: 'cache', path: claude('cache'), layout: 'tree',
    },
    {
      id: 'claude-image-cache', category: 'kit-caches', host: 'claude',
      label: 'image cache', path: claude('image-cache'), layout: 'tree',
    },
    {
      id: 'claude-paste-cache', category: 'kit-caches', host: 'claude',
      label: 'paste cache', path: claude('paste-cache'), layout: 'tree',
    },
    {
      id: 'codex-cache', category: 'kit-caches', host: 'codex',
      label: 'cache', path: codex('cache'), layout: 'tree',
    },
  ];

  for (const project of projects ?? []) {
    const label = path.basename(project);
    for (const [dir, what] of [
      ['.claude-flow', 'ruflo learning state'],
      ['.agentic-qe', 'agentic-qe state'],
      ['.swarm', 'swarm memory'],
    ]) {
      roots.push({
        id: `learning:${project}:${dir}`,
        category: 'learning-stores',
        host: 'project',
        project: label,
        projectPath: project,
        label: what,
        path: path.join(project, dir),
        layout: 'tree',
      });
    }
  }
  return roots;
}

/** YYYY-MM-DD in LOCAL time — the same convention usage-index's localDay uses,
 *  so a growth day and a usage day mean the same calendar day. */
export function localDay(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function newNode({ key, kind, label, path: nodePath = null, host = null, attribution = null }) {
  return {
    key, kind, label, path: nodePath, host, attribution,
    bytes: 0, files: 0, newestMtimeMs: null, presence: 'present',
    children: new Map(),
  };
}

function childOf(children, key, spec) {
  if (!children.has(key)) children.set(key, newNode({ key, ...spec }));
  return children.get(key);
}

function bump(node, bytes, mtimeMs) {
  node.bytes += bytes;
  node.files += 1;
  if (node.newestMtimeMs === null || mtimeMs > node.newestMtimeMs) node.newestMtimeMs = mtimeMs;
}

/** Depth-first finalize: Map children → sorted array, capped, remainder folded
 *  into one aggregate node so a capped parent's total still adds up. */
function finalizeNode(node, { asOf, maxChildren }) {
  const kids = [...node.children.values()]
    .map((child) => finalizeNode(child, { asOf, maxChildren }))
    .sort((a, b) => (b.bytes.value ?? 0) - (a.bytes.value ?? 0));
  let children = kids;
  if (kids.length > maxChildren) {
    const kept = kids.slice(0, maxChildren);
    const rest = kids.slice(maxChildren);
    const restBytes = rest.reduce((acc, c) => acc + (c.bytes.value ?? 0), 0);
    const restFiles = rest.reduce((acc, c) => acc + (c.files.value ?? 0), 0);
    children = [...kept, {
      key: `${node.key}::others`,
      kind: 'aggregate',
      label: `${rest.length} more`,
      path: null,
      host: node.host,
      attribution: null,
      presence: 'present',
      bytes: measured(restBytes, { asOf }),
      files: measured(restFiles, { asOf }),
      newestMtimeMs: null,
      children: [],
    }];
  }
  return {
    key: node.key,
    kind: node.kind,
    label: node.label,
    path: node.path,
    host: node.host,
    attribution: node.attribution,
    presence: node.presence,
    bytes: node.bytesMeasurement ?? measured(node.bytes, { asOf, partial: node.partial === true }),
    files: node.filesMeasurement ?? measured(node.files, { asOf, partial: node.partial === true }),
    newestMtimeMs: node.newestMtimeMs,
    children,
  };
}

/** Where a file sits in the project/session part of the tree, from its PATH
 *  alone. `attribution` states how the project was determined so the UI can say
 *  "unattributable" rather than showing an empty cell. */
function leafKeysFor(root, file) {
  const rel = path.relative(root.path, file);
  const parts = rel.split(path.sep).filter(Boolean);
  const session = parts.length ? parts[parts.length - 1] : path.basename(file);
  if (root.layout === 'claude-projects' && parts.length > 1) {
    return { project: parts[0], attribution: 'path', session };
  }
  if (root.layout === 'flat-sessions' || root.layout === 'claude-projects') {
    return { project: null, attribution: 'none', session };
  }
  return { project: root.project ?? null, attribution: root.project ? 'catalog' : 'root', session: null };
}

/**
 * Walk every storage root once, folding files into the category → host →
 * project → session tree and the growth / topN / aged-transcript accumulators
 * in the same pass. Split out of `collectStorage` (2026-08 complexity program)
 * purely to give the walk loop its own complexity budget — the accumulators and
 * the per-file `onFile` handler are unchanged. Return shape left to inference
 * (categories/growth/agedTranscripts/transcriptProjects are Maps;
 * sessionLeaves/files are the same row arrays `collectStorage` always sorted).
 */
function walkStorageRoots(rootList, { walk, limits, fsImpl, topN, growthCutoff, agedCutoff, opts, asOf }) {
  const categories = new Map();
  const growth = new Map();
  const sessionLeaves = [];
  const files = [];
  const agedTranscripts = new Map();
  // Per transcript-project-directory totals, kept alongside the tree because the
  // orphaned-transcript detector needs exactly what this walk already measured —
  // re-walking those directories to learn the same bytes would be waste.
  const transcriptProjects = new Map();
  let anyDegraded = false;

  const trimTop = (list) => {
    if (list.length <= topN * 8) return;
    list.sort((a, b) => b.bytes - a.bytes);
    list.length = topN;
  };

  for (const root of rootList) {
    const category = childOf(categories, root.category, {
      kind: 'category', label: root.category,
    });
    const host = childOf(category.children, root.host, {
      kind: 'host', label: root.host, host: root.host,
    });

    const projectKey = root.project ?? root.id;
    const rootNode = root.layout === 'claude-projects'
      ? host
      : childOf(host.children, projectKey, {
        kind: 'project',
        label: root.project ?? root.label,
        path: root.path,
        host: root.host,
        attribution: root.project ? 'catalog' : 'root',
      });

    const result = walk(root.path, {
      ...limits,
      fsImpl,
      ...(root.acceptFile ? { acceptFile: (name) => root.acceptFile(name) } : {}),
      ...(root.skipDir ? { skipDir: root.skipDir } : {}),
      onFile: ({ file, name, bytes, mtimeMs }) => {
        bump(category, bytes, mtimeMs);
        bump(host, bytes, mtimeMs);
        if (rootNode !== host) bump(rootNode, bytes, mtimeMs);

        const { project, attribution, session } = leafKeysFor(root, file);
        let leafParent = rootNode;
        if (root.layout === 'claude-projects') {
          leafParent = childOf(host.children, project ?? '(unattributed)', {
            kind: 'project',
            label: project ?? 'unattributed',
            path: project ? path.join(root.path, project) : root.path,
            host: root.host,
            attribution,
          });
          bump(leafParent, bytes, mtimeMs);
          if (project && root.category === 'transcripts') {
            const key = `${root.id} ${project}`;
            const acc = transcriptProjects.get(key) ?? {
              host: root.host, rootPath: root.path, dir: project,
              path: path.join(root.path, project),
              bytes: 0, files: 0, newestMtimeMs: null,
            };
            acc.bytes += bytes;
            acc.files += 1;
            if (acc.newestMtimeMs === null || mtimeMs > acc.newestMtimeMs) {
              acc.newestMtimeMs = mtimeMs;
            }
            transcriptProjects.set(key, acc);
          }
        } else if (root.layout === 'flat-sessions') {
          rootNode.attribution = 'none';
        }
        if (session) {
          const leaf = childOf(leafParent.children, session, {
            kind: 'session', label: session, path: file, host: root.host, attribution,
          });
          bump(leaf, bytes, mtimeMs);
          sessionLeaves.push({
            session, host: root.host, category: root.category,
            project: project ?? null, attribution, path: file, bytes, mtimeMs,
          });
          trimTop(sessionLeaves);
        }

        if (mtimeMs >= growthCutoff) {
          if (!growth.has(root.host)) growth.set(root.host, new Map());
          const days = growth.get(root.host);
          const day = localDay(mtimeMs);
          const cell = days.get(day) ?? { bytes: 0, files: 0 };
          cell.bytes += bytes;
          cell.files += 1;
          days.set(day, cell);
        }

        files.push({ path: file, name, host: root.host, category: root.category, bytes, mtimeMs });
        trimTop(files);

        if (root.category === 'transcripts' && mtimeMs < agedCutoff) {
          const acc = agedTranscripts.get(root.host)
            ?? { host: root.host, root: root.path, files: 0, bytes: 0, oldestMtimeMs: null, samples: [] };
          acc.files += 1;
          acc.bytes += bytes;
          if (acc.oldestMtimeMs === null || mtimeMs < acc.oldestMtimeMs) acc.oldestMtimeMs = mtimeMs;
          if (acc.samples.length < opts.samplePaths) acc.samples.push(file);
          agedTranscripts.set(root.host, acc);
        }
      },
    });

    const { presence } = rootMeasurements(result, { asOf });
    if (rootNode !== host) rootNode.presence = presence;
    if (result.complete || presence === 'absent') continue;
    anyDegraded = true;
    // Invariant 6: this root degrades, its siblings under the same host keep
    // their measured figures. The ancestors stay measured but become `partial`
    // — a floor — because a sum that silently omits an unknown child would
    // read as a total, which is the zero-for-unknown failure in disguise.
    if (rootNode !== host) {
      if (result.status === 'unknown') {
        rootNode.bytesMeasurement = unknown(result.reason);
        rootNode.filesMeasurement = unknown(result.reason);
      } else {
        rootNode.partial = true;
      }
    }
    host.partial = true;
    category.partial = true;
  }

  return { categories, growth, sessionLeaves, files, agedTranscripts, transcriptProjects, anyDegraded };
}

/** Every category always appears, so a missing slice is never mistaken for a
 *  rendering gap. A category with no roots is a measured zero — EXCEPT
 *  learning-stores with no project catalog supplied, whose emptiness is
 *  ambiguous: "we were given nowhere to look" is not "there is nothing there". */
function fillMissingStorageCategories(categories, projects) {
  for (const id of STORAGE_CATEGORIES) {
    if (categories.has(id)) continue;
    const node = newNode({ key: id, kind: 'category', label: id });
    if (id === 'learning-stores' && projects === null) {
      node.presence = 'unknown';
      node.bytesMeasurement = unknown('no project catalog supplied');
      node.filesMeasurement = unknown('no project catalog supplied');
    }
    categories.set(id, node);
  }
}

/**
 * The storage section of a FootprintSnapshot.
 *
 * `consumers` is an already-collected ranked-consumers payload (consumers.mjs).
 * When supplied, a detector that needs the size of a path that view already
 * walked adopts that figure instead of walking the tree a second time — the npm
 * content cache alone is ~10^5 files, and measuring it twice in one deep scan is
 * pure I/O cost for an identical answer.
 *
 * @param {{
 *   projects?: string[]|null, now?: () => number, walk?: typeof walkTree,
 *   roots?: StorageRoot[]|null, limits?: object, growthDays?: number, topN?: number,
 *   maxChildren?: number, reclaim?: object, detectWorktrees?: boolean,
 *   detectCaches?: boolean, detectOrphanedTranscripts?: boolean,
 *   consumers?: object|null, install?: object|null, projectFootprints?: object[]|null,
 *   env?: NodeJS.ProcessEnv,
 *   decodeDir?: typeof decodeClaudeProjectDir,
 *   fsImpl?: typeof fs,
 * }} [options]
 */
export function collectStorage({
  projects = null,
  now = Date.now,
  walk = walkTree,
  roots = null,
  limits = {},
  growthDays = STORAGE_DEFAULTS.growthDays,
  topN = STORAGE_DEFAULTS.topN,
  maxChildren = STORAGE_DEFAULTS.maxChildren,
  reclaim = {},
  detectWorktrees = true,
  detectCaches = true,
  detectOrphanedTranscripts = true,
  consumers = null,
  install = null,
  projectFootprints = null,
  env = process.env,
  decodeDir = decodeClaudeProjectDir,
  fsImpl = fs,
} = {}) {
  const asOf = now();
  const opts = { ...STORAGE_DEFAULTS, ...reclaim };
  const rootList = roots ?? defaultStorageRoots({ projects });
  const growthCutoff = asOf - growthDays * 86_400_000;
  const agedCutoff = asOf - opts.transcriptAgeDays * 86_400_000;

  const {
    categories, growth, sessionLeaves, files, agedTranscripts, transcriptProjects, anyDegraded,
  } = walkStorageRoots(rootList, { walk, limits, fsImpl, topN, growthCutoff, agedCutoff, opts, asOf });

  fillMissingStorageCategories(categories, projects);

  const tree = [...categories.values()]
    .map((node) => finalizeNode(node, { asOf, maxChildren }))
    .sort((a, b) => (b.bytes.value ?? 0) - (a.bytes.value ?? 0));

  files.sort((a, b) => b.bytes - a.bytes);
  sessionLeaves.sort((a, b) => b.bytes - a.bytes);

  const reclaimables = collectReclaimables({
    asOf, agedTranscripts, transcriptProjects, projects, opts, walk, limits,
    detectWorktrees, detectCaches, detectOrphanedTranscripts, consumers, install,
    projectFootprints, env, decodeDir, fsImpl,
  });

  return {
    asOf,
    categories: tree,
    totals: {
      bytes: sumMeasurements(tree.map((c) => c.bytes), { asOf }),
      files: sumMeasurements(tree.map((c) => c.files), { asOf }),
    },
    growth: buildGrowth(growth, { asOf, growthDays }),
    // Decode only the rows that survive the top-N cut. `project` on a
    // claude-projects row is the ENCODED directory name, in which every `/`,
    // `.` and `-` became `-` — so it cannot be split back into a path by
    // string manipulation, and a client that guesses at the last hyphenated
    // segment turns `tub-vault` into `vault`. decodeClaudeProjectDir resolves
    // the ambiguity the only way it can be resolved: by walking the candidates
    // against the real filesystem. Doing it here, after the slice, bounds the
    // cost to topN rather than to every session file measured.
    topSessions: labelSessions(sessionLeaves.slice(0, topN), { decodeDir, fsImpl }),
    topFiles: files.slice(0, topN),
    reclaimables,
    reclaimSummary: summarizeReclaimables(reclaimables, { asOf }),
    complete: !anyDegraded,
  };
}

/**
 * Give each session row a human `projectLabel` beside its raw `project` key.
 *
 * The raw key stays untouched — it is the tree key everything else joins on.
 * The label is the decoded directory's basename when the decode succeeds, and
 * falls back to the encoded name when it does not: a project directory that no
 * longer exists cannot be decoded, and showing its encoded form is honest
 * where inventing a plausible name would not be.
 *
 * Memoized per distinct project key: the top-N rows commonly share a handful of
 * projects, and each decode is a bounded filesystem walk.
 *
 * @param {Array<Record<string, any>>} rows
 * @param {{ decodeDir?: typeof decodeClaudeProjectDir, fsImpl?: typeof fs }} [opts]
 */
export function labelSessions(rows, { decodeDir = decodeClaudeProjectDir, fsImpl = fs } = {}) {
  const cache = new Map();
  const label = (key) => {
    if (!cache.has(key)) {
      let decoded;
      try { decoded = decodeDir(key, { fsImpl }); } catch { decoded = null; }
      // `projectResolved: false` is the load-bearing half. A decode fails when
      // the project directory is gone — the encoding is only reversible by
      // walking real directories — and a consumer that cannot tell a decoded
      // name from an undecodable one would present a guess as a fact.
      // Two different reasons a decode fails, and they mean opposite things to a
      // reader. `gone`: the name is a POSIX-rooted encoding but no such
      // directory exists any more — the project really was deleted. `encoding`:
      // the name was never a POSIX-rooted encoding at all, which on Windows is
      // every name (a drive prefix, which decodeClaudeProjectDir refuses by
      // design). Collapsing the two would report every Windows session as a
      // deleted project.
      cache.set(key, decoded
        ? { projectLabel: path.basename(decoded), projectResolved: true }
        : {
          projectLabel: key,
          projectResolved: false,
          projectReason: String(key).startsWith('-') ? 'gone' : 'encoding',
        });
    }
    return cache.get(key);
  };
  return rows.map((row) => (
    row.project ? { ...row, ...label(row.project) } : row
  ));
}

/** Trailing-window growth per host, from mtime + size only — no content read
 *  ever happens here. It is an APPROXIMATION and says so: a file rewritten
 *  today contributes its WHOLE size to today, because a single mtime cannot
 *  tell how many of those bytes are new. That over-counts rewritten stores
 *  (sqlite ledgers) and is exact for append-only transcripts. */
export function buildGrowth(growthByHost, { asOf, growthDays }) {
  const days = [];
  for (let i = growthDays - 1; i >= 0; i--) days.push(localDay(asOf - i * 86_400_000));
  const hosts = [...growthByHost.entries()].map(([host, cells]) => {
    const series = days.map((day) => ({
      day,
      bytes: cells.get(day)?.bytes ?? 0,
      files: cells.get(day)?.files ?? 0,
    }));
    const total = series.reduce((acc, d) => acc + d.bytes, 0);
    return {
      host,
      days: series,
      totalBytes: measured(total, { asOf }),
      perDayAvgBytes: measured(Math.round(total / growthDays), { asOf }),
    };
  }).sort((a, b) => (b.totalBytes.value ?? 0) - (a.totalBytes.value ?? 0));
  return {
    windowDays: growthDays,
    approximate: true,
    basis: 'file mtime + size; a rewritten file counts its whole size on its mtime day',
    hosts,
  };
}

// ── re-exports: the reclaim half of this domain (see this file's header) ──────
export {
  RECLAIM_SAFETY_TIERS, RECLAIM_SAFETY_MEANING,
  collectReclaimables, summarizeReclaimables, npxReclaimables, adoptedConsumerFigures,
} from './storage-reclaim.mjs';
export {
  snapshotFamilies, supersededSnapshotReclaimables,
  regenerableCacheRoots, regenerableCacheReclaimables,
  browserRevisionRoots, browserRevisionReclaimables,
  runtimeVersionRoots, runtimeVersionReclaimables,
  orphanedTranscriptReclaimables, worktreeReclaimables,
} from './storage-reclaim-detectors.mjs';
