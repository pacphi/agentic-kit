// Largest consumers — the ranked "where are the bytes actually going" answer the
// System Summary strip renders (ADR-0025 §4, docs/ddd/machine-footprint.md
// "Storage breakdown"). It is a VIEW over roots this domain already has
// trust-boundary access to, not a new source: every figure is one bounded walk
// or one figure adopted from a section that already walked it.
//
// WHY THIS MODULE EXISTS RATHER THAN A SORT IN THE CLIENT. The previous ranking
// was assembled in the browser from whatever the install and storage sections
// happened to carry, which made it wrong in the one way a size ranking must
// never be wrong: it named the npx cache the machine's biggest consumer while
// ~/.npm/_cacache — three times larger — was not scanned at all, and it had no
// way to know that ~/.cache/ruvnet-brain/kb (1.9 GB) is a sixth of the cache
// root it lives in (13 GB). A ranking whose breadth is an accident of what other
// sections needed is a ranking that reads as an answer and is not one.
//
// THREE ACCOUNTING RULES, because a size ranking is trivially made dishonest:
//
//  1. CONTAINMENT. Roots nest — ~/.claude/projects is inside ~/.claude, npm's
//     global root is inside mise's node install which is inside mise's installs
//     tree. Bytes are counted ONCE, at the outermost row (`kind: 'root'`), and
//     every enclosed row is a `kind: 'breakdown'` that explains its parent
//     instead of competing with it. Containment is DERIVED from the resolved
//     paths, not hand-declared, so a registry edit cannot silently start
//     double-counting. Only roots are ranked and only roots are summed.
//  2. RESIDUALS. A parent with breakdowns also gets a synthesized
//     `<parent>:other` row — parent minus its direct children — so the
//     breakdown always adds up and "what is the rest of this?" has an answer on
//     the row rather than in a user's head. This is what makes the brain row
//     legible: 13 GB, of which 1.9 GB is the active KB and 11 GB is stale
//     kb.bak-* copies. Merging the two figures, or reporting only the KB, are
//     both ways of being wrong about the same 11 GB.
//  3. PROJECT TREES ARE OPT-IN. One repository on a working machine can be
//     larger than every shared cache combined (175 GB here), and a bar chart
//     containing it is a bar chart of one repository. `includeProjectTrees`
//     defaults to false and the exclusion is STATED in the payload, never
//     silent — an omitted category the user cannot see is its own dishonesty.
//
// Absent roots are not consumers. A cache root that does not exist on this
// machine is reported in `absent` with its path — "we looked, it is not here" —
// and kept out of the ranking and the group totals rather than ranked as a
// zero-byte consumer. Unreadable roots are reported in `unmeasured` with their
// errno and make the affected group total `partial`; they are never a zero
// (invariant 2).
//
// Metadata only (invariant 1): dirents and lstat sizes, through walk.mjs, which
// has no read path for file contents at all.
//
// KNOWN COST: this is deep-tier work. The registry names ~50 roots and several
// are enormous (a 22 GB content-addressable npm cache is ~10^5 files), so a full
// pass is tens of seconds of I/O. That is why it belongs behind the explicit
// deep scan and why `roots`/`limits` are injectable — a caller that needs a
// cheaper pass narrows the registry rather than lowering the caps, since a
// lowered cap yields a partial figure and a narrowed registry yields an honest
// smaller question.
import fs from 'node:fs';
import path from 'node:path';
import {
  claudeDir, codexDir, configDir, globalRoot, home, isWindows, npxCacheDir,
} from '../paths.mjs';
import {
  hasValue, measured, rootMeasurements, sumMeasurements, unknown, walkTree,
} from './walk.mjs';

/**
 * A Measurement as walk.mjs defines it: a value plus how it was obtained.
 * @typedef {{ value: number|null, status: string, reason: string|null,
 *             asOf: number|null, partial: boolean }} Measurement
 */

/**
 * One registry entry. `path` and `match` are alternatives — a plain root, or a
 * family of siblings sharing a name prefix. Containment fills in `kind` and
 * `containedBy`; merging fills in `source` and `measuredBy`.
 *
 * @typedef {{
 *   id: string, label: string, group: string, note: string,
 *   path?: string|null, match?: { dir: string, prefix: string },
 *   allocation?: string,
 *   adopted?: { presence?: string, bytes: Measurement, files?: Measurement,
 *               newestMtimeMs?: number|null, complete?: boolean },
 *   kind?: string, containedBy?: string|null, source?: string, measuredBy?: string,
 * }} ConsumerDescriptor
 */

/**
 * A project the ranking may include: a ProjectFootprint from the projects
 * section (whose figures are adopted) or a bare path (which is walked).
 * @typedef {string|{ path: string, label?: string, presence?: string,
 *                    totalBytes?: Measurement, treeFiles?: Measurement,
 *                    lastActivity?: Measurement, complete?: boolean }} ProjectTreeInput
 */

/** The ecosystem a consumer belongs to. Ecosystem rather than "kind of thing"
 *  because the actionable question is which toolchain is costing the disk: four
 *  node package caches at 5 GB each is a node answer, not four unrelated rows.
 *  `note` is the group's own liner note, rendered when the grouped view is on. */
export const CONSUMER_GROUPS = Object.freeze([
  Object.freeze({
    id: 'ai-toolchain',
    label: 'AI toolchain',
    note: 'Local model weights, agent CLIs, their transcripts, caches and knowledge bases.',
  }),
  Object.freeze({
    id: 'node',
    label: 'Node / npm',
    note: 'Package caches, content stores and global installs for npm, pnpm, yarn and bun.',
  }),
  Object.freeze({
    id: 'rust', label: 'Rust', note: 'rustup toolchains and the Cargo registry/git caches.',
  }),
  Object.freeze({
    id: 'go', label: 'Go', note: 'The module cache and tooling caches under GOPATH.',
  }),
  Object.freeze({
    id: 'python', label: 'Python', note: 'pip and uv download caches and tool installs.',
  }),
  Object.freeze({
    id: 'java', label: 'JVM', note: 'The Maven local repository and Gradle caches/wrapper dists.',
  }),
  Object.freeze({
    id: 'browsers',
    label: 'Browser binaries',
    note: 'Playwright and Puppeteer browser downloads, re-fetched by their installers.',
  }),
  Object.freeze({
    id: 'system',
    label: 'System & containers',
    note: 'Version-manager installs, Homebrew, and container VM data.',
  }),
  Object.freeze({
    id: 'project-trees',
    label: 'Project trees',
    note: 'Working trees, .git and node_modules of the projects this machine has touched.',
  }),
]);

export const CONSUMER_GROUP_IDS = Object.freeze(CONSUMER_GROUPS.map((g) => g.id));

/** Twenty, because the point of the strip is breadth: at six rows the ranking
 *  could not show that four separate node caches outweigh the one everybody
 *  looks at. The panel scrolls; the payload does not need to guess how many
 *  fit. */
export const CONSUMER_TOP_N = 20;

/** How many `match`-enumerated siblings a glob row keeps as evidence paths. The
 *  SUM is over every match; only the sample is capped. */
const MAX_MATCH_SAMPLES = 8;

/** This view's own walk budget, raised from WALK_LIMITS because the defaults
 *  were sized for install trees and transcript roots and these roots are neither.
 *  Measured here: rustup exhausts the 400k entry cap at 9.4 of its 13.1 GB, and
 *  pnpm's content store, LM Studio and ~/.claude all bottom out on depth 16. A
 *  ranking whose deepest trees are systematically floors does not merely
 *  under-report them, it mis-ORDERS the answer — which is the exact failure this
 *  module exists to remove. Raised, not removed: the caps still bound the walk,
 *  and a root that exhausts even these still reports "≥" rather than a total.
 *  Costs roughly 30 s of the deep pass on this corpus; the walker's own defaults
 *  are unchanged for every other collector. */
export const CONSUMER_WALK_LIMITS = Object.freeze({
  maxDepth: 24,
  maxEntries: 2_000_000,
});

// Third-party cache roots are computed here rather than in paths.mjs on purpose:
// that module owns the kit's and its hosts' locations, and adding fifty foreign
// tools' cache conventions to it would make the kit's own path contract harder
// to audit for the sake of a read-only ranking. Kit and host paths still come
// from paths.mjs — nothing home-relative that the kit itself owns is spelled out
// below.
const xdgCache = (env) => env.XDG_CACHE_HOME || path.join(home, '.cache');
const xdgData = (env) => env.XDG_DATA_HOME || path.join(home, '.local', 'share');
const macCache = () => path.join(home, 'Library', 'Caches');
const winLocalAppData = (env) => env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');

const at = (id, label, group, target, note) => ({ id, label, group, path: target, note });
/** A row whose subject is a FAMILY of sibling entries — generation-numbered
 *  ledgers (`state_5.sqlite` and its -wal/-shm), dated backup copies
 *  (`kb.bak-2026-08-01`). One row per generation would be noise, and hardcoding
 *  today's generation would silently stop matching on the next bump. */
const family = (id, label, group, dir, prefix, note) => (
  { id, label, group, match: { dir, prefix }, note }
);

/**
 * The curated consumer registry: pure data, no I/O, in the shape discipline of
 * `src/lib/dashboard/about-directory.mjs` — authored and versioned with the
 * release, joined to measurements at scan time.
 *
 * Platform variants are listed side by side (Playwright installs to
 * ~/Library/Caches on macOS, ~/.cache on Linux, LOCALAPPDATA on Windows) rather
 * than switched on `process.platform`: the wrong-platform row simply reads
 * absent, and a machine that has both — a real outcome when a tool migrates its
 * cache location — reports both instead of hiding one.
 *
 * @param {{ env?: NodeJS.ProcessEnv }} [options]
 * @returns {Array<ConsumerDescriptor>} descriptors; `path` or `match`, never both
 */
export function consumerRoots({ env = process.env } = {}) {
  const cache = xdgCache(env);
  const data = xdgData(env);
  const mac = macCache();
  const winCache = winLocalAppData(env);
  const brain = path.join(cache, 'ruvnet-brain');
  const claude = claudeDir();
  const codex = codexDir();
  const mise = path.join(data, 'mise', 'installs');
  const goPath = env.GOPATH || path.join(home, 'go');
  const goModCache = env.GOMODCACHE || path.join(goPath, 'pkg', 'mod');
  const brewPrefixes = [env.HOMEBREW_PREFIX, '/opt/homebrew', '/usr/local',
    '/home/linuxbrew/.linuxbrew'].filter(Boolean);
  const seenBrew = new Set();

  const rows = [
    // ── ai-toolchain ────────────────────────────────────────────────────────
    at('ollama', 'Ollama local models', 'ai-toolchain', path.join(home, '.ollama'),
      'Ollama\'s model blobs and manifests. Re-pullable: each model re-downloads on demand.'),
    at('lmstudio', 'LM Studio models', 'ai-toolchain', path.join(home, '.lmstudio'),
      'LM Studio\'s downloaded weights and its own runtime. Re-downloadable per model.'),
    at('huggingface', 'Hugging Face hub cache', 'ai-toolchain', path.join(cache, 'huggingface'),
      'Model and dataset snapshots pulled by any huggingface_hub client; re-downloadable.'),
    at('ruvnet-brain', 'RuvNet Brain cache root', 'ai-toolchain', brain,
      'The WHOLE brain cache root, not just the active KB: the breakdown below says '
      + 'how much of it is the KB in use and how much is superseded copies.'),
    at('ruvnet-brain-kb', 'RuvNet Brain active KB', 'ai-toolchain', path.join(brain, 'kb'),
      'The knowledge base the search tool actually reads.'),
    family('ruvnet-brain-kb-backups', 'RuvNet Brain superseded KB copies', 'ai-toolchain',
      brain, 'kb.bak',
      'Copies the installer left behind on previous updates. Nothing reads them; the '
      + 'active KB is the row above.'),
    at('ruvnet-brain-models', 'RuvNet Brain embedding models', 'ai-toolchain',
      path.join(brain, 'models'),
      'Embedding model files the brain loads to answer queries offline.'),
    at('claude-home', 'Claude Code home', 'ai-toolchain', claude,
      'Everything under ~/.claude: transcripts, plugins, skills, snapshots and caches.'),
    at('claude-transcripts', 'Claude session transcripts', 'ai-toolchain',
      path.join(claude, 'projects'),
      'One .jsonl per session, per project. Historical usage reads these — deleting '
      + 'them deletes that history.'),
    at('claude-plugins', 'Claude Code plugins', 'ai-toolchain', path.join(claude, 'plugins'),
      'Installed plugin repositories and their marketplace checkouts.'),
    at('claude-skills', 'Claude user-scope skills', 'ai-toolchain', path.join(claude, 'skills'),
      'Skills installed at user scope, available in every project.'),
    at('claude-security', 'Claude security scanner', 'ai-toolchain',
      path.join(claude, 'security'),
      'The security scanner hook\'s virtualenv and its logs.'),
    at('claude-file-history', 'Claude file-history snapshots', 'ai-toolchain',
      path.join(claude, 'file-history'),
      'Pre-edit copies of files Claude Code changed, kept for undo.'),
    at('claude-shell-snapshots', 'Claude shell snapshots', 'ai-toolchain',
      path.join(claude, 'shell-snapshots'),
      'Captured shell environments, one per session start.'),
    at('claude-telemetry', 'Claude telemetry', 'ai-toolchain', path.join(claude, 'telemetry'),
      'Local telemetry spool written by the CLI.'),
    at('claude-image-cache', 'Claude image cache', 'ai-toolchain',
      path.join(claude, 'image-cache'), 'Images pasted into sessions.'),
    at('claude-todos', 'Claude todos', 'ai-toolchain', path.join(claude, 'todos'),
      'Per-session todo lists written by the CLI.'),
    at('claude-statsig', 'Claude statsig', 'ai-toolchain', path.join(claude, 'statsig'),
      'Feature-flag evaluation cache written by the CLI.'),
    at('claude-backups', 'Claude config backups', 'ai-toolchain', path.join(claude, 'backups'),
      'Backups of CLAUDE.md and settings taken before managed edits.'),
    at('claude-history', 'Claude history.jsonl', 'ai-toolchain',
      path.join(claude, 'history.jsonl'), 'The prompt-history ledger; one line per prompt.'),
    at('claude-native-install', 'Claude Code native install', 'ai-toolchain',
      path.join(data, 'claude'),
      'The native installer\'s versions directory — every version it has downloaded, '
      + 'not just the current one.'),
    at('claude-cli-nodejs-cache', 'Claude Code per-project node cache', 'ai-toolchain',
      path.join(mac, 'claude-cli-nodejs'),
      'Per-project scratch the CLI keeps outside ~/.claude (macOS cache location).'),
    at('codex-home', 'Codex home', 'ai-toolchain', codex,
      'Everything under ~/.codex: rollouts, ledgers, plugin cache and snapshots.'),
    at('codex-sessions', 'Codex session rollouts', 'ai-toolchain', path.join(codex, 'sessions'),
      'One rollout file per session, in dated directories. Historical usage reads these.'),
    family('codex-logs-ledger', 'Codex logs ledgers', 'ai-toolchain', codex, 'logs_',
      'The logs_N.sqlite family and its -wal/-shm siblings; N bumps on schema changes '
      + 'and the old generation is left behind.'),
    family('codex-state-ledger', 'Codex state ledgers', 'ai-toolchain', codex, 'state_',
      'The state_N.sqlite thread ledgers and their -wal/-shm siblings.'),
    at('codex-shell-snapshots', 'Codex shell snapshots', 'ai-toolchain',
      path.join(codex, 'shell_snapshots'), 'Captured shell environments, one per session.'),
    at('codex-plugins', 'Codex plugin cache', 'ai-toolchain',
      path.join(codex, 'plugins', 'cache'), 'Downloaded plugin payloads.'),
    at('codex-cache', 'Codex cache', 'ai-toolchain', path.join(codex, 'cache'),
      'Codex\'s own scratch cache.'),
    at('opencode-cache', 'OpenCode cache', 'ai-toolchain', path.join(cache, 'opencode'),
      'OpenCode\'s download and build cache.'),
    at('opencode-data', 'OpenCode data root', 'ai-toolchain', path.join(data, 'opencode'),
      'OpenCode\'s session store, logs and sqlite database.'),
    at('ak-config', 'agentic-kit config & indexes', 'ai-toolchain', configDir(),
      'kit.json plus the usage index, workspace store and this footprint snapshot. '
      + 'Rebuildable: every file here is derived from state the kit re-reads.'),

    // ── node ────────────────────────────────────────────────────────────────
    at('npm-cacache', 'npm content cache (_cacache)', 'node', path.join(home, '.npm', '_cacache'),
      'npm\'s content-addressable download cache. Safe to clear: npm refetches what it '
      + 'needs on the next install.'),
    at('npx-cache', 'npx cache envs', 'node', npxCacheDir(),
      'One throwaway install tree per `npx <pkg>` invocation. Reproducible; stale envs '
      + 'are listed as reclaimables in the Storage view.'),
    at('npm-global-root', 'npm global node_modules', 'node', safeGlobalRoot(),
      'Every globally installed npm package, including the managed tools — `npm root -g`.'),
    at('pnpm-store-xdg', 'pnpm content store (XDG)', 'node', path.join(data, 'pnpm', 'store'),
      'pnpm\'s content-addressable store; project node_modules hard-link into it.'),
    at('pnpm-store-library', 'pnpm content store (older layout)', 'node',
      path.join(home, 'Library', 'pnpm', 'store'),
      'The pre-XDG pnpm store location. Present here means an older pnpm wrote it; it is '
      + 'not linked by projects the current pnpm installs.'),
    at('pnpm-store-legacy', 'pnpm store (legacy ~/.pnpm-store)', 'node',
      path.join(home, '.pnpm-store'), 'The oldest pnpm store location.'),
    at('pnpm-cache', 'pnpm metadata cache', 'node', path.join(cache, 'pnpm'),
      'Registry metadata and side caches pnpm keeps outside the content store.'),
    at('mise-node', 'mise node runtimes', 'node', path.join(mise, 'node'),
      'Every Node version mise has installed, each with its own global lib tree.'),
    at('node-gyp-cache', 'node-gyp headers cache', 'node', path.join(mac, 'node-gyp'),
      'Node headers and libs per version, downloaded to build native addons.'),
    at('node-gyp-cache-xdg', 'node-gyp headers cache', 'node', path.join(cache, 'node-gyp'),
      'Node headers and libs per version, downloaded to build native addons.'),
    at('yarn-cache', 'Yarn cache', 'node', path.join(mac, 'Yarn'),
      'Yarn\'s package cache; re-fetched on demand.'),
    at('yarn-cache-xdg', 'Yarn cache', 'node', path.join(cache, 'yarn'),
      'Yarn\'s package cache; re-fetched on demand.'),
    at('bun', 'Bun home', 'node', path.join(home, '.bun'),
      'The bun runtime, its global installs and its package cache.'),

    // ── rust ────────────────────────────────────────────────────────────────
    at('rustup', 'rustup toolchains', 'rust', path.join(home, '.rustup'),
      'Every installed Rust toolchain and its docs/std components.'),
    at('cargo', 'Cargo home', 'rust', path.join(home, '.cargo'),
      'Cargo\'s registry cache, git checkouts and installed binaries.'),
    at('cargo-registry', 'Cargo registry cache', 'rust', path.join(home, '.cargo', 'registry'),
      'Downloaded crate sources and their .crate archives; re-fetchable.'),

    // ── go ──────────────────────────────────────────────────────────────────
    at('go-modcache', 'Go module cache', 'go', goModCache,
      'Extracted module sources; `go clean -modcache` re-downloads them.'),
    at('goimports-cache', 'goimports cache', 'go', path.join(mac, 'goimports'),
      'Index goimports keeps to resolve packages quickly.'),

    // ── python ──────────────────────────────────────────────────────────────
    at('uv-cache', 'uv cache', 'python', path.join(cache, 'uv'),
      'uv\'s wheel and source distribution cache; re-fetchable.'),
    at('uv-data', 'uv tool installs', 'python', path.join(data, 'uv'),
      'Environments uv created for `uv tool install`.'),
    at('pip-cache', 'pip cache', 'python', path.join(mac, 'pip'),
      'pip\'s HTTP and wheel cache; re-fetchable.'),
    at('pip-cache-xdg', 'pip cache', 'python', path.join(cache, 'pip'),
      'pip\'s HTTP and wheel cache; re-fetchable.'),

    // ── java ────────────────────────────────────────────────────────────────
    at('maven-repo', 'Maven local repository', 'java', path.join(home, '.m2', 'repository'),
      'Every artifact Maven or Gradle resolved into ~/.m2; re-resolvable from remotes.'),
    at('gradle-home', 'Gradle home', 'java', path.join(home, '.gradle'),
      'Gradle\'s build caches, resolved dependencies and downloaded wrapper distributions.'),

    // ── browsers ────────────────────────────────────────────────────────────
    at('playwright-mac', 'Playwright browsers', 'browsers', path.join(mac, 'ms-playwright'),
      'Browser builds downloaded by `playwright install` (macOS location).'),
    at('playwright-xdg', 'Playwright browsers', 'browsers', path.join(cache, 'ms-playwright'),
      'Browser builds downloaded by `playwright install` (Linux/XDG location).'),
    at('playwright-win', 'Playwright browsers', 'browsers', path.join(winCache, 'ms-playwright'),
      'Browser builds downloaded by `playwright install` (Windows location).'),
    at('puppeteer', 'Puppeteer browsers', 'browsers', path.join(cache, 'puppeteer'),
      'Chrome builds downloaded by Puppeteer\'s installer.'),

    // ── system ──────────────────────────────────────────────────────────────
    at('mise-installs', 'mise toolchain installs', 'system', mise,
      'Every runtime mise manages — node, python, go, java — all versions kept.'),
    {
      ...at('docker-data', 'Docker Desktop VM data', 'system',
        path.join(home, 'Library', 'Containers', 'com.docker.docker', 'Data'),
        'The Linux VM disk image backing Docker Desktop: images, volumes and layers live '
        + 'inside it, so it does not shrink when you delete images. Counted as blocks '
        + 'actually written — the image is sparse, and its apparent size is far larger.'),
      allocation: 'blocks',
    },
    at('docker-config', 'Docker CLI config', 'system', path.join(home, '.docker'),
      'CLI config, contexts and credential helpers.'),
    at('homebrew-cache', 'Homebrew download cache', 'system', path.join(mac, 'Homebrew'),
      'Downloaded bottles and source tarballs; `brew cleanup` removes them.'),
    at('homebrew-cache-xdg', 'Homebrew download cache', 'system', path.join(cache, 'Homebrew'),
      'Downloaded bottles and source tarballs; `brew cleanup` removes them.'),
  ];

  for (const prefix of brewPrefixes) {
    const cellar = path.join(prefix, 'Cellar');
    if (seenBrew.has(cellar)) continue;
    seenBrew.add(cellar);
    rows.push(at(`homebrew-cellar:${prefix}`, 'Homebrew Cellar', 'system', cellar,
      `Installed formulae under ${prefix}, all versions kept until \`brew cleanup\`.`));
  }
  if (isWindows) {
    rows.push(at('npm-cache-win', 'npm cache (Windows)', 'node',
      path.join(winCache, 'npm-cache', '_cacache'),
      'npm\'s content-addressable download cache. Safe to clear; npm refetches.'));
  }
  return rows;
}

/** `npm root -g` throws when npm is absent (paths.mjs). A machine without npm
 *  is a legitimate machine, and the row simply reads absent rather than taking
 *  the registry down with it. */
function safeGlobalRoot() {
  try { return globalRoot(); } catch { return null; }
}

// Path comparison is case-insensitive off Linux because APFS and NTFS are: on
// macOS ~/Library/Caches and ~/library/caches are the same directory, and a
// case-sensitive containment test would rank a child as its own root and
// double-count it.
const foldCase = process.platform !== 'linux';
const normalizePath = (p) => {
  const abs = path.resolve(p);
  return foldCase ? abs.toLowerCase() : abs;
};

/** Is `child` strictly inside `parent`? */
export function isInside(parent, child) {
  if (!parent || !child) return false;
  const a = normalizePath(parent);
  const b = normalizePath(child);
  if (a === b) return false;
  const rel = path.relative(a, b);
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** The path a descriptor is accounted at. A `match` family anchors at
 *  `<dir>/<prefix>` — a pseudo-path, deliberately: the family's members live
 *  INSIDE `dir`, so anchoring at `dir` itself would make the family a sibling of
 *  its own container and let both be ranked, double-counting every byte. The
 *  pseudo-path cannot capture the real siblings it is derived from either
 *  (`kb.bak` is not an ancestor of `kb.bak-2026-08-01`), so it nests one way
 *  only, which is exactly what containment needs. */
const anchorOf = (desc) => (
  desc.path ?? (desc.match ? path.join(desc.match.dir, desc.match.prefix) : null)
);

/**
 * Derive containment across descriptors. Each row is tagged `kind: 'root'` (its
 * bytes are counted once, here) or `kind: 'breakdown'` with `containedBy` naming
 * the nearest enclosing row. Nearest, not first: mise installs ⊃ mise node ⊃ npm
 * global root must chain, so the residual of each parent is over its DIRECT
 * children only.
 *
 * Pure over the descriptor list — no filesystem access — so the accounting is
 * testable without a machine to measure.
 *
 * @param {Array<ConsumerDescriptor>} descriptors
 * @returns {Array<ConsumerDescriptor>} the same descriptors, `kind` and
 *   `containedBy` filled in
 */
export function assignContainment(descriptors) {
  const rows = descriptors.filter((d) => anchorOf(d));
  return rows.map((desc) => {
    const mine = anchorOf(desc);
    let parent = null;
    for (const other of rows) {
      if (other === desc) continue;
      const theirs = anchorOf(other);
      if (!isInside(theirs, mine)) continue;
      if (!parent || isInside(anchorOf(parent), theirs)) parent = other;
    }
    return { ...desc, kind: parent ? 'breakdown' : 'root', containedBy: parent?.id ?? null };
  });
}

/** Sum a `match` family: every immediate entry of `dir` whose name starts with
 *  `prefix`. An unreadable directory is unknown-with-errno; a readable one with
 *  no matches is a real, measured zero and reads as absent — nothing named that
 *  is there. */
function measureFamily(desc, { walk, limits, asOf, fsImpl }) {
  const { dir, prefix } = desc.match;
  let entries;
  try {
    // One non-recursive listing to find the members; every member is then handed
    // to the shared walker, which keeps the caps, the symlink rule and the
    // degrade-this-node-only behaviour where they belong. This is the same
    // enumerate-then-walk shape install.mjs's npxEnvNodes already uses.
    entries = fsImpl.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    const code = err?.code || 'io';
    if (code === 'ENOENT') {
      return {
        presence: 'absent', bytes: measured(0, { asOf }), files: measured(0, { asOf }),
        newestMtimeMs: null, matchedPaths: [], matchedCount: 0, complete: true,
      };
    }
    return {
      presence: 'degraded', bytes: unknown(code), files: unknown(code),
      newestMtimeMs: null, matchedPaths: [], matchedCount: 0, complete: false,
    };
  }
  const byteParts = [];
  const fileParts = [];
  const samples = [];
  let matched = 0;
  let newest = null;
  let complete = true;
  for (const entry of entries) {
    if (!entry.name.startsWith(prefix) || entry.isSymbolicLink()) continue;
    matched += 1;
    const target = path.join(dir, entry.name);
    if (samples.length < MAX_MATCH_SAMPLES) samples.push(target);
    const result = walk(target, { ...limits, fsImpl });
    const node = rootMeasurements(result, { asOf });
    byteParts.push(node.bytes);
    fileParts.push(node.files);
    if (result.newestMtimeMs !== null && (newest === null || result.newestMtimeMs > newest)) {
      newest = result.newestMtimeMs;
    }
    if (result.complete === false) complete = false;
  }
  if (!matched) {
    return {
      presence: 'absent', bytes: measured(0, { asOf }), files: measured(0, { asOf }),
      newestMtimeMs: null, matchedPaths: [], matchedCount: 0, complete: true,
    };
  }
  return {
    presence: 'present',
    bytes: sumMeasurements(byteParts, { asOf }),
    files: sumMeasurements(fileParts, { asOf }),
    newestMtimeMs: newest,
    matchedPaths: samples,
    matchedCount: matched,
    complete,
  };
}

/**
 * Bytes a root really OCCUPIES, from allocated blocks rather than apparent
 * size. Only for roots declared `allocation: 'blocks'`, and only because
 * apparent size is catastrophically wrong for them: Docker Desktop's VM image is
 * a sparse file whose apparent size on this machine is ~4 TB against ~15 GB
 * actually written, which would not merely mis-order the ranking, it would put a
 * figure larger than the disk at the top of it.
 *
 * The walker still owns the traversal; the extra lstat per file is what buys
 * `blocks`, which `onFile` does not carry. A platform that reports no block
 * count (Windows) falls back to that file's apparent size, so the row degrades
 * to the ordinary basis rather than to zero.
 */
function measureAllocated(desc, { walk, limits, asOf, fsImpl }) {
  let allocated = 0;
  let apparent = 0;
  let files = 0;
  let newest = null;
  let estimated = 0;
  const result = walk(desc.path, {
    ...limits,
    fsImpl,
    onFile: ({ file, bytes, mtimeMs }) => {
      apparent += bytes;
      files += 1;
      if (newest === null || mtimeMs > newest) newest = mtimeMs;
      let blocks;
      try { blocks = Number(fsImpl.lstatSync(file).blocks); } catch { blocks = null; }
      // Zero blocks is a valid answer (an empty file, or one held entirely in
      // an inode); only a platform that reports no block count at all falls
      // back to apparent size, and that fallback is counted so the row can say
      // its basis is mixed.
      if (Number.isFinite(blocks) && blocks >= 0) allocated += blocks * 512;
      else { allocated += bytes; estimated += 1; }
    },
  });
  const node = rootMeasurements(result, { asOf });
  if (node.presence !== 'present') {
    return {
      presence: node.presence, bytes: node.bytes, files: node.files,
      newestMtimeMs: null, matchedPaths: [], matchedCount: null,
      apparentBytes: node.bytes, basis: 'allocated-blocks', complete: node.presence === 'absent',
    };
  }
  const partial = result.complete === false;
  return {
    presence: 'present',
    bytes: measured(allocated, { asOf, partial }),
    files: measured(files, { asOf, partial }),
    newestMtimeMs: newest,
    matchedPaths: [],
    matchedCount: null,
    apparentBytes: measured(apparent, { asOf, partial }),
    basis: estimated ? 'allocated-blocks (partly apparent)' : 'allocated-blocks',
    complete: !partial,
  };
}

function measureDescriptor(desc, ctx) {
  // An adopted figure is already measured — re-walking a 22 GB tree a second
  // time to learn what another section already knows is pure I/O cost.
  if (desc.adopted) {
    return {
      presence: desc.adopted.presence ?? (hasValue(desc.adopted.bytes) ? 'present' : 'degraded'),
      bytes: desc.adopted.bytes,
      files: desc.adopted.files ?? unknown('file count not carried by the adopted figure'),
      newestMtimeMs: desc.adopted.newestMtimeMs ?? null,
      matchedPaths: [],
      matchedCount: null,
      basis: 'adopted',
      complete: desc.adopted.complete !== false,
    };
  }
  if (desc.match) return measureFamily(desc, ctx);
  if (desc.allocation === 'blocks') return measureAllocated(desc, ctx);
  const result = ctx.walk(desc.path, { ...ctx.limits, fsImpl: ctx.fsImpl });
  const node = rootMeasurements(result, { asOf: ctx.asOf });
  return {
    presence: node.presence,
    bytes: node.bytes,
    files: node.files,
    newestMtimeMs: result.newestMtimeMs ?? null,
    matchedPaths: [],
    matchedCount: null,
    basis: 'apparent-size',
    // An absent root is a COMPLETE measurement of a real zero, not an
    // incomplete one: the walker reports `complete: false` for it only because
    // it could not read a directory that is not there.
    complete: node.presence === 'absent' || result.complete !== false,
  };
}

/** The ecosystem of each install-section shared cache. Kept beside the adoption
 *  code rather than in install.mjs: the ecosystem grouping is this view's
 *  vocabulary, and install.mjs has no opinion about it. */
const SHARED_CACHE_GROUPS = Object.freeze({
  'npx-envs': 'node',
  'claude-plugins': 'ai-toolchain',
  'codex-plugins': 'ai-toolchain',
  playwright: 'browsers',
  'playwright-mac': 'browsers',
  'playwright-win': 'browsers',
  puppeteer: 'browsers',
});

/** Descriptors adopted from the install section: managed-tool trees and the
 *  shared caches it already walked. Their figures are reused as-is; where the
 *  registry already names the same path, the registry's label and note win and
 *  only the MEASUREMENT is taken (one walk, one row, two sources agreeing). */
export function installDescriptors(install) {
  if (!install) return [];
  const rows = [];
  for (const tool of install.tools ?? []) {
    if (!tool?.root || !hasValue(tool.bytes)) continue;
    rows.push({
      id: `install:${tool.tool}`,
      label: `${tool.label} install tree`,
      group: 'ai-toolchain',
      path: tool.root,
      note: `The ${tool.label} install tree${tool.version ? ` (v${tool.version})` : ''}, `
        + 'measured by the Install section.',
      adopted: {
        presence: 'present', bytes: tool.bytes, files: tool.files,
        newestMtimeMs: tool.newestMtimeMs ?? null, complete: tool.complete !== false,
      },
    });
  }
  for (const cache of install.sharedCaches ?? []) {
    if (!cache?.path) continue;
    rows.push({
      id: `cache:${cache.id}`,
      label: cache.label,
      group: SHARED_CACHE_GROUPS[cache.id] ?? 'system',
      path: cache.path,
      note: 'Shared cache measured by the Install section.',
      adopted: {
        presence: cache.presence, bytes: cache.bytes, files: cache.files,
        newestMtimeMs: cache.newestMtimeMs ?? null, complete: cache.complete !== false,
      },
    });
  }
  return rows;
}

/**
 * Project working trees as consumer descriptors. A ProjectFootprint from the
 * projects section already carries `totalBytes` (tree + .git + node_modules), so
 * inclusion costs nothing extra; a bare `{ path, label }` is walked.
 *
 * @param {Array<ProjectTreeInput>} projects
 * @returns {Array<ConsumerDescriptor>}
 */
export function projectTreeDescriptors(projects) {
  const rows = [];
  for (const project of projects ?? []) {
    const footprint = typeof project === 'string' ? null : project;
    const target = typeof project === 'string' ? project : project?.path;
    if (!target) continue;
    const total = footprint?.totalBytes ?? null;
    const adopted = hasValue(total) && footprint
      ? {
        presence: footprint.presence ?? 'present',
        bytes: total,
        files: footprint.treeFiles,
        newestMtimeMs: hasValue(footprint.lastActivity) ? footprint.lastActivity.value : null,
        complete: footprint.complete !== false,
      }
      : null;
    rows.push({
      id: `project:${target}`,
      label: footprint?.label ?? path.basename(target),
      group: 'project-trees',
      path: target,
      note: adopted
        ? 'Working tree plus .git plus node_modules, measured by the Projects scan.'
        : 'Working tree as walked here; .git and node_modules included.',
      ...(adopted ? { adopted } : {}),
    });
  }
  return rows;
}

/** Merge descriptor sources, path-keyed. The first source to claim a path owns
 *  its identity (label, note, group); later sources contribute only a
 *  measurement it lacks. That is what keeps the registry's editorial notes while
 *  still reusing the install section's walk. */
function mergeDescriptors(sources) {
  const byPath = new Map();
  const out = [];
  for (const { source, rows } of sources) {
    for (const desc of rows) {
      const anchor = anchorOf(desc);
      if (!anchor) continue;
      const key = normalizePath(anchor) + (desc.match ? `::${desc.match.prefix}` : '');
      const existing = byPath.get(key);
      if (existing) {
        if (!existing.adopted && desc.adopted) {
          existing.adopted = desc.adopted;
          existing.measuredBy = source;
        }
        continue;
      }
      const row = { ...desc, source, measuredBy: desc.adopted ? source : 'consumers' };
      byPath.set(key, row);
      out.push(row);
    }
  }
  return out;
}

/** Parent minus its DIRECT children. The row exists so a breakdown always adds
 *  up: without it, "13 GB, of which 1.9 GB is the KB" invites the reader to
 *  invent the missing 11 GB. Unknown inputs make it unknown — never a
 *  difference computed against a fabricated zero — and a negative difference
 *  (children overlapping in a way containment did not catch) reports itself
 *  rather than rendering as a plausible small number. */
function residualRow(parent, children, asOf) {
  const parts = children.map((c) => c.bytes);
  if (!hasValue(parent.bytes) || parts.some((m) => !hasValue(m))) {
    return {
      bytes: unknown('parent or a breakdown row is unmeasured'),
      files: unknown('parent or a breakdown row is unmeasured'),
      negative: false,
    };
  }
  const bytes = parent.bytes.value - parts.reduce((acc, m) => acc + m.value, 0);
  if (bytes < 0) {
    return {
      bytes: unknown('breakdown rows sum to more than their parent'),
      files: unknown('breakdown rows sum to more than their parent'),
      negative: true,
    };
  }
  const partial = parent.bytes.partial === true || parts.some((m) => m.partial === true);
  const files = hasValue(parent.files) && children.every((c) => hasValue(c.files))
    ? measured(
      Math.max(0, parent.files.value - children.reduce((acc, c) => acc + c.files.value, 0)),
      { asOf, partial },
    )
    : unknown('file counts not available for every breakdown row');
  return { bytes: measured(bytes, { asOf, partial }), files, negative: false };
}

const rankValue = (row) => (hasValue(row.bytes) ? row.bytes.value : -1);

/**
 * The ranked-consumers view.
 *
 * @param {{
 *   now?: () => number, walk?: typeof walkTree, limits?: object,
 *   roots?: Array<ConsumerDescriptor>|null, env?: NodeJS.ProcessEnv,
 *   install?: object|null, projects?: Array<ProjectTreeInput>|null,
 *   includeProjectTrees?: boolean, topN?: number,
 *   extraRoots?: Array<ConsumerDescriptor>,
 *   fsImpl?: typeof fs,
 * }} [options] `roots` replaces the registry outright (tests, narrowed scans);
 *   `extraRoots` adds to it. `install` and `projects` are already-collected
 *   sections whose figures are adopted rather than re-walked.
 * @returns {{
 *   asOf: number, includeProjectTrees: boolean, topN: number,
 *   rows: object[], top: object[], groups: object[], totals: object,
 *   absent: object[], unmeasured: object[], projectTrees: object,
 *   accounting: object, complete: boolean,
 * }}
 */
export function collectConsumers({
  now = Date.now,
  walk = walkTree,
  limits = {},
  roots = null,
  env = process.env,
  install = null,
  projects = null,
  includeProjectTrees = false,
  topN = CONSUMER_TOP_N,
  extraRoots = [],
  fsImpl = fs,
} = {}) {
  const asOf = now();
  const ctx = { walk, limits: { ...CONSUMER_WALK_LIMITS, ...limits }, asOf, fsImpl };
  const candidates = Array.isArray(projects) ? projects : [];

  const descriptors = assignContainment(mergeDescriptors([
    { source: 'registry', rows: roots ?? consumerRoots({ env }) },
    { source: 'install', rows: installDescriptors(install) },
    { source: 'caller', rows: extraRoots },
    {
      source: 'projects',
      rows: includeProjectTrees ? projectTreeDescriptors(candidates) : [],
    },
  ]));

  const measuredRows = descriptors.map((desc) => {
    const m = measureDescriptor(desc, ctx);
    return {
      id: desc.id,
      label: desc.label,
      path: desc.path ?? null,
      pathPattern: desc.match ? path.join(desc.match.dir, `${desc.match.prefix}*`) : null,
      matchedPaths: m.matchedPaths,
      matchedCount: m.matchedCount,
      group: desc.group,
      kind: desc.kind,
      containedBy: desc.containedBy,
      presence: m.presence,
      bytes: m.bytes,
      files: m.files,
      // How the bytes were obtained. 'apparent-size' is every ordinary row;
      // 'allocated-blocks' rows also carry `apparentBytes`, and the gap between
      // the two is the whole reason that basis exists.
      basis: m.basis ?? 'apparent-size',
      apparentBytes: m.apparentBytes ?? null,
      newestMtimeMs: m.newestMtimeMs,
      accountingNote: desc.note,
      source: desc.source,
      measuredBy: desc.measuredBy,
      residual: false,
      complete: m.complete,
    };
  });

  const byId = new Map(measuredRows.map((row) => [row.id, row]));
  const directChildren = new Map();
  for (const row of measuredRows) {
    if (!row.containedBy || !byId.has(row.containedBy)) continue;
    const list = directChildren.get(row.containedBy) ?? [];
    list.push(row);
    directChildren.set(row.containedBy, list);
  }

  const residuals = [];
  for (const [parentId, children] of directChildren) {
    const parent = byId.get(parentId);
    if (parent.presence === 'absent') continue;
    const { bytes, files } = residualRow(parent, children, asOf);
    residuals.push({
      id: `${parentId}:other`,
      label: `everything else under ${parent.label}`,
      path: parent.path,
      pathPattern: null,
      matchedPaths: [],
      matchedCount: null,
      group: parent.group,
      kind: 'breakdown',
      containedBy: parentId,
      presence: parent.presence,
      bytes,
      files,
      basis: 'derived',
      apparentBytes: null,
      newestMtimeMs: null,
      accountingNote: `${parent.label} minus the ${children.length} row(s) broken out of it, `
        + 'so the breakdown adds up to the parent.',
      source: 'derived',
      measuredBy: 'consumers',
      residual: true,
      complete: parent.complete,
    });
  }

  const rows = [...measuredRows, ...residuals]
    .sort((a, b) => rankValue(b) - rankValue(a));

  // Totals sum every ROOT, absent ones included: an absent root's measured zero
  // is a real zero and adding it changes nothing. Ranking, by contrast, drops
  // them — a directory that is not there is not a consumer, and listing it at
  // "0 B" is the shape of an unknown wearing a number.
  const allRoots = rows.filter((row) => row.kind === 'root');
  const ranked = allRoots.filter((row) => row.presence !== 'absent' && hasValue(row.bytes));
  const groups = CONSUMER_GROUPS.map((group) => {
    const members = allRoots.filter((row) => row.group === group.id);
    const empty = group.id === 'project-trees' && !includeProjectTrees
      ? unknown('project trees not measured: the toggle is off')
      : measured(0, { asOf });
    return {
      ...group,
      rowCount: members.length,
      bytes: members.length ? sumMeasurements(members.map((r) => r.bytes), { asOf }) : empty,
      files: members.length ? sumMeasurements(members.map((r) => r.files), { asOf }) : empty,
      largest: members.filter((r) => hasValue(r.bytes))
        .sort((a, b) => rankValue(b) - rankValue(a))[0]?.id ?? null,
    };
  }).sort((a, b) => (b.bytes.value ?? -1) - (a.bytes.value ?? -1));

  const absent = rows.filter((row) => row.presence === 'absent')
    .map(({ id, label, path: rootPath, group, kind }) => ({ id, label, path: rootPath, group, kind }));
  const unmeasured = rows.filter((row) => row.presence === 'degraded')
    .map(({ id, label, path: rootPath, group, kind, bytes }) => (
      { id, label, path: rootPath, group, kind, reason: bytes.reason }
    ));

  return {
    asOf,
    includeProjectTrees,
    topN,
    rows,
    top: ranked.slice(0, topN),
    groups,
    totals: {
      bytes: sumMeasurements(allRoots.map((r) => r.bytes), { asOf }),
      files: sumMeasurements(allRoots.map((r) => r.files), { asOf }),
      rootCount: measured(allRoots.length, { asOf }),
      breakdownCount: measured(rows.filter((r) => r.kind === 'breakdown').length, { asOf }),
      rankedCount: measured(ranked.length, { asOf }),
    },
    absent,
    unmeasured,
    projectTrees: {
      included: includeProjectTrees,
      candidates: candidates.length,
      // Stated rather than silent: an excluded category the reader cannot see is
      // the same failure as an unknown rendered as zero.
      reason: includeProjectTrees
        ? null
        : 'Project working trees are excluded by default: a single large repository can '
          + 'outweigh every shared cache combined and flatten the ranking.',
    },
    accounting: {
      basis: 'One bounded walk per root (symlinks never followed, so a symlinked tree is '
        + 'counted where it really lives), or the figure the Install/Projects scan already '
        + 'measured for that exact path.',
      containment: 'Nested roots are counted once, at the outermost row. Rows inside another '
        + 'row are breakdowns and are excluded from the ranking and the group totals.',
      residuals: 'Every row with breakdowns also carries an "everything else" row, so a '
        + 'breakdown always sums to its parent.',
      absent: 'Roots that do not exist on this machine are listed as absent, not ranked as '
        + 'zero-byte consumers.',
      projectTrees: 'Project working trees join the ranking only when the toggle is on.',
    },
    complete: rows.every((row) => row.complete !== false) && !unmeasured.length,
  };
}
