// Storage breakdown — the category → host → project → session tree, the derived
// views over the same walk (trailing-30d growth, top-N giants), and the advisory
// reclaimable rows (ADR-0025 §4, docs/ddd/machine-footprint.md "Storage
// breakdown").
//
// This module is ADVISORY ONLY by invariant 4: there is no delete, prune, or
// cleanup verb here, and none may be added. `ReclaimableCandidate` rows carry a
// path, a size, and a rationale — a `cleanupHint` names the CLI that already
// owns the removal, and that string is documentation, not a command this module
// runs. npx.mjs's pruneNpxStale is deliberately NOT imported; only its
// read-only scanNpxStale is.
//
// SAFETY IS A FIELD, NOT A TONE OF VOICE. Every candidate carries `safety`:
// 'regenerable' (the owning tool refetches it on demand — the npm content cache,
// the Homebrew download cache, the brain's superseded KB copies) or 'review'
// (plausible but NOT safe to state as removable — mise has eight node entries on
// this machine and some of them are the aliases a live toolchain resolves
// through; a browser revision may still be pinned by an installed package).
// A review row is a pointer at something to look at, never a figure to sweep,
// and `summarizeReclaimables` totals the two tiers SEPARATELY on purpose: a
// combined "you could free N" that mixes them would be the honest-measurement
// contract broken at the last mile.
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
// reads `<repo>/.git/worktrees/<name>/gitdir`, which holds a single filesystem
// PATH. That is the same class of datum as `.git/config`'s remote URL, which
// ADR-0025 §7 already sanctions, and it is the only way an orphaned worktree
// can be identified at all. Bounded to 4 KB, parsed as a path and nothing else,
// and skipped entirely when `detectWorktrees` is false.
import fs from 'node:fs';
import path from 'node:path';
import { home, claudeDir, codexDir, configDir, isWindows } from '../paths.mjs';
import { defaultOpencodeDbPath } from '../usage-opencode.mjs';
import { scanNpxStale } from '../npx.mjs';
import { npxEnvNodes } from './install.mjs';
import { decodeClaudeProjectDir } from './project-sources.mjs';
import {
  walkTree, rootMeasurements, measured, unknown, sumMeasurements, statNode, hasValue,
} from './walk.mjs';

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

/** The two safety tiers, in the order a panel should present them. Two and not
 *  three: a "definitely dead" tier would be a claim this module cannot
 *  substantiate from directory metadata alone. */
export const RECLAIM_SAFETY_TIERS = Object.freeze(['regenerable', 'review']);

/** What each tier promises, carried in the payload so no surface has to invent
 *  the wording — and so the difference between the two is impossible to render
 *  as the same thing. */
export const RECLAIM_SAFETY_MEANING = Object.freeze({
  regenerable: 'The owning tool refetches this on demand. Removing it costs download time, '
    + 'not data.',
  review: 'Plausible but not safe to call removable: some of these may be in use. Review them '
    + 'individually — this is not a total to sweep.',
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
 *   consumers?: object|null, env?: NodeJS.ProcessEnv,
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
  env = process.env,
  decodeDir = decodeClaudeProjectDir,
  fsImpl = fs,
} = {}) {
  const asOf = now();
  const opts = { ...STORAGE_DEFAULTS, ...reclaim };
  const rootList = roots ?? defaultStorageRoots({ projects });
  const growthCutoff = asOf - growthDays * 86_400_000;
  const agedCutoff = asOf - opts.transcriptAgeDays * 86_400_000;

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
            const key = `${root.id} ${project}`;
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

  // Every category always appears, so a missing slice is never mistaken for a
  // rendering gap. A category with no roots is a measured zero — EXCEPT
  // learning-stores with no project catalog supplied, whose emptiness is
  // ambiguous: "we were given nowhere to look" is not "there is nothing there".
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

  const tree = [...categories.values()]
    .map((node) => finalizeNode(node, { asOf, maxChildren }))
    .sort((a, b) => (b.bytes.value ?? 0) - (a.bytes.value ?? 0));

  files.sort((a, b) => b.bytes - a.bytes);
  sessionLeaves.sort((a, b) => b.bytes - a.bytes);

  const reclaimables = collectReclaimables({
    asOf, agedTranscripts, transcriptProjects, projects, opts, walk, limits,
    detectWorktrees, detectCaches, detectOrphanedTranscripts, consumers, env, decodeDir, fsImpl,
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

/**
 * Advisory rows only — see this module's header. Nothing here removes anything;
 * `cleanupHint` names the CLI that already owns the removal.
 *
 * @typedef {{ value: number|null, status: string, reason: string|null,
 *             asOf: number|null, partial: boolean }} Measurement
 * @typedef {{
 *   id: string, kind: string, label: string, path: string, samplePaths: string[],
 *   matchedCount: number|null, bytes: Measurement, files: Measurement,
 *   safety: 'regenerable'|'review', bytesMeaning: 'candidate'|'installed',
 *   keeps: Array<{ path: string, label: string, bytes: Measurement }>,
 *   rationale: string, cleanupHint: string|null, advisory: true,
 * }} ReclaimableCandidate
 */
export function collectReclaimables({
  asOf, agedTranscripts, transcriptProjects = new Map(), projects, opts, walk, limits,
  detectWorktrees, detectCaches = true, detectOrphanedTranscripts = true,
  consumers = null, env = process.env, decodeDir = decodeClaudeProjectDir, fsImpl,
}) {
  const rows = [];
  const days = (ms) => Math.floor((asOf - ms) / 86_400_000);
  const ctx = {
    asOf, opts, walk, limits, fsImpl, adopt: adoptedConsumerFigures(consumers),
  };

  for (const acc of agedTranscripts.values()) {
    rows.push(candidate({
      id: `aged-transcripts:${acc.host}`,
      kind: 'aged-transcripts',
      label: `${acc.host} transcripts older than ${opts.transcriptAgeDays}d`,
      path: acc.root,
      samplePaths: acc.samples,
      matchedCount: acc.files,
      bytes: measured(acc.bytes, { asOf }),
      files: measured(acc.files, { asOf }),
      // Not regenerable in any sense: a transcript is the only copy of the
      // session it records, and Historical usage is denominated in them.
      safety: 'review',
      rationale: `${acc.files} file(s) untouched for ${opts.transcriptAgeDays}d or more; `
        + `oldest ${days(acc.oldestMtimeMs)}d. Historical usage reads these — removing them `
        + 'removes that history too.',
      cleanupHint: null,
    }));
  }

  rows.push(...npxReclaimables({ asOf, opts, walk, limits, fsImpl }));
  if (detectOrphanedTranscripts) {
    rows.push(...orphanedTranscriptReclaimables({
      asOf, opts, transcriptProjects, decodeDir, fsImpl,
    }));
  }
  if (detectCaches) {
    rows.push(...supersededSnapshotReclaimables(ctx, snapshotFamilies({ env })));
    rows.push(...regenerableCacheReclaimables(ctx, regenerableCacheRoots({ env })));
    rows.push(...browserRevisionReclaimables(ctx, browserRevisionRoots({ env })));
    rows.push(...runtimeVersionReclaimables(ctx, runtimeVersionRoots({ env })));
  }
  if (detectWorktrees && Array.isArray(projects)) {
    rows.push(...worktreeReclaimables({ asOf, projects, opts, walk, limits, fsImpl }));
  }
  return rows.sort((a, b) => (b.bytes.value ?? 0) - (a.bytes.value ?? 0));
}

/** Do any two of these rows describe the same path, or one inside another? Two
 *  such rows cover some of the same bytes — an aged transcript can also sit in a
 *  project that no longer exists — and adding them would report space twice. */
function rowsOverlap(rows) {
  const keys = rows.map((row) => (row.path ? pathKey(row.path) : null)).filter(Boolean);
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      if (keys[i] === keys[j]) return true;
      const rel = path.relative(keys[i], keys[j]);
      const nested = rel && !rel.startsWith('..') && !path.isAbsolute(rel);
      const inverse = path.relative(keys[j], keys[i]);
      if (nested || (inverse && !inverse.startsWith('..') && !path.isAbsolute(inverse))) return true;
    }
  }
  return false;
}

/**
 * Per-tier totals, and deliberately NO combined figure. Summing a regenerable
 * cache with a runtime tree that may be live would produce the one number a
 * reader would act on and the one number this module cannot stand behind.
 *
 * A tier whose own rows overlap reports its total as unknown-with-reason rather
 * than as a sum that counts the same bytes twice — the rowCount still stands,
 * and each row still carries its own measured figure.
 */
export function summarizeReclaimables(rows, { asOf = null } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  return {
    tiers: RECLAIM_SAFETY_TIERS.map((safety) => {
      const tier = list.filter((row) => row.safety === safety);
      // Only 'candidate' bytes are summable: an 'installed' figure is context on
      // a review row, not space the row claims is available.
      const members = tier.filter((row) => row.bytesMeaning === 'candidate');
      const overlapping = rowsOverlap(members);
      return {
        safety,
        meaning: RECLAIM_SAFETY_MEANING[safety],
        rowCount: tier.length,
        bytes: overlapping
          ? unknown('rows in this tier describe overlapping paths, so a sum would count the '
            + 'same bytes twice')
          : sumMeasurements(members.map((row) => row.bytes), { asOf }),
        summedRows: overlapping ? 0 : members.length,
        contextOnlyRows: tier.length - members.length,
      };
    }),
    combined: null,
    combinedNote: 'The tiers are reported separately and never added: only the regenerable '
      + 'total is space a tool would rebuild by itself.',
  };
}

/** Fill in the fields every row carries, so no detector can ship a candidate
 *  without a safety tier or a statement of what its bytes mean. */
function candidate(row) {
  return {
    samplePaths: [],
    matchedCount: null,
    keeps: [],
    bytesMeaning: 'candidate',
    cleanupHint: null,
    ...row,
    advisory: true,
  };
}

/** Stale npx cache envs. Two independent rationales, both read-only: a cached
 *  copy strictly older than its installed global baseline (npx.mjs's version
 *  verdict — the bug that kept a machine running a retired ruflo), and an env
 *  untouched for longer than the idle threshold. */
export function npxReclaimables({ asOf, opts, walk, limits, fsImpl }) {
  const nodes = npxEnvNodes({ walk, limits, asOf, fsImpl });
  if (nodes.presence !== 'present') return [];
  let staleByVersion = new Map();
  try {
    staleByVersion = new Map(scanNpxStale().map((entry) => [entry.dir, entry.stale]));
  } catch { /* an unreadable cache simply yields no version verdict */ }
  const idleCutoff = asOf - opts.npxEnvIdleDays * 86_400_000;
  const rows = [];
  for (const env of nodes.envs) {
    const stale = staleByVersion.get(env.path);
    const idle = env.newestMtimeMs !== null && env.newestMtimeMs < idleCutoff;
    if (!stale && !idle) continue;
    const why = [];
    if (stale) {
      why.push(`cached ${stale.map((s) => `${s.pkg}@${s.cached}`).join(', ')} `
        + `older than installed ${stale.map((s) => s.installed).join(', ')}`);
    }
    if (idle) why.push(`untouched for ${Math.floor((asOf - env.newestMtimeMs) / 86_400_000)}d`);
    rows.push(candidate({
      id: `stale-npx-env:${env.id}`,
      kind: 'stale-npx-env',
      label: `npx cache env (${env.packages.join(', ') || 'unkeyed'})`,
      path: env.path,
      bytes: env.bytes,
      files: env.files,
      safety: 'regenerable',
      rationale: `${why.join('; ')}. npx re-fetches on demand, so the cache is reproducible.`,
      cleanupHint: 'ak sync prunes version-stale envs (npx.pruneNpxStale)',
    }));
  }
  return rows;
}

// ── shared detector plumbing ──────────────────────────────────────────────────

// Third-party cache conventions are spelled out here rather than in paths.mjs
// for the reason consumers.mjs states: that module owns the kit's own path
// contract, and fifty foreign tools' cache layouts would make it harder to
// audit. Platform variants are listed side by side instead of switched on
// process.platform, so the wrong-platform root simply reads absent and a machine
// carrying both (a tool that moved its cache) reports both.
const xdgCache = (env) => env.XDG_CACHE_HOME || path.join(home, '.cache');
const xdgData = (env) => env.XDG_DATA_HOME || path.join(home, '.local', 'share');
const macCache = () => path.join(home, 'Library', 'Caches');
const winLocalAppData = (env) => env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');

// APFS and NTFS are case-insensitive, so an adopted figure keyed by an
// exact-case path would silently miss on macOS and Windows.
const foldCase = process.platform !== 'linux';
const pathKey = (target) => {
  const abs = path.resolve(target);
  return foldCase ? abs.toLowerCase() : abs;
};

/**
 * A lookup from absolute path to a figure the ranked-consumers view already
 * measured, or a function that always misses when no such view was supplied.
 * Exact paths only: a consumers row for a glob FAMILY carries one total for the
 * whole family and cannot answer for an individual member.
 *
 * @param {{ rows?: any[] }|null} consumers a collectConsumers payload
 * @returns {(target: string) => ({ presence: string, bytes: Measurement,
 *   files: Measurement, newestMtimeMs: number|null })|null}
 */
export function adoptedConsumerFigures(consumers) {
  const index = new Map();
  for (const row of consumers?.rows ?? []) {
    if (!row?.path || row.residual || row.presence !== 'present' || !hasValue(row.bytes)) continue;
    index.set(pathKey(row.path), {
      presence: 'present',
      bytes: row.bytes,
      files: row.files ?? unknown('file count not carried by the adopted figure'),
      newestMtimeMs: row.newestMtimeMs ?? null,
    });
  }
  return (target) => (target ? index.get(pathKey(target)) ?? null : null);
}

/** One node's figures: the already-measured answer when the consumers view has
 *  one for this exact path, otherwise one bounded walk. */
function measureNode(target, ctx) {
  const adopted = ctx.adopt?.(target);
  if (adopted) return adopted;
  const result = ctx.walk(target, { ...ctx.limits, fsImpl: ctx.fsImpl });
  return {
    ...rootMeasurements(result, { asOf: ctx.asOf }),
    newestMtimeMs: result.newestMtimeMs ?? null,
  };
}

/** Immediate entries of a directory. ENOENT is an ABSENCE — that tool is not
 *  installed here, which is not a failed measurement — and every other errno is
 *  a degradation the caller must report rather than swallow. Symlinked entries
 *  are classified but never followed or measured. */
function listMembers(dir, fsImpl) {
  try {
    return { status: 'ok', reason: null, entries: fsImpl.readdirSync(dir, { withFileTypes: true }) };
  } catch (err) {
    const code = err?.code || 'io';
    return { status: code === 'ENOENT' ? 'absent' : 'degraded', reason: code, entries: [] };
  }
}

/** A root that exists but could not be listed. Reported rather than dropped:
 *  "there is nothing to reclaim here" and "we could not look" are different
 *  answers, and only one of them is a measurement (invariant 2). */
function unreadableCandidate({ id, kind, label, target, reason, safety, cleanupHint = null }) {
  return candidate({
    id: `${id}:unreadable`,
    kind,
    label: `${label} (unreadable)`,
    path: target,
    bytes: unknown(reason),
    files: unknown(reason),
    safety,
    rationale: `${target} could not be listed (${reason}), so whether anything here is `
      + 'reclaimable is unknown rather than none.',
    cleanupHint,
  });
}

/** Walk a family's members under a walk budget. A cap makes the sum a floor and
 *  says so through `partial`, which is what "≥ N" renders from; a budget already
 *  spent before this family was reached yields unknown, because zero members
 *  measured is not a measurement of zero bytes. */
function measureMembers(members, ctx, limit = ctx.opts.maxFamilyWalks) {
  const walked = members.slice(0, Math.max(0, limit))
    .map((member) => ({ ...member, ...measureNode(member.path, ctx) }));
  const capped = members.length > walked.length;
  if (members.length && !walked.length) {
    const reason = 'the walk budget for this root was spent before this node was reached';
    return { walked, capped, bytes: unknown(reason), files: unknown(reason) };
  }
  const bytes = sumMeasurements(walked.map((m) => m.bytes), { asOf: ctx.asOf });
  const files = sumMeasurements(walked.map((m) => m.files), { asOf: ctx.asOf });
  return {
    walked,
    capped,
    bytes: capped && hasValue(bytes) ? { ...bytes, partial: true } : bytes,
    files: capped && hasValue(files) ? { ...files, partial: true } : files,
  };
}

/** Is there anything to advise about? A measured zero is a real zero, and a real
 *  zero is not a candidate — an "0 B reclaimable" row is an unknown wearing a
 *  number. An unmeasured figure still earns its row, because not knowing is
 *  itself the finding. */
const worthListing = (bytes) => !hasValue(bytes) || bytes.value > 0;

// ── superseded snapshot copies ────────────────────────────────────────────────

/**
 * Families of dated copies an installer leaves beside the copy in use. The
 * RuvNet Brain is the one on this machine and the largest safe win on it: five
 * `kb.bak-<date>` directories totalling ~11 GB beside a 1.9 GB active `kb/`.
 *
 * @param {{ env?: NodeJS.ProcessEnv }} [options]
 */
export function snapshotFamilies({ env = process.env } = {}) {
  const brain = path.join(xdgCache(env), 'ruvnet-brain');
  return [{
    id: 'brain-kb-snapshots',
    label: 'RuvNet Brain superseded KB copies',
    dir: brain,
    // `kb.bak` cannot match `kb`, so the active KB can never be enumerated as
    // one of its own backups.
    prefix: 'kb.bak',
    active: path.join(brain, 'kb'),
    activeLabel: 'active KB (kb/)',
    what: 'The brain installer copies the knowledge base aside before each update and never '
      + 'removes the copy, so one accumulates per update.',
    reproducible: 'A knowledge base is rebuilt by re-running the installer '
      + '(npx ruvnet-brain --doctor).',
    cleanupHint: 'remove the dated kb.bak-* directories (npx ruvnet-brain --doctor rebuilds)',
  }];
}

/** The `YYYY-MM-DD` a dated copy names, when it names one. Used only for the
 *  rationale's range; a member whose name carries no date is still counted. */
const datePart = (name) => name.match(/(\d{4}-\d{2}-\d{2})/)?.[1] ?? null;

/**
 * Dated, superseded copies beside an active one — the single largest safe win
 * measured on this machine. The active copy is measured too and reported in
 * `keeps`, never inside the candidate figure: the row's whole credibility is
 * that it can say what it is NOT proposing to touch.
 */
export function supersededSnapshotReclaimables(ctx, families) {
  const rows = [];
  for (const family of families ?? []) {
    const listing = listMembers(family.dir, ctx.fsImpl);
    if (listing.status === 'absent') continue;
    if (listing.status === 'degraded') {
      rows.push(unreadableCandidate({
        id: family.id, kind: 'superseded-snapshots', label: family.label,
        target: family.dir, reason: listing.reason, safety: 'regenerable',
        cleanupHint: family.cleanupHint,
      }));
      continue;
    }
    const members = listing.entries
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink()
        && entry.name.startsWith(family.prefix))
      .map((entry) => ({ name: entry.name, path: path.join(family.dir, entry.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (!members.length) continue;

    const { walked, capped, bytes, files } = measureMembers(members, ctx);
    if (!worthListing(bytes)) continue;
    const dates = members.map((m) => datePart(m.name)).filter(Boolean);
    const span = dates.length >= 2 ? ` (${dates[0]} through ${dates[dates.length - 1]})`
      : (dates.length === 1 ? ` (${dates[0]})` : '');
    const active = measureNode(family.active, ctx);
    rows.push(candidate({
      id: family.id,
      kind: 'superseded-snapshots',
      label: `${members.length} superseded copies of ${path.basename(family.active)}`,
      path: family.dir,
      samplePaths: walked.slice(0, ctx.opts.samplePaths).map((m) => m.path),
      matchedCount: members.length,
      bytes,
      files,
      safety: 'regenerable',
      keeps: [{
        path: family.active,
        label: family.activeLabel,
        bytes: active.presence === 'absent'
          ? unknown('the active copy is not on disk')
          : active.bytes,
      }],
      rationale: `${members.length} dated copies${span}${capped ? ', of which only '
        + `${walked.length} were measured` : ''}. ${family.what} Nothing reads them: `
        + `the ${family.activeLabel} is measured separately, is excluded from this figure, and `
        + `is not a candidate. ${family.reproducible}`,
      cleanupHint: family.cleanupHint,
    }));
  }
  return rows;
}

// ── regenerable caches ────────────────────────────────────────────────────────

/**
 * Whole cache roots whose owner refetches them on demand. These are the biggest
 * genuinely-safe rows on a developer machine — the npm content-addressable cache
 * alone measures ~22 GB here — and they are invisible in the per-host storage
 * tree because they belong to no host.
 *
 * @param {{ env?: NodeJS.ProcessEnv }} [options]
 */
export function regenerableCacheRoots({ env = process.env } = {}) {
  const cache = xdgCache(env);
  const roots = [
    {
      id: 'npm-cacache',
      kind: 'regenerable-cache',
      label: 'npm content-addressable cache',
      path: path.join(home, '.npm', '_cacache'),
      what: 'Every package tarball and registry response npm has downloaded, keyed by content '
        + 'hash. It grows monotonically: npm adds to it and never prunes it.',
      cleanupHint: 'npm cache clean --force',
    },
    {
      id: 'homebrew-downloads',
      kind: 'regenerable-cache',
      label: 'Homebrew download cache',
      path: path.join(macCache(), 'Homebrew'),
      what: 'Bottles, source tarballs and the formula API responses brew downloaded, kept after '
        + 'the install they were for.',
      cleanupHint: 'brew cleanup',
    },
    {
      id: 'homebrew-downloads-xdg',
      kind: 'regenerable-cache',
      label: 'Homebrew download cache',
      path: path.join(cache, 'Homebrew'),
      what: 'Bottles, source tarballs and the formula API responses brew downloaded, kept after '
        + 'the install they were for.',
      cleanupHint: 'brew cleanup',
    },
  ];
  if (isWindows) {
    roots.push({
      id: 'npm-cacache-win',
      kind: 'regenerable-cache',
      label: 'npm content-addressable cache',
      path: path.join(winLocalAppData(env), 'npm-cache', '_cacache'),
      what: 'Every package tarball and registry response npm has downloaded, keyed by content '
        + 'hash. It grows monotonically: npm adds to it and never prunes it.',
      cleanupHint: 'npm cache clean --force',
    });
  }
  return roots;
}

/** One row per present cache root. An absent root produces nothing at all —
 *  a tool that is not installed is not a reclaimable zero. */
export function regenerableCacheReclaimables(ctx, roots) {
  const rows = [];
  for (const root of roots ?? []) {
    const node = measureNode(root.path, ctx);
    if (node.presence === 'absent') continue;
    if (!worthListing(node.bytes)) continue;
    rows.push(candidate({
      id: root.id,
      kind: root.kind,
      label: root.label,
      path: root.path,
      bytes: node.bytes,
      files: node.files,
      safety: 'regenerable',
      rationale: `${root.what} Nothing here is unique: the tool refetches what it needs on the `
        + 'next install, so the cost of clearing it is download time, not data.',
      cleanupHint: root.cleanupHint,
    }));
  }
  return rows;
}

// ── superseded browser downloads ──────────────────────────────────────────────

/**
 * Roots where a browser installer keeps one directory per revision and adds a
 * new one on every version bump, never removing the old. `depth` is where the
 * revision directories live: Playwright keeps them at the root
 * (`chromium-1223`), Puppeteer one level down (`chrome/mac_arm-149.0.7827.22`).
 *
 * @param {{ env?: NodeJS.ProcessEnv }} [options]
 */
export function browserRevisionRoots({ env = process.env } = {}) {
  const cache = xdgCache(env);
  const playwright = {
    kind: 'superseded-browser-revisions',
    label: 'Playwright browser builds',
    depth: 1,
    installer: 'npx playwright install',
  };
  return [
    { ...playwright, id: 'playwright-mac', path: path.join(macCache(), 'ms-playwright') },
    { ...playwright, id: 'playwright-xdg', path: path.join(cache, 'ms-playwright') },
    { ...playwright, id: 'playwright-win', path: path.join(winLocalAppData(env), 'ms-playwright') },
    {
      kind: 'superseded-browser-revisions',
      id: 'puppeteer',
      label: 'Puppeteer browser builds',
      path: path.join(cache, 'puppeteer'),
      depth: 2,
      installer: 'npx puppeteer browsers install',
    },
  ];
}

/** Split `chromium_headless_shell-1223` into its family and its revision. The
 *  revision must contain a digit, which is what keeps Playwright's
 *  `mcp-chrome-profile` — a browser PROFILE, not a revision — out of the
 *  families entirely. */
function splitRevision(name) {
  const cut = name.lastIndexOf('-');
  if (cut <= 0 || cut === name.length - 1) return null;
  const revision = name.slice(cut + 1);
  if (!/\d/.test(revision)) return null;
  return { family: name.slice(0, cut), revision };
}

/** Revision directories under a root, at the root itself (`depth` 1) or one
 *  level down (`depth` 2). Never recursive: a browser build's own contents are
 *  not revisions. */
function revisionMembers(root, ctx) {
  const listing = listMembers(root.path, ctx.fsImpl);
  if (listing.status !== 'ok') return { status: listing.status, reason: listing.reason, members: [] };
  const holders = root.depth === 2
    ? listing.entries.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => ({ dir: path.join(root.path, entry.name), scope: entry.name }))
    : [{ dir: root.path, scope: '' }];
  const members = [];
  for (const holder of holders) {
    const inner = root.depth === 2 ? listMembers(holder.dir, ctx.fsImpl) : listing;
    if (inner.status !== 'ok') continue;
    for (const entry of inner.entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const split = splitRevision(entry.name);
      if (!split) continue;
      const target = path.join(holder.dir, entry.name);
      members.push({
        name: entry.name,
        path: target,
        family: holder.scope ? `${holder.scope}/${split.family}` : split.family,
        revision: split.revision,
        mtimeMs: statNode(target, { fsImpl: ctx.fsImpl }).mtimeMs ?? 0,
      });
    }
  }
  return { status: 'ok', reason: null, members };
}

/**
 * Older revisions in each browser family — everything except the most recently
 * installed one. Ordering is by directory mtime rather than by parsing the
 * revision, because the revisions are not comparable across installers
 * (Playwright's `1223` is a counter, its `mcp-chrome-5b42311` is a hex build id,
 * Puppeteer's is a four-part Chrome version).
 *
 * REVIEW tier, not regenerable, even though the installer would refetch them: a
 * project's pinned playwright/puppeteer version resolves to a specific revision,
 * and this module cannot see which package pins what. The row's job is to say
 * "these accumulated, look at them", not "delete N GB".
 */
export function browserRevisionReclaimables(ctx, roots) {
  const rows = [];
  for (const root of roots ?? []) {
    const { status, reason, members } = revisionMembers(root, ctx);
    if (status === 'absent') continue;
    if (status === 'degraded') {
      rows.push(unreadableCandidate({
        id: root.id, kind: root.kind, label: root.label,
        target: root.path, reason, safety: 'review',
      }));
      continue;
    }
    const families = new Map();
    for (const member of members) {
      const list = families.get(member.family) ?? [];
      list.push(member);
      families.set(member.family, list);
    }
    const superseded = [];
    const keeps = [];
    for (const [family, list] of families) {
      if (list.length < 2) continue;
      const ordered = [...list].sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));
      keeps.push({ family, ...ordered[0] });
      superseded.push(...ordered.slice(1));
    }
    if (!superseded.length) continue;
    const { walked, capped, bytes, files } = measureMembers(superseded, ctx);
    if (!worthListing(bytes)) continue;
    rows.push(candidate({
      id: `${root.id}:superseded`,
      kind: root.kind,
      label: `${superseded.length} superseded ${root.label.toLowerCase()}`,
      path: root.path,
      samplePaths: walked.slice(0, ctx.opts.samplePaths).map((m) => m.path),
      matchedCount: superseded.length,
      bytes,
      files,
      safety: 'review',
      keeps: keeps.map((keep) => ({
        path: keep.path,
        label: `newest ${keep.family} revision (${keep.revision})`,
        bytes: unknown('the retained revision is not part of this figure'),
      })),
      rationale: `${keeps.length} browser famil(ies) here carry more than one revision; this `
        + `figure covers the ${superseded.length} older one(s)${capped
          ? `, of which ${walked.length} were measured` : ''}, and excludes the newest of each. `
        + 'Review rather than sweep: an installed package can pin an older revision, and this '
        + 'row cannot see which package pins what. '
        + `${root.installer} refetches whatever is missing.`,
      cleanupHint: `${root.installer} (confirm no project pins the older revision first)`,
    }));
  }
  return rows;
}

// ── installed runtime versions ────────────────────────────────────────────────

/**
 * Version-manager install roots — one directory per installed runtime version,
 * plus alias entries pointing into them.
 *
 * @param {{ env?: NodeJS.ProcessEnv }} [options]
 */
export function runtimeVersionRoots({ env = process.env } = {}) {
  return [{
    id: 'mise-installs',
    kind: 'installed-runtime-versions',
    label: 'mise',
    path: path.join(xdgData(env), 'mise', 'installs'),
    manager: 'mise',
    cleanupHint: 'mise ls, then mise uninstall <tool>@<version> (nothing may pin it)',
  }];
}

/**
 * Installed runtime versions, one row per managed tool that has more than one.
 *
 * REVIEW tier and `bytesMeaning: 'installed'`, both deliberately. On this
 * machine `mise/installs/node` holds eight entries — 22, 22.22, 22.22.3, 26,
 * 26.4, 26.4.0, latest, lts-jod — of which only two are real directories and six
 * are ALIAS SYMLINKS resolving into them. Removing a version silently breaks
 * every alias that points at it, and any `mise.toml` or `.tool-versions` on the
 * machine can pin any of them, so there is no subset this module can honestly
 * call reclaimable. What it can do is show what is installed and say that out
 * loud; recommending the deletion of a live runtime would be worse than saying
 * nothing.
 *
 * The alias links are counted, never followed — the walker's rule, and also the
 * only reason the byte figure is not multiplied by every alias.
 */
export function runtimeVersionReclaimables(ctx, roots) {
  const rows = [];
  for (const root of roots ?? []) {
    const listing = listMembers(root.path, ctx.fsImpl);
    if (listing.status === 'absent') continue;
    if (listing.status === 'degraded') {
      rows.push(unreadableCandidate({
        id: root.id, kind: root.kind, label: `${root.manager} installs`,
        target: root.path, reason: listing.reason, safety: 'review',
      }));
      continue;
    }
    // Every managed tool is examined — listing one is a readdir, and capping the
    // LIST would drop tools in alphabetical order, which is an invisible
    // truncation of exactly the kind this domain forbids. What is bounded is the
    // expensive part: the walks, under one budget shared across the root.
    let budget = ctx.opts.maxFamilyWalks;
    const tools = listing.entries
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink()
        && !entry.name.startsWith('.'));
    for (const tool of tools) {
      const dir = path.join(root.path, tool.name);
      const inner = listMembers(dir, ctx.fsImpl);
      if (inner.status !== 'ok') continue;
      const versions = [];
      let aliases = 0;
      for (const entry of inner.entries) {
        if (entry.name.startsWith('.')) continue;
        if (entry.isSymbolicLink()) { aliases += 1; continue; }
        if (entry.isDirectory()) versions.push({ name: entry.name, path: path.join(dir, entry.name) });
      }
      // One installed version is the toolchain working as intended, not sprawl.
      if (versions.length < 2) continue;
      const { walked, capped, bytes, files } = measureMembers(versions, ctx, budget);
      budget -= walked.length;
      if (!worthListing(bytes)) continue;
      rows.push(candidate({
        id: `${root.id}:${tool.name}`,
        kind: root.kind,
        label: `${versions.length} ${root.manager} ${tool.name} versions installed`,
        path: dir,
        samplePaths: walked.slice(0, ctx.opts.samplePaths).map((m) => m.path),
        matchedCount: versions.length,
        bytes,
        files,
        safety: 'review',
        bytesMeaning: 'installed',
        rationale: `${versions.length} installed version(s) of ${tool.name}`
          + `${aliases ? ` plus ${aliases} alias link(s) resolving into them` : ''}`
          + `${capped ? `, of which ${walked.length} were measured` : ''}. `
          + 'This is what is installed, not what is free: an alias points at a real version, '
          + `and any ${root.manager} config on this machine can pin any of them. Review with `
          + `\`${root.manager} ls ${tool.name}\` before removing anything.`,
        cleanupHint: root.cleanupHint,
      }));
    }
  }
  return rows;
}

// ── transcripts for projects that no longer exist ─────────────────────────────

/**
 * Claude transcript directories whose project directory is gone.
 *
 * A `~/.claude/projects/` directory name is a LOSSY encoding of the project path
 * (`/`, `.` and a literal `-` all become `-`), so it cannot be decoded by string
 * manipulation; `decodeClaudeProjectDir` walks the candidate segments against the
 * real filesystem and returns a path only when the filesystem confirms one.
 * A directory that decodes to nothing is therefore a project that is no longer
 * on this machine — and that is exactly the evidence available, so the row says
 * so rather than claiming certainty.
 *
 * TWO GUARDS against the failure mode that would matter, flagging live projects:
 *   · only `-`-leading (POSIX-encoded) names are considered, because Windows
 *     names encode a drive letter that this decoder does not handle and would
 *     otherwise report every project on the machine as dead;
 *   · if NOTHING decoded, the finding is about the decoder or an unreadable home
 *     directory, not about the projects, so no row is emitted at all.
 *
 * The value here is hygiene and privacy, not space: measured on this machine
 * these are ~0.05 GB across 8 dead projects. The rationale says that plainly —
 * selling 50 MB as a disk win would be the same dishonesty as a fabricated zero,
 * just in the other direction.
 */
export function orphanedTranscriptReclaimables({
  asOf, opts, transcriptProjects, decodeDir = decodeClaudeProjectDir, fsImpl,
}) {
  const byHost = new Map();
  for (const entry of transcriptProjects?.values?.() ?? []) {
    if (!entry.dir.startsWith('-')) continue;
    const acc = byHost.get(entry.host)
      ?? { host: entry.host, root: entry.rootPath, alive: 0, dead: [] };
    if (decodeDir(entry.dir, { fsImpl })) acc.alive += 1;
    else acc.dead.push(entry);
    byHost.set(entry.host, acc);
  }

  const rows = [];
  for (const acc of byHost.values()) {
    if (!acc.dead.length || !acc.alive) continue;
    const bytes = acc.dead.reduce((total, entry) => total + entry.bytes, 0);
    const files = acc.dead.reduce((total, entry) => total + entry.files, 0);
    const newest = acc.dead.reduce((at, entry) => Math.max(at, entry.newestMtimeMs ?? 0), 0);
    rows.push(candidate({
      id: `orphaned-transcripts:${acc.host}`,
      kind: 'orphaned-transcripts',
      label: `${acc.host} transcripts for ${acc.dead.length} project(s) that no longer exist`,
      path: acc.root,
      samplePaths: acc.dead.slice(0, opts.samplePaths).map((entry) => entry.path),
      matchedCount: acc.dead.length,
      bytes: measured(bytes, { asOf }),
      files: measured(files, { asOf }),
      safety: 'review',
      rationale: `${files} transcript(s) belong to ${acc.dead.length} project director(ies) that `
        + `no longer resolve on this machine (${acc.alive} others still do; last activity `
        + `${newest ? `${Math.floor((asOf - newest) / 86_400_000)}d ago` : 'unknown'}). This row `
        + 'is here for hygiene and privacy, not as a space win: it is listed because those '
        + 'projects are gone, whatever the byte figure turns out to be. The transcripts are also '
        + 'the only copy of that history, and an unreadable parent directory looks identical to '
        + 'a deleted project — confirm the project is really gone before acting.',
      cleanupHint: null,
    }));
  }
  return rows;
}

/** Orphaned git worktrees, from each project's `.git/worktrees/<name>` admin
 *  records. Two honest verdicts, no git invocation:
 *    · the checkout the record points at no longer exists → the record is dead;
 *    · the checkout exists but nothing in it has been touched for the idle
 *      window → a candidate, with its real on-disk size.
 *  A record whose pointer cannot be read is reported as unverifiable rather
 *  than assumed dead. See this module's header for why the pointer read is in
 *  scope. */
export function worktreeReclaimables({ asOf, projects, opts, walk, limits, fsImpl }) {
  const rows = [];
  let walks = 0;
  for (const project of projects) {
    const adminRoot = path.join(project, '.git', 'worktrees');
    let entries;
    try {
      entries = fsImpl.readdirSync(adminRoot, { withFileTypes: true });
    } catch { continue; } // no worktrees here (or unreadable): nothing to claim
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const record = path.join(adminRoot, entry.name);
      const pointer = readGitdirPointer(path.join(record, 'gitdir'), fsImpl);
      if (!pointer) {
        rows.push(candidate({
          id: `orphaned-worktree:${record}`,
          kind: 'orphaned-worktree',
          label: `worktree record "${entry.name}" (unverifiable)`,
          path: record,
          bytes: unknown('worktree pointer unreadable'),
          files: unknown('worktree pointer unreadable'),
          safety: 'review',
          rationale: 'The admin record exists but its gitdir pointer could not be read, '
            + 'so whether the checkout still exists is unknown.',
          cleanupHint: 'git worktree prune (verify first)',
        }));
        continue;
      }
      // gitdir points at `<checkout>/.git`; the checkout is its parent.
      const checkout = path.dirname(pointer);
      const head = statNode(checkout, { fsImpl });
      if (head.status === 'unknown') {
        rows.push(candidate({
          id: `orphaned-worktree:${record}`,
          kind: 'orphaned-worktree',
          label: `orphaned worktree record "${entry.name}"`,
          path: record,
          samplePaths: [checkout],
          bytes: measured(0, { asOf }),
          files: measured(0, { asOf }),
          safety: 'review',
          rationale: `The checkout at ${checkout} no longer exists; only the administrative `
            + 'record remains.',
          cleanupHint: 'git worktree prune',
        }));
        continue;
      }
      if (walks >= opts.maxWorktreeWalks) continue;
      walks += 1;
      const result = walk(checkout, { ...limits, fsImpl });
      const { bytes, files } = rootMeasurements(result, { asOf });
      const idleMs = result.newestMtimeMs === null ? null : asOf - result.newestMtimeMs;
      if (idleMs === null || idleMs < opts.worktreeIdleDays * 86_400_000) continue;
      rows.push(candidate({
        id: `idle-worktree:${record}`,
        kind: 'orphaned-worktree',
        label: `idle worktree "${entry.name}"`,
        path: checkout,
        samplePaths: [record],
        bytes,
        files,
        safety: 'review',
        rationale: `Nothing in the checkout has changed for ${Math.floor(idleMs / 86_400_000)}d. `
          + 'Merge state is not checked here — confirm the branch is landed before removing.',
        cleanupHint: 'git worktree remove (verify the branch is merged first)',
      }));
    }
  }
  return rows;
}

/** The single narrow non-metadata read in this module: a `gitdir` file holds
 *  one absolute path and nothing else. Bounded to 4 KB and validated as a path
 *  so a corrupt file yields null rather than a bogus candidate. */
function readGitdirPointer(file, fsImpl) {
  let fd;
  try {
    fd = fsImpl.openSync(file, 'r');
    const buf = Buffer.alloc(4096);
    const read = fsImpl.readSync(fd, buf, 0, 4096, 0);
    const value = buf.toString('utf8', 0, read).trim();
    return value && path.isAbsolute(value) ? value : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { fsImpl.closeSync(fd); } catch { /* already gone */ }
    }
  }
}
